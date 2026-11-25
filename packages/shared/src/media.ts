export type MediaKind = "image" | "video" | "audio";

export interface MediaType {
  kind: MediaKind;
  mimeType: string;
}

const mediaTypes: Readonly<Record<string, MediaType>> = Object.freeze({
  png: { kind: "image", mimeType: "image/png" },
  jpg: { kind: "image", mimeType: "image/jpeg" },
  jpeg: { kind: "image", mimeType: "image/jpeg" },
  gif: { kind: "image", mimeType: "image/gif" },
  webp: { kind: "image", mimeType: "image/webp" },
  mp4: { kind: "video", mimeType: "video/mp4" },
  m4v: { kind: "video", mimeType: "video/mp4" },
  mov: { kind: "video", mimeType: "video/quicktime" },
  webm: { kind: "video", mimeType: "video/webm" },
  ogv: { kind: "video", mimeType: "video/ogg" },
  mp3: { kind: "audio", mimeType: "audio/mpeg" },
  m4a: { kind: "audio", mimeType: "audio/mp4" },
  aac: { kind: "audio", mimeType: "audio/aac" },
  wav: { kind: "audio", mimeType: "audio/wav" },
  ogg: { kind: "audio", mimeType: "audio/ogg" },
  oga: { kind: "audio", mimeType: "audio/ogg" },
  opus: { kind: "audio", mimeType: "audio/ogg" },
  flac: { kind: "audio", mimeType: "audio/flac" },
});

export const mediaLimits = {
  chunkBytes: 1024 * 1024,
  linkSeconds: 60 * 60,
  pathLength: 1024,
} as const;

export function mediaType(path: string): MediaType | undefined {
  const name = path.split("/").at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return undefined;
  return mediaTypes[name.slice(dot + 1).toLowerCase()];
}

export function worktreeMediaPath(value: string): string | undefined {
  let path = value.trim();
  if (!path || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//") || path.startsWith("#") || path.includes("?")) return undefined;
  try { path = decodeURIComponent(path); } catch { return undefined; }
  path = path.replace(/^(\.\/)+/, "");
  if (!path || path.length > mediaLimits.pathLength || path.startsWith("/") || path.includes("\\") || /[\x00-\x1f\x7f]/.test(path)
    || path.split("/").some(part => part === "" || part === "." || part === "..")) return undefined;
  return mediaType(path) ? path : undefined;
}

export interface ByteRange {
  start: number;
  end: number;
}

export function parseByteRange(header: string | undefined, size: number, chunk: number = mediaLimits.chunkBytes): ByteRange | "unsatisfiable" | undefined {
  if (header === undefined) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return undefined;
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix === 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return undefined;
  }
  if (start >= size) return "unsatisfiable";
  return { start, end: Math.min(end, size - 1, start + chunk - 1) };
}

export interface MediaRangeRequest {
  path: string;
  offset: number;
  length: number;
}

export interface MediaRange {
  size: number;
  data: string;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export function mediaRangeRequest(value: unknown): MediaRangeRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(",") !== "length,offset,path") return undefined;
  const { path, offset, length } = input;
  if (typeof path !== "string" || !path || path.length > mediaLimits.pathLength) return undefined;
  if (!Number.isSafeInteger(offset) || (offset as number) < 0) return undefined;
  if (!Number.isSafeInteger(length) || (length as number) < 1 || (length as number) > mediaLimits.chunkBytes) return undefined;
  return { path, offset: offset as number, length: length as number };
}

export function checkMediaRange(value: unknown, request: Pick<MediaRangeRequest, "offset" | "length">): MediaRange | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const range = value as Record<string, unknown>;
  if (Object.keys(range).sort().join(",") !== "data,size") return undefined;
  const { size, data } = range;
  if (!Number.isSafeInteger(size) || (size as number) < 0 || typeof data !== "string" || data.length % 4 !== 0 || !BASE64.test(data)) return undefined;
  const bytes = data.length / 4 * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
  const expected = Math.max(0, Math.min(request.length, (size as number) - request.offset));
  if (bytes !== expected) return undefined;
  return { size: size as number, data };
}
