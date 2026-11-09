import { IMAGE_LINE, type EntryImage, type EntryImageSize } from "../../shared/src/entry-images";
import type { EntryView, SessionRecord } from "../../shared/src/types";
import { segment } from "./api";

/*
 * The images of a transcript entry, as clients show them: thumbnails in place of the `[image <type>]` lines the entry's
 * text holds for them, each opening the whole image. Only collaborators (`write`) see them, as only they can read the
 * session's files; everyone else, and a host that lists no images, keeps the lines.
 */

/** `GET /api/sessions/:id/images`: the `index`th image of the entry `entryId`. */
export function entryImageHref(sessionId: string, entryId: string, index: number, size: EntryImageSize): string {
  return `/api/sessions/${segment(sessionId)}/images?entry=${encodeURIComponent(entryId)}&index=${index}&size=${size}`;
}

/** Whether this person's client shows a session's transcript images: a collaborator's, in a session not archived. */
export function seesEntryImages(session: Pick<SessionRecord, "permissions" | "status">): boolean {
  return (session.permissions ?? []).includes("write") && session.status !== "archived";
}

/** The images `entry` shows, where its viewer sees them (`seesEntryImages`); none otherwise. */
export function shownImages(entry: EntryView, sees: boolean): { mimeType: string }[] {
  return sees && Array.isArray(entry.images) ? entry.images : [];
}

/**
 * An entry's text beside its `count` thumbnails: without the lines that stood for them, and without the blank end they
 * leave. The runner writes them after everything else the entry says, so they are its last `count` image lines: a line
 * typed to look like one, above them, stays.
 */
export function textBesideImages(text: string, count: number): string {
  const lines = text.split("\n");
  for (let index = lines.length - 1, left = count; index >= 0 && left > 0; index--) {
    if (IMAGE_LINE.test(lines[index]!)) { lines.splice(index, 1); left--; }
  }
  return lines.join("\n").replace(/\s+$/, "");
}

/** A data: URL of an image. */
export const imageSource = (image: EntryImage) => `data:${image.mimeType};base64,${image.data}`;

/**
 * Images read for a client, by their href, so a transcript drawn again (a new view, a recycled row) asks the host once:
 * at most `limit`, the least recently shown going first. One that failed is asked for again when next shown. Clients
 * keep thumbnails (up to 64 KiB each) in one, and whole images (up to megabytes) in a much smaller other
 * (`entryImageCaches`).
 */
export function createEntryImageCache(load: (href: string) => Promise<{ image: EntryImage }>, limit = 200) {
  const kept = new Map<string, { loading: Promise<string>; source?: string }>();
  return {
    /** The image as a data: URL. */
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
    /** The image as a data: URL if it is loaded already, so a row drawn again shows it at once. */
    loaded(href: string): string | undefined {
      return kept.get(href)?.source;
    },
  };
}
export type EntryImageCache = ReturnType<typeof createEntryImageCache>;

/** A client's caches: the transcript's thumbnails, and the few whole images last opened. */
export function entryImageCaches(load: (href: string) => Promise<{ image: EntryImage }>): Record<EntryImageSize, EntryImageCache> {
  return { thumbnail: createEntryImageCache(load, 200), full: createEntryImageCache(load, 4) };
}
