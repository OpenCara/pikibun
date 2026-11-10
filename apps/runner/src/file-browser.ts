import { lstat, open, readdir, type FileHandle } from "node:fs/promises";
import { checkBrowseResult, type BrowseResult } from "../../../packages/shared/src/file-browser.js";
import { fileBrowserLimits, type FileEntry } from "../../../packages/shared/src/types.js";
import { imageType } from "./images.js";
import { OPEN_DIRECTORY, OPEN_FILE, windows } from "./platform.js";

export type { BrowseResult };

const FILE_FLAGS = OPEN_FILE;
const DIRECTORY_FLAGS = OPEN_DIRECTORY;
const MAX_LISTED = 100_000;

export function sortEntries(entries: FileEntry[]): FileEntry[] {
  return entries.sort((a, b) => Number(a.type !== "directory") - Number(b.type !== "directory") || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function checkedBrowse(value: unknown): BrowseResult {
  const result = checkBrowseResult(value);
  if (result.type === "file" && result.image && imageType(Buffer.from(result.image.data, "base64")) !== result.image.mimeType) {
    throw new Error("Invalid file browser response");
  }
  return result;
}

async function readablePath(directory: string, handle: FileHandle): Promise<{ path: string; check(): Promise<void> }> {
  if (process.platform === "linux") return { path: `/proc/self/fd/${handle.fd}`, check: async () => {} };
  const opened = await handle.stat({ bigint: true });
  const check = async () => {
    const now = await lstat(directory, { bigint: true });
    if (!now.isDirectory() || now.dev !== opened.dev || now.ino !== opened.ino) throw new Error("directory changed while being read; retry the operation");
  };
  await check();
  return { path: directory, check };
}

export async function browseDirectory(directory: string): Promise<BrowseResult> {
  const handle = windows ? undefined : await open(directory, DIRECTORY_FLAGS);
  try {
    const { path: opened, check } = handle ? await readablePath(directory, handle) : await windowsDirectory(directory);
    const names = await readdir(opened);
    if (names.length > MAX_LISTED) throw new Error("directory has too many entries");
    const entries: FileEntry[] = [];
    for (const name of names) {
      let info;
      try { info = await lstat(`${opened}/${name}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      const type: FileEntry["type"] = info.isDirectory() ? "directory" : info.isFile() ? "file" : info.isSymbolicLink() ? "symlink" : "other";
      entries.push({ name, type, ...(type === "file" ? { size: info.size } : {}) });
    }
    await check();
    sortEntries(entries);
    return { type: "directory", entries: entries.slice(0, fileBrowserLimits.entries), total: entries.length, truncated: entries.length > fileBrowserLimits.entries };
  } finally {
    await handle?.close();
  }
}

async function windowsDirectory(directory: string): Promise<{ path: string; check(): Promise<void> }> {
  const opened = await lstat(directory, { bigint: true });
  if (!opened.isDirectory()) throw new Error("not a directory");
  const check = async () => {
    const now = await lstat(directory, { bigint: true });
    if (!now.isDirectory() || now.dev !== opened.dev || now.ino !== opened.ino) throw new Error("directory changed while being read; retry the operation");
  };
  return { path: directory, check };
}

export async function browseFile(file: string): Promise<BrowseResult> {
  const handle = await open(file, FILE_FLAGS);
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { type: "file", size: 0, truncated: false, binary: true };
    const size = info.size;
    const read = async (limit: number): Promise<Buffer> => {
      const buffer = Buffer.alloc(limit);
      let length = 0;
      while (length < limit) {
        const { bytesRead } = await handle.read(buffer, length, limit - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      return buffer.subarray(0, length);
    };
    const head = await read(16);
    const mimeType = imageType(head);
    if (mimeType) {
      if (size > fileBrowserLimits.imageBytes) return { type: "file", size, truncated: true, binary: true };
      const data = await read(fileBrowserLimits.imageBytes + 1);
      if (data.length > fileBrowserLimits.imageBytes) return { type: "file", size, truncated: true, binary: true };
      return { type: "file", size, truncated: false, image: { mimeType, data: data.toString("base64") } };
    }
    const prefix = await read(fileBrowserLimits.textBytes + 1);
    const truncated = prefix.length > fileBrowserLimits.textBytes || size > fileBrowserLimits.textBytes;
    return { type: "file", size, truncated, ...textPreview(prefix.subarray(0, fileBrowserLimits.textBytes), truncated) };
  } finally {
    await handle.close();
  }
}

export function textPreview(data: Uint8Array, truncated: boolean): { text: string } | { binary: true } {
  if (data.includes(0)) return { binary: true };
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let cut = 0; cut <= (truncated ? 3 : 0) && cut <= data.length; cut++) {
    try { return { text: decoder.decode(data.subarray(0, data.length - cut)) }; } catch { }
  }
  return { binary: true };
}
