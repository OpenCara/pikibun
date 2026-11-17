import type { Hono } from 'hono';
import { parseCapabilities } from '../../../packages/shared/src/connector.js';
import { sessionBranchName } from '../../../packages/shared/src/git-push.js';
import {
  canonicalJson, parseSettings, verifiedSigned, type PortableSettings, type Signed, type StatementOf,
} from '../../../packages/shared/src/identity.js';
import type { PortableSessionOffer, SessionRecord, SessionSchedule } from '../../../packages/shared/src/types.js';
import { auditStatement, authenticateConnector, isPersonalWorkspace, type ConnectorRow } from './authority/index.js';
import { chatAgentVersion, requireModel } from './catalog.js';
import { sessionRecord } from './db.js';
import { z } from 'zod';
import { appOrigin, fail, id, identifier, now } from './http.js';
import { body, fields, identifier as identifierField, text as textField } from './schemas.js';
import { ownerRequest, runnerJSON, runnerRequest } from './runner.js';
import { restorePortableSchedules, sessionSchedules } from './scheduled-prompts.js';
import { markSessionChanged } from './session-changes.js';
import { bindingForSession } from './sessions.js';
import { newSessionToolOutput, workspaceTranscriptSettings } from './transcript-settings.js';
import { ConstraintError, type Query } from './db/types.js';
import type { AppContext, AppEnv, Env, SessionRow } from './types.js';

const REPORT_BYTES = 1024 * 1024;
const MAX_REPORTED = 500;
const MAX_ROTATIONS = 32;
const CONVERT_BATCH = 50;

const identityReportBody = fields({
  delegation: z.unknown(), rotations: z.array(z.unknown(), { error: 'Invalid identity rotations.' }).max(MAX_ROTATIONS, 'Invalid identity rotations.'),
  settings: z.unknown().optional(), sessions: z.array(z.unknown(), { error: 'The report lists no sessions.' }).max(MAX_REPORTED, 'Invalid portable session report.'),
}, 'Unexpected identity report field.', { required: ['delegation', 'rotations', 'sessions'], code: 'invalid_report' });
const signedSettingsBody = fields({ settings: z.unknown() }, 'Unexpected settings field.', { required: ['settings'], code: 'invalid_report' });
const detachedBody = fields({ sessionId: identifierField('sessionId') }, 'Unexpected detached report field.', { required: ['sessionId'], code: 'invalid_report' });
const attachBody = fields({ connectorId: identifierField('connectorId'), modelId: identifierField('modelId').optional() },
  'Name the host (connectorId) and, optionally, a model of it.', { required: ['connectorId'] });
const convertBody = fields({ after: fields({ createdAt: textField('after.createdAt', 64), id: identifierField('after.id') },
  'Continue after a session\'s createdAt and id.', { required: ['createdAt', 'id'] }).optional() }, 'Only where to continue (after) is taken.');

interface DelegationRow { connector_id: string; user_id: string; public_key: string }
interface OfferRow {
  connector_id: string; session_id: string; user_id: string; public_key: string; title: string; created_at: string; host_environment: number;
  provider: string; model_id: string; attached: number; working: number; reported_at: string;
}
interface SettingsRow {
  user_id: string; public_key: string | null; version: number; statement_json: string | null; signature: string | null;
  applied_version: number; pending_version: number | null; pending_json: string | null; updated_at: string;
}


function plainText(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
}

async function personalWorkspaceOf(env: Env, userId: string): Promise<string | null> {
  return (await env.DB.query<{ workspace_id: string }>('SELECT workspace_id FROM personal_workspaces WHERE user_id = ?').bind(userId).first())?.workspace_id ?? null;
}

export async function delegationFor(env: Env, connectorId: string, userId: string): Promise<DelegationRow | null> {
  return env.DB.query<DelegationRow>(`SELECT d.connector_id, d.user_id, d.public_key FROM identity_delegations d
    JOIN connectors c ON c.id = d.connector_id AND c.owner_id = d.user_id AND c.revoked_at IS NULL
    WHERE d.connector_id = ? AND d.user_id = ?`).bind(connectorId, userId).first();
}

export async function portableKeyFor(env: Env, row: Pick<SessionRow, 'workspace_id' | 'owner_id' | 'connector_id' | 'connector_owner_id' | 'host_environment'>,
  sourcesEmpty: boolean): Promise<string | null> {
  if (!row.connector_id || row.connector_owner_id !== row.owner_id) return null;
  if (Number(row.host_environment ?? 0) !== 1 && !sourcesEmpty) return null;
  const capabilities = parseCapabilities((await env.DB.query<{ capabilities_json: string }>('SELECT capabilities_json FROM connectors WHERE id = ?')
    .bind(row.connector_id).first())?.capabilities_json);
  if (capabilities.portableSessions !== true || !await isPersonalWorkspace(env, row.workspace_id, row.owner_id)) return null;
  return (await delegationFor(env, row.connector_id, row.owner_id))?.public_key ?? null;
}

async function currentSettings(env: Env, workspaceId: string): Promise<PortableSettings> {
  const workspace = await env.DB.query<{ name: string }>('SELECT name FROM workspaces WHERE id = ?').bind(workspaceId).first();
  const transcripts = await workspaceTranscriptSettings(env.DB, workspaceId);
  return parseSettings({ ...(workspace ? { name: workspace.name } : {}), toolOutput: transcripts.toolOutput, paging: transcripts.paging });
}

export async function portableSettingsChanged(env: Env, workspaceId: string): Promise<void> {
  const owner = await env.DB.query<{ user_id: string }>('SELECT user_id FROM personal_workspaces WHERE workspace_id = ?').bind(workspaceId).first();
  if (!owner) return;
  const settings = canonicalJson(await currentSettings(env, workspaceId));
  const timestamp = now();
  await env.DB.query(`INSERT INTO portable_settings (user_id, version, applied_version, pending_version, pending_json, updated_at)
    VALUES (?, 0, 0, 1, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET pending_version = (CASE WHEN portable_settings.version > COALESCE(portable_settings.pending_version, 0)
        THEN portable_settings.version ELSE COALESCE(portable_settings.pending_version, 0) END) + 1,
      pending_json = excluded.pending_json, updated_at = excluded.updated_at`).bind(owner.user_id, settings, timestamp).run();
}

async function applySettings(env: Env, userId: string, settings: PortableSettings): Promise<void> {
  const workspaceId = await personalWorkspaceOf(env, userId);
  if (!workspaceId) return;
  const timestamp = now();
  const transcripts = await workspaceTranscriptSettings(env.DB, workspaceId);
  await env.DB.batch([
    ...(settings.name ? [env.DB.query<never>('UPDATE workspaces SET name = ? WHERE id = ?').bind(settings.name, workspaceId)] : []),
    env.DB.query<never>(`INSERT INTO workspace_transcript_settings (workspace_id, paging, tool_output, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (workspace_id) DO UPDATE SET paging = excluded.paging, tool_output = excluded.tool_output, updated_by = excluded.updated_by,
        updated_at = excluded.updated_at`)
      .bind(workspaceId, (settings.paging ?? transcripts.paging) ? 1 : 0, settings.toolOutput ?? transcripts.toolOutput, userId, timestamp),
    auditStatement(env, userId, 'workspace.portable_settings.applied', workspaceId, null, { ...(settings.name ? { renamed: true } : {}) }),
  ]);
}

async function storeSettings(env: Env, userId: string, signed: Signed<StatementOf<'settings'>>, apply: boolean): Promise<void> {
  const current = await env.DB.query<SettingsRow>('SELECT * FROM portable_settings WHERE user_id = ?').bind(userId).first();
  const version = signed.statement.version;
  if (current && version <= Number(current.version)) return;
  const timestamp = now();
  await env.DB.query(`INSERT INTO portable_settings (user_id, public_key, version, statement_json, signature, applied_version, pending_version, pending_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)
    ON CONFLICT (user_id) DO UPDATE SET public_key = excluded.public_key, version = excluded.version, statement_json = excluded.statement_json,
      signature = excluded.signature, applied_version = CASE WHEN portable_settings.applied_version > excluded.applied_version
        THEN portable_settings.applied_version ELSE excluded.applied_version END,
      pending_version = CASE WHEN portable_settings.pending_version > excluded.version THEN portable_settings.pending_version
        WHEN ? = 1 AND portable_settings.pending_version = excluded.version THEN excluded.version + 1 ELSE NULL END,
      pending_json = CASE WHEN portable_settings.pending_version > excluded.version OR (? = 1 AND portable_settings.pending_version = excluded.version)
        THEN portable_settings.pending_json ELSE NULL END,
      updated_at = excluded.updated_at`)
    .bind(userId, signed.statement.key, version, canonicalJson(signed.statement), signed.signature, version, timestamp, apply ? 1 : 0, apply ? 1 : 0).run();
  const newer = !current || version > Number(current.applied_version);
  const localEdit = current?.pending_version !== null && current?.pending_version !== undefined && Number(current.pending_version) >= version;
  if (apply && newer && !localEdit) await applySettings(env, userId, signed.statement.settings);
}

type ReportedSession = {
  id: string; title: string; createdAt: string; attached: boolean; hostEnvironment: boolean; working: boolean;
  model: { provider: string; modelId: string }; mark: Signed<StatementOf<'session'>>;
};

async function reportedSessions(value: unknown, key: string): Promise<ReportedSession[]> {
  if (!Array.isArray(value) || value.length > MAX_REPORTED) fail(400, 'invalid_report', 'Invalid portable session report.');
  const reported: ReportedSession[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const input = item as Record<string, unknown>;
    const model = input?.model as Record<string, unknown> | undefined;
    const title = plainText(input?.title, 200);
    const provider = plainText(model?.provider, 80);
    const modelId = plainText(model?.modelId, 200);
    if (!input || typeof input !== 'object' || typeof input.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.id) || !title
      || typeof input.createdAt !== 'string' || Number.isNaN(Date.parse(input.createdAt)) || typeof input.attached !== 'boolean'
      || typeof input.hostEnvironment !== 'boolean' || typeof input.working !== 'boolean' || !provider || !modelId || seen.has(input.id)) continue;
    let mark: Signed<StatementOf<'session'>>;
    try { mark = await verifiedSigned(input.mark, 'session'); }
    catch { continue; }
    if (mark.statement.session !== input.id || mark.statement.key !== key) continue;
    seen.add(input.id);
    reported.push({ id: input.id, title, createdAt: input.createdAt, attached: input.attached, hostEnvironment: input.hostEnvironment, working: input.working,
      model: { provider, modelId }, mark });
  }
  return reported;
}

async function identityReport(c: AppContext): Promise<Response> {
  const connector = await authenticateConnector(c);
  const input = await body(c, identityReportBody, { maxBytes: REPORT_BYTES });
  let delegation: Signed<StatementOf<'delegation'>>;
  try { delegation = await verifiedSigned(input.delegation, 'delegation'); }
  catch { fail(400, 'invalid_delegation', 'The host\'s delegation is not validly signed.'); }
  if (delegation.statement.server !== appOrigin(c.env) || delegation.statement.connector !== connector.id) {
    fail(403, 'foreign_delegation', 'The delegation names another server or host.');
  }
  const key = delegation.statement.key;
  const rotations = input.rotations;
  const statements: Query<never>[] = [];
  const chain: Signed<StatementOf<'rotation'>>[] = [];
  for (const rotation of rotations) {
    try { chain.push(await verifiedSigned(rotation, 'rotation')); }
    catch { chain.length = 0; break; }
  }
  const linked = chain.length > 0 && chain.at(-1)!.statement.next === key && chain.every((rotation, index) => index === 0 || chain[index - 1]!.statement.next === rotation.statement.key);
  if (linked) {
    for (const rotation of chain) {
      statements.push(c.env.DB.query<never>('UPDATE sessions SET portable_key = ? WHERE owner_id = ? AND portable_key = ?')
        .bind(key, connector.owner_id, rotation.statement.key));
    }
  }
  const sessions = await reportedSessions(input.sessions, key);
  const timestamp = now();
  statements.push(
    c.env.DB.query<never>(`INSERT INTO identity_delegations (connector_id, user_id, public_key, statement_json, signature, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (connector_id) DO UPDATE SET user_id = excluded.user_id, public_key = excluded.public_key, statement_json = excluded.statement_json,
        signature = excluded.signature, created_at = excluded.created_at`)
      .bind(connector.id, connector.owner_id, key, canonicalJson(delegation.statement), delegation.signature, timestamp),
    c.env.DB.query<never>('DELETE FROM portable_offers WHERE connector_id = ?').bind(connector.id),
  );
  for (const session of sessions) {
    statements.push(
      c.env.DB.query<never>(`INSERT INTO portable_offers (connector_id, session_id, user_id, public_key, title, created_at, host_environment, provider, model_id,
        attached, working, reported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(connector.id, session.id, connector.owner_id, key, session.title, session.createdAt, session.hostEnvironment ? 1 : 0,
          session.model.provider, session.model.modelId, session.attached ? 1 : 0, session.working ? 1 : 0, timestamp),
      c.env.DB.query<never>('UPDATE sessions SET portable_key = ? WHERE id = ? AND owner_id = ? AND connector_id = ? AND portable_key IS NOT NULL')
        .bind(key, session.id, connector.owner_id, connector.id),
    );
  }
  await c.env.DB.batch(statements);
  if (input.settings !== undefined && input.settings !== null) {
    let settings: Signed<StatementOf<'settings'>> | undefined;
    try { settings = await verifiedSigned(input.settings, 'settings'); } catch { settings = undefined; }
    if (settings && settings.statement.key === key) await storeSettings(c.env, connector.owner_id, settings, true);
  }
  const pending = await c.env.DB.query<SettingsRow>('SELECT * FROM portable_settings WHERE user_id = ?').bind(connector.owner_id).first();
  if (pending?.pending_version && pending.pending_json && Number(pending.pending_version) > Number(pending.version)) {
    return c.json({ sign: { version: Number(pending.pending_version), settings: JSON.parse(pending.pending_json) } });
  }
  return c.json({});
}

async function signedSettings(c: AppContext): Promise<Response> {
  const connector = await authenticateConnector(c);
  const input = await body(c, signedSettingsBody, { maxBytes: 64 * 1024 });
  let settings: Signed<StatementOf<'settings'>>;
  try { settings = await verifiedSigned(input.settings, 'settings'); }
  catch { fail(400, 'invalid_settings', 'The settings are not validly signed.'); }
  const delegation = await delegationFor(c.env, connector.id, connector.owner_id);
  if (!delegation || delegation.public_key !== settings.statement.key) fail(403, 'foreign_settings', 'The settings are signed by another identity.');
  await storeSettings(c.env, connector.owner_id, settings, false);
  return c.json({ ok: true });
}

async function detached(c: AppContext): Promise<Response> {
  const connector = await authenticateConnector(c);
  const { sessionId } = await body(c, detachedBody, { maxBytes: 4096 });
  const row = await c.env.DB.query<SessionRow>(`UPDATE sessions SET archived_status = CASE WHEN status = 'archived' THEN archived_status ELSE status END,
    status = 'archived', detached_at = ?, policy_version = policy_version + 1, pack_due_at = NULL, tunnel_url = NULL, tunnel_expires_at = NULL
    WHERE id = ? AND connector_id = ? AND owner_id = ? AND portable_key IS NOT NULL AND detached_at IS NULL RETURNING *`)
    .bind(now(), sessionId, connector.id, connector.owner_id).first();
  if (row) {
    await c.env.DB.batch([
      c.env.DB.query<never>('UPDATE portable_offers SET attached = 0 WHERE connector_id = ? AND session_id = ?').bind(connector.id, sessionId),
      auditStatement(c.env, connector.owner_id, 'session.detached', row.workspace_id, row.id, { connectorId: connector.id }),
    ]);
    await markSessionChanged(c.env, row.id);
  }
  return c.json({ ok: true });
}

export function registerPortableConnectorRoutes(app: Hono<AppEnv>): void {
  app.post('/api/connectors/self/identity', identityReport);
  app.post('/api/connectors/self/identity/settings', signedSettings);
  app.post('/api/connectors/self/portable/detached', detached);
}

export async function portableOffers(env: Env, userId: string): Promise<PortableSessionOffer[]> {
  const workspaceId = await personalWorkspaceOf(env, userId);
  const rows = await env.DB.query<OfferRow & { host_name: string; local_model_id: string | null; existing: number }>(`SELECT o.*, c.name AS host_name,
      (SELECT m.id FROM models m WHERE m.workspace_id = ? AND m.connector_id = o.connector_id AND m.provider = o.provider AND m.model_id = o.model_id
        AND m.available = 1 LIMIT 1) AS local_model_id,
      EXISTS (SELECT 1 FROM sessions s WHERE s.id = o.session_id) AS existing
    FROM portable_offers o
    JOIN connectors c ON c.id = o.connector_id AND c.owner_id = o.user_id AND c.revoked_at IS NULL
    JOIN identity_delegations d ON d.connector_id = o.connector_id AND d.user_id = o.user_id AND d.public_key = o.public_key
    WHERE o.user_id = ? AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = o.session_id AND s.connector_id = o.connector_id AND s.status <> 'archived')
    ORDER BY o.created_at DESC, o.session_id LIMIT 500`).bind(workspaceId ?? '', userId).all();
  return rows.map(row => ({ id: row.session_id, title: row.title, createdAt: row.created_at, connectorId: row.connector_id, hostName: row.host_name,
    hostEnvironment: Number(row.host_environment) === 1, working: Number(row.working) === 1, attachedElsewhere: Number(row.attached) !== 1,
    model: { provider: row.provider, modelId: row.model_id }, ...(row.local_model_id ? { modelId: row.local_model_id } : {}),
    ...(Number(row.existing) === 1 ? { existing: true } : {}) }));
}

function keptSchedules(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)).slice(0, 50) : [];
}

async function attachSession(c: AppContext): Promise<Response> {
  const userId = c.get('auth').userId;
  const sessionId = identifier(c.req.param('id'));
  const input = await body(c, attachBody, { maxBytes: 4096 });
  const connectorId = input.connectorId;
  const offer = await c.env.DB.query<OfferRow>('SELECT * FROM portable_offers WHERE connector_id = ? AND session_id = ? AND user_id = ?')
    .bind(connectorId, sessionId, userId).first();
  if (!offer) fail(404, 'not_found', 'That host hasn\'t reported this session. Start the host, or wait a minute for it to report.');
  const delegation = await delegationFor(c.env, connectorId, userId);
  if (!delegation || delegation.public_key !== offer.public_key) fail(403, 'identity_mismatch', 'This session belongs to an identity the host doesn\'t act for here.');
  if (Number(offer.working) === 1) fail(409, 'session_working', 'This session is working where it is attached now. Wait for it to finish, or stop it there.');
  const workspaceId = await personalWorkspaceOf(c.env, userId);
  if (!workspaceId) fail(409, 'no_private_workspace', 'Open Pikibun once so it makes your private workspace, then try again.');
  const connector = await c.env.DB.query<ConnectorRow>('SELECT * FROM connectors WHERE id = ? AND owner_id = ? AND revoked_at IS NULL').bind(connectorId, userId).first();
  if (!connector) fail(404, 'not_found', 'Host not found.');
  const capabilities = parseCapabilities(connector.capabilities_json);
  if (capabilities.portableSessions !== true) fail(409, 'connector_update_required', 'Update the host\'s connector (npx pikibun@latest connect) to bring sessions here.');
  const modelId = input.modelId === undefined ? (await c.env.DB.query<{ id: string }>(`SELECT id FROM models WHERE workspace_id = ? AND connector_id = ? AND provider = ?
    AND model_id = ? AND available = 1`).bind(workspaceId, connectorId, offer.provider, offer.model_id).first())?.id : identifier(input.modelId, 'modelId');
  if (!modelId) fail(409, 'model_required', 'The host no longer offers the model this session ran on. Choose one of its models.');
  const model = await requireModel(c.env, modelId, userId);
  if (model.workspace_id !== workspaceId || model.connector_id !== connectorId) fail(400, 'invalid_model', 'Choose a model of that host in your private workspace.');
  const existing = await c.env.DB.query<SessionRow>('SELECT * FROM sessions WHERE id = ?').bind(sessionId).first();
  if (existing && existing.status !== 'archived' && existing.connector_id === connectorId) fail(409, 'already_here', 'This session is attached here already.');
  const reuse = !!existing && existing.owner_id === userId && existing.workspace_id === workspaceId && existing.connector_id === connectorId
    && existing.repository_mode === 'clone' && (existing.repositories_json ?? '[]') === '[]';
  const targetId = existing && !reuse ? id() : sessionId;
  let row: SessionRow;
  if (reuse) {
    const updated = await c.env.DB.query<SessionRow>(`UPDATE sessions SET status = 'provisioning', archived_status = NULL, detached_at = NULL,
      policy_version = policy_version + 1, portable_key = ?, title = ?, pack_due_at = NULL
      WHERE id = ? AND owner_id = ? AND workspace_id = ? AND connector_id = ? AND policy_version = ? AND status = 'archived' RETURNING *`)
      .bind(offer.public_key, offer.title, sessionId, userId, workspaceId, connectorId, existing!.policy_version).first();
    if (!updated) fail(409, 'policy_changed', 'The session changed meanwhile; try again.');
    row = updated;
  } else {
    const agent = await chatAgentVersion(c.env, userId, model, capabilities);
    const branch = capabilities.sessionBranches === true ? sessionBranchName(offer.title, targetId) : null;
    let inserted: SessionRow | null;
    try {
      inserted = await c.env.DB.query<SessionRow>(`INSERT INTO sessions (id, workspace_id, owner_id, agent_version_id, title, policy_version, status, created_at,
        connector_id, connector_owner_id, repositories_json, visibility, repository_mode, branch, host_environment, tool_output, portable_key)
        SELECT ?, ?, ?, ?, ?, 1, 'provisioning', ?, ?, ?, '[]', 'workspace', 'clone', ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?) RETURNING *`)
        .bind(targetId, workspaceId, userId, agent.id, offer.title, offer.created_at, connectorId, userId, branch, Number(offer.host_environment) === 1 ? 1 : 0,
          await newSessionToolOutput(c.env.DB, workspaceId), offer.public_key, workspaceId, userId).first();
    } catch (error) {
      if (error instanceof ConstraintError) fail(409, 'attach_in_progress', 'This session is being brought here already.');
      throw error;
    }
    if (!inserted) fail(409, 'session_configuration_changed', 'Your private workspace changed meanwhile; try again.');
    row = inserted;
  }
  let kept: { title?: string; schedules?: unknown } | undefined;
  try {
    const binding = await bindingForSession(c, row);
    const result = await runnerJSON<{ session?: SessionRecord; kept?: { title?: string; schedules?: unknown } }>(
      await runnerRequest(c, row, 'attach', '', { binding, ...(targetId !== sessionId ? { sourceSessionId: sessionId } : {}) }));
    kept = result.kept;
  } catch (error) {
    if (reuse) {
      await c.env.DB.query(`UPDATE sessions SET status = 'archived', archived_status = ?, detached_at = ?, policy_version = policy_version + 1, portable_key = ?, title = ?
        WHERE id = ?`).bind(existing!.archived_status ?? null, existing!.detached_at ?? null, existing!.portable_key ?? null, existing!.title, sessionId).run();
    } else {
      await c.env.DB.query("DELETE FROM sessions WHERE id = ? AND status = 'provisioning'").bind(targetId).run();
    }
    throw error;
  }
  const ready = await c.env.DB.query<SessionRow>("UPDATE sessions SET status = 'ready' WHERE id = ? RETURNING *").bind(targetId).first() ?? row;
  await c.env.DB.batch([
    ...(targetId !== sessionId ? [
      c.env.DB.query<never>(`UPDATE sessions SET archived_status = CASE WHEN status = 'archived' THEN archived_status ELSE status END, status = 'archived',
        detached_at = COALESCE(detached_at, ?), policy_version = policy_version + 1, pack_due_at = NULL WHERE id = ? AND owner_id = ? AND portable_key IS NOT NULL`)
        .bind(now(), sessionId, userId),
      c.env.DB.query<never>('DELETE FROM portable_offers WHERE session_id = ? AND user_id = ?').bind(sessionId, userId),
    ] : [
      c.env.DB.query<never>('UPDATE portable_offers SET attached = CASE WHEN connector_id = ? THEN 1 ELSE 0 END WHERE session_id = ? AND user_id = ?').bind(connectorId, sessionId, userId),
    ]),
    auditStatement(c.env, userId, 'session.attached', workspaceId, targetId, { connectorId, ...(reuse ? { returned: true } : {}),
      ...(targetId !== sessionId ? { hostSessionId: sessionId } : {}) }),
  ]);
  const restored = await restorePortableSchedules(c.env, ready, keptSchedules(kept?.schedules));
  await markSessionChanged(c.env, targetId);
  return c.json({ session: sessionRecord(ready), ...(restored ? { schedules: restored } : {}) }, reuse ? 200 : 201);
}

async function convertSessions(c: AppContext): Promise<Response> {
  const userId = c.get('auth').userId;
  const connectorId = identifier(c.req.param('id'));
  const connector = await c.env.DB.query<ConnectorRow>('SELECT * FROM connectors WHERE id = ? AND owner_id = ? AND revoked_at IS NULL').bind(connectorId, userId).first();
  if (!connector) fail(404, 'not_found', 'Host not found.');
  if (parseCapabilities(connector.capabilities_json).portableSessions !== true) {
    fail(409, 'connector_update_required', 'Update the host\'s connector (npx pikibun@latest connect) to make its sessions portable.');
  }
  const delegation = await delegationFor(c.env, connectorId, userId);
  if (!delegation) fail(409, 'identity_pending', 'The host hasn\'t sent its identity yet. Wait a minute after it connects, then try again.');
  const workspaceId = await personalWorkspaceOf(c.env, userId);
  if (!workspaceId) fail(404, 'not_found', 'Private workspace not found.');
  const { after } = c.req.header('content-type') ? await body(c, convertBody, { maxBytes: 1024 }) : { after: undefined };
  const afterId = after?.id ?? null;
  const afterAt = after?.createdAt ?? null;
  const candidates = await c.env.DB.query<SessionRow>(`SELECT * FROM sessions WHERE workspace_id = ? AND owner_id = ? AND connector_id = ? AND connector_owner_id = ?
    AND portable_key IS NULL AND status IN ('ready', 'error') AND packed_at IS NULL AND repository_mode = 'clone' AND COALESCE(repositories_json, '[]') = '[]'
    AND (? IS NULL OR created_at > ? OR (created_at = ? AND id > ?))
    ORDER BY created_at, id LIMIT ?`).bind(workspaceId, userId, connectorId, userId, afterId, afterAt, afterAt, afterId,
      CONVERT_BATCH + 1).all();
  const more = candidates.length > CONVERT_BATCH;
  candidates.splice(CONVERT_BATCH);
  const last = candidates.at(-1);
  const converted: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const candidate of candidates) {
    const marked = await c.env.DB.query<SessionRow>('UPDATE sessions SET portable_key = ? WHERE id = ? AND portable_key IS NULL RETURNING *')
      .bind(delegation.public_key, candidate.id).first();
    if (!marked) continue;
    try {
      const response = await runnerRequest(c, marked, 'attach', '', { binding: await bindingForSession(c, marked) });
      await response.body?.cancel();
      converted.push(marked.id);
      await auditStatement(c.env, userId, 'session.portable', workspaceId, marked.id, { connectorId }).run();
      await keepPortable(c, marked);
    } catch (error) {
      await c.env.DB.query('UPDATE sessions SET portable_key = NULL WHERE id = ?').bind(marked.id).run();
      const message = error instanceof Error && 'getResponse' in error ? await (error as { getResponse(): Response }).getResponse().clone().json()
        .then((body: { error?: string }) => body.error ?? 'The host refused', () => 'The host refused') : 'The host refused';
      skipped.push({ id: marked.id, reason: message });
    }
  }
  return c.json({ converted, skipped, ...(more && last ? { next: { createdAt: last.created_at, id: last.id } } : {}) });
}

export async function keepPortable(c: AppContext, row: SessionRow): Promise<void> {
  if (!row.portable_key || !row.connector_id || row.status === 'archived') return;
  try {
    const schedules = (await sessionSchedules(c.env, row.id)).map((schedule: SessionSchedule) => ({ name: schedule.name, cron: schedule.cron, timeZone: schedule.timeZone,
      content: schedule.content, access: schedule.access, runIn: schedule.runIn ?? 'session', oneShot: schedule.oneShot !== false,
      ...(schedule.modelId ? { modelId: schedule.modelId } : {}), ...(schedule.thinkingLevel ? { thinkingLevel: schedule.thinkingLevel } : {}), enabled: schedule.enabled }));
    const response = await ownerRequest(c, row, 'portable', { title: row.title, schedules });
    await response.body?.cancel();
  } catch { }
}

export function registerPortableSessions(app: Hono<AppEnv>): void {
  app.get('/api/portable-sessions', async c => c.json({ sessions: await portableOffers(c.env, c.get('auth').userId) }));
  app.post('/api/portable-sessions/:id/attach', attachSession);
  app.post('/api/connectors/:id/portable', convertSessions);
}
