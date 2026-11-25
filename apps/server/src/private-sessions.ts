import type { Hono } from 'hono';
import { PRIVATE_REPORT_LIMIT, PRIVATE_SESSIONS_VERSION } from '../../../packages/shared/src/private-sessions.js';
import { permissions } from '../../../packages/shared/src/types.js';
import { ensurePersonalWorkspace } from './catalog.js';
import { sessionRecord } from './db.js';
import { z } from 'zod';
import { fail, localMode } from './http.js';
import { body, fields, text } from './schemas.js';
import { createSession } from './sessions.js';
import type { AppContext, AppEnv, SessionRow } from './types.js';

const createBody = fields({
  provider: text('provider', 80), modelId: text('modelId', 200), title: z.string({ error: 'Invalid title.' }).max(200, 'Invalid title.').optional(),
  hostEnvironment: z.boolean({ error: 'hostEnvironment must be true or false.' }).optional(),
  hostDirectory: z.string({ error: 'Invalid hostDirectory.' }).max(1024, 'Invalid hostDirectory.').optional(),
  generateTitle: z.boolean({ error: 'generateTitle must be true or false.' }).optional(),
}, 'A private session starts from a provider, a model and, optionally, a title.', { required: ['provider', 'modelId'] });

async function privateWorkspace(c: AppContext): Promise<string> {
  if (!localMode(c.env)) fail(404, 'not_found', 'API route not found.');
  await ensurePersonalWorkspace(c.env, c.get('auth').userId);
  const workspaceId = await c.env.DB.query<{ workspace_id: string }>('SELECT workspace_id FROM personal_workspaces WHERE user_id = ?')
    .bind(c.get('auth').userId).first('workspace_id');
  if (!workspaceId) fail(409, 'no_private_workspace', 'This Pikibun has no private workspace yet: open it once.');
  return workspaceId;
}

export function registerPrivateSessions(app: Hono<AppEnv>): void {
  app.get('/api/private-sessions', async c => {
    const workspaceId = await privateWorkspace(c);
    const rows = await c.env.DB.query<SessionRow>(`SELECT * FROM sessions WHERE workspace_id = ? AND owner_id = ?
      ORDER BY created_at DESC, id LIMIT ?`).bind(workspaceId, c.get('auth').userId, PRIVATE_REPORT_LIMIT).all();
    return c.json({ version: PRIVATE_SESSIONS_VERSION, sessions: rows.map(row => sessionRecord(row, [...permissions])) });
  });

  app.post('/api/private-sessions', async c => {
    const workspaceId = await privateWorkspace(c);
    const { provider, modelId, ...rest } = await body(c, createBody, { maxBytes: 16 * 1024 });
    const model = await c.env.DB.query<{ id: string }>(`SELECT m.id FROM models m JOIN connectors h ON h.id = m.connector_id AND h.revoked_at IS NULL
      WHERE m.workspace_id = ? AND m.provider = ? AND m.model_id = ? AND m.available = 1 AND m.connector_owner_id = ?
      ORDER BY m.created_at, m.id LIMIT 1`).bind(workspaceId, provider, modelId, c.get('auth').userId).first();
    if (!model) fail(409, 'model_unavailable', 'This computer doesn\'t offer that model: choose another, or check Pi\'s configuration on the computer.');
    const { row, notice } = await createSession(c, { ...rest, workspaceId, modelId: model.id });
    return c.json({ session: { ...sessionRecord(row, [...permissions]), ...(notice ? { cloneUnavailable: notice } : {}) } }, 201);
  });
}
