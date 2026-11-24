import type { Hono } from 'hono';
import { z } from 'zod';
import { hasPermission, workspaceManagerRoles } from '../../../packages/shared/src/policy.js';
import { sessionToolExtensionOn } from '../../../packages/shared/src/piki-extensions.js';
import {
  isMemoryWriteAction, memoryActionFields, memoryNoteResolutions, memoryToolActions, workspaceMemoryLimits,
  type MemoryNoteResolution, type MemoryToolAction, type WorkspaceMemory, type WorkspaceMemoryNote, type WorkspaceMemoryPrompt, type WorkspaceMemoryView,
} from '../../../packages/shared/src/workspace-memory.js';
import {
  auditStatement, requireAdmission, requireCallbackScope, requireMember, requireToolCall, sessionAccess, workspaceAdminSQL, workspaceExtensions,
} from './authority/index.js';
import { fail, id, identifier, now } from './http.js';
import { body, fields as requestShape, identifier as identifierField, text, userIdentifier as userField } from './schemas.js';
import type { AppContext, AppEnv, Env, SessionRow } from './types.js';

interface MemoryRow { instructions: string; memory: string; revision: number | string; updated_by: string | null; updated_at: string | null }
interface NoteRow {
  id: string; session_id: string | null; session_title: string | null; author_id: string; text: string; status: WorkspaceMemoryNote['status'];
  created_at: string; resolved_by: string | null; resolved_at: string | null;
}

const emptyMemory: WorkspaceMemory = Object.freeze({ instructions: '', memory: '', revision: 0, updatedBy: null, updatedAt: null });
const noteId = /^[A-Za-z0-9_-]{1,64}$/;

function memoryRecord(row: MemoryRow | null | undefined): WorkspaceMemory {
  if (!row) return { ...emptyMemory };
  return { instructions: row.instructions, memory: row.memory, revision: Number(row.revision), updatedBy: row.updated_by, updatedAt: row.updated_at };
}

function noteRecord(row: NoteRow): WorkspaceMemoryNote {
  return {
    id: row.id, sessionId: row.session_id, ...(row.session_title ? { sessionTitle: row.session_title } : {}), authorId: row.author_id, text: row.text,
    status: row.status, createdAt: row.created_at, ...(row.resolved_by ? { resolvedBy: row.resolved_by } : {}), ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
  };
}

export async function workspaceMemory(env: Env, workspaceId: string): Promise<WorkspaceMemory> {
  return memoryRecord(await env.DB.query<MemoryRow>('SELECT instructions, memory, revision, updated_by, updated_at FROM workspace_memory WHERE workspace_id = ?')
    .bind(workspaceId).first());
}

export async function pendingNoteCount(env: Env, workspaceId: string): Promise<number> {
  const row = await env.DB.query<{ n: number }>("SELECT COUNT(*) AS n FROM workspace_memory_notes WHERE workspace_id = ? AND status = 'pending'").bind(workspaceId).first();
  return Number(row?.n ?? 0);
}

export async function pendingNotes(env: Env, workspaceId: string, limit: number = workspaceMemoryLimits.listedNotes): Promise<WorkspaceMemoryNote[]> {
  const rows = await env.DB.query<NoteRow>(`SELECT n.id, n.session_id, s.title AS session_title, n.author_id, n.text, n.status, n.created_at, n.resolved_by, n.resolved_at
    FROM workspace_memory_notes n LEFT JOIN sessions s ON s.id = n.session_id
    WHERE n.workspace_id = ? AND n.status = 'pending' ORDER BY n.created_at, n.id LIMIT ?`).bind(workspaceId, limit).all();
  return rows.map(noteRecord);
}

export async function memoryEnabled(env: Env, workspaceId: string): Promise<boolean> {
  return sessionToolExtensionOn(await workspaceExtensions(env, workspaceId), 'piki:memory');
}

export async function workspaceMemoryPrompt(env: Env, workspaceId: string): Promise<WorkspaceMemoryPrompt | undefined> {
  if (!await memoryEnabled(env, workspaceId)) return undefined;
  const memory = await workspaceMemory(env, workspaceId);
  return { instructions: memory.instructions, memory: memory.memory, revision: memory.revision, pendingNotes: await pendingNoteCount(env, workspaceId) };
}

function noteIds(value: string | readonly string[]): string[] {
  const ids = typeof value === 'string' ? value.split(',').map(item => item.trim()).filter(Boolean) : [...value];
  if (!ids.length || ids.length > workspaceMemoryLimits.resolvedAtOnce || ids.some(item => !noteId.test(item))) {
    fail(400, 'invalid_input', `Name 1 to ${workspaceMemoryLimits.resolvedAtOnce} note ids, as the notes list gives them.`);
  }
  return [...new Set(ids)];
}

async function requireManager(env: Env, workspaceId: string, actorId: string, what: string): Promise<void> {
  const member = await env.DB.query<{ role: string }>('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?').bind(workspaceId, actorId).first();
  if (!member) fail(404, 'not_found', 'Workspace not found.');
  if (!(workspaceManagerRoles as readonly string[]).includes(member.role)) fail(403, 'memory_managers_only', what);
}

interface MemoryChange { instructions?: string; memory?: string }

export async function saveWorkspaceMemory(env: Env, workspaceId: string, actorId: string, change: MemoryChange, revision: number,
  accept: readonly string[] = [], origin: { sessionId?: string; callId?: string } = {}): Promise<{ memory: WorkspaceMemory; accepted: number }> {
  if (change.instructions === undefined && change.memory === undefined && !accept.length) fail(400, 'invalid_input', 'Give memory, instructions or notes to accept.');
  if (change.instructions !== undefined && change.instructions.length > workspaceMemoryLimits.instructionsChars) {
    fail(413, 'memory_too_long', `The instructions are at most ${workspaceMemoryLimits.instructionsChars} characters.`);
  }
  if (change.memory !== undefined && change.memory.length > workspaceMemoryLimits.memoryChars) {
    fail(413, 'memory_too_long', `The memory is at most ${workspaceMemoryLimits.memoryChars} characters: keep what still matters, and drop or shorten the rest.`);
  }
  const at = now();
  const changes = change.instructions !== undefined || change.memory !== undefined;
  let saved: MemoryRow | null = null;
  if (changes && revision === 0) {
    saved = await env.DB.query<MemoryRow>(`INSERT INTO workspace_memory (workspace_id, instructions, memory, revision, updated_by, updated_at)
      SELECT ?, ?, ?, 1, ?, ? WHERE ${workspaceAdminSQL} ON CONFLICT (workspace_id) DO NOTHING
      RETURNING instructions, memory, revision, updated_by, updated_at`)
      .bind(workspaceId, change.instructions ?? '', change.memory ?? '', actorId, at, workspaceId, actorId).first();
  }
  if (changes && !saved) {
    saved = await env.DB.query<MemoryRow>(`UPDATE workspace_memory SET instructions = COALESCE(?, instructions), memory = COALESCE(?, memory),
        revision = revision + 1, updated_by = ?, updated_at = ?
      WHERE workspace_id = ? AND revision = ? AND ${workspaceAdminSQL}
      RETURNING instructions, memory, revision, updated_by, updated_at`)
      .bind(change.instructions ?? null, change.memory ?? null, actorId, at, workspaceId, revision, workspaceId, actorId).first();
  }
  if (changes && !saved) {
    await requireManager(env, workspaceId, actorId, 'Only the workspace\'s owners and admins change its memory and instructions.');
    const current = await workspaceMemory(env, workspaceId);
    fail(409, 'memory_changed', `The memory changed since revision ${revision}: it is at revision ${current.revision}. Read it again, merge your change into it, and save as of revision ${current.revision}.`);
  }
  if (!changes) await requireManager(env, workspaceId, actorId, 'Only the workspace\'s owners and admins accept notes.');
  const accepted = accept.length ? await resolveNotes(env, workspaceId, actorId, accept, 'accepted', at) : 0;
  const memory = saved ? memoryRecord(saved) : await workspaceMemory(env, workspaceId);
  const fields = (['instructions', 'memory'] as const).filter(field => change[field] !== undefined);
  await auditStatement(env, actorId, 'workspace.memory.updated', workspaceId, origin.sessionId ?? null, {
    revision: memory.revision, ...(fields.length ? { fields } : {}), ...(accepted ? { accepted } : {}), ...(origin.callId ? { callId: origin.callId } : {}),
  }).run();
  return { memory, accepted };
}

async function resolveNotes(env: Env, workspaceId: string, actorId: string, ids: readonly string[], status: MemoryNoteResolution, at: string = now()): Promise<number> {
  const marks = ids.map(() => '?').join(', ');
  const rows = await env.DB.query<{ id: string }>(`UPDATE workspace_memory_notes SET status = ?, resolved_by = ?, resolved_at = ?
    WHERE workspace_id = ? AND status = 'pending' AND id IN (${marks}) AND ${workspaceAdminSQL} RETURNING id`)
    .bind(status, actorId, at, workspaceId, ...ids, workspaceId, actorId).all();
  return rows.length;
}

export async function resolveWorkspaceMemoryNotes(env: Env, workspaceId: string, actorId: string, ids: readonly string[], status: MemoryNoteResolution,
  origin: { sessionId?: string; callId?: string } = {}): Promise<number> {
  await requireManager(env, workspaceId, actorId, 'Only the workspace\'s owners and admins accept or dismiss notes.');
  const resolved = await resolveNotes(env, workspaceId, actorId, ids, status);
  await auditStatement(env, actorId, 'workspace.memory.notes_resolved', workspaceId, origin.sessionId ?? null, {
    status, notes: resolved, ...(origin.callId ? { callId: origin.callId } : {}),
  }).run();
  return resolved;
}

export async function addWorkspaceMemoryNote(env: Env, row: Pick<SessionRow, 'id' | 'workspace_id'>, actorId: string, note: string, callId: string): Promise<WorkspaceMemoryNote> {
  const trimmed = note.trim();
  if (!trimmed) fail(400, 'invalid_input', 'The note is empty.');
  if (trimmed.length > workspaceMemoryLimits.noteChars) fail(413, 'memory_note_too_long', `A note is at most ${workspaceMemoryLimits.noteChars} characters.`);
  const noteId = id();
  const at = now();
  const saved = await env.DB.query<NoteRow>(`INSERT INTO workspace_memory_notes (id, workspace_id, session_id, author_id, text, status, created_at)
    SELECT ?, ?, ?, ?, ?, 'pending', ?
    WHERE (SELECT COUNT(*) FROM workspace_memory_notes WHERE workspace_id = ? AND status = 'pending') < ?
    RETURNING id, session_id, NULL AS session_title, author_id, text, status, created_at, resolved_by, resolved_at`)
    .bind(noteId, row.workspace_id, row.id, actorId, trimmed, at, row.workspace_id, workspaceMemoryLimits.pendingNotes).first();
  if (!saved) {
    fail(429, 'memory_notes_full', `${workspaceMemoryLimits.pendingNotes} notes already wait for this workspace's owners and admins. Tell the person, who can ask them to go through the notes.`);
  }
  await auditStatement(env, actorId, 'workspace.memory.noted', row.workspace_id, row.id, { noteId, callId }).run();
  return noteRecord(saved);
}

async function memoryView(env: Env, workspaceId: string, actorId: string): Promise<WorkspaceMemoryView> {
  const member = await requireMember(env, workspaceId, actorId);
  return {
    memory: await workspaceMemory(env, workspaceId), notes: await pendingNotes(env, workspaceId), pendingNotes: await pendingNoteCount(env, workspaceId),
    enabled: await memoryEnabled(env, workspaceId), admin: (workspaceManagerRoles as readonly string[]).includes(member.role),
  };
}

const memorySave = z.strictObject({
  revision: z.number({ error: 'revision is the revision you read.' }).int().min(0),
  instructions: z.string().max(workspaceMemoryLimits.instructionsChars, `The instructions are at most ${workspaceMemoryLimits.instructionsChars} characters.`)
    .refine(value => !value.includes('\0'), 'The instructions contain a NUL character.').optional(),
  memory: z.string().max(workspaceMemoryLimits.memoryChars, `The memory is at most ${workspaceMemoryLimits.memoryChars} characters.`)
    .refine(value => !value.includes('\0'), 'The memory contains a NUL character.').optional(),
  accept: z.array(z.string()).max(workspaceMemoryLimits.resolvedAtOnce).optional(),
});

const notesResolution = z.strictObject({
  notes: z.array(z.string()).min(1).max(workspaceMemoryLimits.resolvedAtOnce),
  status: z.enum(memoryNoteResolutions, { error: `status is one of ${memoryNoteResolutions.join(', ')}.` }),
});

export function registerWorkspaceMemory(app: Hono<AppEnv>): void {
  app.get('/api/workspaces/:id/memory', async c => {
    const workspaceId = identifier(c.req.param('id'));
    return c.json(await memoryView(c.env, workspaceId, c.get('auth').userId));
  });
  app.put('/api/workspaces/:id/memory', async c => {
    const workspaceId = identifier(c.req.param('id'));
    const actor = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    const input = await body(c, memorySave, { maxBytes: (workspaceMemoryLimits.instructionsChars + workspaceMemoryLimits.memoryChars) * 4 + 16 * 1024 });
    await saveWorkspaceMemory(c.env, workspaceId, actor, { instructions: input.instructions, memory: input.memory }, input.revision,
      input.accept?.length ? noteIds(input.accept) : []);
    return c.json(await memoryView(c.env, workspaceId, actor));
  });
  app.post('/api/workspaces/:id/memory/notes', async c => {
    const workspaceId = identifier(c.req.param('id'));
    const actor = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    const input = await body(c, notesResolution, { maxBytes: 16 * 1024 });
    await resolveWorkspaceMemoryNotes(c.env, workspaceId, actor, noteIds(input.notes), input.status);
    return c.json(await memoryView(c.env, workspaceId, actor));
  });
}

const memoryToolRequest = requestShape({
  sessionId: identifierField('sessionId'), actorId: userField('actorId'), admissionId: text('admissionId', 128), callId: identifierField('callId'),
  action: z.enum(memoryToolActions, { error: `action is one of ${memoryToolActions.join(', ')}.` }),
  text: text('text', workspaceMemoryLimits.noteChars).optional(),
  memory: text('memory', workspaceMemoryLimits.memoryChars, 0).optional(),
  instructions: text('instructions', workspaceMemoryLimits.instructionsChars, 0).optional(),
  revision: z.number({ error: 'revision is the revision read returned.' }).int().min(0).optional(),
  accept: text('accept', 64 * 65).optional(),
  notes: text('notes', 64 * 65).optional(),
  status: z.enum(memoryNoteResolutions, { error: `status is one of ${memoryNoteResolutions.join(', ')}.` }).optional(),
}, 'Unexpected memory tool field.', { required: ['sessionId', 'actorId', 'admissionId', 'callId', 'action'] });

type MemoryToolInput = z.output<typeof memoryToolRequest>;
const memoryToolFields = ['text', 'memory', 'instructions', 'revision', 'accept', 'notes', 'status'] as const;

function requireActionFields(input: MemoryToolInput): void {
  const spec = memoryActionFields[input.action as MemoryToolAction];
  const given = memoryToolFields.filter(name => input[name] !== undefined);
  const unexpected = given.find(name => !spec.required.includes(name) && !spec.optional?.includes(name));
  if (unexpected) fail(400, 'invalid_input', `${input.action} takes no ${unexpected}${spec.required.length || spec.optional?.length
    ? `: it takes ${[...spec.required, ...(spec.optional ?? []).map(name => `${name}?`)].join(', ')}` : ''}.`);
  const missing = spec.required.find(name => input[name as keyof MemoryToolInput] === undefined);
  if (missing) fail(400, 'invalid_input', `${input.action} takes ${missing}.`);
}

export async function agentMemory(c: AppContext, connectorId: string | null): Promise<Response> {
  const input = await body(c, memoryToolRequest, { maxBytes: (workspaceMemoryLimits.instructionsChars + workspaceMemoryLimits.memoryChars) * 4 + 64 * 1024 });
  const { sessionId, actorId, admissionId, callId, action } = input;
  requireActionFields(input);
  const access = await sessionAccess(c.env, sessionId, actorId);
  if (!access || access.row.status === 'archived' || !hasPermission(access.permissions, 'write')) {
    fail(403, 'permission_revoked', 'The requester can no longer write to this session.');
  }
  const row = access.row;
  await requireCallbackScope(c, row, connectorId);
  const admission = await requireAdmission(c.env, { admissionId, sessionId, actorId }, { code: 'memory_not_admitted',
    message: 'The memory tool needs a write message from the requester sent within the last hour, or whose run is still going.' });
  await requireToolCall(c.env, row, actorId, 'memory');
  if (!await memoryEnabled(c.env, row.workspace_id)) {
    fail(403, 'memory_off', 'Workspace memory is turned off in this workspace (piki:memory). Its owners and admins add it under Settings → Workspaces → Extensions.');
  }
  if (isMemoryWriteAction(action) && admission.access === 'read') fail(403, 'write_not_allowed', 'A Read-only message changes nothing in the workspace\'s memory: ask in a message that may act.');
  const workspaceId = row.workspace_id;
  const origin = { sessionId: row.id, callId };
  if (action === 'read') {
    const memory = await workspaceMemory(c.env, workspaceId);
    return c.json({ action, memory, pendingNotes: await pendingNoteCount(c.env, workspaceId) });
  }
  if (action === 'notes') return c.json({ action, notes: await pendingNotes(c.env, workspaceId), pendingNotes: await pendingNoteCount(c.env, workspaceId) });
  if (action === 'note') {
    const note = await addWorkspaceMemoryNote(c.env, row, actorId, input.text!, callId);
    return c.json({ action, note, pendingNotes: await pendingNoteCount(c.env, workspaceId) });
  }
  if (action === 'update') {
    await requireManager(c.env, workspaceId, actorId, 'Only the workspace\'s owners and admins change its memory and instructions: propose a note with memory {action: "note", text} instead.');
    const { memory, accepted } = await saveWorkspaceMemory(c.env, workspaceId, actorId, { instructions: input.instructions, memory: input.memory }, input.revision!,
      input.accept !== undefined ? noteIds(input.accept) : [], origin);
    return c.json({ action, memory: { revision: memory.revision, updatedAt: memory.updatedAt }, accepted, pendingNotes: await pendingNoteCount(c.env, workspaceId) });
  }
  const resolved = await resolveWorkspaceMemoryNotes(c.env, workspaceId, actorId, noteIds(input.notes!), input.status!, origin);
  return c.json({ action, status: input.status, resolved, pendingNotes: await pendingNoteCount(c.env, workspaceId) });
}
