export const fileUploadLimits = {
  defaultBytes: 10 * 1024 * 1024,
  maxBytes: 50 * 1024 * 1024,
  minBytes: 1024 * 1024,
  chunkBytes: 512 * 1024,
  count: 10,
} as const;

export const ATTACHMENTS_DIRECTORY = "attachments";

export interface UploadChunk {
  uploadId: string;
  name: string;
  size: number;
  offset: number;
  data: string;
}

export interface UploadResult {
  received: number;
  path?: string;
}

const UPLOAD_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export function uploadFileName(name: string): string {
  let value = name.normalize("NFC").replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, "_").trim();
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
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(value)) value = `_${value}`;
  return value.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "_");
}

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

export function attachmentCandidate(name: string, index: number): string {
  if (index <= 1) return name;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} (${index})${name.slice(dot)}` : `${name} (${index})`;
}

export const ATTACHMENT_CANDIDATES = 999;

export function base64Bytes(data: string): number {
  return data.length / 4 * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    const value = bytes / (1024 * 1024);
    return `${Number.isInteger(value) ? value : value.toFixed(1)} MB`;
  }
  if (bytes >= 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${bytes} bytes`;
}

export function attachedFilesNote(files: readonly { path: string; size: number }[]): string {
  if (!files.length) return "";
  return `Attached ${files.length === 1 ? "file" : "files"}, uploaded into the session worktree:\n`
    + files.map(file => `- ${file.path} (${formatBytes(file.size)})`).join("\n");
}
