import { documentSourceExtensionOf, pikiExtensionsFor, pikiSessionToolExtensions } from '../../../../packages/shared/src/piki-extensions.js';
import { extensionLimits, withSessionToolsListed, type ExtensionToolMode, type WorkspaceExtension } from '../../../../packages/shared/src/host-extensions.js';
import type { DocumentKind } from '../../../../packages/shared/src/sources.js';
import type { Env } from '../types.js';
import { now } from '../http.js';
import { auditStatement } from './audit.js';

/*
 * Extensions as policy: which extension tool calls a session may run at all, and which run without approval. The
 * workspace's owners and admins choose its extensions and their tool mode, and a host's owner whether workspaces may run
 * tools without approval there (extensions.ts, with the hosts' reports and installs); approvals and brokers read the
 * outcome here. Binding a workspace's first repository on a forge also adds that forge's Pikibun extensions, with approval,
 * and adding its first document source of a kind adds that kind's: Pikibun's extensions are in no workspace by default.
 */

interface ExtensionRow { source: string; enabled: number | string; tools_mode: ExtensionToolMode; settings_json: string }

/**
 * The workspace's extensions, in its order, then the session-tool extensions it hasn't added, turned off
 * (`withSessionToolsListed`): what its pages and its hosts' connectors read.
 */
export async function workspaceExtensions(env: Env, workspaceId: string): Promise<WorkspaceExtension[]> {
  const rows = await env.DB.query<ExtensionRow>(`SELECT source, enabled, tools_mode, settings_json FROM workspace_extensions
    WHERE workspace_id = ? ORDER BY position, package_key`).bind(workspaceId).all();
  return withSessionToolsListed(rows.map(row => ({ source: row.source, enabled: Number(row.enabled) === 1, tools: row.tools_mode, settings: JSON.parse(row.settings_json) })));
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
 * Adds the Pikibun extension `source` to a workspace, enabled, its tools with approval, at the end of its list, while
 * `first` (SQL and its values) holds, unless it already lists it (turned off included: one turned off stays off) or uses
 * as many extensions as it may; a session-tool extension takes no place. Whether it added it.
 */
async function addPikiExtension(env: Env, workspaceId: string, source: string, actor: string, first: { sql: string; values: string[] },
  detail: Record<string, string>): Promise<boolean> {
  const sessionTool = sessionToolSources.includes(source);
  const saved = await env.DB.query<{ source: string }>(`INSERT INTO workspace_extensions (workspace_id, package_key, source, position, enabled, tools_mode, settings_json, updated_by, updated_at)
    SELECT ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM workspace_extensions WHERE workspace_id = ?), 1, 'approval', '{}', ?, ?
    WHERE ${first.sql}
      AND (? = 1 OR (SELECT COUNT(*) FROM workspace_extensions WHERE workspace_id = ? AND package_key NOT IN (${sessionToolSources.map(() => '?').join(', ')})) < ?)
    ON CONFLICT (workspace_id, package_key) DO NOTHING
    RETURNING source`)
    .bind(workspaceId, source, source, workspaceId, actor, now(), ...first.values, sessionTool ? 1 : 0, workspaceId, ...sessionToolSources, extensionLimits.workspace).first();
  if (!saved) return false;
  await auditStatement(env, actor, 'workspace.extension.updated', workspaceId, null,
    { source: saved.source, enabled: true, tools: 'approval', settings: [], ...detail }).run();
  return true;
}

/**
 * Adds the Pikibun extensions for repositories of `provider` (piki-extensions.ts: the forge's command-line tool, piki:git,
 * and piki:github for GitHub) to a workspace that has just bound its first one there (for piki:git, its first of any).
 * Returns the sources it added.
 */
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

/**
 * Adds the document-source extension of `kind` (piki:notion, ...) to a workspace that has just added its first source of
 * that kind. Returns the sources it added.
 */
export async function addDocumentSourceExtension(env: Env, workspaceId: string, kind: DocumentKind, actor: string): Promise<string[]> {
  const extension = documentSourceExtensionOf(kind);
  if (!extension) return [];
  const first = { sql: '(SELECT COUNT(*) FROM document_sources WHERE workspace_id = ? AND kind = ?) = 1', values: [workspaceId, kind] };
  return await addPikiExtension(env, workspaceId, extension.source, actor, first, { reason: 'source', kind }) ? [extension.source] : [];
}

/**
 * The extensions whose tool calls the session's host may run without approval for anyone's message: enabled ones its
 * workspace runs automatically, while its host's owner lets workspaces do that there. Empty without a host.
 */
export async function automaticExtensionSources(env: Env, row: { workspace_id: string; connector_id?: string | null }): Promise<Set<string>> {
  if (!row.connector_id || !await automaticTools(env, row.connector_id)) return new Set();
  return new Set((await workspaceExtensions(env, row.workspace_id)).filter(item => item.enabled && item.tools === 'automatic').map(item => item.source));
}
