import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { RunnerService } from '../apps/runner/src/server.js';
import type { RunnerSession } from '../apps/runner/src/session.js';
import { brokeredArguments } from '../apps/runner/src/defined-tools.js';
import { app } from '../apps/server/src/index.js';
import type { Env } from '../apps/server/src/types.js';
import { workspaceMemoryPrompt as serverMemoryPrompt } from '../apps/server/src/workspace-memory.js';
import { sha256 } from '../packages/shared/src/crypto.js';
import { matchesTerms, searchSnippet, searchTerms } from '../packages/shared/src/cross-session.js';
import { parseWorkspaceExtensionsAnswer, type WorkspaceExtensionsAnswer } from '../packages/shared/src/host-extensions.js';
import { pikiExtension, pikiExtensionOn } from '../packages/shared/src/piki-extensions.js';
import { bundledToolDefinition, bundledToolDefinitions, parseToolDefinition, type BrokeredToolDefinition } from '../packages/shared/src/tool-definitions.js';
import { roleTools } from '../packages/shared/src/tool-groups.js';
import { toolNames, type AuthorizationRequest, type RunnerAction, type RunnerBinding, type RunnerTicket } from '../packages/shared/src/types.js';
import {
  memoryActionFields, memoryToolActions, memoryToolDefinition, parseWorkspaceMemoryPrompt, workspaceMemoryLimits, workspaceMemoryPrompt,
  type WorkspaceMemoryNote, type WorkspaceMemoryView,
} from '../packages/shared/src/workspace-memory.js';
import { seedAgentVersion, testDatabase } from './helpers/control-plane.js';

test('the memory tool is defined as data, switched by piki:memory, off until added, and every role that starts sessions has it', () => {
  const definition = bundledToolDefinition('memory') as BrokeredToolDefinition;
  assert.equal(definition, memoryToolDefinition);
  assert.deepEqual(parseToolDefinition(JSON.parse(JSON.stringify(definition))), definition, 'a connector parses it as it is sent');
  assert.deepEqual([definition.route, definition.extensions], ['memory', ['piki:memory']]);
  assert.deepEqual([...memoryToolActions].sort(), Object.keys(memoryActionFields).sort());
  const extension = pikiExtension('piki:memory');
  assert.deepEqual(extension?.sessionTools, ['memory']);
  assert.equal(pikiExtensionOn(extension!, []), false, 'off where the workspace never added it');
  assert.equal(pikiExtensionOn(extension!, [{ source: 'piki:memory', enabled: true }]), true);
  for (const role of ['owner', 'admin', 'collaborator', 'member'] as const) assert.ok(roleTools[role].includes('memory'), role);
  assert.ok(!roleTools.viewer.includes('memory'));
  assert.deepEqual(brokeredArguments(definition, { action: 'update', revision: 3, memory: '- A', accept: 'n1,n2' }), { action: 'update', revision: 3, memory: '- A', accept: 'n1,n2' });
  assert.throws(() => brokeredArguments(definition, { action: 'forget' }), /action is one of read, notes, note, update, resolve/);
  assert.throws(() => brokeredArguments(definition, { action: 'resolve', notes: 'a b', status: 'accepted' }), /notes is note ids separated by commas/);
  assert.throws(() => brokeredArguments(definition, { action: 'note', text: 'x'.repeat(workspaceMemoryLimits.noteChars + 1) }), /text is a note of at most/);
});

test('the prompt holds the instructions and the memory, says what waits, and points at search; an empty one says nothing', () => {
  const prompt = { instructions: '  Be brief.  ', memory: '- The API is apps/server.', revision: 4, pendingNotes: 2 };
  const all = workspaceMemoryPrompt(prompt, { tool: true, sessions: true });
  assert.match(all, /^Workspace instructions, which this workspace's owners and admins wrote for every session here:\nBe brief\.\n\n/);
  assert.match(all, /Workspace memory \(revision 4\).*trust the files and say so\.\n- The API is apps\/server\./s);
  assert.match(all, /2 proposed notes wait for this workspace's owners and admins \(memory \{action: "notes"\}\)/);
  assert.match(all, /search them with sessions \{action: "search", query\}/);
  const bare = workspaceMemoryPrompt(prompt, { tool: false, sessions: false });
  assert.ok(!/proposed note|sessions \{action/.test(bare), 'without the tools, nothing that needs them');
  assert.equal(workspaceMemoryPrompt({ instructions: '', memory: ' ', revision: 0, pendingNotes: 0 }, { tool: false, sessions: true }), '');
  assert.match(workspaceMemoryPrompt({ instructions: '', memory: '', revision: 0, pendingNotes: 1 }, { tool: true, sessions: false }),
    /^Workspace memory: this workspace's memory is empty so far\.\n\n1 proposed note waits/);
  assert.deepEqual(parseWorkspaceMemoryPrompt({ instructions: 'a', memory: 'b', revision: 1, pendingNotes: 0 }), { instructions: 'a', memory: 'b', revision: 1, pendingNotes: 0 });
  for (const value of [null, [], { instructions: 1, memory: '', revision: 0, pendingNotes: 0 }, { instructions: '', memory: 'x'.repeat(workspaceMemoryLimits.memoryChars + 1), revision: 0, pendingNotes: 0 },
    { instructions: '', memory: '', revision: -1, pendingNotes: 0 }, { instructions: '', memory: 'a\0', revision: 0, pendingNotes: 0 }]) {
    assert.equal(parseWorkspaceMemoryPrompt(value), undefined, JSON.stringify(value));
  }
  const answer = { extensions: [], automaticTools: false };
  assert.deepEqual(parseWorkspaceExtensionsAnswer({ ...answer, memory: { instructions: '', memory: 'm', revision: 2, pendingNotes: 0 } }).memory,
    { instructions: '', memory: 'm', revision: 2, pendingNotes: 0 });
  assert.equal(parseWorkspaceExtensionsAnswer({ ...answer, memory: { memory: 'm' } }).memory, undefined, 'a memory it can\'t read is left out, the rest of the answer kept');
});

test('a search looks for every word, keeps quoted phrases whole, and shows the part of a long message that matched', () => {
  assert.deepEqual(searchTerms('  Postgres  "connection pool"  postgres '), ['connection pool', 'postgres']);
  assert.deepEqual(searchTerms('""'), []);
  assert.equal(matchesTerms('We moved the Connection Pool to PgBouncer for Postgres.', ['connection pool', 'postgres']), true);
  assert.equal(matchesTerms('Only postgres here.', ['connection pool', 'postgres']), false);
  assert.equal(matchesTerms('anything', []), false);
  assert.equal(searchSnippet('short  text\nhere', ['text']), 'short text here');
  const long = `${'a '.repeat(400)}the needle is here ${'b '.repeat(400)}`;
  const snippet = searchSnippet(long, ['needle'], 100);
  assert.ok(snippet.includes('the needle is here') && snippet.startsWith('…') && snippet.endsWith('…') && snippet.length <= 102, snippet);
});

const origin = 'http://localhost:8787';
const testSecret = 'workspace-memory-test-secret-not-for-deployment';

async function fixture(t: TestContext) {
  const { db, sqlite } = await testDatabase();
  t.after(() => db.close());
  const env: Env = { DB: db, APP_ORIGIN: origin, TEST_AUTH_ENABLED: 'true', TEST_AUTH_SECRET: testSecret,
    TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(), RUNNER_SHARED_SECRET: 'workspace-memory-internal-secret-0123456789',
    VAULT_KEY: Buffer.alloc(32, 7).toString('base64url'), RUNNER_URL: 'https://runner.example.test' };
  async function client(name: string) {
    const login = await app.request('/api/auth/test', { method: 'POST', headers: { Origin: origin, Authorization: `Bearer ${testSecret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: name, displayName: name, gitName: name, gitEmail: `${name}@example.test` }) }, env);
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const user = (await login.json() as { user: { id: string } }).user;
    const csrf = (await (await app.request('/api/auth/csrf', { headers: { Cookie: cookie } }, env)).json() as { csrfToken: string }).csrfToken;
    return { user, async request(method: string, path: string, body?: unknown) {
      return app.request(path, { method, headers: { Cookie: cookie, Origin: origin, 'x-csrf-token': csrf,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
    } };
  }
  const owner = await client('wm-owner');
  const admin = await client('wm-admin');
  const member = await client('wm-member');
  const workspace = (await (await owner.request('POST', '/api/workspaces', { name: 'Remembers' })).json() as { workspace: { id: string } }).workspace;
  for (const [person, role] of [[admin, 'admin'], [member, 'member']] as const) {
    assert.equal((await owner.request('POST', `/api/workspaces/${workspace.id}/members`, { userId: person.user.id, role })).status, 200);
  }
  const model = (await (await owner.request('POST', `/api/workspaces/${workspace.id}/models`, { name: 'faux', provider: 'faux', modelId: 'faux-1' })).json() as { model: { id: string } }).model;
  const seed = (id: string, ownerId: string, title: string) => {
    const agent = seedAgentVersion(sqlite, { authorId: ownerId, modelId: model.id, tools: ['identity', 'memory'] });
    sqlite.prepare("INSERT INTO sessions (id,workspace_id,owner_id,agent_version_id,title,status,created_at,visibility,repository_mode) VALUES (?,?,?,?,?,?,?,'workspace','clone')")
      .run(id, workspace.id, ownerId, agent.id, title, 'ready', new Date().toISOString());
  };
  seed('owner-session', owner.user.id, 'Coordinator');
  seed('member-session', member.user.id, 'Fix the login page');
  const admit = (sessionId: string, actorId: string, access?: 'read') => {
    const admission = randomBytes(32).toString('base64url');
    sqlite.prepare('INSERT INTO run_admissions (id,session_id,actor_id,mode,access,auto_merge,request_id,content_hash,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(admission, sessionId, actorId, 'write', access ?? null, 0, `request-${admission}`, 'h'.repeat(43), Math.floor(Date.now() / 1000) + 3600, new Date().toISOString());
    return admission;
  };
  let calls = 0;
  const tool = async (sessionId: string, actorId: string, admissionId: string, body: Record<string, unknown>) => {
    const response = await app.request('/api/internal/memory', { method: 'POST', headers: { Authorization: `Bearer ${env.RUNNER_SHARED_SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, actorId, admissionId, callId: `call-${++calls}`, ...body }) }, env);
    return { status: response.status, body: await response.json() as Record<string, unknown> & { code?: string; error?: string } };
  };
  const ok = async <T = Record<string, unknown>>(result: Promise<{ status: number; body: Record<string, unknown> }>): Promise<T> => {
    const { status, body } = await result;
    assert.equal(status, 200, JSON.stringify(body));
    return body as T;
  };
  const refused = async (result: Promise<{ status: number; body: { code?: string } }>, status: number, code: string) => {
    const { status: actual, body } = await result;
    assert.equal(actual, status, JSON.stringify(body));
    assert.equal(body.code, code, JSON.stringify(body));
  };
  const turn = async (enabled: boolean) => assert.equal((await owner.request('PUT', `/api/workspaces/${workspace.id}/extensions`, { source: 'piki:memory', enabled })).status, 200);
  return { env, sqlite, owner, admin, member, workspace, admit, tool, ok, refused, turn };
}

test('agents propose notes as their message\'s sender, and only owners and admins keep them in the memory, as of the revision they read', async t => {
  const f = await fixture(t);
  const ownerId = f.owner.user.id;
  const memberId = f.member.user.id;
  const byMember = f.admit('member-session', memberId);
  await f.refused(f.tool('member-session', memberId, byMember, { action: 'read' }), 403, 'memory_off');
  assert.equal(await serverMemoryPrompt(f.env, f.workspace.id), undefined, 'hosts get no memory while piki:memory is off');
  await f.turn(true);

  const empty = await f.ok<{ memory: { memory: string; revision: number }; pendingNotes: number }>(f.tool('member-session', memberId, byMember, { action: 'read' }));
  assert.deepEqual([empty.memory.memory, empty.memory.revision, empty.pendingNotes], ['', 0, 0]);
  const noted = await f.ok<{ note: WorkspaceMemoryNote; pendingNotes: number }>(f.tool('member-session', memberId, byMember, { action: 'note', text: '  Login uses the session cookie, not a token.  ' }));
  assert.deepEqual([noted.note.text, noted.note.authorId, noted.note.sessionId, noted.note.status, noted.pendingNotes],
    ['Login uses the session cookie, not a token.', memberId, 'member-session', 'pending', 1]);
  await f.refused(f.tool('member-session', memberId, byMember, { action: 'update', revision: 0, memory: 'mine' }), 403, 'memory_managers_only');
  await f.refused(f.tool('member-session', memberId, byMember, { action: 'resolve', notes: noted.note.id, status: 'dismissed' }), 403, 'memory_managers_only');
  const readOnly = f.admit('member-session', memberId, 'read');
  await f.ok(f.tool('member-session', memberId, readOnly, { action: 'notes' }));
  await f.refused(f.tool('member-session', memberId, readOnly, { action: 'note', text: 'no' }), 403, 'write_not_allowed');
  for (const body of [{ action: 'note' }, { action: 'read', text: 'x' }, { action: 'update', memory: 'x' }, { action: 'resolve', notes: 'a', status: 'kept' },
    { action: 'note', text: 'x'.repeat(workspaceMemoryLimits.noteChars + 1) }, { action: 'read', workspaceId: 'other' }, { action: 'update', revision: -1, memory: 'x' }]) {
    await f.refused(f.tool('member-session', memberId, byMember, body), 400, 'invalid_input');
  }

  const write = f.admit('owner-session', ownerId);
  const waiting = await f.ok<{ notes: WorkspaceMemoryNote[] }>(f.tool('owner-session', ownerId, write, { action: 'notes' }));
  assert.deepEqual(waiting.notes.map(note => [note.id, note.sessionTitle]), [[noted.note.id, 'Fix the login page']]);
  const kept = await f.ok<{ memory: { revision: number }; accepted: number; pendingNotes: number }>(
    f.tool('owner-session', ownerId, write, { action: 'update', revision: 0, memory: '- Login uses the session cookie.', accept: noted.note.id }));
  assert.deepEqual([kept.memory.revision, kept.accepted, kept.pendingNotes], [1, 1, 0]);
  await f.refused(f.tool('owner-session', ownerId, write, { action: 'update', revision: 0, memory: 'stale' }), 409, 'memory_changed');
  await f.refused(f.tool('owner-session', ownerId, write, { action: 'update', revision: 1 }), 400, 'invalid_input');
  const instructed = await f.ok<{ memory: { revision: number } }>(f.tool('owner-session', ownerId, write, { action: 'update', revision: 1, instructions: 'Answer briefly.' }));
  assert.equal(instructed.memory.revision, 2);
  const read = await f.ok<{ memory: { instructions: string; memory: string; revision: number; updatedBy: string } }>(f.tool('member-session', memberId, byMember, { action: 'read' }));
  assert.deepEqual(read.memory, { ...read.memory, instructions: 'Answer briefly.', memory: '- Login uses the session cookie.', revision: 2, updatedBy: ownerId });
  assert.deepEqual(await serverMemoryPrompt(f.env, f.workspace.id), { instructions: 'Answer briefly.', memory: '- Login uses the session cookie.', revision: 2, pendingNotes: 0 });

  const first = await f.ok<{ note: WorkspaceMemoryNote }>(f.tool('member-session', memberId, byMember, { action: 'note', text: 'one' }));
  const second = await f.ok<{ note: WorkspaceMemoryNote }>(f.tool('member-session', memberId, byMember, { action: 'note', text: 'two' }));
  const dismissed = await f.ok<{ resolved: number; pendingNotes: number }>(
    f.tool('owner-session', ownerId, write, { action: 'resolve', notes: `${first.note.id},${second.note.id},${noted.note.id}`, status: 'dismissed' }));
  assert.deepEqual([dismissed.resolved, dismissed.pendingNotes], [2, 0], 'a note already kept stays kept');

  const now = new Date().toISOString();
  const insert = f.sqlite.prepare("INSERT INTO workspace_memory_notes (id, workspace_id, session_id, author_id, text, status, created_at) VALUES (?, ?, NULL, ?, 'n', 'pending', ?)");
  for (let index = 0; index < workspaceMemoryLimits.pendingNotes; index++) insert.run(randomUUID(), f.workspace.id, memberId, now);
  await f.refused(f.tool('member-session', memberId, byMember, { action: 'note', text: 'one too many' }), 429, 'memory_notes_full');

  const audits = f.sqlite.prepare("SELECT action, session_id, detail_json FROM audit WHERE action LIKE 'workspace.memory.%' ORDER BY created_at").all() as
    { action: string; session_id: string | null; detail_json: string }[];
  assert.deepEqual([...new Set(audits.map(row => row.action))].sort(), ['workspace.memory.noted', 'workspace.memory.notes_resolved', 'workspace.memory.updated']);
  assert.ok(audits.every(row => !row.detail_json.includes('Login uses') && !row.detail_json.includes('Answer briefly')), 'the audit records who changed what, never the text');
  const updated = JSON.parse(audits.find(row => row.action === 'workspace.memory.updated')!.detail_json) as Record<string, unknown>;
  assert.match(String(updated.callId), /^call-\d+$/);
  assert.deepEqual(updated, { revision: 1, fields: ['memory'], accepted: 1, callId: updated.callId });
  assert.ok(audits.every(row => row.session_id), 'a change made from a session is recorded with it');

  await f.turn(false);
  await f.refused(f.tool('owner-session', ownerId, write, { action: 'read' }), 403, 'memory_off');
});

test('the settings page shows every member the memory and the notes waiting, and lets owners and admins change them', async t => {
  const f = await fixture(t);
  const path = `/api/workspaces/${f.workspace.id}/memory`;
  const view = async (person: typeof f.owner) => (await person.request('GET', path)).json() as Promise<WorkspaceMemoryView>;
  const initial = await view(f.member);
  assert.deepEqual([initial.memory.revision, initial.enabled, initial.admin, initial.notes], [0, false, false, []]);
  assert.equal((await f.member.request('PUT', path, { revision: 0, memory: 'mine' })).status, 403);
  const saved = await f.admin.request('PUT', path, { revision: 0, instructions: 'Use pnpm.', memory: '- One' });
  assert.equal(saved.status, 200);
  assert.deepEqual(((await saved.json()) as WorkspaceMemoryView).memory, { ...(await view(f.owner)).memory, instructions: 'Use pnpm.', memory: '- One', revision: 1, updatedBy: f.admin.user.id });
  const stale = await f.owner.request('PUT', path, { revision: 0, memory: 'overwrite' });
  assert.equal(stale.status, 409);
  assert.match(((await stale.json()) as { error: string }).error, /it is at revision 1/);
  assert.equal((await f.owner.request('PUT', path, { revision: 1, memory: 'x'.repeat(workspaceMemoryLimits.memoryChars + 1) })).status, 400);
  assert.equal((await f.owner.request('PUT', path, { revision: 1, memory: '- One', extra: true })).status, 400);

  await f.turn(true);
  const byMember = f.admit('member-session', f.member.user.id);
  const note = (await f.ok<{ note: WorkspaceMemoryNote }>(f.tool('member-session', f.member.user.id, byMember, { action: 'note', text: 'Two' }))).note;
  const other = (await f.ok<{ note: WorkspaceMemoryNote }>(f.tool('member-session', f.member.user.id, byMember, { action: 'note', text: 'Three' }))).note;
  const listed = await view(f.member);
  assert.deepEqual([listed.enabled, listed.pendingNotes, listed.notes.map(item => item.text).sort()], [true, 2, ['Three', 'Two']]);
  assert.equal((await f.member.request('POST', `${path}/notes`, { notes: [note.id], status: 'dismissed' })).status, 403);
  const accepted = await f.owner.request('PUT', path, { revision: 1, memory: '- One\n- Two\n', accept: [note.id] });
  assert.equal(accepted.status, 200);
  assert.deepEqual([((await accepted.json()) as WorkspaceMemoryView).notes.map(item => item.id)], [[other.id]]);
  const dismissed = await f.admin.request('POST', `${path}/notes`, { notes: [other.id], status: 'dismissed' });
  assert.equal(dismissed.status, 200);
  const after = (await dismissed.json()) as WorkspaceMemoryView;
  assert.deepEqual([after.pendingNotes, after.memory.memory, after.memory.revision], [0, '- One\n- Two\n', 2]);
  assert.equal((await f.admin.request('POST', `${path}/notes`, { notes: ['bad id'], status: 'accepted' })).status, 400);
  const outsider = await f.owner.request('GET', '/api/workspaces/missing/memory');
  assert.equal(outsider.status, 404);
});

function binding(id: string): RunnerBinding {
  return {
    session: { id, workspaceId: 'workspace', ownerId: 'test:alice', agentVersionId: 'version-1', title: 'Remembers', policyVersion: 1, status: 'ready', createdAt: '2026-01-01T00:00:00Z', repositories: [], repositoryMode: 'clone' },
    owner: { id: 'test:alice', githubId: null, githubLogin: 'alice', displayName: 'Alice', gitName: 'Alice Owner', gitEmail: 'alice@example.test', env: {}, githubConnected: false },
    agent: { id: 'version-1', agentId: 'agent', authorId: 'test:alice', workspaceId: 'workspace', version: 1, name: 'Agent', description: '', instructions: 'Use tools.',
      tools: [...toolNames, 'memory'], modelId: 'model-1', createdAt: '2026-01-01T00:00:00Z' },
    model: { id: 'model-1', workspaceId: 'workspace', name: 'Model', provider: 'faux', modelId: 'faux-1' },
  };
}

async function ticket(id: string, action: RunnerAction): Promise<RunnerTicket> {
  const now = Math.floor(Date.now() / 1000);
  return { aud: 'runner', sessionId: id, actorId: 'test:alice', ownerId: 'test:alice', action, policyVersion: 1, iat: now, exp: now + 60, jti: randomUUID(), bodyHash: await sha256('') };
}

async function idle(session: RunnerSession): Promise<void> {
  for (let count = 0; count < 1000; count++) {
    if (!(await session.view()).busy) return;
    await delay(20);
  }
  assert.fail('runner did not settle');
}

test('each message of a session starts with the workspace\'s memory while piki:memory is on, and its notes go to the control plane\'s memory route',
  { skip: process.platform === 'win32' }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'pikibun-workspace-memory-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const prompts: string[] = [];
  const noting = (reply: ReturnType<typeof fauxAssistantMessage>) => (context: unknown) => {
    prompts.push(JSON.stringify(context));
    return reply;
  };
  const faux = fauxProvider({ models: [{ id: 'faux-1' }] });
  faux.setResponses([
    noting(fauxAssistantMessage('Nothing to remember.')),
    noting(fauxAssistantMessage([fauxToolCall('memory', { action: 'note', text: 'Deploys go through the release workflow.' })], { stopReason: 'toolUse' })),
    fauxAssistantMessage('Noted.'),
  ] as never);
  const models = createModels();
  models.setProvider(faux.provider);
  const memory = { instructions: 'Answer in English.', memory: '- Releases are tagged server-v<version>.', revision: 7, pendingNotes: 1 };
  let answer: WorkspaceExtensionsAnswer = { extensions: [], automaticTools: false, memory };
  const calls: { route: string; request: Record<string, unknown> }[] = [];
  const service = new RunnerService({
    dataDir: directory, sharedSecret: 'runner-workspace-memory-secret-not-for-production', controlPlaneUrl: 'http://127.0.0.1:8787', allowFaux: true, unsandboxed: true,
    authorize: async (input: AuthorizationRequest) => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    extensions: { installed: () => [], workspace: async () => answer },
    toolDefinitions: async () => [...bundledToolDefinitions],
    brokered: async (route, request) => { calls.push({ route, request }); return { action: request.action, pendingNotes: 2 }; },
  });
  await service.initialize();
  t.after(() => service.close());
  const id = 'workspace-memory-session';
  const session = await service.provision(binding(id), await ticket(id, 'create'));
  await session.submit(await ticket(id, 'submit'), { content: 'Anything to know?', requestId: 'first', admissionId: await sha256('memory first') }, 'write');
  await idle(session);
  assert.ok(!prompts[0]!.includes('Releases are tagged'), 'no memory while the workspace hasn\'t added piki:memory');

  answer = { extensions: [{ source: 'piki:memory', enabled: true, tools: 'automatic', settings: {} }], automaticTools: false, memory };
  await session.submit(await ticket(id, 'submit'), { content: 'Remember how we deploy.', requestId: 'second', admissionId: await sha256('memory second') }, 'write');
  await idle(session);
  assert.match(prompts[1]!, /Workspace instructions, which this workspace's owners and admins wrote for every session here:\\nAnswer in English\./);
  assert.match(prompts[1]!, /Workspace memory \(revision 7\)[^"]*\\n- Releases are tagged server-v<version>\./);
  assert.match(prompts[1]!, /1 proposed note waits/);
  assert.match(prompts[1]!, /This workspace keeps a memory across its sessions, with the memory tool/);
  assert.deepEqual(calls.map(call => [call.route, call.request.action, call.request.text]), [['memory', 'note', 'Deploys go through the release workflow.']]);
});
