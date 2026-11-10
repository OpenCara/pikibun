import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { join, posix } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflateRaw, crc32 } from "node:zlib";
import { browserAt, type BrowserToolchain } from "./browser-toolchain.js";

export const CHROME_FOR_TESTING_VERSIONS = "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json";
const DOWNLOAD_PREFIX = "https://storage.googleapis.com/chrome-for-testing-public/";
const PLATFORM = "linux64";
const SHELL_DIRECTORY = "chrome-headless-shell-linux64";
const SHELL = "chrome-headless-shell";
const VERSION = /^\d{1,5}(?:\.\d{1,6}){3}$/;

export const downloadLimits = Object.freeze({
  zipBytes: 512 * 1024 * 1024,
  extractedBytes: 2 * 1024 * 1024 * 1024,
  entries: 10_000,
  versionsBytes: 4 * 1024 * 1024,
});

export interface BrowserRelease { version: string; url: string }

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

async function reach(fetcher: typeof fetch, url: string, signal: AbortSignal | undefined, what: string): Promise<Response> {
  try { return await fetcher(url, { ...(signal ? { signal } : {}) }); }
  catch (error) {
    if (signal?.aborted) throw error;
    const cause = error instanceof Error && error.cause instanceof Error ? (error.cause as NodeJS.ErrnoException).code ?? error.cause.message : undefined;
    throw new Error(`Couldn't reach ${new URL(url).host} for ${what}${typeof cause === "string" && cause ? ` (${cause.slice(0, 200)})` : ""}`);
  }
}

export async function latestHeadlessShell(options: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<BrowserRelease> {
  const response = await reach(options.fetch ?? fetch, CHROME_FOR_TESTING_VERSIONS, options.signal, "Chrome for Testing's versions");
  if (!response.ok) throw new Error(`Chrome for Testing's versions answered ${response.status}`);
  const text = await response.text();
  if (text.length > downloadLimits.versionsBytes) throw new Error("Chrome for Testing's versions are too long");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Chrome for Testing's versions aren't JSON"); }
  const stable = isObject(value) && isObject(value.channels) ? value.channels.Stable : undefined;
  const builds = isObject(stable) && isObject(stable.downloads) ? stable.downloads[SHELL] : undefined;
  const version = isObject(stable) ? stable.version : undefined;
  if (typeof version !== "string" || !VERSION.test(version) || !Array.isArray(builds)) throw new Error("Chrome for Testing lists no Stable headless shell");
  const build = builds.find(item => isObject(item) && item.platform === PLATFORM);
  const url = isObject(build) ? build.url : undefined;
  if (typeof url !== "string" || url !== `${DOWNLOAD_PREFIX}${version}/${PLATFORM}/${SHELL}-${PLATFORM}.zip`) {
    throw new Error("Chrome for Testing's headless shell isn't where its builds are");
  }
  return { version, url };
}

export async function downloadedHeadlessShells(root: string): Promise<{ version: string; browser: BrowserToolchain }[]> {
  const names = await readdir(root).catch(() => [] as string[]);
  const newer = (a: string, b: string) => { const x = a.split(".").map(Number); const y = b.split(".").map(Number); for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return y[i]! - x[i]!; return 0; };
  return names.filter(name => VERSION.test(name)).sort(newer).flatMap(version => {
    const browser = browserAt(join(root, version, SHELL_DIRECTORY, SHELL));
    return browser ? [{ version, browser }] : [];
  });
}

export async function downloadHeadlessShell(root: string, release: BrowserRelease, options: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<BrowserToolchain> {
  if (!VERSION.test(release.version) || !release.url.startsWith(DOWNLOAD_PREFIX)) throw new Error("Not a Chrome for Testing build");
  const target = join(root, release.version);
  const existing = browserAt(join(target, SHELL_DIRECTORY, SHELL));
  if (existing) return existing;
  await mkdir(root, { recursive: true, mode: 0o700 });
  const zip = join(root, `.${release.version}.zip`);
  const partial = join(root, `.${release.version}.partial`);
  await rm(partial, { recursive: true, force: true });
  try {
    const response = await reach(options.fetch ?? fetch, release.url, options.signal, "the headless shell's download");
    if (!response.ok || !response.body) throw new Error(`The download answered ${response.status}`);
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > downloadLimits.zipBytes) throw new Error("The download is larger than a headless shell");
    let received = 0;
    const counted = new Transform({ transform(chunk: Buffer, _encoding, done) {
      received += chunk.length;
      done(received > downloadLimits.zipBytes ? new Error("The download is larger than a headless shell") : null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), counted, createWriteStream(zip, { mode: 0o600 }),
      { ...(options.signal ? { signal: options.signal } : {}) });
    await extractZip(zip, partial);
    if (!browserAt(join(partial, SHELL_DIRECTORY, SHELL))) throw new Error("The download holds no headless shell");
    await rm(target, { recursive: true, force: true });
    await rename(partial, target);
  } finally {
    await rm(zip, { force: true });
    await rm(partial, { recursive: true, force: true });
  }
  const browser = browserAt(join(target, SHELL_DIRECTORY, SHELL));
  if (!browser) throw new Error("The downloaded headless shell isn't usable");
  return browser;
}

export async function pruneHeadlessShells(root: string, keep: readonly string[]): Promise<void> {
  for (const name of await readdir(root).catch(() => [] as string[])) {
    if (!keep.includes(name)) await rm(join(root, name), { recursive: true, force: true }).catch(() => {});
  }
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;

function entryPath(name: string): string {
  const parts = name.split("/");
  const directory = name.endsWith("/");
  if (directory) parts.pop();
  if (!name || name.startsWith("/") || name.includes("\\") || name.includes("\0") || !parts.length
    || parts.some(part => !part || part === "." || part === "..")) throw new Error(`The archive holds a path it may not: ${JSON.stringify(name.slice(0, 200))}`);
  return posix.join(...parts);
}

export async function extractZip(file: string, destination: string): Promise<void> {
  const handle = await open(file, "r");
  const entries: { name: string; method: number; compressed: number; size: number; crc: number; offset: number; mode: number }[] = [];
  try {
    const { size } = await handle.stat();
    const tail = Buffer.alloc(Math.min(size, 22 + 0xffff));
    await handle.read(tail, 0, tail.length, size - tail.length);
    let end = -1;
    for (let at = tail.length - 22; at >= 0; at--) if (tail.readUInt32LE(at) === EOCD) { end = at; break; }
    if (end < 0) throw new Error("Not a zip archive");
    const count = tail.readUInt16LE(end + 10);
    const centralSize = tail.readUInt32LE(end + 12);
    const centralOffset = tail.readUInt32LE(end + 16);
    if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error("ZIP64 archives aren't taken");
    if (count > downloadLimits.entries || centralOffset + centralSize > size) throw new Error("Invalid zip archive");
    const central = Buffer.alloc(centralSize);
    await handle.read(central, 0, centralSize, centralOffset);
    let at = 0;
    for (let index = 0; index < count; index++) {
      if (at + 46 > central.length || central.readUInt32LE(at) !== CENTRAL) throw new Error("Invalid zip archive");
      const madeBy = central.readUInt16LE(at + 4) >> 8;
      const flags = central.readUInt16LE(at + 8);
      const method = central.readUInt16LE(at + 10);
      const crc = central.readUInt32LE(at + 16);
      const compressed = central.readUInt32LE(at + 20);
      const uncompressed = central.readUInt32LE(at + 24);
      const nameLength = central.readUInt16LE(at + 28);
      const extraLength = central.readUInt16LE(at + 30);
      const commentLength = central.readUInt16LE(at + 32);
      const external = central.readUInt32LE(at + 38);
      const offset = central.readUInt32LE(at + 42);
      const name = central.subarray(at + 46, at + 46 + nameLength).toString("utf8");
      at += 46 + nameLength + extraLength + commentLength;
      if (flags & 1) throw new Error("Encrypted zip entries aren't taken");
      if (compressed === 0xffffffff || uncompressed === 0xffffffff || offset === 0xffffffff) throw new Error("ZIP64 archives aren't taken");
      if (method !== 0 && method !== 8) throw new Error(`Zip compression method ${method} isn't taken`);
      const unix = madeBy === 3 ? external >>> 16 : 0;
      const type = unix & S_IFMT;
      if (type && type !== S_IFREG && type !== S_IFDIR) throw new Error(`The archive holds a link or special file: ${JSON.stringify(name.slice(0, 200))}`);
      entries.push({ name, method, compressed, size: uncompressed, crc, offset, mode: type === S_IFDIR || name.endsWith("/") ? -1 : unix & 0o777 });
    }
    if (entries.reduce((total, entry) => total + entry.size, 0) > downloadLimits.extractedBytes) throw new Error("The archive is larger than a headless shell");
    await mkdir(destination, { recursive: true, mode: 0o700 });
    for (const entry of entries) {
      const path = join(destination, entryPath(entry.name));
      if (entry.mode === -1) { await mkdir(path, { recursive: true, mode: 0o755 }); continue; }
      await mkdir(join(path, ".."), { recursive: true, mode: 0o755 });
      const local = Buffer.alloc(30);
      await handle.read(local, 0, 30, entry.offset);
      if (local.readUInt32LE(0) !== LOCAL) throw new Error("Invalid zip archive");
      const start = entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      if (start + entry.compressed > size) throw new Error("Invalid zip archive");
      let written = 0;
      let checksum = 0;
      const checked = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          written += chunk.length;
          checksum = crc32(chunk, checksum);
          done(written > entry.size ? new Error(`${entry.name} is larger than the archive says`) : null, chunk);
        },
        flush(done) { done(written !== entry.size || checksum !== entry.crc ? new Error(`${entry.name} doesn't match the archive's checksum`) : null); },
      });
      const mode = entry.mode & 0o111 ? 0o755 : 0o644;
      const source = entry.compressed ? createReadStream(file, { start, end: start + entry.compressed - 1 }) : Readable.from([]);
      const target = createWriteStream(path, { mode, flags: "wx" });
      if (entry.method === 8) await pipeline(source, createInflateRaw(), checked, target);
      else await pipeline(source, checked, target);
      await chmod(path, mode);
    }
  } finally {
    await handle.close();
  }
}
