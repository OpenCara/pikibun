import { maxPendingMembers } from '../../../../packages/shared/src/invites.js';
import { sha256 } from '../../../../packages/shared/src/crypto.js';
import { fail, now } from '../http.js';
import type { Database } from '../db/types.js';
import type { Env } from '../types.js';

export const INVITE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const INVALID_LINK = 'This invite link doesn\'t work. It may have been turned off or replaced.';

export async function requireInvitedWorkspace(env: Env, token: unknown): Promise<{ id: string; name: string }> {
  if (typeof token !== 'string' || !INVITE_TOKEN.test(token)) fail(404, 'not_found', INVALID_LINK);
  const workspace = await env.DB.query<{ id: string; name: string }>(`SELECT w.id, w.name FROM workspace_invite_links l
    JOIN workspaces w ON w.id = l.workspace_id WHERE l.token_hash = ?`).bind(await sha256(token)).first();
  if (!workspace) fail(404, 'not_found', INVALID_LINK);
  return workspace;
}

export function joinRequestStatement(db: Pick<Database, 'query'>, workspaceId: string, tokenHash: string, userId: string) {
  return db.query(`INSERT INTO workspace_join_requests (workspace_id, user_id, created_at)
    SELECT l.workspace_id, ?, ? FROM workspace_invite_links l
    WHERE l.workspace_id = ? AND l.token_hash = ?
      AND NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = l.workspace_id AND m.user_id = ?)
      AND (SELECT COUNT(*) FROM workspace_join_requests r WHERE r.workspace_id = l.workspace_id) < ?
    ON CONFLICT (workspace_id, user_id) DO NOTHING`)
    .bind(userId, now(), workspaceId, tokenHash, userId, maxPendingMembers);
}
