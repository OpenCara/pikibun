import { documentSourceExtensionOf, neededExtensions, pikiExtensionsFor, pikiSessionToolExtensions } from '../../../../packages/shared/src/piki-extensions.js';
import { defaultWorkspaceExtensions, starterWorkspaceExtensions, extensionLimits, extensionPackageKey, isExtensionIntegrity, withSessionToolsListed, type ExtensionToolMode, type WorkspaceExtension } from '../../../../packages/shared/src/host-extensions.js';
import type { DocumentKind } from '../../../../packages/shared/src/sources.js';
import type { Env } from '../types.js';
import { now } from '../http.js';
import { auditStatement } from './audit.js';
import { workspaceAdminSQL } from './access.js';
import type { Database, Query } from '../db/types.js';

interface ExtensionRow { source: string; enabled: number | string; tools_mode: ExtensionToolMode; settings_json: string; integrity: string | null }

export async function workspaceExtensions(env: Env, workspaceId: string): Promise<WorkspaceExtension[]> {
  const rows = await env.DB.query<ExtensionRow>(`SELECT source, enabled, tools_mode, settings_json, integrity FROM workspace_extensions
    WHERE workspace_id = ? ORDER BY position, package_key`).bind(workspaceId).all();
  return withSessionToolsListed(rows.map(row => ({
    source: row.source,
    enabled: Number(row.enabled) === 1,
    tools: 'automatic' as const,
    settings: JSON.parse(row.settings_json),
    ...(row.source.startsWith('npm:') && isExtensionIntegrity(row.integrity) ? { integrity: row.integrity } : {}),
  })));
}

export async function workspaceExtensionLock(env: Env, workspaceId: string, packageKey: string): Promise<{ source: string; integrity: string | null } | null> {
  return env.DB.query<{ source: string; integrity: string | null }>(
    'SELECT source, integrity FROM workspace_extensions WHERE workspace_id = ? AND package_key = ?')
    .bind(workspaceId, packageKey).first();
}

export type AutoCacheChoice = 'on' | 'off' | 'host';

export async function connectorExtensionSettings(env: Env, connectorId: string): Promise<{ automaticTools: boolean; autoCache: AutoCacheChoice }> {
  const row = await env.DB.query<{ automatic_tools: number | string; auto_cache: number | string; auto_cache_off: number | string }>(
    'SELECT automatic_tools, auto_cache, auto_cache_off FROM connector_extension_settings WHERE connector_id = ?')
    .bind(connectorId).first();
  const autoCache: AutoCacheChoice = Number(row?.auto_cache_off) === 1 ? 'off' : Number(row?.auto_cache) === 1 ? 'on' : 'host';
  return { automaticTools: Number(row?.automatic_tools) === 1, autoCache };
}

export async function automaticTools(env: Env, connectorId: string): Promise<boolean> {
  return (await connectorExtensionSettings(env, connectorId)).automaticTools;
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

export async function addNeededExtensions(env: Env, workspaceId: string, source: string, actor: string): Promise<string[]> {
  const added: string[] = [];
  for (const needed of neededExtensions(source)) {
    if (await addPikiExtension(env, workspaceId, needed.source, actor, { sql: '1 = 1', values: [] }, { reason: 'needed', by: source })) added.push(needed.source);
  }
  return added;
}

export async function addDocumentSourceExtension(env: Env, workspaceId: string, kind: DocumentKind, actor: string): Promise<string[]> {
  const extension = documentSourceExtensionOf(kind);
  if (!extension) return [];
  const first = { sql: '(SELECT COUNT(*) FROM document_sources WHERE workspace_id = ? AND kind = ?) = 1', values: [workspaceId, kind] };
  return await addPikiExtension(env, workspaceId, extension.source, actor, first, { reason: 'source', kind }) ? [extension.source] : [];
}

export function defaultWorkspaceExtensionStatements(db: Pick<Database, 'query'>, workspaceId: string, ownerId: string, at: string): Query<never>[] {
  return defaultWorkspaceExtensions.map((source, index) => db.query<never>(`INSERT INTO workspace_extensions
      (workspace_id, package_key, source, position, enabled, tools_mode, settings_json, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, 'automatic', '{}', ?, ?)`)
    .bind(workspaceId, extensionPackageKey(source), source, index + 1, starterWorkspaceExtensions.includes(source) ? 1 : 0, ownerId, at));
}

export function saveWorkspaceExtensionStatement(db: Pick<Database, 'query'>, save: { workspaceId: string; extension: WorkspaceExtension; actor: string; at: string }): Query<{ package_key: string }> {
  const key = extensionPackageKey(save.extension.source);
  const sessionTool = sessionToolSources.includes(key);
  return db.query<{ package_key: string }>(`INSERT INTO workspace_extensions (workspace_id, package_key, source, position, enabled, tools_mode, settings_json, integrity, updated_by, updated_at)
    SELECT ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM workspace_extensions WHERE workspace_id = ?), ?, ?, ?, ?, ?, ?
    WHERE ${workspaceAdminSQL} AND (? = 1 OR (SELECT COUNT(*) FROM workspace_extensions WHERE workspace_id = ? AND package_key NOT IN (${sessionToolSources.map(() => '?').join(', ')})) < ?
      OR EXISTS (SELECT 1 FROM workspace_extensions WHERE workspace_id = ? AND package_key = ?))
    ON CONFLICT (workspace_id, package_key) DO UPDATE SET source = excluded.source, enabled = excluded.enabled, tools_mode = excluded.tools_mode,
      settings_json = excluded.settings_json,
      integrity = CASE WHEN workspace_extensions.source = excluded.source AND workspace_extensions.integrity IS NOT NULL THEN workspace_extensions.integrity ELSE excluded.integrity END,
      updated_by = excluded.updated_by, updated_at = excluded.updated_at
    RETURNING package_key`)
    .bind(save.workspaceId, key, save.extension.source, save.workspaceId, save.extension.enabled ? 1 : 0, save.extension.tools, JSON.stringify(save.extension.settings),
      save.extension.integrity ?? null, save.actor, save.at, save.workspaceId, save.actor, sessionTool ? 1 : 0, save.workspaceId, ...sessionToolSources,
      extensionLimits.workspace, save.workspaceId, key);
}

export function removeWorkspaceExtensionStatement(db: Pick<Database, 'query'>, workspaceId: string, key: string, actor: string): Query<{ source: string }> {
  return db.query<{ source: string }>(`DELETE FROM workspace_extensions WHERE workspace_id = ? AND package_key = ? AND ${workspaceAdminSQL} RETURNING source`)
    .bind(workspaceId, key, workspaceId, actor);
}
