import { fileImageTypes } from "./file-browser.js";

export type EntryImageSize = "thumbnail" | "full";
export const entryImageSizes: readonly EntryImageSize[] = ["thumbnail", "full"];

export const entryImageLimits = {
  thumbnailEdge: 480,
  thumbnailBytes: 64 * 1024,
  fullBytes: 6 * 1024 * 1024,
  images: 64,
} as const;

export interface EntryImageRequest {
  entryId: string;
  index: number;
  size: EntryImageSize;
}

export interface EntryImage {
  mimeType: string;
  data: string;
}

const ENTRY_ID = /^(\d{1,15}):(\d{1,15})$/;

export function entryIdParts(id: string): { conversationId: number; entryId: number } | undefined {
  const match = ENTRY_ID.exec(id);
  return match ? { conversationId: Number(match[1]), entryId: Number(match[2]) } : undefined;
}

export function entryImageRequest(value: unknown): EntryImageRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["entryId", "index", "size"].includes(key))) return undefined;
  if (typeof input.entryId !== "string" || !entryIdParts(input.entryId)) return undefined;
  if (!Number.isSafeInteger(input.index) || (input.index as number) < 0 || (input.index as number) >= entryImageLimits.images) return undefined;
  if (!entryImageSizes.includes(input.size as EntryImageSize)) return undefined;
  return { entryId: input.entryId, index: input.index as number, size: input.size as EntryImageSize };
}

export function checkEntryImage(value: unknown, size: EntryImageSize): EntryImage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const image = value as Record<string, unknown>;
  const limit = size === "thumbnail" ? entryImageLimits.thumbnailBytes : entryImageLimits.fullBytes;
  if (typeof image.mimeType !== "string" || !fileImageTypes.includes(image.mimeType) || typeof image.data !== "string" || !image.data
    || image.data.length > limit || image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) return undefined;
  return { mimeType: image.mimeType, data: image.data };
}

export const IMAGE_LINE = /^\[image [^\s\]]+\]$/;

export function withoutImageLines(text: string): string {
  return text.split("\n").filter(line => !IMAGE_LINE.test(line)).join("\n");
}
