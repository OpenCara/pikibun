import type { Hono, MiddlewareHandler } from 'hono';
import { connectorLimits, parseCapabilities } from '../../../packages/shared/src/connector.js';
import { PRIVATE_REPORT_LIMIT, PRIVATE_SESSIONS_VERSION, privateRoute, type PrivateForwardRequest, type PrivateForwardResponse } from '../../../packages/shared/src/private-sessions.js';
import { permissions, sessionActivities, type SessionActivity, type SessionRecord } from '../../../packages/shared/src/types.js';
import { authenticateConnector } from './authority/index.js';
import { privateConnectorRequest } from './connector-transport.js';
import { z } from 'zod';
import { fail, now } from './http.js';
import { body as requestBody, fields } from './schemas.js';
import { notifySessionActivity } from './notifications.js';
import type { AppContext, AppEnv, Env } from './types.js';

const IDENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const STATUSES = ['provisioning', 'ready', 'error', 'archived'];
const ONLINE_WITHIN_MS = 3 * 60_000;
const RECORD_BYTES = 16 * 1024;
const CREATE_FIELDS = ['title', 'hostEnvironment', 'generateTitle'];
const reportBody = fields({ sessions: z.array(z.unknown(), { error: 'Invalid private session report.' }).max(PRIVATE_REPORT_LIMIT, 'Invalid private session report.') },
  'Invalid private session report.', { required: ['sessions'], code: 'invalid_report' });

interface ForwardedRow {
  connector_id: string; session_id: string; user_id: string; record_json: string; activity: string | null; reported_at: string;
  host_name: string; connection_hash: string | null; workspace_id: string;
}

function shownTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const title = value.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200).trim();
  return title || undefined;
}

function plainLine(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value : undefined;
}

function smallObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  try { return JSON.stringify(value).length <= 4096 ? value as Record<string, unknown> : undefined; } catch { return undefined; }
}

export function reportedRecord(value: unknown): SessionRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const id = typeof input.id === 'string' && IDENT.test(input.id) ? input.id : undefined;
  const title = shownTitle(input.title);
  const agentVersionId = plainLine(input.agentVersionId, 128);
  const createdAt = typeof input.createdAt === 'string' && !Number.isNaN(Date.parse(input.createdAt)) ? input.createdAt : undefined;
  if (!id || !title || !agentVersionId || !createdAt || typeof input.status !== 'string' || !STATUSES.includes(input.status)
    || !Number.isSafeInteger(input.policyVersion)) return null;
  const activity = sessionActivities.includes(input.activity as SessionActivity) ? input.activity as SessionActivity : undefined;
  const branch = plainLine(input.branch, 300);
  const parentSessionId = typeof input.parentSessionId === 'string' && IDENT.test(input.parentSessionId) ? input.parentSessionId : undefined;
  const nextScheduledAt = typeof input.nextScheduledAt === 'string' && !Number.isNaN(Date.parse(input.nextScheduledAt)) ? input.nextScheduledAt : undefined;
  const pullRequest = smallObject(input.pullRequest);
  return {
    id, title, agentVersionId, createdAt, status: input.status as SessionRecord['status'], policyVersion: input.policyVersion as number, workspaceId: '', ownerId: '',
    repositoryMode: 'clone', ...(activity ? { activity } : {}), ...(branch ? { branch } : {}), ...(parentSessionId ? { parentSessionId } : {}),
    ...(input.packed === true ? { packed: true as const } : {}), ...(input.toolOutput === 'brief' ? { toolOutput: 'brief' as const } : {}),
    ...(input.hostEnvironment === true ? { hostEnvironment: true as const } : {}), ...(nextScheduledAt ? { nextScheduledAt } : {}),
    ...(pullRequest ? { pullRequest: pullRequest as unknown as SessionRecord['pullRequest'] } : {}),
  };
}

async function privateWorkspaceOf(env: Env, userId: string): Promise<string | null> {
  return await env.DB.query<{ workspace_id: string }>('SELECT workspace_id FROM personal_workspaces WHERE user_id = ?').bind(userId).first('workspace_id') ?? null;
}

function online(row: Pick<ForwardedRow, 'connection_hash' | 'reported_at'>): boolean {
  return !!row.connection_hash && Date.now() - Date.parse(row.reported_at) < ONLINE_WITHIN_MS;
}

function shown(record: SessionRecord, userId: string, workspaceId: string, connectorId: string, hostName: string, isOnline: boolean): SessionRecord {
  return { ...record, workspaceId, ownerId: userId, connectorId, connectorOwnerId: userId, permissions: [...permissions], visibility: 'workspace',
    forwarded: { hostName, online: isOnline } };
}

async function forwardedRows(env: Env, userId: string, sessionId?: string): Promise<ForwardedRow[]> {
  return env.DB.query<ForwardedRow>(`SELECT f.*, c.name AS host_name, c.connection_hash, p.workspace_id FROM forwarded_sessions f
    JOIN connectors c ON c.id = f.connector_id AND c.owner_id = f.user_id AND c.revoked_at IS NULL
    JOIN personal_workspaces p ON p.user_id = f.user_id
    WHERE f.user_id = ? ${sessionId ? 'AND f.session_id = ?' : ''}
      AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = f.session_id)
    ORDER BY f.reported_at DESC, f.connector_id`).bind(...(sessionId ? [userId, sessionId] : [userId])).all();
}

export async function forwardedRecords(env: Env, userId: string): Promise<SessionRecord[]> {
  const seen = new Set<string>();
  const records: SessionRecord[] = [];
  const rows = await forwardedRows(env, userId);
  for (const row of [...rows.filter(online), ...rows.filter(row => !online(row))]) {
    if (seen.has(row.session_id)) continue;
    const record = reportedRecord(JSON.parse(row.record_json));
    if (!record) continue;
    seen.add(row.session_id);
    records.push(shown(record, userId, row.workspace_id, row.connector_id, row.host_name, online(row)));
  }
  return records;
}

async function remember(env: Env, connectorId: string, userId: string, record: SessionRecord): Promise<void> {
  const json = JSON.stringify(record);
  if (json.length > RECORD_BYTES) return;
  await env.DB.query(`INSERT INTO forwarded_sessions (connector_id, session_id, user_id, record_json, activity, reported_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (connector_id, session_id) DO UPDATE SET record_json = excluded.record_json, activity = COALESCE(excluded.activity, forwarded_sessions.activity)`)
    .bind(connectorId, record.id, userId, json, record.activity ?? null, now()).run();
}

async function report(c: AppContext): Promise<Response> {
  const connector = await authenticateConnector(c);
  if ((parseCapabilities(connector.capabilities_json).privateSessions ?? 0) < PRIVATE_SESSIONS_VERSION) {
    fail(409, 'private_sessions_unsupported', 'This host doesn\'t say it forwards private sessions.');
  }
  const input = await requestBody(c, reportBody, { maxBytes: 4 * 1024 * 1024 });
  const records = new Map<string, SessionRecord>();
  for (const value of input.sessions) {
    const record = reportedRecord(value);
    if (record && !records.has(record.id) && JSON.stringify(record).length <= RECORD_BYTES) records.set(record.id, record);
  }
  const previous = new Map((await c.env.DB.query<{ session_id: string; activity: string | null }>('SELECT session_id, activity FROM forwarded_sessions WHERE connector_id = ?')
    .bind(connector.id).all()).map(row => [row.session_id, row.activity]));
  const at = now();
  await c.env.DB.batch([
    c.env.DB.query<never>('DELETE FROM forwarded_sessions WHERE connector_id = ?').bind(connector.id),
    ...[...records.values()].map(record => c.env.DB.query<never>(`INSERT INTO forwarded_sessions (connector_id, session_id, user_id, record_json, activity, reported_at)
      VALUES (?, ?, ?, ?, ?, ?)`).bind(connector.id, record.id, connector.owner_id, JSON.stringify(record), record.activity ?? null, at)),
  ]);
  const workspaceId = await privateWorkspaceOf(c.env, connector.owner_id);
  if (workspaceId) {
    for (const record of records.values()) {
      const before = previous.get(record.id);
      if (before === undefined || !record.activity || before === record.activity) continue;
      await notifySessionActivity(c.env, { id: record.id, title: record.title, owner_id: connector.owner_id, workspace_id: workspaceId },
        before as SessionActivity | null, record.activity, true).catch(() => {});
    }
  }
  return c.json({ ok: true });
}

export function registerForwardedConnectorRoutes(app: Hono<AppEnv>): void {
  app.post('/api/connectors/self/private-sessions', report);
}

async function bodyText(c: AppContext): Promise<string> {
  const declared = Number(c.req.header('content-length'));
  if (Number.isFinite(declared) && declared > connectorLimits.requestBytes) fail(413, 'body_too_large', 'Request body is too large.');
  const reader = c.req.raw.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > connectorLimits.requestBytes) { await reader.cancel(); fail(413, 'body_too_large', 'Request body is too large.'); }
    chunks.push(part.value);
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { fail(400, 'invalid_input', 'Expected UTF-8 text.'); }
}

async function relay(c: AppContext, row: Pick<ForwardedRow, 'connector_id' | 'host_name'>, request: PrivateForwardRequest): Promise<{ answer: PrivateForwardResponse; json?: unknown }> {
  const answer = await privateConnectorRequest(c, row.connector_id, request);
  if (!answer.contentType.startsWith('application/json')) return { answer };
  let json: unknown;
  try { json = JSON.parse(Buffer.from(answer.data, 'base64').toString('utf8')); } catch { fail(502, 'invalid_runner_response', 'Your computer returned invalid JSON.'); }
  const userId = c.get('auth').userId;
  const workspaceId = await privateWorkspaceOf(c.env, userId);
  if (!workspaceId || !json || typeof json !== 'object' || Array.isArray(json)) return { answer, json };
  const body = json as Record<string, unknown>;
  const map = async (value: unknown): Promise<unknown> => {
    const record = reportedRecord(value);
    if (!record) return value;
    await remember(c.env, row.connector_id, userId, record);
    const extra = value as Record<string, unknown>;
    return { ...shown(record, userId, workspaceId, row.connector_id, row.host_name, true),
      ...(typeof extra.cloneUnavailable === 'string' ? { cloneUnavailable: extra.cloneUnavailable } : {}),
      ...(typeof extra.viewable === 'boolean' ? { viewable: extra.viewable } : {}),
      ...(extra.hostUnsandboxed === true ? { hostUnsandboxed: true } : {}) };
  };
  if (body.session) body.session = await map(body.session);
  return { answer, json: body };
}

const NO_BODY = [101, 204, 205, 304];

function respond(c: AppContext, result: { answer: PrivateForwardResponse; json?: unknown }): Response {
  const status = result.answer.status as 200;
  if (NO_BODY.includes(status)) return new Response(null, { status, headers: { 'Cache-Control': 'private, no-store' } });
  if (result.json !== undefined) return c.json(result.json as Record<string, unknown>, status);
  return new Response(Buffer.from(result.answer.data, 'base64'), { status,
    headers: { 'Content-Type': result.answer.contentType, 'Cache-Control': 'private, no-store, no-transform', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' } });
}

export const forwardedSessionRoutes: MiddlewareHandler<AppEnv> = async (c, next) => {
  const sessionId = c.req.param('id');
  if (!sessionId || !IDENT.test(sessionId)) return next();
  if (await c.env.DB.query('SELECT 1 AS present FROM sessions WHERE id = ?').bind(sessionId).first()) return next();
  const rows = await forwardedRows(c.env, c.get('auth').userId, sessionId);
  const row = rows.find(online) ?? rows[0];
  if (!row) return next();
  const url = new URL(c.req.url);
  const path = url.pathname + url.search;
  const method = c.req.method;
  if (!privateRoute(method, path)) fail(409, 'private_session_here', 'This session is on your computer, which doesn\'t offer that for it from here.');
  if (!online(row)) fail(503, 'computer_offline', `${row.host_name} is offline: start it, or open Pikibun on it, to reach this session.`);
  const body = method === 'GET' ? undefined : await bodyText(c);
  return respond(c, await relay(c, row, { method: method as PrivateForwardRequest['method'], path, ...(body ? { body } : {}) }));
};

export async function createForwardedSession(c: AppContext, input: Record<string, unknown>): Promise<Response | undefined> {
  const userId = c.get('auth').userId;
  const workspaceId = typeof input.workspaceId === 'string' ? input.workspaceId : '';
  const modelId = typeof input.modelId === 'string' ? input.modelId : '';
  if (!workspaceId || !modelId || await privateWorkspaceOf(c.env, userId) !== workspaceId) return undefined;
  const model = await c.env.DB.query<{ provider: string; model_id: string; connector_id: string; capabilities_json: string | null; host_name: string }>(`
    SELECT m.provider, m.model_id, m.connector_id, h.capabilities_json, h.name AS host_name FROM models m
    JOIN connectors h ON h.id = m.connector_id AND h.owner_id = ? AND h.revoked_at IS NULL
    WHERE m.id = ? AND m.workspace_id = ?`).bind(userId, modelId, workspaceId).first();
  if (!model || (parseCapabilities(model.capabilities_json).privateSessions ?? 0) < PRIVATE_SESSIONS_VERSION) return undefined;
  const fields = Object.fromEntries(Object.entries(input).filter(([key]) => CREATE_FIELDS.includes(key)));
  const body = JSON.stringify({ ...fields, provider: model.provider, modelId: model.model_id });
  const result = await relay(c, { connector_id: model.connector_id, host_name: model.host_name }, { method: 'POST', path: '/api/private-sessions', body });
  return respond(c, result);
}
