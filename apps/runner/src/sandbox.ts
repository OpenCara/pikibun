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
import { BROWSER_DRIVER, GIT_SHIM as EMBEDDED_GIT_SHIM, HELPER, SERVICE_DRIVER } from "./sandbox-python.generated.js";
import { SANDBOX_SERVICE_DRIVER, SANDBOX_SERVICE_SOCKETS, type ServiceExit, type ServiceProcess } from "./session-service.js";
import { connectorNode, sandboxNodeMount, type NodeToolchain, type SandboxNodeMount } from "./node-toolchain.js";
import { checkedFileOperation, type FileOperationRequest, type FileOperationResult } from "./file-operations.js";
import { connectorBrowser, SANDBOX_BROWSER_DRIVER, sandboxBrowserMount, type BrowserToolchain } from "./browser-toolchain.js";
import type { SessionBrowser } from "./browser-command.js";
import type { SandboxNodePrograms } from "./program-availability.js";

export { MAX_OUTPUT_BYTES, SandboxProcessError } from "./process-output.js";

export const TIMEOUT_MS = 30_000;
export const PUSH_TIMEOUT_MS = 60 * 60 * 1000;
export const OID = /^[0-9a-f]{40}$/;
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_SNAPSHOT_OUTPUT_BYTES = 48 * 1024 * 1024;
export const MAX_CONTENT_OUTPUT_BYTES = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 64;
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const sessionQueues = new Map<string, Promise<void>>();

export type SandboxAuthorize = () => Promise<void>;

export interface SandboxExecutionOptions {
  allowTestShell?: boolean;
  unbounded?: boolean;
  limits?: CommandLimits;
  gpu?: boolean;
  signal?: AbortSignal;
}

interface CommandOptions { limits?: CommandLimits; gpu?: boolean; signal?: AbortSignal; service?: { socketDirectory: string } }

export interface SandboxOptions {
  node?: NodeToolchain | null;
  browser?: BrowserToolchain | null | (() => BrowserToolchain | undefined);
  egressSocket?: string;
  sessionBranch?: string;
  mirrors?: () => Promise<readonly MirrorMount[]>;
  gpuRoot?: string;
}

export interface MirrorMount { source: string; target: string }
export const MIRROR_ROOT = "/repository-mirrors";
const SHIM_DIRECTORY = "/opt/pikibun/bin";
export const CA_BUNDLE_FILE = "ca-certificates.crt";
export const PACK_SKIPPED_HOME: readonly string[] = Object.freeze([".tmp", ".cache", ".npm", ".pnpm-store", ".yarn", ".bun", ".local/share/pnpm",
  ".cargo/registry", ".cargo/git", "go/pkg/mod", ".m2/repository", ".gradle/caches", ".nuget/packages"]);

const MIRROR_KINDS: ReadonlySet<Request["kind"]> = new Set(["bash", "clone-head", "clone-push-prepare", "clone-push-pack", "clone-backup", "clone-restore"]);

export const GIT_LFS_PATHS = ["/usr/bin/git-lfs", "/usr/local/bin/git-lfs"] as const;
export function hostGitLfs(): string | undefined {
  return GIT_LFS_PATHS.find(path => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } });
}

const GIT_SHIM = EMBEDDED_GIT_SHIM;

export function importRequest(directory: string, name: string, data: Buffer): { kind: "import"; directory: string; name: string; data: string } {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(directory) || directory.startsWith(".") || !name || uploadFileName(name) !== name
    || !Buffer.isBuffer(data) || data.length > fileUploadLimits.maxBytes) throw new Error("Invalid file import");
  return { kind: "import", directory: text(directory, "directory", 64), name, data: data.toString("base64") };
}

export function importedPath(value: unknown, request: { directory: string; name: string }): string {
  const path = (value as { path?: unknown } | null)?.path;
  if (typeof path === "string" && path.startsWith(`${request.directory}/`)) {
    const name = path.slice(request.directory.length + 1);
    for (let index = 1; index <= ATTACHMENT_CANDIDATES; index++) if (attachmentCandidate(request.name, index) === name) return path;
  }
  throw new Error("Invalid sandbox import response");
}

export interface SnapshotFile {
  path: string;
  data: string;
  mode: number;
}

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
  | FileOperationRequest
  | { kind: "import"; directory: string; name: string; data: string }
  | { kind: "snapshot"; clones?: string[]; skipCaches?: true }
  | { kind: "bash"; command: string }
  | { kind: "clone-head"; path: string }
  | { kind: "clone-push-prepare"; path: string; commit: string; old: string | null; tips: string[] }
  | { kind: "clone-push-pack"; path: string; commit: string; exclude: string[] }
  | { kind: "clone-backup"; pack?: true }
  | { kind: "clone-pending" }
  | { kind: "clone-restore"; path: string; url: string; reference: string | null };

interface Transfer { input?: AsyncIterable<Uint8Array>; output?: (stdout: Readable, kill: () => void) => void }

export { HELPER };

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

export function ownerGitConfig(identity: Readonly<SandboxIdentity>): string {
  const { ownerId, githubLogin, gitName, gitEmail, home, worktree } = identity;
  return `# Immutable session owner: ${JSON.stringify({ ownerId, githubLogin, gitName, gitEmail, home, worktree })}\n[user]\n\tname = ${quoteGitConfig(gitName)}\n\temail = ${quoteGitConfig(gitEmail)}\n[core]\n\thooksPath = /dev/null\n\tfsmonitor = false\n[commit]\n\tgpgSign = false\n[credential]\n\thelper =\n`;
}

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

function mirrorMount(mount: MirrorMount): boolean {
  return isAbsolute(mount.source) && !mount.source.split(sep).includes("..")
    && /^\/repository-mirrors\/[a-z0-9-]{1,32}\/[a-z0-9._-]{1,253}\/[A-Za-z0-9{}_-]{1,100}\.git$/.test(mount.target);
}

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
  readonly #shim: boolean;
  readonly #nodeMount: SandboxNodeMount | undefined;
  readonly nodeBin: string | undefined;
  readonly nodePrograms: SandboxNodePrograms | undefined;
  readonly #browserSource: () => BrowserToolchain | undefined;
  readonly #browserDriver: boolean;
  #initialization: Promise<void> | undefined;
  #mounts: Mounts | undefined;
  #closed = false;
  #cancelActive: (() => void) | undefined;
  readonly #services = new Set<() => void>();

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
    this.nodePrograms = node ? { bin: node.bin, ...(node.mount ? { programs: ["node", ...node.mount.links.map(link => link.path.slice(link.path.lastIndexOf("/") + 1))] } : {}) } : undefined;
    const browser = options.browser;
    this.#browserSource = typeof browser === "function" ? browser : browser === undefined ? connectorBrowser : () => browser ?? undefined;
    this.#browserDriver = browser !== null;
    const base = `/sessions/${key}`;
    this.#root = resolve(root);
    this.#identity = Object.freeze({ ownerId, githubLogin, gitName, gitEmail, home: `${base}/home`, worktree: `${base}/worktree`, env });
    this.#environment = sessionEnvironment(this.#identity, { path: "/usr/bin:/bin", gitConfig: `${this.home}/.gitconfig` });
  }

  get home(): string { return this.#identity.home; }
  get worktree(): string { return this.#identity.worktree; }
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
        if (this.#shim) {
          const shim = join(this.#root, "bin", "git");
          await mkdir(join(this.#root, "bin"), { recursive: true, mode: 0o700 });
          await rm(shim, { force: true });
          await writeFile(shim, GIT_SHIM, { mode: 0o500 });
          await chmod(shim, 0o500);
        }
        if (this.#browserDriver) {
          const driver = join(this.#root, "browser", "pikibun-browser");
          await mkdir(join(this.#root, "browser"), { recursive: true, mode: 0o700 });
          await rm(driver, { force: true });
          await writeFile(driver, BROWSER_DRIVER, { mode: 0o500 });
          await chmod(driver, 0o500);
        }
        const service = join(this.#root, "service", "pikibun-service");
        await mkdir(join(this.#root, "service"), { recursive: true, mode: 0o700 });
        await rm(service, { force: true });
        await writeFile(service, SERVICE_DRIVER, { mode: 0o500 });
        await chmod(service, 0o500);
        if (this.#egressSocket !== undefined) {
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
      await authorize();
      if (this.#closed) throw new Error("Sandbox is closed");
      if (command.signal?.aborted) throw new SandboxProcessError("Command stopped before it started", null, null, "", "");
      return this.#run(request, readOnly, gitWritable, requireResources, {}, await this.#mirrorMounts(request), command);
    });
  }

  async #mirrorMounts(request: Request): Promise<readonly MirrorMount[]> {
    return this.#mirrors && MIRROR_KINDS.has(request.kind) ? (await this.#mirrors()).filter(mirrorMount) : [];
  }

  async readFile(path: string, authorize: SandboxAuthorize): Promise<string> {
    const output = await this.#operation({ kind: "read", path: text(path, "path", 1024) }, true, authorize);
    return JSON.parse(output) as string;
  }

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

  async importFile(directory: string, name: string, data: Buffer, authorize: SandboxAuthorize): Promise<string> {
    const request = importRequest(directory, name, data);
    return importedPath(JSON.parse(await this.#operation(request, false, authorize)), request);
  }

  async listFiles(path: string | undefined, authorize: SandboxAuthorize): Promise<string[]> {
    const output = await this.#operation({ kind: "list", path: text(path ?? ".", "path", 1024) }, true, authorize);
    return JSON.parse(output) as string[];
  }

  get browser(): SessionBrowser | undefined {
    const browser = sandboxBrowserMount(this.#browserSource());
    return browser ? { driver: SANDBOX_BROWSER_DRIVER, chromium: browser.executable } : undefined;
  }

  async browse(path: string, authorize: SandboxAuthorize): Promise<BrowseResult> {
    return checkedBrowse(JSON.parse(await this.#operation({ kind: "browse", path: text(path, "path", 1024) }, true, authorize)));
  }

  async search(request: SearchRequest, authorize: SandboxAuthorize): Promise<SearchResult> {
    return checkedSearch(JSON.parse(await this.#operation({ ...request, path: text(request.path, "path", 1024) }, true, authorize)));
  }

  async fileOperation(request: FileOperationRequest, authorize: SandboxAuthorize): Promise<FileOperationResult> {
    return checkedFileOperation(JSON.parse(await this.#operation(request, false, authorize)));
  }

  async execute(operation: Operation, readOnly: boolean, authorize: SandboxAuthorize, options: SandboxExecutionOptions = {}): Promise<string> {
    switch (operation.kind) {
      case "program":
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

  async startService(command: string, authorize: SandboxAuthorize, options: { limits: CommandLimits; unbounded: boolean; gpu?: boolean; socketDirectory: string;
    onOutput: (chunk: Buffer) => void; signal?: AbortSignal }): Promise<ServiceProcess> {
    if (typeof authorize !== "function") throw new Error("Sandbox authorization callback is required");
    if (!isAbsolute(options.socketDirectory)) throw new Error("Invalid service socket directory");
    const bounded = !!this.#resources || !options.unbounded;
    if (bounded && !this.#resources) throw new Error("Production bash unavailable: explicitly provisioned cgroup and bounded filesystem resources are required");
    await this.initialize();
    return this.#exclusive(async () => {
      if (this.#closed) throw new Error("Sandbox is closed");
      await authorize();
      if (this.#closed) throw new Error("Sandbox is closed");
      if (options.signal?.aborted) throw new SandboxProcessError("Service stopped before it started", null, null, "", "");
      const controller = new AbortController();
      const kill = () => controller.abort();
      options.signal?.addEventListener("abort", kill, { once: true });
      this.#services.add(kill);
      const exited: Promise<ServiceExit> = this.#run({ kind: "bash", command: text(command, "service command", 64 * 1024, true) }, false, false, bounded,
        { output: stdout => { stdout.on("data", (chunk: Buffer) => options.onOutput(chunk)); } }, [],
        { limits: options.limits, gpu: options.gpu, signal: controller.signal, service: { socketDirectory: options.socketDirectory } })
        .then((): ServiceExit => ({ code: 0, signal: null }), (error: unknown): ServiceExit => error instanceof SandboxProcessError
          ? { code: error.exitCode, signal: error.signal as NodeJS.Signals | null, ...(error.exitCode === null && !error.signal ? { failure: error.message.slice(0, 500) } : {}) }
          : { code: null, signal: null, failure: error instanceof Error ? error.message.slice(0, 500) : "The service failed" })
        .finally(() => { this.#services.delete(kill); options.signal?.removeEventListener("abort", kill); });
      return { exited, kill };
    });
  }

  async snapshot(authorize: SandboxAuthorize, clones: readonly string[] = [], { skipCaches = false }: { skipCaches?: boolean } = {}): Promise<SnapshotFile[]> {
    return JSON.parse(await this.#operation({ kind: "snapshot", ...(clones.length ? { clones: [...clones] } : {}), ...(skipCaches ? { skipCaches: true as const } : {}) },
      true, authorize)) as SnapshotFile[];
  }

  async cloneBackup(authorize: SandboxAuthorize, { pack = false }: { pack?: boolean } = {}): Promise<{ clones: CloneBackup[]; found: string[] }> {
    const value = JSON.parse(await this.#operation({ kind: "clone-backup", ...(pack ? { pack: true as const } : {}) }, false, authorize)) as { clones: CloneBackup[]; found: string[] };
    if (!Array.isArray(value?.clones) || !Array.isArray(value.found) || !value.found.every(path => validCloneDirectory(path))) throw new Error("Invalid sandbox clone response");
    return value;
  }

  async clonePending(authorize: SandboxAuthorize): Promise<{ path: string; origin: string | null }[]> {
    const value = JSON.parse(await this.#operation({ kind: "clone-pending" }, true, authorize)) as unknown;
    if (!Array.isArray(value)) throw new Error("Invalid sandbox clone response");
    return value.filter((entry): entry is { path: string; origin: string | null } => !!entry && typeof entry === "object"
      && validCloneDirectory((entry as { path?: unknown }).path) && ((entry as { origin?: unknown }).origin === null || typeof (entry as { origin?: unknown }).origin === "string"))
      .map(entry => ({ path: entry.path, origin: entry.origin }));
  }

  async cloneRestore(path: string, url: string, reference: string | null, authorize: SandboxAuthorize): Promise<void> {
    if (!validCloneDirectory(path) || !/^https:\/\/[\x21-\x7e]{1,2040}$/.test(url) || (reference !== null && !reference.startsWith(`${MIRROR_ROOT}/`)))
      throw new Error("Invalid clone restoration");
    await this.#operation({ kind: "clone-restore", path, url, reference }, false, authorize, true);
  }

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

  async clonePushPrepare(path: string, input: { commit: string; old: string | null; tips: string[] }, authorize: SandboxAuthorize): Promise<ClonePushPreparation> {
    if (!validCloneDirectory(path) || !OID.test(input.commit) || (input.old !== null && !OID.test(input.old))
      || input.tips.length > 1024 || !input.tips.every((tip) => OID.test(tip))) throw new Error("Invalid push request");
    const value = JSON.parse(await this.#operation({ kind: "clone-push-prepare", path, commit: input.commit, old: input.old, tips: [...input.tips] }, true, authorize)) as ClonePushPreparation;
    if (!Array.isArray(value.present) || !value.present.every((tip) => input.tips.includes(tip)) || (value.ancestor !== null && typeof value.ancestor !== "boolean")
      || !Array.isArray(value.commits) || value.commits.some((commit) => !OID.test(commit.source) || typeof commit.subject !== "string")
      || !Number.isSafeInteger(value.total) || value.total < value.commits.length) throw new Error("Invalid push preparation");
    return { present: value.present, ancestor: value.ancestor, commits: value.commits.map(({ source, subject }) => ({ source, subject })), total: value.total };
  }

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

  async close(): Promise<void> {
    this.#closed = true;
    this.#cancelActive?.();
    for (const kill of this.#services) kill();
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
    const gpu = request.kind === "bash" && command.gpu ? gpuMounts(this.#gpuRoot) : undefined;
    const limits = request.kind === "bash" ? command.limits : undefined;
    const browser = request.kind === "bash" ? sandboxBrowserMount(this.#browserSource()) : undefined;
    const service = request.kind === "bash" ? command.service : undefined;
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
      ...(egress ? ["--ro-bind-try", egress, EGRESS_SOCKET, "--ro-bind", join(this.#root, CA_BUNDLE_FILE), CA_BUNDLE] : []),
      ...(egress && this.#shim ? ["--ro-bind-try", join(this.#root, "bin"), SHIM_DIRECTORY] : []),
      ...mirrors.flatMap(({ source, target }) => ["--ro-bind-try", source, target]),
      ...(browser ? ["--ro-bind-try", join(this.#root, "browser", "pikibun-browser"), SANDBOX_BROWSER_DRIVER] : []),
      ...(browser?.mount ? ["--ro-bind-try", browser.mount.source, browser.mount.target] : []),
      ...(service ? ["--ro-bind", join(this.#root, "service", "pikibun-service"), SANDBOX_SERVICE_DRIVER, "--bind", service.socketDirectory, SANDBOX_SERVICE_SOCKETS] : []),
      ...(request.kind === "bash" && this.#nodeMount ? [...this.#nodeMount.binds.flatMap(({ source, target }) => ["--ro-bind-try", source, target]),
        ...this.#nodeMount.links.flatMap(({ path, target }) => ["--symlink", target, path])] : []),
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
    const domain = service ? createHash("sha256").update(`${this.#sessionKey}\0service`).digest("hex") : this.#sessionKey;
    const launch = requireResources
      ? resourceLaunch(this.#resources!, domain, args, deadline / 1000)
      : { command: "/usr/bin/bwrap", args };
    return new Promise<string>((resolveResult, reject) => {
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
      if (!service) this.#cancelActive = cancel;
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
          resolveResult(request.kind === "bash" ? out + err : out);
        }
      });
      const line = JSON.stringify({ ...request, ...(egress ? { egress: { socket: EGRESS_SOCKET, port: EGRESS_PORT } } : {}),
        ...(limits ? { limits: { cpu: limits.cpuSeconds, size: limits.fileBytes, files: limits.openFiles } } : {}) });
      const input = transfer.input;
      if (!input) child.stdin!.end(line);
      else {
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
