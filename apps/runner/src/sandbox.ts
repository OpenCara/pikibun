import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { createHash } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { chmod, mkdir, open, realpath, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { validateUserEnv } from "../../../packages/shared/src/policy.js";
import { validCloneDirectory } from "../../../packages/shared/src/repositories.js";
import { ATTACHMENT_CANDIDATES, attachmentCandidate, fileUploadLimits, uploadFileName } from "../../../packages/shared/src/file-uploads.js";
import { EGRESS_PORT, EGRESS_SOCKET, egressEnvironment } from "./egress.js";
import type { HostCommandOperation, Operation, RunnerBinding } from "../../../packages/shared/src/types.js";
import type { ClonePushPreparation } from "./push.js";
import { resourceLaunch, validateResourceConfig, type ResourceConfig } from "./resources.js";
import { MAX_IMAGE_BYTES, imageType, type FileContent } from "./images.js";
import { CA_BUNDLE, sandboxCertificates } from "./trust-store.js";
import { runHostShell } from "./host-shell.js";
import { checkedBrowse, type BrowseResult } from "./file-browser.js";
import { checkedSearch, type SearchRequest, type SearchResult } from "./search.js";
import { MAX_OUTPUT_BYTES, SandboxProcessError } from "./process-output.js";
import { commandLimits, gpuMounts, type CommandLimits } from "./host-config.js";
import type { IsolatedWorkspace } from "./workspace.js";
import { CREATE_FILE, OPEN_FILE, privateEntry } from "./platform.js";
import { GIT_SHIM as EMBEDDED_GIT_SHIM, HELPER } from "./sandbox-python.generated.js";
import { connectorNode, sandboxNodeMount, type NodeToolchain } from "./node-toolchain.js";

export { MAX_OUTPUT_BYTES, SandboxProcessError } from "./process-output.js";

export const TIMEOUT_MS = 30_000;
/** Push rewrites and packs move whole repositories; only push kinds get this deadline. */
export const PUSH_TIMEOUT_MS = 60 * 60 * 1000;
export const OID = /^[0-9a-f]{40}$/;
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_SNAPSHOT_OUTPUT_BYTES = 48 * 1024 * 1024;
/** A whole image file as base64 in one JSON object, with room for its key. */
export const MAX_CONTENT_OUTPUT_BYTES = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 64;
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const sessionQueues = new Map<string, Promise<void>>();

export type SandboxAuthorize = () => Promise<void>;

export interface SandboxExecutionOptions {
  /** Trusted harness only: caller must separately require faux + allowTestShell. */
  allowTestShell?: boolean;
  /**
   * The host's owner allowed this command to run without the resource limits this host lacks. It still runs inside
   * the sandbox's namespaces; provisioned limits are always used when present.
   */
  unbounded?: boolean;
  /** The command's time limit and per-process limits, from the host's configuration; a 30-second command's without them. */
  limits?: CommandLimits;
  /** Lend the command the host's GPU render device, where it has one (HostConfig.gpu; see gpuMounts). */
  gpu?: boolean;
  /** Stops the command, as closing the sandbox does: a stopped message or a closing session ends a long one at once. */
  signal?: AbortSignal;
}

/** How one shell command runs, besides what every sandboxed step gets. */
interface CommandOptions { limits?: CommandLimits; gpu?: boolean; signal?: AbortSignal }

export interface SandboxOptions {
  /** The Node.js the node tool runs (node-toolchain.ts): the connector's own by default; null for none. */
  node?: NodeToolchain | null;
  /**
   * Host path of the session's egress proxy socket (see EgressProxy). Shell commands get it read-only at EGRESS_SOCKET,
   * and the helper relays the sandbox's loopback EGRESS_PORT to it: their only way out of the network namespace.
   */
  egressSocket?: string;
  /** The branch a clone session's shell commands may push through the proxy, given to them as PIKIBUN_SESSION_BRANCH. */
  sessionBranch?: string;
  /**
   * The host repository cache's mirrors this session may borrow from (clone sessions on a cache host), asked for before
   * each shell command and each step that runs Git in a clone (a borrowing clone can't read its objects without them).
   * Each is mounted read-only at its `target` below MIRROR_ROOT, and for shell commands a `git` shim first on PATH makes
   * clones of the workspace's repositories borrow from them (see GIT_SHIM).
   */
  mirrors?: () => Promise<readonly MirrorMount[]>;
  /** Where the host's / is when shell commands look for its GPU (see gpuMounts): the host's own, unless a test gives a stand-in. */
  gpuRoot?: string;
}

export interface MirrorMount { source: string; target: string }
/** Where a clone session's shell commands see the host's mirrors; clones' `objects/info/alternates` name paths below it. */
export const MIRROR_ROOT = "/repository-mirrors";
const SHIM_DIRECTORY = "/opt/pikibun/bin";
/** The host's trusted certificates in the session's private root, mounted read-only at CA_BUNDLE for shell commands. */
export const CA_BUNDLE_FILE = "ca-certificates.crt";
/**
 * What a pack of a session's files (pack.ts) leaves out of its home, relative to it: package managers' caches, downloaded
 * again when needed, and temporary files. The sandbox helper's PACK_SKIPPED_HOME mirrors it.
 */
export const PACK_SKIPPED_HOME: readonly string[] = Object.freeze([".tmp", ".cache", ".npm", ".pnpm-store", ".yarn", ".bun", ".local/share/pnpm",
  ".cargo/registry", ".cargo/git", "go/pkg/mod", ".m2/repository", ".gradle/caches", ".nuget/packages"]);

/** The steps that may run Git in an agent's clone, and so need the mirrors a clone borrows from. */
const MIRROR_KINDS: ReadonlySet<Request["kind"]> = new Set(["bash", "clone-head", "clone-push-prepare", "clone-push-pack", "clone-backup", "clone-restore"]);

/**
 * Where sandboxes find git-lfs: the host's own, as /usr is mounted read-only in every sandbox. Package managers install
 * it in /usr/bin; /usr/local/bin is not on sandboxed commands' PATH, so it is always named by its full path.
 */
export const GIT_LFS_PATHS = ["/usr/bin/git-lfs", "/usr/local/bin/git-lfs"] as const;
/** The host's git-lfs, which sandboxed sessions can run, if it has one. */
export function hostGitLfs(): string | undefined {
  return GIT_LFS_PATHS.find(path => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } });
}

/**
 * `git` for clone sessions on a host with a repository cache or git-lfs. A clone of a workspace repository:
 * - on a cache host, first asks the egress proxy for the host's mirror and borrows its objects (--reference-if-able)
 *   instead of downloading them again. It waits for the mirror however long that takes: a mirror's first fill downloads
 *   the whole repository once, with the host's own Git credentials, and the clone never downloads it a second time
 *   beside it. The wait is told on stderr, and the fill goes on if the command stops. A dropped connection or a failure
 *   that may pass is asked again; only a mirror the host can't fill at all lets the clone go ahead without it. A mirror
 *   that stays unavailable, or that the command can't see yet (mounts are fixed when a command starts), fails the
 *   clone, to be run again;
 * - where the workspace turned Git LFS on for the repository and git-lfs is installed, configures the clone's LFS
 *   filters (in its own .git/config), so its checkout downloads LFS files' content through the proxy. Elsewhere clones
 *   keep LFS pointer files, as plain Git does.
 * Everything else runs Git unchanged. Its source is apps/runner/src/sandbox-python/git_shim.py, embedded by
 * scripts/embed-python.mjs.
 */
const GIT_SHIM = EMBEDDED_GIT_SHIM;

/** The sandbox request that imports an attached file, checked before it goes to any helper. */
export function importRequest(directory: string, name: string, data: Buffer): { kind: "import"; directory: string; name: string; data: string } {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(directory) || directory.startsWith(".") || !name || uploadFileName(name) !== name
    || !Buffer.isBuffer(data) || data.length > fileUploadLimits.maxBytes) throw new Error("Invalid file import");
  return { kind: "import", directory: text(directory, "directory", 64), name, data: data.toString("base64") };
}

/** The path a helper says it imported a file to: in the requested directory, under a name `attachmentCandidate` makes. */
export function importedPath(value: unknown, request: { directory: string; name: string }): string {
  const path = (value as { path?: unknown } | null)?.path;
  if (typeof path === "string" && path.startsWith(`${request.directory}/`)) {
    const name = path.slice(request.directory.length + 1);
    for (let index = 1; index <= ATTACHMENT_CANDIDATES; index++) if (attachmentCandidate(request.name, index) === name) return path;
  }
  throw new Error("Invalid sandbox import response");
}

export interface SnapshotFile {
  /** Relative to the constructor's sandbox root; data is base64, including binary files. */
  path: string;
  data: string;
  mode: number;
}

/**
 * One clone of a clone session as a backup keeps it (see Sandbox.cloneBackup). `worktree` commits its working tree,
 * untracked files included and ignored ones not, on top of `head`; `bundle` (base64) holds what `origin` doesn't have:
 * `worktree` and the local branches, as `refs/pikibun/backup` and `refs/heads/*`.
 */
export interface CloneBackup {
  path: string; origin: string | null; branch: string | null; head: string | null; worktree: string;
  branches: [string, string][]; bundle: string | null;
}

export interface SandboxIdentity {
  ownerId: string;
  githubLogin: string | null;
  gitName: string;
  gitEmail: string;
  home: string;
  worktree: string;
  env: Readonly<Record<string, string>>;
}

interface Mounts {
  root: FileHandle;
  home: FileHandle;
  worktree: FileHandle;
  git: FileHandle;
  config: FileHandle;
}

export type SandboxRequest = Request;
type Request =
  | { kind: "initialize" }
  | { kind: "read" | "read-content" | "list" | "browse"; path: string }
  | SearchRequest
  | { kind: "write"; path: string; content: string }
  | { kind: "import"; directory: string; name: string; data: string }
  | { kind: "snapshot"; clones?: string[]; skipCaches?: true }
  | { kind: "bash"; command: string }
  | { kind: "clone-head"; path: string }
  | { kind: "clone-push-prepare"; path: string; commit: string; old: string | null; tips: string[] }
  | { kind: "clone-push-pack"; path: string; commit: string; exclude: string[] }
  | { kind: "clone-backup"; pack?: true }
  | { kind: "clone-pending" }
  | { kind: "clone-restore"; path: string; url: string; reference: string | null };

/** Push transfers: a pack streamed after the request line, or stdout handed over uncapped. */
interface Transfer { input?: AsyncIterable<Uint8Array>; output?: (stdout: Readable, kill: () => void) => void }

/**
 * The helper every sandboxed step runs as (`python3 -I -c HELPER`): all untrusted filesystem access happens there, after
 * entering the namespace. Its source is apps/runner/src/sandbox-python/helper.py, embedded by scripts/embed-python.mjs.
 */
export { HELPER };

/** Waits for a writable to drain or close, removing whichever listener did not fire so long streams never accumulate listeners. */
export function drained(stream: Writable): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  if (stream.destroyed) { resolve(); return promise; }
  const done = () => { stream.off("drain", done); stream.off("close", done); resolve(); };
  stream.on("drain", done);
  stream.on("close", done);
  return promise;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

export function text(value: unknown, label: string, limit: number, multiline = false): string {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > limit || value.includes("\0") || (!multiline && /[\r\n]/.test(value))) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function fdPath(directory: FileHandle, name: string): string {
  // name is always an internal single component, never a tool-supplied path.
  return `/proc/self/fd/${directory.fd}/${name}`;
}

async function privateDirectory(parent: FileHandle, name: string, create: boolean): Promise<FileHandle> {
  const path = fdPath(parent, name);
  if (create) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  }
  const handle = await open(path, DIRECTORY_FLAGS);
  try {
    const info = await handle.stat();
    if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
      throw new Error("Sandbox storage must be private and owned by the runner user");
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function openRoot(path: string): Promise<FileHandle> {
  // Pin every ancestor rather than checking lstat/realpath and subsequently opening
  // the original pathname. Even a renamed ancestor cannot redirect these operations.
  let current = await open(sep, DIRECTORY_FLAGS);
  try {
    const components = path.split(sep).filter(Boolean);
    for (let index = 0; index < components.length; index++) {
      const component = components[index]!;
      const childPath = fdPath(current, component);
      try {
        await mkdir(childPath, { mode: 0o700 });
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
      const next = index === components.length - 1
        ? await privateDirectory(current, component, false)
        : await open(childPath, DIRECTORY_FLAGS);
      await current.close();
      current = next;
    }
    if (await realpath(`/proc/self/fd/${current.fd}`) !== path) {
      throw new Error("Sandbox root changed during initialization");
    }
    return current;
  } catch (error) {
    await current.close();
    throw error;
  }
}

async function placeholder(parent: FileHandle, name: string): Promise<void> {
  const handle = await open(fdPath(parent, name), constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.()) {
      throw new Error("Unsafe sandbox mount point");
    }
  } finally {
    await handle.close();
  }
}

export function quoteGitConfig(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\t/g, "\\t")}"`;
}

/** Immutable per-session owner Git config, shared with the unsandboxed host workspace. */
export function ownerGitConfig(identity: Readonly<SandboxIdentity>): string {
  const { ownerId, githubLogin, gitName, gitEmail, home, worktree } = identity;
  return `# Immutable session owner: ${JSON.stringify({ ownerId, githubLogin, gitName, gitEmail, home, worktree })}\n[user]\n\tname = ${quoteGitConfig(gitName)}\n\temail = ${quoteGitConfig(gitEmail)}\n[core]\n\thooksPath = /dev/null\n\tfsmonitor = false\n[commit]\n\tgpgSign = false\n[credential]\n\thelper =\n`;
}

/** The complete process environment for session tools; nothing is inherited from the runner. */
export function sessionEnvironment(identity: Readonly<SandboxIdentity>, tools: { path: string; gitConfig: string }): Readonly<Record<string, string>> {
  return Object.freeze({
    ...identity.env,
    PATH: tools.path,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    TERM: "dumb",
    HOME: identity.home,
    PWD: identity.worktree,
    TMPDIR: `${identity.home}/.tmp`,
    XDG_CONFIG_HOME: `${identity.home}/.config`,
    XDG_CACHE_HOME: `${identity.home}/.cache`,
    SANDBOX_WORKTREE: identity.worktree,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: tools.gitConfig,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/usr/bin/false",
    SSH_ASKPASS: "/usr/bin/false",
    GIT_PAGER: "cat",
    GIT_EDITOR: "/usr/bin/false",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_AUTHOR_NAME: identity.gitName,
    GIT_AUTHOR_EMAIL: identity.gitEmail,
    GIT_COMMITTER_NAME: identity.gitName,
    GIT_COMMITTER_EMAIL: identity.gitEmail,
  });
}

/** Only runner-owned cache directories, at their fixed place below MIRROR_ROOT. */
function mirrorMount(mount: MirrorMount): boolean {
  return isAbsolute(mount.source) && !mount.source.split(sep).includes("..")
    && /^\/repository-mirrors\/[a-z0-9-]{1,32}\/[a-z0-9._-]{1,253}\/[A-Za-z0-9{}_-]{1,100}\.git$/.test(mount.target);
}

/** Creates the read-only owner Git config once, then verifies it is the unchanged private original. */
export async function pinOwnerConfig(path: string, configText: string): Promise<FileHandle> {
  try {
    const created = await open(path, CREATE_FILE, 0o400);
    try {
      await created.writeFile(configText, "utf8");
      await created.sync();
    } finally {
      await created.close();
    }
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  const config = await open(path, OPEN_FILE);
  try {
    const info = await config.stat();
    if (!info.isFile() || info.nlink !== 1 || !privateEntry(info, 0o377) || info.size !== Buffer.byteLength(configText)) {
      throw new Error("Unsafe or changed session owner configuration");
    }
    if (await config.readFile("utf8") !== configText) throw new Error("Session owner identity is immutable");
    return config;
  } catch (error) {
    await config.close();
    throw error;
  }
}

/**
 * Linux-only execution boundary. The caller supplies a trusted live-authorization
 * callback, which is awaited after queueing, immediately before execution.
 * execute() takes the exact approved Operation, never a reconstructed shell command.
 * No host-shell, host-Git, or host-filesystem-tool fallback exists.
 */
export class Sandbox implements IsolatedWorkspace {
  readonly isolated = true;
  readonly #root: string;
  readonly #identity: Readonly<SandboxIdentity>;
  readonly #environment: Readonly<Record<string, string>>;
  readonly #resources: Readonly<ResourceConfig> | undefined;
  readonly #sessionKey: string;
  readonly #testProvider: boolean;
  readonly #egressSocket: string | undefined;
  readonly #sessionBranch: string | undefined;
  readonly #mirrors: (() => Promise<readonly MirrorMount[]>) | undefined;
  readonly #gpuRoot: string;
  /** Whether shell commands get the `git` shim: on a cache host, or where git-lfs is installed, in sessions with a proxy. */
  readonly #shim: boolean;
  /** The connector's Node.js, mounted read-only for shell commands where the sandbox doesn't see it already. */
  readonly #nodeMount: { source: string; target: string } | undefined;
  readonly nodeBin: string | undefined;
  #initialization: Promise<void> | undefined;
  #mounts: Mounts | undefined;
  #closed = false;
  #cancelActive: (() => void) | undefined;

  constructor(binding: RunnerBinding, root: string, resources?: ResourceConfig, options: SandboxOptions = {}) {
    if (process.platform !== "linux" || !isAbsolute(root) || resolve(root) === sep) {
      throw new Error("Sandbox requires Linux and an absolute, non-root private storage path");
    }
    if (["/usr", "/lib", "/lib64"].some((runtime) => resolve(root) === runtime || resolve(root).startsWith(`${runtime}/`))) {
      throw new Error("Session storage cannot be located in a shared runtime mount");
    }
    const ownerId = text(binding.owner.id, "owner id", 256);
    if (binding.session.ownerId !== ownerId) throw new Error("Session owner does not match its binding");
    const sessionId = text(binding.session.id, "session id", 256);
    const gitName = text(binding.owner.gitName, "Git name", 256);
    const gitEmail = text(binding.owner.gitEmail, "Git email", 320);
    if (/[<>\x00-\x1f\x7f]/.test(gitName + gitEmail)) throw new Error("Invalid Git identity");
    const githubLogin = binding.owner.githubLogin === null ? null : text(binding.owner.githubLogin, "GitHub login", 256);
    const env = Object.freeze({ ...validateUserEnv(binding.owner.env) });
    const key = createHash("sha256").update(JSON.stringify([ownerId, sessionId])).digest("hex");
    this.#sessionKey = key;
    this.#resources = resources ? validateResourceConfig(resources) : undefined;
    this.#testProvider = binding.model.provider === "faux";
    if (options.egressSocket !== undefined && !isAbsolute(options.egressSocket)) throw new Error("Invalid egress socket path");
    this.#egressSocket = options.egressSocket;
    this.#sessionBranch = options.sessionBranch;
    this.#mirrors = options.mirrors;
    this.#gpuRoot = options.gpuRoot ?? "/";
    this.#shim = options.egressSocket !== undefined && (options.mirrors !== undefined || hostGitLfs() !== undefined);
    const node = sandboxNodeMount(options.node === undefined ? connectorNode() : options.node ?? undefined);
    this.#nodeMount = node?.mount;
    this.nodeBin = node?.bin;
    const base = `/sessions/${key}`;
    this.#root = resolve(root);
    this.#identity = Object.freeze({ ownerId, githubLogin, gitName, gitEmail, home: `${base}/home`, worktree: `${base}/worktree`, env });
    this.#environment = sessionEnvironment(this.#identity, { path: "/usr/bin:/bin", gitConfig: `${this.home}/.gitconfig` });
  }

  get home(): string { return this.#identity.home; }
  get worktree(): string { return this.#identity.worktree; }
  /** Where the worktree is on the host; `worktree` is where it is mounted in the sandbox, a path the host doesn't have. */
  get hostWorktree(): string { return resolve(this.#root, "worktree"); }

  async identity(authorize: SandboxAuthorize): Promise<Readonly<SandboxIdentity>> {
    if (typeof authorize !== "function") throw new Error("Sandbox authorization callback is required");
    return this.#exclusive(async () => {
      if (this.#closed) throw new Error("Sandbox is closed");
      await authorize();
      if (this.#closed) throw new Error("Sandbox is closed");
      return this.#identity;
    });
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = sessionQueues.get(this.#root) ?? Promise.resolve();
    const result = previous.then(operation);
    const barrier = result.then(() => undefined, () => undefined);
    sessionQueues.set(this.#root, barrier);
    try {
      return await result;
    } finally {
      if (sessionQueues.get(this.#root) === barrier) sessionQueues.delete(this.#root);
    }
  }

  initialize(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("Sandbox is closed"));
    this.#initialization ??= this.#exclusive(async () => {
      const opened: FileHandle[] = [];
      try {
        const root = await openRoot(this.#root);
        opened.push(root);
        const home = await privateDirectory(root, "home", true);
        opened.push(home);
        const worktree = await privateDirectory(root, "worktree", true);
        opened.push(worktree);
        const git = await privateDirectory(root, "git", true);
        opened.push(git);
        // File-only backups omit empty Git directories, including those in an unborn repository.
        for (const name of ["objects", "refs"]) {
          const directory = await privateDirectory(git, name, true);
          await directory.close();
        }
        const gitPoint = await privateDirectory(worktree, ".git", true);
        await gitPoint.close();
        const temporary = await privateDirectory(home, ".tmp", true);
        await temporary.close();
        await placeholder(home, ".gitconfig");
        const config = await pinOwnerConfig(fdPath(root, "owner.gitconfig"), ownerGitConfig(this.#identity));
        // The shim lives beside the session's mounts, where nothing in the sandbox can change it.
        if (this.#shim) {
          const shim = join(this.#root, "bin", "git");
          await mkdir(join(this.#root, "bin"), { recursive: true, mode: 0o700 });
          // Written afresh at every open: the previous one is read-only, and may be an older version.
          await rm(shim, { force: true });
          await writeFile(shim, GIT_SHIM, { mode: 0o500 });
          await chmod(shim, 0o500);
        }
        // Beside the shim, out of the sandbox's reach; written at every open, so the host's current store applies.
        if (this.#egressSocket !== undefined) {
          // Replaced in one step, so no command ever finds the file missing or half written.
          const bundle = join(this.#root, CA_BUNDLE_FILE);
          const staged = `${bundle}.new`;
          await rm(staged, { force: true });
          await writeFile(staged, sandboxCertificates(), { mode: 0o400 });
          await chmod(staged, 0o400);
          await rename(staged, bundle);
        }
        opened.push(config);
        this.#mounts = { root, home, worktree, git, config };
        await this.#run({ kind: "initialize" }, false, true);
      } catch (error) {
        this.#mounts = undefined;
        await Promise.allSettled(opened.map((handle) => handle.close()));
        throw error;
      }
    });
    return this.#initialization;
  }

  async #operation(request: Request, readOnly: boolean, authorize: SandboxAuthorize, gitWritable = false, requireResources = false, command: CommandOptions = {}): Promise<string> {
    if (typeof authorize !== "function") throw new Error("Sandbox authorization callback is required");
    await this.initialize();
    return this.#exclusive(async () => {
      if (this.#closed) throw new Error("Sandbox is closed");
      // Admission-time permission may have been revoked while this operation waited.
      await authorize();
      if (this.#closed) throw new Error("Sandbox is closed");
      // A command stopped while it waited for the sandbox never starts.
      if (command.signal?.aborted) throw new SandboxProcessError("Command stopped before it started", null, null, "", "");
      return this.#run(request, readOnly, gitWritable, requireResources, {}, await this.#mirrorMounts(request), command);
    });
  }

  /** The mirrors to mount for `request`: asked for only for steps that may run Git in a clone. */
  async #mirrorMounts(request: Request): Promise<readonly MirrorMount[]> {
    return this.#mirrors && MIRROR_KINDS.has(request.kind) ? (await this.#mirrors()).filter(mirrorMount) : [];
  }

  async readFile(path: string, authorize: SandboxAuthorize): Promise<string> {
    const output = await this.#operation({ kind: "read", path: text(path, "path", 1024) }, true, authorize);
    return JSON.parse(output) as string;
  }

  /** Like `readFile`, but an image (by signature, up to `MAX_IMAGE_BYTES`) comes back as its bytes. */
  async readContent(path: string, authorize: SandboxAuthorize): Promise<FileContent> {
    const output = JSON.parse(await this.#operation({ kind: "read-content", path: text(path, "path", 1024) }, true, authorize)) as { text: string } | { image: string };
    if ("text" in output) return { text: output.text };
    const image = Buffer.from(output.image, "base64");
    const mimeType = imageType(image);
    if (!mimeType) throw new Error("Invalid sandbox image response");
    return { image, mimeType };
  }

  async writeFile(path: string, content: string, authorize: SandboxAuthorize): Promise<void> {
    if (typeof content !== "string" || Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error("File exceeds size limit");
    await this.#operation({ kind: "write", path: text(path, "path", 1024), content }, false, authorize);
  }

  /** A file attached to a message, as a new file in `directory`: see SessionWorkspace.importFile. */
  async importFile(directory: string, name: string, data: Buffer, authorize: SandboxAuthorize): Promise<string> {
    const request = importRequest(directory, name, data);
    return importedPath(JSON.parse(await this.#operation(request, false, authorize)), request);
  }

  async listFiles(path: string | undefined, authorize: SandboxAuthorize): Promise<string[]> {
    const output = await this.#operation({ kind: "list", path: text(path ?? ".", "path", 1024) }, true, authorize);
    return JSON.parse(output) as string[];
  }

  /** The file browser's read-only look at one worktree path: a directory's entries or a file's preview. */
  async browse(path: string, authorize: SandboxAuthorize): Promise<BrowseResult> {
    return checkedBrowse(JSON.parse(await this.#operation({ kind: "browse", path: text(path, "path", 1024) }, true, authorize)));
  }

  /** The search tool's search, in the helper: read-only, like reading a file. */
  async search(request: SearchRequest, authorize: SandboxAuthorize): Promise<SearchResult> {
    return checkedSearch(JSON.parse(await this.#operation({ ...request, path: text(request.path, "path", 1024) }, true, authorize)));
  }

  async execute(operation: Operation, readOnly: boolean, authorize: SandboxAuthorize, options: SandboxExecutionOptions = {}): Promise<string> {
    switch (operation.kind) {
      case "bash": {
        if (options.allowTestShell === true && !this.#testProvider) throw new Error("Test shell bypass is restricted to the explicit faux provider");
        const bounded = options.allowTestShell !== true && (!!this.#resources || options.unbounded !== true);
        if (bounded && !this.#resources) {
          throw new Error("Production bash unavailable: explicitly provisioned cgroup and bounded filesystem resources are required");
        }
        return this.#operation({ kind: "bash", command: text(operation.command, "shell command", 64 * 1024, true) }, readOnly, authorize, false, bounded,
          { limits: options.limits, gpu: options.gpu, signal: options.signal });
      }
      case "github.comment":
      case "github.merge":
      case "github.issue":
        throw new Error("GitHub operations require the control-plane credential broker, not the sandbox");
      default:
        throw new Error("Unsupported sandbox operation");
    }
  }

  /** The session's files, leaving out `clones` (worktree paths), which a backup keeps as bundles (cloneBackup). */
  /** `skipCaches`: leave out the home's package caches and temporary files (PACK_SKIPPED_HOME), as a pack does. */
  async snapshot(authorize: SandboxAuthorize, clones: readonly string[] = [], { skipCaches = false }: { skipCaches?: boolean } = {}): Promise<SnapshotFile[]> {
    return JSON.parse(await this.#operation({ kind: "snapshot", ...(clones.length ? { clones: [...clones] } : {}), ...(skipCaches ? { skipCaches: true as const } : {}) },
      true, authorize)) as SnapshotFile[];
  }

  /**
   * A clone session's clones as a backup keeps them: for each, its origin, branches and HEAD, a commit of its working
   * tree, and a bundle of what its origin doesn't have. Restorations still pending are carried over as they are.
   * `found` are the clones in the worktree, which the snapshot leaves out.
   */
  async cloneBackup(authorize: SandboxAuthorize, { pack = false }: { pack?: boolean } = {}): Promise<{ clones: CloneBackup[]; found: string[] }> {
    // `pack`: the backup will replace the clones (pack.ts), so the sandbox refuses clones with what it can't carry.
    const value = JSON.parse(await this.#operation({ kind: "clone-backup", ...(pack ? { pack: true as const } : {}) }, false, authorize)) as { clones: CloneBackup[]; found: string[] };
    if (!Array.isArray(value?.clones) || !Array.isArray(value.found) || !value.found.every(path => validCloneDirectory(path))) throw new Error("Invalid sandbox clone response");
    return value;
  }

  /** The clones a restore left to clone again, by worktree path. */
  async clonePending(authorize: SandboxAuthorize): Promise<{ path: string; origin: string | null }[]> {
    const value = JSON.parse(await this.#operation({ kind: "clone-pending" }, true, authorize)) as unknown;
    if (!Array.isArray(value)) throw new Error("Invalid sandbox clone response");
    return value.filter((entry): entry is { path: string; origin: string | null } => !!entry && typeof entry === "object"
      && validCloneDirectory((entry as { path?: unknown }).path) && ((entry as { origin?: unknown }).origin === null || typeof (entry as { origin?: unknown }).origin === "string"))
      .map(entry => ({ path: entry.path, origin: entry.origin }));
  }

  /**
   * Clones one pending clone again from `url` (its workspace repository's https remote) through the egress proxy,
   * borrowing from `reference` (a mounted mirror) when given, and puts its backed-up work back; its origin stays as the
   * clone named it. Its pending entry goes once that is done.
   */
  async cloneRestore(path: string, url: string, reference: string | null, authorize: SandboxAuthorize): Promise<void> {
    if (!validCloneDirectory(path) || !/^https:\/\/[\x21-\x7e]{1,2040}$/.test(url) || (reference !== null && !reference.startsWith(`${MIRROR_ROOT}/`)))
      throw new Error("Invalid clone restoration");
    await this.#operation({ kind: "clone-restore", path, url, reference }, false, authorize, true);
  }

  /** Explicit host-owner-approved execution, serialized with sandbox file/Git operations; never a fallback. */
  async executeHost(operation: HostCommandOperation, authorize: SandboxAuthorize, signal: AbortSignal): Promise<string> {
    if (typeof authorize !== "function") throw new Error("Host command authorization is required");
    await this.initialize();
    return this.#exclusive(async () => {
      if (this.#closed) throw new Error("Sandbox is closed");
      await authorize();
      if (this.#closed) throw new Error("Sandbox is closed");
      const controller = new AbortController();
      const cancel = () => controller.abort();
      this.#cancelActive = cancel;
      try {
        return await runHostShell(operation, {
          worktree: this.hostWorktree, git: resolve(this.#root, "git"), gitConfig: resolve(this.#root, "owner.gitconfig"),
          gitName: this.#identity.gitName, gitEmail: this.#identity.gitEmail,
          signal: AbortSignal.any([signal, controller.signal]),
        });
      } finally { if (this.#cancelActive === cancel) this.#cancelActive = undefined; }
    });
  }
  async cloneHead(path: string, authorize: SandboxAuthorize): Promise<{ commit: string; origin: string | null }> {
    if (!validCloneDirectory(path)) throw new Error("Invalid clone directory");
    const value = JSON.parse(await this.#operation({ kind: "clone-head", path }, true, authorize)) as { commit: unknown; origin: unknown };
    if (typeof value.commit !== "string" || !OID.test(value.commit) || (value.origin !== null && typeof value.origin !== "string")) throw new Error("Invalid clone head");
    return { commit: value.commit, origin: value.origin };
  }

  /** Which advertised tips the clone has, whether the branch's tip is an ancestor of `commit`, and the commits to push. */
  async clonePushPrepare(path: string, input: { commit: string; old: string | null; tips: string[] }, authorize: SandboxAuthorize): Promise<ClonePushPreparation> {
    if (!validCloneDirectory(path) || !OID.test(input.commit) || (input.old !== null && !OID.test(input.old))
      || input.tips.length > 1024 || !input.tips.every((tip) => OID.test(tip))) throw new Error("Invalid push request");
    const value = JSON.parse(await this.#operation({ kind: "clone-push-prepare", path, commit: input.commit, old: input.old, tips: [...input.tips] }, true, authorize)) as ClonePushPreparation;
    if (!Array.isArray(value.present) || !value.present.every((tip) => input.tips.includes(tip)) || (value.ancestor !== null && typeof value.ancestor !== "boolean")
      || !Array.isArray(value.commits) || value.commits.some((commit) => !OID.test(commit.source) || typeof commit.subject !== "string")
      || !Number.isSafeInteger(value.total) || value.total < value.commits.length) throw new Error("Invalid push preparation");
    return { present: value.present, ancestor: value.ancestor, commits: value.commits.map(({ source, subject }) => ({ source, subject })), total: value.total };
  }

  /** Streams the clone's pack of `commit` minus `exclude`; the session queue is held until the stream ends. */
  async clonePushPack(path: string, input: { commit: string; exclude: string[] }, authorize: SandboxAuthorize): Promise<AsyncIterable<Uint8Array>> {
    if (!validCloneDirectory(path) || !OID.test(input.commit) || input.exclude.length > 1024 || !input.exclude.every((oid) => OID.test(oid))) throw new Error("Invalid push request");
    if (typeof authorize !== "function") throw new Error("Sandbox authorization callback is required");
    await this.initialize();
    const started = Promise.withResolvers<{ stdout: Readable; kill: () => void }>();
    const finished = this.#exclusive(async () => {
      if (this.#closed) throw new Error("Sandbox is closed");
      await authorize();
      if (this.#closed) throw new Error("Sandbox is closed");
      const request: Request = { kind: "clone-push-pack", path, commit: input.commit, exclude: [...input.exclude] };
      await this.#run(request, true, false, false, { output: (stdout, kill) => started.resolve({ stdout, kill }) }, await this.#mirrorMounts(request));
    });
    finished.catch((error) => started.reject(error));
    const pack = await started.promise;
    return (async function* () {
      let complete = false;
      try {
        for await (const chunk of pack.stdout) yield chunk as Uint8Array;
        await finished;
        complete = true;
      } finally {
        if (!complete) { pack.kill(); await finished.catch(() => undefined); }
      }
    })();
  }

  /** Release pinned descriptors when the owning runner session closes. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#cancelActive?.();
    await this.#initialization?.catch(() => undefined);
    await this.#exclusive(async () => {
      const mounts = this.#mounts;
      this.#mounts = undefined;
      if (mounts) await Promise.allSettled(Object.values(mounts).map((handle) => handle.close()));
    });
  }

  #run(request: Request, readOnly: boolean, gitWritable: boolean, requireResources = false, transfer: Transfer = {}, mirrors: readonly MirrorMount[] = [],
    command: CommandOptions = {}): Promise<string> {
    const mounts = this.#mounts;
    if (!mounts) return Promise.reject(new Error("Sandbox is not initialized"));
    if (readOnly && gitWritable) return Promise.reject(new Error("Invalid read-only mount request"));
    if (requireResources && !this.#resources) return Promise.reject(new Error("Production bash resources are unavailable"));
    const mount = readOnly ? "--ro-bind-fd" : "--bind-fd";
    const egress = request.kind === "bash" || request.kind === "clone-restore" ? this.#egressSocket : undefined;
    // Only shell commands get the GPU, and only its render device; it is looked up again for each one.
    const gpu = request.kind === "bash" && command.gpu ? gpuMounts(this.#gpuRoot) : undefined;
    const limits = request.kind === "bash" ? command.limits : undefined;
    const args = [
      "--unshare-all", "--unshare-user", "--disable-userns", "--die-with-parent", "--new-session",
      "--cap-drop", "ALL",
      "--ro-bind", "/usr", "/usr",
      "--ro-bind", "/lib", "/lib",
      "--ro-bind", "/lib64", "/lib64",
      "--symlink", "usr/bin", "/bin",
      "--proc", "/proc", "--dev", "/dev",
      mount, "3", this.home,
      mount, "4", this.worktree,
      gitWritable ? "--bind-fd" : "--ro-bind-fd", "5", `${this.worktree}/.git`,
      "--ro-bind-fd", "6", `${this.home}/.gitconfig`,
      // Only shell commands reach the network, and only through the session's proxy. A missing socket (the session is
      // not open) is skipped; requests then fail to connect.
      // The certificates are written whenever there is a proxy, so a missing file is an error, not a skipped mount.
      ...(egress ? ["--ro-bind-try", egress, EGRESS_SOCKET, "--ro-bind", join(this.#root, CA_BUNDLE_FILE), CA_BUNDLE] : []),
      ...(egress && this.#shim ? ["--ro-bind-try", join(this.#root, "bin"), SHIM_DIRECTORY] : []),
      ...mirrors.flatMap(({ source, target }) => ["--ro-bind-try", source, target]),
      ...(request.kind === "bash" && this.#nodeMount ? ["--ro-bind-try", this.#nodeMount.source, this.#nodeMount.target] : []),
      ...(gpu?.args ?? []),
      "--remount-ro", "/proc", "--remount-ro", "/dev", "--remount-ro", "/",
      "--chdir", this.worktree, "--clearenv",
    ];
    for (const [name, value] of Object.entries(this.#environment)) args.push("--setenv", name, value);
    if (egress) for (const [name, value] of Object.entries(egressEnvironment(this.#sessionBranch))) args.push("--setenv", name, value);
    if (egress && this.#shim) args.push("--setenv", "PATH", `${SHIM_DIRECTORY}:${this.#environment.PATH}`);
    for (const [name, value] of Object.entries(gpu?.env ?? {})) args.push("--setenv", name, value);
    args.push("--", "/usr/bin/python3", "-I", "-c", HELPER);
    const limit = request.kind === "snapshot" || request.kind === "clone-backup" ? MAX_SNAPSHOT_OUTPUT_BYTES : request.kind === "read-content" ? MAX_CONTENT_OUTPUT_BYTES : MAX_OUTPUT_BYTES;
    const deadline = ["clone-push-prepare", "clone-push-pack", "clone-backup", "clone-restore"].includes(request.kind)
      ? PUSH_TIMEOUT_MS : (limits ?? commandLimits(TIMEOUT_MS / 1000)).seconds * 1000;
    const launch = requireResources
      ? resourceLaunch(this.#resources!, this.#sessionKey, args, deadline / 1000)
      : { command: "/usr/bin/bwrap", args };
    return new Promise<string>((resolveResult, reject) => {
      // Resource supervisor alone receives root fd 8 and liveness pipe 7. It closes
      // both before bwrap exec; neither is exposed to the untrusted namespace.
      const child = spawn(launch.command, launch.args, {
        cwd: "/",
        env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
        detached: true,
        stdio: requireResources
          ? ["pipe", "pipe", "pipe", mounts.home.fd, mounts.worktree.fd, mounts.git.fd, mounts.config.fd, "pipe", mounts.root.fd]
          : ["pipe", "pipe", "pipe", mounts.home.fd, mounts.worktree.fd, mounts.git.fd, mounts.config.fd],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let failure: string | undefined;
      let spawnFailure: Error | undefined;
      const kill = () => {
        if (!child.pid) return;
        if (requireResources) {
          // Never SIGKILL the supervisor: it must retain its lock until the entire
          // cgroup is killed and empty. It also watches parent EOF + its own deadline.
          child.kill("SIGTERM");
          return;
        }
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (errorCode(error) !== "ESRCH") child.kill("SIGKILL");
        }
      };
      const cancel = () => {
        failure ??= "Sandbox closed";
        kill();
      };
      this.#cancelActive = cancel;
      const stop = () => {
        failure ??= "Command stopped";
        kill();
      };
      command.signal?.addEventListener("abort", stop, { once: true });
      if (command.signal?.aborted) stop();
      const timer = setTimeout(() => {
        failure ??= `Sandbox exceeded ${deadline}ms time limit`;
        kill();
      }, deadline);
      const capture = (target: Buffer[], chunk: Buffer) => {
        const remaining = Math.max(0, limit - bytes);
        if (remaining) target.push(chunk.subarray(0, remaining));
        bytes += chunk.length;
        if (bytes > limit) {
          failure ??= `Sandbox exceeded ${limit} byte output limit`;
          kill();
        }
      };
      // Push packs stream to the forge uncapped; stderr stays bounded.
      if (transfer.output) transfer.output(child.stdout!, cancel);
      else child.stdout!.on("data", (chunk: Buffer) => capture(stdout, chunk));
      child.stderr!.on("data", (chunk: Buffer) => capture(stderr, chunk));
      for (const stream of [child.stdout!, child.stderr!]) {
        stream.on("error", () => {
          failure ??= "Could not read sandbox output";
          kill();
        });
      }
      child.once("error", (error) => {
        spawnFailure = error;
        failure ??= "Sandbox launcher is unavailable; refusing unsandboxed execution";
        kill();
      });
      child.stdin!.on("error", (error: NodeJS.ErrnoException) => {
        // Early process exit commonly closes stdin; the exit status is authoritative.
        if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") {
          failure ??= "Could not send sandbox request";
          kill();
        }
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        command.signal?.removeEventListener("abort", stop);
        if (this.#cancelActive === cancel) this.#cancelActive = undefined;
        child.stdio.at(7)?.destroy();
        const out = Buffer.concat(stdout).toString("utf8");
        const err = Buffer.concat(stderr).toString("utf8");
        if (failure || code !== 0 || signal) {
          const detail = failure ?? `Sandbox process failed (${signal ?? `exit ${code}`})`;
          const error = new SandboxProcessError(`${detail}${err ? `: ${err.slice(0, 4096).trim()}` : ""}`, code, signal, out, err);
          if (spawnFailure) error.cause = spawnFailure;
          reject(error);
        } else {
          // Structured filesystem responses use stdout only; shell/Git diagnostics
          // remain visible without corrupting their exit status or JSON tool output.
          resolveResult(request.kind === "bash" ? out + err : out);
        }
      });
      const line = JSON.stringify({ ...request, ...(egress ? { egress: { socket: EGRESS_SOCKET, port: EGRESS_PORT } } : {}),
        ...(limits ? { limits: { cpu: limits.cpuSeconds, size: limits.fileBytes, files: limits.openFiles } } : {}) });
      const input = transfer.input;
      if (!input) child.stdin!.end(line);
      else {
        // One request line, then the upstream pack with backpressure.
        void (async () => {
          const stdin = child.stdin!;
          stdin.write(`${line}\n`);
          for await (const chunk of input) {
            if (stdin.destroyed) break;
            if (!stdin.write(chunk)) await drained(stdin);
          }
          stdin.end();
        })().catch(() => {
          failure ??= "Could not stream the upstream pack";
          kill();
        });
      }
    });
  }
}
