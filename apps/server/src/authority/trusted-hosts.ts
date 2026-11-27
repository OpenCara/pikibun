import type { Hono } from 'hono';
import type { TrustedHostsResponse } from '../../../../packages/shared/src/trusted-hosts.js';
import type { Database } from '../db/types.js';
import type { AppEnv } from '../types.js';
import { auditStatement } from './audit.js';
import { fail, identifier, now } from '../http.js';

export async function ownerTrustsHost(db: Pick<Database, 'query'>, ownerId: string, connectorId: string | null | undefined,
  hostOwnerId: string | null | undefined): Promise<boolean> {
  if (!connectorId || !hostOwnerId || hostOwnerId === ownerId) return false;
  const row = await db.query<{ trusted: number }>(`SELECT 1 AS trusted FROM member_trusted_hosts t
    JOIN connectors c ON c.id = t.connector_id AND c.owner_id = t.host_owner_id
    WHERE t.user_id = ? AND t.connector_id = ? AND t.host_owner_id = ? AND c.revoked_at IS NULL AND c.removed_at IS NULL`)
    .bind(ownerId, connectorId, hostOwnerId).first();
  return row !== null;
}

export async function trustedHosts(db: Pick<Database, 'query'>, userId: string): Promise<TrustedHostsResponse> {
  const rows = await db.query<{ connector_id: string; created_at: string }>(`SELECT t.connector_id, t.created_at FROM member_trusted_hosts t
    JOIN connectors c ON c.id = t.connector_id AND c.owner_id = t.host_owner_id
    WHERE t.user_id = ? AND c.revoked_at IS NULL AND c.removed_at IS NULL ORDER BY t.created_at, t.connector_id`).bind(userId).all();
  return { hosts: rows.map(row => ({ connectorId: row.connector_id, trustedAt: row.created_at })) };
}

export function registerTrustedHosts(app: Hono<AppEnv>): void {
  app.get('/api/trusted-hosts', async c => c.json(await trustedHosts(c.env.DB, c.get('auth').userId)));
  app.put('/api/trusted-hosts/:connectorId', async c => {
    const connectorId = identifier(c.req.param('connectorId'), 'connectorId');
    const actor = c.get('auth').userId;
    const saved = await c.env.DB.query<{ connector_id: string }>(`INSERT INTO member_trusted_hosts (user_id, connector_id, host_owner_id, created_at)
      SELECT ?, c.id, c.owner_id, ? FROM connectors c
      WHERE c.id = ? AND c.owner_id <> ? AND c.revoked_at IS NULL AND c.removed_at IS NULL
        AND EXISTS (SELECT 1 FROM connector_shares sh
          JOIN workspace_members actor ON actor.workspace_id = sh.workspace_id AND actor.user_id = ?
          JOIN workspace_members host ON host.workspace_id = sh.workspace_id AND host.user_id = c.owner_id
          WHERE sh.connector_id = c.id)
      ON CONFLICT (user_id, connector_id) DO UPDATE SET host_owner_id = excluded.host_owner_id
      RETURNING connector_id`).bind(actor, now(), connectorId, actor, actor).first();
    if (!saved) fail(404, 'not_found', 'No host by that id is shared with you by another member.');
    await auditStatement(c.env, actor, 'host.trusted', null, null, { connectorId }).run();
    return c.json(await trustedHosts(c.env.DB, actor));
  });
  app.delete('/api/trusted-hosts/:connectorId', async c => {
    const connectorId = identifier(c.req.param('connectorId'), 'connectorId');
    const actor = c.get('auth').userId;
    const removed = await c.env.DB.query('DELETE FROM member_trusted_hosts WHERE user_id = ? AND connector_id = ?').bind(actor, connectorId).run();
    if (removed.changes > 0) await auditStatement(c.env, actor, 'host.untrusted', null, null, { connectorId }).run();
    return c.json(await trustedHosts(c.env.DB, actor));
  });
}
