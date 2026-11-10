import type { Hono } from 'hono';
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
import type { AppContext, Env, ModelRow, SessionRow, WorkerEnv } from './types.js';

/**
 * Scheduled prompts: messages the server sends a session's agent on a cron schedule, so that a session can wake up and
 * do recurring work (a nightly check, a weekly report) without anyone at the keyboard.
 *
 * - Only the session's owner creates, changes or removes them, and they run as the owner: each run is the owner's
 *   message, with every check the chat box's message has (session access, suspension, the host and its models).
 *   Anyone who can view the session sees its schedules, as they see its messages.
 * - A sweep (main.ts) runs every minute and sends each schedule that is due. A run due while the agent is working or
 *   waits for an approval is skipped (`session_busy`), not queued, so a slow run never piles up behind it. Runs missed
 *   while the server was down, the session archived or not ready, are not caught up: the next sweep sends one and moves on.
 * - Each enabled schedule's next run is kept on the session (`next_scheduled_at`), which lists show as "Scheduled".
 * - The owner's agent manages them too, with the schedule tool (`agentSchedules`), for a tool call of a write message
 *   the owner sent: what it creates runs as the owner, as theirs from the Schedules tab do. Only a message the owner
 *   sent with Auto-approve creates an auto-approved one or changes one and leaves it so, so a message can't leave
 *   behind more access than it had; any of their write messages may pause one, lower its access or delete it.
 * - A schedule that runs in a new child session (`run_in` 'child') doesn't prompt the session itself: each run starts a
 *   session under it (`parent_session_id`, and `schedule_id` naming the schedule), as the owner, on the session's
 *   current model and host, never shown to more people than it, and sends the message there as its opening message. So
 *   it runs whatever the session is doing. A session keeps at most `MAX_SCHEDULED_CHILDREN` of these that aren't
 *   archived; they don't count against the sessions its agent may start (cross-session.ts).
 */

/** The most schedules a session keeps. */
export const MAX_SCHEDULES_PER_SESSION = 20;
/** The most sessions a session's schedules started that it keeps unarchived: another run starts none until one is archived. */
export const MAX_SCHEDULED_CHILDREN = 20;
/** The most runs one sweep sends; the rest wait for the next one, the longest overdue first. */
const sweepLimit = 20;

interface ScheduleRow {
  id: string; session_id: string; created_by: string; name: string; cron: string; time_zone: string; content: string;
  access: AccessMode; run_in: ScheduleRunIn; enabled: number; next_run_at: string | null; last_run_at: string | null; last_submission_id: string | null;
  last_session_id: string | null; last_error: string | null; created_at: string; updated_at: string;
}

export function scheduleRecord(row: ScheduleRow): SessionSchedule {
  return { id: row.id, sessionId: row.session_id, name: row.name, cron: row.cron, timeZone: row.time_zone, content: row.content,
    access: row.access, runIn: row.run_in ?? 'session', enabled: Number(row.enabled) === 1, nextRunAt: row.next_run_at, lastRunAt: row.last_run_at,
    lastSubmissionId: row.last_submission_id, lastSessionId: row.last_session_id ?? null, lastError: row.last_error, createdBy: row.created_by,
    createdAt: row.created_at, updatedAt: row.updated_at };
}

/** When a schedule runs next after `at`, as stored: null when it never comes round. */
function nextRun(cron: string, timeZone: string, at: number): string | null {
  const next = nextCronTime(cron, timeZone, at);
  return next === null ? null : new Date(next).toISOString();
}

/** Keeps the session's `next_scheduled_at` in step with its enabled schedules. */
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

function validRunIn(value: unknown): ScheduleRunIn {
  if (!scheduleRunIns.includes(value as ScheduleRunIn)) fail(400, 'invalid_input', 'Run in is session or child.');
  return value as ScheduleRunIn;
}

function validEnabled(value: unknown): boolean {
  if (typeof value !== 'boolean') fail(400, 'invalid_input', 'Enabled is true or false.');
  return value;
}

/** The session, for its owner to change its schedules: refused for anyone else, and for sessions that run nothing. */
async function ownSession(c: AppContext): Promise<SessionRow> {
  const { row } = await requireSession(c, identifier(c.req.param('id')), 'write');
  if (row.owner_id !== c.get('auth').userId) fail(403, 'owner_required', 'Only the session owner can schedule prompts.');
  requireUnfrozen(row);
  return row;
}

/**
 * Read-only and auto-approve are message options, which only a host that takes them runs (see chatOptions in
 * sessions.ts): said when the schedule is saved, not at its first run. Approval is every message's default.
 */
async function requireAccessSupported(env: Env, row: SessionRow, access: AccessMode): Promise<void> {
  if (access === 'approval') return;
  if (!row.connector_id) fail(400, 'options_unsupported', 'This session\'s runner cannot change access; schedule it with approval.');
  const host = await env.DB.query<{ capabilities_json: string }>('SELECT capabilities_json FROM connectors WHERE id = ? AND revoked_at IS NULL')
    .bind(row.connector_id).first();
  if (!host) fail(409, 'connector_unavailable', 'The session\'s host is no longer available.');
  if ((JSON.parse(host.capabilities_json) as { chatOptions?: unknown }).chatOptions !== true) {
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
  // Postgres returns BIGINT columns as strings.
  return { ...schedule, enabled: Number(schedule.enabled) };
}

/** What a run sent: its message, and the session it started for it when it runs in a new child session. */
type Sent = SubmitResult & { childSessionId?: string };

/** Sends the schedule's message now, as the session's owner, to the session or to a new child session of it; throws what refused it. */
async function send(env: Env, schedule: ScheduleRow, ownerId: string, at: number, trigger: 'schedule' | 'manual'): Promise<Sent> {
  return asSessionOwner(env, { owner_id: ownerId }, async c => {
    // Every check of a message the owner sends, as of now: they may have lost access, or the session moved on.
    const { row } = await requireSession(c, schedule.session_id, 'write');
    if (schedule.run_in === 'child') return startChild(c, row, schedule, at, trigger);
    return submitMessage(c, row, 'submit', {
      content: schedule.content,
      requestId: `schedule:${schedule.id}:${at}`,
      // Approval is every message's default, so older hosts that take no options run these too.
      ...(schedule.access === 'approval' ? {} : { options: { access: schedule.access } }),
    }, { scheduleId: schedule.id, trigger }, { currentModel: true });
  }, 'scheduled-prompt');
}

/** The run's time in the schedule's time zone, as a new child session's title shows it: 2026-03-02 09:00. */
function runLabel(at: number, timeZone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23' }).formatToParts(new Date(at)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/**
 * Starts a new session under `parent` for one run of `schedule`, as the request's user (its owner), and sends it the
 * schedule's message as its opening message: on the parent's current model, at its reasoning level where that model
 * runs at it, on the parent's host, never shown to more people than the parent. A session that fails to start, or
 * takes no message, is archived again, so failed runs leave nothing behind.
 */
async function startChild(c: AppContext, parent: SessionRow, schedule: ScheduleRow, at: number, trigger: 'schedule' | 'manual'): Promise<Sent> {
  // A session that runs nothing starts nothing either.
  requireUnfrozen(parent);
  const ownerId = c.get('auth').userId;
  const open = await c.env.DB.query<{ n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE parent_session_id = ? AND schedule_id IS NOT NULL AND status <> 'archived'")
    .bind(parent.id).first('n');
  if (Number(open ?? 0) >= MAX_SCHEDULED_CHILDREN) {
    fail(409, 'too_many_children', `This session's schedules keep at most ${MAX_SCHEDULED_CHILDREN} sessions open. Archive some of the sessions they started.`);
  }
  const current = await sessionCurrentModel(c.env, parent, ownerId);
  if (!current.modelId) fail(409, 'invalid_binding', 'This session\'s model is unavailable.');
  const model = await c.env.DB.query<Pick<ModelRow, 'id' | 'provider' | 'model_id' | 'connector_id'>>(
    'SELECT id, provider, model_id, connector_id FROM models WHERE id = ? AND workspace_id = ?').bind(current.modelId, parent.workspace_id).first();
  if (!model) fail(404, 'not_found', 'Model not found.');
  const thinkingLevel = await childThinkingLevel(c.env, model, undefined, current.thinkingLevel);
  let child: SessionRow;
  try {
    child = (await createSession(c, { workspaceId: parent.workspace_id, title: `${schedule.name} · ${runLabel(at, schedule.time_zone)}`,
      visibility: parent.visibility ?? 'private', modelId: model.id,
      // The owner started the session on this host, and trusts it with the sessions its schedules start there too.
      ...(model.connector_id && model.connector_id === parent.connector_id ? { trustedConnectorId: model.connector_id } : {}),
    }, { parentSessionId: parent.id, scheduleId: schedule.id })).row;
  } catch (error) {
    // Its host refused to start it: the session left behind, in error, runs nothing.
    const failed = await c.env.DB.query<{ id: string }>("SELECT id FROM sessions WHERE parent_session_id = ? AND schedule_id = ? AND status = 'error'")
      .bind(parent.id, schedule.id).all();
    for (const row of failed) await archiveSession(c, row.id, { scheduleId: schedule.id }).catch(() => undefined);
    throw error;
  }
  let submission: SubmitResult;
  try {
    const options: ChatOptions = { ...(schedule.access === 'approval' ? {} : { access: schedule.access }), ...(thinkingLevel ? { thinkingLevel } : {}) };
    submission = await submitMessage(c, child, 'submit', {
      content: schedule.content,
      requestId: `schedule:${schedule.id}:${at}`,
      ...(Object.keys(options).length ? { options } : {}),
    }, { scheduleId: schedule.id, trigger, parentSessionId: parent.id }, { currentModel: true });
  } catch (error) {
    await archiveSession(c, child.id, { scheduleId: schedule.id }).catch(() => undefined);
    throw error;
  }
  await auditStatement(c.env, ownerId, 'session.schedule.child_started', parent.workspace_id, parent.id,
    { scheduleId: schedule.id, childSessionId: child.id, trigger }).run();
  return { ...submission, childSessionId: child.id };
}

/** What one due schedule did, for tests and logs. */
export type ScheduledPromptOutcome = { scheduleId: string; sessionId: string; submissionId: string; childSessionId?: string }
  | { scheduleId: string; sessionId: string; error: string };

type DueSchedule = ScheduleRow & { owner_id: string };

/** Sends the scheduled prompts that are due now; see the top of this file. Safe to call at any time. */
export async function runScheduledPrompts(env: Env, at = Date.now()): Promise<ScheduledPromptOutcome[]> {
  const timestamp = new Date(at).toISOString();
  const due = await env.DB.query<DueSchedule>(`SELECT p.*, s.owner_id
    FROM session_schedules p JOIN sessions s ON s.id = p.session_id
    WHERE p.enabled = 1 AND p.next_run_at IS NOT NULL AND p.next_run_at <= ? AND s.status = 'ready'
    ORDER BY p.next_run_at, p.id LIMIT ?`).bind(timestamp, sweepLimit).all();
  const outcomes: ScheduledPromptOutcome[] = [];
  // Sessions this sweep sent a message: busy from then on, though the list above read them before it did.
  const sent = new Set<string>();
  for (const schedule of due) {
    // Claim the run before sending it, moving the schedule on, so that a sweep running beside this one doesn't send it too.
    const claimed = await env.DB.query(`UPDATE session_schedules SET next_run_at = ?, last_run_at = ?
      WHERE id = ? AND enabled = 1 AND next_run_at = ?`)
      .bind(nextRun(schedule.cron, schedule.time_zone, at), timestamp, schedule.id, schedule.next_run_at).run();
    if (claimed.changes !== 1) continue;
    let outcome: ScheduledPromptOutcome;
    // A run in a new child session leaves the session itself alone: whatever it is doing, the run goes ahead.
    const child = schedule.run_in === 'child';
    // What the host reports now, not when the list was read: an earlier run, or someone in the chat box, woke it since.
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

const scheduleFields = ['name', 'cron', 'timeZone', 'content', 'access', 'runIn', 'enabled'] as const;
type ScheduleInput = Partial<Record<(typeof scheduleFields)[number], unknown>>;

/** A schedule's fields from a request, refusing any other. */
function scheduleInput(input: Record<string, unknown>): ScheduleInput {
  if (Object.keys(input).some(key => !(scheduleFields as readonly string[]).includes(key))) fail(400, 'invalid_input', 'Unknown schedule field.');
  return input;
}

/** Who changes a schedule: its owner, from the Schedules tab, or their agent's tool call (`callId`), which its audit names. */
type ScheduleChange = { actorId: string; callId?: string };
const changedBy = (change: ScheduleChange) => change.callId === undefined ? {} : { agent: true, callId: change.callId };

async function createSchedule(env: Env, row: SessionRow, change: ScheduleChange, input: ScheduleInput): Promise<ScheduleRow> {
  const cron = validCron(input.cron);
  const timeZone = input.timeZone === undefined ? 'UTC' : validTimeZone(input.timeZone);
  const content = text(input.content, 'content', 60000);
  const name = input.name === undefined || input.name === '' ? content.trim().split('\n')[0]!.slice(0, 80) || 'Scheduled prompt' : text(input.name, 'name', 100);
  const access = input.access === undefined ? 'approval' : validAccess(input.access);
  const runIn = input.runIn === undefined ? 'session' : validRunIn(input.runIn);
  const enabled = input.enabled === undefined ? true : validEnabled(input.enabled);
  await requireAccessSupported(env, row, access);
  const at = Date.now();
  const nextRunAt = enabled ? nextRun(cron, timeZone, at) : null;
  if (enabled && nextRunAt === null) fail(400, 'invalid_cron', 'This schedule never comes round.');
  const count = await env.DB.query<{ n: number }>('SELECT COUNT(*) AS n FROM session_schedules WHERE session_id = ?').bind(row.id).first('n');
  if (Number(count) >= MAX_SCHEDULES_PER_SESSION) fail(409, 'too_many_schedules', `A session keeps at most ${MAX_SCHEDULES_PER_SESSION} schedules.`);
  const timestamp = now();
  const schedule: ScheduleRow = { id: id(), session_id: row.id, created_by: change.actorId, name, cron, time_zone: timeZone, content, access, run_in: runIn,
    enabled: enabled ? 1 : 0, next_run_at: nextRunAt, last_run_at: null, last_submission_id: null, last_session_id: null, last_error: null, created_at: timestamp,
    updated_at: timestamp };
  await env.DB.batch([
    env.DB.query(`INSERT INTO session_schedules (id, session_id, created_by, name, cron, time_zone, content, access, run_in, enabled, next_run_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(schedule.id, row.id, schedule.created_by, name, cron, timeZone, content, access, runIn, schedule.enabled,
      nextRunAt, timestamp, timestamp),
    auditStatement(env, change.actorId, 'session.schedule.created', row.workspace_id, row.id, { scheduleId: schedule.id, cron, timeZone, access, runIn, enabled,
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
    ...(input.enabled !== undefined ? { enabled: validEnabled(input.enabled) ? 1 : 0 } : {}),
    updated_at: now() };
  if (next.access !== current.access) await requireAccessSupported(env, row, next.access);
  const timing = next.cron !== current.cron || next.time_zone !== current.time_zone || next.enabled !== current.enabled;
  if (timing) next.next_run_at = next.enabled ? nextRun(next.cron, next.time_zone, Date.now()) : null;
  if (next.enabled && next.next_run_at === null) fail(400, 'invalid_cron', 'This schedule never comes round.');
  // A sweep may claim a run, moving next_run_at on, while this request runs: an edit that doesn't change when it runs
  // leaves next_run_at alone, and one that does replaces only the next run it read, so a claimed run never comes back.
  const update = timing
    ? env.DB.query(`UPDATE session_schedules SET name = ?, cron = ?, time_zone = ?, content = ?, access = ?, run_in = ?, enabled = ?, next_run_at = ?, updated_at = ?
        WHERE id = ? AND ${current.next_run_at === null ? 'next_run_at IS NULL' : 'next_run_at = ?'}`)
      .bind(next.name, next.cron, next.time_zone, next.content, next.access, next.run_in, next.enabled, next.next_run_at, next.updated_at, next.id,
        ...(current.next_run_at === null ? [] : [current.next_run_at]))
    : env.DB.query('UPDATE session_schedules SET name = ?, content = ?, access = ?, run_in = ?, updated_at = ? WHERE id = ?')
      .bind(next.name, next.content, next.access, next.run_in, next.updated_at, next.id);
  const [updated] = await env.DB.batch([
    update,
    auditStatement(env, change.actorId, 'session.schedule.updated', row.workspace_id, row.id,
      { scheduleId: next.id, cron: next.cron, timeZone: next.time_zone, access: next.access, runIn: next.run_in, enabled: next.enabled === 1, ...changedBy(change) }),
  ]);
  // Its next run moved on, or the schedule went, since it was read: nothing changed, and the editor reads it again.
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

/**
 * The schedule tool: lists, creates, changes or deletes the session's scheduled prompts for a tool call of a write
 * message the session owner sent within the last hour, as the Schedules tab does for them, with the tool the pinned
 * agent has, or the owner allowed for the session or for this call (`requireToolCall`). Only a message the owner sent
 * with Auto-approve creates an auto-approved schedule, or changes one and leaves it so: a schedule runs later, with
 * nobody watching, and must not carry more access than the message that made it had. Any write message may pause one,
 * lower its access or delete it.
 */
export async function agentSchedules(c: AppContext, connectorId: string | null): Promise<Response> {
  // Room for a message at its character limit in any script, and JSON's escapes.
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
  if (fields.enabled !== undefined) validEnabled(fields.enabled);
  // What the permission card showed the owner, for a one-call grant: built from the call's own fields, as the runner does.
  const target = scheduleToolTarget({ action, scheduleId, ...fields as { name?: string; cron?: string; timeZone?: string; content?: string; access?: AccessMode;
    runIn?: ScheduleRunIn; enabled?: boolean } });
  const access = await sessionAccess(c.env, sessionId, actorId);
  if (!access || access.row.status === 'archived' || !hasPermission(access.permissions, 'write')) {
    fail(403, 'permission_revoked', 'The requester can no longer write to this session.');
  }
  const row = access.row;
  // A schedule runs as the session owner, so only the owner's own messages make one.
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
  // Changes that leave it auto-approved need the owner's Auto-approve; pausing one, or lowering its access, takes
  // nothing from it but what it could do unattended.
  const pausing = Object.keys(fields).length === 1 && fields.enabled === false;
  if ((fields.access ?? current.access) === 'auto' && !pausing) requireAutomatic();
  return c.json({ schedule: scheduleRecord(await updateSchedule(c.env, row, change, current, fields)) } satisfies ScheduleToolResult);
}

export function registerScheduledPrompts(app: Hono<WorkerEnv>) {
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

  // Sends the schedule's message now, as a test of it; its next scheduled run stays as it was.
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
