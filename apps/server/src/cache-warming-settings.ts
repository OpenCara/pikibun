import type { Hono } from 'hono';
import { z } from 'zod';
import { cacheWarmingModes, defaultCacheWarmingMode, isCacheWarmingMode, sessionCacheWarmingMode, type CacheWarmingMode, type CacheWarmingSettings, type SessionCacheWarming } from '../../../packages/shared/src/cache-warming.js';
import type { Database } from './db/types.js';
import type { AppEnv, SessionRow } from './types.js';
import { connectorHostConfig } from './host-config.js';
import { auditStatement, authenticateConnector, requireCallbackScope, requireMember, workspaceAdminSQL } from './authority/index.js';
import { fail, identifier, now } from './http.js';
import { body } from './schemas.js';

export async function workspaceCacheWarming(db: Database, workspaceId: string): Promise<CacheWarmingSettings> {
  const row = await db.query<{ mode: string }>('SELECT mode FROM workspace_cache_warming_settings WHERE workspace_id = ?').bind(workspaceId).first();
  return { mode: isCacheWarmingMode(row?.mode) ? row.mode : defaultCacheWarmingMode };
}

export function registerConnectorCacheWarming(app: Hono<AppEnv>): void {
  app.post('/api/connectors/self/cache-warming', async c => {
    const connector = await authenticateConnector(c);
    const { sessionId } = await body(c, z.strictObject({ sessionId: z.string() }), { maxBytes: 1024, message: 'Name the session.' });
    const row = await c.env.DB.query<SessionRow>('SELECT * FROM sessions WHERE id = ?').bind(identifier(sessionId, 'sessionId')).first();
    if (!row) fail(404, 'not_found', 'Session not found.');
    await requireCallbackScope(c, row, connector.id);
    const [{ mode }, host] = await Promise.all([workspaceCacheWarming(c.env.DB, row.workspace_id), connectorHostConfig(c.env, connector.id)]);
    return c.json({ mode: sessionCacheWarmingMode(mode, host), child: !!row.parent_session_id } satisfies SessionCacheWarming);
  });
}

export function registerCacheWarmingSettings(app: Hono<AppEnv>): void {
  app.get('/api/workspaces/:id/cache-warming', async c => {
    const workspaceId = identifier(c.req.param('id'));
    await requireMember(c.env, workspaceId, c.get('auth').userId);
    return c.json({ settings: await workspaceCacheWarming(c.env.DB, workspaceId) });
  });
  app.put('/api/workspaces/:id/cache-warming', async c => {
    const workspaceId = identifier(c.req.param('id'));
    const actor = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    const { mode } = await body(c, z.strictObject({ mode: z.enum(cacheWarmingModes) }), { maxBytes: 1024, message: 'Set mode to idle, streaming or off.' });
    const saved = await c.env.DB.query<{ mode: string }>(`INSERT INTO workspace_cache_warming_settings (workspace_id, mode, updated_by, updated_at)
      SELECT ?,?,?,? WHERE ${workspaceAdminSQL}
      ON CONFLICT (workspace_id) DO UPDATE SET mode = excluded.mode, updated_by = excluded.updated_by, updated_at = excluded.updated_at WHERE ${workspaceAdminSQL}
      RETURNING mode`).bind(workspaceId, mode, actor, now(), workspaceId, actor, workspaceId, actor).first();
    if (!saved || !isCacheWarmingMode(saved.mode)) fail(403, 'forbidden', 'Workspace administrator access is required.');
    await auditStatement(c.env, actor, 'workspace.cache_warming.updated', workspaceId, null, { mode }).run();
    return c.json({ settings: { mode: saved.mode as CacheWarmingMode } satisfies CacheWarmingSettings });
  });
}
