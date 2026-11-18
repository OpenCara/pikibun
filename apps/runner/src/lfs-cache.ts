import { createHash, randomBytes, type Hash } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, rename, rm, utimes, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

const windows = process.platform === "win32";
const OID = /^[0-9a-f]{64}$/;
const TEMPORARY_AGE_MS = 24 * 60 * 60 * 1000;
const TEMPORARY_IDLE_MS = 60 * 60 * 1000;
const READ_FLAGS = constants.O_RDONLY | (windows ? 0 : constants.O_NOFOLLOW);

export class LfsCacheError extends Error {
  constructor(message: string) { super(message); this.name = "LfsCacheError"; }
}

export interface LfsObject { oid: string; size: number }
export interface LfsCacheUsage { objects: number; bytes: number }
export interface LfsShareResult { added: number; linked: number; kept: number; skipped: number }

export class LfsObjectCache {
  readonly root: string;

  constructor(root: string) {
    if (!isAbsolute(root) || resolve(root) === sep) throw new LfsCacheError("Git LFS cache root must be an absolute, non-root path");
    this.root = resolve(root);
  }

  path(oid: string): string {
    if (!OID.test(oid)) throw new LfsCacheError("Invalid Git LFS object id");
    return join(this.root, "objects", oid.slice(0, 2), oid.slice(2, 4), oid);
  }

  async open(object: LfsObject): Promise<FileHandle | undefined> {
    const path = this.path(object.oid);
    if (!await this.#private()) return undefined;
    let handle: FileHandle;
    try { handle = await open(path, READ_FLAGS); }
    catch { return undefined; }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size !== object.size) {
        await handle.close();
        return undefined;
      }
      const now = new Date();
      await handle.utimes(now, now).catch(() => {});
      return handle;
    } catch {
      await handle.close().catch(() => {});
      return undefined;
    }
  }

  async discard(oid: string, handle: FileHandle): Promise<void> {
    const path = this.path(oid);
    const [opened, current] = await Promise.all([handle.stat(), lstat(path)]);
    if (opened.ino === current.ino && opened.dev === current.dev) await rm(path, { force: true });
  }

  async writer(object: LfsObject): Promise<LfsObjectWriter> {
    const target = this.path(object.oid);
    await this.#prepare();
    const temporary = join(this.root, "tmp");
    await mkdir(temporary, { recursive: true, mode: 0o700 });
    const path = join(temporary, `${object.oid}.${randomBytes(8).toString("hex")}`);
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (windows ? 0 : constants.O_NOFOLLOW), 0o600);
    return new LfsObjectWriter(object, handle, path, target);
  }

  async reference(): Promise<string | undefined> {
    try {
      await this.#prepare();
      await mkdir(join(this.root, "objects"), { recursive: true, mode: 0o700 });
      return this.root;
    } catch {
      return undefined;
    }
  }

  async share(gitDirectory: string): Promise<LfsShareResult> {
    const result = { added: 0, linked: 0, kept: 0, skipped: 0 };
    if (!isAbsolute(gitDirectory)) throw new LfsCacheError("A clone's Git directory must be an absolute path");
    await this.#prepare();
    for (const source of await objectFiles(join(gitDirectory, "lfs", "objects"))) {
      const oid = source.slice(-64);
      try {
        const info = await lstat(source);
        if (!info.isFile()) { result.skipped++; continue; }
        const target = this.path(oid);
        const kept = await lstat(target).catch(() => undefined);
        if (kept?.isFile() && kept.size === info.size) {
          const now = new Date();
          if (kept.ino === info.ino && kept.dev === info.dev) {
            await utimes(target, now, now).catch(() => {});
            result.kept++;
            continue;
          }
          const swap = join(dirname(source), `.${oid}.pikibun-${randomBytes(8).toString("hex")}`);
          await link(target, swap);
          try { await rename(swap, source); }
          catch (error) { await rm(swap, { force: true }).catch(() => {}); throw error; }
          await utimes(target, now, now).catch(() => {});
          result.linked++;
          continue;
        }
        if (await this.#adopt(source, { oid, size: info.size })) result.added++;
        else result.skipped++;
      } catch {
        result.skipped++;
      }
    }
    return result;
  }

  async #adopt(source: string, object: LfsObject): Promise<boolean> {
    const temporary = join(this.root, "tmp");
    await mkdir(temporary, { recursive: true, mode: 0o700 });
    const staged = join(temporary, `${object.oid}.${randomBytes(8).toString("hex")}`);
    try {
      await link(source, staged);
    } catch {
      return this.#copy(source, object);
    }
    try {
      if (!await matches(staged, object)) return false;
      await mkdir(dirname(this.path(object.oid)), { recursive: true, mode: 0o700 });
      await rename(staged, this.path(object.oid));
      return true;
    } finally {
      await rm(staged, { force: true }).catch(() => {});
    }
  }

  async #copy(source: string, object: LfsObject): Promise<boolean> {
    const handle = await open(source, READ_FLAGS);
    const writer = await this.writer(object);
    try {
      for await (const chunk of handle.createReadStream({ autoClose: false })) await writer.write(chunk as Buffer);
      return await writer.commit();
    } catch {
      await writer.abort();
      return false;
    } finally {
      await handle.close().catch(() => {});
    }
  }

  async usage(): Promise<LfsCacheUsage> {
    let objects = 0, bytes = 0;
    for (const path of await this.#objects()) {
      try { bytes += (await lstat(path)).size; objects++; } catch { }
    }
    return { objects, bytes };
  }

  async prune(age: number): Promise<LfsCacheUsage> {
    if (!Number.isSafeInteger(age) || age < 0) throw new LfsCacheError("Invalid prune age");
    const now = Date.now();
    let objects = 0, bytes = 0;
    for (const path of await this.#objects()) {
      try {
        const info = await lstat(path);
        if (now - info.mtimeMs < age) continue;
        await rm(path, { force: true });
        objects++;
        bytes += info.size;
      } catch { }
    }
    for (const name of await names(join(this.root, "tmp"))) {
      const path = join(this.root, "tmp", name);
      try { if (now - (await lstat(path)).mtimeMs >= Math.max(Math.min(age, TEMPORARY_AGE_MS), TEMPORARY_IDLE_MS)) await rm(path, { force: true }); } catch { }
    }
    return { objects, bytes };
  }

  async #prepare(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if (!await this.#private()) throw new LfsCacheError("Git LFS cache root must be a private directory owned by the runner user");
  }

  async #private(): Promise<boolean> {
    try {
      const info = await lstat(this.root);
      return info.isDirectory() && (windows || (info.uid === process.getuid?.() && (info.mode & 0o077) === 0));
    } catch {
      return false;
    }
  }

  #objects(): Promise<string[]> {
    return objectFiles(join(this.root, "objects"));
  }
}

export class LfsObjectWriter {
  readonly #hash: Hash = createHash("sha256");
  #bytes = 0;
  #failed = false;
  #settled = false;

  constructor(private readonly object: LfsObject, private readonly handle: FileHandle, private readonly temporary: string, private readonly target: string) {}

  async write(chunk: Uint8Array): Promise<void> {
    if (this.#failed || this.#settled) return;
    this.#bytes += chunk.byteLength;
    if (this.#bytes > this.object.size) { this.#failed = true; return; }
    this.#hash.update(chunk);
    try {
      let offset = 0;
      while (offset < chunk.byteLength) offset += (await this.handle.write(chunk, offset, chunk.byteLength - offset)).bytesWritten;
    } catch {
      this.#failed = true;
    }
  }

  async commit(): Promise<boolean> {
    if (this.#settled) return false;
    if (this.#failed || this.#bytes !== this.object.size || this.#hash.digest("hex") !== this.object.oid) {
      await this.abort();
      return false;
    }
    this.#settled = true;
    try {
      await this.handle.close();
      await mkdir(resolve(this.target, ".."), { recursive: true, mode: 0o700 });
      await rename(this.temporary, this.target);
      return true;
    } catch {
      await rm(this.temporary, { force: true }).catch(() => {});
      return false;
    }
  }

  async abort(): Promise<void> {
    if (this.#settled) return;
    this.#settled = true;
    await this.handle.close().catch(() => {});
    await rm(this.temporary, { force: true }).catch(() => {});
  }
}

async function matches(path: string, object: LfsObject): Promise<boolean> {
  const handle = await open(path, READ_FLAGS);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size !== object.size) return false;
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytes += (chunk as Buffer).length;
      if (bytes > object.size) return false;
      hash.update(chunk as Buffer);
    }
    return bytes === object.size && hash.digest("hex") === object.oid;
  } finally {
    await handle.close().catch(() => {});
  }
}

async function objectFiles(base: string): Promise<string[]> {
  const found: string[] = [];
  for (const first of await names(base)) {
    if (!/^[0-9a-f]{2}$/.test(first)) continue;
    for (const second of await names(join(base, first))) {
      if (!/^[0-9a-f]{2}$/.test(second)) continue;
      for (const name of await names(join(base, first, second))) {
        if (OID.test(name) && name.startsWith(first + second)) found.push(join(base, first, second, name));
      }
    }
  }
  return found;
}

async function names(directory: string): Promise<string[]> {
  try { return await readdir(directory); }
  catch { return []; }
}
