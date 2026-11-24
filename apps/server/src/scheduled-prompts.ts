import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import {
  accessModes, scheduleRunIns, scheduleToolActions, thinkingLevels, type AccessMode, type ChatOptions, type Schedule, type ScheduleModelChoice, type ScheduleRunIn,
  type ScheduleToolAction, type ScheduleToolResult, type SubmitResult, type ThinkingLevel, type WorkspaceRole, type WorkspaceScheduleListing,
} from '../../../packages/shared/src/types.js';
import { CronError, isTimeZone, nextCronTime, parseCron } from '../../../packages/shared/src/cron.js';
import { hasPermission, sessionCreatorRoles, workspaceManagerRoles } from '../../../packages/shared/src/policy.js';
import { asSessionOwner, errorCode } from './automatic-backups.js';
import {
  admissionExpired, auditStatement, hostCapabilities, isDeletedWorkspace, requireCallbackScope, requireMember, requireSession, requireSessionCreator, requireToolCall, sessionAccess,
} from './authority/index.js';
import { requireModel, usableModels } from './catalog.js';
import { workspaceChildSessionSettings } from './child-session-settings.js';
import { childModel, childModelChoices, childThinkingLevel, sessionCurrentModel, type ChildModel } from './cross-session.js';
import { agentMayStartOn, hostUnsandboxed, sandboxRequired, sessionSandboxed } from './placement.js';
import { requireUnfrozen } from './db.js';
import { fail, id, identifier, jsonObject, now, text, userIdentifier } from './http.js';
import { archiveSession, createSession, submitMessage } from './sessions.js';
import { keepPortable } from './portable-sessions.js';
import { body, fields as bodyFields, identifier as identifierSchema } from './schemas.js';
import type { SqlValue } from './db/types.js';
import type { AppContext, Env, SessionAccess, SessionRow, AppEnv } from './types.js';

export const MAX_SCHEDULES_PER_SESSION = 20;
export const MAX_SCHEDULES_PER_OWNER = 50;
export const MAX_SCHEDULED_SESSIONS = 20;
const sweepLimit = 20;
const hostConcurrency = 8;
const oneShotSweepLimit = 50;
const busyHosts = new WeakMap<Env['DB'], Set<string>>();

interface ScheduleRow {
  id: string; workspace_id: string; session_id: string | null; origin_session_id: string | null; owner_id: string; created_by: string;
  name: string; cron: string; time_zone: string; content: string; access: AccessMode; one_shot: number; model_id: string | null; thinking_level: ThinkingLevel | null;
  enabled: number; next_run_at: string | null; last_run_at: string | null; last_submission_id: string | null; last_session_id: string | null; last_error: string | null;
  created_at: string; updated_at: string;
}
type ListedRow = ScheduleRow & { owner_name?: string | null; origin_owner_id?: string | null };

const runInOf = (row: Pick<ScheduleRow, 'session_id'>): ScheduleRunIn => row.session_id === null ? 'child' : 'session';
const normal = <T extends ScheduleRow>(row: T): T => ({ ...row, session_id: row.session_id ?? null, origin_session_id: row.origin_session_id ?? null,
  enabled: Number(row.enabled), one_shot: Number(row.one_shot ?? 1) });

export function scheduleRecord(row: ListedRow, canManage?: boolean): Schedule {
  return { id: row.id, workspaceId: row.workspace_id, sessionId: row.session_id ?? null, ...(row.origin_session_id ? { originSessionId: row.origin_session_id } : {}),
    ...(row.origin_session_id && row.origin_owner_id ? { originOwnerId: row.origin_owner_id } : {}),
    ownerId: row.owner_id, ...(row.owner_name ? { ownerName: row.owner_name } : {}), name: row.name, cron: row.cron, timeZone: row.time_zone, content: row.content,
    access: row.access, runIn: runInOf(row), oneShot: Number(row.one_shot ?? 1) === 1,
    ...(row.model_id ? { modelId: row.model_id } : {}), ...(row.thinking_level ? { thinkingLevel: row.thinking_level } : {}),
    enabled: Number(row.enabled) === 1, nextRunAt: row.next_run_at, lastRunAt: row.last_run_at,
    lastSubmissionId: row.last_submission_id, lastSessionId: row.last_session_id ?? null, lastError: row.last_error, createdBy: row.created_by,
    createdAt: row.created_at, updatedAt: row.updated_at, ...(canManage === undefined ? {} : { canManage }) };
}

const listedSQL = `SELECT p.*, u.display_name AS owner_name, o.owner_id AS origin_owner_id FROM schedules p
  LEFT JOIN users u ON u.id = p.owner_id LEFT JOIN sessions o ON o.id = p.origin_session_id`;

async function listed(env: Env, where: string, values: SqlValue[]): Promise<ListedRow[]> {
  return (await env.DB.query<ListedRow>(`${listedSQL} WHERE ${where} ORDER BY p.created_at, p.id`).bind(...values).all()).map(normal);
}

function nextRun(cron: string, timeZone: string, at: number): string | null {
  const next = nextCronTime(cron, timeZone, at);
  return next === null ? null : new Date(next).toISOString();
}

export async function refreshNextScheduled(env: Env, sessionId: string): Promise<void> {
  await env.DB.query(`UPDATE sessions SET next_scheduled_at = (SELECT MIN(next_run_at) FROM schedules
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

function validModelId(value: unknown): string | null {
  return value === null ? null : identifier(value, 'modelId');
}

function validThinking(value: unknown): ThinkingLevel | null {
  if (value !== null && !thinkingLevels.includes(value as ThinkingLevel)) fail(400, 'invalid_input', `Thinking is ${thinkingLevels.join(', ')}, or null.`);
  return value as ThinkingLevel | null;
}

type ModelChoice = Pick<ScheduleRow, 'model_id' | 'thinking_level'>;

const chosenOf = (schedule: ModelChoice) => ({ ...(schedule.model_id ? { modelId: schedule.model_id } : {}),
  ...(schedule.thinking_level ? { thinkingLevel: schedule.thinking_level } : {}) });

const choiceCodes = ['not_found', 'model_disabled', 'thinking_unsupported', 'child_models_disabled', 'connector_trust_required', 'invalid_binding', 'invalid_input', 'model_required'];

type Refused = { refused: string };
const refused = (value: unknown): value is Refused => typeof value === 'object' && value !== null && 'refused' in value;

async function choiceRefused<T>(work: () => Promise<T>): Promise<T | Refused> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof HTTPException)) throw error;
    const code = await errorCode(error);
    if (!choiceCodes.includes(code)) throw error;
    return { refused: code };
  }
}

type ChoiceContext = { workspaceId: string; ownerId: string; origin: SessionRow | null; gated: boolean; trusted?: string; trustKept?: boolean };

function modelRequired(): never {
  fail(400, 'model_required', 'Choose the model each new session starts on.');
}

async function validModelChoice(env: Env, context: ChoiceContext, choice: ModelChoice): Promise<void> {
  if (choice.model_id === null && choice.thinking_level === null) {
    if (!context.origin) modelRequired();
    return;
  }
  if (context.gated && !(await workspaceChildSessionSettings(env.DB, context.workspaceId)).childModels) {
    fail(403, 'child_models_disabled', 'This workspace runs the sessions agents start on their parent\'s model and reasoning level. Leave out model and thinking.');
  }
  if (choice.model_id === null) {
    if (!context.origin) modelRequired();
    await childModel(env, context.origin, context.ownerId, { thinkingLevel: choice.thinking_level! }, false);
    return;
  }
  const model = await requireModel(env, choice.model_id, context.ownerId);
  if (model.workspace_id !== context.workspaceId) fail(404, 'not_found', 'Model not found.');
  const trusted = !model.connector_id || model.connector_owner_id === context.ownerId || context.trusted === model.connector_id || context.trustKept === true
    || (context.origin !== null && agentMayStartOn(context.origin, context.ownerId, model));
  if (!trusted) {
    fail(403, 'connector_trust_required', context.gated
      ? 'A session started by the agent runs on your own host or on this session\'s host. Choose such a model, or make the schedule in the workspace\'s Schedules.'
      : 'Explicitly acknowledge that this host can access the sessions this schedule starts.');
  }
  await childThinkingLevel(env, model, choice.thinking_level ?? undefined, undefined);
}

async function originFor(env: Env, schedule: Pick<ScheduleRow, 'origin_session_id'>, ownerId: string): Promise<SessionRow | null> {
  if (!schedule.origin_session_id) return null;
  const origin = await env.DB.query<SessionRow>('SELECT * FROM sessions WHERE id = ?').bind(schedule.origin_session_id).first();
  return origin && origin.owner_id === ownerId ? origin : null;
}

async function scheduleHost(env: Env, schedule: Pick<ScheduleRow, 'session_id' | 'origin_session_id' | 'model_id'>): Promise<string | null> {
  const row = await env.DB.query<{ host: string | null }>(`SELECT COALESCE(
      (SELECT connector_id FROM sessions WHERE id = ?), (SELECT connector_id FROM models WHERE id = ?), (SELECT connector_id FROM sessions WHERE id = ?)) AS host`)
    .bind(schedule.session_id, schedule.model_id, schedule.origin_session_id).first();
  return row?.host ?? null;
}

async function requireAccessSupported(env: Env, connectorId: string | null, access: AccessMode): Promise<void> {
  if (access !== 'read') return;
  if (!connectorId) fail(400, 'options_unsupported', 'This schedule\'s runner cannot run read-only prompts; schedule it without Read only.');
  const capabilities = await hostCapabilities(env, connectorId, { active: true });
  if (!capabilities) fail(409, 'connector_unavailable', 'The schedule\'s host is no longer available.');
  if (capabilities.chatOptions !== true) {
    fail(409, 'connector_update_required', 'Update the host\'s connector (npx pikibun@latest connect) to schedule read-only prompts.');
  }
}

async function workspaceRole(env: Env, workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
  const member = await env.DB.query<{ role: WorkspaceRole }>(`SELECT m.role FROM workspace_members m JOIN users u ON u.id = m.user_id
    WHERE m.workspace_id = ? AND m.user_id = ? AND u.suspended_at IS NULL`).bind(workspaceId, userId).first();
  return member?.role ?? null;
}

const creates = (role: WorkspaceRole | null | undefined) => !!role && sessionCreatorRoles.includes(role);
const administers = (role: WorkspaceRole | null | undefined) => !!role && workspaceManagerRoles.includes(role);

function managesWorkspaceSchedule(schedule: Pick<ScheduleRow, 'owner_id'>, actorId: string, role: WorkspaceRole | null | undefined): boolean {
  return creates(role) && (schedule.owner_id === actorId || administers(role));
}

function managesInSession(access: SessionAccess, schedule: Pick<ScheduleRow, 'owner_id'>, actorId: string): boolean {
  return creates(access.role) && (actorId === access.row.owner_id || actorId === schedule.owner_id || administers(access.role));
}

type Sent = SubmitResult & { startedSessionId?: string; fallback?: string };

async function send(env: Env, schedule: ScheduleRow, at: number, trigger: 'schedule' | 'manual'): Promise<Sent> {
  return asSessionOwner(env, { owner_id: schedule.owner_id }, async c => {
    if (schedule.session_id === null) return startScheduledSession(c, schedule, at, trigger);
    const { row } = await requireSession(c, schedule.session_id, 'write');
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

async function openScheduledSessions(env: Env, workspaceId: string, ownerId: string): Promise<number> {
  const open = await env.DB.query<{ n: number }>(`SELECT COUNT(*) AS n FROM sessions
    WHERE workspace_id = ? AND owner_id = ? AND schedule_id IS NOT NULL AND status <> 'archived'`).bind(workspaceId, ownerId).first('n');
  return Number(open ?? 0);
}

function tooManySessions(): never {
  fail(409, 'too_many_sessions', `Your schedules in this workspace keep at most ${MAX_SCHEDULED_SESSIONS} sessions open. Archive some of the sessions they started.`);
}

type RunModel = { model: ChildModel; thinkingLevel?: ThinkingLevel; fallback?: string };

async function runModel(env: Env, schedule: ScheduleRow, ownerId: string, origin: SessionRow | null): Promise<RunModel> {
  const chosen = chosenOf(schedule);
  const fromOrigin = async (fallback?: string): Promise<RunModel> => {
    if (!origin) fail(409, 'model_unavailable', 'The schedule\'s model is no longer available. Choose another.');
    const { model, thinkingLevel } = await childModel(env, origin, ownerId, {}, true);
    return { model, ...(thinkingLevel ? { thinkingLevel } : {}), ...(fallback ? { fallback } : {}) };
  };
  if (chosen.modelId === undefined && chosen.thinkingLevel === undefined) return fromOrigin();
  if (origin && !(await workspaceChildSessionSettings(env.DB, schedule.workspace_id)).childModels) return fromOrigin('child_models_disabled');
  if (chosen.modelId === undefined) {
    if (!origin) return fromOrigin();
    const levelled = await choiceRefused(() => childModel(env, origin, ownerId, chosen, true));
    if (!refused(levelled)) return { model: levelled.model, ...(levelled.thinkingLevel ? { thinkingLevel: levelled.thinkingLevel } : {}) };
    return fromOrigin(levelled.refused === 'thinking_unsupported' ? levelled.refused : 'model_unavailable');
  }
  const model = await choiceRefused(() => requireModel(env, chosen.modelId!, ownerId));
  if (refused(model) || model.workspace_id !== schedule.workspace_id) return fromOrigin('model_unavailable');
  const inherited = chosen.thinkingLevel === undefined && origin ? (await sessionCurrentModel(env, origin, ownerId)).thinkingLevel : undefined;
  const level = await choiceRefused(() => childThinkingLevel(env, model, chosen.thinkingLevel, inherited));
  if (refused(level)) return { model, fallback: 'thinking_unsupported' };
  return { model, ...(level ? { thinkingLevel: level } : {}) };
}

async function startScheduledSession(c: AppContext, schedule: ScheduleRow, at: number, trigger: 'schedule' | 'manual'): Promise<Sent> {
  const ownerId = c.get('auth').userId;
  await requireSessionCreator(c.env, schedule.workspace_id, ownerId);
  if (await openScheduledSessions(c.env, schedule.workspace_id, ownerId) >= MAX_SCHEDULED_SESSIONS) tooManySessions();
  const origin = await originFor(c.env, schedule, ownerId);
  const { model, thinkingLevel, fallback } = await runModel(c.env, schedule, ownerId, origin);
  const started: { id?: string } = {};
  try {
    const { row: session } = await createSession(c, { workspaceId: schedule.workspace_id, title: `${schedule.name} · ${runLabel(at, schedule.time_zone)}`,
      modelId: model.id,
      ...(model.connector_id ? { trustedConnectorId: model.connector_id } : {}),
    }, { ...(origin ? { parentSessionId: origin.id } : {}), scheduleId: schedule.id, inserted: sessionId => { started.id = sessionId; } });
    if (await openScheduledSessions(c.env, schedule.workspace_id, ownerId) > MAX_SCHEDULED_SESSIONS) tooManySessions();
    await auditStatement(c.env, ownerId, 'workspace.schedule.session_started', schedule.workspace_id, origin?.id ?? null,
      { scheduleId: schedule.id, sessionId: session.id, trigger, modelId: model.id, ...(thinkingLevel ? { thinkingLevel } : {}), ...(fallback ? { fallback } : {}) }).run();
    if (Number(schedule.one_shot ?? 1) === 1) await c.env.DB.query('UPDATE sessions SET one_shot = 1 WHERE id = ?').bind(session.id).run();
    const options: ChatOptions = { ...(schedule.access === 'read' ? { access: 'read' } : {}), ...(thinkingLevel ? { thinkingLevel } : {}) };
    const submission = await submitMessage(c, session, 'submit', {
      content: schedule.content,
      requestId: `schedule:${schedule.id}:${at}`,
      ...(Object.keys(options).length ? { options } : {}),
    }, { scheduleId: schedule.id, trigger, ...(origin ? { parentSessionId: origin.id } : {}) }, { currentModel: true });
    return { ...submission, startedSessionId: session.id, ...(fallback ? { fallback } : {}) };
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

export type ScheduledPromptOutcome = { scheduleId: string; sessionId: string | null; submissionId: string; startedSessionId?: string; fallback?: string }
  | { scheduleId: string; sessionId: string | null; error: string };

type DueSchedule = ScheduleRow & { host_id: string | null };

const hostKey = (schedule: DueSchedule) => schedule.host_id !== null ? `host:${schedule.host_id}`
  : schedule.session_id !== null ? `session:${schedule.session_id}` : `schedule:${schedule.id}`;
const dueHost = 'COALESCE(s.connector_id, m.connector_id, o.connector_id)';

export async function runScheduledPrompts(env: Env, at = Date.now()): Promise<ScheduledPromptOutcome[]> {
  const timestamp = new Date(at).toISOString();
  let busy = busyHosts.get(env.DB);
  if (!busy) busyHosts.set(env.DB, busy = new Set());
  const held = (prefix: string) => [...busy].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length));
  const [skippedHosts, skippedSessions, skippedSchedules] = [held('host:'), held('session:'), held('schedule:')];
  const list = (values: string[]) => values.map(() => '?').join(', ');
  const due = (await env.DB.query<DueSchedule>(`SELECT p.*, ${dueHost} AS host_id
    FROM schedules p LEFT JOIN sessions s ON s.id = p.session_id LEFT JOIN models m ON m.id = p.model_id LEFT JOIN sessions o ON o.id = p.origin_session_id
    WHERE p.enabled = 1 AND p.next_run_at IS NOT NULL AND p.next_run_at <= ? AND (p.session_id IS NULL OR s.status = 'ready')
    ${skippedHosts.length ? `AND (${dueHost} IS NULL OR ${dueHost} NOT IN (${list(skippedHosts)}))` : ''}
    ${skippedSessions.length ? `AND (p.session_id IS NULL OR p.session_id NOT IN (${list(skippedSessions)}))` : ''}
    ${skippedSchedules.length ? `AND p.id NOT IN (${list(skippedSchedules)})` : ''}
    ORDER BY p.next_run_at, p.id LIMIT ?`).bind(timestamp, ...skippedHosts, ...skippedSessions, ...skippedSchedules, sweepLimit).all()).map(normal);
  const hosts = new Map<string, { schedule: DueSchedule; index: number }[]>();
  due.forEach((schedule, index) => {
    const key = hostKey(schedule);
    if (busy.has(key)) return;
    hosts.set(key, [...hosts.get(key) ?? [], { schedule, index }]);
  });
  for (const key of hosts.keys()) busy.add(key);
  const outcomes: (ScheduledPromptOutcome | undefined)[] = [];
  const queue = [...hosts.entries()];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [key, schedules] = next;
      try {
        const sent = new Set<string>();
        for (const { schedule, index } of schedules) {
          try { outcomes[index] = await runDueSchedule(env, schedule, at, timestamp, sent); }
          catch (error) { outcomes[index] = { scheduleId: schedule.id, sessionId: schedule.session_id, error: await errorCode(error).catch(() => 'internal_error') }; }
        }
      } finally {
        busy.delete(key);
      }
    }
  };
  try {
    await Promise.allSettled(Array.from({ length: Math.min(hostConcurrency, queue.length) }, worker));
  } finally {
    for (const [key] of queue.splice(0)) busy.delete(key);
  }
  return outcomes.filter((outcome): outcome is ScheduledPromptOutcome => outcome !== undefined);
}

async function ownerMayRun(env: Env, schedule: ScheduleRow): Promise<boolean> {
  if (schedule.session_id === null) return creates(await workspaceRole(env, schedule.workspace_id, schedule.owner_id));
  const access = await sessionAccess(env, schedule.session_id, schedule.owner_id);
  return !!access && hasPermission(access.permissions, 'write');
}

async function runDueSchedule(env: Env, schedule: DueSchedule, at: number, timestamp: string, sent: Set<string>): Promise<ScheduledPromptOutcome | undefined> {
  const claimed = await env.DB.query(`UPDATE schedules SET next_run_at = ?, last_run_at = ?
    WHERE id = ? AND enabled = 1 AND next_run_at = ?`)
    .bind(nextRun(schedule.cron, schedule.time_zone, at), timestamp, schedule.id, schedule.next_run_at).run();
  if (claimed.changes !== 1) return undefined;
  let outcome: ScheduledPromptOutcome;
  let pause = false;
  const target = schedule.session_id;
  const activity = target === null ? null : sent.has(target) ? 'working'
    : await env.DB.query<{ activity: string | null }>('SELECT activity FROM sessions WHERE id = ?').bind(target).first('activity');
  if (activity === 'working' || activity === 'waiting') {
    outcome = { scheduleId: schedule.id, sessionId: target, error: 'session_busy' };
  } else if (await isDeletedWorkspace(env, schedule.workspace_id)) {
    outcome = { scheduleId: schedule.id, sessionId: target, error: 'workspace_deleted' };
  } else if (!(await ownerMayRun(env, schedule))) {
    outcome = { scheduleId: schedule.id, sessionId: target, error: 'owner_unavailable' };
    pause = true;
  } else {
    try {
      const result = await send(env, schedule, at, 'schedule');
      if (target !== null) sent.add(target);
      outcome = { scheduleId: schedule.id, sessionId: target, submissionId: result.submissionId,
        ...(result.startedSessionId ? { startedSessionId: result.startedSessionId } : {}), ...(result.fallback ? { fallback: result.fallback } : {}) };
    } catch (error) {
      outcome = { scheduleId: schedule.id, sessionId: target, error: await errorCode(error) };
    }
  }
  await env.DB.query(`UPDATE schedules SET last_submission_id = ?, last_session_id = ?, last_error = ?${pause ? ', enabled = 0, next_run_at = NULL' : ''} WHERE id = ?`)
    .bind('submissionId' in outcome ? outcome.submissionId : null, 'startedSessionId' in outcome ? outcome.startedSessionId ?? null : null,
      'error' in outcome ? outcome.error : outcome.fallback ?? null, schedule.id).run();
  if (target !== null) await refreshNextScheduled(env, target);
  return outcome;
}

const scheduleFields = ['name', 'cron', 'timeZone', 'content', 'access', 'runIn', 'oneShot', 'modelId', 'thinkingLevel', 'enabled'] as const;
type ScheduleInput = Partial<Record<(typeof scheduleFields)[number], unknown>>;

function scheduleInput(input: Record<string, unknown>): { fields: ScheduleInput; trusted?: string } {
  const { trustedConnectorId, ...fields } = input;
  if (Object.keys(fields).some(key => !(scheduleFields as readonly string[]).includes(key))) fail(400, 'invalid_input', 'Unknown schedule field.');
  return { fields, ...(trustedConnectorId === undefined ? {} : { trusted: identifier(trustedConnectorId, 'trustedConnectorId') }) };
}

const checkedLater = z.unknown().optional();
const workspaceBody = bodyFields({ name: checkedLater, cron: checkedLater, timeZone: checkedLater, content: checkedLater, access: checkedLater, oneShot: checkedLater,
  modelId: checkedLater, thinkingLevel: checkedLater, enabled: checkedLater, trustedConnectorId: identifierSchema('trustedConnectorId').optional() }, 'Unknown schedule field.');

async function workspaceInput(c: AppContext): Promise<{ fields: ScheduleInput; trusted?: string }> {
  const { trustedConnectorId, ...input } = await body(c, workspaceBody);
  return { fields: Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)), ...(trustedConnectorId ? { trusted: trustedConnectorId } : {}) };
}

type ScheduleChange = { actorId: string; callId?: string; gated: boolean; trusted?: string; agentSession?: SessionRow };

async function requireSandboxKept(env: Env, change: ScheduleChange, schedule: Pick<ScheduleRow, 'session_id' | 'origin_session_id' | 'model_id'>): Promise<void> {
  if (!change.agentSession || schedule.session_id !== null) return;
  if (!await hostUnsandboxed(env, await scheduleHost(env, schedule)) || !await sessionSandboxed(env, change.agentSession)) return;
  sandboxRequired('make or change a schedule whose runs start there', 'the host this schedule\'s runs start on',
    'Choose a model on a sandboxed host (sessions list shows each host\'s sandbox), or ask the person to make or change it themselves, in this session\'s Schedules tab or the workspace\'s Schedules.');
}
const changedBy = (change: ScheduleChange) => change.callId === undefined ? {} : { agent: true, callId: change.callId };
type Target = { workspaceId: string; session: SessionRow | null; origin: SessionRow | null };

const auditOf = (schedule: Pick<ScheduleRow, 'session_id' | 'origin_session_id'>, action: 'created' | 'updated' | 'deleted') => schedule.session_id !== null
  ? { action: `session.schedule.${action}`, sessionId: schedule.session_id } : { action: `workspace.schedule.${action}`, sessionId: schedule.origin_session_id };

async function requireRoomFor(env: Env, workspaceId: string, ownerId: string): Promise<void> {
  const count = await env.DB.query<{ n: number }>('SELECT COUNT(*) AS n FROM schedules WHERE workspace_id = ? AND owner_id = ? AND session_id IS NULL')
    .bind(workspaceId, ownerId).first('n');
  if (Number(count) >= MAX_SCHEDULES_PER_OWNER) {
    fail(409, 'too_many_schedules', `Each person keeps at most ${MAX_SCHEDULES_PER_OWNER} schedules that start new sessions in a workspace.`);
  }
}

function noModelForSession(): never {
  fail(400, 'invalid_input', 'A model and reasoning level choose what each run in a new session starts on: run it in a new session, or leave them out.');
}

async function createSchedule(env: Env, target: Target, change: ScheduleChange, input: ScheduleInput): Promise<ScheduleRow> {
  const cron = validCron(input.cron);
  const timeZone = input.timeZone === undefined ? 'UTC' : validTimeZone(input.timeZone);
  const content = text(input.content, 'content', 60000);
  const name = input.name === undefined || input.name === '' ? content.trim().split('\n')[0]!.slice(0, 80) || 'Scheduled prompt' : text(input.name, 'name', 100);
  const access = input.access === undefined ? 'auto' : validAccess(input.access);
  if (input.runIn !== undefined) validRunIn(input.runIn);
  const oneShot = input.oneShot === undefined ? true : validOneShot(input.oneShot);
  const modelId = input.modelId === undefined ? null : validModelId(input.modelId);
  const thinkingLevel = input.thinkingLevel === undefined ? null : validThinking(input.thinkingLevel);
  const enabled = input.enabled === undefined ? true : validEnabled(input.enabled);
  const session = target.session;
  const at = Date.now();
  const timestamp = now();
  const schedule: ScheduleRow = { id: id(), workspace_id: target.workspaceId, session_id: session?.id ?? null, origin_session_id: session ? null : target.origin?.id ?? null,
    owner_id: change.actorId, created_by: change.actorId, name, cron, time_zone: timeZone, content, access, one_shot: oneShot ? 1 : 0,
    model_id: modelId, thinking_level: thinkingLevel, enabled: enabled ? 1 : 0, next_run_at: enabled ? nextRun(cron, timeZone, at) : null,
    last_run_at: null, last_submission_id: null, last_session_id: null, last_error: null, created_at: timestamp, updated_at: timestamp };
  if (session && (modelId !== null || thinkingLevel !== null)) noModelForSession();
  if (!session) await validModelChoice(env, { workspaceId: target.workspaceId, ownerId: change.actorId, origin: target.origin, gated: change.gated, trusted: change.trusted }, schedule);
  await requireSandboxKept(env, change, schedule);
  await requireAccessSupported(env, await scheduleHost(env, schedule), access);
  if (enabled && schedule.next_run_at === null) fail(400, 'invalid_cron', 'This schedule never comes round.');
  if (session) {
    const count = await env.DB.query<{ n: number }>('SELECT COUNT(*) AS n FROM schedules WHERE session_id = ?').bind(session.id).first('n');
    if (Number(count) >= MAX_SCHEDULES_PER_SESSION) fail(409, 'too_many_schedules', `A session keeps at most ${MAX_SCHEDULES_PER_SESSION} schedules.`);
  } else {
    await requireRoomFor(env, target.workspaceId, change.actorId);
  }
  const audit = auditOf(schedule, 'created');
  await env.DB.batch([
    env.DB.query(`INSERT INTO schedules (id, workspace_id, session_id, origin_session_id, owner_id, created_by, name, cron, time_zone, content, access, one_shot,
        model_id, thinking_level, enabled, next_run_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(schedule.id, schedule.workspace_id, schedule.session_id, schedule.origin_session_id,
      schedule.owner_id, schedule.created_by, name, cron, timeZone, content, access, schedule.one_shot, modelId, thinkingLevel, schedule.enabled, schedule.next_run_at,
      timestamp, timestamp),
    auditStatement(env, change.actorId, audit.action, target.workspaceId, audit.sessionId, { scheduleId: schedule.id, cron, timeZone, access, runIn: runInOf(schedule),
      oneShot, ...chosenOf(schedule), enabled, ...changedBy(change) }),
  ]);
  if (session) await refreshNextScheduled(env, session.id);
  return schedule;
}

async function updateSchedule(env: Env, context: { session: SessionRow | null }, change: ScheduleChange, current: ScheduleRow, input: ScheduleInput): Promise<ScheduleRow> {
  const next: ScheduleRow = { ...current,
    ...(input.name !== undefined ? { name: text(input.name, 'name', 100) } : {}),
    ...(input.cron !== undefined ? { cron: validCron(input.cron) } : {}),
    ...(input.timeZone !== undefined ? { time_zone: validTimeZone(input.timeZone) } : {}),
    ...(input.content !== undefined ? { content: text(input.content, 'content', 60000) } : {}),
    ...(input.access !== undefined ? { access: validAccess(input.access) } : {}),
    ...(input.oneShot !== undefined ? { one_shot: validOneShot(input.oneShot) ? 1 : 0 } : {}),
    ...(input.modelId !== undefined ? { model_id: validModelId(input.modelId) } : {}),
    ...(input.thinkingLevel !== undefined ? { thinking_level: validThinking(input.thinkingLevel) } : {}),
    ...(input.enabled !== undefined ? { enabled: validEnabled(input.enabled) ? 1 : 0 } : {}),
    updated_at: now() };
  next.model_id ??= null;
  next.thinking_level ??= null;
  const runIn = input.runIn === undefined ? runInOf(current) : validRunIn(input.runIn);
  if (runIn !== runInOf(current)) {
    if (runIn === 'child') {
      next.origin_session_id = current.session_id;
      next.session_id = null;
    } else if (context.session && current.origin_session_id === context.session.id) {
      next.session_id = context.session.id;
      next.origin_session_id = null;
    } else {
      fail(400, 'invalid_input', 'Only a schedule made in this session can run in it.');
    }
  }
  const takeover = change.actorId !== current.owner_id && Object.keys(input).some(key => key !== 'enabled');
  if (takeover) next.owner_id = change.actorId;
  if (next.session_id === null && (takeover || current.session_id !== null)) await requireRoomFor(env, next.workspace_id, next.owner_id);
  if (next.session_id !== null) {
    if ((next.model_id !== null && input.modelId !== undefined) || (next.thinking_level !== null && input.thinkingLevel !== undefined)) noModelForSession();
    next.model_id = null;
    next.thinking_level = null;
  } else if (input.modelId !== undefined || input.thinkingLevel !== undefined || takeover || runIn !== runInOf(current)) {
    const origin = await originFor(env, next, next.owner_id);
    await validModelChoice(env, { workspaceId: next.workspace_id, ownerId: next.owner_id, origin, gated: change.gated, trusted: change.trusted,
      trustKept: next.model_id === current.model_id && next.owner_id === current.owner_id && current.session_id === null }, next);
  }
  if (next.enabled === 1 || Object.keys(input).some(key => key !== 'enabled')) await requireSandboxKept(env, change, next);
  if (next.access === 'read' && (next.access !== current.access || next.model_id !== current.model_id || next.session_id !== current.session_id)) {
    await requireAccessSupported(env, await scheduleHost(env, next), next.access);
  }
  const timing = next.cron !== current.cron || next.time_zone !== current.time_zone || next.enabled !== current.enabled;
  if (timing) next.next_run_at = next.enabled ? nextRun(next.cron, next.time_zone, Date.now()) : null;
  if (next.enabled && next.next_run_at === null) fail(400, 'invalid_cron', 'This schedule never comes round.');
  const columns = 'name = ?, content = ?, access = ?, session_id = ?, origin_session_id = ?, owner_id = ?, one_shot = ?, model_id = ?, thinking_level = ?';
  const values = [next.name, next.content, next.access, next.session_id, next.origin_session_id, next.owner_id, next.one_shot, next.model_id, next.thinking_level];
  const update = timing
    ? env.DB.query(`UPDATE schedules SET ${columns}, cron = ?, time_zone = ?, enabled = ?, next_run_at = ?, updated_at = ?
        WHERE id = ? AND ${current.next_run_at === null ? 'next_run_at IS NULL' : 'next_run_at = ?'}`)
      .bind(...values, next.cron, next.time_zone, next.enabled, next.next_run_at, next.updated_at, next.id, ...(current.next_run_at === null ? [] : [current.next_run_at]))
    : env.DB.query(`UPDATE schedules SET ${columns}, updated_at = ? WHERE id = ?`).bind(...values, next.updated_at, next.id);
  const audit = auditOf(next, 'updated');
  const [updated] = await env.DB.batch([
    update,
    auditStatement(env, change.actorId, audit.action, next.workspace_id, audit.sessionId,
      { scheduleId: next.id, cron: next.cron, timeZone: next.time_zone, access: next.access, runIn: runInOf(next), oneShot: next.one_shot === 1, ...chosenOf(next),
        enabled: next.enabled === 1, ...(takeover ? { takenOverFrom: current.owner_id } : {}), ...changedBy(change) }),
  ]);
  if (updated!.changes !== 1) fail(409, 'schedule_changed', 'This schedule ran or changed meanwhile. Reload it and try again.');
  for (const sessionId of new Set([current.session_id, next.session_id])) if (sessionId) await refreshNextScheduled(env, sessionId);
  const saved = await env.DB.query<ScheduleRow>('SELECT * FROM schedules WHERE id = ?').bind(next.id).first();
  return saved ? normal(saved) : next;
}

async function deleteSchedule(env: Env, change: ScheduleChange, schedule: ScheduleRow): Promise<void> {
  const audit = auditOf(schedule, 'deleted');
  await env.DB.batch([
    env.DB.query('DELETE FROM schedules WHERE id = ?').bind(schedule.id),
    auditStatement(env, change.actorId, audit.action, schedule.workspace_id, audit.sessionId, { scheduleId: schedule.id, ...changedBy(change) }),
  ]);
  if (schedule.session_id) await refreshNextScheduled(env, schedule.session_id);
}

async function runNow(c: AppContext, schedule: ScheduleRow): Promise<Response> {
  const at = Date.now();
  const timestamp = new Date(at).toISOString();
  try {
    const { startedSessionId, fallback, ...submission } = await send(c.env, schedule, at, 'manual');
    await c.env.DB.query('UPDATE schedules SET last_run_at = ?, last_submission_id = ?, last_session_id = ?, last_error = ? WHERE id = ?')
      .bind(timestamp, submission.submissionId, startedSessionId ?? null, fallback ?? null, schedule.id).run();
    return c.json({ schedule: scheduleRecord({ ...schedule, last_run_at: timestamp, last_submission_id: submission.submissionId, last_session_id: startedSessionId ?? null,
      last_error: fallback ?? null }), submission, ...(startedSessionId ? { sessionId: startedSessionId } : {}) }, 202);
  } catch (error) {
    await c.env.DB.query('UPDATE schedules SET last_run_at = ?, last_submission_id = NULL, last_session_id = NULL, last_error = ? WHERE id = ?')
      .bind(timestamp, await errorCode(error), schedule.id).run();
    throw error;
  }
}

export async function sessionSchedules(env: Env, sessionId: string): Promise<Schedule[]> {
  return (await listed(env, 'p.session_id = ? OR p.origin_session_id = ?', [sessionId, sessionId])).map(row => scheduleRecord(row));
}

async function keepPortableFor(c: AppContext, schedule: Pick<ScheduleRow, 'session_id' | 'origin_session_id'>): Promise<void> {
  for (const sessionId of new Set([schedule.session_id, schedule.origin_session_id])) {
    if (!sessionId) continue;
    const row = await c.env.DB.query<SessionRow>('SELECT * FROM sessions WHERE id = ?').bind(sessionId).first();
    if (row) await keepPortable(c, row);
  }
}

export async function restorePortableSchedules(env: Env, row: SessionRow, schedules: Record<string, unknown>[]): Promise<number> {
  if (!schedules.length) return 0;
  const count = await env.DB.query<{ n: number }>('SELECT COUNT(*) AS n FROM schedules WHERE session_id = ? OR origin_session_id = ?').bind(row.id, row.id).first('n');
  if (Number(count) > 0) return 0;
  let restored = 0;
  for (const schedule of schedules.slice(0, MAX_SCHEDULES_PER_SESSION)) {
    const fields: ScheduleInput = Object.fromEntries(scheduleFields.filter(key => schedule[key] !== undefined).map(key => [key, schedule[key]]));
    const { modelId, thinkingLevel, ...sessionModel } = fields;
    const attempts = modelId === undefined && thinkingLevel === undefined ? [fields]
      : [fields, ...(modelId !== undefined && thinkingLevel !== undefined ? [{ ...sessionModel, modelId }] : []), sessionModel];
    const target: Target = fields.runIn === 'child' ? { workspaceId: row.workspace_id, session: null, origin: row } : { workspaceId: row.workspace_id, session: row, origin: null };
    for (const [index, attempt] of attempts.entries()) {
      try {
        await createSchedule(env, target, { actorId: row.owner_id, gated: true }, attempt);
        restored++;
        break;
      } catch (error) {
        if (index === attempts.length - 1 || !(error instanceof HTTPException) || !choiceCodes.includes(await errorCode(error))) break;
      }
    }
  }
  return restored;
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
  if (fields.modelId !== undefined) validModelId(fields.modelId);
  if (fields.thinkingLevel !== undefined) validThinking(fields.thinkingLevel);
  if (fields.oneShot !== undefined) validOneShot(fields.oneShot);
  if (fields.enabled !== undefined) validEnabled(fields.enabled);
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
    || await admissionExpired(c.env, admissionId, admission)) {
    fail(403, 'schedule_not_admitted', 'Scheduling needs a write message from the session owner sent within the last hour, or whose run is still going.');
  }
  await requireToolCall(c.env, row, actorId, 'schedule');
  const visible = 'p.workspace_id = ? AND (p.session_id = ? OR p.origin_session_id = ? OR (p.session_id IS NULL AND p.owner_id = ?))';
  if (action === 'list') {
    const rows = await listed(c.env, visible, [row.workspace_id, row.id, row.id, actorId]);
    return c.json({ schedules: rows.map(item => scheduleRecord(item, item.session_id !== null || managesWorkspaceSchedule(item, actorId, access.role))) } satisfies ScheduleToolResult);
  }
  requireUnfrozen(row);
  if (admission.access === 'read') {
    fail(403, 'read_only_message', 'A Read-only message changes nothing, schedules included: ask in a message that may act.');
  }
  const change: ScheduleChange = { actorId, callId, gated: true, agentSession: row };
  if (action === 'create') {
    const created = await createSchedule(c.env, fields.runIn === 'child' ? { workspaceId: row.workspace_id, session: null, origin: row }
      : { workspaceId: row.workspace_id, session: row, origin: null }, change, fields);
    await keepPortable(c, row);
    return c.json({ schedule: scheduleRecord(created) } satisfies ScheduleToolResult, 201);
  }
  const [current] = (await listed(c.env, `p.id = ? AND ${visible}`, [scheduleId!, row.workspace_id, row.id, row.id, actorId]))
    .filter(item => item.session_id !== null || item.origin_session_id === row.id || managesWorkspaceSchedule(item, actorId, access.role));
  if (!current) fail(404, 'not_found', 'Schedule not found.');
  if (action === 'delete') {
    await deleteSchedule(c.env, change, current);
    await keepPortableFor(c, current);
    return c.json({ deleted: current.id } satisfies ScheduleToolResult);
  }
  const updated = await updateSchedule(c.env, { session: row }, change, current, fields);
  await keepPortableFor(c, { session_id: updated.session_id ?? current.session_id, origin_session_id: updated.origin_session_id ?? current.origin_session_id });
  return c.json({ schedule: scheduleRecord(updated) } satisfies ScheduleToolResult);
}

async function scheduleModels(env: Env, workspaceId: string, actorId: string, keep: (model: { connector_id?: string | null; connector_owner_id?: string | null }) => boolean = () => true):
  Promise<{ models: ScheduleModelChoice[]; childModels: boolean }> {
  const usable = (await usableModels(env, workspaceId, actorId)).filter(keep);
  const foreign = new Set(usable.filter(model => model.connector_id && model.connector_owner_id !== actorId).map(model => model.id));
  const { models, childModels } = await childModelChoices(env, workspaceId, usable);
  return { models: models.map(model => ({ ...model, ...(foreign.has(model.id) ? { foreignHost: true } : {}) })), childModels };
}

async function sessionSchedule(c: AppContext, permission: 'read' | 'write'): Promise<{ access: SessionAccess; schedule: ListedRow }> {
  const access = await requireSession(c, identifier(c.req.param('id')), permission);
  const scheduleId = identifier(c.req.param('scheduleId'), 'scheduleId');
  const [schedule] = await listed(c.env, 'p.id = ? AND (p.session_id = ? OR p.origin_session_id = ?)', [scheduleId, access.row.id, access.row.id]);
  if (!schedule) fail(404, 'not_found', 'Schedule not found.');
  return { access, schedule };
}

async function managedInSession(c: AppContext): Promise<{ row: SessionRow; schedule: ListedRow }> {
  const { access, schedule } = await sessionSchedule(c, 'write');
  if (!managesInSession(access, schedule, c.get('auth').userId)) {
    fail(403, 'owner_required', 'Only the session owner, the schedule\'s owner, or the workspace\'s owner or an admin, changes this schedule.');
  }
  requireUnfrozen(access.row);
  return { row: access.row, schedule };
}

async function managedInWorkspace(c: AppContext): Promise<ListedRow> {
  const workspaceId = identifier(c.req.param('id'));
  const actorId = c.get('auth').userId;
  const member = await requireMember(c.env, workspaceId, actorId);
  const [schedule] = await listed(c.env, 'p.id = ? AND p.workspace_id = ? AND p.session_id IS NULL', [identifier(c.req.param('scheduleId'), 'scheduleId'), workspaceId]);
  if (!schedule) fail(404, 'not_found', 'Schedule not found.');
  if (!managesWorkspaceSchedule(schedule, actorId, member.role)) {
    fail(403, 'forbidden', 'Only the schedule\'s owner, or the workspace\'s owner or an admin, changes this schedule.');
  }
  return schedule;
}

export function registerScheduledPrompts(app: Hono<AppEnv>) {
  app.get('/api/sessions/:id/schedules', async c => {
    const access = await requireSession(c, identifier(c.req.param('id')), 'read');
    const { row } = access;
    const actorId = c.get('auth').userId;
    const rows = await listed(c.env, 'p.session_id = ? OR p.origin_session_id = ?', [row.id, row.id]);
    const open = row.status !== 'archived';
    const canCreate = row.owner_id === actorId && open;
    const canManage = open && creates(access.role) && (row.owner_id === actorId || administers(access.role));
    const choices = canCreate ? await scheduleModels(c.env, row.workspace_id, row.owner_id, model => !model.connector_id || agentMayStartOn(row, row.owner_id, model)) : undefined;
    return c.json({ schedules: rows.map(item => scheduleRecord(item, open && managesInSession(access, item, actorId))), canManage, canCreate, ...choices });
  });

  app.post('/api/sessions/:id/schedules', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'write');
    if (row.owner_id !== c.get('auth').userId) fail(403, 'owner_required', 'Only the session owner can schedule prompts.');
    requireUnfrozen(row);
    const { fields: input, trusted } = scheduleInput(await jsonObject(c));
    const target: Target = input.runIn === 'child' ? { workspaceId: row.workspace_id, session: null, origin: row } : { workspaceId: row.workspace_id, session: row, origin: null };
    const schedule = await createSchedule(c.env, target, { actorId: c.get('auth').userId, gated: true, ...(trusted ? { trusted } : {}) }, input);
    await keepPortable(c, row);
    return c.json({ schedule: scheduleRecord(schedule) }, 201);
  });

  app.patch('/api/sessions/:id/schedules/:scheduleId', async c => {
    const { row, schedule } = await managedInSession(c);
    const { fields, trusted } = scheduleInput(await jsonObject(c));
    const saved = await updateSchedule(c.env, { session: row }, { actorId: c.get('auth').userId, gated: true, ...(trusted ? { trusted } : {}) }, schedule, fields);
    await keepPortableFor(c, { session_id: row.id, origin_session_id: null });
    return c.json({ schedule: scheduleRecord(saved) });
  });

  app.delete('/api/sessions/:id/schedules/:scheduleId', async c => {
    const { row, schedule } = await managedInSession(c);
    await deleteSchedule(c.env, { actorId: c.get('auth').userId, gated: true }, schedule);
    await keepPortable(c, row);
    return c.body(null, 204);
  });

  app.post('/api/sessions/:id/schedules/:scheduleId/run', async c => runNow(c, (await managedInSession(c)).schedule));

  app.get('/api/workspaces/:id/schedules', async c => {
    const workspaceId = identifier(c.req.param('id'));
    const actorId = c.get('auth').userId;
    const member = await requireMember(c.env, workspaceId, actorId);
    const canCreate = creates(member.role);
    const rows = await listed(c.env, 'p.workspace_id = ? AND p.session_id IS NULL', [workspaceId]);
    const choices = canCreate ? await scheduleModels(c.env, workspaceId, actorId) : undefined;
    return c.json({ schedules: rows.map(row => scheduleRecord(row, managesWorkspaceSchedule(row, actorId, member.role))), canCreate, admin: administers(member.role),
      ...(choices ? { models: choices.models } : {}) } satisfies WorkspaceScheduleListing);
  });

  app.post('/api/workspaces/:id/schedules', async c => {
    const workspaceId = identifier(c.req.param('id'));
    const actorId = c.get('auth').userId;
    await requireSessionCreator(c.env, workspaceId, actorId);
    const { fields, trusted } = await workspaceInput(c);
    const schedule = await createSchedule(c.env, { workspaceId, session: null, origin: null }, { actorId, gated: false, ...(trusted ? { trusted } : {}) }, fields);
    return c.json({ schedule: scheduleRecord(schedule, true) }, 201);
  });

  app.patch('/api/workspaces/:id/schedules/:scheduleId', async c => {
    const schedule = await managedInWorkspace(c);
    const { fields, trusted } = await workspaceInput(c);
    const saved = await updateSchedule(c.env, { session: null }, { actorId: c.get('auth').userId, gated: false, ...(trusted ? { trusted } : {}) }, schedule, fields);
    await keepPortableFor(c, saved);
    return c.json({ schedule: scheduleRecord(saved, true) });
  });

  app.delete('/api/workspaces/:id/schedules/:scheduleId', async c => {
    const schedule = await managedInWorkspace(c);
    await deleteSchedule(c.env, { actorId: c.get('auth').userId, gated: false }, schedule);
    await keepPortableFor(c, schedule);
    return c.body(null, 204);
  });

  app.post('/api/workspaces/:id/schedules/:scheduleId/run', async c => runNow(c, await managedInWorkspace(c)));
}
