import { workspaceAdminSQL } from './authority/index.js';
import type { Hono } from 'hono';
import type { ChildSessionSettings } from '../../../packages/shared/src/cross-session.js';
import type { Database } from './db/types.js';
import type { AppEnv } from './types.js';
import { auditStatement, requireMember } from './authority/index.js';
import { z } from 'zod';
import { fail, identifier, now } from './http.js';
import { body } from './schemas.js';

const adminSql = workspaceAdminSQL;

export async function workspaceChildSessionSettings(db: Database, workspaceId: string): Promise<ChildSessionSettings> {
  const row = await db.query<{ child_models: number }>('SELECT child_models FROM workspace_child_session_settings WHERE workspace_id = ?')
    .bind(workspaceId).first();
  return { childModels: Number(row?.child_models ?? 1) === 1 };
}

export function registerChildSessionSettings(app: Hono<AppEnv>): void {
  app.get('/api/workspaces/:id/child-sessions', async c => {
    const workspaceId = identifier(c.req.param('id'));
    await requireMember(c.env, workspaceId, c.get('auth').userId);
    return c.json({ settings: await workspaceChildSessionSettings(c.env.DB, workspaceId) });
  });
  app.put('/api/workspaces/:id/child-sessions', async c => {
    const workspaceId = identifier(c.req.param('id'));
    const actor = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    const { childModels: enabled } = await body(c, z.strictObject({ childModels: z.boolean() }), { maxBytes: 1024, message: 'Set childModels to true or false.' });
    const saved = await c.env.DB.query<{ child_models: number }>(`INSERT INTO workspace_child_session_settings
        (workspace_id, child_models, updated_by, updated_at)
      SELECT ?,?,?,? WHERE ${adminSql}
      ON CONFLICT (workspace_id) DO UPDATE SET child_models = excluded.child_models,
        updated_by = excluded.updated_by, updated_at = excluded.updated_at WHERE ${adminSql}
      RETURNING child_models`).bind(workspaceId, enabled ? 1 : 0, actor, now(), workspaceId, actor, workspaceId, actor).first();
    if (!saved) fail(403, 'forbidden', 'Workspace administrator access is required.');
    await auditStatement(c.env, actor, 'workspace.child_sessions.updated', workspaceId, null, { childModels: enabled }).run();
    return c.json({ settings: { childModels: Number(saved.child_models) === 1 } satisfies ChildSessionSettings });
  });
}
