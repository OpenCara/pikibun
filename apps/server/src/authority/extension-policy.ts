import { documentSourceExtensionOf, pikiExtensionsFor, pikiSessionToolExtensions } from '../../../../packages/shared/src/piki-extensions.js';
import { extensionLimits, withSessionToolsListed, type ExtensionToolMode, type WorkspaceExtension } from '../../../../packages/shared/src/host-extensions.js';
import type { DocumentKind } from '../../../../packages/shared/src/sources.js';
import type { Env } from '../types.js';
import { now } from '../http.js';
import { auditStatement } from './audit.js';

interface ExtensionRow { source: string; enabled: number | string; tools_mode: ExtensionToolMode; settings_json: string }

export async function workspaceExtensions(env: Env, workspaceId: string): Promise<WorkspaceExtension[]> {
  const rows = await env.DB.query<ExtensionRow>(`SELECT source, enabled, tools_mode, settings_json FROM workspace_extensions
    WHERE workspace_id = ? ORDER BY position, package_key`).bind(workspaceId).all();
  return withSessionToolsListed(rows.map(row => ({ source: row.source, enabled: Number(row.enabled) === 1, tools: row.tools_mode, settings: JSON.parse(row.settings_json) })));
}

export async function automaticTools(env: Env, connectorId: string): Promise<boolean> {
  const row = await env.DB.query<{ automatic_tools: number | string }>('SELECT automatic_tools FROM connector_extension_settings WHERE connector_id = ?')
    .bind(connectorId).first();
  return Number(row?.automatic_tools) === 1;
}

export const sessionToolSources: readonly string[] = pikiSessionToolExtensions().map(item => item.source);

export async function sessionExtensionSources(env: Env, row: { workspace_id: string; owner_id: string; connector_owner_id?: string | null }): Promise<(source: string) => boolean> {
  const enabled = new Set((await workspaceExtensions(env, row.workspace_id)).filter(item => item.enabled).map(item => item.source));
  const ownHost = !!row.connector_owner_id && row.connector_owner_id === row.owner_id;
  return source => enabled.has(source) || (ownHost && source.startsWith('local:'));
}

async function addPikiExtension(env: Env, workspaceId: string, source: string, actor: string, first: { sql: string; values: string[] },
  detail: Record<string, string>): Promise<boolean> {
  const sessionTool = sessionToolSources.includes(source);
  const saved = await env.DB.query<{ source: string }>(`INSERT INTO workspace_extensions (workspace_id, package_key, source, position, enabled, tools_mode, settings_json, updated_by, updated_at)
    SELECT ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM workspace_extensions WHERE workspace_id = ?), 1, 'automatic', '{}', ?, ?
    WHERE ${first.sql}
      AND (? = 1 OR (SELECT COUNT(*) FROM workspace_extensions WHERE workspace_id = ? AND package_key NOT IN (${sessionToolSources.map(() => '?').join(', ')})) < ?)
    ON CONFLICT (workspace_id, package_key) DO NOTHING
    RETURNING source`)
    .bind(workspaceId, source, source, workspaceId, actor, now(), ...first.values, sessionTool ? 1 : 0, workspaceId, ...sessionToolSources, extensionLimits.workspace).first();
  if (!saved) return false;
  await auditStatement(env, actor, 'workspace.extension.updated', workspaceId, null,
    { source: saved.source, enabled: true, tools: 'automatic', settings: [], ...detail }).run();
  return true;
}

export async function addPikiExtensions(env: Env, workspaceId: string, provider: string, actor: string): Promise<string[]> {
  const added: string[] = [];
  for (const extension of pikiExtensionsFor(provider)) {
    const providers: string[] = [...extension.providers];
    const first = { sql: `(SELECT COUNT(*) FROM workspace_repositories WHERE workspace_id = ? AND provider IN (${providers.map(() => '?').join(', ')})) = 1`,
      values: [workspaceId, ...providers] };
    if (await addPikiExtension(env, workspaceId, extension.source, actor, first, { reason: 'repository', provider })) added.push(extension.source);
  }
  return added;
}

export async function addDocumentSourceExtension(env: Env, workspaceId: string, kind: DocumentKind, actor: string): Promise<string[]> {
  const extension = documentSourceExtensionOf(kind);
  if (!extension) return [];
  const first = { sql: '(SELECT COUNT(*) FROM document_sources WHERE workspace_id = ? AND kind = ?) = 1', values: [workspaceId, kind] };
  return await addPikiExtension(env, workspaceId, extension.source, actor, first, { reason: 'source', kind }) ? [extension.source] : [];
}

