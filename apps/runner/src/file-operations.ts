import { Worker } from "node:worker_threads";

/*
 * The file tools that move, copy and delete (#163): what sessions did with mv, cp, rm and mkdir in bash, each approved.
 * Like write_file they need no approval, stay in the worktree and never touch Git's metadata. Every backend does the
 * same: the Python helper (Linux and macOS sandboxes) in Python, the Windows Node helper and unsandboxed hosts (in a
 * worker thread) with FILE_OPERATIONS_CORE below; the conformance suite holds them to the same answers.
 *
 * Each path names an entry itself: its directory is resolved like any file tool's path (through links that stay in the
 * worktree), but its last component never is, so moving or deleting a link moves or deletes the link, never what it
 * points to. A destination is never replaced, and a directory is never put inside itself.
 */

export const fileOperationLimits = Object.freeze({
  /** Entries one copy makes. */
  entries: 10_000,
  /** Bytes of files one copy writes: an attachment's limit (fileUploadLimits.maxBytes). */
  bytes: 50 * 1024 * 1024,
  /** Directory levels a copy or delete goes down. */
  depth: 64,
});

export type FileOperationRequest =
  | { kind: "move"; from: string; to: string }
  | { kind: "copy"; from: string; to: string }
  | { kind: "delete"; path: string; recursive: boolean };

/** How many entries it moved, copied or deleted, and how many bytes of files a copy wrote. */
export interface FileOperationResult { entries: number; bytes: number }

const path = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !value || value.length > 1024 || value.includes("\0")) throw new Error(`${name} is a path in the worktree, such as src/app.ts`);
  return value;
};

/** A tool call's request, checked before it reaches a backend. */
export function fileOperationRequest(kind: "move" | "copy", input: { from: unknown; to: unknown }): FileOperationRequest;
export function fileOperationRequest(kind: "delete", input: { path: unknown; recursive?: unknown }): FileOperationRequest;
export function fileOperationRequest(kind: FileOperationRequest["kind"], input: Record<string, unknown>): FileOperationRequest {
  if (kind === "delete") {
    if (input.recursive !== undefined && typeof input.recursive !== "boolean") throw new Error("recursive is true or false");
    return { kind, path: path(input.path, "path"), recursive: input.recursive === true };
  }
  return { kind, from: path(input.from, "from"), to: path(input.to, "to") };
}

/** A backend's answer, checked. */
export function checkedFileOperation(value: unknown): FileOperationResult {
  const result = value as FileOperationResult;
  if (!result || typeof result !== "object" || !Number.isSafeInteger(result.entries) || result.entries < 0 || !Number.isSafeInteger(result.bytes) || result.bytes < 0) {
    throw new Error("Invalid file operation response");
  }
  return { entries: result.entries, bytes: result.bytes };
}

/**
 * The operation itself, on host paths a backend resolved: `source` and `target` (or `path`), each an entry in a
 * directory of the worktree, with their worktree-relative parts in `sourceParts` and `targetParts`, and `root`, the
 * worktree. Nothing is made before every check has passed; a move never replaces what appeared at its destination
 * since, and a failed copy removes only what it made. `fs` is the backend's (synchronous) file system; `limits`
 * fileOperationLimits. The Python helper mirrors it: change both together.
 */
export const FILE_OPERATIONS_CORE = String.raw`
class FileOperationRefusal extends Error {}
function fileOperation(fs, op, limits) {
  const refuse = message => { throw new FileOperationRefusal(message); };
  const found = path => { try { return fs.lstat(path); } catch (error) { if (error && error.code === "ENOENT") return undefined; throw error; } };
  const removeAll = (path, depth) => {
    if (depth > limits.depth) refuse("directory nesting limit exceeded");
    const entry = fs.lstat(path);
    if (entry.directory && !entry.link) {
      let count = 1;
      for (const name of fs.list(path)) count += removeAll(fs.join(path, name), depth + 1);
      fs.rmdir(path);
      return count;
    }
    fs.unlink(path);
    return 1;
  };
  if (op.kind === "delete") {
    const entry = found(op.path);
    if (!entry) refuse("no such file or directory");
    if (entry.directory && !entry.link && !op.recursive) {
      if (fs.list(op.path).length) refuse("the directory is not empty: delete it with recursive");
      fs.rmdir(op.path);
      return { entries: 1, bytes: 0 };
    }
    return { entries: removeAll(op.path, 0), bytes: 0 };
  }
  const source = found(op.source);
  if (!source) refuse("no such file or directory");
  const lower = parts => parts.map(part => fs.caseInsensitive ? part.toLowerCase() : part);
  const from = lower(op.sourceParts), to = lower(op.targetParts);
  if (to.length >= from.length && from.every((part, index) => part === to[index])) refuse("the destination is the source or inside it");
  if (found(op.target)) refuse("the destination exists already");
  // Only now, with every check passed, the destination's directories: real directories of the worktree, never links.
  let parent = op.root;
  for (const part of op.targetParts.slice(0, -1)) {
    parent = fs.join(parent, part);
    try { fs.mkdir(parent); } catch (error) { if (!error || error.code !== "EEXIST") throw error; }
    const made = fs.lstat(parent);
    if (!made.directory || made.link) refuse("path component is not a real directory");
  }
  const exists = error => !!error && (error.code === "EEXIST" || error.code === "ENOTEMPTY");
  if (op.kind === "move") {
    // Never over something that appeared since the check: a link is made again where it goes, a file gets a second
    // name there before losing its first, and a directory takes the place of an empty one made for it, which a
    // rename replaces only while it is still empty (Windows never renames over a directory, so it renames at once).
    try {
      if (source.link) { fs.symlink(fs.readlink(op.source), op.target, op.source); fs.unlink(op.source); }
      else if (source.directory) {
        if (!fs.windows) fs.mkdir(op.target);
        try { fs.rename(op.source, op.target); }
        catch (error) { if (!fs.windows) try { fs.rmdir(op.target); } catch {} throw error; }
      } else {
        try { fs.link(op.source, op.target); }
        catch (error) {
          // A file system without hard links has no move that can't replace what appears at the destination meanwhile:
          // refused, rather than a rename that might (review of #185).
          if (error && ["EPERM", "ENOTSUP", "EXDEV", "EMLINK", "ENOSYS"].includes(error.code)) {
            refuse("this file system can't move a file without risking what appears at its destination: copy it, then delete the original");
          }
          throw error;
        }
        fs.unlink(op.source);
      }
    } catch (error) { if (exists(error)) refuse("the destination exists already"); throw error; }
    return { entries: 1, bytes: 0 };
  }
  let entries = 0, bytes = 0;
  // What the copy made, in order: on failure each goes again, last first, a directory only while it is empty, so
  // nothing another writer put there meanwhile is removed.
  const made = [];
  const copy = (from, to, entry, depth) => {
    if (depth > limits.depth) refuse("directory nesting limit exceeded");
    if (++entries > limits.entries) refuse("too many files to copy");
    if (entry.link) { fs.symlink(fs.readlink(from), to, from); made.push({ path: to, identity: fs.lstat(to).identity }); }
    else if (entry.directory) {
      fs.mkdir(to);
      made.push({ path: to, directory: true });
      for (const name of fs.list(from).sort()) {
        // A clone's Git metadata is copied by cloning again, as everywhere else the file tools leave it alone.
        if (name.toLowerCase() === ".git") refuse("Git metadata is protected: clone the repository again rather than copy it");
        copy(fs.join(from, name), fs.join(to, name), fs.lstat(fs.join(from, name)), depth + 1);
      }
    } else if (entry.file) {
      if (entry.nlink !== 1) refuse("only regular, non-hardlinked files are supported");
      if (bytes + entry.size > limits.bytes) refuse("too much to copy: at most " + limits.bytes + " bytes of files");
      const data = fs.read(from, limits.bytes - bytes);
      bytes += data.length;
      fs.create(to, data, entry.executable);
      made.push({ path: to, identity: fs.lstat(to).identity });
    } else refuse("only files, directories and links can be copied");
  };
  try { copy(op.source, op.target, source, 0); }
  catch (error) {
    // A file or link goes only while it is still the one the copy made (same device and inode): one another writer put in
    // its place stays (review of #185).
    for (const entry of made.reverse()) {
      try { if (entry.directory) fs.rmdir(entry.path); else if (fs.lstat(entry.path).identity === entry.identity) fs.unlink(entry.path); } catch {}
    }
    if (exists(error)) refuse("the destination exists already");
    throw error;
  }
  return { entries, bytes };
}
`;

/**
 * The file system FILE_OPERATIONS_CORE runs on, from Node's synchronous calls, as the Windows helper and the worker use
 * it. Its source is embedded in both.
 */
export const FILE_OPERATIONS_FS = String.raw`
const fileOperationsFs = (fsCalls, path, caseInsensitive, windows) => ({
  caseInsensitive,
  windows,
  lstat: target => { const info = fsCalls.lstatSync(target, { bigint: true }); return { directory: info.isDirectory(), file: info.isFile(), link: info.isSymbolicLink(),
    nlink: Number(info.nlink), size: Number(info.size), executable: (info.mode & 0o100n) !== 0n, identity: info.dev + ":" + info.ino }; },
  list: target => fsCalls.readdirSync(target),
  rmdir: target => fsCalls.rmdirSync(target),
  // Windows removes a link to a directory (or a junction) as a directory.
  unlink: target => {
    try { fsCalls.unlinkSync(target); }
    catch (error) { if (!windows || !error || (error.code !== "EPERM" && error.code !== "EISDIR")) throw error; fsCalls.rmdirSync(target); }
  },
  rename: (from, to) => fsCalls.renameSync(from, to),
  link: (from, to) => fsCalls.linkSync(from, to),
  mkdir: target => fsCalls.mkdirSync(target, { mode: 0o700 }),
  readlink: target => fsCalls.readlinkSync(target),
  // Windows makes a link as a file's or a directory's: a link to a directory is made again as one (review of #185).
  symlink: (value, target, from) => {
    let directory = false;
    if (windows) try { directory = fsCalls.statSync(from).isDirectory(); } catch {}
    fsCalls.symlinkSync(value, target, directory ? "dir" : undefined);
  },
  read: (target, limit) => {
    const fd = fsCalls.openSync(target, "r");
    try {
      const before = fsCalls.fstatSync(fd);
      if (!before.isFile() || before.nlink !== 1) throw new FileOperationRefusal("only regular, non-hardlinked files are supported");
      if (before.size > limit) throw new FileOperationRefusal("too much to copy");
      const data = Buffer.alloc(before.size);
      let read = 0;
      while (read < data.length) { const count = fsCalls.readSync(fd, data, read, data.length - read, read); if (!count) break; read += count; }
      return data.subarray(0, read);
    } finally { fsCalls.closeSync(fd); }
  },
  // A file it couldn't write whole goes again, so a failed copy leaves no part of one.
  create: (target, data, executable) => {
    const fd = fsCalls.openSync(target, "wx", executable ? 0o700 : 0o600);
    try { let written = 0; while (written < data.length) written += fsCalls.writeSync(fd, data, written, data.length - written); fsCalls.fsyncSync(fd); }
    catch (error) { fsCalls.closeSync(fd); try { fsCalls.unlinkSync(target); } catch {} throw error; }
    fsCalls.closeSync(fd);
  },
  join: path.join,
});
`;

/**
 * An operation as FILE_OPERATIONS_CORE takes it: host paths of the entries, their worktree-relative parts, and the
 * worktree's real path (`root`), below which it makes the destination's directories once every check has passed.
 */
export interface ResolvedFileOperation {
  kind: FileOperationRequest["kind"];
  root?: string;
  source?: string;
  target?: string;
  path?: string;
  recursive?: boolean;
  sourceParts?: string[];
  targetParts?: string[];
}

/** How long a worker's operation may take before it is stopped. */
const WORKER_TIMEOUT_MS = 120_000;

/**
 * Runs FILE_OPERATIONS_CORE in a worker thread, for unsandboxed hosts, whose file operations run in the connector
 * itself: a copy or delete of a large tree then never holds up the connector.
 */
export async function fileOperationInWorker(operation: ResolvedFileOperation, timeoutMs = WORKER_TIMEOUT_MS): Promise<FileOperationResult> {
  const code = `
const { parentPort, workerData } = require("node:worker_threads");
const fsCalls = require("node:fs");
const path = require("node:path");
${FILE_OPERATIONS_CORE}
${FILE_OPERATIONS_FS}
try { parentPort.postMessage({ result: fileOperation(fileOperationsFs(fsCalls, path, process.platform === "win32" || process.platform === "darwin", process.platform === "win32"), workerData.operation, workerData.limits) }); }
catch (error) {
  parentPort.postMessage({ error: error instanceof FileOperationRefusal ? error.message
    : error && error.code ? error.code + ": " + (error.syscall || "operation") + " failed" : "file operation failed" });
}
`;
  const worker = new Worker(code, { eval: true, workerData: { operation, limits: fileOperationLimits }, resourceLimits: { maxOldGenerationSizeMb: 512 } });
  try {
    return await new Promise<FileOperationResult>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the file operation took too long")), timeoutMs);
      timer.unref();
      worker.once("message", (message: { result?: unknown; error?: string }) => {
        clearTimeout(timer);
        if (message.error !== undefined) reject(new Error(message.error));
        else { try { resolve(checkedFileOperation(message.result)); } catch (error) { reject(error); } }
      });
      worker.once("error", error => { clearTimeout(timer); reject(error); });
      worker.once("exit", code => { clearTimeout(timer); reject(new Error(`file operation stopped (${code})`)); });
    });
  } finally { await worker.terminate(); }
}
