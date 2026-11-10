import { Worker } from "node:worker_threads";

export const fileOperationLimits = Object.freeze({
  entries: 10_000,
  bytes: 50 * 1024 * 1024,
  depth: 64,
});

export type FileOperationRequest =
  | { kind: "move"; from: string; to: string }
  | { kind: "copy"; from: string; to: string }
  | { kind: "delete"; path: string; recursive: boolean };

export interface FileOperationResult { entries: number; bytes: number }

const path = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !value || value.length > 1024 || value.includes("\0")) throw new Error(`${name} is a path in the worktree, such as src/app.ts`);
  return value;
};

export function fileOperationRequest(kind: "move" | "copy", input: { from: unknown; to: unknown }): FileOperationRequest;
export function fileOperationRequest(kind: "delete", input: { path: unknown; recursive?: unknown }): FileOperationRequest;
export function fileOperationRequest(kind: FileOperationRequest["kind"], input: Record<string, unknown>): FileOperationRequest {
  if (kind === "delete") {
    if (input.recursive !== undefined && typeof input.recursive !== "boolean") throw new Error("recursive is true or false");
    return { kind, path: path(input.path, "path"), recursive: input.recursive === true };
  }
  return { kind, from: path(input.from, "from"), to: path(input.to, "to") };
}

export function checkedFileOperation(value: unknown): FileOperationResult {
  const result = value as FileOperationResult;
  if (!result || typeof result !== "object" || !Number.isSafeInteger(result.entries) || result.entries < 0 || !Number.isSafeInteger(result.bytes) || result.bytes < 0) {
    throw new Error("Invalid file operation response");
  }
  return { entries: result.entries, bytes: result.bytes };
}

export const FILE_OPERATIONS_CORE = String.raw`
class FileOperationRefusal extends Error {}
function fileOperation(fs, op, limits) {
  const refuse = message => { throw new FileOperationRefusal(message); };
  const found = path => { try { return fs.lstat(path); } catch (error) { if (error && error.code === "ENOENT") return undefined; throw error; } };
  const removeAll = (path, depth) => {
    if (depth > limits.depth) refuse("directory nesting limit exceeded");
    const entry = fs.lstat(path);
    if (entry.directory && !entry.link) {
      const names = fs.list(path);
      const now = fs.lstat(path);
      if (!now.directory || now.link || now.identity !== entry.identity) refuse("the directory changed while being deleted; try again");
      let count = 1;
      for (const name of names) count += removeAll(fs.join(path, name), depth + 1);
      fs.rmdir(path);
      return count;
    }
    fs.unlink(path);
    return 1;
  };
  const changed = error => !!error && ["ENOTDIR", "EISDIR", "EPERM"].includes(error.code);
  if (op.kind === "delete") {
    const entry = found(op.path);
    if (!entry) refuse("no such file or directory");
    if (!op.recursive) {
      try { if (entry.directory && !entry.link) fs.rmdir(op.path); else fs.unlink(op.path); }
      catch (error) {
        if (error && (error.code === "ENOTEMPTY" || error.code === "EEXIST")) refuse("the directory is not empty: delete it with recursive");
        if (changed(error)) refuse("it changed while being deleted; try again");
        throw error;
      }
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
  let parent = op.root;
  for (const part of op.targetParts.slice(0, -1)) {
    parent = fs.join(parent, part);
    try { fs.mkdir(parent); } catch (error) { if (!error || error.code !== "EEXIST") throw error; }
    const made = fs.lstat(parent);
    if (!made.directory || made.link) refuse("path component is not a real directory");
  }
  const exists = error => !!error && (error.code === "EEXIST" || error.code === "ENOTEMPTY");
  if (op.kind === "move") {
    try {
      if (source.link) { fs.symlink(fs.readlink(op.source), op.target, op.source); fs.unlink(op.source); }
      else if (source.directory) {
        if (!fs.windows) fs.mkdir(op.target);
        try { fs.rename(op.source, op.target); }
        catch (error) { if (!fs.windows) try { fs.rmdir(op.target); } catch {} throw error; }
      } else {
        try { fs.link(op.source, op.target); }
        catch (error) {
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
  const made = [];
  const copy = (from, to, entry, depth) => {
    if (depth > limits.depth) refuse("directory nesting limit exceeded");
    if (++entries > limits.entries) refuse("too many files to copy");
    if (entry.link) { fs.symlink(fs.readlink(from), to, from); made.push({ path: to, identity: fs.lstat(to).identity }); }
    else if (entry.directory) {
      fs.mkdir(to);
      made.push({ path: to, directory: true });
      for (const name of fs.list(from).sort()) {
        if (name.toLowerCase() === ".git") refuse("Git metadata is protected: clone the repository again rather than copy it");
        copy(fs.join(from, name), fs.join(to, name), fs.lstat(fs.join(from, name)), depth + 1);
      }
    } else if (entry.file) {
      if (entry.nlink !== 1) refuse("only regular, non-hardlinked files are supported");
      if (bytes + entry.size > limits.bytes) refuse("too much to copy: at most " + limits.bytes + " bytes of files");
      const data = fs.read(from, limits.bytes - bytes);
      bytes += data.length;
      made.push({ path: to, identity: fs.create(to, data, entry.executable) });
    } else refuse("only files, directories and links can be copied");
  };
  try { copy(op.source, op.target, source, 0); }
  catch (error) {
    for (const entry of made.reverse()) {
      try { if (entry.directory) fs.rmdir(entry.path); else if (fs.lstat(entry.path).identity === entry.identity) fs.unlink(entry.path); } catch {}
    }
    if (exists(error)) refuse("the destination exists already");
    throw error;
  }
  return { entries, bytes };
}
`;

export const FILE_OPERATIONS_FS = String.raw`
const fileOperationsFs = (fsCalls, path, caseInsensitive, windows) => ({
  caseInsensitive,
  windows,
  lstat: target => { const info = fsCalls.lstatSync(target, { bigint: true }); return { directory: info.isDirectory(), file: info.isFile(), link: info.isSymbolicLink(),
    nlink: Number(info.nlink), size: Number(info.size), executable: (info.mode & 0o100n) !== 0n, identity: info.dev + ":" + info.ino }; },
  list: target => fsCalls.readdirSync(target),
  rmdir: target => fsCalls.rmdirSync(target),
  unlink: target => {
    try { fsCalls.unlinkSync(target); }
    catch (error) { if (!windows || !error || (error.code !== "EPERM" && error.code !== "EISDIR")) throw error; fsCalls.rmdirSync(target); }
  },
  rename: (from, to) => fsCalls.renameSync(from, to),
  link: (from, to) => fsCalls.linkSync(from, to),
  mkdir: target => fsCalls.mkdirSync(target, { mode: 0o700 }),
  readlink: target => fsCalls.readlinkSync(target),
  symlink: (value, target, from) => {
    let directory = false;
    if (windows) {
      try { directory = fsCalls.statSync(from).isDirectory(); }
      catch { throw new FileOperationRefusal("on Windows a link that points nowhere can't be copied or moved: its kind (file or directory link) isn't known"); }
    }
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
  create: (target, data, executable) => {
    const fd = fsCalls.openSync(target, "wx", executable ? 0o700 : 0o600);
    let identity;
    try {
      const made = fsCalls.fstatSync(fd, { bigint: true });
      identity = made.dev + ":" + made.ino;
      let written = 0;
      while (written < data.length) written += fsCalls.writeSync(fd, data, written, data.length - written);
      fsCalls.fsyncSync(fd);
    }
    catch (error) {
      fsCalls.closeSync(fd);
      try { const now = fsCalls.lstatSync(target, { bigint: true }); if (identity !== undefined && now.dev + ":" + now.ino === identity) fsCalls.unlinkSync(target); } catch {}
      throw error;
    }
    fsCalls.closeSync(fd);
    return identity;
  },
  join: path.join,
});
`;

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

const WORKER_TIMEOUT_MS = 120_000;

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
