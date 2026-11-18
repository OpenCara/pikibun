import { createHash, randomBytes, type Hash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

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

  async #objects(): Promise<string[]> {
    const found: string[] = [];
    const base = join(this.root, "objects");
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

async function names(directory: string): Promise<string[]> {
  try { return await readdir(directory); }
  catch { return []; }
}
