import type { ConnectorInfo } from "../../../packages/shared/src/connector";
import { sha256 } from "../../../packages/shared/src/crypto";
import { fileUploadLimits, type UploadChunk, type UploadResult } from "../../../packages/shared/src/file-uploads";
import { api, segment } from "./api";
import { desktopBridge, type DesktopBridge } from "./desktop";

/** A file attached to a message, once it is in the session's worktree. */
export interface UploadedFile { path: string; size: number }

/** Hosts this page found aren't run by the desktop app it is in: their files go through the server. */
const notLocal = new Set<string>();

/**
 * Whether the desktop app this page runs in hosts `host` itself, so a file attached to a message there goes straight to
 * it: only its chunks' grants come from the server, and the file's bytes stay on this computer.
 */
async function localHost(host: ConnectorInfo | undefined): Promise<DesktopBridge | undefined> {
  const bridge = desktopBridge();
  if (!bridge?.upload || !host?.capabilities.directUploads || notLocal.has(host.id)) return undefined;
  try {
    const view = await bridge.view();
    if (view.hosts.connections.some(connection => connection.running?.connectorId === host.id)) return bridge;
  } catch { /* An app page that can't say: through the server. */ }
  notLocal.add(host.id);
  return undefined;
}

/** A blob's bytes as base64, a block at a time so no call gets too many arguments. */
async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

/** The host's answer to a chunk, as the server would have checked it. */
function checked(value: UploadResult, received: number, size: number): UploadResult {
  const path = value?.path;
  if (!value || value.received !== received || (path !== undefined && (typeof path !== "string" || !/^attachments\/[^/\x00-\x1f\x7f]+$/.test(path)))
    || (received === size) !== (path !== undefined)) throw new Error("The host answered the upload unexpectedly.");
  return value;
}

/** The reason a host on this computer gave for refusing a chunk, when it is one short plain line. */
function hostReason(body: string): string {
  try {
    const parsed = JSON.parse(body.slice(0, 2048)) as { error?: unknown };
    if (typeof parsed.error === "string" && /^[\w .,:;'()-]{1,300}$/.test(parsed.error)) return parsed.error;
  } catch { /* Not JSON. */ }
  return "";
}

/**
 * Uploads one file attached to a message into the session's worktree (packages/shared/src/file-uploads.ts), a chunk at
 * a time, and answers where it went. Through the server, or, in the desktop app that hosts the session itself, straight
 * to that host. `progress` hears the bytes sent so far.
 */
export async function uploadFile(sessionId: string, host: ConnectorInfo | undefined, file: Blob, name: string, progress?: (sent: number) => void): Promise<UploadedFile> {
  const size = file.size;
  const uploadId = crypto.randomUUID();
  let bridge = await localHost(host);
  let offset = 0;
  for (;;) {
    const end = Math.min(size, offset + fileUploadLimits.chunkBytes);
    const chunk: UploadChunk = { uploadId, name, size, offset, data: await base64(file.slice(offset, end)) };
    let result: UploadResult | undefined;
    if (bridge && host) {
      const body = JSON.stringify(chunk);
      const { connectorId, grant } = await api<{ connectorId: string; grant: string }>(`/api/sessions/${segment(sessionId)}/uploads/direct`, {
        method: "POST", body: { bodyHash: await sha256(body), size },
      });
      const outcome = await bridge.upload!({ connectorId, grant, body });
      if (!outcome.ok) {
        // Only before anything reached it: a host that isn't this computer's after all takes the file through the server.
        if (outcome.local || offset > 0) throw new Error(outcome.error);
        notLocal.add(host.id);
        bridge = undefined;
      } else if (outcome.status >= 400) {
        throw new Error(hostReason(outcome.body) || "This computer's host could not take the file.");
      } else {
        try { result = JSON.parse(outcome.body) as UploadResult; }
        catch { throw new Error("The host answered the upload unexpectedly."); }
      }
    }
    result ??= await api<UploadResult>(`/api/sessions/${segment(sessionId)}/uploads`, { method: "POST", body: chunk });
    checked(result, end, size);
    progress?.(end);
    if (result.path !== undefined) return { path: result.path, size };
    offset = end;
  }
}
