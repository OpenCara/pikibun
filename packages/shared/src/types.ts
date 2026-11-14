import type { GitProvider, SessionRepository } from "./repositories.js";
import type { SessionTunnelRecord, SessionTunnelView } from "./tunnel.js";
import type { ChatImage } from "./chat-images.js";

export const permissions = ["read", "ask", "write", "approve", "manage"] as const;
export type Permission = (typeof permissions)[number];
export const workspaceRoles = ["owner", "admin", "collaborator", "member", "viewer"] as const;
export type WorkspaceRole = (typeof workspaceRoles)[number];
export const assignableWorkspaceRoles = ["admin", "collaborator", "member", "viewer"] as const satisfies readonly WorkspaceRole[];
export type AssignableWorkspaceRole = (typeof assignableWorkspaceRoles)[number];
export const sessionRoles = ["viewer", "member", "collaborator", "admin"] as const;
export type SessionRole = (typeof sessionRoles)[number];
export const toolNames = ["identity", "ls", "read", "write", "edit", "git_status", "git_commit", "bash", "github_read", "github_comment", "github_merge", "git_push", "git_repin", "host_bash", "github_issue", "schedule", "sessions", "web_fetch", "web_search", "source_read", "grep", "find", "git", "node", "move_file", "copy_file", "delete_file", "python", "rust", "go", "dotnet", "make", "browser"] as const;
export type ToolName = (typeof toolNames)[number];
export type AnyToolName = ToolName | (string & {});
export const definedToolNamePattern = /^[a-z][a-z0-9_]{0,63}$/;
export const retiredToolNames: readonly ToolName[] = ["git_status", "git_commit", "git_repin", "web_fetch", "web_search", "bash", "host_bash"];
export const renamedToolNames: Readonly<Record<string, ToolName>> = Object.freeze({ read_file: "read", write_file: "write", edit_file: "edit", list_files: "ls", search: "grep" });
const renamedTools = new Map<string, string>(Object.entries(renamedToolNames));
export function canonicalToolName(name: string): string {
  return renamedTools.get(name) ?? name;
}
export function legacyToolNames(name: string): string[] {
  return Object.keys(renamedToolNames).filter(legacy => renamedToolNames[legacy] === name);
}
export function canonicalToolNames(names: readonly string[]): string[] {
  return [...new Set(names.map(canonicalToolName))];
}
export const groupedToolNames: Readonly<Record<string, ToolName>> = Object.freeze({ find: "grep" });
const groupedTools = new Map<string, string>(Object.entries(groupedToolNames));
export function toolGroupEntry(name: string): string {
  const canonical = canonicalToolName(name);
  return groupedTools.get(canonical) ?? canonical;
}
export function toolsGroupedUnder(name: string): string[] {
  return Object.keys(groupedToolNames).filter(grouped => groupedToolNames[grouped] === name);
}
export function sessionToolNames(names: readonly string[]): string[] {
  const canonical = canonicalToolNames(names);
  return [...new Set(canonical.flatMap(name => [name, ...toolsGroupedUnder(name)]))];
}
export function withLegacyToolNames(names: readonly string[]): string[] {
  return [...new Set(names.flatMap(name => [name, ...legacyToolNames(name)]))];
}
export interface UserProfile {
  id: string;
  username?: string | null;
  githubId: string | null;
  githubLogin: string | null;
  displayName: string;
  gitName: string;
  gitEmail: string;
  env: Record<string, string>;
  githubConnected: boolean;
  instanceAdmin?: true;
  passwordSignIn?: true;
  localOwner?: true;
  hasPassword?: true;
  usernameRequired?: true;
}
export interface SignedInDevice {
  id: string;
  name: string | null;
  createdAt: string;
  expiresAt: string;
  current: boolean;
  viaCode?: true;
}
export interface NativeSignIn {
  token: string;
  expiresAt: string;
  user: UserProfile;
}
export interface AppSignInCode {
  id: string;
  code: string;
  link: string;
  expiresAt: string;
}
export interface AppSignInCodeState {
  id: string;
  status: 'pending' | 'used';
  expiresAt: string;
  deviceName: string | null;
}
export interface Workspace {
  id: string;
  name: string;
  ownerId: string;
  role?: WorkspaceRole;
  personal?: boolean;
}
export interface ModelDefinition {
  id: string;
  workspaceId: string;
  name: string;
  provider: string;
  modelId: string;
  connectorId?: string;
  connectorOwnerId?: string;
}
export interface AgentVersion {
  id: string;
  agentId: string;
  authorId: string;
  workspaceId: string | null;
  version: number;
  name: string;
  description: string;
  instructions: string;
  tools: AnyToolName[];
  modelId: string;
  createdAt: string;
}
export const sessionActivities = ["idle", "working", "waiting", "done", "failed"] as const;
export type SessionActivity = (typeof sessionActivities)[number];
export interface SessionBranch { repository: string; branch: string }
export interface SessionRecord {
  id: string;
  workspaceId: string;
  ownerId: string;
  ownerName?: string;
  agentVersionId: string;
  title: string;
  policyVersion: number;
  status: "provisioning" | "ready" | "error" | "archived";
  createdAt: string;
  permissions?: Permission[];
  connectorId?: string;
  connectorOwnerId?: string;
  repositories?: SessionRepository[];
  repositoryMode?: "clone";
  branch?: string;
  frozen?: true;
  cloneUnavailable?: string;
  visibility?: "private" | "workspace";
  parentSessionId?: string;
  packed?: true;
  toolOutput?: "brief";
  hostUnsandboxed?: boolean;
  viewable?: boolean;
  hostEnvironment?: true;
  audienceSharing?: true;
  activity?: SessionActivity;
  nextScheduledAt?: string;
  pullRequest?: SessionPullRequest;
  tunnel?: SessionTunnelRecord;
}
export type PullRequestState = "draft" | "open" | "failing" | "changes_requested" | "merged" | "closed";
export interface SessionPullRequest {
  url: string;
  number?: number;
  state?: PullRequestState;
}
export const scheduleRunIns = ["session", "child"] as const;
export type ScheduleRunIn = (typeof scheduleRunIns)[number];
export interface SessionSchedule {
  id: string;
  sessionId: string;
  name: string;
  cron: string;
  timeZone: string;
  content: string;
  access: AccessMode;
  runIn?: ScheduleRunIn;
  oneShot?: boolean;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastSubmissionId: string | null;
  lastSessionId?: string | null;
  lastError: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
export interface SessionGrant {
  userId: string;
  permissions: Permission[];
  workspaceRole?: WorkspaceRole;
  sessionRole?: SessionRole | null;
}
export interface RunnerBinding {
  session: SessionRecord;
  owner: UserProfile;
  agent: AgentVersion;
  model: ModelDefinition;
}
export type RunnerAction = "create" | "view" | "events" | "submit" | "ask" | "backup" | "restart" | "restore" | "stop" | "files" | "changes"
  | "revert" | "fork" | "pack" | "unpack" | "withdraw" | "upload" | "tunnel" | "image" | "sudo";

export const fileBrowserLimits = { entries: 1000, textBytes: 256 * 1024, imageBytes: 2 * 1024 * 1024 } as const;

export interface FileEntry {
  name: string;
  type: "directory" | "file" | "symlink" | "other";
  size?: number;
}

export type SessionFiles =
  | { path: string; type: "directory"; entries: FileEntry[]; total: number; truncated: boolean }
  | { path: string; type: "file"; size: number; truncated: boolean; text?: string; image?: { mimeType: string; data: string }; binary?: true;
    redacted?: true };
export interface RunnerTicket {
  aud: "runner";
  sessionId: string;
  actorId: string;
  ownerId: string;
  action: RunnerAction;
  policyVersion: number;
  iat: number;
  exp: number;
  jti: string;
  bodyHash: string;
  connectorId?: string;
}
export interface AuthorizationRequest {
  sessionId: string;
  actorId: string;
  permission: Permission;
  ownerId: string;
  host?: boolean;
  hostSessions?: boolean;
  archived?: boolean;
}
export const hostCommandLevels = ["auto"] as const;
export type HostCommandLevel = (typeof hostCommandLevels)[number];
export interface AuthorizationResult {
  allowed: boolean;
  policyVersion: number;
  ownerId: string;
  hostCommands?: HostCommandLevel;
  hostSessions?: true;
}
export interface PullRequestRequest {
  title: string;
  body: string;
  base?: string;
  draft?: boolean;
}
export interface GitPushOperation {
  kind: "git.push";
  repository: string;
  directory?: string;
  branch: string;
  tag?: string;
  commit: string;
  pullRequest?: PullRequestRequest;
}
export const permissionNeeds = ["tool", "write", "unbounded-shell", "audience"] as const;
export type PermissionNeed = (typeof permissionNeeds)[number];
export interface PermissionRequest {
  kind: "permission";
  tool: AnyToolName;
  target: string;
  needs: PermissionNeed[];
}
export const githubMergeMethods = ["merge", "squash", "rebase"] as const;
export type GitHubMergeMethod = (typeof githubMergeMethods)[number];
export interface GitHubMergeOperation {
  kind: "github.merge";
  repository: string;
  pull: number;
  sha: string;
  method: GitHubMergeMethod;
}
export const GITHUB_ISSUE_TITLE_LIMIT = 256;
export const GITHUB_ISSUE_BODY_LIMIT = 60000;
export interface GitHubIssueOperation {
  kind: "github.issue";
  repository: string;
  title: string;
  body: string;
}
export type GitHubEffectAuthority = { capability: string; admissionId?: undefined } | { admissionId: string; capability?: undefined };
export type GitHubIssueRequest = GitHubEffectAuthority & {
  sessionId: string;
  actorId: string;
  approvalId: string;
  repository: string;
  title: string;
  body: string;
};
export interface GitHubIssueResult {
  number: number;
  url: string;
}
export const programToolNames = ["git", "node", "python", "rust", "go", "dotnet", "browser", "make"] as const;
export type ProgramToolName = (typeof programToolNames)[number];
export interface ProgramOperation {
  kind: "program";
  tool: ProgramToolName | (string & {});
  command: string;
}
export interface HostCommandOperation {
  kind: "host.bash";
  command: string;
  timeoutSeconds: number;
}
export interface ExtensionToolOperation {
  kind: "extension.tool";
  source: string;
  tool: string;
  arguments: string;
  digest: string;
}
export const EXTENSION_ARGUMENTS_SHOWN = 8000;
export interface GitRepinOperation {
  kind: "git.repin";
  repository: string;
  ref: string;
}
export interface RepinRequest {
  sessionId: string;
  approvalId: string;
  actorId: string;
  operation: GitRepinOperation;
  capability?: string;
  admissionId?: string;
}
export interface RepinResult {
  sessionId: string;
  path: string;
  repositories: SessionRepository[];
}
export type Operation =
  | ExtensionToolOperation
  | { kind: "git.commit"; message: string }
  | { kind: "bash"; command: string }
  | ProgramOperation
  | { kind: "github.comment"; repository: string; issue: number; body: string }
  | GitHubMergeOperation
  | GitHubIssueOperation
  | GitPushOperation
  | GitRepinOperation
  | HostCommandOperation
  | PermissionRequest;
export interface GitHubReadRequest {
  sessionId: string;
  actorId: string;
  admissionId: string;
  callId: string;
  repository: string;
  issue: number;
}
export const scheduleToolActions = ["list", "create", "update", "delete"] as const;
export type ScheduleToolAction = (typeof scheduleToolActions)[number];
export interface ScheduleToolRequest {
  sessionId: string;
  actorId: string;
  admissionId: string;
  callId: string;
  action: ScheduleToolAction;
  scheduleId?: string;
  name?: string;
  cron?: string;
  timeZone?: string;
  content?: string;
  access?: AccessMode;
  runIn?: ScheduleRunIn;
  oneShot?: boolean;
  enabled?: boolean;
}
export type ScheduleToolResult = { schedules: SessionSchedule[] } | { schedule: SessionSchedule } | { deleted: string };
export type GitHubMergeRequest = GitHubEffectAuthority & {
  sessionId: string;
  actorId: string;
  approvalId: string;
  repository: string;
  pull: number;
  sha: string;
  method: GitHubMergeMethod;
};
export type GitHubCommentRequest = GitHubEffectAuthority & {
  sessionId: string;
  actorId: string;
  approvalId: string;
  repository: string;
  issue: number;
  body: string;
};
export interface GitHubMergeResult {
  sha: string;
  url: string;
}
export interface GitHubCommentView {
  id: number;
  author: string | null;
  createdAt: string;
  body: string;
  url: string;
}
export interface GitHubReviewView {
  id: number;
  author: string | null;
  state: string;
  submittedAt: string | null;
  commit: string | null;
  body: string;
  url: string;
}
export interface GitHubReviewCommentView {
  id: number;
  inReplyTo: number | null;
  author: string | null;
  createdAt: string;
  path: string;
  line: number | null;
  originalLine: number | null;
  commit: string;
  body: string;
  diffHunk: string;
  url: string;
}
export interface GitHubPullRequestView {
  draft: boolean;
  merged: boolean;
  mergeable: boolean | null;
  mergeableState: string;
  head: { ref: string; sha: string; repository: string | null };
  base: { ref: string; sha: string };
  reviews: GitHubReviewView[];
  reviewComments: GitHubReviewCommentView[];
  checks: { name: string; status: string; conclusion: string | null }[];
}
export interface GitHubIssueView {
  repository: string;
  number: number;
  url: string;
  title: string;
  state: string;
  author: string | null;
  createdAt: string;
  body: string;
  labels: string[];
  comments: GitHubCommentView[];
  pullRequest?: GitHubPullRequestView;
  omitted?: { comments?: number; reviews?: number; reviewComments?: number; checks?: number };
}
export const pullRequestReviewLimits = { files: 300, commits: 250, patchBytes: 256 * 1024, totalPatchBytes: 2 * 1024 * 1024 } as const;
export type PullRequestFileStatus = "added" | "modified" | "removed" | "renamed" | "copied";
export interface PullRequestFileView {
  path: string;
  previousPath?: string;
  status: PullRequestFileStatus;
  additions: number;
  deletions: number;
  patch?: string;
  truncated?: true;
  redacted?: true;
}
export interface PullRequestCommitView {
  sha: string;
  message: string;
  author: string | null;
  date: string;
}
export interface PullRequestReview {
  pull: GitHubIssueView;
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: PullRequestCommitView[];
  files: PullRequestFileView[];
  omitted?: { files?: number; commits?: number };
}
export interface PushCredential {
  credentialId: string;
  remote: string;
  authorization: string;
  expiresAt: string;
}
export interface HostPushCredential {
  credentialId: string;
  remote: string;
  hostCredentials: true;
  expiresAt: string;
}
export type PushOutcome = "pushed" | "up-to-date" | "failed" | "unknown";
export interface PushCompletionResult {
  pullRequest?: { url: string; number: number; created: boolean; draft?: boolean };
}
export interface PushCredentialRequest {
  sessionId: string;
  approvalId: string;
  actorId: string;
  operation: GitPushOperation;
  capability?: string;
  admissionId?: string;
}
export interface PushCompleteRequest {
  sessionId: string;
  approvalId: string;
  credentialId: string;
  outcome: PushOutcome;
  tip?: string;
}
export const pushIdentityKinds = ["github-app", "entra-federation", "bitbucket-client-credentials", "oauth-refresh", "forgejo-integration", "owner-account", "host-credentials"] as const;
export type PushIdentityKind = (typeof pushIdentityKinds)[number];
export interface PushIdentity {
  id: string;
  workspaceId: string;
  provider: GitProvider;
  host: string;
  scope: string;
  kind: PushIdentityKind;
  config: Record<string, string>;
  status: "ready" | "authorization_required";
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
export const workspaceDatabaseTlsModes = ["verify-full", "require", "disable"] as const;
export type WorkspaceDatabaseTls = (typeof workspaceDatabaseTlsModes)[number];
export interface WorkspaceDatabase {
  id: string;
  workspaceId: string;
  host: string;
  port: number;
  database: string;
  user: string;
  tls: WorkspaceDatabaseTls;
  customCa: boolean;
  connectedBy: string;
  createdAt: string;
  updatedAt: string;
}
export type BackupLocation = "server" | "workspace-database";
export interface OperationRecord {
  id: string;
  sessionId: string;
  requestedBy: string;
  operation: Operation;
  status: "pending" | "approved" | "denied" | "executing" | "executed" | "interrupted" | "failed";
  decidedBy?: string;
  result?: string;
  createdAt: string;
  admissionId?: string;
  automatic?: boolean;
  reviewHash?: string;
  scope?: "call" | "session";
  unbounded?: boolean;
  permission?: { decidedBy: string; scope?: "call" | "session" };
}
export interface CallOutcome {
  tool: string;
  callId?: string;
  status: OperationRecord["status"];
  unbounded?: true;
}
export interface ToolCallRef {
  id: string;
  name: string;
}
export type CompactionFailure = "token_limit" | "tool_call" | "no_text" | "aborted";
export const COMPACTION_FAILURES: readonly CompactionFailure[] = ["token_limit", "tool_call", "no_text", "aborted"];
export type ModelFailureCause = "incomplete_stream";
export const MODEL_FAILURE_CAUSES: readonly ModelFailureCause[] = ["incomplete_stream"];
export interface EntryView {
  id: string;
  kind: string;
  role: string;
  text: string;
  actorId?: string;
  conversationId?: string;
  error?: { provider?: string; modelId?: string; status?: number; compaction?: CompactionFailure; cause?: ModelFailureCause; compacting?: true };
  durationMs?: number;
  autoApproved?: CallOutcome[];
  toolCalls?: ToolCallRef[];
  toolResult?: { callId?: string; tool?: string; error?: true };
  images?: { mimeType: string }[];
  trimmed?: { lines: number; chars: number };
}
export const repositoryPreparationPhases = ["queued", "authorizing", "waiting", "connecting", "enumerating", "counting", "compressing",
  "receiving", "resolving", "verifying", "checking", "checking-out", "done"] as const;
export type RepositoryPreparationPhase = (typeof repositoryPreparationPhases)[number];
export interface RepositoryPreparationItem {
  path: string;
  phase: RepositoryPreparationPhase;
  percent: number | null;
  done: number | null;
  total: number | null;
  bytes: number;
}
export interface RepositoryPreparationView {
  status: "preparing" | "failed";
  items: RepositoryPreparationItem[];
  error?: string;
}
export interface ConversationView {
  id: string;
  mode: "write" | "ask";
  actorId?: string;
  olderEntries?: number;
  previousEntryId?: string;
}
export interface SessionView {
  sessionId: string;
  owner: Pick<UserProfile, "id" | "displayName" | "gitName" | "gitEmail" | "githubLogin">;
  entries: EntryView[];
  approvals: OperationRecord[];
  olderApprovals?: number;
  conversations: ConversationView[];
  busy: boolean;
  queue?: { submissionId: string; actorId: string; mode: "write" | "ask"; status: string }[];
  stoppable?: boolean;
  withdrawable?: boolean;
  rewindable?: boolean;
  memberForks?: boolean;
  agent?: { provider: string; modelId: string; thinkingLevel: ThinkingLevel };
  context?: SessionContextView;
  access?: AccessMode;
  repositories?: RepositoryPreparationView;
  activity?: SessionActivity;
  extensions?: { running: { source: string; dev: boolean; tools: string[]; required?: true }[]; missing: string[]; builtin?: string[]; missingRequired?: string[];
    unavailable?: { source: string; tools: string[]; reason: string; programs?: string[] }[] };
  tunnel?: SessionTunnelView;
  sudo?: SudoPromptView;
}
export interface SudoPromptView {
  id: string;
  prompt: string;
  command?: string;
  requestedAt: string;
  expiresAt: string;
}
export interface SessionContextView {
  tokens: number;
  window?: number;
  compactsAt?: number;
}
export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof thinkingLevels)[number];
export const accessModes = ["read", "approval", "auto"] as const;
export type AccessMode = (typeof accessModes)[number];
export interface ChatOptions {
  model?: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
  access?: AccessMode;
  autoMerge?: boolean;
  auto?: true | AutoModelRequest;
}
export interface AutoModelRequest {
  candidates: { provider: string; modelId: string; name: string; thinkingLevels?: ThinkingLevel[]; thinkingLevel?: ThinkingLevel }[];
}
export interface SubmitInput {
  content: string;
  requestId: string;
  admissionId?: string;
  options?: ChatOptions;
  images?: ChatImage[];
}
export interface SubmitResult {
  submissionId: string;
  conversationId: string;
  status: string;
  queuePosition?: number;
}
export interface WithdrawResult {
  content: string;
  mode: "write" | "ask";
  images?: ChatImage[];
  imagesLost?: true;
}
