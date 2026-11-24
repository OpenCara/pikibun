import type { GroupTool } from "./tool-groups.js";
import type { WorkspaceRole } from "./types.js";

export const buildCacheModes = ["off", "workspace", "owner"] as const;
export type BuildCacheMode = (typeof buildCacheModes)[number];

export const buildCacheScopes = ["shared", "owner"] as const;
export type BuildCacheScope = (typeof buildCacheScopes)[number];

export const buildCacheAccesses = ["write", "read"] as const;
export type BuildCacheAccess = (typeof buildCacheAccesses)[number];

export const buildCacheLimits = Object.freeze({
  caches: 16,
  writerGroups: 16,
  gib: Object.freeze({ min: 1, max: 10_000, default: 20 }),
});

export const BUILD_CACHE_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const BUILD_CACHE_ENV = /^[A-Z_][A-Z0-9_]{0,63}$/;
const RESERVED_ENV = /^(PATH|HOME|USER|LOGNAME|SHELL|PWD|OLDPWD|TMPDIR|TMP|TEMP|TERM|LANG|LANGUAGE|LC_.*|TZ|LD_.*|DYLD_.*|PYTHON.*|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|NPM_CONFIG_.*|GIT_.*|SSH_.*|SSL_.*|CURL_CA_BUNDLE|REQUESTS_CA_BUNDLE|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|PIKIBUN.*|SANDBOX_.*|SDKROOT|CLANG_MODULE_CACHE_PATH|XDG_.*|BASH_ENV|ENV|IFS|PS[0-9]|PROMPT_COMMAND)$/;

export interface BuildCache {
  name: string;
  env: string;
  writerGroups: string[];
}

export interface StoredBuildCache extends BuildCache {
  createdAt: string;
  updatedAt: string;
}

export interface SessionBuildCache {
  name: string;
  env: string;
  scope: BuildCacheScope;
  access: BuildCacheAccess;
}

export interface SessionBuildCaches {
  caches: SessionBuildCache[];
}

export function buildCacheEnvAllowed(name: string): boolean {
  return BUILD_CACHE_ENV.test(name) && !RESERVED_ENV.test(name);
}

export function parseBuildCacheName(value: unknown): string {
  if (typeof value !== "string" || !BUILD_CACHE_NAME.test(value)) {
    throw new Error("A build cache's name is 1 to 40 lowercase letters, digits and hyphens, starting with a letter or digit.");
  }
  return value;
}

export function parseBuildCache(name: unknown, value: unknown): BuildCache {
  const cacheName = parseBuildCacheName(name);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid build cache.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== "env" && key !== "writerGroups")) throw new Error("A build cache takes env and writerGroups.");
  const env = input.env;
  if (typeof env !== "string" || !BUILD_CACHE_ENV.test(env)) {
    throw new Error("A build cache's variable is 1 to 64 uppercase letters, digits and underscores, not starting with a digit.");
  }
  if (RESERVED_ENV.test(env)) throw new Error(`${env} is a variable the sandbox or the tools set themselves; name another.`);
  const groups = input.writerGroups ?? [];
  if (!Array.isArray(groups) || groups.length > buildCacheLimits.writerGroups
    || groups.some(group => typeof group !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(group))) {
    throw new Error(`writerGroups is a list of at most ${buildCacheLimits.writerGroups} tool group ids.`);
  }
  return { name: cacheName, env, writerGroups: [...new Set(groups as string[])].sort() };
}

export interface BuildCacheWriter {
  role: WorkspaceRole | null;
  tools: readonly GroupTool[];
  groupId: string | null;
  personal: boolean;
  workspaceOwner: boolean;
}

export function buildCacheScope(owner: BuildCacheWriter, cache: Pick<BuildCache, "writerGroups">, mode: BuildCacheMode = "workspace"): BuildCacheScope {
  if (mode === "owner") return "owner";
  if (owner.personal) return "shared";
  if (owner.role !== "owner" && owner.role !== "admin" && owner.role !== "collaborator") return "owner";
  if (!owner.tools.includes("write")) return "owner";
  if (!cache.writerGroups.length) return "shared";
  if (owner.workspaceOwner) return "shared";
  return owner.groupId !== null && cache.writerGroups.includes(owner.groupId) ? "shared" : "owner";
}

export interface BuildCacheSender extends BuildCacheWriter {
  owns: boolean;
}

export function buildCacheWrites(sender: BuildCacheSender, cache: Pick<BuildCache, "writerGroups">, scope: BuildCacheScope): boolean {
  if (sender.role === null) return false;
  if (scope === "shared") return buildCacheScope(sender, cache, "workspace") === "shared";
  if (sender.owns) return true;
  return (sender.role === "owner" || sender.role === "admin" || sender.role === "collaborator") && sender.tools.includes("write");
}

export type BuildCacheSenders =
  | { kind: "message"; sender: BuildCacheSender; granted: readonly BuildCacheSender[] }
  | { kind: "none" }
  | { kind: "unknown"; possible: readonly BuildCacheSender[] };

export function sessionBuildCaches(owner: BuildCacheWriter, caches: readonly BuildCache[], mode: BuildCacheMode, senders: BuildCacheSenders): SessionBuildCaches {
  if (mode === "off" || owner.role === null) return { caches: [] };
  const answer: SessionBuildCache[] = [];
  for (const cache of caches) {
    const scope = buildCacheScope(owner, cache, mode);
    const writes = (people: readonly BuildCacheSender[]) => people.every(person => buildCacheWrites(person, cache, scope));
    if (senders.kind === "unknown") {
      if (writes(senders.possible)) answer.push({ name: cache.name, env: cache.env, scope, access: "write" });
      continue;
    }
    const access = senders.kind === "message" && writes([senders.sender, ...senders.granted]) ? "write" : "read";
    answer.push({ name: cache.name, env: cache.env, scope, access });
  }
  return { caches: answer };
}

export function parseSessionBuildCaches(value: unknown): SessionBuildCaches {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid build caches");
  const caches = (value as { caches?: unknown }).caches;
  if (!Array.isArray(caches) || caches.length > buildCacheLimits.caches) throw new Error("Invalid build caches");
  const names = new Set<string>();
  const envs = new Set<string>();
  return {
    caches: caches.map(item => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid build caches");
      const { name, env, scope, access } = item as Record<string, unknown>;
      if (typeof name !== "string" || !BUILD_CACHE_NAME.test(name) || typeof env !== "string" || !buildCacheEnvAllowed(env)
        || !(buildCacheScopes as readonly unknown[]).includes(scope) || names.has(name) || envs.has(env)) throw new Error("Invalid build caches");
      names.add(name);
      envs.add(env);
      return { name, env, scope: scope as BuildCacheScope, access: access === "write" ? "write" : "read" };
    }),
  };
}
