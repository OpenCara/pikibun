import type { Hono } from 'hono';
import { parseCapabilities } from '../../../packages/shared/src/connector.js';
import type { ConnectorCapabilities, HostModelSettings, LocalModelSummary } from '../../../packages/shared/src/connector.js';
import type { ChatOptions } from '../../../packages/shared/src/types.js';
import type { AppContext, Env, SessionRow, AppEnv } from './types.js';
import { auditAfterChange, managedConnector, managedConnectorFor, managesConnectorSQL } from './authority/index.js';
import { fail, jsonObject, now, text } from './http.js';

const maxDisabledModels = 1000;

const modelKey = (provider: string, modelId: string) => JSON.stringify([provider, modelId]);

export function modelEnabledSQL(connector: string, model: string): string {
  return `NOT EXISTS (SELECT 1 FROM connector_disabled_models off
    WHERE off.connector_id = ${connector} AND off.provider = ${model}.provider AND off.model_id = ${model}.model_id)`;
}

export async function disabledModelKeys(env: Env, connectorId: string): Promise<Set<string>> {
  const rows = await env.DB.query<{ provider: string; model_id: string }>('SELECT provider, model_id FROM connector_disabled_models WHERE connector_id = ?')
    .bind(connectorId).all();
  return new Set(rows.map(row => modelKey(row.provider, row.model_id)));
}

export function hostModelSettings(models: readonly LocalModelSummary[], disabled: ReadonlySet<string>): HostModelSettings {
  const off = (model: LocalModelSummary) => disabled.has(modelKey(model.provider, model.modelId));
  return { models: models.filter(model => !off(model)), disabledModels: models.filter(off) };
}

export function isModelDisabled(disabled: ReadonlySet<string>, model: { provider: string; modelId: string }): boolean {
  return disabled.has(modelKey(model.provider, model.modelId));
}

export async function requireEnabledModel(c: AppContext, row: SessionRow, options: ChatOptions | undefined): Promise<void> {
  if (!row.connector_id || options?.model) return;
  const host = await hostDisabledModels(c.env, row);
  if (!host) return;
  const { disabled } = host;
  if (!disabled.length) return;
  if (host.switchesModels) {
    fail(409, 'model_required', 'Some of this host\'s models are disabled, so each message names the model it runs on. Choose a model and send it again.');
  }
  const own = await c.env.DB.query<{ provider: string; model_id: string }>(`SELECT m.provider, m.model_id FROM agent_versions a
    JOIN models m ON m.id = a.model_id WHERE a.id = ?`).bind(row.agent_version_id).first();
  if (own && disabled.some(model => model.provider === own.provider && model.modelId === own.model_id)) {
    fail(409, 'model_disabled', 'This session\'s model is disabled on its host. Ask the host\'s owner or an admin to enable it.');
  }
}

async function hostDisabledModels(env: Env, row: SessionRow): Promise<{ disabled: LocalModelSummary[]; switchesModels: boolean } | null> {
  if (!row.connector_id) return null;
  const host = await env.DB.query<{ models_json: string; capabilities_json: string }>('SELECT models_json, capabilities_json FROM connectors WHERE id = ?')
    .bind(row.connector_id).first();
  if (!host) return null;
  return {
    disabled: hostModelSettings(JSON.parse(host.models_json) as LocalModelSummary[], await disabledModelKeys(env, row.connector_id)).disabledModels,
    switchesModels: parseCapabilities(host.capabilities_json).chatOptions === true,
  };
}

export async function messageNeedsModel(env: Env, row: SessionRow): Promise<boolean> {
  const host = await hostDisabledModels(env, row);
  return !!host && host.switchesModels && host.disabled.length > 0;
}

export function registerHostModels(app: Hono<AppEnv>): void {
  app.patch('/api/connectors/:id/models', async c => {
    const actorId = c.get('auth').userId;
    const row = await managedConnector(c);
    if (row.revoked_at) fail(409, 'connector_revoked', 'Connector is revoked.');
    const input = await jsonObject(c, 4096);
    if (Object.keys(input).some(field => !['provider', 'modelId', 'enabled'].includes(field)) || typeof input.enabled !== 'boolean') {
      fail(400, 'invalid_model_setting', 'Name the model by provider and modelId, and set enabled to true or false.');
    }
    const provider = text(input.provider, 'provider', 80);
    const modelId = text(input.modelId, 'modelId', 200);
    const enabled = input.enabled;
    const detail = { connectorId: row.id, provider, modelId };
    const live = `c.id = ? AND c.revoked_at IS NULL AND c.removed_at IS NULL AND ${managesConnectorSQL}`;
    await c.env.DB.batch(enabled ? [
      c.env.DB.query(`DELETE FROM connector_disabled_models WHERE connector_id = ? AND provider = ? AND model_id = ?
        AND EXISTS (SELECT 1 FROM connectors c WHERE ${live})`)
        .bind(row.id, provider, modelId, row.id, actorId, actorId),
      auditAfterChange(c.env, actorId, 'connector.model.enabled', null, detail),
    ] : [
      c.env.DB.query(`INSERT INTO connector_disabled_models (connector_id, provider, model_id, disabled_by, disabled_at)
        SELECT c.id, ?, ?, ?, ? FROM connectors c WHERE ${live}
          AND EXISTS (SELECT 1 FROM json_each(c.models_json) local
            WHERE json_extract(local.value, '$.provider') = ? AND json_extract(local.value, '$.modelId') = ?)
          AND (SELECT COUNT(*) FROM connector_disabled_models WHERE connector_id = c.id) < ?
        ON CONFLICT (connector_id, provider, model_id) DO NOTHING`)
        .bind(provider, modelId, actorId, now(), row.id, actorId, actorId, provider, modelId, maxDisabledModels),
      auditAfterChange(c.env, actorId, 'connector.model.disabled', null, detail),
    ]);
    const current = await managedConnectorFor(c.env, row.id, actorId);
    if (!current) fail(404, 'not_found', 'Connector not found.');
    if (current.revoked_at) fail(409, 'connector_revoked', 'Connector is revoked.');
    const advertised = JSON.parse(current.models_json) as LocalModelSummary[];
    const disabled = await disabledModelKeys(c.env, current.id);
    if (!enabled && !isModelDisabled(disabled, { provider, modelId })) {
      if (!advertised.some(model => model.provider === provider && model.modelId === modelId)) fail(404, 'model_not_on_host', 'This host doesn\'t offer that model.');
      fail(409, 'model_limit', `A host keeps at most ${maxDisabledModels} disabled models.`);
    }
    return c.json(hostModelSettings(advertised, disabled));
  });
}
