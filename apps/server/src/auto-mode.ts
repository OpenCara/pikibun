import type { Hono } from 'hono';
import { z } from 'zod';
import {
  AUTO_MODE_SELECTION_LIMIT, AUTO_TASK_LIMIT, autoChoice, autoModeModels, autoModeOn, autoModelsText, autoModelUsable, type MemberAutoModels,
} from '../../../packages/shared/src/auto-mode.js';
import type { Database } from './db/types.js';
import type { Env, AppEnv } from './types.js';
import { auditStatement, requireMember, workspaceExtensions } from './authority/index.js';
import { usableModels } from './catalog.js';
import { workspaceConnectorInfos } from './connectors.js';
import { fail, identifier, now } from './http.js';
import { body, identifier as identifierField, text } from './schemas.js';

const modelField = z.strictObject({ provider: text('provider', 80), modelId: text('modelId', 200) }, { error: 'Invalid model.' });

const choiceRequest = z.strictObject({
  task: z.string({ error: 'Invalid task.' }).max(AUTO_TASK_LIMIT, 'Invalid task.'),
  connectorId: identifierField('connectorId').optional(),
  model: modelField.optional(),
}, { error: 'Ask with the task, and optionally the connectorId or model to keep.' });

const selectionRequest = z.strictObject({
  models: z.array(z.string().trim().min(3).max(281).regex(/^[^/\x00-\x1f\x7f]+\/[^\x00-\x1f\x7f]+$/), { error: 'Invalid model.' })
    .min(1).max(AUTO_MODE_SELECTION_LIMIT).nullable(),
});

function parseSelection(value: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length && parsed.every(item => typeof item === 'string') ? parsed as string[] : null;
  } catch {
    return null;
  }
}

export async function memberAutoModels(db: Database, workspaceId: string, userId: string): Promise<string[] | null> {
  const row = await db.query<{ models_json: string }>('SELECT models_json FROM member_auto_models WHERE workspace_id = ? AND user_id = ?')
    .bind(workspaceId, userId).first();
  return row ? parseSelection(row.models_json) : null;
}

export function autoModelsLimit(settings: { models: string[] | undefined; selected: string[] | null }): string {
  const parts = [
    ...(settings.selected ? [`the models you chose for Auto in this workspace (${settings.selected.join(', ')})`] : []),
    ...(settings.models ? [`the models its models setting names here (${autoModelsText(settings.models)})`] : []),
  ];
  return parts.join(' that are also among ');
}

export async function autoModeEnabled(env: Env, workspaceId: string): Promise<boolean> {
  return autoModeOn(await workspaceExtensions(env, workspaceId));
}

export async function autoModeSettings(env: Env, workspaceId: string, userId: string): Promise<{ enabled: boolean; models: string[] | undefined; selected: string[] | null }> {
  const [extensions, selected] = await Promise.all([workspaceExtensions(env, workspaceId), memberAutoModels(env.DB, workspaceId, userId)]);
  return { enabled: autoModeOn(extensions), models: autoModeModels(extensions), selected };
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

  app.get('/api/workspaces/:id/auto-mode/models', async c => {
    const workspaceId = identifier(c.req.param('id'));
    const userId = c.get('auth').userId;
    await requireMember(c.env, workspaceId, userId);
    const settings = await autoModeSettings(c.env, workspaceId, userId);
    return c.json({ settings: { selected: settings.selected, workspace: settings.models ?? null } satisfies MemberAutoModels });
  });

  app.put('/api/workspaces/:id/auto-mode/models', async c => {
    const workspaceId = identifier(c.req.param('id'));
    const actor = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actor);
    const { models } = await body(c, selectionRequest, { maxBytes: 64 * 1024,
      message: 'Set models to a list of provider/modelId keys, at least one, or to null for every model auto mode may choose here.' });
    const selected = models ? [...new Set(models)] : null;
    if (selected) {
      const saved = await c.env.DB.query<{ models_json: string }>(`INSERT INTO member_auto_models (workspace_id, user_id, models_json, updated_at)
        SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?)
        ON CONFLICT (workspace_id, user_id) DO UPDATE SET models_json = excluded.models_json, updated_at = excluded.updated_at
        RETURNING models_json`).bind(workspaceId, actor, JSON.stringify(selected), now(), workspaceId, actor).first();
      if (!saved) fail(404, 'not_found', 'Workspace not found.');
    } else {
      await c.env.DB.query<never>('DELETE FROM member_auto_models WHERE workspace_id = ? AND user_id = ?').bind(workspaceId, actor).run();
    }
    await auditStatement(c.env, actor, 'workspace.auto_models.updated', workspaceId, null, { models: selected }).run();
    const extensions = await workspaceExtensions(c.env, workspaceId);
    return c.json({ settings: { selected, workspace: autoModeModels(extensions) ?? null } satisfies MemberAutoModels });
  });

  app.post('/api/workspaces/:id/auto-mode', async c => {
    const workspaceId = identifier(c.req.param('id'));
    const userId = c.get('auth').userId;
    await requireMember(c.env, workspaceId, userId);
    const input = await body(c, choiceRequest, { maxBytes: AUTO_TASK_LIMIT * 4 + 4096 });
    const settings = await autoModeSettings(c.env, workspaceId, userId);
    if (!settings.enabled) fail(409, 'auto_mode_off', 'Auto mode is off in this workspace: its owners and admins add it under Extensions.');
    const [hosts, models] = await Promise.all([workspaceConnectorInfos(c.env, workspaceId, userId), usableModels(c.env, workspaceId, userId)]);
    const offered = new Set(models.flatMap(model => model.connector_id ? [JSON.stringify([model.connector_id, model.provider, model.model_id])] : []));
    const working = await workingSessions(c.env, hosts.filter(host => host.online).map(host => host.id));
    const choice = autoChoice({
      task: input.task, userId, workspaceId, hosts, working,
      usable: (host, model) => offered.has(JSON.stringify([host.id, model.provider, model.modelId])) && autoModelUsable(settings, model),
      ...(input.connectorId ? { connectorId: input.connectorId } : {}),
      ...(input.model ? { model: input.model } : {}),
    });
    if (!choice) {
      const limited = settings.models || settings.selected ? ` Auto mode may choose only ${autoModelsLimit(settings)}.` : '';
      fail(409, 'auto_mode_unavailable', (input.connectorId || input.model
        ? 'No online host offers what you kept: choose another host or model, or Auto for both.'
        : 'No host shared with this workspace is online with a model you can use.') + limited);
    }
    const model = models.find(item => item.connector_id === choice.connectorId && item.provider === choice.provider && item.model_id === choice.modelId);
    return c.json({ choice: { ...choice, ...(model ? { id: model.id } : {}) } });
  });
}
