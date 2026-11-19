import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, rm, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isExtensionIntegrity, parseExtensionSourceSpec, type InstalledExtension } from "../../../../packages/shared/src/host-extensions.js";
import type { RunnerBinding } from "../../../../packages/shared/src/types.js";
import type { EgressOptions } from "../egress.js";
import { EgressProxy, egressEnvironment, egressSocketPath } from "../egress.js";
import { HelperWorkspace, type HelperBackend } from "../helper-workspace.js";
import { Sandbox, serviceBindAllowed } from "../sandbox.js";
import { createFilled } from "../identity.js";
import type { Describe } from "./describe.js";
import { describedModules, installMount, packageEntries, type LoadedSource, type LoadOptions } from "./load.js";
import { ExtensionSourceError } from "./store.js";

export const CACHE_KEY = /^[0-9a-f]{32}$/;
export const CACHE_PACKAGES_LIMIT = 128;
export const CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const CACHE_LOCK_STALE_MS = 5 * 60 * 1000;
export const CACHE_INSTALL_TIMEOUT_SECONDS = 60;
const CACHE_TREE_ENTRIES_LIMIT = 10_000;
const CACHE_TREE_BYTES_LIMIT = 128 * 1024 * 1024;
const INSTALL_SESSION = "extension-install";

export const refusingDescribe: Describe = async () => {
  throw new Error("Auto-cached extensions are described only inside the host's sandbox");
};

export function extensionCacheKey(source: string, integrity: string): string {
  return createHash("sha256").update(`${source}\0${integrity}`).digest("hex").slice(0, 32);
}

export function defaultExtensionCacheDir(stateDir: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const configured = env.PIKIBUN_CACHE_DIR?.trim();
  const base = configured ? resolve(configured)
    : platform === "darwin" ? join(homedir(), "Library", "Caches")
    : platform === "win32" ? (env.LOCALAPPDATA ? resolve(env.LOCALAPPDATA) : join(homedir(), "AppData", "Local"))
    : (env.XDG_CACHE_HOME ? resolve(env.XDG_CACHE_HOME) : join(homedir(), ".cache"));
  const candidate = join(base, "pikibun", "extensions");
  const sessionProbe = join(resolve(stateDir), "runner", "probe");
  return serviceBindAllowed(candidate, sessionProbe) ? candidate : join(resolve(stateDir), "extensions", "cache");
}

export interface ExtensionCacheInstallRequest {
  package: string;
  version: string;
  stageDir: string;
  signal?: AbortSignal;
}

export type ExtensionCacheInstaller = (request: ExtensionCacheInstallRequest) => Promise<void>;

export interface ExtensionCacheOptions {
  fallbackDirectory?: string;
  sandboxed: boolean;
  install?: ExtensionCacheInstaller;
  describe?: Describe;
  connectorVersion?: string;
  now?: () => number;
}

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const escapes = (rel: string) => rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel);

function installBinding(): RunnerBinding {
  const owner = "pikibun:host";
  return {
    session: { id: INSTALL_SESSION, ownerId: owner },
    owner: { id: owner, githubLogin: null, gitName: "Pikibun", gitEmail: "pikibun@localhost", env: {} },
    model: { provider: "faux" },
  } as unknown as RunnerBinding;
}

export function registryOnlyProxy(socketPath: string, token?: string, extra: Pick<EgressOptions, "lookup" | "connect"> = {}): EgressProxy {
  return new EgressProxy({
    socketPath,
    ...(token ? { tcp: { token } } : {}),
    grant: async () => ({
      policy: { mode: "allowlist", domains: ["registry.npmjs.org"], packageRegistries: false },
      repositories: [],
    }),
    relay: async () => { throw new Error("Git relay is not offered in the extension installer"); },
    ...extra,
  });
}

export function installShellCommand(nodeBin: string, subdir: string, spec: string): string {
  return `PATH=${quote(nodeBin)}:"\${PATH:-/usr/bin:/bin}" && export PATH && cd -- ${quote(`./${subdir}`)} && `
    + "exec env npm_config_userconfig=/dev/null NPM_CONFIG_USERCONFIG=/dev/null npm_config_globalconfig=/dev/null NPM_CONFIG_GLOBALCONFIG=/dev/null "
    + "npm_config_allow_git=none NPM_CONFIG_ALLOW_GIT=none NPM_TOKEN='' NODE_AUTH_TOKEN='' "
    + `npm install --save-exact --no-audit --no-fund --legacy-peer-deps --ignore-scripts --registry=https://registry.npmjs.org ${quote(spec)} </dev/null 2>&1`;
}

async function copySafeTree(fromRoot: string, toRoot: string): Promise<void> {
  const sourceBase = await realpath(fromRoot);
  await mkdir(toRoot, { recursive: true, mode: 0o700 });
  const pending: { from: string; to: string }[] = [{ from: sourceBase, to: toRoot }];
  const symlinks: { linkPath: string; target: string }[] = [];
  let entries = 0;
  let bytes = 0;
  while (pending.length) {
    const current = pending.pop()!;
    const names = await readdir(current.from);
    for (const name of names) {
      entries++;
      if (entries > CACHE_TREE_ENTRIES_LIMIT) throw new ExtensionSourceError(`Installed package has more than ${CACHE_TREE_ENTRIES_LIMIT} entries`);
      const fromPath = join(current.from, name);
      const toPath = join(current.to, name);
      const info = await lstat(fromPath);
      if (info.isDirectory()) {
        await mkdir(toPath, { recursive: true, mode: 0o700 });
        pending.push({ from: fromPath, to: toPath });
      } else if (info.isFile()) {
        if (info.nlink > 1) throw new ExtensionSourceError(`Refused hard-linked file in installed package: ${name}`);
        bytes += info.size;
        if (bytes > CACHE_TREE_BYTES_LIMIT) throw new ExtensionSourceError("Installed package exceeds size limit");
        await copyFile(fromPath, toPath, constants.COPYFILE_EXCL);
      } else if (info.isSymbolicLink()) {
        const rawTarget = await readlink(fromPath);
        if (isAbsolute(rawTarget)) throw new ExtensionSourceError(`Refused absolute symbolic link in installed package: ${name}`);
        const resolved = await realpath(fromPath).catch(() => "");
        const rel = resolved ? relative(sourceBase, resolved) : "..";
        if (!resolved || escapes(rel)) {
          throw new ExtensionSourceError(`Refused symbolic link escaping installed package: ${name}`);
        }
        symlinks.push({ linkPath: toPath, target: rawTarget });
      } else {
        throw new ExtensionSourceError(`Refused special file in installed package: ${name}`);
      }
    }
  }
  for (const item of symlinks) {
    await mkdir(dirname(item.linkPath), { recursive: true, mode: 0o700 });
    await symlink(item.target, item.linkPath);
  }
}

function serialized<T extends (...args: never[]) => Promise<unknown>>(fn: T): T {
  let queue: Promise<unknown> = Promise.resolve();
  return ((...args: Parameters<T>) => {
    const next = queue.then(() => fn(...args));
    queue = next.catch(() => {});
    return next;
  }) as T;
}

export function sandboxExtensionInstaller(stateDirectory: string): ExtensionCacheInstaller {
  return serialized(async request => {
    const root = join(stateDirectory, INSTALL_SESSION);
    await rm(root, { recursive: true, force: true }).catch(() => {});
    await mkdir(root, { recursive: true, mode: 0o700 });
    const proxy = registryOnlyProxy(egressSocketPath(INSTALL_SESSION, stateDirectory));
    const sandbox = new Sandbox(installBinding(), join(root, "sandbox"), undefined, { egressSocket: proxy.socketPath, browser: null });
    try {
      await proxy.start();
      await sandbox.initialize();
      const nodeBin = sandbox.nodeBin;
      if (!nodeBin) throw new ExtensionSourceError("This host's Node.js can't be given to the sandbox, so extensions can't be auto-cached");
      const subdir = "pkg";
      const workDir = join(sandbox.hostWorktree, subdir);
      await mkdir(workDir, { recursive: true, mode: 0o700 });
      await writeFile(join(workDir, "package.json"), `${JSON.stringify({ name: "pikibun-cached-extension", private: true, dependencies: {} }, null, 2)}\n`, { mode: 0o600 });
      const signal = request.signal
        ? AbortSignal.any([request.signal, AbortSignal.timeout(CACHE_INSTALL_TIMEOUT_SECONDS * 1000)])
        : AbortSignal.timeout(CACHE_INSTALL_TIMEOUT_SECONDS * 1000);
      await sandbox.execute({ kind: "bash", command: installShellCommand(nodeBin, subdir, `${request.package}@${request.version}`) }, false, async () => {},
        { allowTestShell: true, unbounded: true, signal });
      await copySafeTree(workDir, request.stageDir);
    } finally {
      await sandbox.close().catch(() => {});
      await proxy.close().catch(() => {});
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });
}

export function helperExtensionInstaller(stateDirectory: string, createBackend: () => HelperBackend): ExtensionCacheInstaller {
  return serialized(async request => {
    const root = join(stateDirectory, INSTALL_SESSION);
    await rm(root, { recursive: true, force: true }).catch(() => {});
    await mkdir(root, { recursive: true, mode: 0o700 });
    const token = randomBytes(24).toString("base64url");
    const proxy = registryOnlyProxy(egressSocketPath(INSTALL_SESSION, stateDirectory), token);
    let workspace: HelperWorkspace | undefined;
    workspace = new HelperWorkspace(installBinding(), join(root, "sandbox"), createBackend(), {
      egressEnvironment: () => {
        const endpoint = proxy.endpoint;
        return endpoint && workspace ? egressEnvironment(undefined, endpoint, workspace.layout.caBundle) : undefined;
      },
    });
    try {
      await proxy.start();
      await workspace.initialize();
      const nodeBin = workspace.nodeBin;
      if (!nodeBin) throw new ExtensionSourceError("This host's Node.js can't be given to the sandbox, so extensions can't be auto-cached");
      const subdir = "pkg";
      const workDir = join(workspace.hostWorktree, subdir);
      await mkdir(workDir, { recursive: true, mode: 0o700 });
      await writeFile(join(workDir, "package.json"), `${JSON.stringify({ name: "pikibun-cached-extension", private: true, dependencies: {} }, null, 2)}\n`, { mode: 0o600 });
      const signal = request.signal
        ? AbortSignal.any([request.signal, AbortSignal.timeout(CACHE_INSTALL_TIMEOUT_SECONDS * 1000)])
        : AbortSignal.timeout(CACHE_INSTALL_TIMEOUT_SECONDS * 1000);
      await workspace.execute({ kind: "bash", command: installShellCommand(nodeBin, subdir, `${request.package}@${request.version}`) }, false, async () => {},
        { allowTestShell: true, unbounded: true, signal });
      await copySafeTree(workDir, request.stageDir);
    } finally {
      await workspace.close().catch(() => {});
      await proxy.close().catch(() => {});
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });
}

export async function verifyCachedNpmTree(stageDir: string, pkg: string, version: string, integrity: string): Promise<void> {
  const base = await realpath(stageDir);
  const pending = [base];
  let entries = 0;
  while (pending.length) {
    const dir = pending.pop()!;
    for (const name of await readdir(dir)) {
      entries++;
      if (entries > CACHE_TREE_ENTRIES_LIMIT) throw new ExtensionSourceError(`Cached package has more than ${CACHE_TREE_ENTRIES_LIMIT} entries`);
      const full = join(dir, name);
      const info = await lstat(full);
      if (info.isDirectory()) pending.push(full);
      else if (info.isFile()) {
        if (info.nlink > 1) throw new ExtensionSourceError(`Refused hard-linked file in cached package: ${name}`);
      } else if (info.isSymbolicLink()) {
        const resolved = await realpath(full).catch(() => "");
        const rel = resolved ? relative(base, resolved) : "..";
        if (!resolved || escapes(rel)) throw new ExtensionSourceError(`Refused symbolic link escaping cached package: ${name}`);
      } else {
        throw new ExtensionSourceError(`Refused special file in cached package: ${name}`);
      }
    }
  }
  const manifest = JSON.parse(await readFile(join(stageDir, "package.json"), "utf8")) as { dependencies?: Record<string, unknown> };
  const deps = Object.keys(manifest.dependencies ?? {});
  if (deps.length !== 1 || deps[0] !== pkg) throw new ExtensionSourceError(`npm installed ${deps.join(", ") || "nothing"}, not ${pkg}@${version}`);
  let lock: { packages?: Record<string, { version?: unknown; resolved?: unknown; integrity?: unknown; link?: unknown }> };
  try { lock = JSON.parse(await readFile(join(stageDir, "package-lock.json"), "utf8")); }
  catch { throw new ExtensionSourceError(`npm wrote no package-lock.json for ${pkg}@${version}, so its digest can't be checked`); }
  const lockPackages = lock.packages && typeof lock.packages === "object" ? Object.entries(lock.packages).filter(([path]) => path !== "") : [];
  if (!lockPackages.length) throw new ExtensionSourceError(`npm's lock file lists no packages for ${pkg}@${version}`);
  for (const [path, entry] of lockPackages) {
    if (!entry || entry.link) throw new ExtensionSourceError(`npm's lock file holds a link at ${path}`);
    if (typeof entry.resolved !== "string" || !entry.resolved.startsWith("https://registry.npmjs.org/")) {
      throw new ExtensionSourceError(`npm resolved ${path} from ${String(entry.resolved ?? "an unknown source")}, outside https://registry.npmjs.org/`);
    }
    if (typeof entry.integrity !== "string" || !entry.integrity.startsWith("sha512-")) {
      throw new ExtensionSourceError(`npm's lock file has no sha512 digest for ${path}`);
    }
  }
  const rootEntry = lock.packages?.[`node_modules/${pkg}`];
  if (!rootEntry) throw new ExtensionSourceError(`npm's lock file doesn't name ${pkg}`);
  if (rootEntry.version !== version) throw new ExtensionSourceError(`npm installed ${pkg}@${String(rootEntry.version)}, not ${version}`);
  if (rootEntry.integrity !== integrity) throw new ExtensionSourceError(`${pkg}@${version}'s digest isn't the one the workspace locked`);
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(resolvePromise, ms);
    timer.unref();
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason ?? new Error("Aborted")); }, { once: true });
  });
}

export class ExtensionCache {
  #root: string | undefined;

  constructor(readonly preferredDirectory: string, readonly options: ExtensionCacheOptions) {}

  get sandboxed(): boolean { return this.options.sandboxed; }

  private get loading(): LoadOptions {
    return {
      describe: this.options.describe ?? refusingDescribe,
      ...(this.options.connectorVersion !== undefined ? { version: this.options.connectorVersion } : {}),
    };
  }

  private async packagesDir(): Promise<string> {
    if (this.#root) return join(this.#root, "packages");
    try {
      const dir = join(this.preferredDirectory, "packages");
      await mkdir(dir, { recursive: true, mode: 0o700 });
      this.#root = this.preferredDirectory;
      return dir;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!this.options.fallbackDirectory || (code !== "EACCES" && code !== "EROFS" && code !== "EPERM")) throw error;
      const fallback = join(this.options.fallbackDirectory, "packages");
      await mkdir(fallback, { recursive: true, mode: 0o700 });
      this.#root = this.options.fallbackDirectory;
      return fallback;
    }
  }

  private async markUsed(projectDir: string): Promise<void> {
    const marker = join(projectDir, "used");
    const at = new Date((this.options.now ?? Date.now)());
    await writeFile(marker, "", { mode: 0o600 }).catch(() => {});
    await utimes(marker, at, at).catch(() => {});
  }

  private async loadExisting(projectDir: string, source: string, pkg: string, version: string, integrity: string): Promise<LoadedSource | undefined> {
    const root = join(projectDir, "node_modules", ...pkg.split("/"));
    try { await stat(root); }
    catch { return undefined; }
    const lock = JSON.parse(await readFile(join(projectDir, "package-lock.json"), "utf8")) as {
      packages?: Record<string, { version?: unknown; integrity?: unknown }>;
    };
    const lockRoot = lock.packages?.[`node_modules/${pkg}`];
    if (!lockRoot || lockRoot.version !== version || lockRoot.integrity !== integrity) {
      throw new ExtensionSourceError(`${pkg}@${version} in cache doesn't match its locked integrity`);
    }
    const entries = await packageEntries(root, true);
    if (entries.name !== pkg || entries.version !== version || !entries.files.length) {
      throw new ExtensionSourceError(`${pkg}@${version} in cache is invalid`);
    }
    const mount = installMount(root);
    const modules = await describedModules(this.loading, mount, root, entries.files, mount);
    const failed = modules.find(module => module.error)?.error;
    if (failed) throw new ExtensionSourceError(failed);
    await this.markUsed(projectDir);
    const summary: InstalledExtension = {
      source,
      dev: false,
      name: entries.name,
      version: entries.version,
      ...(entries.description ? { description: entries.description } : {}),
      modules,
    };
    return { installed: { source, package: pkg }, root, files: entries.files, mount, summary };
  }

  private async withKeyLock<T>(packagesDir: string, key: string, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    const lockPath = join(packagesDir, `${key}.lock`);
    const token = randomUUID();
    const now = this.options.now ?? Date.now;
    const deadline = now() + CACHE_INSTALL_TIMEOUT_SECONDS * 1000;
    const writeLock = async (): Promise<boolean> => {
      const payload = `${process.pid} ${token} ${now()}\n`;
      try { return await createFilled(lockPath, payload); }
      catch {
        try {
          const handle = await open(lockPath, "wx", 0o600);
          try { await handle.writeFile(payload); }
          finally { await handle.close(); }
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
          throw error;
        }
      }
    };
    for (;;) {
      signal?.throwIfAborted();
      if (await writeLock()) break;
      const content = await readFile(lockPath, "utf8").catch(() => undefined);
      const parts = content?.trim().split(" ");
      const heldAt = parts?.[2] ? Number.parseInt(parts[2], 10) : NaN;
      const info = Number.isSafeInteger(heldAt) ? undefined : await stat(lockPath).catch(() => undefined);
      const age = Number.isSafeInteger(heldAt) ? now() - heldAt : info ? now() - info.mtimeMs : 0;
      if (age > CACHE_LOCK_STALE_MS && content !== undefined) {
        if (await readFile(lockPath, "utf8").catch(() => "") === content) await unlink(lockPath).catch(() => {});
        continue;
      }
      if (now() >= deadline) throw new ExtensionSourceError("Timed out waiting for another extension cache install");
      await sleep(50, signal);
    }
    try { return await work(); }
    finally {
      const current = await readFile(lockPath, "utf8").catch(() => "");
      if (current.includes(` ${token} `)) await unlink(lockPath).catch(() => {});
    }
  }

  async getIfCached(source: string, integrity: string): Promise<LoadedSource | undefined> {
    if (!this.options.sandboxed || !isExtensionIntegrity(integrity)) return undefined;
    const spec = parseExtensionSourceSpec(source);
    if (spec.kind !== "npm") return undefined;
    const key = extensionCacheKey(source, integrity);
    const packagesDir = await this.packagesDir().catch(() => undefined);
    if (!packagesDir) return undefined;
    try { return await this.loadExisting(join(packagesDir, key), source, spec.package, spec.version, integrity); }
    catch { return undefined; }
  }

  async ensure(source: string, integrity: string, signal?: AbortSignal): Promise<LoadedSource> {
    if (!this.options.sandboxed) throw new ExtensionSourceError("Extension auto-caching runs only on sandboxed hosts");
    if (!isExtensionIntegrity(integrity)) throw new ExtensionSourceError(`Missing sha512 integrity lock for ${source}`);
    const spec = parseExtensionSourceSpec(source);
    if (spec.kind !== "npm") throw new ExtensionSourceError(`Only npm: extensions are auto-cached (${source})`);
    const key = extensionCacheKey(source, integrity);
    const packagesDir = await this.packagesDir();
    const projectDir = join(packagesDir, key);
    const hit = await this.loadExisting(projectDir, source, spec.package, spec.version, integrity).catch(async () => {
      await rm(projectDir, { recursive: true, force: true }).catch(() => {});
      return undefined;
    });
    if (hit) return hit;
    return this.withKeyLock(packagesDir, key, signal, async () => {
      const raced = await this.loadExisting(projectDir, source, spec.package, spec.version, integrity).catch(() => undefined);
      if (raced) return raced;
      if (!this.options.install) throw new ExtensionSourceError("No sandboxed extension installer is configured on this host");
      const stageDir = join(packagesDir, `${key}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
      await rm(stageDir, { recursive: true, force: true }).catch(() => {});
      try {
        await mkdir(stageDir, { recursive: true, mode: 0o700 });
        await writeFile(join(stageDir, "package.json"), `${JSON.stringify({ name: "pikibun-cached-extension", private: true, dependencies: {} }, null, 2)}\n`, { mode: 0o600 });
        await this.options.install({ package: spec.package, version: spec.version, stageDir, ...(signal ? { signal } : {}) });
        await verifyCachedNpmTree(stageDir, spec.package, spec.version, integrity);
        const stagedRoot = join(stageDir, "node_modules", ...spec.package.split("/"));
        const stagedEntries = await packageEntries(stagedRoot, true);
        if (!stagedEntries.files.length) throw new ExtensionSourceError(`${spec.package}@${spec.version} has no extension modules`);
        const stagedMount = installMount(stagedRoot);
        const modules = await describedModules(this.loading, stagedMount, stagedRoot, stagedEntries.files, stagedMount);
        const failed = modules.find(module => module.error)?.error;
        if (failed) throw new ExtensionSourceError(`${spec.package}@${spec.version} didn't load: ${failed}`);
        await rm(projectDir, { recursive: true, force: true }).catch(() => {});
        await rename(stageDir, projectDir);
        await this.markUsed(projectDir);
        const root = join(projectDir, "node_modules", ...spec.package.split("/"));
        const mount = installMount(root);
        return {
          installed: { source, package: spec.package },
          root,
          files: stagedEntries.files.map(file => join(root, relative(stagedRoot, file))),
          mount,
          summary: {
            source,
            dev: false,
            name: stagedEntries.name ?? spec.package,
            version: stagedEntries.version ?? spec.version,
            ...(stagedEntries.description ? { description: stagedEntries.description } : {}),
            modules,
          },
        };
      } catch (error) {
        await rm(stageDir, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
    });
  }

  async prune(keepKeys: ReadonlySet<string>): Promise<string[]> {
    const packagesDir = await this.packagesDir().catch(() => undefined);
    if (!packagesDir) return [];
    const now = (this.options.now ?? Date.now)();
    let names: string[];
    try { names = await readdir(packagesDir); }
    catch { return []; }
    const candidates: { key: string; usedAt: number }[] = [];
    const removed: string[] = [];
    for (const name of names) {
      const full = join(packagesDir, name);
      if (name.includes(".tmp-")) {
        const info = await stat(full).catch(() => undefined);
        if (info && now - info.mtimeMs > CACHE_LOCK_STALE_MS) await rm(full, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      if (!CACHE_KEY.test(name)) continue;
      const usedInfo = await stat(join(full, "used")).catch(() => stat(full).catch(() => undefined));
      const usedAt = usedInfo?.mtimeMs ?? 0;
      if (!keepKeys.has(name) && now - usedAt > CACHE_MAX_AGE_MS) {
        await rm(full, { recursive: true, force: true }).catch(() => {});
        removed.push(name);
        continue;
      }
      candidates.push({ key: name, usedAt });
    }
    if (candidates.length > CACHE_PACKAGES_LIMIT) {
      const evictable = candidates.filter(item => !keepKeys.has(item.key)).sort((a, b) => a.usedAt - b.usedAt);
      let excess = candidates.length - CACHE_PACKAGES_LIMIT;
      for (const item of evictable) {
        if (excess <= 0) break;
        await rm(join(packagesDir, item.key), { recursive: true, force: true }).catch(() => {});
        removed.push(item.key);
        excess--;
      }
    }
    return removed;
  }
}
