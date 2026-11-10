import { validGitHost, type GitProvider } from "./repositories.js";
import type { GrantSource } from "./sources.js";

export const networkModes = ["off", "allowlist", "open"] as const;
export type NetworkMode = (typeof networkModes)[number];
export interface NetworkPolicy { mode: NetworkMode; domains: string[]; packageRegistries: boolean }

export const defaultNetworkPolicy: NetworkPolicy = Object.freeze({ mode: "off", domains: [], packageRegistries: true }) as NetworkPolicy;
export const networkLimits = { domains: 100 } as const;

export const packageRegistryDomains: readonly string[] = Object.freeze([
  "registry.npmjs.org", "registry.yarnpkg.com", "jsr.io", "npm.jsr.io",
  "pypi.org", "files.pythonhosted.org",
  "crates.io", "index.crates.io", "static.crates.io",
  "proxy.golang.org", "sum.golang.org",
  "rubygems.org", "index.rubygems.org",
  "repo.maven.apache.org", "repo1.maven.org", "plugins.gradle.org",
  "api.nuget.org", "repo.packagist.org",
]);

export function validNetworkDomain(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const name = value.startsWith("*.") ? value.slice(2) : value;
  return !name.includes(":") && validGitHost(name);
}

export function parseNetworkPolicy(value: unknown): NetworkPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid network policy");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["mode", "domains", "packageRegistries", "webSearch"].includes(key))) throw new Error("Invalid network policy");
  if (!networkModes.includes(input.mode as NetworkMode)) throw new Error("Invalid network mode");
  if (typeof input.packageRegistries !== "boolean") throw new Error("Invalid package registry setting");
  const domains = input.domains ?? [];
  if (!Array.isArray(domains) || domains.length > networkLimits.domains) throw new Error(`At most ${networkLimits.domains} domains are allowed`);
  const invalid = domains.find(domain => !validNetworkDomain(domain));
  if (invalid !== undefined) throw new Error(`Invalid domain: ${String(invalid).slice(0, 100)}`);
  return { mode: input.mode as NetworkMode, domains: [...new Set(domains as string[])], packageRegistries: input.packageRegistries };
}

export function egressGrantPolicy(policy: NetworkPolicy): NetworkPolicy {
  return { mode: policy.mode, domains: [...policy.domains], packageRegistries: policy.packageRegistries };
}

function matches(pattern: string, host: string): boolean {
  return pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) : host === pattern;
}

export function hostAllowed(policy: NetworkPolicy, host: string): boolean {
  switch (policy.mode) {
    case "off": return false;
    case "open": return true;
    case "allowlist":
      return policy.domains.some(pattern => matches(pattern, host)) || (policy.packageRegistries && packageRegistryDomains.includes(host));
  }
}

export interface EgressRepository {
  bindingId: string; provider: GitProvider; host: string; fullName: string;
  repositoryId?: string;
  lfs?: boolean;
}
export interface EgressGrant {
  policy: NetworkPolicy;
  repositories: EgressRepository[];
  apis?: EgressApi[];
  sources?: GrantSource[];
}

export const credentialedApiHosts: readonly string[] = Object.freeze(["api.github.com", "gitlab.com", "dev.azure.com"]);
export type CredentialedApiProvider = "github" | "gitlab" | "azure-devops";
export const credentialedApiProviders: Readonly<Record<string, CredentialedApiProvider>> = Object.freeze({
  "api.github.com": "github", "gitlab.com": "gitlab", "dev.azure.com": "azure-devops",
});
export interface EgressApi { host: string; provider: CredentialedApiProvider }
export const API_TOKEN_PLACEHOLDER = "pikibun-egress-proxy-adds-the-credential";
export type ApiAccessKind = "read" | "write";
export function apiWriteToken(lease: string): string { return `${API_TOKEN_PLACEHOLDER}.write.${lease}`; }
export function apiWriteLease(token: string): string | undefined {
  return WRITE_LEASE.exec(token)?.[1];
}
const WRITE_LEASE = new RegExp(`${API_TOKEN_PLACEHOLDER}\\.write\\.([A-Za-z0-9_-]{32,64})`);
export const API_CREDENTIAL_CACHE_SECONDS = 60;
export type ApiCredentialGrant =
  | { available: false; reason: string; cacheSeconds: number }
  | { available: true; credentials: ApiCredential[]; cacheSeconds: number };
export interface ApiCredential {
  account: string;
  authorization: string;
  repositories: string[];
  expiresAt: string;
}
export const egressGitServices = ["info-refs", "upload-pack", "receive-refs", "receive-pack", "lfs-batch", "lfs-object"] as const;
export type EgressGitService = (typeof egressGitServices)[number];
export const egressReadServices: readonly EgressGitService[] = ["info-refs", "upload-pack"];
export function egressPushService(service: EgressGitService): service is "receive-refs" | "receive-pack" {
  return service === "receive-refs" || service === "receive-pack";
}
export function egressLfsService(service: EgressGitService): service is "lfs-batch" | "lfs-object" {
  return service === "lfs-batch" || service === "lfs-object";
}

export type GitDirectAccess = "read" | "lfs" | "push";
export function gitDirectAccess(service: EgressGitService): GitDirectAccess {
  return egressPushService(service) ? "push" : egressLfsService(service) ? "lfs" : "read";
}
export interface GitDirectRequest {
  sessionId: string; bindingId: string; access: GitDirectAccess;
  command?: { old: string; new: string; ref: string };
}
export type GitDirectGrant =
  | { direct: false; reason: string; cacheSeconds: number }
  | {
    direct: true;
    remote: string;
    authorization: string | null;
    kind: "public" | "repository-token" | "owner-account" | "push-identity";
    expiresAt: string;
    cacheSeconds: number;
    revoke?: { url: string; authorization: string };
  };
export const GIT_DIRECT_CACHE_SECONDS = 60;

export const lfsLimits = {
  batchObjects: 100,
  objectBytes: 8 * 1024 * 1024 * 1024,
} as const;
export interface LfsObject { oid: string; size: number }
export interface LfsBatchRequest { objects: LfsObject[]; ref?: string }
export interface LfsBatchResult {
  objects: (LfsObject & { download: boolean; error?: { code: number; message: string } })[];
}

export function validLfsOid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
export function validLfsSize(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= lfsLimits.objectBytes;
}
export function parseLfsObject(value: unknown): LfsObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Git LFS object");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== "oid" && key !== "size") || !validLfsOid(input.oid) || !validLfsSize(input.size)) {
    throw new Error("Invalid Git LFS object");
  }
  return { oid: input.oid, size: input.size };
}
export function parseLfsBatchRequest(value: unknown): LfsBatchRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Git LFS batch request");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== "objects" && key !== "ref")) throw new Error("Invalid Git LFS batch request");
  if (!Array.isArray(input.objects) || !input.objects.length || input.objects.length > lfsLimits.batchObjects) {
    throw new Error(`A Git LFS batch names 1 to ${lfsLimits.batchObjects} objects`);
  }
  const objects = input.objects.map(parseLfsObject);
  if (input.ref !== undefined && (typeof input.ref !== "string" || !/^refs\/[\x21-\x7e]{1,250}$/.test(input.ref))) throw new Error("Invalid Git LFS ref");
  return { objects, ...(input.ref !== undefined ? { ref: input.ref } : {}) };
}
