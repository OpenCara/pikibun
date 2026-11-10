import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { link, lstat, mkdir, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { GitProvider } from "../../../packages/shared/src/repositories.js";
import { GitRemote, GitRemoteError, ProgressLines, parseGitProgress, type GitProgressPhase } from "./git-remote.js";

export type RepositoryCacheScope = "host" | "owner";

export type RepositoryCachePhase = "waiting" | "connecting" | GitProgressPhase | "verifying" | "done";

export interface RepositoryCacheProgress {
  path: string;
  phase: RepositoryCachePhase;
  percent: number | null;
  done: number | null;
  total: number | null;
  bytes: number;
}

export interface RepositoryCacheOptions {
  root: string;
  scope?: RepositoryCacheScope;
  progressIntervalMs?: number;
  retryDelaysMs?: readonly number[];
}

export interface MirrorRepository { provider: GitProvider; host: string; repositoryId: string; fullName: string }
export interface MirrorTarget {
  repository: MirrorRepository; ownerId: string; sessionId: string;
  remote: GitRemote;
  refs?: ReadonlyMap<string, string>;
}
export interface CachedRepository { directory: string; bytes: number; sessions: number; pins: number }

export class RepositoryCacheError extends Error {
  constructor(message: string) { super(message); this.name = "RepositoryCacheError"; }
}

const OID = /^[0-9a-f]{40}$/;
const RETRY_DELAYS_MS = [2_000, 10_000];
const FETCH_TIMEOUT_MS = 60 * 60 * 1000;
const GIT_TIMEOUT_MS = 60 * 60 * 1000;
const LOCK_POLL_MS = 250;
const LOCK_NAME = "pikibun.lock";
const PIN_PREFIX = "refs/pikibun/pins/";
const SESSION_PREFIX = "refs/pikibun/sessions/";
const KEEP_PARENTS = 500;

export function mirrorPath(repository: { provider: string; host: string; repositoryId: string }): string {
  if (!/^[a-z0-9-]{1,32}$/.test(repository.provider) || !/^[a-z0-9.-]{1,253}(?::[0-9]{1,5})?$/.test(repository.host)
    || !/^[A-Za-z0-9{}_-]{1,100}$/.test(repository.repositoryId)) {
    throw new RepositoryCacheError("Repository cannot name a cache directory");
  }
  return join(repository.provider, repository.host.replace(":", "_"), `${repository.repositoryId}.git`);
}
const UPSTREAM_PREFIX = "refs/upstream/";
const CAPTURE_BYTES = 64 * 1024 * 1024;

type Listener = (progress: RepositoryCacheProgress) => void;

export class RepositoryCache {
  readonly #root: string;
  readonly #scope: RepositoryCacheScope;
  readonly #interval: number;
  readonly #retryDelays: readonly number[];
  readonly #queues = new Map<string, { tail: Promise<void>; listeners: Set<Listener>; last: RepositoryCacheProgress | undefined }>();

  constructor(options: RepositoryCacheOptions) {
    if (!isAbsolute(options.root) || resolve(options.root) === sep) throw new RepositoryCacheError("Repository cache root must be an absolute, non-root path");
    this.#root = resolve(options.root);
    this.#scope = options.scope ?? "host";
    if (this.#scope !== "host" && this.#scope !== "owner") throw new RepositoryCacheError("Repository cache scope must be host or owner");
    this.#interval = options.progressIntervalMs ?? 250;
    this.#retryDelays = options.retryDelaysMs ?? RETRY_DELAYS_MS;
  }

  get scope(): RepositoryCacheScope { return this.#scope; }

  mirrorDirectory(repository: MirrorRepository, ownerId: string): string {
    return this.#directory(repository.provider, repository.host, repository.repositoryId, ownerId);
  }

  #directory(provider: string, host: string, id: string, ownerId: string): string {
    const base = this.#scope === "owner" ? join(this.#root, "owners", digest(ownerId)) : this.#root;
    return join(base, mirrorPath({ provider, host, repositoryId: id }));
  }

  async prepare(repository: MirrorRepository, ownerId: string): Promise<string> {
    const directory = this.mirrorDirectory(repository, ownerId);
    await this.#prepare(directory);
    return directory;
  }

  async filled(repository: MirrorRepository, ownerId: string): Promise<boolean> {
    const directory = this.mirrorDirectory(repository, ownerId);
    try { await lstat(join(directory, "HEAD")); }
    catch (error) { if (errorCode(error) === "ENOENT") return false; throw error; }
    return (await cacheGit(directory).capture(["for-each-ref", "--count=1", "--format=%(refname)", UPSTREAM_PREFIX])).trim() !== "";
  }

  async ready(target: MirrorTarget, options: { onProgress?: Listener; wait?: number } = {}): Promise<{ directory: string; fresh: boolean }> {
    const directory = this.mirrorDirectory(target.repository, target.ownerId);
    const filled = await this.filled(target.repository, target.ownerId);
    const refresh = this.refresh(target, options.onProgress ? { onProgress: options.onProgress } : {});
    if (!filled) {
      await refresh;
      return { directory, fresh: true };
    }
    let timer: NodeJS.Timeout | undefined;
    const fresh = await Promise.race([
      refresh.then(() => true, () => false),
      new Promise<boolean>(resolveWait => { timer = setTimeout(() => resolveWait(false), Math.max(0, options.wait ?? 0)); }),
    ]);
    clearTimeout(timer);
    return { directory, fresh };
  }

  async refresh(target: MirrorTarget, options: { onProgress?: Listener; signal?: AbortSignal } = {}): Promise<{ directory: string; fetched: boolean }> {
    const directory = this.mirrorDirectory(target.repository, target.ownerId);
    return this.#serialized(directory, target.repository.fullName, throttle(options.onProgress, this.#interval), options.signal, async (emit) => {
      await this.#prepare(directory);
      const git = cacheGit(directory, options.signal);
      const connecting = () => emit({ phase: "connecting", percent: null, done: null, total: null, bytes: 0 });
      connecting();
      const advertised = target.refs ? listed(target.refs) : await this.#retrying(() => target.remote.listRefs(), options.signal, connecting);
      const before = await git.objectTypes([...advertised.values()]);
      const wants = [...before].filter(([, type]) => type === null).map(([id]) => id);
      const bytes = wants.length ? await this.#retrying(() => this.#fetchObjects(directory, git, target.remote, wants, emit), options.signal, connecting) : 0;
      await this.#updateUpstream(git, advertised);
      const heads = [...new Set([...advertised].filter(([ref]) => ref.startsWith("refs/heads/")).map(([, id]) => id))];
      const present = await git.objectTypes(heads);
      await keep(git, target.sessionId, heads.filter(id => present.get(id) === "commit"));
      emit({ phase: "done", percent: 100, done: null, total: null, bytes });
      return { directory, fetched: wants.length > 0 };
    });
  }

  async touch(repository: MirrorRepository, ownerId: string, sessionId: string): Promise<void> {
    const directory = this.mirrorDirectory(repository, ownerId);
    try { await lstat(join(directory, "HEAD")); }
    catch (error) { if (errorCode(error) === "ENOENT") return; throw error; }
    await this.#serialized(directory, repository.fullName, undefined, undefined, async () => { await keep(cacheGit(directory), sessionId, []); });
  }

  async list(): Promise<CachedRepository[]> {
    const repositories: CachedRepository[] = [];
    for (const directory of await cacheRepositories(this.#root)) {
      const refs = (await cacheGit(directory).capture(["for-each-ref", "--format=%(refname)", SESSION_PREFIX, PIN_PREFIX])).split("\n").filter(Boolean);
      repositories.push({ directory, bytes: await directorySize(directory), sessions: refs.filter(ref => ref.startsWith(SESSION_PREFIX)).length,
        pins: refs.filter(ref => ref.startsWith(PIN_PREFIX)).length });
    }
    return repositories;
  }

  async prune(age: number): Promise<{ repositories: number; sessions: number }> {
    if (!Number.isSafeInteger(age) || age < 0) throw new RepositoryCacheError("Invalid prune age");
    const cutoff = Math.floor((Date.now() - age) / 1000);
    let repositories = 0, sessions = 0;
    for (const directory of await cacheRepositories(this.#root)) {
      await this.#serialized(directory, basename(directory), undefined, undefined, async () => {
        const git = cacheGit(directory);
        await removeTemporaryPacks(directory);
        const stale = (await git.capture(["for-each-ref", "--format=%(committerdate:unix) %(refname)", SESSION_PREFIX])).split("\n")
          .map(line => line.split(" ") as [string, string]).filter(([date, ref]) => ref && Number(date) <= cutoff).map(([, ref]) => ref);
        if (stale.length) await git.run(["update-ref", "--no-deref", "--stdin"], `${stale.map(ref => `delete ${ref}`).join("\n")}\n`);
        await git.run(["gc", "--quiet", `--prune=${cutoff}`]);
        repositories++;
        sessions += stale.length;
      });
    }
    return { repositories, sessions };
  }

  async #retrying<T>(attempt: () => Promise<T>, signal: AbortSignal | undefined, again: () => void): Promise<T> {
    for (let failures = 0; ; failures++) {
      try { return await attempt(); }
      catch (error) {
        const pause = this.#retryDelays[failures];
        if (pause === undefined || signal?.aborted || !retryable(error)) throw error;
        await sleep(pause, undefined, signal ? { signal } : {}).catch(() => { throw error; });
        again();
      }
    }
  }

  async #fetchObjects(directory: string, git: CacheGit, remote: GitRemote, wants: string[], emit: (progress: Omit<RepositoryCacheProgress, "path">) => void): Promise<number> {
    await removeTemporaryPacks(directory);
    try { return await this.#fetchPack(git, remote, wants, emit); }
    catch (error) {
      await removeTemporaryPacks(directory).catch(() => {});
      throw error;
    }
  }

  async #fetchPack(git: CacheGit, remote: GitRemote, wants: string[], emit: (progress: Omit<RepositoryCacheProgress, "path">) => void): Promise<number> {
    const haves = (await git.capture(["for-each-ref", "--format=%(objecttype) %(objectname)", "--sort=-committerdate", UPSTREAM_PREFIX]))
      .split("\n").filter(line => line.startsWith("commit ")).map(line => line.slice(7));
    let bytes = 0;
    let phase: Omit<RepositoryCacheProgress, "path"> = { phase: "connecting", percent: null, done: null, total: null, bytes };
    const update = (line: string) => {
      const parsed = parseGitProgress(line);
      if (!parsed) return;
      phase = { ...parsed, bytes };
      emit(phase);
    };
    const pack = await remote.fetchHistory({ wants, haves, onProgress: update });
    const counted = (async function* () {
      for await (const chunk of pack) {
        bytes += chunk.length;
        if (phase.phase !== "receiving") phase = { phase: "receiving", percent: null, done: null, total: null, bytes };
        emit({ ...phase, bytes });
        yield chunk;
      }
    })();
    await git.run(["index-pack", "--stdin", "-v", "--fix-thin"], counted, update);
    emit({ phase: "verifying", percent: null, done: null, total: null, bytes });
    await git.run(["rev-list", "--objects", "--quiet", "--stdin"], [...wants, ...haves.map(id => `^${id}`), ""].join("\n"));
    return bytes;
  }

  async #updateUpstream(git: CacheGit, advertised: Map<string, string>): Promise<void> {
    const after = await git.objectTypes([...advertised.values()]);
    const current = new Map((await git.capture(["for-each-ref", "--format=%(refname) %(objectname)", UPSTREAM_PREFIX]))
      .split("\n").filter(Boolean).map(line => line.split(" ") as [string, string]));
    const updates: string[] = [];
    for (const [ref, id] of advertised) {
      const local = `${UPSTREAM_PREFIX}${ref.slice("refs/".length)}`;
      if (current.get(local) !== id && after.get(id)) updates.push(`update ${local} ${id}`);
      current.delete(local);
    }
    const deletes = [...current.keys()].map(ref => `delete ${ref}`);
    if (deletes.length) await git.run(["update-ref", "--no-deref", "--stdin"], `${deletes.join("\n")}\n`);
    if (updates.length) await git.run(["update-ref", "--no-deref", "--stdin"], `${updates.join("\n")}\n`);
  }

  async #prepare(directory: string): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const root = await lstat(this.#root);
    if (!root.isDirectory() || root.uid !== process.getuid?.() || (root.mode & 0o077) !== 0) {
      throw new RepositoryCacheError("Repository cache root must be a private directory owned by the runner user");
    }
    const parent = resolve(directory, "..");
    await mkdir(parent, { recursive: true, mode: 0o700 });
    try {
      const info = await lstat(join(directory, "HEAD"));
      if (!info.isFile()) throw new RepositoryCacheError("Repository cache entry is not a Git repository");
      return;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    const staging = `${directory}.init-${randomBytes(8).toString("hex")}`;
    try {
      await runGit(staging, ["init", "--quiet", "--bare", "--template=", staging], { cwd: parent });
      await rename(staging, directory);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      if (errorCode(error) === "ENOTEMPTY" || errorCode(error) === "EEXIST") return;
      throw error;
    }
  }

  async #serialized<T>(directory: string, path: string, listener: Listener | undefined, signal: AbortSignal | undefined,
    operation: (emit: (progress: Omit<RepositoryCacheProgress, "path">) => void) => Promise<T>): Promise<T> {
    let queue = this.#queues.get(directory);
    if (!queue) { queue = { tail: Promise.resolve(), listeners: new Set(), last: undefined }; this.#queues.set(directory, queue); }
    const state = queue;
    if (listener) {
      state.listeners.add(listener);
      listener(state.last ? { ...state.last, path } : { path, phase: "waiting", percent: null, done: null, total: null, bytes: 0 });
    }
    const emit = (progress: Omit<RepositoryCacheProgress, "path">) => {
      state.last = { ...progress, path };
      for (const each of state.listeners) each({ ...progress, path });
    };
    const result = state.tail.then(async () => {
      state.last = undefined;
      signal?.throwIfAborted();
      const release = await acquireLock(directory, signal);
      try { return await operation(emit); } finally { await release(); }
    });
    const settled = result.then(() => undefined, () => undefined);
    state.tail = settled;
    try {
      return await result;
    } finally {
      if (listener) state.listeners.delete(listener);
      if (state.tail === settled && !state.listeners.size) this.#queues.delete(directory);
    }
  }
}

async function keep(git: CacheGit, sessionId: string, tips: readonly string[]): Promise<void> {
  const ref = `${SESSION_PREFIX}${digest(sessionId)}`;
  const previous = (await git.capture(["for-each-ref", "--format=%(objectname)", ref])).trim();
  const parents = [...(OID.test(previous) ? [previous] : []), ...tips];
  if (!parents.length) return;
  const tree = (await git.capture(["mktree"])).trim();
  let head: string | undefined;
  for (let index = 0; index < parents.length; index += KEEP_PARENTS) {
    const batch = [...(head ? [head] : []), ...parents.slice(index, index + KEEP_PARENTS)];
    head = (await git.capture(["-c", "user.name=Pikibun", "-c", "user.email=pikibun@localhost", "commit-tree", tree,
      ...batch.flatMap(id => ["-p", id]), "-m", "Objects a clone session borrows"])).trim();
    if (!OID.test(head)) throw new RepositoryCacheError("The session's keep ref could not be written");
  }
  await git.run(["update-ref", "--no-deref", ref, head!]);
}

async function cacheRepositories(root: string): Promise<string[]> {
  const found: string[] = [];
  const children = async (directory: string): Promise<string[]> => {
    try { return (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => join(directory, entry.name)); }
    catch (error) { if (errorCode(error) === "ENOENT") return []; throw error; }
  };
  const visit = async (base: string) => {
    for (const provider of await children(base)) {
      if (basename(provider) === "owners") continue;
      for (const host of await children(provider)) {
        for (const repository of await children(host)) if (/^[A-Za-z0-9{}_-]{1,100}\.git$/.test(basename(repository))) found.push(repository);
      }
    }
  };
  await visit(root);
  for (const owner of await children(join(root, "owners"))) await visit(owner);
  return found.sort();
}

async function directorySize(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) total += (await lstat(join(entry.parentPath, entry.name))).size;
  }
  return total;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function listed(refs: ReadonlyMap<string, string>): Map<string, string> {
  for (const [ref, id] of refs) {
    if (!/^refs\/(?:heads|tags)\/./.test(ref) || !OID.test(id)) throw new RepositoryCacheError("Invalid ref listing");
  }
  return new Map(refs);
}

async function removeTemporaryPacks(directory: string): Promise<void> {
  const pack = join(directory, "objects", "pack");
  let names: string[];
  try { names = await readdir(pack); }
  catch (error) { if (errorCode(error) === "ENOENT") return; throw error; }
  await Promise.all(names.filter(name => /^(?:tmp_|\.tmp-)/.test(name)).map(name => rm(join(pack, name), { force: true })));
}

function retryable(error: unknown): boolean {
  return error instanceof GitRemoteError && error.retryable;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function throttle(listener: Listener | undefined, interval: number): Listener | undefined {
  if (!listener) return undefined;
  let last = 0;
  let phase: RepositoryCachePhase | undefined;
  return (progress) => {
    const now = Date.now();
    if (progress.phase !== phase || progress.phase === "done" || now - last >= interval) {
      last = now;
      phase = progress.phase;
      listener(progress);
    }
  };
}

async function acquireLock(directory: string, signal?: AbortSignal): Promise<() => Promise<void>> {
  const parent = resolve(directory, "..");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const name = `${basename(directory)}.${LOCK_NAME}`;
  const path = join(parent, name);
  const deadline = Date.now() + FETCH_TIMEOUT_MS;
  let suspect: { ino: number; content: string } | undefined;
  for (;;) {
    signal?.throwIfAborted();
    const claim = join(parent, `.${name}.${randomBytes(8).toString("hex")}`);
    await writeFile(claim, `${process.pid}\n`, { mode: 0o600, flag: "wx" });
    try {
      await link(claim, path);
      return async () => { await unlink(path).catch(() => undefined); };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    } finally {
      await unlink(claim).catch(() => undefined);
    }
    let held: { ino: number; content: string };
    try {
      const info = await lstat(path);
      held = { ino: info.ino, content: await readFile(path, "utf8") };
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    const holder = /^[1-9][0-9]{0,9}\n$/.test(held.content) ? Number(held.content) : 0;
    const stale = holder ? holder === process.pid || !alive(holder) : suspect?.ino === held.ino && suspect.content === held.content;
    if (stale) {
      await unlink(path).catch(() => undefined);
      suspect = undefined;
      continue;
    }
    suspect = holder ? undefined : held;
    if (Date.now() > deadline) throw new RepositoryCacheError("Timed out waiting for another process to finish fetching this repository");
    await new Promise(resolveWait => setTimeout(resolveWait, LOCK_POLL_MS));
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return errorCode(error) !== "ESRCH"; }
}

interface CacheGit {
  run(args: string[], input?: string | AsyncIterable<Uint8Array>, onProgress?: (line: string) => void): Promise<void>;
  capture(args: string[]): Promise<string>;
  objectType(id: string): Promise<string | null>;
  objectTypes(ids: readonly string[]): Promise<Map<string, string | null>>;
}

function cacheGit(directory: string, signal?: AbortSignal): CacheGit {
  return {
    run: async (args, input, onProgress) => { await runGit(directory, args, { input, onProgress, signal }); },
    capture: async (args) => (await runGit(directory, args, { signal })).stdout.toString("utf8"),
    objectType: async (id) => {
      if (!OID.test(id)) return null;
      const result = await runGit(directory, ["cat-file", "-t", id], { signal, allowFailure: true });
      return result.code === 0 ? result.stdout.toString("utf8").trim() : null;
    },
    objectTypes: async (ids) => {
      const unique = [...new Set(ids)];
      if (unique.some(id => !OID.test(id))) throw new RepositoryCacheError("Invalid object id");
      const types = new Map<string, string | null>(unique.map(id => [id, null]));
      if (!unique.length) return types;
      const output = (await runGit(directory, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], { signal, input: `${unique.join("\n")}\n` })).stdout.toString("utf8");
      for (const line of output.split("\n")) {
        const [id, type] = line.split(" ");
        if (id && type && type !== "missing" && types.has(id)) types.set(id, type);
      }
      return types;
    },
  };
}

function runGit(directory: string, args: string[], options: {
  input?: string | AsyncIterable<Uint8Array>; onProgress?: (line: string) => void;
  signal?: AbortSignal; allowFailure?: boolean; cwd?: string;
}): Promise<{ code: number | null; stdout: Buffer }> {
  if (options.signal?.aborted) return Promise.reject(new RepositoryCacheError("Repository cache operation was cancelled"));
  const child = spawn("git", ["--no-pager",
    "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
    "-c", "core.attributesFile=/dev/null", "-c", "core.sshCommand=/usr/bin/false",
    "-c", "credential.helper=", "-c", "protocol.allow=never",
    "-c", "core.pager=cat", "-c", "core.editor=/usr/bin/false",
    "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "fetch.fsckObjects=false",
    "-c", "transfer.fsckObjects=false", "-c", "core.bigFileThreshold=64m",
    "-c", `safe.directory=${directory}`,
    ...(args[0] === "init" ? [] : [`--git-dir=${directory}`]), ...args], {
    cwd: options.cwd ?? directory, detached: true, stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH || "/usr/bin:/bin", LANG: "C", LC_ALL: "C", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  });
  const { promise, resolve: done, reject } = Promise.withResolvers<{ code: number | null; stdout: Buffer }>();
  const stdout: Buffer[] = [];
  let size = 0;
  let failure: Error | undefined;
  const kill = (reason: Error) => {
    failure ??= reason;
    if (!child.pid) return;
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  };
  const timer = setTimeout(() => kill(new RepositoryCacheError("Git exceeded its time limit in the repository cache")), GIT_TIMEOUT_MS);
  const abort = () => kill(new RepositoryCacheError("Repository cache operation was cancelled"));
  options.signal?.addEventListener("abort", abort, { once: true });
  child.stdout.on("data", (chunk: Buffer) => {
    if (failure) return;
    size += chunk.length;
    if (size > CAPTURE_BYTES) kill(new RepositoryCacheError("Git output exceeds its limit in the repository cache"));
    else stdout.push(chunk);
  });
  const progress = options.onProgress ? new ProgressLines(options.onProgress) : undefined;
  child.stderr.on("data", (chunk: Buffer) => progress?.push(chunk));
  child.stdin.on("error", () => { });
  child.once("error", () => { clearTimeout(timer); reject(new RepositoryCacheError("Git could not be started on this host")); });
  child.once("close", (code, signal) => {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    progress?.end();
    if (failure) reject(failure);
    else if (signal || (code !== 0 && !options.allowFailure)) reject(new RepositoryCacheError(`Git ${args[0]} failed in the repository cache`));
    else done({ code, stdout: Buffer.concat(stdout) });
  });
  if (options.input === undefined || typeof options.input === "string") child.stdin.end(options.input ?? "");
  else {
    const input = options.input;
    let exited = false;
    child.once("close", () => { exited = true; });
    const writable = () => new Promise<void>(resolveWritable => {
      const settle = () => {
        child.stdin.off("drain", settle).off("close", settle).off("error", settle);
        child.off("close", settle);
        resolveWritable();
      };
      child.stdin.once("drain", settle).once("close", settle).once("error", settle);
      child.once("close", settle);
    });
    void (async () => {
      for await (const chunk of input) {
        if (exited || child.stdin.destroyed) break;
        if (!child.stdin.write(chunk)) await writable();
        if (exited || child.stdin.destroyed) break;
      }
      if (!child.stdin.destroyed) child.stdin.end();
    })().catch(error => kill(error instanceof Error ? error : new RepositoryCacheError("Repository fetch failed")));
  }
  return promise;
}
