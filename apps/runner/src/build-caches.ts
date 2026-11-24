import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, realpath, statfs } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { BUILD_CACHE_NAME, buildCacheEnvAllowed, type BuildCacheScope, type SessionBuildCache, type SessionBuildCaches } from "../../../packages/shared/src/build-caches.js";
import { runBuildCacheJanitor } from "./build-cache-janitor.js";

export const SANDBOX_BUILD_CACHE_ROOT = "/build-caches";
export const BUILD_CACHE_FRESH_MS = 30_000;
export const BUILD_CACHE_STALE_MS = 5 * 60_000;
export const BUILD_CACHE_EVICT_AT = 0.9;
export const BUILD_CACHE_EVICT_TO = 0.8;
const SENDER_ANSWERS = 32;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface BuildCacheMount {
  name: string;
  env: string;
  scope: BuildCacheScope;
  source: string;
  target: string;
  readOnly: boolean;
}

export interface BuildCacheDirectory {
  workspace: string;
  name: string;
  scope: BuildCacheScope;
  owner?: string;
  bytes: number;
  files: number;
  newest: number;
}

export interface BuildCacheUsage { removed: number; bytes: number; truncated: boolean }

export class BuildCacheError extends Error {
  constructor(message: string) { super(message); this.name = "BuildCacheError"; }
}

export function buildCacheMount(value: unknown): value is BuildCacheMount {
  if (!value || typeof value !== "object") return false;
  const mount = value as Partial<BuildCacheMount>;
  return typeof mount.name === "string" && BUILD_CACHE_NAME.test(mount.name) && typeof mount.env === "string" && buildCacheEnvAllowed(mount.env)
    && (mount.scope === "shared" || mount.scope === "owner") && typeof mount.readOnly === "boolean" && typeof mount.source === "string" && isAbsolute(mount.source) && safePath(mount.source)
    && typeof mount.target === "string" && isAbsolute(mount.target) && safePath(mount.target);
}

function safePath(path: string): boolean {
  return path.length <= 4096 && !path.split(/[\\/]/).includes("..") && !/[\x00-\x1f\x7f"\\]/.test(path);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

export function workspaceDirectoryName(workspaceId: string): string {
  return SAFE_ID.test(workspaceId) ? workspaceId : `h-${digest(workspaceId)}`;
}

export function ownerDirectoryName(ownerId: string): string {
  return digest(ownerId);
}

export function sandboxBuildCacheTarget(name: string): string {
  if (!BUILD_CACHE_NAME.test(name)) throw new BuildCacheError("Invalid build cache name");
  return `${SANDBOX_BUILD_CACHE_ROOT}/${name}`;
}

const usage = z.object({ removed: z.number().int().nonnegative(), bytes: z.number().nonnegative(), truncated: z.boolean() });
const listing = z.object({
  caches: z.array(z.object({ workspace: z.string(), name: z.string(), scope: z.enum(["shared", "owner"]), owner: z.string().optional(),
    bytes: z.number().nonnegative(), files: z.number().int().nonnegative(), newest: z.number().nonnegative() })),
  truncated: z.boolean(),
});

export class BuildCacheStore {
  readonly root: string;
  readonly dedicated: boolean;
  readonly #python: string | undefined;

  constructor(root: string, options: { dedicated?: boolean; python?: string } = {}) {
    if (!isAbsolute(root) || resolve(root) === sep || resolve(root) === resolve(root, "..")) throw new BuildCacheError("The build cache root must be an absolute, non-root path");
    this.root = resolve(root);
    this.dedicated = options.dedicated === true;
    this.#python = options.python;
  }

  directory(workspaceId: string, cache: Pick<SessionBuildCache, "name" | "scope">, ownerId: string): string {
    if (!BUILD_CACHE_NAME.test(cache.name)) throw new BuildCacheError("Invalid build cache name");
    const base = join(this.root, workspaceDirectoryName(workspaceId), cache.name);
    return cache.scope === "shared" ? join(base, "shared") : join(base, "owners", ownerDirectoryName(ownerId));
  }

  async #privateRoot(): Promise<void> {
    if (!this.dedicated) await mkdir(this.root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new BuildCacheError("The build cache root must be a directory");
    if (process.getuid && info.uid !== process.getuid()) throw new BuildCacheError("The build cache root must belong to the connector's user");
    if (info.mode & 0o077) await chmod(this.root, 0o700);
  }

  async prepare(workspaceId: string, cache: Pick<SessionBuildCache, "name" | "scope">, ownerId: string): Promise<string> {
    await this.#privateRoot();
    const leaf = this.directory(workspaceId, cache, ownerId);
    let current = this.root;
    for (const part of relative(this.root, leaf).split(sep)) {
      current = join(current, part);
      try { await mkdir(current, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new BuildCacheError("A build cache directory was replaced by something else");
    }
    const real = await realpath(leaf);
    if (!safePath(real)) throw new BuildCacheError("The build cache's path can't be given to a sandbox");
    return real;
  }

  async #janitor(request: Record<string, unknown>): Promise<unknown> {
    await this.#privateRoot();
    return runBuildCacheJanitor({ root: this.root, ...request }, this.#python ? { python: this.#python } : {});
  }

  async list(): Promise<{ caches: BuildCacheDirectory[]; truncated: boolean }> {
    try { await lstat(this.root); } catch { return { caches: [], truncated: false }; }
    return listing.parse(await this.#janitor({ mode: "list" }));
  }

  async prune(olderThanMs: number, now = Date.now()): Promise<BuildCacheUsage> {
    if (!Number.isSafeInteger(olderThanMs) || olderThanMs < 0) throw new BuildCacheError("Invalid prune age");
    try { await lstat(this.root); } catch { return { removed: 0, bytes: 0, truncated: false }; }
    return usage.parse(await this.#janitor({ mode: "prune", olderThan: olderThanMs, now }));
  }

  async capacity(limitBytes: number): Promise<number> {
    if (!this.dedicated) return limitBytes;
    const info = await statfs(this.root);
    return Number(info.blocks) * Number(info.bsize);
  }

  async evict(limitBytes: number): Promise<BuildCacheUsage> {
    if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) throw new BuildCacheError("Invalid build cache size limit");
    try { await lstat(this.root); } catch { return { removed: 0, bytes: 0, truncated: false }; }
    return usage.parse(await this.#janitor({ mode: "evict", capacity: await this.capacity(limitBytes), dedicated: this.dedicated,
      evictAt: BUILD_CACHE_EVICT_AT, evictTo: BUILD_CACHE_EVICT_TO }));
  }
}

export interface SessionBuildCacheOptions {
  fetch: (sender: string | null) => Promise<SessionBuildCaches>;
  store: BuildCacheStore;
  workspaceId: string;
  ownerId: string;
  target: (name: string, source: string) => string;
  now?: () => number;
}

export class SessionBuildCacheMounts {
  readonly #options: SessionBuildCacheOptions;
  readonly #answers = new Map<string | null, { caches: SessionBuildCache[]; at: number }>();
  readonly #pending = new Map<string | null, Promise<SessionBuildCache[]>>();

  constructor(options: SessionBuildCacheOptions) {
    this.#options = options;
  }

  #keep(sender: string | null, caches: SessionBuildCache[], at: number): void {
    this.#answers.delete(sender);
    this.#answers.set(sender, { caches, at });
    for (const [key, answer] of this.#answers) {
      if (this.#answers.size <= SENDER_ANSWERS && at - answer.at < BUILD_CACHE_STALE_MS) break;
      this.#answers.delete(key);
    }
  }

  async #caches(sender: string | null): Promise<SessionBuildCache[]> {
    const now = (this.#options.now ?? Date.now)();
    const known = this.#answers.get(sender);
    if (known && now - known.at < BUILD_CACHE_FRESH_MS) return known.caches;
    let pending = this.#pending.get(sender);
    if (!pending) {
      pending = this.#options.fetch(sender).then(answer => {
        this.#keep(sender, answer.caches, (this.#options.now ?? Date.now)());
        return answer.caches;
      }).finally(() => { this.#pending.delete(sender); });
      this.#pending.set(sender, pending);
    }
    try { return await pending; }
    catch {
      const last = this.#answers.get(sender);
      if (last && now - last.at < BUILD_CACHE_STALE_MS) return last.caches;
      this.#answers.delete(sender);
      return [];
    }
  }

  async mounts(sender: string | null): Promise<BuildCacheMount[]> {
    const mounts: BuildCacheMount[] = [];
    for (const cache of await this.#caches(sender)) {
      try {
        const source = await this.#options.store.prepare(this.#options.workspaceId, cache, this.#options.ownerId);
        const mount = { name: cache.name, env: cache.env, scope: cache.scope, source, target: this.#options.target(cache.name, source),
          readOnly: sender === null || cache.access !== "write" };
        if (buildCacheMount(mount)) mounts.push(mount);
      } catch { continue; }
    }
    return mounts;
  }
}
