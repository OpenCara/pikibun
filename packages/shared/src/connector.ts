import type { HostCommandLevel, RunnerBinding, RunnerTicket, ThinkingLevel } from "./types.js";
import type { GpuKind, HostConfig } from "./host-config.js";

export interface LocalModelSummary {
  provider: string;
  modelId: string;
  name: string;
  thinkingLevels?: ThinkingLevel[];
  thinkingLevel?: ThinkingLevel;
}

export interface ConnectorCapabilities {
  platform: string;
  sandbox: boolean;
  productionShell: boolean;
  unsandboxed?: boolean;
  chatOptions?: boolean;
  chatImages?: boolean;
  gitProviders?: boolean;
  gitPush?: boolean;
  gitServers?: boolean;
  gitCredentials?: boolean;
  github?: boolean;
  githubIssues?: boolean;
  schedules?: boolean;
  crossSessions?: boolean;
  sources?: boolean;
  repositoryCache?: boolean;
  hostMigration?: boolean;
  plainGit?: boolean;
  cloneBackups?: boolean;
  sessionBranches?: boolean;
  conversationBackups?: boolean;
  sessionPacking?: boolean;
  automaticGitHub?: boolean;
  requesterAutoApprove?: boolean;
  hostGrants?: boolean;
  hostOwnerDecides?: boolean;
  hostSessionGrants?: boolean;
  unboundedShellGrants?: boolean;
  fileBrowser?: boolean;
  fileUploads?: boolean;
  directUploads?: boolean;
  web?: boolean;
  extensions?: boolean;
  builtinExtensions?: boolean;
  requiredExtensions?: boolean;
  hostConfig?: boolean;
  compactionConfig?: boolean;
  gpu?: GpuKind;
}

export interface ConnectorAdmin {
  userId: string;
  name: string;
  createdAt: string;
}

export interface HostCommandGrant {
  workspaceId: string;
  userId: string | null;
  userName?: string;
  level: HostCommandLevel;
  hostSessions?: true;
  expiresAt: string | null;
  createdBy: string;
  createdAt: string;
}

export interface ConnectorInfo {
  id: string;
  ownerId: string;
  ownerName: string;
  name: string;
  createdAt: string;
  revokedAt: string | null;
  online: boolean;
  version?: string;
  models: LocalModelSummary[];
  workspaceIds: string[];
  connectedWorkspaceIds?: string[];
  capabilities: ConnectorCapabilities;
  role?: "owner" | "admin";
  admins?: ConnectorAdmin[];
  hostGrants?: HostCommandGrant[];
  config?: HostConfig;
  hostSessions?: true;
  disabledModels?: LocalModelSummary[];
  hostCommandAccess?: "owner" | HostCommandLevel;
}

export interface HostModelSettings {
  models: LocalModelSummary[];
  disabledModels: LocalModelSummary[];
}

export interface ConnectorPairing {
  id: string;
  code: string;
  expiresAt: string;
}

export interface ConnectorCredentials {
  connectorId: string;
  token: string;
  controlPlaneUrl: string;
}

export interface ConnectorRpcRequest {
  type: "request";
  id: string;
  method: "GET" | "POST";
  path: string;
  body: string;
  ticket: RunnerTicket;
}

export interface ConnectorRpcResponse {
  type: "response";
  id: string;
  status: number;
  body: string;
}

export interface ConnectorWelcome {
  type: "welcome";
  connectorId: string;
  connectionToken: string;
}

export type ConnectorMessage = ConnectorRpcRequest | ConnectorRpcResponse | ConnectorWelcome;

export const connectorLimits = {
  requestBytes: 1024 * 1024,
  responseBytes: 24 * 1024 * 1024,
  frameBytes: 30 * 1024 * 1024,
  bufferedBytes: 32 * 1024 * 1024,
  pendingRequests: 32,
  models: 200,
} as const;

export function connectorRequestTimeoutMs(action: string): number {
  return action === "backup" || action === "restore" ? 90_000 : 30_000;
}

export interface RestoreDescriptor {
  id: string;
  sourceSessionId: string;
  backupId: string;
  sha256: string;
  size: number;
  downloadToken: string;
  migration?: true;
}

export interface RestoreInput {
  binding: RunnerBinding;
  restore: RestoreDescriptor;
}

export function parseCapabilities(json: string | null | undefined): ConnectorCapabilities {
  const none = {} as ConnectorCapabilities;
  if (!json) return none;
  try {
    const value: unknown = JSON.parse(json);
    return value && typeof value === "object" && !Array.isArray(value) ? value as ConnectorCapabilities : none;
  } catch {
    return none;
  }
}
