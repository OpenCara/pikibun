import type { Hono } from 'hono';
import { z } from 'zod';
import { defaultHostAccount, type HostAccountSettings } from '../../../../packages/shared/src/host-account.js';
import type { Database } from '../db/types.js';
import type { AppEnv } from '../types.js';
import { requireMember } from './access.js';
import { auditStatement } from './audit.js';
import { fail, identifier, now } from '../http.js';
import { body } from '../schemas.js';

export async function memberHostAccount(db: Database, workspaceId: string, userId: string): Promise<HostAccountSettings> {
  const row = await db.query<{ others_hosts: number }>('SELECT others_hosts FROM member_host_account WHERE workspace_id = ? AND user_id = ?')
    .bind(workspaceId, userId).first();
  return row ? { othersHosts: Number(row.others_hosts) === 1 } : { ...defaultHostAccount };
}

export async function ownerAccountServesOthersHosts(db: Database, workspaceId: string, ownerId: string): Promise<boolean> {
  return (await memberHostAccount(db, workspaceId, ownerId)).othersHosts;
}

export function registerHostAccount(app: Hono<AppEnv>): void {
  app.get('/api/workspaces/:id/host-account', async c => {
    const workspaceId = identifier(c.req.param('id'));
    const actor = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actor);
    return c.json({ settings: await memberHostAccount(c.env.DB, workspaceId, actor) });
  });
  app.put('/api/workspaces/:id/host-account', async c => {
    const workspaceId = identifier(c.req.param('id'));
    const actor = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actor);
    const { othersHosts } = await body(c, z.strictObject({ othersHosts: z.boolean() }), { maxBytes: 1024, message: 'Set othersHosts to true or false.' });
    const saved = await c.env.DB.query<{ others_hosts: number }>(`INSERT INTO member_host_account (workspace_id, user_id, others_hosts, updated_at)
      SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?)
      ON CONFLICT (workspace_id, user_id) DO UPDATE SET others_hosts = excluded.others_hosts, updated_at = excluded.updated_at
      RETURNING others_hosts`).bind(workspaceId, actor, othersHosts ? 1 : 0, now(), workspaceId, actor).first();
    if (!saved) fail(404, 'not_found', 'Workspace not found.');
    await auditStatement(c.env, actor, 'workspace.host_account.updated', workspaceId, null, { othersHosts }).run();
    return c.json({ settings: { othersHosts: Number(saved.others_hosts) === 1 } satisfies HostAccountSettings });
  });
}
