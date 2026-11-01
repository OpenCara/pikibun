import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, rename, rm, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { RunnerBinding } from "../../../packages/shared/src/types.js";
import { RunnerError } from "./protocol.js";
import { sandboxContent, writePrivate, type SnapshotFile } from "./restore.js";
import { Sandbox, type CloneBackup, type SnapshotFile as SandboxFile } from "./sandbox.js";

/**
 * Packed sessions. An archived session's owner can pack its files to save the host's disk, inodes above all: its
 * `sandbox` directory (home, worktree, the worktree's Git directory) becomes one compressed file beside it, in the format
 * of a backup's files (restore.ts): clones as bundles of their local work, cloned again when the session next opens, and
 * no package caches or temporary files in its home (PACK_SKIPPED_HOME). Its conversation and state stay as they are, so
 * the session still opens to show them; nothing else runs in it until it is unarchived, which unpacks it.
 *
 * Every step leaves the session directory in one of two states, whatever crash interrupts it (see settlePack):
 * - unpacked: `sandbox/`, and no PACK_FILE;
 * - packed: PACK_FILE, and no `sandbox/`.
 * A pack is written and synced before the sandbox goes, which is renamed away before it is deleted; an unpacked sandbox
 * is written and synced in a staging directory and renamed into place before the pack goes. Both at once means the
 * sandbox is complete, so it wins.
 */

export const PACK_FILE = "sandbox.pack";
const PACK_FORMAT = "pistead-sandbox-pack-v1";
/** A pack's JSON, as large as a backup may be (restore.ts MAX_BYTES), and so is the compressed file. */
const MAX_PACK_BYTES = 24 * 1024 * 1024;
/** Files a pack holds besides its clones, as many as a backup's (restore.ts MAX_FILES). */
const MAX_PACK_FILES = 10_000;
const TEMPORARY_PREFIX = `${PACK_FILE}.tmp-`;
const STAGE_PREFIX = ".sandbox-unpack-";
const DELETE_PREFIX = ".sandbox-delete-";
const SANDBOX = "sandbox";

/** A session's files as its pack keeps them, as the sandbox read them. */
export interface PackContent { files: readonly SandboxFile[]; clones?: readonly CloneBackup[] }
/** What a pack holds: its files and clones, and its size on disk. */
export interface PackSummary { files: number; clones: number; bytes: number }

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

async function exists(path: string): Promise<"file" | "directory" | "other" | undefined> {
  try {
    const info = await lstat(path);
    return info.isFile() ? "file" : info.isDirectory() ? "directory" : "other";
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Syncs every file and directory below `path`, which only the runner wrote, deepest first. */
async function syncTree(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isDirectory()) {
    for (const name of await readdir(path)) await syncTree(join(path, name));
    await syncDirectory(path);
  } else if (info.isFile()) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  }
}

/**
 * Removes `path` and everything below it, which the session's commands made: a directory they left without write or
 * search permission is given it back first. Symlinks are removed, never followed.
 */
async function removeTree(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
    return;
  } catch (error) {
    if (!["EACCES", "EPERM", "ENOTEMPTY"].includes(errorCode(error) ?? "")) throw error;
  }
  const permit = async (directory: string): Promise<void> => {
    const info = await lstat(directory).catch(() => undefined);
    if (!info?.isDirectory()) return;
    await chmod(directory, 0o700);
    for (const name of await readdir(directory)) await permit(join(directory, name));
  };
  await permit(path);
  await rm(path, { recursive: true, force: true });
}

/**
 * Brings the session directory back to one of its two states after a step that didn't finish, and says which: true
 * when its files are packed. Called before the session opens; the caller ensures nothing else works on it meanwhile.
 */
export async function settlePack(directory: string): Promise<boolean> {
  let names: string[];
  try { names = await readdir(directory); }
  catch (error) { if (errorCode(error) === "ENOENT") return false; throw error; }
  let changed = false;
  for (const name of names) {
    if (name.startsWith(TEMPORARY_PREFIX)) await rm(join(directory, name), { force: true });
    else if (name.startsWith(STAGE_PREFIX) || name.startsWith(DELETE_PREFIX)) await removeTree(join(directory, name));
    else continue;
    changed = true;
  }
  const pack = await exists(join(directory, PACK_FILE));
  if (pack !== undefined && pack !== "file") throw new RunnerError(409, "The session's pack is not a regular file");
  const packed = pack === "file";
  if (packed && await exists(join(directory, SANDBOX)) !== undefined) {
    // The sandbox is only ever complete where it is: a pack that didn't finish, or an unpack that did.
    await rm(join(directory, PACK_FILE), { force: true });
    await syncDirectory(directory);
    return false;
  }
  if (changed) await syncDirectory(directory);
  return packed;
}

/** Whether the session's files are packed, as the session directory says once settled (settlePack). */
export async function isPacked(directory: string): Promise<boolean> {
  return await exists(join(directory, PACK_FILE)) === "file";
}

/** Why the sandbox's files can't be packed, in words the control plane shows (a runner 422), from an error reading them. */
export function packRefusal(error: unknown): unknown {
  if (error instanceof RunnerError) return error;
  const message = error instanceof Error ? error.message : "";
  if (/refuses symlinks and special files/.test(message)) {
    return new RunnerError(422, "This session has symlinks or special files outside its clones, which a pack can't keep. Remove them, or leave the session unpacked");
  }
  if (/non-hardlinked files/.test(message)) return new RunnerError(422, "This session has hardlinked files outside its clones, which a pack can't keep");
  if (/too many files|too many entries|nesting limit/.test(message)) return new RunnerError(422, "This session has too many files to pack: a pack holds at most 10,000 files outside its clones");
  if (/exceeds size limit|byte output limit/.test(message)) return new RunnerError(422, "This session's files are too large to pack: a pack holds at most 24 MiB");
  if (/too many clones|too many branches/.test(message)) return new RunnerError(422, "This session has too many clones or branches to pack");
  if (/has stashed changes/.test(message)) {
    return new RunnerError(422, "One of this session's clones has stashed changes (git stash), which a pack can't keep. Unarchive it to apply or drop them, or leave it unpacked");
  }
  if (/refs other than branches and tags/.test(message)) return new RunnerError(422, "One of this session's clones has refs other than branches and tags, which a pack can't keep");
  if (/has tags on commits/.test(message)) return new RunnerError(422, "One of this session's clones has tags on commits its origin doesn't have, which a pack can't keep. Push them first, or leave it unpacked");
  if (/borrows objects from the host cache/.test(message)) {
    return new RunnerError(422, "One of this session's clones borrows from the host's repository cache, which an archived session can't read, so it can't be packed yet");
  }
  if (/the clone .* could not be backed up|can't be backed up/.test(message)) return new RunnerError(422, "One of this session's clones can't be packed");
  return error;
}

/** The pack of `content` for the session of `binding`, compressed, once it is checked exactly as unpacking checks it. */
export function packBytes(binding: RunnerBinding, content: PackContent): Buffer {
  const value = { format: PACK_FORMAT, sessionId: binding.session.id, createdAt: new Date().toISOString(), files: content.files,
    ...(content.clones?.length ? { clones: content.clones } : {}) };
  if (content.files.length > MAX_PACK_FILES) throw new RunnerError(422, "This session has too many files to pack: a pack holds at most 10,000 files outside its clones");
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > MAX_PACK_BYTES) throw new RunnerError(422, "This session's files are too large to pack: a pack holds at most 24 MiB");
  try { sandboxContent(JSON.parse(text) as Record<string, unknown>, binding); }
  catch (error) {
    if (!(error instanceof RunnerError)) throw error;
    if (/size limit/.test(error.message)) throw new RunnerError(422, "This session's files are too large to pack: a pack holds at most 24 MiB");
    if (/too many/.test(error.message)) throw new RunnerError(422, "This session has too many files to pack: a pack holds at most 10,000 files outside its clones");
    if (/repository cache/.test(error.message)) throw new RunnerError(422, "This session was checked out from the host's repository cache, so it can't be packed");
    throw new RunnerError(422, "This session's files can't be packed");
  }
  return gzipSync(text);
}

/**
 * Publishes the pack `bytes` in the session `directory`, then removes the sandbox it packs. The session must be closed,
 * with its sandbox.
 */
export async function writePack(directory: string, bytes: Uint8Array): Promise<void> {
  const pack = join(directory, PACK_FILE);
  const temporary = join(directory, `${TEMPORARY_PREFIX}${randomUUID()}`);
  try {
    await writePrivate(temporary, bytes);
    // Never replaces a pack: the directory was settled before the session opened, and it had none.
    await link(temporary, pack);
  } finally { await rm(temporary, { force: true }); }
  await syncDirectory(directory);
  const doomed = join(directory, `${DELETE_PREFIX}${randomUUID()}`);
  await rename(join(directory, SANDBOX), doomed);
  await syncDirectory(directory);
  await removeTree(doomed);
}

/** The files of the session's pack, checked as a backup's are (restore.ts), to write below its sandbox. */
export async function readPack(directory: string, binding: RunnerBinding): Promise<SnapshotFile[]> {
  const handle = await open(join(directory, PACK_FILE), constants.O_RDONLY | constants.O_NOFOLLOW);
  let compressed: Buffer;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size > MAX_PACK_BYTES) {
      throw new RunnerError(409, "The session's pack is not a private file of the host");
    }
    compressed = await handle.readFile();
  } finally { await handle.close(); }
  let value: unknown;
  try { value = JSON.parse(gunzipSync(compressed, { maxOutputLength: MAX_PACK_BYTES }).toString("utf8")); }
  catch { throw new RunnerError(409, "The session's pack is damaged"); }
  const record = value as Record<string, unknown> | null;
  if (!record || typeof record !== "object" || Array.isArray(record) || record.format !== PACK_FORMAT || record.sessionId !== binding.session.id
    || typeof record.createdAt !== "string" || Object.keys(record).some(key => !["format", "sessionId", "createdAt", "files", "clones"].includes(key))) {
    throw new RunnerError(409, "The session's pack is damaged");
  }
  return sandboxContent(record, binding);
}

/**
 * Writes `files` (readPack) as the session's sandbox again, in a staging directory the sandbox initializes as any
 * session's, publishes it, then removes the pack. The session must be closed.
 */
export async function unpackSandbox(directory: string, binding: RunnerBinding, files: readonly SnapshotFile[]): Promise<void> {
  if (await exists(join(directory, SANDBOX)) !== undefined) throw new RunnerError(409, "The session's files are already unpacked");
  const stage = join(directory, `${STAGE_PREFIX}${randomUUID()}`);
  await mkdir(stage, { mode: 0o700 });
  try {
    for (const name of ["home", "worktree", "git"]) await mkdir(join(stage, name), { mode: 0o700 });
    for (const file of files) {
      const path = join(stage, file.path);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writePrivate(path, file.bytes, file.mode);
    }
    const sandbox = new Sandbox(binding, stage);
    try { await sandbox.initialize(); } finally { await sandbox.close(); }
    await syncTree(stage);
    if (await exists(join(directory, SANDBOX)) !== undefined) throw new RunnerError(409, "The session's files are already unpacked");
    await rename(stage, join(directory, SANDBOX));
  } catch (error) {
    await removeTree(stage).catch(() => {});
    throw error;
  }
  await syncDirectory(directory);
  await unlink(join(directory, PACK_FILE));
  await syncDirectory(directory);
}
