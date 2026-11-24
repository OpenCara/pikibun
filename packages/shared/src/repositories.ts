import type { PushIdentityKind } from "./types.js";
import type { SourceReadAs } from "./workspace-connections.js";

export const gitProviders = ["github", "github-enterprise", "gitlab", "bitbucket", "azure-devops", "gitea", "git"] as const;
export type GitProvider = (typeof gitProviders)[number];
export type TokenGitProvider = Exclude<GitProvider, "github">;

export const gitProviderNames: Record<GitProvider, string> = {
  github: "GitHub",
  "github-enterprise": "GitHub Enterprise Server",
  gitlab: "GitLab",
  bitbucket: "Bitbucket Cloud",
  "azure-devops": "Azure DevOps",
  gitea: "Gitea / Forgejo",
  git: "Git server (HTTPS)",
};

export const gitProviderHosts: Record<GitProvider, { fixed: string | null; default: string | null }> = {
  github: { fixed: "github.com", default: "github.com" },
  "github-enterprise": { fixed: null, default: null },
  gitlab: { fixed: null, default: "gitlab.com" },
  bitbucket: { fixed: "bitbucket.org", default: "bitbucket.org" },
  "azure-devops": { fixed: "dev.azure.com", default: "dev.azure.com" },
  gitea: { fixed: null, default: null },
  git: { fixed: null, default: null },
};

export function gitProviderHasForge(provider: GitProvider): boolean {
  return provider !== "git";
}

export function validGitHost(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 253 || value !== value.toLowerCase()) return false;
  const match = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)(?::([1-9]\d{0,4}))?$/.exec(value);
  if (!match) return false;
  const name = match[1]!;
  if (match[2] !== undefined && Number(match[2]) > 65535) return false;
  if (/^[\d.]+$/.test(name) || /\.(?:local|localhost|internal|lan|home|arpa|test|invalid|example)$/.test(name) || name === "localhost") return false;
  return /[a-z]/.test(name.split(".").at(-1)!);
}

const segment = /^[A-Za-z0-9_.-]{1,100}$/;
const azureSegment = /^[A-Za-z0-9_.\- ()&'+,=@$!]{1,100}$/;

export function validRepositoryName(provider: GitProvider, value: unknown): value is string {
  if (typeof value !== "string" || value.length > 400 || value !== value.trim()) return false;
  const parts = value.split("/");
  if (parts.some(part => [".", "..", ".git"].includes(part.toLowerCase()) || part.startsWith(" ") || part.endsWith(" "))) return false;
  switch (provider) {
    case "github":
    case "github-enterprise":
      return parts.length === 2 && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(parts[0]!) && segment.test(parts[1]!);
    case "bitbucket":
    case "gitea":
      return parts.length === 2 && parts.every(part => segment.test(part));
    case "gitlab":
      return parts.length >= 2 && parts.length <= 20 && parts.every(part => segment.test(part));
    case "azure-devops":
      return parts.length === 3 && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,48}[A-Za-z0-9])?$/.test(parts[0]!) && azureSegment.test(parts[1]!) && azureSegment.test(parts[2]!);
    case "git":
      return parts.length >= 1 && parts.length <= 20 && parts.every(part => segment.test(part) && part !== "." && part !== "..");
  }
}

export function plainRepositoryPath(host: string, value: string): string | null {
  let path = value.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
    let url: URL;
    try { url = new URL(path); } catch { return null; }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.host !== host) return null;
    try { path = decodeURIComponent(url.pathname); } catch { return null; }
  }
  path = path.replace(/^\/+/, "").replace(/\/+$/, "");
  return validRepositoryName("git", path) ? path : null;
}

interface RepositoryLocation { host: string; ssh: boolean; segments: string[] }

const publicForgeAliases: Record<string, string> = { "www.github.com": "github.com", "www.gitlab.com": "gitlab.com", "www.bitbucket.org": "bitbucket.org" };

function forgeHost(host: string, segments: string[]): { host: string; segments: string[] } {
  const azure = /^([a-z0-9-]+)\.visualstudio\.com$/.exec(host);
  if (azure) return { host: "dev.azure.com", segments: [azure[1]!, ...segments] };
  if (host === "ssh.dev.azure.com") return { host: "dev.azure.com", segments: segments[0] === "v3" ? segments.slice(1) : segments };
  return { host: publicForgeAliases[host] ?? host, segments };
}

function pathSegments(path: string): string[] | null {
  try { return path.split("/").filter(Boolean).map(part => decodeURIComponent(part)); }
  catch { return null; }
}

function repositoryLocation(value: string): RepositoryLocation | null | undefined {
  const scp = /^[^\s@/:]+@([^\s/:]+):(?!\/)(.*)$/.exec(value);
  if (scp) {
    const segments = pathSegments(scp[2]!);
    return segments ? { ...forgeHost(scp[1]!.toLowerCase(), segments), ssh: true } : null;
  }
  const schemed = /^[a-z][a-z0-9+.-]*:/i.test(value);
  let url: URL;
  try { url = new URL(schemed ? value : `https://${value}`); } catch { return schemed ? null : undefined; }
  if (!schemed && !value.includes("/")) return undefined;
  if (!["https:", "http:", "ssh:"].includes(url.protocol) || url.password) return schemed ? null : undefined;
  const segments = pathSegments(url.pathname);
  if (!segments) return null;
  const location = { ...forgeHost(url.protocol === "ssh:" ? url.hostname : url.host, segments), ssh: url.protocol === "ssh:" };
  return !schemed && !location.host.includes(".") ? undefined : location;
}

const onHost = (location: RepositoryLocation, host: string) => location.host === host || (location.ssh && location.host === host.replace(/:\d+$/, ""));

export function repositoryUrlHost(value: string): string | null {
  return repositoryLocation(value.trim())?.host ?? null;
}

export function repositoryUrlOnHost(value: string, host: string): boolean | null {
  const location = repositoryLocation(value.trim());
  return location ? onHost(location, host) : null;
}

const withoutGitSuffix = (name: string) => name.replace(/\.git$/i, "");

function forgeRepositoryName(provider: Exclude<GitProvider, "git">, segments: string[]): string | null {
  switch (provider) {
    case "gitlab": {
      const end = segments.indexOf("-");
      const parts = end === -1 ? segments : segments.slice(0, end);
      if (parts.length < 2) return null;
      return [...parts.slice(0, -1), withoutGitSuffix(parts.at(-1)!)].join("/");
    }
    case "azure-devops": {
      const parts = [...segments];
      if (parts[1]?.toLowerCase() === "defaultcollection") parts.splice(1, 1);
      const at = parts.indexOf("_git");
      const [organization, project, name] = at === 1 ? [parts[0], parts[2], parts[2]]
        : at === 2 ? [parts[0], parts[1], parts[3]] : at === -1 && parts.length === 3 ? parts : [];
      return organization && project && name ? `${organization.toLowerCase()}/${project}/${name}` : null;
    }
    default:
      return segments.length >= 2 ? `${segments[0]}/${withoutGitSuffix(segments[1]!)}` : null;
  }
}

export function repositoryFullName(provider: GitProvider, host: string, value: string): string | null {
  if (provider === "git") return plainRepositoryPath(host, value);
  const input = value.trim();
  if (!input || input.length > 600) return null;
  const location = repositoryLocation(input);
  if (location === null) return null;
  let segments: string[] | null;
  if (location && onHost(location, host)) segments = location.segments;
  else if (location && (/^[a-z][a-z0-9+.-]*:/i.test(input) || input.includes("@"))) return null;
  else {
    segments = pathSegments(input);
    if (segments && ["github", "github-enterprise", "bitbucket", "gitea"].includes(provider) && segments.length !== 2) return null;
  }
  const name = segments && forgeRepositoryName(provider, segments);
  return name && validRepositoryName(provider, name) ? name : null;
}

export function validRepositoryId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9{}_-]{1,100}$/.test(value);
}

export interface ProviderRepository {
  id: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

export interface ProviderRepositoryList {
  repositories: ProviderRepository[];
  truncated: boolean;
}

export interface GitHubDeviceSignIn {
  id: string;
  userCode: string;
  verificationUri: string;
  expiresAt: string;
  interval: number;
}

export type GitHubDeviceSignInState = { status: "pending"; interval: number } | { status: "connected"; account: GitAccount };

export interface GitAccount {
  id: string;
  provider: GitProvider;
  host: string;
  organization: string;
  login: string;
  createdAt: string | null;
}

export interface WorkspaceRepository {
  id: string;
  workspaceId: string;
  provider: GitProvider;
  host: string;
  repositoryId: string;
  fullName: string;
  ref: string;
  private: boolean;
  createdAt: string;
  forbidDefaultBranchPush: boolean;
  lfs: boolean;
  readAs: SourceReadAs;
}

export interface WorkspaceRepositoryList {
  repositories: WorkspaceRepository[];
  required: boolean;
  sources?: number;
}

export function validPushBranch(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 200 && value !== "HEAD" && value !== "@"
    && !value.startsWith("-") && !value.startsWith("refs/") && !/[\s\x00-\x1f\x7f\\~^:?*[]/.test(value)
    && !/[\uD800-\uDFFF]/u.test(value) && !value.includes("..") && !value.includes("@{") && !value.endsWith(".")
    && !value.endsWith("/") && !value.split("/").some(part => !part || part.startsWith(".") || part.endsWith(".lock"));
}

export function validPushTag(value: unknown): value is string {
  return validPushBranch(value);
}

export const pushIdentityKindsByProvider: Record<GitProvider, readonly PushIdentityKind[]> = {
  github: ["github-app", "owner-account", "host-credentials"],
  "github-enterprise": ["github-app", "owner-account", "host-credentials"],
  gitlab: ["oauth-refresh", "owner-account", "host-credentials"],
  bitbucket: ["bitbucket-client-credentials", "owner-account", "host-credentials"],
  "azure-devops": ["entra-federation", "owner-account", "host-credentials"],
  gitea: ["oauth-refresh", "forgejo-integration", "owner-account", "host-credentials"],
  git: ["owner-account", "host-credentials"],
};

export type SessionRepository = GitHubSessionRepository | ProviderSessionRepository;
export interface GitHubSessionRepository {
  bindingId: string;
  repositoryId: number;
  fullName: string;
  ref: string;
  commit: string;
  path: string;
}
export interface ProviderSessionRepository {
  bindingId: string;
  provider: TokenGitProvider;
  host: string;
  repositoryId: string;
  fullName: string;
  ref: string;
  commit: string;
  path: string;
}

export function sessionRepositoryProvider(repository: SessionRepository): GitProvider {
  return "provider" in repository ? repository.provider : "github";
}

export function repositoryRemote(pin: SessionRepository): string {
  return bindingRemote({ provider: sessionRepositoryProvider(pin), host: "provider" in pin ? pin.host : "github.com", fullName: pin.fullName });
}

export function bindingRemote(binding: { provider: GitProvider; host: string; fullName: string }): string {
  const name = binding.fullName;
  switch (binding.provider) {
    case "github": return `https://github.com/${name}.git`;
    case "bitbucket": return `https://bitbucket.org/${name}.git`;
    case "azure-devops": {
      const [organization, project, repository] = name.split("/") as [string, string, string];
      return `https://dev.azure.com/${organization}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repository)}`;
    }
    case "git": return `https://${binding.host}/${name}`;
    default: return `https://${binding.host}/${name}.git`;
  }
}

export function repositoryPath(repository: { provider?: GitProvider; host?: string; fullName: string }): string {
  if (!repository.provider || repository.provider === "github") return repository.fullName;
  const parts = [repository.host ?? "", ...repository.fullName.split("/")].map(part => part.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+/, "-"));
  return parts.join("/");
}

// A workspace binds any number of repositories; only the provider picker's listing is bounded.
export const repositoryLimits = {
  pickerRepositories: 3000,
} as const;

export function validCloneDirectory(value: unknown): value is string {
  return typeof value === "string" && value.length <= 512 && /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){0,63}$/.test(value)
    && !value.split("/").some(part => [".", "..", ".git"].includes(part.toLowerCase()));
}
