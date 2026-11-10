import { IMAGE_LINE, type EntryImage, type EntryImageSize } from "../../shared/src/entry-images";
import type { EntryView, SessionRecord } from "../../shared/src/types";
import { segment } from "./api";

export function entryImageHref(sessionId: string, entryId: string, index: number, size: EntryImageSize): string {
  return `/api/sessions/${segment(sessionId)}/images?entry=${encodeURIComponent(entryId)}&index=${index}&size=${size}`;
}

export function seesEntryImages(session: Pick<SessionRecord, "permissions" | "status">): boolean {
  return (session.permissions ?? []).includes("write") && session.status !== "archived";
}

export function shownImages(entry: EntryView, sees: boolean): { mimeType: string }[] {
  return sees && Array.isArray(entry.images) ? entry.images : [];
}

export function textBesideImages(text: string, count: number): string {
  const lines = text.split("\n");
  for (let index = lines.length - 1, left = count; index >= 0 && left > 0; index--) {
    if (IMAGE_LINE.test(lines[index]!)) { lines.splice(index, 1); left--; }
  }
  return lines.join("\n").replace(/\s+$/, "");
}

export const imageSource = (image: EntryImage) => `data:${image.mimeType};base64,${image.data}`;

export function createEntryImageCache(load: (href: string) => Promise<{ image: EntryImage }>, limit = 200) {
  const kept = new Map<string, { loading: Promise<string>; source?: string }>();
  return {
    get(href: string): Promise<string> {
      const known = kept.get(href);
      if (known) {
        kept.delete(href);
        kept.set(href, known);
        return known.loading;
      }
      const item: { loading: Promise<string>; source?: string } = { loading: load(href).then(result => item.source = imageSource(result.image)) };
      kept.set(href, item);
      while (kept.size > limit) kept.delete(kept.keys().next().value!);
      item.loading.catch(() => { if (kept.get(href) === item) kept.delete(href); });
      return item.loading;
    },
    loaded(href: string): string | undefined {
      return kept.get(href)?.source;
    },
  };
}
export type EntryImageCache = ReturnType<typeof createEntryImageCache>;

export function entryImageCaches(load: (href: string) => Promise<{ image: EntryImage }>): Record<EntryImageSize, EntryImageCache> {
  return { thumbnail: createEntryImageCache(load, 200), full: createEntryImageCache(load, 4) };
}
