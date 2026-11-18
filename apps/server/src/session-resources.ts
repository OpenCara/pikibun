import type { Hono } from 'hono';
import { parseSessionResources, type SessionResourcesView } from '../../../packages/shared/src/session-resources.js';
import { hostCapabilities, requireSession } from './authority/index.js';
import { fail, identifier } from './http.js';
import { runnerJSON, runnerRequest } from './runner.js';
import type { AppEnv } from './types.js';

export function registerSessionResources(app: Hono<AppEnv>): void {
  app.get('/api/sessions/:id/resources', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'read');
    c.header('Cache-Control', 'no-store');
    const none = { resources: null as SessionResourcesView | null };
    if (row.status === 'archived' || row.packed_at) return c.json(none);
    if (row.connector_id && (await hostCapabilities(c.env, row.connector_id))?.sessionResources !== true) return c.json(none);
    const result = await runnerJSON<{ resources?: unknown }>(await runnerRequest(c, row, 'resources', '', {}));
    const resources = parseSessionResources(result?.resources);
    if (!resources) fail(502, 'invalid_runner_response', 'The runner returned invalid resource use.');
    return c.json({ resources });
  });
}
