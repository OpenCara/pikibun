import { pikiExtensionsFor, pikiSessionToolExtensions } from '../../../../packages/shared/src/piki-extensions.js';
import { extensionLimits, type ExtensionToolMode, type WorkspaceExtension } from '../../../../packages/shared/src/host-extensions.js';
import type { Env } from '../types.js';
import { now } from '../http.js';
import { auditStatement } from './audit.js';

/*
 * Extensions as policy: which extension tool calls a session may run at all, and which run without approval. The
 * workspace's owners and admins choose its extensions and their tool mode, and a host's owner whether workspaces may run
 * tools without approval there (extensions.ts, with the hosts' reports and installs); approvals and brokers read the
 * outcome here. Binding a workspace's first repository on a forge also adds that forge's Pikibun extensions, with approval.
 */

interface ExtensionRow { source: string; enabled: number | string; tools_mode: ExtensionToolMode; settings_json: string }

/** The workspace's extensions, in its order. */
export async function workspaceExtensions(env: Env, workspaceId: string): Promise<WorkspaceExtension[]> {
  const rows = await env.DB.query<ExtensionRow>(`SELECT source, enabled, tools_mode, settings_json FROM workspace_extensions
    WHERE workspace_id = ? ORDER BY position, package_key`).bind(workspaceId).all();
  return rows.map(row => ({ source: row.source, enabled: Number(row.enabled) === 1, tools: row.tools_mode, settings: JSON.parse(row.settings_json) }));
}

/** Whether the host's owner lets workspaces run extension tools without approval on it. */
export async function automaticTools(env: Env, connectorId: string): Promise<boolean> {
  const row = await env.DB.query<{ automatic_tools: number | string }>('SELECT automatic_tools FROM connector_extension_settings WHERE connector_id = ?')
    .bind(connectorId).first();
  return Number(row?.automatic_tools) === 1;
}

/** The sources of Pikibun's session-tool extensions, which are also their package keys. */
export const sessionToolSources: readonly string[] = pikiSessionToolExtensions().map(item => item.source);

/** Whether an extension tool card's `source` is one the session may run: an enabled extension of its workspace, or a dev extension of its host owner's own session. */
export async function sessionExtensionSources(env: Env, row: { workspace_id: string; owner_id: string; connector_owner_id?: string | null }): Promise<(source: string) => boolean> {
  const enabled = new Set((await workspaceExtensions(env, row.workspace_id)).filter(item => item.enabled).map(item => item.source));
  const ownHost = !!row.connector_owner_id && row.connector_owner_id === row.owner_id;
  return source => enabled.has(source) || (ownHost && source.startsWith('local:'));
}

/**
 * Adds the Pikibun extensions for repositories of `provider` (piki-extensions.ts) to a workspace that has just bound
 * its first one there, enabled, their tools with approval, at the end of its list, unless it already uses them or as many
 * extensions as it may. Returns the sources it added.
 */
export async function addPikiExtensions(env: Env, workspaceId: string, provider: string, actor: string): Promise<string[]> {
  const added: string[] = [];
  for (const extension of pikiExtensionsFor(provider)) {
    const providers = extension.providers;
    const saved = await env.DB.query<{ source: string }>(`INSERT INTO workspace_extensions (workspace_id, package_key, source, position, enabled, tools_mode, settings_json, updated_by, updated_at)
      SELECT ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM workspace_extensions WHERE workspace_id = ?), 1, 'approval', '{}', ?, ?
      WHERE (SELECT COUNT(*) FROM workspace_repositories WHERE workspace_id = ? AND provider IN (${providers.map(() => '?').join(', ')})) = 1
        AND (SELECT COUNT(*) FROM workspace_extensions WHERE workspace_id = ? AND package_key NOT IN (${sessionToolSources.map(() => '?').join(', ')})) < ?
      ON CONFLICT (workspace_id, package_key) DO NOTHING
      RETURNING source`)
      .bind(workspaceId, extension.source, extension.source, workspaceId, actor, now(), workspaceId, ...providers, workspaceId, ...sessionToolSources, extensionLimits.workspace).first();
    if (!saved) continue;
    added.push(saved.source);
    await auditStatement(env, actor, 'workspace.extension.updated', workspaceId, null,
      { source: saved.source, enabled: true, tools: 'approval', settings: [], reason: 'repository', provider }).run();
  }
  return added;
}

/**
 * The extensions whose tool calls the session's host may run without approval for anyone's message: enabled ones its
 * workspace runs automatically, while its host's owner lets workspaces do that there. Empty without a host.
 */
export async function automaticExtensionSources(env: Env, row: { workspace_id: string; connector_id?: string | null }): Promise<Set<string>> {
  if (!row.connector_id || !await automaticTools(env, row.connector_id)) return new Set();
  return new Set((await workspaceExtensions(env, row.workspace_id)).filter(item => item.enabled && item.tools === 'automatic').map(item => item.source));
}
