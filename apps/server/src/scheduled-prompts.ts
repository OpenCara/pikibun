import type { Hono } from 'hono';
import { hostCapabilities } from './authority/index.js';
import {
  accessModes, scheduleRunIns, scheduleToolActions, type AccessMode, type ChatOptions, type ScheduleRunIn, type ScheduleToolAction, type ScheduleToolResult,
  type SessionSchedule, type SubmitResult,
} from '../../../packages/shared/src/types.js';
import { CronError, isTimeZone, nextCronTime, parseCron, scheduleToolTarget } from '../../../packages/shared/src/cron.js';
import { hasPermission } from '../../../packages/shared/src/policy.js';
import { asSessionOwner, errorCode } from './automatic-backups.js';
import { auditStatement, requireCallbackScope, requireSession, requireToolCall, sessionAccess } from './authority/index.js';
import { childThinkingLevel, sessionCurrentModel } from './cross-session.js';
import { requireUnfrozen } from './db.js';
import { fail, id, identifier, jsonObject, now, text, userIdentifier } from './http.js';
import { archiveSession, createSession, submitMessage } from './sessions.js';
import type { AppContext, Env, ModelRow, SessionRow, AppEnv } from './types.js';

export const MAX_SCHEDULES_PER_SESSION = 20;
export const MAX_SCHEDULED_CHILDREN = 20;
const sweepLimit = 20;
const oneShotSweepLimit = 50;

interface ScheduleRow {
  id: string; session_id: string; created_by: string; name: string; cron: string; time_zone: string; content: string;
  access: AccessMode; run_in: ScheduleRunIn; one_shot: number; enabled: number; next_run_at: string | null; last_run_at: string | null; last_submission_id: string | null;
  last_session_id: string | null; last_error: string | null; created_at: string; updated_at: string;
}

export function scheduleRecord(row: ScheduleRow): SessionSchedule {
  return { id: row.id, sessionId: row.session_id, name: row.name, cron: row.cron, timeZone: row.time_zone, content: row.content,
    access: row.access, runIn: row.run_in ?? 'session', oneShot: Number(row.one_shot ?? 1) === 1, enabled: Number(row.enabled) === 1, nextRunAt: row.next_run_at, lastRunAt: row.last_run_at,
    lastSubmissionId: row.last_submission_id, lastSessionId: row.last_session_id ?? null, lastError: row.last_error, createdBy: row.created_by,
    createdAt: row.created_at, updatedAt: row.updated_at };
}

function nextRun(cron: string, timeZone: string, at: number): string | null {
  const next = nextCronTime(cron, timeZone, at);
  return next === null ? null : new Date(next).toISOString();
}

export async function refreshNextScheduled(env: Env, sessionId: string): Promise<void> {
  await env.DB.query(`UPDATE sessions SET next_scheduled_at = (SELECT MIN(next_run_at) FROM session_schedules
      WHERE session_id = ? AND enabled = 1 AND next_run_at IS NOT NULL) WHERE id = ?`).bind(sessionId, sessionId).run();
}

function validCron(value: unknown): string {
  const cron = text(value, 'cron', 120);
  try { parseCron(cron); } catch (error) {
    if (error instanceof CronError) fail(400, 'invalid_cron', error.message);
    throw error;
  }
  return cron.trim().replace(/\s+/g, ' ');
}

function validTimeZone(value: unknown): string {
  if (!isTimeZone(value)) fail(400, 'invalid_time_zone', 'Choose a time zone such as UTC or Europe/Berlin.');
  return value;
}

/** A schedule's access: read, Read only; anything else (auto, or approval from before approvals were removed) acts. */
function validAccess(value: unknown): AccessMode {
  if (!accessModes.includes(value as AccessMode)) fail(400, 'invalid_input', 'Access is read or auto.');
  return value === 'read' ? 'read' : 'auto';
}

function validRunIn(value: unknown): ScheduleRunIn {
  if (!scheduleRunIns.includes(value as ScheduleRunIn)) fail(400, 'invalid_input', 'Run in is session or child.');
  return value as ScheduleRunIn;
}

function validEnabled(value: unknown): boolean {
  if (typeof value !== 'boolean') fail(400, 'invalid_input', 'Enabled is true or false.');
  return value;
}

function validOneShot(value: unknown): boolean {
  if (typeof value !== 'boolean') fail(400, 'invalid_input', 'One-shot is true or false.');
  return value;
}

async function ownSession(c: AppContext): Promise<SessionRow> {
  const { row } = await requireSession(c, identifier(c.req.param('id')), 'write');
  if (row.owner_id !== c.get('auth').userId) fail(403, 'owner_required', 'Only the session owner can schedule prompts.');
  requireUnfrozen(row);
  return row;
}

async function requireAccessSupported(env: Env, row: SessionRow, access: AccessMode): Promise<void> {
  if (access !== 'read') return;
  if (!row.connector_id) fail(400, 'options_unsupported', 'This session\'s runner cannot run read-only prompts; schedule it without Read only.');
  const capabilities = await hostCapabilities(env, row.connector_id, { active: true });
  if (!capabilities) fail(409, 'connector_unavailable', 'The session\'s host is no longer available.');
  if (capabilities.chatOptions !== true) {
    fail(409, 'connector_update_required', 'Update the host\'s connector (npx pikibun@latest connect) to schedule read-only prompts.');
  }
}

async function ownSchedule(c: AppContext, row: SessionRow): Promise<ScheduleRow> {
  return findSchedule(c.env, row, identifier(c.req.param('scheduleId'), 'scheduleId'));
}

async function findSchedule(env: Env, row: SessionRow, scheduleId: string): Promise<ScheduleRow> {
  const schedule = await env.DB.query<ScheduleRow>('SELECT * FROM session_schedules WHERE id = ? AND session_id = ?')
    .bind(scheduleId, row.id).first();
  if (!schedule) fail(404, 'not_found', 'Schedule not found.');
  return { ...schedule, enabled: Number(schedule.enabled), one_shot: Number(schedule.one_shot ?? 1) };
}

type Sent = SubmitResult & { childSessionId?: string };

async function send(env: Env, schedule: ScheduleRow, ownerId: string, at: number, trigger: 'schedule' | 'manual'): Promise<Sent> {
  return asSessionOwner(env, { owner_id: ownerId }, async c => {
    const { row } = await requireSession(c, schedule.session_id, 'write');
    if (schedule.run_in === 'child') return startChild(c, row, schedule, at, trigger);
    return submitMessage(c, row, 'submit', {
      content: schedule.content,
      requestId: `schedule:${schedule.id}:${at}`,
      ...(schedule.access === 'read' ? { options: { access: 'read' } } : {}),
    }, { scheduleId: schedule.id, trigger }, { currentModel: true });
  }, 'scheduled-prompt');
}

function runLabel(at: number, timeZone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23' }).formatToParts(new Date(at)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

async function openScheduledChildren(env: Env, parentId: string): Promise<number> {
  const open = await env.DB.query<{ n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE parent_session_id = ? AND schedule_id IS NOT NULL AND status <> 'archived'")
    .bind(parentId).first('n');
  return Number(open ?? 0);
}

function tooManyChildren(): never {
  fail(409, 'too_many_children', `This session's schedules keep at most ${MAX_SCHEDULED_CHILDREN} sessions open. Archive some of the sessions they started.`);
}

async function startChild(c: AppContext, parent: SessionRow, schedule: ScheduleRow, at: number, trigger: 'schedule' | 'manual'): Promise<Sent> {
  requireUnfrozen(parent);
  const ownerId = c.get('auth').userId;
  if (await openScheduledChildren(c.env, parent.id) >= MAX_SCHEDULED_CHILDREN) tooManyChildren();
  const current = await sessionCurrentModel(c.env, parent, ownerId);
  if (!current.modelId) fail(409, 'invalid_binding', 'This session\'s model is unavailable.');
  const model = await c.env.DB.query<Pick<ModelRow, 'id' | 'provider' | 'model_id' | 'connector_id'>>(
    'SELECT id, provider, model_id, connector_id FROM models WHERE id = ? AND workspace_id = ?').bind(current.modelId, parent.workspace_id).first();
  if (!model) fail(404, 'not_found', 'Model not found.');
  const thinkingLevel = await childThinkingLevel(c.env, model, undefined, current.thinkingLevel);
  const started: { id?: string } = {};
  try {
    const { row: child } = await createSession(c, { workspaceId: parent.workspace_id, title: `${schedule.name} · ${runLabel(at, schedule.time_zone)}`,
      visibility: parent.visibility ?? 'private', modelId: model.id,
      ...(model.connector_id && model.connector_id === parent.connector_id ? { trustedConnectorId: model.connector_id } : {}),
    }, { parentSessionId: parent.id, scheduleId: schedule.id, inserted: sessionId => { started.id = sessionId; } });
    if (await openScheduledChildren(c.env, parent.id) > MAX_SCHEDULED_CHILDREN) tooManyChildren();
    await auditStatement(c.env, ownerId, 'session.schedule.child_started', parent.workspace_id, parent.id,
      { scheduleId: schedule.id, childSessionId: child.id, trigger }).run();
    if (Number(schedule.one_shot ?? 1) === 1) await c.env.DB.query('UPDATE sessions SET one_shot = 1 WHERE id = ?').bind(child.id).run();
    const options: ChatOptions = { ...(schedule.access === 'read' ? { access: 'read' } : {}), ...(thinkingLevel ? { thinkingLevel } : {}) };
    const submission = await submitMessage(c, child, 'submit', {
      content: schedule.content,
      requestId: `schedule:${schedule.id}:${at}`,
      ...(Object.keys(options).length ? { options } : {}),
    }, { scheduleId: schedule.id, trigger, parentSessionId: parent.id }, { currentModel: true });
    return { ...submission, childSessionId: child.id };
  } catch (error) {
    if (started.id) await archiveSession(c, started.id, { scheduleId: schedule.id }).catch(() => undefined);
    throw error;
  }
}

export type OneShotOutcome = { sessionId: string; archived: true } | { sessionId: string; skipped: true } | { sessionId: string; error: string };

export async function archiveFinishedOneShots(env: Env): Promise<OneShotOutcome[]> {
  const finished = await env.DB.query<{ id: string; owner_id: string; schedule_id: string | null }>(
    "SELECT id, owner_id, schedule_id FROM sessions WHERE one_shot = 1 AND activity = 'done' AND status = 'ready' ORDER BY id LIMIT ?").bind(oneShotSweepLimit).all();
  const outcomes: OneShotOutcome[] = [];
  for (const session of finished) {
    const claimed = await env.DB.query("UPDATE sessions SET one_shot = 0 WHERE id = ? AND one_shot = 1 AND activity = 'done' AND status = 'ready'").bind(session.id).run();
    if (claimed.changes !== 1) {
      outcomes.push({ sessionId: session.id, skipped: true });
      continue;
    }
    try {
      await asSessionOwner(env, session, c => archiveSession(c, session.id, { oneShot: true, ...(session.schedule_id ? { scheduleId: session.schedule_id } : {}) }), 'one-shot-session');
      outcomes.push({ sessionId: session.id, archived: true });
    } catch (error) {
      outcomes.push({ sessionId: session.id, error: await errorCode(error) });
    }
  }
  return outcomes;
}

export type ScheduledPromptOutcome = { scheduleId: string; sessionId: string; submissionId: string; childSessionId?: string }
  | { scheduleId: string; sessionId: string; error: string };

type DueSchedule = ScheduleRow & { owner_id: string };

export async function runScheduledPrompts(env: Env, at = Date.now()): Promise<ScheduledPromptOutcome[]> {
  const timestamp = new Date(at).toISOString();
  const due = await env.DB.query<DueSchedule>(`SELECT p.*, s.owner_id
    FROM session_schedules p JOIN sessions s ON s.id = p.session_id
    WHERE p.enabled = 1 AND p.next_run_at IS NOT NULL AND p.next_run_at <= ? AND s.status = 'ready'
    ORDER BY p.next_run_at, p.id LIMIT ?`).bind(timestamp, sweepLimit).all();
  const outcomes: ScheduledPromptOutcome[] = [];
  const sent = new Set<string>();
  for (const schedule of due) {
    const claimed = await env.DB.query(`UPDATE session_schedules SET next_run_at = ?, last_run_at = ?
      WHERE id = ? AND enabled = 1 AND next_run_at = ?`)
      .bind(nextRun(schedule.cron, schedule.time_zone, at), timestamp, schedule.id, schedule.next_run_at).run();
    if (claimed.changes !== 1) continue;
    let outcome: ScheduledPromptOutcome;
    const child = schedule.run_in === 'child';
    const activity = child ? null : sent.has(schedule.session_id) ? 'working'
      : await env.DB.query<{ activity: string | null }>('SELECT activity FROM sessions WHERE id = ?').bind(schedule.session_id).first('activity');
    if (activity === 'working' || activity === 'waiting') {
      outcome = { scheduleId: schedule.id, sessionId: schedule.session_id, error: 'session_busy' };
    } else {
      try {
        const result = await send(env, schedule, schedule.owner_id, at, 'schedule');
        if (!child) sent.add(schedule.session_id);
        outcome = { scheduleId: schedule.id, sessionId: schedule.session_id, submissionId: result.submissionId,
          ...(result.childSessionId ? { childSessionId: result.childSessionId } : {}) };
      } catch (error) {
        outcome = { scheduleId: schedule.id, sessionId: schedule.session_id, error: await errorCode(error) };
      }
    }
    await env.DB.query('UPDATE session_schedules SET last_submission_id = ?, last_session_id = ?, last_error = ? WHERE id = ?')
      .bind('submissionId' in outcome ? outcome.submissionId : null, 'childSessionId' in outcome ? outcome.childSessionId ?? null : null,
        'error' in outcome ? outcome.error : null, schedule.id).run();
    await refreshNextScheduled(env, schedule.session_id);
    outcomes.push(outcome);
  }
  return outcomes;
}

const scheduleFields = ['name', 'cron', 'timeZone', 'content', 'access', 'runIn', 'oneShot', 'enabled'] as const;
type ScheduleInput = Partial<Record<(typeof scheduleFields)[number], unknown>>;

function scheduleInput(input: Record<string, unknown>): ScheduleInput {
  if (Object.keys(input).some(key => !(scheduleFields as readonly string[]).includes(key))) fail(400, 'invalid_input', 'Unknown schedule field.');
  return input;
}

type ScheduleChange = { actorId: string; callId?: string };
const changedBy = (change: ScheduleChange) => change.callId === undefined ? {} : { agent: true, callId: change.callId };

async function createSchedule(env: Env, row: SessionRow, change: ScheduleChange, input: ScheduleInput): Promise<ScheduleRow> {
  const cron = validCron(input.cron);
  const timeZone = input.timeZone === undefined ? 'UTC' : validTimeZone(input.timeZone);
  const content = text(input.content, 'content', 60000);
  const name = input.name === undefined || input.name === '' ? content.trim().split('\n')[0]!.slice(0, 80) || 'Scheduled prompt' : text(input.name, 'name', 100);
  const access = input.access === undefined ? 'auto' : validAccess(input.access);
  const runIn = input.runIn === undefined ? 'session' : validRunIn(input.runIn);
  const oneShot = input.oneShot === undefined ? true : validOneShot(input.oneShot);
  const enabled = input.enabled === undefined ? true : validEnabled(input.enabled);
  await requireAccessSupported(env, row, access);
  const at = Date.now();
  const nextRunAt = enabled ? nextRun(cron, timeZone, at) : null;
  if (enabled && nextRunAt === null) fail(400, 'invalid_cron', 'This schedule never comes round.');
  const count = await env.DB.query<{ n: number }>('SELECT COUNT(*) AS n FROM session_schedules WHERE session_id = ?').bind(row.id).first('n');
  if (Number(count) >= MAX_SCHEDULES_PER_SESSION) fail(409, 'too_many_schedules', `A session keeps at most ${MAX_SCHEDULES_PER_SESSION} schedules.`);
  const timestamp = now();
  const schedule: ScheduleRow = { id: id(), session_id: row.id, created_by: change.actorId, name, cron, time_zone: timeZone, content, access, run_in: runIn, one_shot: oneShot ? 1 : 0,
    enabled: enabled ? 1 : 0, next_run_at: nextRunAt, last_run_at: null, last_submission_id: null, last_session_id: null, last_error: null, created_at: timestamp,
    updated_at: timestamp };
  await env.DB.batch([
    env.DB.query(`INSERT INTO session_schedules (id, session_id, created_by, name, cron, time_zone, content, access, run_in, one_shot, enabled, next_run_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(schedule.id, row.id, schedule.created_by, name, cron, timeZone, content, access, runIn, schedule.one_shot, schedule.enabled,
      nextRunAt, timestamp, timestamp),
    auditStatement(env, change.actorId, 'session.schedule.created', row.workspace_id, row.id, { scheduleId: schedule.id, cron, timeZone, access, runIn, oneShot, enabled,
      ...changedBy(change) }),
  ]);
  await refreshNextScheduled(env, row.id);
  return schedule;
}

async function updateSchedule(env: Env, row: SessionRow, change: ScheduleChange, current: ScheduleRow, input: ScheduleInput): Promise<ScheduleRow> {
  const next: ScheduleRow = { ...current,
    ...(input.name !== undefined ? { name: text(input.name, 'name', 100) } : {}),
    ...(input.cron !== undefined ? { cron: validCron(input.cron) } : {}),
    ...(input.timeZone !== undefined ? { time_zone: validTimeZone(input.timeZone) } : {}),
    ...(input.content !== undefined ? { content: text(input.content, 'content', 60000) } : {}),
    ...(input.access !== undefined ? { access: validAccess(input.access) } : {}),
    ...(input.runIn !== undefined ? { run_in: validRunIn(input.runIn) } : {}),
    ...(input.oneShot !== undefined ? { one_shot: validOneShot(input.oneShot) ? 1 : 0 } : {}),
    ...(input.enabled !== undefined ? { enabled: validEnabled(input.enabled) ? 1 : 0 } : {}),
    updated_at: now() };
  if (next.access !== current.access) await requireAccessSupported(env, row, next.access);
  const timing = next.cron !== current.cron || next.time_zone !== current.time_zone || next.enabled !== current.enabled;
  if (timing) next.next_run_at = next.enabled ? nextRun(next.cron, next.time_zone, Date.now()) : null;
  if (next.enabled && next.next_run_at === null) fail(400, 'invalid_cron', 'This schedule never comes round.');
  const update = timing
    ? env.DB.query(`UPDATE session_schedules SET name = ?, cron = ?, time_zone = ?, content = ?, access = ?, run_in = ?, one_shot = ?, enabled = ?, next_run_at = ?, updated_at = ?
        WHERE id = ? AND ${current.next_run_at === null ? 'next_run_at IS NULL' : 'next_run_at = ?'}`)
      .bind(next.name, next.cron, next.time_zone, next.content, next.access, next.run_in, next.one_shot, next.enabled, next.next_run_at, next.updated_at, next.id,
        ...(current.next_run_at === null ? [] : [current.next_run_at]))
    : env.DB.query('UPDATE session_schedules SET name = ?, content = ?, access = ?, run_in = ?, one_shot = ?, updated_at = ? WHERE id = ?')
      .bind(next.name, next.content, next.access, next.run_in, next.one_shot, next.updated_at, next.id);
  const [updated] = await env.DB.batch([
    update,
    auditStatement(env, change.actorId, 'session.schedule.updated', row.workspace_id, row.id,
      { scheduleId: next.id, cron: next.cron, timeZone: next.time_zone, access: next.access, runIn: next.run_in, oneShot: next.one_shot === 1, enabled: next.enabled === 1, ...changedBy(change) }),
  ]);
  if (updated!.changes !== 1) fail(409, 'schedule_changed', 'This schedule ran or changed meanwhile. Reload it and try again.');
  await refreshNextScheduled(env, row.id);
  return await env.DB.query<ScheduleRow>('SELECT * FROM session_schedules WHERE id = ?').bind(next.id).first() ?? next;
}

async function deleteSchedule(env: Env, row: SessionRow, change: ScheduleChange, schedule: ScheduleRow): Promise<void> {
  await env.DB.batch([
    env.DB.query('DELETE FROM session_schedules WHERE id = ?').bind(schedule.id),
    auditStatement(env, change.actorId, 'session.schedule.deleted', row.workspace_id, row.id, { scheduleId: schedule.id, ...changedBy(change) }),
  ]);
  await refreshNextScheduled(env, row.id);
}

type AdmissionRow = { id: string; session_id: string; actor_id: string; mode: string; access: string | null; expires_at: number };

export async function agentSchedules(c: AppContext, connectorId: string | null): Promise<Response> {
  const input = await jsonObject(c, 512 * 1024);
  if (Object.keys(input).some(key => !['sessionId', 'actorId', 'admissionId', 'callId', 'action', 'scheduleId', ...scheduleFields].includes(key))) {
    fail(400, 'invalid_input', 'Unexpected schedule field.');
  }
  const sessionId = identifier(input.sessionId, 'sessionId');
  const actorId = userIdentifier(input.actorId, 'actorId');
  const admissionId = text(input.admissionId, 'admissionId', 128);
  const callId = identifier(input.callId, 'callId');
  if (!scheduleToolActions.includes(input.action as ScheduleToolAction)) fail(400, 'invalid_input', 'Action is list, create, update or delete.');
  const action = input.action as ScheduleToolAction;
  const scheduleId = input.scheduleId === undefined ? undefined : identifier(input.scheduleId, 'scheduleId');
  if ((action === 'update' || action === 'delete') !== (scheduleId !== undefined)) {
    fail(400, 'invalid_input', scheduleId === undefined ? `Name the schedule to ${action} by its id.` : `A ${action} names no schedule.`);
  }
  const fields: ScheduleInput = Object.fromEntries(scheduleFields.filter(key => input[key] !== undefined).map(key => [key, input[key]]));
  if ((action === 'list' || action === 'delete') && Object.keys(fields).length) fail(400, 'invalid_input', `A ${action} takes no schedule fields.`);
  if (action === 'update' && !Object.keys(fields).length) fail(400, 'invalid_input', 'An update changes at least one field.');
  for (const key of ['name', 'cron', 'timeZone', 'content', 'access', 'runIn'] as const) {
    if (fields[key] !== undefined && typeof fields[key] !== 'string') fail(400, 'invalid_input', `${key} is text.`);
  }
  if (fields.runIn !== undefined) validRunIn(fields.runIn);
  if (fields.oneShot !== undefined) validOneShot(fields.oneShot);
  if (fields.enabled !== undefined) validEnabled(fields.enabled);
  const target = scheduleToolTarget({ action, scheduleId, ...fields as { name?: string; cron?: string; timeZone?: string; content?: string; access?: AccessMode;
    runIn?: ScheduleRunIn; oneShot?: boolean; enabled?: boolean } });
  const access = await sessionAccess(c.env, sessionId, actorId);
  if (!access || access.row.status === 'archived' || !hasPermission(access.permissions, 'write')) {
    fail(403, 'permission_revoked', 'The requester can no longer write to this session.');
  }
  const row = access.row;
  if (row.owner_id !== actorId) fail(403, 'owner_required', 'Only the session owner\'s messages schedule prompts.');
  await requireCallbackScope(c, row, connectorId);
  const admission = await c.env.DB.query<AdmissionRow>('SELECT id, session_id, actor_id, mode, access, expires_at FROM run_admissions WHERE id = ?')
    .bind(admissionId).first();
  if (!admission || admission.session_id !== sessionId || admission.actor_id !== actorId || admission.mode !== 'write'
    || admission.expires_at <= Math.floor(Date.now() / 1000)) {
    fail(403, 'schedule_not_admitted', 'Scheduling needs a write message from the session owner sent within the last hour.');
  }
  await requireToolCall(c.env, row, 'schedule');
  if (action === 'list') {
    const rows = await c.env.DB.query<ScheduleRow>('SELECT * FROM session_schedules WHERE session_id = ? ORDER BY created_at, id').bind(row.id).all();
    return c.json({ schedules: rows.map(scheduleRecord) } satisfies ScheduleToolResult);
  }
  requireUnfrozen(row);
  if (admission.access === 'read') {
    fail(403, 'read_only_message', 'A Read-only message changes nothing, schedules included: ask in a message that may act.');
  }
  const change: ScheduleChange = { actorId, callId };
  if (action === 'create') {
    return c.json({ schedule: scheduleRecord(await createSchedule(c.env, row, change, fields)) } satisfies ScheduleToolResult, 201);
  }
  const current = await findSchedule(c.env, row, scheduleId!);
  if (action === 'delete') {
    await deleteSchedule(c.env, row, change, current);
    return c.json({ deleted: current.id } satisfies ScheduleToolResult);
  }
  return c.json({ schedule: scheduleRecord(await updateSchedule(c.env, row, change, current, fields)) } satisfies ScheduleToolResult);
}

export function registerScheduledPrompts(app: Hono<AppEnv>) {
  app.get('/api/sessions/:id/schedules', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'read');
    const rows = await c.env.DB.query<ScheduleRow>('SELECT * FROM session_schedules WHERE session_id = ? ORDER BY created_at, id').bind(row.id).all();
    return c.json({ schedules: rows.map(scheduleRecord), canManage: row.owner_id === c.get('auth').userId && row.status !== 'archived' });
  });

  app.post('/api/sessions/:id/schedules', async c => {
    const row = await ownSession(c);
    const schedule = await createSchedule(c.env, row, { actorId: c.get('auth').userId }, scheduleInput(await jsonObject(c)));
    return c.json({ schedule: scheduleRecord(schedule) }, 201);
  });

  app.patch('/api/sessions/:id/schedules/:scheduleId', async c => {
    const row = await ownSession(c);
    const current = await ownSchedule(c, row);
    const saved = await updateSchedule(c.env, row, { actorId: c.get('auth').userId }, current, scheduleInput(await jsonObject(c)));
    return c.json({ schedule: scheduleRecord(saved) });
  });

  app.delete('/api/sessions/:id/schedules/:scheduleId', async c => {
    const row = await ownSession(c);
    await deleteSchedule(c.env, row, { actorId: c.get('auth').userId }, await ownSchedule(c, row));
    return c.body(null, 204);
  });

  app.post('/api/sessions/:id/schedules/:scheduleId/run', async c => {
    const row = await ownSession(c);
    const schedule = await ownSchedule(c, row);
    const at = Date.now();
    const timestamp = new Date(at).toISOString();
    try {
      const { childSessionId, ...submission } = await send(c.env, schedule, row.owner_id, at, 'manual');
      await c.env.DB.query('UPDATE session_schedules SET last_run_at = ?, last_submission_id = ?, last_session_id = ?, last_error = NULL WHERE id = ?')
        .bind(timestamp, submission.submissionId, childSessionId ?? null, schedule.id).run();
      return c.json({ schedule: scheduleRecord({ ...schedule, last_run_at: timestamp, last_submission_id: submission.submissionId, last_session_id: childSessionId ?? null,
        last_error: null }), submission, ...(childSessionId ? { sessionId: childSessionId } : {}) }, 202);
    } catch (error) {
      await c.env.DB.query('UPDATE session_schedules SET last_run_at = ?, last_submission_id = NULL, last_session_id = NULL, last_error = ? WHERE id = ?')
        .bind(timestamp, await errorCode(error), schedule.id).run();
      throw error;
    }
  });
}
