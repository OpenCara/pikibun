import type { Env } from '../types.js';
import { fail } from '../http.js';

/*
 * Private workspaces: every user has one workspace of their own (personal_workspaces), which the catalog creates the
 * first time they list their workspaces and lists first. It is theirs alone: nobody else can be added to it, it has no
 * invite link, and their hosts aren't shared into it. Its sessions need no source, so an agent runs there privately
 * from the start.
 */

/** The name a private workspace is created with. */
export const personalWorkspaceName = 'Private';

/** SQL true when workspace `workspaceId` (a placeholder or column) is someone's private workspace. */
export function personalWorkspaceSQL(workspaceId: string): string {
  return `EXISTS (SELECT 1 FROM personal_workspaces WHERE workspace_id = ${workspaceId})`;
}

/** Whether `workspaceId` is `userId`'s own private workspace (or, without `userId`, anyone's). */
export async function isPersonalWorkspace(env: Env, workspaceId: string, userId?: string): Promise<boolean> {
  const row = userId === undefined
    ? await env.DB.query('SELECT 1 AS found FROM personal_workspaces WHERE workspace_id = ?').bind(workspaceId).first()
    : await env.DB.query('SELECT 1 AS found FROM personal_workspaces WHERE workspace_id = ? AND user_id = ?').bind(workspaceId, userId).first();
  return Boolean(row);
}

/** Refuses what would let someone else into a private workspace: members, invite links and shared hosts. */
export async function requireSharedWorkspace(env: Env, workspaceId: string): Promise<void> {
  if (await isPersonalWorkspace(env, workspaceId)) {
    fail(409, 'personal_workspace', 'This is a private workspace, only for its owner. Create a workspace to work with others.');
  }
}
