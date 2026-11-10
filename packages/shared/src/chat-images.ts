import { sha256 } from "./crypto.js";

export const chatImageTypes = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ChatImageType = (typeof chatImageTypes)[number];

export interface ChatImage {
  mimeType: ChatImageType;
  data: string;
}

export const chatImageLimits = { count: 4, imageBase64: 512 * 1024, totalBase64: 720 * 1024 } as const;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function parseChatImages(value: unknown): { images: ChatImage[] } | { error: string } {
  if (!Array.isArray(value)) return { error: "Invalid images." };
  if (value.length > chatImageLimits.count) return { error: `A message can carry at most ${chatImageLimits.count} images.` };
  const images: ChatImage[] = [];
  let total = 0;
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { error: "Invalid image." };
    const image = item as Record<string, unknown>;
    if (Object.keys(image).some(key => key !== "mimeType" && key !== "data")) return { error: "Invalid image." };
    if (!chatImageTypes.includes(image.mimeType as never)) return { error: "Images must be PNG, JPEG, GIF or WebP." };
    if (typeof image.data !== "string" || image.data.length % 4 !== 0 || !BASE64.test(image.data)) return { error: "Invalid image." };
    if (image.data.length > chatImageLimits.imageBase64) return { error: `Each image can be at most ${chatImageLimits.imageBase64 / 1024} KiB as base64.` };
    total += image.data.length;
    if (total > chatImageLimits.totalBase64) return { error: `A message's images can be at most ${chatImageLimits.totalBase64 / 1024} KiB together as base64.` };
    images.push({ mimeType: image.mimeType as ChatImageType, data: image.data });
  }
  return { images };
}

export function messageHash(content: string, images?: readonly ChatImage[]): Promise<string> {
  return sha256(images?.length ? JSON.stringify([content, images.map(image => [image.mimeType, image.data])]) : content);
}
