import type { Hono } from 'hono';
import { parseCapabilities } from '../../../packages/shared/src/connector.js';
import {
  canonicalJson, parseSettings, verifiedSigned, type PortableSettings, type Signed, type StatementOf,
} from '../../../packages/shared/src/identity.js';
import type { SessionSchedule } from '../../../packages/shared/src/types.js';
import { auditStatement, authenticateConnector, isPersonalWorkspace } from './authority/index.js';
import { z } from 'zod';
import { appOrigin, fail, now } from './http.js';
import { body, fields, identifier as identifierField } from './schemas.js';
import { ownerRequest } from './runner.js';
import { dropReport, holdReport, reportDigest, reportHeld } from './report-digests.js';
import { sessionSchedules } from './scheduled-prompts.js';
import { markSessionChanged } from './session-changes.js';
import { workspaceTranscriptSettings } from './transcript-settings.js';
import type { Query } from './db/types.js';
import type { AppContext, AppEnv, Env, SessionRow } from './types.js';

const REPORT_BYTES = 1024 * 1024;
const MAX_REPORTED = 500;
const MAX_ROTATIONS = 32;

const identityReportBody = fields({
  delegation: z.unknown(), rotations: z.array(z.unknown(), { error: 'Invalid identity rotations.' }).max(MAX_ROTATIONS, 'Invalid identity rotations.'),
  settings: z.unknown().optional(), sessions: z.array(z.unknown(), { error: 'The report lists no sessions.' }).max(MAX_REPORTED, 'Invalid portable session report.'),
}, 'Unexpected identity report field.', { required: ['delegation', 'rotations', 'sessions'], code: 'invalid_report' });
const signedSettingsBody = fields({ settings: z.unknown() }, 'Unexpected settings field.', { required: ['settings'], code: 'invalid_report' });
const detachedBody = fields({ sessionId: identifierField('sessionId') }, 'Unexpected detached report field.', { required: ['sessionId'], code: 'invalid_report' });

interface DelegationRow { connector_id: string; user_id: string; public_key: string }
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
  id: string; title: string; createdAt: string; attached: boolean; hostEnvironment: boolean; working: boolean; archived: boolean | null;
  model: { provider: string; modelId: string }; mark: Signed<StatementOf<'session'>>;
};

function reportsArchived(value: unknown): boolean {
  return Array.isArray(value) && value.some(item => !!item && typeof item === 'object' && 'archived' in item);
}

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
      || typeof input.hostEnvironment !== 'boolean' || typeof input.working !== 'boolean' || !provider || !modelId || seen.has(input.id)
      || (input.archived !== undefined && input.archived !== null && typeof input.archived !== 'boolean')) continue;
    let mark: Signed<StatementOf<'session'>>;
    try { mark = await verifiedSigned(input.mark, 'session'); }
    catch { continue; }
    if (mark.statement.session !== input.id || mark.statement.key !== key) continue;
    seen.add(input.id);
    reported.push({ id: input.id, title, createdAt: input.createdAt, attached: input.attached, hostEnvironment: input.hostEnvironment, working: input.working,
      archived: typeof input.archived === 'boolean' ? input.archived : null, model: { provider, modelId }, mark });
  }
  return reported;
}

async function identityReport(c: AppContext): Promise<Response> {
  const connector = await authenticateConnector(c);
  const input = await body(c, identityReportBody, { maxBytes: REPORT_BYTES });
  const reportKey = `identity:${connector.id}`;
  const digest = await reportDigest([connector.owner_id, appOrigin(c.env), input.delegation, input.rotations, input.settings ?? null, input.sessions]);
  const attached = reportHeld(c.env.DB, reportKey, digest) ? attachedIn(input.sessions) : await applyIdentityReport(c, connector, input, reportKey, digest);
  const archived = reportsArchived(input.sessions) ? await archivedHere(c.env, connector.id, connector.owner_id, attached) : undefined;
  const pending = await c.env.DB.query<SettingsRow>('SELECT * FROM portable_settings WHERE user_id = ?').bind(connector.owner_id).first();
  const sign = pending?.pending_version && pending.pending_json && Number(pending.pending_version) > Number(pending.version)
    ? { version: Number(pending.pending_version), settings: JSON.parse(pending.pending_json) } : undefined;
  return c.json({ ...(sign ? { sign } : {}), ...(archived ? { archived } : {}) });
}

function attachedIn(sessions: readonly unknown[]): Set<string> {
  return new Set(sessions.map(item => item as { id?: unknown; attached?: unknown } | null)
    .flatMap(item => item && item.attached === true && typeof item.id === 'string' ? [item.id] : []));
}

async function applyIdentityReport(c: AppContext, connector: { id: string; owner_id: string }, input: z.output<typeof identityReportBody>,
  reportKey: string, digest: string): Promise<Set<string>> {
  const applying = dropReport(c.env.DB, reportKey);
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
  );
  for (const session of sessions) {
    statements.push(
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
  if (sessions.length === input.sessions.length) holdReport(c.env.DB, reportKey, digest, applying);
  return new Set(sessions.filter(session => session.attached).map(session => session.id));
}

async function archivedHere(env: Env, connectorId: string, userId: string, attached: ReadonlySet<string>): Promise<string[]> {
  if (!attached.size) return [];
  const rows = await env.DB.query<{ id: string }>(`SELECT id FROM sessions WHERE connector_id = ? AND owner_id = ? AND portable_key IS NOT NULL
    AND status = 'archived' AND detached_at IS NULL`).bind(connectorId, userId).all();
  return rows.map(row => row.id).filter(sessionId => attached.has(sessionId)).sort();
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
    await auditStatement(c.env, connector.owner_id, 'session.detached', row.workspace_id, row.id, { connectorId: connector.id }).run();
    await markSessionChanged(c.env, row.id);
  }
  return c.json({ ok: true });
}

export function registerPortableConnectorRoutes(app: Hono<AppEnv>): void {
  app.post('/api/connectors/self/identity', identityReport);
  app.post('/api/connectors/self/identity/settings', signedSettings);
  app.post('/api/connectors/self/portable/detached', detached);
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
