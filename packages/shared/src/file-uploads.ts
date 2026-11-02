/**
 * Files attached to a message (other than the images the model sees, chat-images.ts): each is uploaded into the
 * session's worktree, under `attachments/`, before the message is sent, and the message names where it went.
 *
 * A file travels in chunks of at most `chunkBytes`, one runner request each (the `upload` action), so every request
 * fits the connector relay's request limit (connectorLimits.requestBytes). The host keeps the chunks outside the
 * sandbox until the last one arrives, then writes the whole file into the worktree at once.
 */
export const fileUploadLimits = {
  /** A workspace's limit on one file, until its owners or admins choose another. */
  defaultBytes: 10 * 1024 * 1024,
  /** The largest limit a workspace may choose; hosts refuse anything larger whatever the control plane says. */
  maxBytes: 50 * 1024 * 1024,
  /** The smallest limit a workspace may choose. */
  minBytes: 1024 * 1024,
  /** Raw bytes per chunk: base64 makes about 683 KiB of it, which leaves room in a 1 MiB request. */
  chunkBytes: 512 * 1024,
  /** Files one message may carry. */
  count: 10,
} as const;

/** Where in the worktree attached files go. */
export const ATTACHMENTS_DIRECTORY = "attachments";

/** One chunk of a file being uploaded, as the browser sends it and the host takes it. */
export interface UploadChunk {
  /** The browser's id for this upload, the same for each of its chunks. */
  uploadId: string;
  /** The file's name, as `uploadFileName` makes it. */
  name: string;
  /** The whole file's size in bytes. */
  size: number;
  /** Where this chunk starts: the bytes sent before it. */
  offset: number;
  /** The chunk's bytes, base64. */
  data: string;
}

/** What the host answers: the last chunk names where the file now is, relative to the worktree. */
export interface UploadResult {
  received: number;
  path?: string;
}

const UPLOAD_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * A file name that is safe to create in one directory on every host: no separators, control characters or characters
 * Windows refuses, not `.`, `..` or `.git`, no trailing dot or space, at most 200 bytes of UTF-8. Empty when nothing of
 * `name` is left, for the caller to replace.
 */
export function uploadFileName(name: string): string {
  let value = name.normalize("NFC").replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, "_").trim();
  // At most 200 UTF-8 bytes, leaving room for a " (2)" within the 255 bytes most file systems allow a name.
  const bytes = (text: string) => new TextEncoder().encode(text).length;
  if (bytes(value) > 200) {
    const dot = value.lastIndexOf(".");
    const extension = dot > 0 && value.length - dot <= 16 ? value.slice(dot) : "";
    let stem = value.slice(0, value.length - extension.length);
    while (stem && bytes(stem + extension) > 200) stem = stem.slice(0, -1);
    value = stem + extension;
  }
  value = value.replace(/[. ]+$/, "");
  if (!value || /^\.+$/.test(value) || value.toLowerCase() === ".git") return "";
  // Names Windows keeps for devices, whatever their extension.
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(value)) value = `_${value}`;
  // A lone surrogate left by the cut can't be written as UTF-8.
  return value.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "_");
}

/** The chunk in `value`, checked: its fields and nothing else, a sound name and base64, within `maxBytes` and its chunk size. */
export function parseUploadChunk(value: unknown, maxBytes: number = fileUploadLimits.maxBytes): UploadChunk | { error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "Expected an upload chunk." };
  const chunk = value as Record<string, unknown>;
  if (Object.keys(chunk).sort().join(",") !== "data,name,offset,size,uploadId") return { error: "Expected uploadId, name, size, offset and data." };
  const { uploadId, name, size, offset, data } = chunk;
  if (typeof uploadId !== "string" || !UPLOAD_ID.test(uploadId)) return { error: "Invalid upload id." };
  if (typeof name !== "string" || !name || uploadFileName(name) !== name) return { error: "Invalid file name." };
  if (!Number.isSafeInteger(size) || (size as number) < 0 || (size as number) > Math.min(maxBytes, fileUploadLimits.maxBytes)) {
    return { error: `A file may be at most ${formatBytes(Math.min(maxBytes, fileUploadLimits.maxBytes))}.` };
  }
  if (typeof data !== "string" || data.length % 4 !== 0 || !BASE64.test(data)) return { error: "Invalid chunk data." };
  const length = base64Bytes(data);
  if (!Number.isSafeInteger(offset) || (offset as number) < 0 || length > fileUploadLimits.chunkBytes
    || (offset as number) + length > (size as number) || (length === 0 && size !== 0)) return { error: "Invalid chunk range." };
  return { uploadId, name, size: size as number, offset: offset as number, data };
}

/**
 * The name an attached file takes in its directory on the `index`th try, from 1: its own name first, then
 * `report (2).pdf`, `report (3).pdf` and so on. The sandbox helpers (sandbox.ts, node-helper.ts) mirror it.
 */
export function attachmentCandidate(name: string, index: number): string {
  if (index <= 1) return name;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} (${index})${name.slice(dot)}` : `${name} (${index})`;
}

/** Tries `attachmentCandidate` makes before an import gives up. */
export const ATTACHMENT_CANDIDATES = 999;

/** The bytes a base64 string holds. */
export function base64Bytes(data: string): number {
  return data.length / 4 * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
}

/** "10 MB", "1.5 MB", "300 KB": decimal-looking, as people read sizes, but counted in binary units as limits are. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    const value = bytes / (1024 * 1024);
    return `${Number.isInteger(value) ? value : value.toFixed(1)} MB`;
  }
  if (bytes >= 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${bytes} bytes`;
}

/** The line a message carries for its attached files, so the agent knows where they are. */
export function attachedFilesNote(files: readonly { path: string; size: number }[]): string {
  if (!files.length) return "";
  return `Attached ${files.length === 1 ? "file" : "files"}, uploaded into the session worktree:\n`
    + files.map(file => `- ${file.path} (${formatBytes(file.size)})`).join("\n");
}
