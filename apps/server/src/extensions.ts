import type { Hono } from 'hono';
import { builtinExtensionsFor } from '../../../packages/shared/src/builtin-extensions.js';
import { extensionAvailability, extensionLimits, extensionPackageKey, isBuiltinExtensionSource, normalizeExtensionSource, parseExtensionsSync, parseHostExtensionsReport,
  parseWorkspaceExtension, type ExtensionAvailability, type ExtensionRequest, type ExtensionToolMode, type HostExtensionsReport, type InstalledExtension,
  type WorkspaceExtension } from '../../../packages/shared/src/host-extensions.js';
import type { Env, WorkerEnv } from './types.js';
import { auditStatement, requireMember } from './db.js';
import { fail, id, identifier, jsonObject, now } from './http.js';
import { authenticateConnector } from './connectors.js';
import { managedConnector } from './host-access.js';

/*
 * Extensions (docs/design/host-extensions.md). A workspace's owners and admins choose the Pi extensions its sessions use,
 * each pinned to one version; each host reports what it has installed, and its owner asks for installs and removals,
 * which its connector carries out when it next syncs. Sessions run the workspace's enabled extensions their host has at
 * that version (the connector decides that, from what it asks here), and the host owner's dev extensions in their own
 * sessions.
 */

/** How many settled requests a host's page lists. */
const RECENT_REQUESTS = 20;
/** How many requests may wait for a host at once. */
const MAX_PENDING = 20;

interface ExtensionRow { source: string; enabled: number | string; tools_mode: ExtensionToolMode; settings_json: string }

/** The workspace's extensions, in its order. */
export async function workspaceExtensions(env: Env, workspaceId: string): Promise<WorkspaceExtension[]> {
  const rows = await env.DB.query<ExtensionRow>(`SELECT source, enabled, tools_mode, settings_json FROM workspace_extensions
    WHERE workspace_id = ? ORDER BY position, package_key`).bind(workspaceId).all();
  return rows.map(row => ({ source: row.source, enabled: Number(row.enabled) === 1, tools: row.tools_mode, settings: JSON.parse(row.settings_json) }));
}

/** What a host last reported, or null before its first report (or from a report that no longer reads as valid). */
async function hostReport(env: Env, connectorId: string): Promise<{ report: HostExtensionsReport; reportedAt: string } | null> {
  const row = await env.DB.query<{ report_json: string; reported_at: string }>('SELECT report_json, reported_at FROM connector_extensions WHERE connector_id = ?')
    .bind(connectorId).first();
  if (!row) return null;
  try { return { report: parseHostExtensionsReport(JSON.parse(row.report_json)), reportedAt: row.reported_at }; }
  catch { return null; }
}

async function automaticTools(env: Env, connectorId: string): Promise<boolean> {
  const row = await env.DB.query<{ automatic_tools: number | string }>('SELECT automatic_tools FROM connector_extension_settings WHERE connector_id = ?')
    .bind(connectorId).first();
  return Number(row?.automatic_tools) === 1;
}

/** Each of `extensions` on a host that reported `installed`. */
function availability(extensions: readonly WorkspaceExtension[], installed: readonly InstalledExtension[]): Record<string, ExtensionAvailability> {
  return Object.fromEntries(extensions.map(extension => [extension.source, extensionAvailability(extension.source, installed)]));
}

/** A host's report as someone other than its owner sees it: without its dev extensions, whose paths are its owner's files. */
function shownReport(report: HostExtensionsReport, ownerView: boolean): HostExtensionsReport {
  return ownerView ? report : { ...report, installed: report.installed.filter(item => !item.dev) };
}

/** SQL true while `user` (bound) is the owner or an admin of the workspace (bound before it). */
const adminSql = `EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND role IN ('owner','admin'))`;

/** Whether an extension tool card's `source` is one the session may run: an enabled extension of its workspace, or a dev extension of its host owner's own session. */
export async function sessionExtensionSources(env: Env, row: { workspace_id: string; owner_id: string; connector_owner_id?: string | null }): Promise<(source: string) => boolean> {
  const enabled = new Set((await workspaceExtensions(env, row.workspace_id)).filter(item => item.enabled).map(item => item.source));
  const ownHost = !!row.connector_owner_id && row.connector_owner_id === row.owner_id;
  return source => enabled.has(source) || (ownHost && source.startsWith('local:'));
}

/**
 * Adds the built-in extensions for repositories of `provider` (builtin-extensions.ts) to a workspace that has just bound
 * its first one there, enabled, their tools with approval, at the end of its list, unless it already uses them or as many
 * extensions as it may. Returns the sources it added.
 */
export async function addBuiltinExtensions(env: Env, workspaceId: string, provider: string, actor: string): Promise<string[]> {
  const added: string[] = [];
  for (const builtin of builtinExtensionsFor(provider)) {
    const providers = builtin.providers;
    const saved = await env.DB.query<{ source: string }>(`INSERT INTO workspace_extensions (workspace_id, package_key, source, position, enabled, tools_mode, settings_json, updated_by, updated_at)
      SELECT ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM workspace_extensions WHERE workspace_id = ?), 1, 'approval', '{}', ?, ?
      WHERE (SELECT COUNT(*) FROM workspace_repositories WHERE workspace_id = ? AND provider IN (${providers.map(() => '?').join(', ')})) = 1
        AND (SELECT COUNT(*) FROM workspace_extensions WHERE workspace_id = ?) < ?
      ON CONFLICT (workspace_id, package_key) DO NOTHING
      RETURNING source`)
      .bind(workspaceId, builtin.source, builtin.source, workspaceId, actor, now(), workspaceId, ...providers, workspaceId, extensionLimits.workspace).first();
    if (!saved) continue;
    added.push(saved.source);
    await auditStatement(env, actor, 'workspace.extension.updated', workspaceId, null,
      { source: saved.source, enabled: true, tools: 'approval', settings: [], reason: 'repository', provider }).run();
  }
  return added;
}

/** Whether a connector's last report names built-in extensions: one that predates them refuses a workspace's list naming one. */
async function knowsBuiltins(env: Env, connectorId: string): Promise<boolean> {
  return (await hostReport(env, connectorId))?.report.installed.some(item => isBuiltinExtensionSource(item.source)) === true;
}

/** The connector's routes, authenticated by its own credential (registered before the apps' authentication). */
/**
 * The extensions whose tool calls the session's host may run without approval for anyone's message: enabled ones its
 * workspace runs automatically, while its host's owner lets workspaces do that there. Empty without a host.
 */
export async function automaticExtensionSources(env: Env, row: { workspace_id: string; connector_id?: string | null }): Promise<Set<string>> {
  if (!row.connector_id || !await automaticTools(env, row.connector_id)) return new Set();
  return new Set((await workspaceExtensions(env, row.workspace_id)).filter(item => item.enabled && item.tools === 'automatic').map(item => item.source));
}

export function registerConnectorExtensions(app: Hono<WorkerEnv>): void {
  // The connector's sync: what it has installed and how its last requests went; the answer lists those still to do.
  app.post('/api/connectors/self/extensions', async c => {
    const row = await authenticateConnector(c);
    let sync: ReturnType<typeof parseExtensionsSync>;
    try { sync = parseExtensionsSync(await jsonObject(c, extensionLimits.reportBytes + 64 * 1024)); }
    catch (error) { return fail(400, 'invalid_extensions', error instanceof Error ? error.message : 'Invalid extensions report.'); }
    const reported = now();
    const finished = sync.results.length ? await c.env.DB.query<{ id: string; action: string; source: string; requested_by: string }>(
      `SELECT id, action, source, requested_by FROM connector_extension_requests WHERE connector_id = ? AND status = 'pending'`).bind(row.id).all() : [];
    const statements = [
      c.env.DB.query(`INSERT INTO connector_extensions (connector_id, report_json, reported_at) VALUES (?, ?, ?)
        ON CONFLICT (connector_id) DO UPDATE SET report_json = excluded.report_json, reported_at = excluded.reported_at`)
        .bind(row.id, JSON.stringify(sync.report), reported),
    ];
    for (const result of sync.results) {
      const request = finished.find(item => item.id === result.id);
      if (!request) continue;
      statements.push(c.env.DB.query(`UPDATE connector_extension_requests SET status = ?, error = ?, finished_at = ? WHERE id = ? AND connector_id = ? AND status = 'pending'`)
        .bind(result.ok ? 'done' : 'failed', result.ok ? null : result.error ?? 'It failed.', reported, result.id, row.id));
      statements.push(auditStatement(c.env, request.requested_by, `connector.extension.${result.ok ? (request.action === 'install' ? 'installed' : 'removed') : 'failed'}`, null, null,
        { connectorId: row.id, action: request.action, source: request.source, ...(result.ok ? {} : { error: result.error ?? '' }) }));
    }
    await c.env.DB.batch(statements);
    const pending = await c.env.DB.query<ExtensionRequest>(`SELECT id, action, source FROM connector_extension_requests
      WHERE connector_id = ? AND status = 'pending' ORDER BY requested_at, id LIMIT ?`).bind(row.id, MAX_PENDING).all();
    return c.json({ requests: pending.map(item => ({ id: item.id, action: item.action, source: item.source })) });
  });

  // One workspace's extensions, for the sessions this host runs in it: only a workspace the host is connected to.
  app.post('/api/connectors/self/extensions/workspace', async c => {
    const row = await authenticateConnector(c);
    const input = await jsonObject(c, 4096);
    const workspaceId = identifier(input.workspaceId, 'workspaceId');
    const connected = await c.env.DB.query<{ connector_id: string }>(`SELECT cw.connector_id FROM connector_workspaces cw
      JOIN workspace_members m ON m.workspace_id = cw.workspace_id AND m.user_id = ?
      WHERE cw.connector_id = ? AND cw.workspace_id = ?`).bind(row.owner_id, row.id, workspaceId).first();
    if (!connected) fail(404, 'not_found', 'Workspace not found.');
    const extensions = await workspaceExtensions(c.env, workspaceId);
    // A connector that predates built-in extensions would refuse the whole list for naming one: it gets the others.
    const shown = extensions.some(item => isBuiltinExtensionSource(item.source)) && !await knowsBuiltins(c.env, row.id)
      ? extensions.filter(item => !isBuiltinExtensionSource(item.source)) : extensions;
    return c.json({ extensions: shown, automaticTools: await automaticTools(c.env, row.id) });
  });
}

export function registerExtensions(app: Hono<WorkerEnv>): void {

  // Every member sees the workspace's extensions, and where its hosts stand with them; owners and admins change them.
  app.get('/api/workspaces/:id/extensions', async c => {
    const workspaceId = identifier(c.req.param('id'));
    const userId = c.get('auth').userId;
    const member = await requireMember(c.env, workspaceId, userId);
    const extensions = await workspaceExtensions(c.env, workspaceId);
    const rows = await c.env.DB.query<{ id: string; name: string; owner_id: string; owner_name: string }>(`SELECT c.id, c.name, c.owner_id, u.display_name AS owner_name
      FROM connectors c JOIN connector_workspaces cw ON cw.connector_id = c.id AND cw.workspace_id = ?
      JOIN workspace_members m ON m.workspace_id = cw.workspace_id AND m.user_id = c.owner_id
      JOIN users u ON u.id = c.owner_id
      WHERE c.revoked_at IS NULL AND c.removed_at IS NULL AND (c.owner_id = ? OR EXISTS (SELECT 1 FROM connector_shares sh
        WHERE sh.connector_id = c.id AND sh.workspace_id = cw.workspace_id))
      ORDER BY c.created_at DESC LIMIT 30`).bind(workspaceId, userId).all();
    const hosts = await Promise.all(rows.map(async host => {
      const reported = await hostReport(c.env, host.id);
      return { id: host.id, name: host.name, ownerId: host.owner_id, ownerName: host.owner_name,
        ...(reported ? { report: shownReport(reported.report, host.owner_id === userId), reportedAt: reported.reportedAt,
          availability: availability(extensions, reported.report.installed) } : {}) };
    }));
    return c.json({ extensions, hosts, admin: member.role === 'owner' || member.role === 'admin' });
  });

  // Adds an extension, or changes one: the package's entry, whose version may change too, keeps its place.
  app.put('/api/workspaces/:id/extensions', async c => {
    const workspaceId = identifier(c.req.param('id'));
    const actor = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    let extension: WorkspaceExtension;
    try { extension = parseWorkspaceExtension(await jsonObject(c, extensionLimits.settingsBytes + 4096)); }
    catch (error) { return fail(400, 'invalid_extension', error instanceof Error ? error.message : 'Invalid extension.'); }
    const key = extensionPackageKey(extension.source);
    const saved = await c.env.DB.query(`INSERT INTO workspace_extensions (workspace_id, package_key, source, position, enabled, tools_mode, settings_json, updated_by, updated_at)
      SELECT ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM workspace_extensions WHERE workspace_id = ?), ?, ?, ?, ?, ?
      WHERE ${adminSql} AND ((SELECT COUNT(*) FROM workspace_extensions WHERE workspace_id = ?) < ?
        OR EXISTS (SELECT 1 FROM workspace_extensions WHERE workspace_id = ? AND package_key = ?))
      ON CONFLICT (workspace_id, package_key) DO UPDATE SET source = excluded.source, enabled = excluded.enabled, tools_mode = excluded.tools_mode,
        settings_json = excluded.settings_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at
      RETURNING package_key`)
      .bind(workspaceId, key, extension.source, workspaceId, extension.enabled ? 1 : 0, extension.tools, JSON.stringify(extension.settings), actor, now(),
        workspaceId, actor, workspaceId, extensionLimits.workspace, workspaceId, key).first();
    if (!saved) {
      await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
      fail(409, 'extension_limit', `A workspace uses at most ${extensionLimits.workspace} extensions.`);
    }
    await auditStatement(c.env, actor, 'workspace.extension.updated', workspaceId, null,
      { source: extension.source, enabled: extension.enabled, tools: extension.tools, settings: Object.keys(extension.settings) }).run();
    return c.json({ extensions: await workspaceExtensions(c.env, workspaceId) });
  });

  // Removes the package `?source=` names (any version of it).
  app.delete('/api/workspaces/:id/extensions', async c => {
    const workspaceId = identifier(c.req.param('id'));
    const actor = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    let key: string;
    try { key = extensionPackageKey(normalizeExtensionSource(c.req.query('source') ?? '')); }
    catch { return fail(400, 'invalid_extension', 'Name the extension by its source, such as npm:<package>@<version>.'); }
    const removed = await c.env.DB.query<{ source: string }>(`DELETE FROM workspace_extensions WHERE workspace_id = ? AND package_key = ? AND ${adminSql} RETURNING source`)
      .bind(workspaceId, key, workspaceId, actor).first();
    if (!removed) fail(404, 'not_found', 'The workspace doesn\'t use that extension.');
    await auditStatement(c.env, actor, 'workspace.extension.removed', workspaceId, null, { source: removed.source }).run();
    return c.json({ extensions: await workspaceExtensions(c.env, workspaceId) });
  });

  // The host's page: what it has, its owner's requests, and the extensions of its workspaces it lacks.
  app.get('/api/connectors/:id/extensions', async c => {
    const row = await managedConnector(c);
    const userId = c.get('auth').userId;
    const reported = await hostReport(c.env, row.id);
    const requests = await c.env.DB.query<{ id: string; action: string; source: string; status: string; error: string | null; requested_at: string; finished_at: string | null }>(
      `SELECT id, action, source, status, error, requested_at, finished_at FROM connector_extension_requests WHERE connector_id = ?
        ORDER BY requested_at DESC, id LIMIT ?`).bind(row.id, RECENT_REQUESTS).all();
    // The workspaces it is connected to, where the viewer is a member too.
    const workspaces = await c.env.DB.query<{ id: string; name: string; shared: number | string }>(`SELECT w.id, w.name,
        CASE WHEN EXISTS (SELECT 1 FROM connector_shares sh WHERE sh.connector_id = cw.connector_id AND sh.workspace_id = w.id) THEN 1 ELSE 0 END AS shared
      FROM connector_workspaces cw JOIN workspaces w ON w.id = cw.workspace_id
      JOIN workspace_members owner ON owner.workspace_id = w.id AND owner.user_id = ?
      JOIN workspace_members viewer ON viewer.workspace_id = w.id AND viewer.user_id = ?
      WHERE cw.connector_id = ? ORDER BY w.name LIMIT 50`).bind(row.owner_id, userId, row.id).all();
    const installed = reported?.report.installed ?? [];
    return c.json({
      role: row.role,
      ...(reported ? { report: shownReport(reported.report, row.role === 'owner'), reportedAt: reported.reportedAt } : {}),
      automaticTools: await automaticTools(c.env, row.id),
      requests: requests.map(item => ({ id: item.id, action: item.action, source: item.source, status: item.status, ...(item.error ? { error: item.error } : {}),
        requestedAt: item.requested_at, ...(item.finished_at ? { finishedAt: item.finished_at } : {}) })),
      workspaces: await Promise.all(workspaces.map(async workspace => {
        const extensions = (await workspaceExtensions(c.env, workspace.id)).filter(item => item.enabled);
        return { id: workspace.id, name: workspace.name, shared: Number(workspace.shared) === 1,
          extensions: extensions.map(item => ({ source: item.source, availability: extensionAvailability(item.source, installed) })) };
      })),
    });
  });

  // The host's owner asks for an install or a removal, which its connector carries out when it next syncs.
  app.post('/api/connectors/:id/extensions/requests', async c => {
    const row = await managedConnector(c);
    if (row.role !== 'owner') fail(403, 'host_owner_required', 'Only the host\'s owner installs or removes its extensions.');
    if (row.revoked_at) fail(409, 'connector_revoked', 'Connector is revoked.');
    const input = await jsonObject(c, 4096);
    if (Object.keys(input).some(key => key !== 'action' && key !== 'source') || (input.action !== 'install' && input.action !== 'remove') || typeof input.source !== 'string') {
      fail(400, 'invalid_extension_request', 'Ask to install or remove an extension by its source.');
    }
    let source: string;
    try { source = normalizeExtensionSource(input.source); }
    catch (error) { return fail(400, 'invalid_extension_request', error instanceof Error ? error.message : 'Invalid extension source.'); }
    if (isBuiltinExtensionSource(source)) fail(400, 'builtin_extension', 'Built-in extensions come with the connector: update it (npx pikibun@latest connect) to get newer ones.');
    const reported = await hostReport(c.env, row.id);
    if (reported && !reported.report.remoteInstalls) fail(409, 'remote_installs_off', 'This host\'s connector refuses installs from Pikibun: install extensions on it with pikibun extensions.');
    const existing = await c.env.DB.query<{ id: string }>(`SELECT id FROM connector_extension_requests WHERE connector_id = ? AND status = 'pending' AND action = ? AND source = ?`)
      .bind(row.id, input.action, source).first();
    const requestId = existing?.id ?? id();
    if (!existing) {
      const saved = await c.env.DB.query<{ id: string }>(`INSERT INTO connector_extension_requests (id, connector_id, action, source, requested_by, requested_at)
        SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM connectors WHERE id = ? AND owner_id = ? AND revoked_at IS NULL AND removed_at IS NULL)
          AND (SELECT COUNT(*) FROM connector_extension_requests WHERE connector_id = ? AND status = 'pending') < ?
        RETURNING id`).bind(requestId, row.id, input.action, source, row.owner_id, now(), row.id, row.owner_id, row.id, MAX_PENDING).first();
      if (!saved) fail(409, 'extension_requests_limit', `At most ${MAX_PENDING} requests wait for a host; it carries them out when it is online.`);
      await auditStatement(c.env, row.owner_id, 'connector.extension.requested', null, null, { connectorId: row.id, action: input.action, source }).run();
    }
    return c.json({ request: { id: requestId, action: input.action, source, status: 'pending' } }, existing ? 200 : 201);
  });

  // The host's owner lets workspaces run extension tools without approval on it, or stops that.
  app.patch('/api/connectors/:id/extensions', async c => {
    const row = await managedConnector(c);
    if (row.role !== 'owner') fail(403, 'host_owner_required', 'Only the host\'s owner decides whether extension tools run on it without approval.');
    if (row.revoked_at) fail(409, 'connector_revoked', 'Connector is revoked.');
    const input = await jsonObject(c, 1024);
    if (Object.keys(input).join() !== 'automaticTools' || typeof input.automaticTools !== 'boolean') fail(400, 'invalid_input', 'Set automaticTools to true or false.');
    await c.env.DB.batch([
      c.env.DB.query(`INSERT INTO connector_extension_settings (connector_id, automatic_tools, updated_by, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (connector_id) DO UPDATE SET automatic_tools = excluded.automatic_tools, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
        .bind(row.id, input.automaticTools ? 1 : 0, row.owner_id, now()),
      auditStatement(c.env, row.owner_id, 'connector.extension.automatic_tools', null, null, { connectorId: row.id, automaticTools: input.automaticTools }),
    ]);
    return c.json({ automaticTools: input.automaticTools });
  });
}

