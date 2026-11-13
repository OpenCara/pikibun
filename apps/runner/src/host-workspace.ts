import { runHostShell } from "./host-shell.js";
import type { HostCommandOperation } from "../../../packages/shared/src/types.js";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { BigIntStats, Stats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Operation, RunnerBinding } from "../../../packages/shared/src/types.js";
import {
  importRequest, MAX_FILE_BYTES, MAX_OUTPUT_BYTES, SandboxProcessError, TIMEOUT_MS, ownerGitConfig, pinOwnerConfig, quoteGitConfig, sessionEnvironment, text,
  type SandboxAuthorize, type SandboxExecutionOptions, type SandboxIdentity, type SnapshotFile,
} from "./sandbox.js";
import { MAX_IMAGE_BYTES, imageType, type FileContent } from "./images.js";
import { browseDirectory, browseFile, checkedBrowse, checkedEntries, type BrowseResult } from "./file-browser.js";
import type { SessionWorkspace } from "./workspace.js";
import { searchInWorker, type SearchRequest, type SearchResult } from "./search.js";
import { bashPath, CREATE_FILE, hostBashArgs, killTree, OPEN_DIRECTORY, OPEN_FILE, privateEntry, startHostBash, windows, windowsSystemEnvironment } from "./platform.js";
import { readCloneBranches, type CloneBranch } from "./clone-branches.js";
import { fileOperationInWorker, type FileOperationRequest, type FileOperationResult, type ResolvedFileOperation } from "./file-operations.js";
import { ATTACHMENT_CANDIDATES, attachmentCandidate } from "../../../packages/shared/src/file-uploads.js";

const MAX_ENTRIES = 10_000;
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const FILE_FLAGS = OPEN_FILE;
const DIRECTORY_FLAGS = OPEN_DIRECTORY;
const queues = new Map<string, Promise<void>>();

type Captured = { code: number | null; stdout: string; stderr: string };
type SpawnOptions = { env?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal; hostCommand?: string; isolated?: boolean };
export type HostWorkspaceOptions = { ownerEnvironment?: boolean; privateEnvironment?: readonly string[] };

export const CONNECTOR_ENVIRONMENT = new RegExp("^(?:PIKIBUN_|RUNNER_)|^(?:CONTROL_PLANE_URL|DATA_DIR|ALLOW_FAUX_MODEL|ALLOW_TEST_SHELL)$"
  + "|^GIT_(?:DIR|WORK_TREE|IMPLICIT_WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|PREFIX|INTERNAL_SUPER_PREFIX"
  + "|SHALLOW_FILE|GRAFT_FILE|NO_REPLACE_OBJECTS|REPLACE_REF_BASE|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\\d+|CONFIG_VALUE_\\d+)$", "i");

export function hostOwnersSession(binding: RunnerBinding): boolean {
  const hostOwner = binding.session.connectorOwnerId;
  return !!hostOwner && hostOwner === binding.owner.id && binding.session.ownerId === hostOwner;
}

export function ownerHostEnvironment(identity: Readonly<SandboxIdentity>, base: NodeJS.ProcessEnv = process.env,
  privateEnvironment: readonly string[] = []): Readonly<Record<string, string>> {
  const excluded = new Set(privateEnvironment.map(name => name.toUpperCase()));
  const inherited = Object.fromEntries(Object.entries(base)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && !CONNECTOR_ENVIRONMENT.test(entry[0]) && !excluded.has(entry[0].toUpperCase())));
  return Object.freeze({
    ...(base.LANG || base.LC_ALL ? {} : { LANG: "C.UTF-8" }),
    ...(!windows && !base.HOME ? { HOME: homedir() } : {}),
    ...inherited,
    ...identity.env,
    TERM: "dumb",
    PWD: identity.worktree,
    SANDBOX_WORKTREE: identity.worktree,
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    GIT_EDITOR: "/usr/bin/false",
    GIT_AUTHOR_NAME: identity.gitName,
    GIT_AUTHOR_EMAIL: identity.gitEmail,
    GIT_COMMITTER_NAME: identity.gitName,
    GIT_COMMITTER_EMAIL: identity.gitEmail,
  });
}

export class HostWorkspace implements SessionWorkspace {
  readonly isolated = false;
  readonly #root: string;
  readonly #identity: Readonly<SandboxIdentity>;
  readonly #environment: Readonly<Record<string, string>>;
  readonly #isolated: Readonly<Record<string, string>>;
  readonly #reported: Readonly<SandboxIdentity>;
  readonly ownerEnvironment: boolean;
  readonly #testProvider: boolean;
  readonly #clone: boolean;
  #initialization: Promise<void> | undefined;
  #ready = false;
  #closed = false;
  #cancelActive: (() => void) | undefined;

  constructor(binding: RunnerBinding, root: string, options: HostWorkspaceOptions = {}) {
    if (!["linux", "darwin", "win32"].includes(process.platform) || !isAbsolute(root) || resolve(root) === sep || resolve(root) === resolve(root, "..")) {
      throw new Error("Host workspace requires Linux, macOS or Windows and an absolute, non-root private storage path");
    }
    const ownerId = text(binding.owner.id, "owner id", 256);
    if (binding.session.ownerId !== ownerId) throw new Error("Session owner does not match its binding");
    text(binding.session.id, "session id", 256);
    const gitName = text(binding.owner.gitName, "Git name", 256);
    const gitEmail = text(binding.owner.gitEmail, "Git email", 320);
    if (/[<>\x00-\x1f\x7f]/.test(gitName + gitEmail)) throw new Error("Invalid Git identity");
    const githubLogin = binding.owner.githubLogin === null ? null : text(binding.owner.githubLogin, "GitHub login", 256);
    this.#root = resolve(root);
    this.#testProvider = binding.model.provider === "faux";
    this.#clone = binding.session.repositoryMode === "clone";
    this.#identity = Object.freeze({
      ownerId, githubLogin, gitName, gitEmail, home: join(this.#root, "home"), worktree: join(this.#root, "worktree"),
      env: Object.freeze({ ...binding.owner.env }),
    });
    this.ownerEnvironment = options.ownerEnvironment === true;
    this.#isolated = Object.freeze({
      ...(windows ? windowsSystemEnvironment() : {}),
      ...sessionEnvironment(this.#identity, { path: process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin", gitConfig: join(this.#root, "owner.gitconfig") }),
    });
    this.#environment = this.ownerEnvironment ? ownerHostEnvironment(this.#identity, process.env, options.privateEnvironment) : this.#isolated;
    const home = this.ownerEnvironment ? this.#environment.HOME ?? this.#environment.USERPROFILE ?? homedir() : undefined;
    this.#reported = home ? Object.freeze({ ...this.#identity, home }) : this.#identity;
  }

  get home(): string { return this.#identity.home; }
  get worktree(): string { return this.#identity.worktree; }
  get hostWorktree(): string { return this.worktree; }

  identity(authorize: SandboxAuthorize): Promise<Readonly<SandboxIdentity>> {
    return this.#operation(authorize, async () => this.#reported);
  }

  initialize(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("Sandbox is closed"));
    this.#initialization ??= this.#exclusive(async () => {
      for (const directory of [this.#root, this.home, this.worktree, join(this.home, ".tmp")]) {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const info = await lstat(directory);
        if (!info.isDirectory() || !privateEntry(info)) {
          throw new Error("Sandbox storage must be private and owned by the runner user");
        }
      }
      const config = ownerGitConfig(this.#identity) + (this.#clone ? hostCredentialConfig(process.env.HOME || homedir()) : "");
      await (await pinOwnerConfig(join(this.#root, "owner.gitconfig"), config)).close();
      if (!await exists(join(this.worktree, ".git", "HEAD"))) {
        await this.#git(["init", "--quiet", "--template=", "--initial-branch=main", this.worktree]);
      }
      await this.#git(["rev-parse", "--is-inside-work-tree"]);
      this.#ready = true;
    });
    return this.#initialization;
  }

  async readFile(path: string, authorize: SandboxAuthorize): Promise<string> {
    const value = text(path, "path", 1024);
    return this.#operation(authorize, async () => {
      const parts = await this.#parts(value, false);
      if (!parts.length) throw hostError("a file path is required");
      const parent = await directoryAt(this.worktree, parts.slice(0, -1));
      const data = (await readAt(parent, parts.at(-1)!, MAX_FILE_BYTES)).data;
      try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data); } catch { throw hostError("the file is not UTF-8 text"); }
    });
  }

  async readContent(path: string, authorize: SandboxAuthorize): Promise<FileContent> {
    const value = text(path, "path", 1024);
    return this.#operation(authorize, async () => {
      const parts = await this.#parts(value, false);
      if (!parts.length) throw hostError("a file path is required");
      const parent = await directoryAt(this.worktree, parts.slice(0, -1));
      const { data } = await readAt(parent, parts.at(-1)!, MAX_IMAGE_BYTES);
      const mimeType = imageType(data);
      if (mimeType) return { image: data, mimeType };
      if (data.length > MAX_FILE_BYTES) throw hostError("file exceeds size limit");
      return { text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(data) };
    });
  }

  async writeFile(path: string, content: string, authorize: SandboxAuthorize): Promise<void> {
    const value = text(path, "path", 1024);
    if (typeof content !== "string" || Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error("File exceeds size limit");
    await this.#operation(authorize, async () => {
      await writeAt(this.worktree, await this.#parts(value, true), content);
    });
  }

  async importFile(directory: string, name: string, data: Buffer, authorize: SandboxAuthorize): Promise<string> {
    const request = importRequest(directory, name, data);
    return this.#operation(authorize, async () => {
      const parts = await this.#parts(request.directory, true);
      if (!parts.length || parts.join("/") !== request.directory) throw hostError("path component is not a real directory");
      const parent = await directoryAt(this.worktree, parts, true);
      for (let index = 1; index <= ATTACHMENT_CANDIDATES; index++) {
        const candidate = attachmentCandidate(name, index);
        const target = join(parent, candidate);
        let handle;
        try { handle = await open(target, CREATE_FILE, 0o600); }
        catch (error) { if (errorCode(error) === "EEXIST") continue; throw error; }
        try {
          await handle.writeFile(data);
          await handle.sync();
        } catch (error) {
          await handle.close().catch(() => undefined);
          handle = undefined;
          await unlink(target).catch(() => undefined);
          throw error;
        } finally { await handle?.close(); }
        await syncPath(parent);
        return [...parts, candidate].join("/");
      }
      throw hostError("too many files with this name");
    });
  }

  async listFiles(path: string | undefined, authorize: SandboxAuthorize): Promise<string[]> {
    const value = text(path ?? ".", "path", 1024);
    return this.#operation(authorize, async () => {
      const names = await readdir(await directoryAt(this.worktree, await this.#parts(value, false)));
      if (names.length > MAX_ENTRIES) throw hostError("directory has too many entries");
      return names.sort();
    });
  }

  async listEntries(path: string | undefined, authorize: SandboxAuthorize): Promise<string[]> {
    const value = text(path ?? ".", "path", 1024);
    return this.#operation(authorize, async () => {
      const directory = await directoryAt(this.worktree, await this.#parts(value, false));
      const names = await readdir(directory);
      if (names.length > MAX_ENTRIES) throw hostError("directory has too many entries");
      const entries: string[] = [];
      for (const name of names.sort()) {
        let info;
        try { info = await lstat(join(directory, name)); }
        catch (error) { if (errorCode(error) === "ENOENT") continue; throw error; }
        entries.push(info.isDirectory() ? `${name}/` : name);
      }
      return checkedEntries(entries);
    });
  }

  async browse(path: string, authorize: SandboxAuthorize): Promise<BrowseResult> {
    const value = text(path, "path", 1024);
    return this.#operation(authorize, async () => {
      const parts = await this.#parts(value, false);
      if (!parts.length) return checkedBrowse(await browseDirectory(this.worktree));
      const parent = await directoryAt(this.worktree, parts.slice(0, -1));
      const target = join(parent, parts.at(-1)!);
      return checkedBrowse((await lstat(target)).isDirectory() ? await browseDirectory(target) : await browseFile(target));
    });
  }

  async search(request: SearchRequest, authorize: SandboxAuthorize): Promise<SearchResult> {
    const value = text(request.path, "path", 1024);
    return this.#operation(authorize, async () => {
      const parts = await this.#parts(value, false);
      const start = parts.length ? join(await directoryAt(this.worktree, parts.slice(0, -1)), parts.at(-1)!) : this.worktree;
      try { return await searchInWorker(start, parts.length ? parts.join("/") : ".", { ...request, path: value }); }
      catch (error) { throw hostError(error instanceof Error ? error.message : "search failed"); }
    });
  }

  async execute(operation: Operation, readOnly: boolean, authorize: SandboxAuthorize, options: SandboxExecutionOptions = {}): Promise<string> {
    switch (operation.kind) {
      case "program":
      case "bash": {
        if (options.allowTestShell === true && !this.#testProvider) throw new Error("Test shell bypass is restricted to the explicit faux provider");
        if (readOnly) throw new Error("Unsandboxed hosts cannot run read-only shell commands");
        const command = text(operation.command, "shell command", 64 * 1024, true);
        return this.#operation(authorize, async () => {
          if (options.signal?.aborted) throw new SandboxProcessError("Command stopped before it started", null, null, "", "");
          const bash = bashPath();
          if (!bash) throw hostError(windows ? "bash commands need Git for Windows' bash.exe" : "bash commands need /bin/bash");
          return output(checked(await this.#spawn(bash, hostBashArgs(command), undefined,
            { timeoutMs: (options.limits?.seconds ?? TIMEOUT_MS / 1000) * 1000, signal: options.signal, hostCommand: command })));
        });
      }
      case "github.comment":
      case "github.merge":
      case "github.issue":
        throw new Error("GitHub operations require the control-plane credential broker, not the sandbox");
      default:
        throw new Error("Unsupported sandbox operation");
    }
  }

  snapshot(authorize: SandboxAuthorize): Promise<SnapshotFile[]> {
    return this.#operation(authorize, async () => {
      const files: SnapshotFile[] = [];
      let total = 0;
      const add = async (parent: string, name: string, archivePath: string) => {
        if (files.length >= MAX_ENTRIES) throw hostError("snapshot has too many files");
        const { data, mode } = await readAt(parent, name, MAX_SNAPSHOT_BYTES - total);
        total += data.length;
        files.push({ path: archivePath, data: Buffer.from(data).toString("base64"), mode });
      };
      const visit = async (directory: string, prefix: string, skip: readonly string[] = [], depth = 0): Promise<void> => {
        if (depth > 64) throw hostError("snapshot directory nesting limit exceeded");
        const names = await readdir(directory);
        if (names.length > MAX_ENTRIES) throw hostError("directory has too many entries");
        for (const name of names.sort()) {
          if (skip.includes(name)) continue;
          if (name === ".git" && prefix.startsWith("worktree/")) {
            throw hostError("backups of sessions with a clone in the worktree need a host with the sandbox; push the clone's work instead");
          }
          const info = await lstat(join(directory, name));
          if (info.isDirectory()) await visit(join(directory, name), `${prefix}/${name}`, [], depth + 1);
          else if (info.isFile()) await add(directory, name, `${prefix}/${name}`);
          else throw hostError("snapshot refuses symlinks and special files");
        }
      };
      await visit(this.home, "home");
      await add(this.#root, "owner.gitconfig", "owner.gitconfig");
      await visit(this.worktree, "worktree", [".git"]);
      await visit(join(this.worktree, ".git"), "git", ["pikibun-push"]);
      return files;
    });
  }

  cloneBranches(authorize: SandboxAuthorize): Promise<CloneBranch[]> {
    return this.#operation(authorize, () => readCloneBranches(this.worktree));
  }

  async executeHost(operation: HostCommandOperation, authorize: SandboxAuthorize, signal: AbortSignal): Promise<string> {
    if (typeof authorize !== "function") throw new Error("Host command authorization is required");
    return this.#operation(authorize, async () => {
      await authorize();
      const controller = new AbortController();
      const cancel = () => controller.abort();
      this.#cancelActive = cancel;
      try {
        return await runHostShell(operation, {
          worktree: this.worktree, git: join(this.worktree, ".git"), gitConfig: join(this.#root, "owner.gitconfig"),
          gitName: this.#identity.gitName, gitEmail: this.#identity.gitEmail,
          signal: AbortSignal.any([signal, controller.signal]),
        });
      } finally { if (this.#cancelActive === cancel) this.#cancelActive = undefined; }
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#cancelActive?.();
    await this.#initialization?.catch(() => undefined);
    await this.#exclusive(async () => { this.#ready = false; });
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = queues.get(this.#root) ?? Promise.resolve();
    const result = previous.then(operation);
    const barrier = result.then(() => undefined, () => undefined);
    queues.set(this.#root, barrier);
    try {
      return await result;
    } finally {
      if (queues.get(this.#root) === barrier) queues.delete(this.#root);
    }
  }

  async #operation<T>(authorize: SandboxAuthorize, operation: () => Promise<T>): Promise<T> {
    if (typeof authorize !== "function") throw new Error("Sandbox authorization callback is required");
    await this.initialize();
    return this.#exclusive(async () => {
      if (this.#closed || !this.#ready) throw new Error("Sandbox is closed");
      await authorize();
      if (this.#closed) throw new Error("Sandbox is closed");
      try {
        return await operation();
      } catch (error) {
        throw error instanceof SandboxProcessError ? error : hostError(describe(error));
      }
    });
  }

  async #entry(value: string): Promise<{ parts: string[]; path: string }> {
    if (!value || value.startsWith("/") || value.includes("\\") || /[\x00-\x1f\x7f]/.test(value)) throw hostError("invalid relative path");
    if (value.length >= 2 && value[1] === ":") throw hostError("absolute paths are not allowed");
    if (value === ".") throw hostError("the worktree itself can't be moved, copied or deleted");
    if (value.split("/").some(part => ["", ".", ".."].includes(part))) throw hostError("path traversal is not allowed");
    const index = value.lastIndexOf("/");
    const name = value.slice(index + 1);
    if (name.toLowerCase() === ".git") throw hostError("Git metadata is protected");
    if (windows && (/[ .]$/.test(name) || name.includes(":"))) throw hostError("invalid Windows file name");
    const parts = await this.#parts(index < 0 ? "." : value.slice(0, index), true);
    return { parts: [...parts, name], path: join(await realpath(this.worktree), ...parts, name) };
  }

  async fileOperation(request: FileOperationRequest, authorize: SandboxAuthorize): Promise<FileOperationResult> {
    return this.#operation(authorize, async () => {
      let resolved: ResolvedFileOperation;
      if (request.kind === "delete") resolved = { kind: "delete", path: (await this.#entry(text(request.path, "path", 1024))).path, recursive: request.recursive === true };
      else {
        const source = await this.#entry(text(request.from, "path", 1024));
        const target = await this.#entry(text(request.to, "path", 1024));
        resolved = { kind: request.kind, root: await realpath(this.worktree), source: source.path, target: target.path, sourceParts: source.parts, targetParts: target.parts };
      }
      try { return await fileOperationInWorker(resolved); }
      catch (error) { throw hostError(error instanceof Error ? error.message : "file operation failed"); }
    });
  }

  async #parts(value: string, writing: boolean): Promise<string[]> {
    if (value.startsWith("/") || value.includes("\\") || /[\x00-\x1f\x7f]/.test(value)) throw hostError("invalid relative path");
    if (value.length >= 2 && value[1] === ":") throw hostError("absolute paths are not allowed");
    const lexical = value === "." ? [] : value.split("/");
    if (lexical.some((part) => ["", ".", ".."].includes(part))) throw hostError("path traversal is not allowed");
    if (writing && lexical.some((part) => part.toLowerCase() === ".git")) throw hostError("Git metadata is protected");
    const work = await realpath(this.worktree);
    let current = work;
    for (const [index, part] of lexical.entries()) {
      try {
        current = await realpath(join(current, part));
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
        current = join(current, ...lexical.slice(index));
        break;
      }
    }
    const inside = relative(work, current);
    if (inside.startsWith("..") || isAbsolute(inside)) throw hostError("path escapes the worktree");
    const parts = inside ? inside.split(sep) : [];
    if (writing && parts.some((part) => part.toLowerCase() === ".git")) throw hostError("Git metadata is protected");
    return parts;
  }

  #gitArgs(args: string[]): string[] {
    return ["--no-pager",
      "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
      "-c", "core.attributesFile=/dev/null", "-c", "core.sshCommand=/usr/bin/false",
      "-c", "credential.helper=", "-c", "commit.gpgSign=false",
      "-c", "tag.gpgSign=false", "-c", "protocol.allow=never",
      "-c", "core.pager=cat", "-c", "core.editor=/usr/bin/false",
      "-c", "gc.auto=0", "-c", "maintenance.auto=false",
      "-c", "core.preloadIndex=false", "-c", "index.threads=1",
      "-c", `core.worktree=${this.worktree}`, "-c", `safe.directory=${this.worktree}`,
      "-c", `user.name=${this.#identity.gitName}`, "-c", `user.email=${this.#identity.gitEmail}`,
      ...args];
  }

  #capture(args: string[], input?: string, options: SpawnOptions = {}): Promise<Captured> {
    return this.#spawn("git", this.#gitArgs(args), input, { ...options, isolated: true });
  }

  async #git(args: string[], input?: string, options: SpawnOptions = {}): Promise<Captured> {
    return checked(await this.#capture(args, input, options));
  }

  #spawn(command: string, args: string[], input?: string, options: SpawnOptions = {}): Promise<Captured> {
    const { promise, resolve: resolveResult, reject } = Promise.withResolvers<Captured>();
    const child = spawn(command, args, { cwd: this.worktree, env: { ...(options.isolated ? this.#isolated : this.#environment), ...options.env }, detached: !windows, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failure: string | undefined;
    const kill = () => {
      if (!child.pid) return;
      killTree(child);
    };
    const cancel = () => { failure ??= "Sandbox closed"; kill(); };
    this.#cancelActive = cancel;
    const stop = () => { failure ??= "Command stopped"; kill(); };
    options.signal?.addEventListener("abort", stop, { once: true });
    if (options.signal?.aborted) stop();
    const timer = setTimeout(() => { failure ??= `Command exceeded ${timeoutMs}ms time limit`; kill(); }, timeoutMs);
    const capture = (target: Buffer[], chunk: Buffer) => {
      const remaining = Math.max(0, MAX_OUTPUT_BYTES - bytes);
      if (remaining) target.push(chunk.subarray(0, remaining));
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) { failure ??= `Command exceeded ${MAX_OUTPUT_BYTES} byte output limit`; kill(); }
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.stdin.on("error", () => { });
    child.once("error", (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
      reject(new SandboxProcessError(`Cannot start ${command}: ${errorCode(error) ?? "launch failed"}`, null, null, "", ""));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
      if (this.#cancelActive === cancel) this.#cancelActive = undefined;
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      if (failure || signal) reject(new SandboxProcessError(`${failure ?? `Command killed by ${signal}`}${err ? `: ${err.slice(0, 4096).trim()}` : ""}`, code, signal, out, err));
      else resolveResult({ code, stdout: out, stderr: err });
    });
    if (options.hostCommand === undefined) child.stdin.end(input ?? "");
    else if (failure) child.stdin.end();
    else startHostBash(child, options.hostCommand);
    return promise;
  }
}

export function hostCredentialConfig(home: string): string {
  const shell = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  const helper = `!f() { test "$1" = get || exit 0; exec env -i PATH="$PATH" HOME=${shell(home)} GIT_TERMINAL_PROMPT=0 GIT_ASKPASS= SSH_ASKPASS= GCM_INTERACTIVE=never git credential fill; }; f`;
  return `[credential]\n\thelper = ${quoteGitConfig(helper)}\n`;
}

function checked(result: Captured): Captured {
  if (result.code !== 0) {
    throw new SandboxProcessError(`Command failed (exit ${result.code})${result.stderr ? `: ${result.stderr.slice(0, 4096).trim()}` : ""}`, result.code, null, result.stdout, result.stderr);
  }
  return result;
}

function output(result: Captured): string {
  return result.stdout + result.stderr;
}

function hostError(message: string): Error {
  return new Error(`sandbox: ${message}`);
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function describe(error: unknown): string {
  const known: Record<string, string> = {
    ENOENT: "no such file or directory", ELOOP: "symlinks are not followed", ENOTDIR: "not a directory",
    EISDIR: "is a directory", EEXIST: "file exists", EACCES: "permission denied", EPERM: "operation not permitted",
  };
  const code = errorCode(error);
  if (code && known[code]) return known[code];
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("sandbox: ") ? message.slice(9) : message;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function directoryAt(root: string, parts: readonly string[], create = false): Promise<string> {
  let current = root;
  for (const part of parts) {
    const next = join(current, part);
    if (create) {
      try { await mkdir(next, { mode: 0o700 }); } catch (error) { if (errorCode(error) !== "EEXIST") throw error; }
    }
    if (!(await lstat(next)).isDirectory()) throw hostError("path component is not a real directory");
    current = next;
  }
  return current;
}

function regular(info: Stats | BigIntStats): void {
  if (!info.isFile() || Number(info.nlink) !== 1) throw hostError("only regular, non-hardlinked files are supported");
}

async function readAt(parent: string, name: string, limit: number): Promise<{ data: Buffer; mode: number }> {
  const handle = await open(join(parent, name), FILE_FLAGS);
  try {
    const before = await handle.stat({ bigint: true });
    regular(before);
    if (before.size > BigInt(limit)) throw hostError("file exceeds size limit");
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(65536, limit + 1 - size));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead));
      size += bytesRead;
      if (size > limit) throw hostError("file exceeds size limit");
    }
    const after = await handle.stat({ bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw hostError("file changed while being read; retry the operation");
    }
    return { data: Buffer.concat(chunks), mode: Number(before.mode) & 0o777 };
  } finally {
    await handle.close();
  }
}

async function writeAt(root: string, parts: readonly string[], content: string): Promise<void> {
  if (!parts.length) throw hostError("a file path is required");
  const data = Buffer.from(content, "utf8");
  if (data.length > MAX_FILE_BYTES) throw hostError("file exceeds size limit");
  const parent = await directoryAt(root, parts.slice(0, -1), true);
  const target = join(parent, parts.at(-1)!);
  try { regular(await lstat(target)); } catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
  const temporary = join(parent, `.sandbox-write-${randomUUID().replaceAll("-", "")}`);
  let created = false;
  try {
    const handle = await open(temporary, CREATE_FILE, 0o600);
    created = true;
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    created = false;
    await syncPath(parent);
  } finally {
    if (created) await unlink(temporary).catch(() => undefined);
  }
}

async function syncPath(path: string): Promise<void> {
  if (windows) return;
  const handle = await open(path, DIRECTORY_FLAGS);
  try { await handle.sync(); } finally { await handle.close(); }
}
