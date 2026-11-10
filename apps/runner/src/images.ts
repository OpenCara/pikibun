import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import type { ImageLimits, ImageProcessor, PreparedImage } from "@earendil-works/pi-durable/tools";
import { entryImageLimits } from "../../../packages/shared/src/entry-images.js";

export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

export const IMAGE_LIMITS: ImageLimits = { maxWidth: 1568, maxHeight: 1568, maxBytes: 512 * 1024 };

const MAX_DECODE_BYTES = 512 * 1024 * 1024;
const PREPARE_TIMEOUT_MS = 30_000;
const MAX_WAITING = 8;

export const IMAGE_ERROR = "The image cannot be decoded or fitted to the model's image limits";
export const IMAGE_BUSY = "Too many images are being prepared at once; read this file again shortly";

const IMAGE_SIGNATURES: readonly (readonly [string, readonly (readonly [number, Buffer])[]])[] = [
  ["image/png", [[0, Buffer.from("89504e470d0a1a0a", "hex")]]],
  ["image/jpeg", [[0, Buffer.from("ffd8ff", "hex")]]],
  ["image/gif", [[0, Buffer.from("GIF87a")]]],
  ["image/gif", [[0, Buffer.from("GIF89a")]]],
  ["image/webp", [[0, Buffer.from("RIFF")], [8, Buffer.from("WEBP")]]],
];

export function imageType(bytes: Uint8Array): string | undefined {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return IMAGE_SIGNATURES.find(([, parts]) => parts.every(([offset, expected]) => data.subarray(offset, offset + expected.length).equals(expected)))?.[0];
}

export type FileContent = { readonly text: string } | { readonly image: Uint8Array; readonly mimeType: string };

export type ModelImage = { readonly data: string; readonly mimeType: string; readonly width: number; readonly height: number };

type ImageHeader = { readonly width: number; readonly height: number; readonly bytesPerPixel: number; readonly animated: boolean };

let processor: Promise<ImageProcessor> | undefined;

function imageProcessor(): Promise<ImageProcessor> {
  processor ??= createNodePhotonImages({ idleMs: 0 }).catch((error: unknown) => { processor = undefined; throw error; });
  return processor;
}

const BUSY = Symbol("busy");

export type ImageTurn = "model" | "thumbnail";
const WAITING_LIMITS: Record<ImageTurn, number> = { model: MAX_WAITING, thumbnail: 32 };

let preparing = false;
const waiting: Record<ImageTurn, (() => void)[]> = { model: [], thumbnail: [] };

export async function inTurn<T>(turn: ImageTurn, work: () => Promise<T>): Promise<T | typeof BUSY> {
  if (preparing) {
    if (waiting[turn].length >= WAITING_LIMITS[turn]) return BUSY;
    await new Promise<void>(resolve => waiting[turn].push(resolve));
  } else preparing = true;
  try { return await work(); }
  finally {
    const next = waiting.model.shift() ?? waiting.thumbnail.shift();
    if (next) next();
    else preparing = false;
  }
}

async function prepareWithin(bytes: Uint8Array, mimeType: string, limits: ImageLimits = IMAGE_LIMITS): Promise<PreparedImage | undefined> {
  const current = imageProcessor();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>(resolve => { timer = setTimeout(resolve, PREPARE_TIMEOUT_MS, undefined); });
  try {
    const prepared = await Promise.race([current.then(images => images.prepare(bytes, mimeType, limits)), timeout]);
    if (!prepared && processor === current) processor = undefined;
    return prepared;
  } catch {
    if (processor === current) processor = undefined;
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export async function prepareImage(bytes: Uint8Array, mimeType: string): Promise<{ readonly image: ModelImage } | { readonly error: string }> {
  const header = imageHeader(bytes, mimeType);
  if (!header || (header.animated && mimeType === "image/webp")) return { error: IMAGE_ERROR };
  if (header.width * header.height * (header.bytesPerPixel + 8) > MAX_DECODE_BYTES) return { error: IMAGE_ERROR };
  const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const prepared = await inTurn("model", () => prepareWithin(view, header.animated ? "image/x-animated-gif" : mimeType));
  if (prepared === BUSY) return { error: IMAGE_BUSY };
  const size = prepared && imageHeader(Buffer.from(prepared.data, "base64"), prepared.mimeType);
  if (!prepared || !size) return { error: IMAGE_ERROR };
  return { image: { data: prepared.data, mimeType: prepared.mimeType, width: size.width, height: size.height } };
}

const THUMBNAIL_LIMITS: ImageLimits = { maxWidth: entryImageLimits.thumbnailEdge, maxHeight: entryImageLimits.thumbnailEdge, maxBytes: entryImageLimits.thumbnailBytes };

type Thumbnail = { readonly data: string; readonly mimeType: string };
const thumbnails = new Map<string, Promise<Thumbnail | "busy" | undefined>>();
const THUMBNAILS_KEPT = 128;

export function thumbnailImage(data: string, mimeType: string): Promise<Thumbnail | "busy" | undefined> {
  const key = createHash("sha256").update(mimeType).update("\0").update(data).digest("hex");
  const kept = thumbnails.get(key);
  if (kept) {
    thumbnails.delete(key);
    thumbnails.set(key, kept);
    return kept;
  }
  const made = makeThumbnail(data, mimeType);
  thumbnails.set(key, made);
  while (thumbnails.size > THUMBNAILS_KEPT) thumbnails.delete(thumbnails.keys().next().value!);
  void made.then(result => { if (typeof result !== "object" && thumbnails.get(key) === made) thumbnails.delete(key); });
  return made;
}

async function makeThumbnail(data: string, mimeType: string): Promise<Thumbnail | "busy" | undefined> {
  const bytes = Buffer.from(data, "base64");
  const header = imageHeader(bytes, mimeType);
  if (!header || header.width * header.height * (header.bytesPerPixel + 8) > MAX_DECODE_BYTES) return undefined;
  const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (header.animated && mimeType === "image/webp") return undefined;
  const prepared = await inTurn("thumbnail", () => prepareWithin(view, header.animated ? "image/x-animated-gif" : mimeType, THUMBNAIL_LIMITS));
  if (prepared === BUSY) return "busy";
  return prepared ? { data: prepared.data, mimeType: prepared.mimeType } : undefined;
}

function imageHeader(bytes: Uint8Array, mimeType: string): ImageHeader | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = (width: number, height: number, bytesPerPixel = 4, animated = false) =>
    width > 0 && height > 0 ? { width, height, bytesPerPixel, animated } : undefined;
  switch (mimeType) {
    case "image/png": return bytes.length >= 26 ? header(view.getUint32(16), view.getUint32(20), bytes[24] === 16 ? 8 : 4) : undefined;
    case "image/gif": return gifHeader(bytes, view);
    case "image/webp": {
      if (bytes.length < 30) return undefined;
      const chunk = Buffer.from(bytes.buffer, bytes.byteOffset + 12, 4).toString("latin1");
      if (chunk === "VP8 ") return header(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
      if (chunk === "VP8L") {
        const bits = view.getUint32(21, true);
        return header((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
      }
      const uint24 = (offset: number) => view.getUint16(offset, true) + (view.getUint8(offset + 2) << 16);
      return chunk === "VP8X" ? header(uint24(24) + 1, uint24(27) + 1, 4, (bytes[20]! & 0x02) !== 0) : undefined;
    }
    case "image/jpeg":
      for (let offset = 2; offset + 9 <= bytes.length;) {
        if (bytes[offset] !== 0xff) return undefined;
        const marker = bytes[offset + 1]!;
        if (marker === 0xff) { offset++; continue; }
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return header(view.getUint16(offset + 7), view.getUint16(offset + 5));
        }
        offset += 2 + view.getUint16(offset + 2);
      }
      return undefined;
    default: return undefined;
  }
}

function gifHeader(bytes: Uint8Array, view: DataView): ImageHeader | undefined {
  if (bytes.length < 13) return undefined;
  let width = view.getUint16(6, true);
  let height = view.getUint16(8, true);
  let frames = 0;
  const colourTable = (packed: number) => packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0;
  const skipSubBlocks = (from: number) => {
    let offset = from;
    while (offset < bytes.length && bytes[offset] !== 0) offset += bytes[offset]! + 1;
    return offset + 1;
  };
  let offset = 13 + colourTable(bytes[10]!);
  while (offset < bytes.length && bytes[offset] !== 0x3b) {
    if (bytes[offset] === 0x21) {
      offset = skipSubBlocks(offset + 2);
      continue;
    }
    if (bytes[offset] !== 0x2c || offset + 10 > bytes.length) return undefined;
    frames++;
    width = Math.max(width, view.getUint16(offset + 1, true) + view.getUint16(offset + 5, true));
    height = Math.max(height, view.getUint16(offset + 3, true) + view.getUint16(offset + 7, true));
    offset = skipSubBlocks(offset + 10 + colourTable(bytes[offset + 9]!) + 1);
  }
  return frames && width > 0 && height > 0 ? { width, height, bytesPerPixel: 4, animated: frames > 1 } : undefined;
}
