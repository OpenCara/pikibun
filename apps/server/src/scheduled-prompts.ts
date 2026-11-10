import type { Hono } from 'hono';
import { hostCapabilities } from './authority/index.js';
import { accessModes, scheduleToolActions, type AccessMode, type ScheduleToolAction, type ScheduleToolResult, type SessionSchedule, type SubmitResult } from '../../../packages/shared/src/types.js';
import { CronError, isTimeZone, nextCronTime, parseCron, scheduleToolTarget } from '../../../packages/shared/src/cron.js';
import { hasPermission } from '../../../packages/shared/src/policy.js';
import { asSessionOwner, errorCode } from './automatic-backups.js';
import { auditStatement, requireCallbackScope, requireSession, requireToolCall, sessionAccess } from './authority/index.js';
import { requireUnfrozen } from './db.js';
import { fail, id, identifier, jsonObject, now, text, userIdentifier } from './http.js';
import { submitMessage } from './sessions.js';
import type { AppContext, Env, SessionRow, AppEnv } from './types.js';

export const MAX_SCHEDULES_PER_SESSION = 20;
const sweepLimit = 20;

interface ScheduleRow {
  id: string; session_id: string; created_by: string; name: string; cron: string; time_zone: string; content: string;
  access: AccessMode; enabled: number; next_run_at: string | null; last_run_at: string | null; last_submission_id: string | null;
  last_error: string | null; created_at: string; updated_at: string;
}

export function scheduleRecord(row: ScheduleRow): SessionSchedule {
  return { id: row.id, sessionId: row.session_id, name: row.name, cron: row.cron, timeZone: row.time_zone, content: row.content,
    access: row.access, enabled: Number(row.enabled) === 1, nextRunAt: row.next_run_at, lastRunAt: row.last_run_at,
    lastSubmissionId: row.last_submission_id, lastError: row.last_error, createdBy: row.created_by, createdAt: row.created_at,
    updatedAt: row.updated_at };
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

function validAccess(value: unknown): AccessMode {
  if (!accessModes.includes(value as AccessMode)) fail(400, 'invalid_input', 'Access is read, approval or auto.');
  return value as AccessMode;
}

function validEnabled(value: unknown): boolean {
  if (typeof value !== 'boolean') fail(400, 'invalid_input', 'Enabled is true or false.');
  return value;
}

async function ownSession(c: AppContext): Promise<SessionRow> {
  const { row } = await requireSession(c, identifier(c.req.param('id')), 'write');
  if (row.owner_id !== c.get('auth').userId) fail(403, 'owner_required', 'Only the session owner can schedule prompts.');
  requireUnfrozen(row);
  return row;
}

async function requireAccessSupported(env: Env, row: SessionRow, access: AccessMode): Promise<void> {
  if (access === 'approval') return;
  if (!row.connector_id) fail(400, 'options_unsupported', 'This session\'s runner cannot change access; schedule it with approval.');
  const capabilities = await hostCapabilities(env, row.connector_id, { active: true });
  if (!capabilities) fail(409, 'connector_unavailable', 'The session\'s host is no longer available.');
  if (capabilities.chatOptions !== true) {
    fail(409, 'connector_update_required', 'Update the host\'s connector (npx pikibun@latest connect) to schedule read-only or auto-approved prompts.');
  }
}

async function ownSchedule(c: AppContext, row: SessionRow): Promise<ScheduleRow> {
  return findSchedule(c.env, row, identifier(c.req.param('scheduleId'), 'scheduleId'));
}

async function findSchedule(env: Env, row: SessionRow, scheduleId: string): Promise<ScheduleRow> {
  const schedule = await env.DB.query<ScheduleRow>('SELECT * FROM session_schedules WHERE id = ? AND session_id = ?')
    .bind(scheduleId, row.id).first();
  if (!schedule) fail(404, 'not_found', 'Schedule not found.');
  return { ...schedule, enabled: Number(schedule.enabled) };
}

async function send(env: Env, schedule: ScheduleRow, ownerId: string, at: number, trigger: 'schedule' | 'manual'): Promise<SubmitResult> {
  return asSessionOwner(env, { owner_id: ownerId }, async c => {
    const { row } = await requireSession(c, schedule.session_id, 'write');
    return submitMessage(c, row, 'submit', {
      content: schedule.content,
      requestId: `schedule:${schedule.id}:${at}`,
      ...(schedule.access === 'approval' ? {} : { options: { access: schedule.access } }),
    }, { scheduleId: schedule.id, trigger }, { currentModel: true });
  }, 'scheduled-prompt');
}

export type ScheduledPromptOutcome = { scheduleId: string; sessionId: string; submissionId: string } | { scheduleId: string; sessionId: string; error: string };

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
    const activity = sent.has(schedule.session_id) ? 'working'
      : await env.DB.query<{ activity: string | null }>('SELECT activity FROM sessions WHERE id = ?').bind(schedule.session_id).first('activity');
    if (activity === 'working' || activity === 'waiting') {
      outcome = { scheduleId: schedule.id, sessionId: schedule.session_id, error: 'session_busy' };
    } else {
      try {
        const result = await send(env, schedule, schedule.owner_id, at, 'schedule');
        sent.add(schedule.session_id);
        outcome = { scheduleId: schedule.id, sessionId: schedule.session_id, submissionId: result.submissionId };
      } catch (error) {
        outcome = { scheduleId: schedule.id, sessionId: schedule.session_id, error: await errorCode(error) };
      }
    }
    await env.DB.query('UPDATE session_schedules SET last_submission_id = ?, last_error = ? WHERE id = ?')
      .bind('submissionId' in outcome ? outcome.submissionId : null, 'error' in outcome ? outcome.error : null, schedule.id).run();
    await refreshNextScheduled(env, schedule.session_id);
    outcomes.push(outcome);
  }
  return outcomes;
}

const scheduleFields = ['name', 'cron', 'timeZone', 'content', 'access', 'enabled'] as const;
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
  const access = input.access === undefined ? 'approval' : validAccess(input.access);
  const enabled = input.enabled === undefined ? true : validEnabled(input.enabled);
  await requireAccessSupported(env, row, access);
  const at = Date.now();
  const nextRunAt = enabled ? nextRun(cron, timeZone, at) : null;
  if (enabled && nextRunAt === null) fail(400, 'invalid_cron', 'This schedule never comes round.');
  const count = await env.DB.query<{ n: number }>('SELECT COUNT(*) AS n FROM session_schedules WHERE session_id = ?').bind(row.id).first('n');
  if (Number(count) >= MAX_SCHEDULES_PER_SESSION) fail(409, 'too_many_schedules', `A session keeps at most ${MAX_SCHEDULES_PER_SESSION} schedules.`);
  const timestamp = now();
  const schedule: ScheduleRow = { id: id(), session_id: row.id, created_by: change.actorId, name, cron, time_zone: timeZone, content, access,
    enabled: enabled ? 1 : 0, next_run_at: nextRunAt, last_run_at: null, last_submission_id: null, last_error: null, created_at: timestamp, updated_at: timestamp };
  await env.DB.batch([
    env.DB.query(`INSERT INTO session_schedules (id, session_id, created_by, name, cron, time_zone, content, access, enabled, next_run_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(schedule.id, row.id, schedule.created_by, name, cron, timeZone, content, access, schedule.enabled,
      nextRunAt, timestamp, timestamp),
    auditStatement(env, change.actorId, 'session.schedule.created', row.workspace_id, row.id, { scheduleId: schedule.id, cron, timeZone, access, enabled, ...changedBy(change) }),
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
    ...(input.enabled !== undefined ? { enabled: validEnabled(input.enabled) ? 1 : 0 } : {}),
    updated_at: now() };
  if (next.access !== current.access) await requireAccessSupported(env, row, next.access);
  const timing = next.cron !== current.cron || next.time_zone !== current.time_zone || next.enabled !== current.enabled;
  if (timing) next.next_run_at = next.enabled ? nextRun(next.cron, next.time_zone, Date.now()) : null;
  if (next.enabled && next.next_run_at === null) fail(400, 'invalid_cron', 'This schedule never comes round.');
  const update = timing
    ? env.DB.query(`UPDATE session_schedules SET name = ?, cron = ?, time_zone = ?, content = ?, access = ?, enabled = ?, next_run_at = ?, updated_at = ?
        WHERE id = ? AND ${current.next_run_at === null ? 'next_run_at IS NULL' : 'next_run_at = ?'}`)
      .bind(next.name, next.cron, next.time_zone, next.content, next.access, next.enabled, next.next_run_at, next.updated_at, next.id,
        ...(current.next_run_at === null ? [] : [current.next_run_at]))
    : env.DB.query('UPDATE session_schedules SET name = ?, content = ?, access = ?, updated_at = ? WHERE id = ?')
      .bind(next.name, next.content, next.access, next.updated_at, next.id);
  const [updated] = await env.DB.batch([
    update,
    auditStatement(env, change.actorId, 'session.schedule.updated', row.workspace_id, row.id,
      { scheduleId: next.id, cron: next.cron, timeZone: next.time_zone, access: next.access, enabled: next.enabled === 1, ...changedBy(change) }),
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
  for (const key of ['name', 'cron', 'timeZone', 'content', 'access'] as const) {
    if (fields[key] !== undefined && typeof fields[key] !== 'string') fail(400, 'invalid_input', `${key} is text.`);
  }
  if (fields.enabled !== undefined) validEnabled(fields.enabled);
  const target = scheduleToolTarget({ action, scheduleId, ...fields as { name?: string; cron?: string; timeZone?: string; content?: string; access?: AccessMode; enabled?: boolean } });
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
  await requireToolCall(c.env, row, 'schedule', { id: callId, requestedBy: actorId, admission, target });
  if (action === 'list') {
    const rows = await c.env.DB.query<ScheduleRow>('SELECT * FROM session_schedules WHERE session_id = ? ORDER BY created_at, id').bind(row.id).all();
    return c.json({ schedules: rows.map(scheduleRecord) } satisfies ScheduleToolResult);
  }
  requireUnfrozen(row);
  const change: ScheduleChange = { actorId, callId };
  const requireAutomatic = () => {
    if (admission.access !== 'auto') {
      fail(403, 'automatic_schedule_not_admitted', 'Only a message the session owner sent with Auto-approve schedules an auto-approved prompt, or changes one and leaves it auto-approved. Pause it, lower its access, or have the owner change it in the Schedules tab.');
    }
  };
  if (action === 'create') {
    if (fields.access === 'auto') requireAutomatic();
    return c.json({ schedule: scheduleRecord(await createSchedule(c.env, row, change, fields)) } satisfies ScheduleToolResult, 201);
  }
  const current = await findSchedule(c.env, row, scheduleId!);
  if (action === 'delete') {
    await deleteSchedule(c.env, row, change, current);
    return c.json({ deleted: current.id } satisfies ScheduleToolResult);
  }
  const pausing = Object.keys(fields).length === 1 && fields.enabled === false;
  if ((fields.access ?? current.access) === 'auto' && !pausing) requireAutomatic();
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
      const submission = await send(c.env, schedule, row.owner_id, at, 'manual');
      await c.env.DB.query('UPDATE session_schedules SET last_run_at = ?, last_submission_id = ?, last_error = NULL WHERE id = ?')
        .bind(timestamp, submission.submissionId, schedule.id).run();
      return c.json({ schedule: scheduleRecord({ ...schedule, last_run_at: timestamp, last_submission_id: submission.submissionId, last_error: null }), submission }, 202);
    } catch (error) {
      await c.env.DB.query('UPDATE session_schedules SET last_run_at = ?, last_submission_id = NULL, last_error = ? WHERE id = ?')
        .bind(timestamp, await errorCode(error), schedule.id).run();
      throw error;
    }
  });
}
