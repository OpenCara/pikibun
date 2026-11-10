import type { TokenGitProvider } from "./repositories.js";
import type { DocumentKind } from "./sources.js";

export type WorkspaceConnectionFamily = "git" | "document";

export const workspaceGitProviders: readonly TokenGitProvider[] = ["github-enterprise", "gitlab", "bitbucket", "azure-devops", "gitea", "git"];
export const workspaceDocumentProviders: readonly DocumentKind[] = ["notion", "google-drive", "feishu"];

export const workspaceConnectionLimit = 20;

export interface WorkspaceConnection {
  id: string;
  workspaceId: string;
  family: WorkspaceConnectionFamily;
  provider: TokenGitProvider | DocumentKind;
  host: string;
  organization: string;
  name: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  sources: number;
}

export interface WorkspaceConnectionList {
  connections: WorkspaceConnection[];
}

export type SourceReadAs = "members" | "workspace";
export const sourceReadAsValues: readonly SourceReadAs[] = ["members", "workspace"];
