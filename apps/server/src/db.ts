import { isPullRequestState } from '../../../packages/shared/src/pull-requests.js';
import type { AgentVersion, ModelDefinition, Permission, SessionPullRequest, SessionRecord, UserProfile } from '../../../packages/shared/src/types.js';
import type { ConnectorCapabilities } from '../../../packages/shared/src/connector.js';
import { sessionBranchName } from '../../../packages/shared/src/git-push.js';
import type { AgentRow, Env, ModelRow, SessionRow, UserRow } from './types.js';
import { fail } from './http.js';

export async function getUser(env: Env, userId: string): Promise<UserRow | null> {
  return env.DB.query<UserRow>(`SELECT u.*, EXISTS(SELECT 1 FROM github_tokens t WHERE t.user_id = u.id) AS github_connected,
    EXISTS(SELECT 1 FROM password_credentials p WHERE p.user_id = u.id) AS has_password FROM users u WHERE u.id = ?`).bind(userId).first();
}
export function userProfile(row: UserRow): UserProfile {
  const username = row.username ?? (row.auth_kind === 'password' && row.id.startsWith('password:') ? row.id.slice('password:'.length) : null);
  return { id: row.id, username, githubId: row.github_id, githubLogin: row.github_login, displayName: row.display_name,
    gitName: row.git_name, gitEmail: row.git_email, env: JSON.parse(row.env_json), githubConnected: row.auth_kind !== 'test' && !!row.github_id && !!row.github_connected };
}
export function modelDefinition(row: ModelRow): ModelDefinition {
  return { id: row.id, workspaceId: row.workspace_id, name: row.name, provider: row.provider, modelId: row.model_id,
    ...(row.connector_id ? { connectorId: row.connector_id, connectorOwnerId: row.connector_owner_id! } : {}) };
}
export function agentVersion(row: AgentRow): AgentVersion {
  return { id: row.id, agentId: row.agent_id, authorId: row.author_id, workspaceId: row.workspace_id, version: row.version,
    name: row.name, description: row.description, instructions: row.instructions, tools: JSON.parse(row.tools_json), modelId: row.model_id, createdAt: row.created_at };
}
export function frozenSession(row: Pick<SessionRow, 'repository_mode' | 'repositories_json'>): boolean {
  if (row.repository_mode === 'clone') return false;
  try {
    const pins: unknown = JSON.parse(row.repositories_json ?? '[]');
    return !Array.isArray(pins) || pins.length > 0;
  } catch { return true; }
}
export function requireUnfrozen(row: Pick<SessionRow, 'repository_mode' | 'repositories_json'>): void {
  if (frozenSession(row)) {
    fail(409, 'session_frozen', 'This session pinned its repositories when it started, which sessions no longer do. It stays readable, but it no longer '
      + 'runs messages, approvals, backups, restores or moves; start a new session to continue the work.');
  }
}

export function sessionPullRequest(url: string | null | undefined, state?: string | null): SessionPullRequest | undefined {
  if (!url) return undefined;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return undefined; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
  const number = /\/(\d+)\/?$/.exec(parsed.pathname)?.[1];
  return { url: parsed.href, ...(number ? { number: Number(number) } : {}), ...(isPullRequestState(state) ? { state } : {}) };
}

export function successorBranch(row: Pick<SessionRow, 'id' | 'title' | 'repository_mode'>, capabilities: ConnectorCapabilities): string | null {
  return row.repository_mode === 'clone' && capabilities.sessionBranches === true ? sessionBranchName(row.title, row.id) : null;
}

export function sessionRecord(row: SessionRow, grants?: Permission[]): SessionRecord {
  const pullRequest = row.pull_request_url ? sessionPullRequest(row.pull_request_url, row.pull_request_state)
    : sessionPullRequest(row.branch_pull_request_url, row.branch_pull_request_state);
  return { id: row.id, workspaceId: row.workspace_id, ownerId: row.owner_id, ...(row.owner_name ? { ownerName: row.owner_name } : {}), agentVersionId: row.agent_version_id,
    title: row.title, visibility: row.visibility ?? 'private', policyVersion: row.policy_version, status: row.status, createdAt: row.created_at,
    repositories: JSON.parse(row.repositories_json ?? '[]'),
    ...(row.repository_mode === 'clone' ? { repositoryMode: 'clone' as const } : {}),
    ...(row.repository_mode === 'clone' && row.branch ? { branch: row.branch } : {}),
    ...(Number(row.host_environment ?? 0) === 1 ? { hostEnvironment: true as const } : {}),
    ...(frozenSession(row) ? { frozen: true as const } : {}),
    ...(row.connector_id ? { connectorId: row.connector_id, connectorOwnerId: row.connector_owner_id! } : {}),
    ...(grants ? { permissions: grants } : {}),
    ...(row.activity ? { activity: row.activity } : {}),
    ...(row.next_scheduled_at ? { nextScheduledAt: row.next_scheduled_at } : {}),
    ...(row.tool_output === 'brief' ? { toolOutput: 'brief' as const } : {}),
    ...(row.parent_session_id ? { parentSessionId: row.parent_session_id } : {}),
    ...(row.packed_at ? { packed: true as const } : {}),
    ...(pullRequest ? { pullRequest } : {}),
    ...(row.tunnel_url && row.tunnel_expires_at && row.status !== 'archived' && Date.parse(row.tunnel_expires_at) > Date.now() ? { tunnel: { url: row.tunnel_url, expiresAt: row.tunnel_expires_at } } : {}) };
}
export function runnerSessionRecord(row: SessionRow): Omit<SessionRecord, 'ownerName' | 'visibility' | 'permissions' | 'activity' | 'frozen' | 'pullRequest' | 'toolOutput' | 'nextScheduledAt' | 'parentSessionId' | 'packed' | 'tunnel'> {
  const { ownerName: _ownerName, visibility: _visibility, permissions: _permissions, activity: _activity, frozen: _frozen, pullRequest: _pullRequest,
    toolOutput: _toolOutput, nextScheduledAt: _nextScheduledAt, parentSessionId: _parentSessionId, packed: _packed, tunnel: _tunnel, ...record } = sessionRecord(row);
  return record;
}
export async function requireActiveSession(env: Env, row: Pick<SessionRow, 'id' | 'status'>): Promise<void> {
  if (row.status === 'archived') fail(409, 'session_archived', 'Session is archived.');
  if (await env.DB.query("SELECT 1 FROM restore_jobs WHERE target_session_id = ? AND status <> 'completed'").bind(row.id).first()) {
    fail(409, 'restore_pending', 'Session restoration is not complete.');
  }
  await requireNoMigration(env, row.id);
}
export async function requireNoMigration(env: Env, sessionId: string, asTarget = false): Promise<void> {
  if (await env.DB.query("SELECT 1 FROM host_migrations WHERE status = 'pending' AND (source_session_id = ? OR (target_session_id = ? AND ? = 0))")
    .bind(sessionId, sessionId, asTarget ? 1 : 0).first()) {
    fail(409, 'migration_pending', 'This session is moving to another host. Finish or cancel the move first.');
  }
}
