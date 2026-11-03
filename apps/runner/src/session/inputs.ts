import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ChatImage } from "../../../../packages/shared/src/chat-images.js";
import { IMAGE_BUSY, IMAGE_ERROR, imageType, prepareImage } from "../images.js";
import { RunnerError } from "../protocol.js";

/*
 * The images of a session's queued messages, prepared as the model gets them, waiting on disk until their messages reach
 * Pi: outside the sandbox and the backups, one file per run, by the run's key (the hash `requestKey` makes, so always a
 * plain file name). The session decides when a run's images go (its ledger); this keeps them whole or not at all.
 */

/** A message's image as the model gets it: prepared by `prepareImage`, base64. */
export type InputImage = { mimeType: string; data: string };

/** Decodes a message's images and fits them to what the model gets of an image, as read_file does for image files. */
export async function prepareMessageImages(images: readonly ChatImage[]): Promise<InputImage[]> {
  const prepared: InputImage[] = [];
  for (const image of images) {
    const bytes = Buffer.from(image.data, "base64");
    // The sender names the type, and an image passed through to a provider under another type than its bytes would
    // fail every later turn of the conversation: the bytes' signature must say the same.
    if (imageType(bytes) !== image.mimeType) throw new RunnerError(422, IMAGE_ERROR);
    const result = await prepareImage(bytes, image.mimeType);
    // 422 carries this fixed, runner-authored reason through the Worker to the sender.
    if ("error" in result) throw new RunnerError(422, result.error === IMAGE_BUSY ? "Too many images are being prepared at once. Send the message again shortly" : result.error);
    prepared.push({ mimeType: result.image.mimeType, data: result.image.data });
  }
  return prepared;
}

export class MessageInputs {
  /** `directory`: where they wait (the session's `inputs`). */
  constructor(readonly directory: string) {}

  #path(key: string): string {
    return join(this.directory, `${key}.json`);
  }

  /** Keeps a queued run's prepared images, whole or not at all, until it reaches Pi. */
  async write(key: string, images: readonly InputImage[]): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `.${key}.${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify({ images }));
        await file.sync();
      } finally { await file.close(); }
      await rename(temporary, this.#path(key));
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  /** A run's prepared images; undefined when they are gone or unreadable. */
  async read(key: string): Promise<InputImage[] | undefined> {
    try {
      const images = (JSON.parse(await readFile(this.#path(key), "utf8")) as { images?: unknown }).images;
      if (!Array.isArray(images) || !images.length
        || images.some(image => typeof image?.mimeType !== "string" || typeof image.data !== "string")) return undefined;
      return images as InputImage[];
    } catch { return undefined; }
  }

  async discard(keys: readonly string[]): Promise<void> {
    await Promise.all(keys.map(key => rm(this.#path(key), { force: true }).catch(() => {})));
  }

  /**
   * Removes every file but the images of the runs `waiting` names by key: those of runs that no longer wait to reach Pi,
   * and whatever a run that never committed left (its temporary file).
   */
  async sweep(waiting: (key: string) => boolean): Promise<void> {
    let names: string[];
    try { names = await readdir(this.directory); }
    catch { return; }
    const kept = (name: string) => name.endsWith(".json") && waiting(name.slice(0, -".json".length));
    await Promise.all(names.filter(name => !kept(name)).map(name => rm(join(this.directory, name), { force: true }).catch(() => {})));
  }
}
