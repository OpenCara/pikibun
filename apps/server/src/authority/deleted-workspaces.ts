import type { Hono } from 'hono';
import type { DeletedWorkspace, Workspace } from '../../../../packages/shared/src/types.js';
import { ConstraintError, type Query } from '../db/types.js';
import { fail, id, identifier, now } from '../http.js';
import type { AppEnv, Env } from '../types.js';
import { requireMember } from './access.js';
import { auditAfterChange } from './audit.js';
import { personalWorkspaceSQL } from './personal-workspaces.js';

export function deletedWorkspaceSQL(workspace: string): string {
  return `EXISTS (SELECT 1 FROM deleted_workspaces WHERE workspace_id = ${workspace})`;
}

export async function isDeletedWorkspace(env: Env, workspaceId: string): Promise<boolean> {
  return Boolean(await env.DB.query('SELECT 1 AS found FROM deleted_workspaces WHERE workspace_id = ?').bind(workspaceId).first());
}

function lockWorkspace(env: Env, workspaceId: string, ownerId: string): Query<never> {
  return env.DB.query<never>('UPDATE workspaces SET owner_id = owner_id WHERE id = ? AND owner_id = ?').bind(workspaceId, ownerId);
}

const ownedDeleted = `EXISTS (SELECT 1 FROM deleted_workspaces dw JOIN workspaces w ON w.id = dw.workspace_id WHERE dw.workspace_id = ? AND w.owner_id = ?)`;
const audited = 'EXISTS (SELECT 1 FROM audit WHERE id = ?)';

interface DeletedRow { id: string; name: string; deleted_at: string; deleted_by: string; members: number; sessions: number }

function deletedStatement(env: Env, ownerId: string, workspaceId: string | null): Query<DeletedRow> {
  return env.DB.query<DeletedRow>(`SELECT w.id, w.name, dw.deleted_at, dw.deleted_by,
      (SELECT COUNT(*) FROM deleted_workspace_members dm WHERE dm.workspace_id = w.id) AS members,
      (SELECT COUNT(*) FROM sessions s WHERE s.workspace_id = w.id) AS sessions
    FROM deleted_workspaces dw JOIN workspaces w ON w.id = dw.workspace_id
    WHERE w.owner_id = ?${workspaceId === null ? '' : ' AND w.id = ?'}
    ORDER BY dw.deleted_at DESC, w.id`).bind(ownerId, ...(workspaceId === null ? [] : [workspaceId]));
}

const deletedWorkspace = (row: DeletedRow): DeletedWorkspace => ({ id: row.id, name: row.name, deletedAt: row.deleted_at, deletedBy: row.deleted_by,
  members: Number(row.members), sessions: Number(row.sessions) });

async function requireOwnDeleted(env: Env, workspaceId: string, ownerId: string): Promise<DeletedWorkspace> {
  const row = await deletedStatement(env, ownerId, workspaceId).first();
  if (!row) fail(404, 'not_found', 'Deleted workspace not found.');
  return deletedWorkspace(row);
}

export function registerDeletedWorkspaces(app: Hono<AppEnv>): void {
  app.delete('/api/workspaces/:id', async c => {
    const workspaceId = identifier(c.req.param('id'), 'workspaceId');
    const actorId = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actorId);
    const row = await c.env.DB.query<{ ownerId: string; personal: number }>(`SELECT w.owner_id AS ownerId,
        CASE WHEN ${personalWorkspaceSQL('w.id')} THEN 1 ELSE 0 END AS personal FROM workspaces w WHERE w.id = ?`).bind(workspaceId).first();
    if (!row) fail(404, 'not_found', 'Workspace not found.');
    if (row.ownerId !== actorId) fail(403, 'forbidden', 'Only the workspace owner can delete it.');
    if (Number(row.personal) > 0) fail(409, 'personal_workspace', 'Your private workspace can\'t be deleted.');
    const auditId = id();
    const at = now();
    const result = await c.env.DB.batch([
      lockWorkspace(c.env, workspaceId, actorId),
      c.env.DB.query<never>(`INSERT INTO deleted_workspaces (workspace_id, deleted_by, deleted_at)
        SELECT w.id, ?, ? FROM workspaces w
        WHERE w.id = ? AND w.owner_id = ? AND NOT ${personalWorkspaceSQL('w.id')} AND NOT ${deletedWorkspaceSQL('w.id')}
          AND EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = w.id AND m.user_id = w.owner_id AND m.role = 'owner')`)
        .bind(actorId, at, workspaceId, actorId),
      auditAfterChange(c.env, actorId, 'workspace.deleted', workspaceId, {}, auditId),
      c.env.DB.query<never>(`INSERT INTO deleted_workspace_members (workspace_id, user_id, role, created_at)
        SELECT workspace_id, user_id, role, created_at FROM workspace_members WHERE workspace_id = ? AND ${audited}`).bind(workspaceId, auditId),
      c.env.DB.query<never>(`DELETE FROM workspace_members WHERE workspace_id = ? AND ${audited}`).bind(workspaceId, auditId),
      c.env.DB.query<never>(`DELETE FROM workspace_invite_links WHERE workspace_id = ? AND ${audited}`).bind(workspaceId, auditId),
      c.env.DB.query<never>(`DELETE FROM workspace_join_requests WHERE workspace_id = ? AND ${audited}`).bind(workspaceId, auditId),
      c.env.DB.query<never>(`UPDATE sessions SET policy_version = policy_version + 1 WHERE workspace_id = ? AND ${audited}`).bind(workspaceId, auditId),
    ]);
    if (result[1]!.changes !== 1) fail(409, 'workspace_changed', 'The workspace changed. Refresh and try again.');
    return c.json({ workspace: await requireOwnDeleted(c.env, workspaceId, actorId) });
  });

  app.get('/api/deleted-workspaces', async c => {
    const rows = await deletedStatement(c.env, c.get('auth').userId, null).all();
    return c.json({ workspaces: rows.map(deletedWorkspace) });
  });

  app.post('/api/deleted-workspaces/:id/restore', async c => {
    const workspaceId = identifier(c.req.param('id'), 'workspaceId');
    const actorId = c.get('auth').userId;
    await requireOwnDeleted(c.env, workspaceId, actorId);
    const auditId = id();
    const result = await c.env.DB.batch<never>([
      lockWorkspace(c.env, workspaceId, actorId),
      c.env.DB.query<never>(`INSERT INTO audit (id, workspace_id, session_id, actor_id, action, detail_json, created_at)
        SELECT ?, ?, NULL, ?, 'workspace.restored', '{}', ? WHERE ${ownedDeleted}`).bind(auditId, workspaceId, actorId, now(), workspaceId, actorId),
      c.env.DB.query<never>(`INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
        SELECT workspace_id, user_id, role, created_at FROM deleted_workspace_members WHERE workspace_id = ? AND ${audited}
        ON CONFLICT (workspace_id, user_id) DO NOTHING`).bind(workspaceId, auditId),
      c.env.DB.query<never>(`DELETE FROM deleted_workspaces WHERE workspace_id = ? AND ${audited}`).bind(workspaceId, auditId),
      c.env.DB.query<never>(`UPDATE sessions SET policy_version = policy_version + 1 WHERE workspace_id = ? AND ${audited}`).bind(workspaceId, auditId),
    ]);
    if (result[3]!.changes !== 1) fail(409, 'workspace_changed', 'The workspace changed. Refresh and try again.');
    const workspace = await c.env.DB.query<Omit<Workspace, 'personal'>>(`SELECT w.id, w.name, w.owner_id AS ownerId, m.role FROM workspaces w
      JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = ? WHERE w.id = ?`).bind(actorId, workspaceId).first();
    if (!workspace) fail(409, 'workspace_changed', 'The workspace changed. Refresh and try again.');
    return c.json({ workspace: { ...workspace, personal: false } satisfies Workspace });
  });

  app.delete('/api/deleted-workspaces/:id', async c => {
    const workspaceId = identifier(c.req.param('id'), 'workspaceId');
    const actorId = c.get('auth').userId;
    const deleted = await requireOwnDeleted(c.env, workspaceId, actorId);
    if (deleted.sessions > 0) {
      fail(409, 'workspace_in_use', 'This workspace has sessions, archived ones included, which are kept with their backups and history, so it can only stay deleted, not be deleted for good.');
    }
    const auditId = id();
    let result: { changes: number }[];
    try {
      result = await c.env.DB.batch([
        lockWorkspace(c.env, workspaceId, actorId),
        c.env.DB.query<never>(`INSERT INTO audit (id, workspace_id, session_id, actor_id, action, detail_json, created_at)
          SELECT ?, NULL, NULL, ?, 'workspace.purged', ?, ? WHERE ${ownedDeleted} AND NOT EXISTS (SELECT 1 FROM sessions WHERE workspace_id = ?)`)
          .bind(auditId, actorId, JSON.stringify({ workspaceId, name: deleted.name }), now(), workspaceId, actorId, workspaceId),
        c.env.DB.query<never>(`UPDATE audit SET workspace_id = NULL WHERE workspace_id = ? AND ${audited}`).bind(workspaceId, auditId),
        c.env.DB.query<never>(`UPDATE connector_pairings SET workspace_id = NULL WHERE workspace_id = ? AND ${audited}`).bind(workspaceId, auditId),
        c.env.DB.query<never>(`DELETE FROM workspaces WHERE id = ? AND ${audited}`).bind(workspaceId, auditId),
      ]);
    } catch (error) {
      if (error instanceof ConstraintError) fail(409, 'workspace_in_use', 'Something else still uses this workspace, such as an agent on one of its models, so it can only stay deleted, not be deleted for good.');
      throw error;
    }
    if (result[4]!.changes !== 1) fail(409, 'workspace_changed', 'The workspace changed. Refresh and try again.');
    return c.body(null, 204);
  });
}
