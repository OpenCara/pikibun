import type { Hono } from 'hono';
import { z } from 'zod';
import { AUTO_TASK_LIMIT, autoChoice, autoModeOn } from '../../../packages/shared/src/auto-mode.js';
import type { Env, AppEnv } from './types.js';
import { requireMember, workspaceExtensions } from './authority/index.js';
import { usableModels } from './catalog.js';
import { workspaceConnectorInfos } from './connectors.js';
import { fail, identifier } from './http.js';
import { body, identifier as identifierField, text } from './schemas.js';

const modelField = z.strictObject({ provider: text('provider', 80), modelId: text('modelId', 200) }, { error: 'Invalid model.' });

const choiceRequest = z.strictObject({
  task: z.string({ error: 'Invalid task.' }).max(AUTO_TASK_LIMIT, 'Invalid task.'),
  connectorId: identifierField('connectorId').optional(),
  model: modelField.optional(),
}, { error: 'Ask with the task, and optionally the connectorId or model to keep.' });

export async function autoModeEnabled(env: Env, workspaceId: string): Promise<boolean> {
  return autoModeOn(await workspaceExtensions(env, workspaceId));
}

async function workingSessions(env: Env, connectorIds: readonly string[]): Promise<Record<string, number>> {
  if (!connectorIds.length) return {};
  const rows = await env.DB.query<{ connector_id: string; working: number | string }>(`SELECT connector_id, COUNT(*) AS working FROM sessions
    WHERE connector_id IN (${connectorIds.map(() => '?').join(', ')}) AND activity = 'working' AND status <> 'archived'
    GROUP BY connector_id`).bind(...connectorIds).all();
  return Object.fromEntries(rows.map(row => [row.connector_id, Number(row.working)]));
}

export function registerAutoMode(app: Hono<AppEnv>): void {
  app.get('/api/workspaces/:id/auto-mode', async c => {
    const workspaceId = identifier(c.req.param('id'));
    await requireMember(c.env, workspaceId, c.get('auth').userId);
    return c.json({ enabled: await autoModeEnabled(c.env, workspaceId) });
  });

  app.post('/api/workspaces/:id/auto-mode', async c => {
    const workspaceId = identifier(c.req.param('id'));
    const userId = c.get('auth').userId;
    await requireMember(c.env, workspaceId, userId);
    const input = await body(c, choiceRequest, { maxBytes: AUTO_TASK_LIMIT * 4 + 4096 });
    if (!await autoModeEnabled(c.env, workspaceId)) fail(409, 'auto_mode_off', 'Auto mode is off in this workspace: its owners and admins add it under Extensions.');
    const [hosts, models] = await Promise.all([workspaceConnectorInfos(c.env, workspaceId, userId), usableModels(c.env, workspaceId, userId)]);
    const offered = new Set(models.flatMap(model => model.connector_id ? [JSON.stringify([model.connector_id, model.provider, model.model_id])] : []));
    const working = await workingSessions(c.env, hosts.filter(host => host.online).map(host => host.id));
    const choice = autoChoice({
      task: input.task, userId, workspaceId, hosts, working,
      usable: (host, model) => offered.has(JSON.stringify([host.id, model.provider, model.modelId])),
      ...(input.connectorId ? { connectorId: input.connectorId } : {}),
      ...(input.model ? { model: input.model } : {}),
    });
    if (!choice) {
      fail(409, 'auto_mode_unavailable', input.connectorId || input.model
        ? 'No online host offers what you kept: choose another host or model, or Auto for both.'
        : 'No host shared with this workspace is online with a model you can use.');
    }
    const model = models.find(item => item.connector_id === choice.connectorId && item.provider === choice.provider && item.model_id === choice.modelId);
    return c.json({ choice: { ...choice, ...(model ? { id: model.id } : {}) } });
  });
}
