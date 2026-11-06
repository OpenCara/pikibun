import {
  apiCredential, auditStatement, authenticateConnector, authorizeSession, connectorAdmins, connectorHostGrants, type ConnectorRow, egressGrant,
  gitDirect, githubComment, githubIssue, githubMerge, githubRead, gitRelay, legacyRepositoryFixture, managedConnector, pushComplete,
  pushCredential, requireCallbackScope, requireConfiguredWorkspace, requireConnectorTLS, requireManagedWorkspace, requireMember, sourceRead,
  viewerHostAuthority, workspaceHasSourceSQL,
} from './authority/index.js';
import { withHostToolCapabilities } from './host-capabilities.js';
import { verifyDirectUpload } from './file-uploads.js';
import type { Hono } from 'hono';
import type { ConnectorCapabilities, ConnectorInfo, ConnectorPairing, LocalModelSummary } from '../../../packages/shared/src/connector.js';
import { gpuKinds, type GpuKind } from '../../../packages/shared/src/host-config.js';
import { sessionActivities, thinkingLevels, type SessionActivity, type ThinkingLevel } from '../../../packages/shared/src/types.js';
import { sha256 } from '../../../packages/shared/src/crypto.js';
import { CONNECTOR_VERSION_HEADER, validVersion } from '../../../packages/shared/src/version.js';
import type { AppContext, Env, SessionRow, WorkerEnv } from './types.js';
import type { Query } from './db/types.js';
import { appOrigin, fail, id, identifier, jsonObject, now, randomToken, requireOrigin, testMode, text } from './http.js';
import { markSessionChanged } from './session-changes.js';
import { agentSchedules } from './scheduled-prompts.js';
import { agentSessions } from './cross-session.js';
import { connectorRestoreDownload } from './restore-routes.js';
import { connectorHostConfig } from './host-config.js';
import { disabledModelKeys, hostModelSettings } from './host-models.js';
import { reportSessionBranches } from './session-branches.js';
import { notifySessionActivityQuietly } from './notifications.js';

function onlyFields(value: Record<string, unknown>, fields: string[]): void {
  if (Object.keys(value).some(key => !fields.includes(key))) fail(400, 'invalid_metadata', 'Only model and capability metadata is accepted.');
}
/**
 * The answer to the retired web_search tool's searches from connectors that still carry it: web search comes from
 * extensions now (docs/design/host-extensions.md). Older connectors pass the reason on to the agent.
 */
export function webSearchRetired(): never {
  fail(410, 'web_search_retired', 'Pikibun no longer searches the web itself: web search comes from extensions now. A workspace\'s owners and admins add one under Settings → Workspaces → the workspace → Extensions.');
}

export function parseManifest(input: Record<string, unknown>, env: Env): { models: LocalModelSummary[]; capabilities: ConnectorCapabilities } {
  if (!Array.isArray(input.models) || input.models.length > 200) fail(400, 'invalid_manifest', 'At most 200 models may be advertised.');
  const seen = new Set<string>();
  const models = input.models.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_manifest', 'Invalid model metadata.');
    onlyFields(value, ['provider', 'modelId', 'name', 'thinkingLevels', 'thinkingLevel']);
    const provider = text(value.provider, 'provider', 80);
    const modelId = text(value.modelId, 'modelId', 200);
    const name = text(value.name, 'name', 120);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(provider) || /[\x00-\x1f\x7f]/.test(modelId + name)) fail(400, 'invalid_manifest', 'Invalid model metadata.');
    if (provider === 'faux' && !testMode(env)) fail(403, 'test_mode_disabled', 'Faux models are disabled.');
    const key = JSON.stringify([provider, modelId]);
    if (seen.has(key)) fail(400, 'invalid_manifest', 'Duplicate model metadata.');
    seen.add(key);
    const levels = value.thinkingLevels;
    if (levels !== undefined && (!Array.isArray(levels) || !levels.length || levels.some(level => !thinkingLevels.includes(level))
      || new Set(levels).size !== levels.length)) fail(400, 'invalid_manifest', 'Invalid reasoning levels.');
    // The level the host's Pi starts the model at must be one the model offers.
    const level = value.thinkingLevel;
    if (level !== undefined && (!thinkingLevels.includes(level as ThinkingLevel) || (levels && !levels.includes(level)))) fail(400, 'invalid_manifest', 'Invalid reasoning levels.');
    return { provider, modelId, name, ...(levels ? { thinkingLevels: [...levels] as ThinkingLevel[] } : {}), ...(level ? { thinkingLevel: level as ThinkingLevel } : {}) };
  });
  const value = input.capabilities;
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_manifest', 'Capabilities are required.');
  const cap = value as Record<string, unknown>;
  onlyFields(cap, ['platform', 'sandbox', 'productionShell', 'unsandboxed', 'chatOptions', 'chatImages', 'gitProviders', 'gitServers', 'gitPush', 'gitCredentials', 'github', 'githubIssues', 'sources', 'schedules', 'crossSessions', 'repositoryCache', 'hostMigration', 'plainGit', 'cloneBackups', 'sessionBranches', 'conversationBackups', 'sessionPacking', 'hostConfig', 'compactionConfig', 'gpu']);
  const platform = text(cap.platform, 'platform', 40);
  if (!/^[a-zA-Z0-9._-]+$/.test(platform) || typeof cap.sandbox !== 'boolean' || typeof cap.productionShell !== 'boolean' || (cap.productionShell && !cap.sandbox)
    || (cap.unsandboxed !== undefined && typeof cap.unsandboxed !== 'boolean') || (cap.unsandboxed && cap.sandbox)
    || (cap.chatOptions !== undefined && typeof cap.chatOptions !== 'boolean') || (cap.gitProviders !== undefined && typeof cap.gitProviders !== 'boolean')
    || (cap.gitServers !== undefined && typeof cap.gitServers !== 'boolean')
    || (cap.chatImages !== undefined && typeof cap.chatImages !== 'boolean')
    || (cap.gitPush !== undefined && typeof cap.gitPush !== 'boolean')
    || (cap.gitCredentials !== undefined && typeof cap.gitCredentials !== 'boolean') || (cap.gitCredentials && !cap.gitPush)
    || (cap.github !== undefined && typeof cap.github !== 'boolean')
    || (cap.githubIssues !== undefined && typeof cap.githubIssues !== 'boolean')
    || (cap.sources !== undefined && typeof cap.sources !== 'boolean')
    || (cap.schedules !== undefined && typeof cap.schedules !== 'boolean')
    || (cap.crossSessions !== undefined && typeof cap.crossSessions !== 'boolean')
    || (cap.repositoryCache !== undefined && typeof cap.repositoryCache !== 'boolean')
    || (cap.hostMigration !== undefined && typeof cap.hostMigration !== 'boolean')
    || (cap.plainGit !== undefined && typeof cap.plainGit !== 'boolean')
    || (cap.cloneBackups !== undefined && typeof cap.cloneBackups !== 'boolean') || (cap.cloneBackups && (!cap.plainGit || cap.unsandboxed))
    || (cap.sessionBranches !== undefined && typeof cap.sessionBranches !== 'boolean') || (cap.sessionBranches && !cap.plainGit)
    || (cap.conversationBackups !== undefined && typeof cap.conversationBackups !== 'boolean')
    // Only sandboxed sessions are packed.
    || (cap.sessionPacking !== undefined && typeof cap.sessionPacking !== 'boolean') || (cap.sessionPacking && cap.unsandboxed)
    || (cap.hostConfig !== undefined && typeof cap.hostConfig !== 'boolean')
    || (cap.compactionConfig !== undefined && typeof cap.compactionConfig !== 'boolean') || (cap.compactionConfig && !cap.hostConfig)
    // Unsandboxed commands already run on the host itself; a GPU is lent only to sandboxed ones.
    || (cap.gpu !== undefined && (!gpuKinds.includes(cap.gpu as GpuKind) || cap.unsandboxed))) fail(400, 'invalid_manifest', 'Invalid capabilities.');
  return { models, capabilities: { platform, sandbox: cap.sandbox, productionShell: cap.productionShell, ...(cap.unsandboxed ? { unsandboxed: true } : {}), ...(cap.chatOptions ? { chatOptions: true } : {}),
    ...(cap.chatImages ? { chatImages: true } : {}), ...(cap.gitProviders ? { gitProviders: true } : {}), ...(cap.gitServers ? { gitServers: true } : {}), ...(cap.gitPush ? { gitPush: true } : {}), ...(cap.gitCredentials ? { gitCredentials: true } : {}),
    ...(cap.github ? { github: true } : {}), ...(cap.githubIssues ? { githubIssues: true } : {}), ...(cap.sources ? { sources: true } : {}), ...(cap.schedules ? { schedules: true } : {}), ...(cap.crossSessions ? { crossSessions: true } : {}), ...(cap.repositoryCache ? { repositoryCache: true } : {}),
    ...(cap.hostMigration ? { hostMigration: true } : {}), ...(cap.plainGit ? { plainGit: true } : {}), ...(cap.cloneBackups ? { cloneBackups: true } : {}),
    ...(cap.sessionBranches ? { sessionBranches: true } : {}), ...(cap.conversationBackups ? { conversationBackups: true } : {}),
    ...(cap.sessionPacking ? { sessionPacking: true } : {}),
    ...(cap.hostConfig ? { hostConfig: true } : {}), ...(cap.compactionConfig ? { compactionConfig: true } : {}), ...(cap.gpu ? { gpu: cap.gpu as GpuKind } : {}) } };
}

/**
 * A connector reports what the agent of a session it serves is doing (see SessionActivity). Activity is display state,
 * neither binding nor policy: it bumps no policy version and leaves no audit entry.
 */
async function reportSessionActivity(c: AppContext, connectorId: string): Promise<Response> {
  const input = await jsonObject(c, 4096);
  const activity = input.activity as SessionActivity;
  if (Object.keys(input).some(key => key !== 'sessionId' && key !== 'activity') || !sessionActivities.includes(activity)) {
    fail(400, 'invalid_activity', 'Invalid session activity.');
  }
  const row = await c.env.DB.query<SessionRow>('SELECT * FROM sessions WHERE id = ?').bind(identifier(input.sessionId, 'sessionId')).first();
  if (!row) fail(404, 'not_found', 'Session not found.');
  await requireCallbackScope(c, row, connectorId);
  if (row.activity !== activity) {
    // From the activity this report read, so that of two reports at once only the one that made a change notifies; the
    // other still writes its activity, the latest report winning as before.
    const { changes } = await c.env.DB.query('UPDATE sessions SET activity = ? WHERE id = ? AND connector_id = ? AND COALESCE(activity, \'\') = ?')
      .bind(activity, row.id, connectorId, row.activity ?? '').run();
    if (!changes) await c.env.DB.query('UPDATE sessions SET activity = ? WHERE id = ? AND connector_id = ?').bind(activity, row.id, connectorId).run();
    // An agent at work changes the session: the next automatic backup has something new to save.
    if (activity === 'working') await markSessionChanged(c.env, row.id);
    // Waiting for an approval, finished or failed: the people it concerns hear about it (notifications.ts).
    if (changes) await notifySessionActivityQuietly(c.env, row, row.activity, activity);
  }
  return c.json({ ok: true });
}

async function ownedConnector(c: AppContext): Promise<ConnectorRow> {
  const row = await c.env.DB.query<ConnectorRow>('SELECT * FROM connectors WHERE id = ? AND owner_id = ? AND removed_at IS NULL')
    .bind(identifier(c.req.param('id')), c.get('auth').userId).first();
  if (!row) fail(404, 'not_found', 'Connector not found.');
  return row;
}

type ConnectorInfoRow = ConnectorRow & { owner_name?: string; workspace_ids?: string; connected_workspace_ids?: string };
/**
 * Who reads the listing: `role` adds the host's admins, host command grants and disabled models for its owner and
 * admins; `workspaceId` adds the viewer's own host command authority there. Everyone is shown only the models it offers.
 */
type InfoViewer = { userId: string; role?: 'owner' | 'admin'; workspaceId?: string };

/**
 * Whether a host's connector runs a session directly on the host when its binding asks (SessionRecord.hostEnvironment):
 * one that takes its configuration from Pikibun, on a sandboxed host. An unsandboxed host runs every session that way.
 * `granted`: for a member the host's owner granted that, which needs a connector that honors such grants.
 */
export function hostSessionsSupported(capabilities: ConnectorCapabilities, granted = false): boolean {
  return capabilities.hostConfig === true && capabilities.unsandboxed !== true && (!granted || capabilities.hostSessionGrants === true);
}
async function connectorInfo(env: Env, row: ConnectorInfoRow, viewer?: InfoViewer): Promise<ConnectorInfo> {
  const ownerName = row.owner_name ?? (await env.DB.query<{ display_name: string }>('SELECT display_name FROM users WHERE id = ?')
    .bind(row.owner_id).first())?.display_name ?? '';
  const workspaceIds: string[] = row.workspace_ids !== undefined ? JSON.parse(row.workspace_ids) :
    (await env.DB.query<{ workspace_id: string }>(`SELECT s.workspace_id FROM connector_shares s JOIN workspace_members m
      ON m.workspace_id = s.workspace_id AND m.user_id = ? WHERE s.connector_id = ? ORDER BY s.workspace_id LIMIT 50`)
      .bind(row.owner_id, row.id).all()).map(item => item.workspace_id);
  const connectedWorkspaceIds: string[] = row.connected_workspace_ids !== undefined ? JSON.parse(row.connected_workspace_ids) :
    (await env.DB.query<{ workspace_id: string }>(`SELECT cw.workspace_id FROM connector_workspaces cw JOIN workspace_members m
      ON m.workspace_id = cw.workspace_id AND m.user_id = ? WHERE cw.connector_id = ? ORDER BY cw.workspace_id`)
      .bind(row.owner_id, row.id).all()).map(item => item.workspace_id);
  let online = false;
  if (!row.revoked_at && env.CONNECTOR_HUB) {
    try {
      online = await env.CONNECTOR_HUB.status(row.id, 2000);
    } catch { /* Offline is safe metadata; do not expose transport errors. */ }
  }
  // The host's owner learns, in every listing, whether their sessions may run directly on it; a member granted that, in
  // the listing of the workspace their grant is in.
  const owner = viewer?.userId === row.owner_id;
  const [admins, grants, disabled, config, authority, memberships] = await Promise.all([
    viewer?.role ? connectorAdmins(env, row.id) : undefined,
    viewer?.role ? connectorHostGrants(env, row.id) : undefined,
    disabledModelKeys(env, row.id),
    viewer?.role || owner || viewer?.workspaceId ? connectorHostConfig(env, row.id) : undefined,
    viewer?.workspaceId ? viewerHostAuthority(env, row, viewer.workspaceId, viewer.userId) : undefined,
    // An admin sees the owner's workspaces only where they are a member too.
    viewer?.role === 'admin' ? env.DB.query<{ workspace_id: string }>('SELECT workspace_id FROM workspace_members WHERE user_id = ?')
      .bind(viewer.userId).all().then(items => new Set(items.map(item => item.workspace_id))) : undefined,
  ]);
  const visible = (workspaceId: string) => !memberships || memberships.has(workspaceId);
  const hostGrants = grants?.filter(grant => visible(grant.workspaceId));
  const { models, disabledModels } = hostModelSettings(JSON.parse(row.models_json), disabled);
  const capabilities = JSON.parse(row.capabilities_json) as ConnectorCapabilities;
  const hostCommandAccess = authority?.level;
  const hostSessions = (owner || authority?.sessions === true) && !row.revoked_at && config?.hostSessions === true
    && hostSessionsSupported(capabilities, !owner);
  return { id: row.id, ownerId: row.owner_id, ownerName, name: row.name,
    createdAt: row.created_at, revokedAt: row.revoked_at, online, models, ...(row.connector_version ? { version: row.connector_version } : {}),
    workspaceIds: workspaceIds.filter(visible), connectedWorkspaceIds: connectedWorkspaceIds.filter(visible), capabilities,
    ...(viewer?.role ? { role: viewer.role, admins, hostGrants, disabledModels, config } : {}), ...(hostCommandAccess ? { hostCommandAccess } : {}),
    ...(hostSessions ? { hostSessions: true as const } : {}) };
}

async function connectorInfos(env: Env, rows: ConnectorInfoRow[], viewer?: (row: ConnectorInfoRow) => InfoViewer): Promise<ConnectorInfo[]> {
  const result: ConnectorInfo[] = [];
  for (let offset = 0; offset < rows.length; offset += 4) {
    result.push(...await Promise.all(rows.slice(offset, offset + 4).map(row => connectorInfo(env, row, viewer?.(row)))));
  }
  return result;
}

function modelStatements(env: Env, row: Pick<ConnectorRow, 'id' | 'models_json'>, workspaceId: string | null): Query<never>[] {
  // Import with two set-based statements, not one query per model or workspace.
  return [
    env.DB.query<never>(`UPDATE models SET available = 0 WHERE connector_id = ? AND (? IS NULL OR workspace_id = ?)
      AND EXISTS (SELECT 1 FROM connectors WHERE id = ? AND models_json = ? AND revoked_at IS NULL)`)
      .bind(row.id, workspaceId, workspaceId, row.id, row.models_json),
    env.DB.query<never>(`INSERT INTO models
      (id, workspace_id, name, provider, model_id, created_at, connector_id, connector_owner_id, available)
      SELECT lower(hex(randomblob(16))), cw.workspace_id, json_extract(local.value, '$.name'),
        json_extract(local.value, '$.provider'), json_extract(local.value, '$.modelId'), ?, c.id, c.owner_id, 1
      FROM connectors c JOIN connector_workspaces cw ON cw.connector_id = c.id
      JOIN workspace_members m ON m.workspace_id = cw.workspace_id AND m.user_id = c.owner_id
      JOIN json_each(c.models_json) local
      WHERE c.id = ? AND c.revoked_at IS NULL AND c.models_json = ? AND (? IS NULL OR cw.workspace_id = ?)
      ON CONFLICT (workspace_id, connector_id, provider, model_id) DO UPDATE SET name = excluded.name, available = 1`)
      .bind(now(), row.id, row.models_json, workspaceId, workspaceId),
  ];
}

async function syncModels(env: Env, row: ConnectorRow, workspaceId: string | null): Promise<void> {
  await env.DB.batch(modelStatements(env, row, workspaceId));
}

/**
 * A host belongs to its owner, not to one workspace: it is connected, for the owner's private use, to every workspace
 * they belong to. These statements connect `userId`'s hosts to `workspaceId` and import their models there, once the
 * user is a member of it (a workspace they create or join); without that membership they change nothing.
 */
export function ownerHostStatements(env: Env, userId: string, workspaceId: string): Query<never>[] {
  const createdAt = now();
  return [
    env.DB.query<never>(`INSERT INTO connector_workspaces (connector_id, workspace_id, created_at)
      SELECT c.id, m.workspace_id, ? FROM connectors c
      JOIN workspace_members m ON m.user_id = c.owner_id AND m.workspace_id = ?
      WHERE c.owner_id = ? AND c.revoked_at IS NULL
      ON CONFLICT (connector_id, workspace_id) DO NOTHING`)
      .bind(createdAt, workspaceId, userId),
    env.DB.query<never>(`UPDATE models SET available = 0 WHERE workspace_id = ? AND connector_owner_id = ?
      AND connector_id IN (SELECT id FROM connectors WHERE owner_id = ? AND revoked_at IS NULL)`)
      .bind(workspaceId, userId, userId),
    env.DB.query<never>(`INSERT INTO models
      (id, workspace_id, name, provider, model_id, created_at, connector_id, connector_owner_id, available)
      SELECT lower(hex(randomblob(16))), cw.workspace_id, json_extract(local.value, '$.name'),
        json_extract(local.value, '$.provider'), json_extract(local.value, '$.modelId'), ?, c.id, c.owner_id, 1
      FROM connectors c JOIN connector_workspaces cw ON cw.connector_id = c.id AND cw.workspace_id = ?
      JOIN workspace_members m ON m.workspace_id = cw.workspace_id AND m.user_id = c.owner_id
      JOIN json_each(c.models_json) local
      WHERE c.owner_id = ? AND c.revoked_at IS NULL
      ON CONFLICT (workspace_id, connector_id, provider, model_id) DO UPDATE SET name = excluded.name, available = 1`)
      .bind(createdAt, workspaceId, userId),
  ];
}

export function registerConnectorCredentials(app: Hono<WorkerEnv>): void {
  app.post('/api/connectors/pairings/:id/claim', async c => {
    requireConnectorTLS(c.env, new URL(c.req.url));
    requireOrigin(c);
    const input = await jsonObject(c, 128 * 1024);
    onlyFields(input, ['code', 'models', 'capabilities']);
    const manifest = withHostToolCapabilities(input, base => parseManifest(base, c.env));
    const pairingId = identifier(c.req.param('id'));
    const code = text(input.code, 'code', 128);
    const controlPlaneUrl = appOrigin(c.env);
    const codeHash = await sha256(code);
    const pairing = await c.env.DB.query<{ owner_id: string }>(`SELECT owner_id FROM connector_pairings
      WHERE id = ? AND code_hash = ? AND claimed_at IS NULL AND expires_at > ?`)
      .bind(pairingId, codeHash, Math.floor(Date.now() / 1000))
      .first();
    if (!pairing) fail(403, 'invalid_pairing', 'Pairing is expired, used, or invalid.');
    const connectorId = id();
    const token = randomToken();
    const credentialHash = await sha256(token);
    const createdAt = now();
    // Consume the code, create the connector and connect it privately to its owner's workspaces in one transaction.
    // A pairing names no workspace: the host is its owner's, wherever they work (ownerHostStatements).
    // INSERT rechecks authority after the asynchronous preflight and token hashing.
    const results = await c.env.DB.batch<ConnectorRow>([
      c.env.DB.query<ConnectorRow>(`INSERT INTO connectors (id,owner_id,name,credential_hash,created_at,models_json,capabilities_json)
        SELECT ?, p.owner_id, p.name, ?, ?, ?, ? FROM connector_pairings p
        JOIN users u ON u.id = p.owner_id
        WHERE p.id = ? AND p.code_hash = ? AND p.claimed_at IS NULL AND p.expires_at > ?
        AND p.owner_id = ?
        AND (? = 1 OR u.auth_kind <> 'test')
        AND (SELECT COUNT(*) FROM connectors WHERE owner_id = p.owner_id AND revoked_at IS NULL) < 20
        RETURNING *`)
        .bind(connectorId, credentialHash, createdAt, JSON.stringify(manifest.models), JSON.stringify(manifest.capabilities),
          pairingId, codeHash, Math.floor(Date.now() / 1000), pairing.owner_id, testMode(c.env) ? 1 : 0),
      c.env.DB.query<never>(`UPDATE connector_pairings SET claimed_at = ? WHERE id = ?
        AND EXISTS (SELECT 1 FROM connectors WHERE id = ? AND credential_hash = ?)`)
        .bind(createdAt, pairingId, connectorId, credentialHash),
      c.env.DB.query<never>(`INSERT INTO connector_workspaces (connector_id, workspace_id, created_at)
        SELECT c.id, m.workspace_id, ? FROM connectors c JOIN workspace_members m ON m.user_id = c.owner_id
        WHERE c.id = ? ON CONFLICT (connector_id, workspace_id) DO NOTHING`)
        .bind(createdAt, connectorId),
      ...modelStatements(c.env, { id: connectorId, models_json: JSON.stringify(manifest.models) }, null),
    ]);
    const created = results[0].results[0];
    if (!created) fail(403, 'invalid_pairing', 'Pairing is expired, used, or invalid.');
    return c.json({ credentials: { connectorId, token, controlPlaneUrl } }, 201);
  });
  // The upgrade itself is completed by the HTTP server (`main.ts`) with `authenticateConnectorSocket`;
  // a plain request to the socket path cannot be upgraded inside Hono.
  app.get('/api/connectors/socket', () => fail(426, 'upgrade_required', 'WebSocket upgrade is required.'));
  app.post('/api/connectors/self/manifest', async c => {
    const row = await authenticateConnector(c);
    const input = await jsonObject(c, 128 * 1024);
    onlyFields(input, ['models', 'capabilities']);
    const manifest = withHostToolCapabilities(input, base => parseManifest(base, c.env));
    // The version it names (a header, which servers before it ignore), recorded at every connection: one that names none,
    // or one that isn't a version, clears an earlier one, so the host's page never shows a version it no longer runs.
    const version = validVersion(c.req.header(CONNECTOR_VERSION_HEADER)) ?? null;
    const updated = await c.env.DB.query<ConnectorRow>(`UPDATE connectors SET models_json = ?, capabilities_json = ?, connector_version = ? WHERE id = ?
      AND revoked_at IS NULL AND connection_hash = ? RETURNING *`)
      .bind(JSON.stringify(manifest.models), JSON.stringify(manifest.capabilities), version, row.id, row.connection_hash).first();
    if (!updated) fail(401, 'stale_connection', 'Connection has been replaced.');
    await syncModels(c.env, updated, null);
    return c.json({ ok: true });
  });
  app.post('/api/connectors/self/authorize', async c => authorizeSession(c, (await authenticateConnector(c)).id));
  app.post('/api/connectors/self/activity', async c => reportSessionActivity(c, (await authenticateConnector(c)).id));
  app.post('/api/connectors/self/branches', async c => reportSessionBranches(c, (await authenticateConnector(c)).id));
  app.post('/api/connectors/self/github/comment', async c => githubComment(c, (await authenticateConnector(c)).id));
  app.post('/api/connectors/self/github/read', async c => githubRead(c, (await authenticateConnector(c)).id));
  app.post('/api/connectors/self/github/merge', async c => githubMerge(c, (await authenticateConnector(c)).id));
  app.post('/api/connectors/self/github/issue', async c => githubIssue(c, (await authenticateConnector(c)).id));
  app.post('/api/connectors/self/sources/read', async c => sourceRead(c, (await authenticateConnector(c)).id));
  app.post('/api/connectors/self/schedules', async c => agentSchedules(c, (await authenticateConnector(c)).id));
  app.post('/api/connectors/self/sessions', async c => agentSessions(c, (await authenticateConnector(c)).id));
  // The retired web_search tool's searches (web tools come from extensions now), from connectors that still carry it.
  app.post('/api/connectors/self/web/search', async c => { await authenticateConnector(c); return webSearchRetired(); });
  app.post('/api/connectors/self/git/push/credential', async c => pushCredential(c, (await authenticateConnector(c)).id));
  app.post('/api/connectors/self/git/push/complete', async c => pushComplete(c, (await authenticateConnector(c)).id));
  app.post('/api/connectors/self/restores/:restoreId/download', async c => connectorRestoreDownload(c, (await authenticateConnector(c)).id));
  app.post('/api/connectors/self/network', async c => egressGrant(c, (await authenticateConnector(c)).id));
  // How the host runs its sessions, as its owner and admins set it; the connector asks when it connects, then at most
  // every 30 seconds (HostConfigSource), so a change reaches running sessions within a minute.
  app.post('/api/connectors/self/config', async c => c.json({ config: await connectorHostConfig(c.env, (await authenticateConnector(c)).id) }));
  app.post('/api/connectors/self/git/relay/:bindingId/:service', async c => gitRelay(c, await authenticateConnector(c)));
  // A credential for the host's egress proxy to make one Git request at the forge itself, or the word to relay it.
  app.post('/api/connectors/self/git/direct', async c => gitDirect(c, await authenticateConnector(c)));
  // The credential a session's egress proxy adds to the GitHub API requests it answers itself (api-access.ts).
  app.post('/api/connectors/self/api/credential', async c => apiCredential(c, await authenticateConnector(c)));
  // A direct-upload grant a desktop app handed this host, checked before the host takes the chunk (file-uploads.ts).
  app.post('/api/connectors/self/uploads/verify', async c => verifyDirectUpload(c, await authenticateConnector(c)));
}

/** A one-use pairing code for a new host of `ownerId`, valid ten minutes; also how a local server pairs its own machine. */
export async function createPairing(env: Env, ownerId: string, name: string): Promise<ConnectorPairing> {
  const pairingId = id(); const code = randomToken(); const expires = Math.floor(Date.now() / 1000) + 600;
  await env.DB.query('DELETE FROM connector_pairings WHERE owner_id = ? AND expires_at <= ?').bind(ownerId, Math.floor(Date.now() / 1000)).run();
  const created = await env.DB.query(`INSERT INTO connector_pairings (id,owner_id,name,code_hash,expires_at,created_at,workspace_id)
    SELECT ?,?,?,?,?,?,NULL WHERE (SELECT COUNT(*) FROM connector_pairings WHERE owner_id = ?) < 5
    AND (SELECT COUNT(*) FROM connectors WHERE owner_id = ? AND revoked_at IS NULL) < 20
    AND EXISTS (SELECT 1 FROM users WHERE id = ? AND (? = 1 OR auth_kind <> 'test')) RETURNING id`)
    .bind(pairingId, ownerId, name, await sha256(code), expires, now(), ownerId, ownerId, ownerId, testMode(env) ? 1 : 0).first();
  if (!created) {
    // The write refuses a test user once test mode is off: a refusal, not a limit, so tell them apart.
    const testUser = await env.DB.query('SELECT 1 FROM users WHERE id = ? AND auth_kind = \'test\'').bind(ownerId).first();
    if (testUser && !testMode(env)) fail(403, 'test_mode_disabled', 'Test users can pair hosts only while test mode is on.');
    fail(429, 'pairing_limit', 'Too many active pairings or connectors.');
  }
  return { id: pairingId, code, expiresAt: new Date(expires * 1000).toISOString() };
}

export function registerConnectors(app: Hono<WorkerEnv>): void {
  app.post('/api/connectors/pairings', async c => {
    const input = await jsonObject(c, 4096);
    // `workspaceId` is accepted, and ignored, from pages that predate it: a host is no longer paired into a workspace.
    onlyFields(input, ['name', 'workspaceId']);
    const name = text(input.name, 'name', 120);
    return c.json({ pairing: await createPairing(c.env, c.get('auth').userId, name) }, 201);
  });
  app.get('/api/connectors', async c => {
    const rows = await c.env.DB.query<ConnectorInfoRow>(`SELECT c.*, u.display_name AS owner_name,
      (SELECT json_group_array(s.workspace_id) FROM connector_shares s JOIN workspace_members m
        ON m.workspace_id = s.workspace_id AND m.user_id = c.owner_id WHERE s.connector_id = c.id) AS workspace_ids,
      (SELECT json_group_array(cw.workspace_id) FROM connector_workspaces cw JOIN workspace_members m
        ON m.workspace_id = cw.workspace_id AND m.user_id = c.owner_id WHERE cw.connector_id = c.id) AS connected_workspace_ids
      FROM connectors c JOIN users u ON u.id = c.owner_id WHERE c.removed_at IS NULL
        AND (c.owner_id = ? OR EXISTS (SELECT 1 FROM connector_admins a WHERE a.connector_id = c.id AND a.user_id = ?))
      ORDER BY c.created_at DESC LIMIT 100`)
      .bind(c.get('auth').userId, c.get('auth').userId).all();
    const userId = c.get('auth').userId;
    // Owners and admins see its admins and grants; an admin's listing names the owner's shares, which they manage.
    return c.json({ connectors: await connectorInfos(c.env, rows, row => ({ userId, role: row.owner_id === userId ? 'owner' : 'admin' })) });
  });
  app.get('/api/workspaces/:id/connectors', async c => {
    const workspaceId = identifier(c.req.param('id'));
    await requireMember(c.env, workspaceId, c.get('auth').userId);
    const rows = await c.env.DB.query<ConnectorInfoRow>(`SELECT c.*, u.display_name AS owner_name,
      CASE WHEN EXISTS (SELECT 1 FROM connector_shares sh WHERE sh.connector_id = c.id AND sh.workspace_id = cw.workspace_id)
        THEN json_array(cw.workspace_id) ELSE json_array() END AS workspace_ids,
      json_array(cw.workspace_id) AS connected_workspace_ids
      FROM connectors c JOIN connector_workspaces cw ON cw.connector_id = c.id
      JOIN workspace_members m ON m.workspace_id = cw.workspace_id AND m.user_id = c.owner_id
      JOIN workspace_members actor ON actor.workspace_id = cw.workspace_id AND actor.user_id = ?
      JOIN users u ON u.id = c.owner_id WHERE cw.workspace_id = ? AND c.revoked_at IS NULL
      AND (c.owner_id = actor.user_id OR EXISTS (SELECT 1 FROM connector_shares sh
        WHERE sh.connector_id = c.id AND sh.workspace_id = cw.workspace_id))
      AND (? = 1 OR u.auth_kind <> 'test') ORDER BY c.created_at DESC LIMIT 30`)
      .bind(c.get('auth').userId, workspaceId, testMode(c.env) ? 1 : 0).all();
    const userId = c.get('auth').userId;
    return c.json({ connectors: await connectorInfos(c.env, rows, () => ({ userId, workspaceId })) });
  });
  // Its owner or an admin shares a host, into a workspace both they and the owner belong to.
  app.put('/api/connectors/:id/shares/:workspaceId', async c => {
    const row = await managedConnector(c);
    if (row.revoked_at) fail(409, 'connector_revoked', 'Connector is revoked.');
    const workspaceId = identifier(c.req.param('workspaceId'));
    await requireManagedWorkspace(c.env, row, workspaceId, c.get('auth').userId);
    await requireMember(c.env, workspaceId, row.owner_id);
    await requireConfiguredWorkspace(c.env, workspaceId, row.owner_id);
    const legacy = testMode(c.env) && await legacyRepositoryFixture(c.env, row.owner_id);
    const results = await c.env.DB.batch([
      c.env.DB.query(`INSERT INTO connector_shares (connector_id,workspace_id,created_at)
      SELECT ?,?,? WHERE ((SELECT COUNT(*) FROM connector_shares WHERE connector_id = ?) < 50
        OR EXISTS (SELECT 1 FROM connector_shares WHERE connector_id = ? AND workspace_id = ?))
      AND EXISTS (SELECT 1 FROM connectors WHERE id = ? AND owner_id = ? AND revoked_at IS NULL)
      AND EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?)
      AND (${workspaceHasSourceSQL('?')}
        OR (? = 1 AND EXISTS (SELECT 1 FROM users WHERE id = ? AND auth_kind = 'test')))
      ON CONFLICT (connector_id, workspace_id) DO UPDATE SET created_at = connector_shares.created_at
      RETURNING connector_id`)
      .bind(row.id, workspaceId, now(), row.id, row.id, workspaceId, row.id, row.owner_id, workspaceId, row.owner_id,
        workspaceId, legacy && testMode(c.env) ? 1 : 0, row.owner_id),
      c.env.DB.query(`INSERT INTO connector_workspaces (connector_id,workspace_id,created_at)
        SELECT ?,?,? WHERE changes() = 1
        ON CONFLICT (connector_id, workspace_id) DO NOTHING`).bind(row.id, workspaceId, now()),
    ]);
    const shared = results[0].results[0];
    if (!shared) {
      const atLimit = await c.env.DB.query(`SELECT 1 WHERE
        (SELECT COUNT(*) FROM connector_shares WHERE connector_id = ?) >= 50
        AND NOT EXISTS (SELECT 1 FROM connector_shares WHERE connector_id = ? AND workspace_id = ?)`)
        .bind(row.id, row.id, workspaceId).first();
      if (atLimit) fail(429, 'share_limit', 'Connector share limit reached.');
      fail(409, 'share_unavailable', 'Connector or workspace authority changed.');
    }
    await syncModels(c.env, row, workspaceId);
    await auditStatement(c.env, c.get('auth').userId, 'connector.share.added', workspaceId, null, { connectorId: row.id }).run();
    return c.json({ connector: await connectorInfo(c.env, row) });
  });
  // Unsharing also ends the workspace's host command grants. An admin unshares only where they are a member.
  app.delete('/api/connectors/:id/shares/:workspaceId', async c => {
    const row = await managedConnector(c);
    const workspaceId = identifier(c.req.param('workspaceId'));
    await requireManagedWorkspace(c.env, row, workspaceId, c.get('auth').userId);
    await c.env.DB.batch([
      c.env.DB.query('DELETE FROM connector_shares WHERE connector_id = ? AND workspace_id = ?').bind(row.id, workspaceId),
      c.env.DB.query('DELETE FROM connector_host_grants WHERE connector_id = ? AND workspace_id = ?').bind(row.id, workspaceId),
      auditStatement(c.env, c.get('auth').userId, 'connector.share.removed', workspaceId, null, { connectorId: row.id }),
      c.env.DB.query(`UPDATE sessions SET policy_version = policy_version + 1
        WHERE connector_id = ? AND workspace_id = ? AND owner_id <> ?`).bind(row.id, workspaceId, row.owner_id),
    ]);
    return c.body(null, 204);
  });
  app.delete('/api/connectors/:id/permanent', async c => {
    const row = await ownedConnector(c);
    const timestamp = now();
    // Keep a revoked tombstone for immutable session and model bindings.
    await c.env.DB.batch([
      c.env.DB.query(`UPDATE connectors SET removed_at = ?, revoked_at = COALESCE(revoked_at, ?),
        connection_hash = NULL, credential_hash = ?, name = 'Removed host', models_json = '[]', capabilities_json = '{}', connector_version = NULL
        WHERE id = ?`).bind(timestamp, timestamp, await sha256(randomToken()), row.id),
      c.env.DB.query('DELETE FROM connector_shares WHERE connector_id = ?').bind(row.id),
      c.env.DB.query('DELETE FROM connector_workspaces WHERE connector_id = ?').bind(row.id),
      c.env.DB.query('DELETE FROM connector_host_grants WHERE connector_id = ?').bind(row.id),
      c.env.DB.query('DELETE FROM connector_admins WHERE connector_id = ?').bind(row.id),
      c.env.DB.query('DELETE FROM connector_disabled_models WHERE connector_id = ?').bind(row.id),
      c.env.DB.query('DELETE FROM connector_extensions WHERE connector_id = ?').bind(row.id),
      c.env.DB.query('DELETE FROM connector_extension_settings WHERE connector_id = ?').bind(row.id),
      c.env.DB.query('DELETE FROM connector_extension_requests WHERE connector_id = ?').bind(row.id),
      c.env.DB.query('UPDATE models SET available = 0 WHERE connector_id = ?').bind(row.id),
      c.env.DB.query('UPDATE sessions SET policy_version = policy_version + 1 WHERE connector_id = ?').bind(row.id),
    ]);
    if (c.env.CONNECTOR_HUB) {
      try { await c.env.CONNECTOR_HUB.revoke(row.id); }
      catch { /* Database revocation already fences all authority. */ }
    }
    return c.body(null, 204);
  });
  app.delete('/api/connectors/:id', async c => {
    const row = await ownedConnector(c);
    await c.env.DB.batch([
      c.env.DB.query('UPDATE connectors SET revoked_at = COALESCE(revoked_at, ?), connection_hash = NULL WHERE id = ?').bind(now(), row.id),
      c.env.DB.query('UPDATE sessions SET policy_version = policy_version + 1 WHERE connector_id = ?').bind(row.id),
    ]);
    if (c.env.CONNECTOR_HUB) {
      try {
        await c.env.CONNECTOR_HUB.revoke(row.id);
      } catch { /* Database revocation already fences all authority. */ }
    }
    return c.body(null, 204);
  });
}
