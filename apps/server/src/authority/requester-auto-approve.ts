import type { Hono } from 'hono';
import type { Database } from '../db/types.js';
import type { Env, SessionRow, WorkerEnv } from '../types.js';
import { auditStatement } from './audit.js';
import { requireMember, requireSession, sessionAccess } from './access.js';
import { fail, identifier, jsonObject, now, userIdentifier } from '../http.js';
import { hasPermission } from '../../../../packages/shared/src/policy.js';
import { sessionChanged } from './changes.js';

/**
 * Auto-approving other members' requests. Approved operations run as the session's owner, so only the owner chooses whose
 * requests run without asking, from one of that member's approval cards ("Always approve"), and stops it in the session
 * panel. The workspace's owner and admins decide whether its session owners may choose that at all
 * (`requesterAutoApprove`); turned off, every such choice rests until it is turned on again. What runs without asking is
 * what `requesterAutoApproves` says, never a merge, a host command or anything the session doesn't allow yet.
 */
export interface WorkspaceApprovalSettings {
  /** Session owners here may auto-approve the requests of members who write to their sessions. Off by default. */
  requesterAutoApprove: boolean;
}

/** Owner/admin authority, re-checked inside the write, on insert and on update alike (binds workspace id, user id). */
const adminSql = `EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND role IN ('owner','admin'))`;

/** The workspace's approval settings; the defaults until an owner or admin saves some. */
export async function workspaceApprovalSettings(db: Database, workspaceId: string): Promise<WorkspaceApprovalSettings> {
  const row = await db.query<{ requester_auto_approve: number }>('SELECT requester_auto_approve FROM workspace_approval_settings WHERE workspace_id = ?')
    .bind(workspaceId).first();
  return { requesterAutoApprove: Number(row?.requester_auto_approve ?? 0) === 1 };
}

/** The members whose requests the session's owner auto-approves now (not stopped), whether or not the workspace allows it today. */
export async function autoApprovedRequesters(db: Database, sessionId: string): Promise<string[]> {
  const rows = await db.query<{ user_id: string }>(`SELECT user_id FROM session_auto_approved_requesters
    WHERE session_id = ? AND revoked_at IS NULL ORDER BY created_at, user_id`).bind(sessionId).all();
  return rows.map(row => row.user_id);
}

/**
 * Whether the session's owner auto-approves `actorId`'s requests at this moment: the actor isn't the owner and can still
 * write to the session, which isn't archived, the workspace allows it, and the owner chose it and hasn't stopped.
 */
export async function autoApprovesRequester(env: Env, row: Pick<SessionRow, 'id' | 'owner_id' | 'workspace_id'>, actorId: string): Promise<boolean> {
  if (actorId === row.owner_id) return false;
  const chosen = await env.DB.query(`SELECT 1 AS chosen FROM session_auto_approved_requesters r
    JOIN workspace_approval_settings w ON w.workspace_id = ? AND w.requester_auto_approve = 1
    WHERE r.session_id = ? AND r.user_id = ? AND r.revoked_at IS NULL`).bind(row.workspace_id, row.id, actorId).first();
  if (!chosen) return false;
  const access = await sessionAccess(env, row.id, actorId);
  return !!access && access.row.owner_id === row.owner_id && access.row.status !== 'archived' && hasPermission(access.permissions, 'write');
}

/**
 * Of `userIds`, those whose requests the session's owner chose to auto-approve at some time, stopped since or not: an
 * operation that ran without asking on the strength of that choice stays a valid record of the session's history, as
 * automatic host commands stay valid after their grant lapses. Whether one may run now is `autoApprovesRequester`.
 */
export async function everAutoApproved(db: Database, sessionId: string, userIds: readonly string[]): Promise<Set<string>> {
  if (!userIds.length) return new Set();
  const rows = await db.query<{ user_id: string }>(`SELECT user_id FROM session_auto_approved_requesters
    WHERE session_id = ? AND user_id IN (SELECT value FROM json_each(?))`).bind(sessionId, JSON.stringify([...new Set(userIds)])).all();
  return new Set(rows.map(row => row.user_id));
}

/**
 * Records that the session's owner (`actorId`, checked again as it writes) auto-approves `userId`'s requests from now on,
 * as they chose on the approval card `approvalId`; the caller has checked the rest (see the approvals route).
 */
export async function chooseAutoApprovedRequester(env: Env, row: SessionRow, actorId: string, userId: string, approvalId: string): Promise<void> {
  const saved = await env.DB.query<{ user_id: string }>(`INSERT INTO session_auto_approved_requesters
      (session_id, user_id, approval_id, granted_by, created_at, revoked_at)
    SELECT ?, ?, ?, ?, ?, NULL WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ? AND owner_id = ? AND status <> 'archived')
    ON CONFLICT (session_id, user_id) DO UPDATE SET approval_id = excluded.approval_id, granted_by = excluded.granted_by,
      created_at = excluded.created_at, revoked_at = NULL
    RETURNING user_id`).bind(row.id, userId, approvalId, actorId, now(), row.id, actorId).first();
  if (!saved) fail(403, 'owner_required', 'Only the session owner can auto-approve another member\'s requests.');
  await auditStatement(env, actorId, 'session.requester_auto_approve.started', row.workspace_id, row.id, { userId, approvalId }).run();
}

export function registerRequesterAutoApprove(app: Hono<WorkerEnv>): void {
  // Every member may see whether session owners can auto-approve other members' requests; owners and admins change it.
  app.get('/api/workspaces/:id/approvals', async c => {
    const workspaceId = identifier(c.req.param('id'));
    await requireMember(c.env, workspaceId, c.get('auth').userId);
    return c.json({ settings: await workspaceApprovalSettings(c.env.DB, workspaceId) });
  });
  app.put('/api/workspaces/:id/approvals', async c => {
    const workspaceId = identifier(c.req.param('id'));
    const actor = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    const input = await jsonObject(c, 1024);
    const keys = Object.keys(input);
    if (keys.length !== 1 || keys[0] !== 'requesterAutoApprove' || typeof input.requesterAutoApprove !== 'boolean') {
      fail(400, 'invalid_input', 'Set requesterAutoApprove to true or false.');
    }
    const enabled = input.requesterAutoApprove as boolean;
    const saved = await c.env.DB.query<{ requester_auto_approve: number }>(`INSERT INTO workspace_approval_settings
        (workspace_id, requester_auto_approve, updated_by, updated_at)
      SELECT ?,?,?,? WHERE ${adminSql}
      ON CONFLICT (workspace_id) DO UPDATE SET requester_auto_approve = excluded.requester_auto_approve,
        updated_by = excluded.updated_by, updated_at = excluded.updated_at WHERE ${adminSql}
      RETURNING requester_auto_approve`).bind(workspaceId, enabled ? 1 : 0, actor, now(), workspaceId, actor, workspaceId, actor).first();
    if (!saved) fail(403, 'forbidden', 'Workspace administrator access is required.');
    await auditStatement(c.env, actor, 'workspace.approvals.updated', workspaceId, null, { requesterAutoApprove: enabled }).run();
    return c.json({ settings: { requesterAutoApprove: Number(saved.requester_auto_approve) === 1 } satisfies WorkspaceApprovalSettings });
  });
  // The session's owner stops auto-approving a member's requests; their next ones ask again. Archived sessions too: it
  // only takes something away.
  app.delete('/api/sessions/:id/auto-approved-requesters/:userId', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'read');
    const actor = c.get('auth').userId;
    if (actor !== row.owner_id) fail(403, 'owner_required', 'Only the session owner can stop auto-approving a member\'s requests.');
    const userId = userIdentifier(c.req.param('userId'), 'userId');
    const stopped = await c.env.DB.query<{ user_id: string }>(`UPDATE session_auto_approved_requesters SET revoked_at = ?
      WHERE session_id = ? AND user_id = ? AND revoked_at IS NULL RETURNING user_id`).bind(now(), row.id, userId).first();
    if (!stopped) fail(404, 'not_found', 'This member\'s requests aren\'t auto-approved here.');
    await auditStatement(c.env, actor, 'session.requester_auto_approve.stopped', row.workspace_id, row.id, { userId }).run();
    sessionChanged(c, row.id);
    return c.json({ autoApprovedRequesters: await autoApprovedRequesters(c.env.DB, row.id) });
  });
}
