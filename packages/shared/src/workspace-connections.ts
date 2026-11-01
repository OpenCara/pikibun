import type { TokenGitProvider } from "./repositories.js";
import type { DocumentKind } from "./sources.js";

/**
 * Workspace connections: service credentials a workspace's owners and admins connect for the workspace itself, such as
 * a GitLab bot's token, a Git server's deploy user, a Notion integration or a Google service account. Never a member's
 * own account: a source reads with one only where an owner or admin chose that (`SourceReadAs`); pushes and pull
 * requests keep using the session owner's account or the workspace's push access.
 */
export type WorkspaceConnectionFamily = "git" | "document";

/** Git providers a workspace can connect: the token providers. github.com reads with each member's GitHub sign-in. */
export const workspaceGitProviders: readonly TokenGitProvider[] = ["github-enterprise", "gitlab", "bitbucket", "azure-devops", "gitea", "git"];
/** Document providers a workspace can connect: those whose credential is a service identity pasted as a secret. */
export const workspaceDocumentProviders: readonly DocumentKind[] = ["notion", "google-drive", "feishu"];

export const workspaceConnectionLimit = 20;

export interface WorkspaceConnection {
  id: string;
  workspaceId: string;
  family: WorkspaceConnectionFamily;
  provider: TokenGitProvider | DocumentKind;
  /** Git: the provider's host; empty for documents. */
  host: string;
  /** Azure DevOps organization; empty otherwise. */
  organization: string;
  /** The account the provider named when the credential was verified (for a Git server, its user name). */
  name: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** How many of the workspace's sources read with it. */
  sources: number;
}

export interface WorkspaceConnectionList {
  connections: WorkspaceConnection[];
}

/**
 * Which identity a source is read with: `members`, each session owner's own account (the default), or `workspace`,
 * the workspace's connection for the source's provider (and, for Git, its host and Azure DevOps organization).
 */
export type SourceReadAs = "members" | "workspace";
export const sourceReadAsValues: readonly SourceReadAs[] = ["members", "workspace"];
