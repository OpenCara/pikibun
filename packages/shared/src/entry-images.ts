import { fileImageTypes } from "./file-browser.js";

/*
 * Images in a session's transcript: what people pasted into their messages and what tools gave the model (a browser
 * screenshot, an image file it read). The transcript notes each as `[image <type>]` and lists them in the entry's
 * `images`; their data stays on the host until a collaborator's client asks for one, as a thumbnail or whole, through
 * the control plane, which checks the host's answer here again.
 */

/** Which of an image to send: a small copy for the transcript, or the image as the model got it. */
export type EntryImageSize = "thumbnail" | "full";
export const entryImageSizes: readonly EntryImageSize[] = ["thumbnail", "full"];

export const entryImageLimits = {
  /** Longest edge of a thumbnail, in pixels: twice what the transcript shows, for high-density screens. */
  thumbnailEdge: 480,
  /** Base64 bytes of a thumbnail. */
  thumbnailBytes: 64 * 1024,
  /**
   * Base64 bytes of a whole image. Hosts keep images within 512 KiB (`IMAGE_LIMITS`); this leaves room for any kept
   * before they did, at Pi's own 4.5 MiB limit.
   */
  fullBytes: 6 * 1024 * 1024,
  /** Images one entry lists. */
  images: 64,
} as const;

/** One image of a transcript entry: the `index`th of the entry `entryId` (an `EntryView` id). */
export interface EntryImageRequest {
  entryId: string;
  index: number;
  size: EntryImageSize;
}

export interface EntryImage {
  mimeType: string;
  /** Base64. */
  data: string;
}

/** A conversation and an entry in it, as `EntryView.id` names the entries Pi keeps (`<conversation>:<entry>`). */
const ENTRY_ID = /^(\d{1,15}):(\d{1,15})$/;

/** The conversation and entry an `EntryView` id names, or undefined when it names none Pi keeps. */
export function entryIdParts(id: string): { conversationId: number; entryId: number } | undefined {
  const match = ENTRY_ID.exec(id);
  return match ? { conversationId: Number(match[1]), entryId: Number(match[2]) } : undefined;
}

/** `value` as a request for an entry's image, or undefined. */
export function entryImageRequest(value: unknown): EntryImageRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["entryId", "index", "size"].includes(key))) return undefined;
  if (typeof input.entryId !== "string" || !entryIdParts(input.entryId)) return undefined;
  if (!Number.isSafeInteger(input.index) || (input.index as number) < 0 || (input.index as number) >= entryImageLimits.images) return undefined;
  if (!entryImageSizes.includes(input.size as EntryImageSize)) return undefined;
  return { entryId: input.entryId, index: input.index as number, size: input.size as EntryImageSize };
}

/** `value` as an image of `size` within its limits, or undefined. Unknown keys are dropped. */
export function checkEntryImage(value: unknown, size: EntryImageSize): EntryImage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const image = value as Record<string, unknown>;
  const limit = size === "thumbnail" ? entryImageLimits.thumbnailBytes : entryImageLimits.fullBytes;
  if (typeof image.mimeType !== "string" || !fileImageTypes.includes(image.mimeType) || typeof image.data !== "string" || !image.data
    || image.data.length > limit || image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) return undefined;
  return { mimeType: image.mimeType, data: image.data };
}

/** The line a transcript entry's text holds in place of each image (see the runner's `entryView`). */
export const IMAGE_LINE = /^\[image [^\s\]]+\]$/;

/** `text` without the lines that stand for images. */
export function withoutImageLines(text: string): string {
  return text.split("\n").filter(line => !IMAGE_LINE.test(line)).join("\n");
}
