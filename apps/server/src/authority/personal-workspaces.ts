import type { Env } from '../types.js';
import { fail } from '../http.js';

export const personalWorkspaceName = 'Private';

export function personalWorkspaceSQL(workspaceId: string): string {
  return `EXISTS (SELECT 1 FROM personal_workspaces WHERE workspace_id = ${workspaceId})`;
}

export function ownHostsOnlySQL(workspaceId: string, hostOwnerId: string): string {
  return `NOT EXISTS (SELECT 1 FROM personal_workspaces own_hosts_only WHERE own_hosts_only.workspace_id = ${workspaceId}
    AND (${hostOwnerId} IS NULL OR own_hosts_only.user_id <> ${hostOwnerId}))`;
}

export async function isPersonalWorkspace(env: Env, workspaceId: string, userId?: string): Promise<boolean> {
  const row = userId === undefined
    ? await env.DB.query('SELECT 1 AS found FROM personal_workspaces WHERE workspace_id = ?').bind(workspaceId).first()
    : await env.DB.query('SELECT 1 AS found FROM personal_workspaces WHERE workspace_id = ? AND user_id = ?').bind(workspaceId, userId).first();
  return Boolean(row);
}

export async function requireSharedWorkspace(env: Env, workspaceId: string): Promise<void> {
  if (await isPersonalWorkspace(env, workspaceId)) {
    fail(409, 'personal_workspace', 'This is a private workspace, only for its owner. Create a workspace to work with others.');
  }
}
