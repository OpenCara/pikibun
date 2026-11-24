import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { app } from '../apps/server/src/index.js';
import type { Env } from '../apps/server/src/types.js';
import { runCrossSessionNotifications, subSessionInheritsHost } from '../apps/server/src/cross-session.js';
import { sessionSandboxed } from '../apps/server/src/placement.js';
import {
  audienceTarget, crossSessionHeader, crossSessionLimits, messageOutcome, sessionsToolTarget, type CrossSessionMessage, type CrossSessionSummary, type SessionConnections,
} from '../packages/shared/src/cross-session.js';
import type { EntryView, SessionRecord, SessionView } from '../packages/shared/src/types.js';
import { nestSessions } from '../packages/client/src/session-tree.js';
import type { ToolGroupSettings } from '../packages/shared/src/tool-groups.js';
import { fakeHub, seedAgentVersion, testDatabase } from './helpers/control-plane.js';

test('a delivered message names its origin and sender, and its outcome is the answer after it in its own conversation', () => {
  const header = crossSessionHeader({ id: 'm1', kind: 'send', hops: 2 }, { id: 'origin', title: 'Fix [auth]\nnow' }, { id: 'github:1', login: 'alice' });
  assert.equal(header, '[Pikibun cross-session message xs:m1 · from session "Fix auth now" (origin) · sent by @alice through its agent · hop 2]');
  assert.match(crossSessionHeader({ id: 'm1-n', kind: 'notify', hops: 3 }, { id: 'target', title: 'Worker' }, { id: 'test:bob' }, { id: 'm1' }),
    /^\[Pikibun notification xs:m1-n · session "Worker" \(target\) finished message xs:m1 · for test:bob · hop 3\]$/);
  const entry = (id: string, role: string, text: string, conversationId = '0', extra: Partial<EntryView> = {}): EntryView => ({ id, kind: 'message', role, text, conversationId, ...extra });
  const view = {
    entries: [entry('0:1', 'user', 'earlier'), entry('0:2', 'assistant', 'earlier answer'), entry('0:3', 'user', `${header}\n\nDo it`),
      entry('0:4', 'assistant', 'read_file({"path":"a"})'), entry('0:5', 'toolResult', 'contents'), entry('0:6', 'assistant', 'Done: it works.'),
      entry('0:7', 'user', 'a later message'), entry('0:8', 'assistant', 'later answer'), entry('1:9', 'assistant', 'another conversation', '1')],
    queue: [{ submissionId: 'sub-1', actorId: 'github:1', mode: 'write' as const, status: 'running' }], approvals: [],
  };
  const message = { id: 'm1', submissionId: 'sub-1', conversationId: '0' };
  assert.deepEqual(messageOutcome(view, message), { status: 'running', done: false, reply: 'Done: it works.' });
  view.queue[0]!.status = 'settled';
  assert.deepEqual(messageOutcome(view, message), { status: 'settled', done: true, reply: 'Done: it works.' });
  assert.equal(messageOutcome(view, { ...message, id: 'm' }).reply, undefined);
  const older = { entries: view.entries.slice(0, 6), approvals: [] as SessionView['approvals'] };
  assert.deepEqual(messageOutcome(older, message), { status: 'unknown', done: true, reply: 'Done: it works.' });
  assert.equal(messageOutcome({ ...older, entries: view.entries.slice(0, 5) }, message).done, false, 'a tool result last: still at work');
  const long = sessionsToolTarget({ action: 'send', targetSessionId: 'b', message: 'x'.repeat(100_000) });
  assert.ok(long.length < 8192 && long.startsWith('send · session b · message:\n'));
  assert.equal(sessionsToolTarget({ action: 'read', targetSessionId: 'b', messageId: 'm1' }), 'read · session b · message m1');
  assert.equal(sessionsToolTarget({ action: 'search', query: 'connection\npool' }), 'search · query "connection pool"');
});

const origin = 'http://localhost:8787';
const testSecret = 'cross-session-test-secret-not-for-deployment';

type Fake = { view: SessionView; submitted: { mode: string; body: Record<string, unknown> }[]; stopped: number };

async function fixture(t: TestContext) {
  const { db, sqlite } = await testDatabase();
  t.after(() => db.close());
  const env: Env = { DB: db, APP_ORIGIN: origin, TEST_AUTH_ENABLED: 'true', TEST_AUTH_SECRET: testSecret,
    TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(), RUNNER_SHARED_SECRET: 'cross-session-internal-secret-0123456789',
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
  const owner = await client('xs-owner');
  const collaborator = await client('xs-collaborator');
  const workspace = (await (await owner.request('POST', '/api/workspaces', { name: 'cross-session' })).json() as { workspace: { id: string } }).workspace;
  await owner.request('POST', `/api/workspaces/${workspace.id}/members`, { userId: collaborator.user.id, role: 'collaborator' });
  const model = (await (await owner.request('POST', `/api/workspaces/${workspace.id}/models`, { name: 'faux', provider: 'faux', modelId: 'faux-1' })).json() as { model: { id: string } }).model;
  const agent = seedAgentVersion(sqlite, { authorId: owner.user.id, modelId: model.id, tools: ['identity'] });
  const seed = (id: string, title: string) => sqlite.prepare("INSERT INTO sessions (id,workspace_id,owner_id,agent_version_id,title,status,created_at,visibility,repository_mode) VALUES (?,?,?,?,?,?,?,'workspace','clone')")
    .run(id, workspace.id, owner.user.id, agent.id, title, 'ready', new Date().toISOString());
  let links = 0;
  const share = (id: string) => sqlite.prepare('INSERT INTO session_links (session_id,token_hash,token_ciphertext,created_at) VALUES (?,?,?,?)')
    .run(id, String(++links).padStart(43, 'l'), 'ciphertext', new Date().toISOString());
  const unshare = (id: string) => sqlite.prepare('DELETE FROM session_links WHERE session_id = ?').run(id);
  seed('session-a', 'Coordinator');
  seed('session-b', 'Worker');
  const fakes = new Map<string, Fake>();
  const fake = (id: string): Fake => {
    let entry = fakes.get(id);
    if (!entry) fakes.set(id, entry = { submitted: [], stopped: 0, view: { sessionId: id, owner: { id: owner.user.id, displayName: 'xs-owner', gitName: 'xs-owner', gitEmail: 'o@example.test', githubLogin: null },
      entries: [], approvals: [], conversations: [{ id: '0', mode: 'write' }], busy: false, queue: [] } });
    return entry;
  };
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  let submissions = 0;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/sessions') return Response.json({ ok: true }, { status: 201 });
    const match = /^\/v1\/sessions\/([^/]+)\/(view|submit|ask|stop)/.exec(path);
    if (!match) return Response.json({ error: 'offline' }, { status: 503 });
    const session = fake(match[1]!);
    if (match[2] === 'view') return Response.json({ view: session.view });
    if (match[2] === 'stop') { session.stopped++; return Response.json({ stopped: 1 }); }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    session.submitted.push({ mode: match[2]!, body });
    const submissionId = `sub-${++submissions}`;
    const conversationId = match[2] === 'ask' ? `ask-${submissions}` : '0';
    session.view.queue!.push({ submissionId, actorId: 'x', mode: match[2] === 'ask' ? 'ask' : 'write', status: 'queued' });
    session.view.entries.push({ id: `${conversationId}:${submissions}`, kind: 'message', role: 'user', text: String(body.content), conversationId });
    return Response.json({ submissionId, conversationId, status: 'queued' });
  };
  const admit = (sessionId: string, actorId: string, options: { access?: string; requestId?: string; autoMerge?: boolean } = {}) => {
    const issued = options.requestId && sqlite.prepare('SELECT id FROM run_admissions WHERE session_id = ? AND actor_id = ? AND request_id = ?').get(sessionId, actorId, options.requestId);
    if (issued) return String(issued.id);
    const admission = randomBytes(32).toString('base64url');
    sqlite.prepare('INSERT INTO run_admissions (id,session_id,actor_id,mode,access,auto_merge,request_id,content_hash,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(admission, sessionId, actorId, 'write', options.access ?? null, options.autoMerge ? 1 : 0, options.requestId ?? `request-${admission}`, 'h'.repeat(43),
        Math.floor(Date.now() / 1000) + 3600, new Date().toISOString());
    return admission;
  };
  let calls = 0;
  const tool = async (sessionId: string, actorId: string, admissionId: string, body: Record<string, unknown>, callId = `call-${++calls}`) => {
    const response = await app.request('/api/internal/sessions', { method: 'POST', headers: { Authorization: `Bearer ${env.RUNNER_SHARED_SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, actorId, admissionId, callId, ...body }) }, env);
    return { status: response.status, body: await response.json() as Record<string, unknown> & { code?: string } };
  };
  const allow = (sessionId: string, tool: string, callId = '', approvalId = `permission-${callId || 'any'}`) => sqlite.prepare('INSERT INTO session_tool_grants (session_id,tool,call_id,approval_id,granted_by,created_at) VALUES (?,?,?,?,?,?)')
    .run(sessionId, tool, callId, approvalId, owner.user.id, new Date().toISOString());
  const refused = async (result: Promise<{ status: number; body: { code?: string } }>, status: number, code: string) => {
    const { status: actual, body } = await result;
    assert.equal(actual, status, JSON.stringify(body));
    assert.equal(body.code, code, JSON.stringify(body));
  };
  return { env, sqlite, owner, collaborator, workspace, model, agent, fake, admit, tool, allow, refused, seed, share, unshare };
}

const nextView = () => delay(1000);

test('an agent lists and reads the sessions its sender can see, and a read never shows people what they can\'t open', async t => {
  const f = await fixture(t);
  const ownerId = f.owner.user.id;
  const write = f.admit('session-a', ownerId);
  for (const [body, code] of [[{ action: 'read' }, 'invalid_input'], [{ action: 'list', targetSessionId: 'session-b' }, 'invalid_input'],
    [{ action: 'send', targetSessionId: 'session-b' }, 'invalid_input'], [{ action: 'jump' }, 'invalid_input'], [{ action: 'read', targetSessionId: 'session-b', limit: 51 }, 'invalid_input'],
    [{ action: 'ask', targetSessionId: 'session-b', message: 'hi', access: 'auto' }, 'invalid_input'], [{ action: 'create', visibility: 'secret' }, 'invalid_input']] as const) {
    await f.refused(f.tool('session-a', ownerId, write, body), 400, code);
  }
  await f.refused(f.tool('session-a', ownerId, f.admit('session-b', ownerId), { action: 'list' }), 403, 'sessions_not_admitted');
  await f.refused(f.tool('session-a', f.collaborator.user.id, write, { action: 'list' }), 403, 'sessions_not_admitted');

  const listed = await f.tool('session-a', ownerId, write, { action: 'list' });
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  const sessions = listed.body.sessions as CrossSessionSummary[];
  assert.deepEqual(sessions.map(session => [session.id, session.self ?? false]).sort(), [['session-a', true], ['session-b', false]]);
  assert.deepEqual((listed.body.models as { id: string }[]).map(model => model.id), [f.model.id]);

  f.share('session-a');
  const worker = f.fake('session-b');
  worker.view.entries.push({ id: '0:1', kind: 'message', role: 'user', text: 'Build it', conversationId: '0', actorId: ownerId },
    { id: '0:2', kind: 'message', role: 'assistant', text: 'y'.repeat(5000), conversationId: '0' },
    { id: '7:3', kind: 'message', role: 'assistant', text: 'a side answer', conversationId: '7' });
  worker.view.conversations.push({ id: '7', mode: 'ask' });
  const consent = await f.tool('session-a', ownerId, write, { action: 'read', targetSessionId: 'session-b' }, 'read-1');
  assert.deepEqual(consent.body, { consent: 'audience', target: audienceTarget({ id: 'session-b', title: 'Worker' }), reason: 'This session\'s readers include people who can\'t read that session.' });
  assert.equal((await f.collaborator.request('PUT', '/api/sessions/session-a/audience-sharing', { enabled: true })).status, 403, 'only its owner lets content through');
  assert.equal((await f.owner.request('PUT', '/api/sessions/session-a/audience-sharing', { enabled: true })).status, 200);
  assert.equal(((await (await f.owner.request('GET', '/api/sessions/session-a')).json()) as { session: SessionRecord }).session.audienceSharing, true);
  const read = await f.tool('session-a', ownerId, write, { action: 'read', targetSessionId: 'session-b' }, 'read-1');
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.ok(!('consent' in read.body), JSON.stringify(read.body));
  const entries = read.body.entries as EntryView[];
  assert.deepEqual(entries.map(entry => entry.id), ['0:1', '0:2'], 'the shared conversation only');
  assert.ok(entries[1]!.text.length < 2100 && entries[1]!.text.endsWith('3000 more characters'));
  assert.equal((await f.owner.request('PUT', '/api/sessions/session-a/audience-sharing', { enabled: false })).status, 200);
  assert.ok('consent' in (await f.tool('session-a', ownerId, write, { action: 'read', targetSessionId: 'session-b' }, 'read-2')).body);
  f.unshare('session-a');
  assert.equal((await f.tool('session-a', ownerId, write, { action: 'read', targetSessionId: 'session-b', limit: 1 })).status, 200);

  await f.refused(f.tool('session-a', ownerId, write, { action: 'read', targetSessionId: 'session-a' }), 409, 'same_session');
  await f.refused(f.tool('session-a', ownerId, write, { action: 'read', targetSessionId: 'missing' }), 404, 'not_found');
});

test('messages go out as their sender, named, recorded and bounded: access, busy sessions, hops, loops and the per-message limit', async t => {
  const f = await fixture(t);
  const ownerId = f.owner.user.id;
  f.allow('session-a', 'sessions');
  f.allow('session-b', 'sessions');
  const write = f.admit('session-a', ownerId);
  const worker = f.fake('session-b');

  const sent = await f.tool('session-a', ownerId, write, { action: 'send', targetSessionId: 'session-b', message: 'Run the tests' }, 'send-1');
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  const message = sent.body.message as CrossSessionMessage;
  assert.deepEqual([message.kind, message.originSessionId, message.targetSessionId, message.actorId, message.hops, message.access, message.notify],
    ['send', 'session-a', 'session-b', ownerId, 1, 'auto', undefined]);
  const delivered = worker.submitted.at(-1)!;
  assert.equal(delivered.mode, 'submit');
  assert.equal(delivered.body.requestId, `xs:${message.id}`);
  assert.equal(delivered.body.content, `[Pikibun cross-session message xs:${message.id} · from session "Coordinator" (session-a) · sent by test:xs-owner through its agent · hop 1]\n\nRun the tests`);
  assert.equal(delivered.body.options, undefined, 'a message that acts, the default, sends no options');
  const audits = f.sqlite.prepare("SELECT action, session_id, actor_id, detail_json FROM audit WHERE action IN ('session.submit', 'session.cross_session.sent') ORDER BY rowid").all();
  assert.deepEqual(audits.map(row => [row.action, row.session_id, row.actor_id]), [['session.submit', 'session-b', ownerId], ['session.cross_session.sent', 'session-a', ownerId]]);
  assert.equal((JSON.parse(String(audits[0]!.detail_json)) as { crossSession: string }).crossSession, message.id);

  worker.view.entries.push({ id: '0:90', kind: 'message', role: 'assistant', text: 'All 12 tests pass.', conversationId: '0' });
  worker.view.queue!.find(item => item.submissionId === message.submissionId)!.status = 'settled';
  await nextView();
  const outcome = await f.tool('session-a', ownerId, write, { action: 'read', targetSessionId: 'session-b', messageId: message.id, limit: 1 });
  assert.deepEqual(outcome.body.outcome, { status: 'settled', done: true, reply: 'All 12 tests pass.' });
  await f.refused(f.tool('session-a', ownerId, write, { action: 'read', targetSessionId: 'session-b', messageId: 'unknown' }), 404, 'not_found');

  f.sqlite.prepare("UPDATE sessions SET activity = 'working' WHERE id = 'session-b'").run();
  await f.refused(f.tool('session-a', ownerId, write, { action: 'send', targetSessionId: 'session-b', message: 'More' }), 409, 'session_busy');
  const asked = await f.tool('session-a', ownerId, write, { action: 'ask', targetSessionId: 'session-b', message: 'How far along?' });
  assert.equal(asked.status, 202, JSON.stringify(asked.body));
  assert.equal(worker.submitted.at(-1)!.mode, 'ask');
  f.sqlite.prepare("UPDATE sessions SET activity = 'done' WHERE id = 'session-b'").run();

  const readOnly = f.admit('session-a', ownerId, { access: 'read' });
  await f.refused(f.tool('session-a', ownerId, readOnly, { action: 'send', targetSessionId: 'session-b', message: 'Go' }), 403, 'write_not_allowed');
  await f.refused(f.tool('session-a', ownerId, readOnly, { action: 'stop', targetSessionId: 'session-b' }), 403, 'write_not_allowed');
  assert.equal((await f.tool('session-a', ownerId, readOnly, { action: 'ask', targetSessionId: 'session-b', message: 'Status?' })).status, 202);
  f.allow('session-a', 'sessions:write');
  await f.refused(f.tool('session-a', ownerId, readOnly, { action: 'send', targetSessionId: 'session-b', message: 'Go' }), 403, 'write_not_allowed');

  const inWorker = f.admit('session-b', ownerId, { requestId: `xs:${message.id}` });
  await f.refused(f.tool('session-b', ownerId, inWorker, { action: 'send', targetSessionId: 'session-a', message: 'Back to you' }), 409, 'session_loop');
  f.seed('session-c', 'Third');
  const onward = await f.tool('session-b', ownerId, inWorker, { action: 'send', targetSessionId: 'session-c', message: 'Pass it on' });
  assert.equal(onward.status, 202, JSON.stringify(onward.body));
  const second = onward.body.message as CrossSessionMessage;
  assert.equal(second.hops, 2);
  assert.match(String(f.fake('session-c').submitted.at(-1)!.body.content), /from session "Worker" \(session-b\) · sent by test:xs-owner through its agent · hop 2\]/);
  f.allow('session-c', 'sessions');
  const inThird = f.admit('session-c', ownerId, { requestId: `xs:${second.id}` });
  for (const back of ['session-a', 'session-b']) await f.refused(f.tool('session-c', ownerId, inThird, { action: 'send', targetSessionId: back, message: 'loop' }), 409, 'session_loop');
  f.sqlite.prepare('UPDATE session_messages SET hops = ? WHERE id = ?').run(crossSessionLimits.maxHops, second.id);
  f.seed('session-d', 'Fourth');
  await f.refused(f.tool('session-c', ownerId, inThird, { action: 'send', targetSessionId: 'session-d', message: 'further' }), 403, 'hop_limit');
  await f.refused(f.tool('session-c', ownerId, inThird, { action: 'create', message: 'further' }), 403, 'hop_limit');
  assert.equal((await f.tool('session-c', ownerId, inThird, { action: 'read', targetSessionId: 'session-d' })).status, 200);
  await f.refused(f.tool('session-a', ownerId, f.admit('session-a', ownerId, { requestId: 'xs:made-up' }), { action: 'send', targetSessionId: 'session-d', message: 'x' }), 403, 'hop_limit');

  const busy = f.admit('session-a', ownerId);
  const burst = await Promise.all(Array.from({ length: crossSessionLimits.perMessage + 3 }, (_, index) =>
    f.tool('session-a', ownerId, busy, { action: 'ask', targetSessionId: 'session-d', message: `q${index}` })));
  assert.equal(burst.filter(result => result.status === 202).length, crossSessionLimits.perMessage);
  assert.deepEqual([...new Set(burst.filter(result => result.status !== 202).map(result => result.body.code))], ['cross_session_limit']);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM session_messages WHERE origin_admission_id = ?").get(busy)!.n, crossSessionLimits.perMessage);
  const refusedOnce = f.admit('session-a', ownerId);
  f.sqlite.prepare("UPDATE sessions SET activity = 'working' WHERE id = 'session-d'").run();
  await f.refused(f.tool('session-a', ownerId, refusedOnce, { action: 'send', targetSessionId: 'session-d', message: 'busy' }), 409, 'session_busy');
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM session_messages WHERE origin_admission_id = ?").get(refusedOnce)!.n, 0);
  f.sqlite.prepare("UPDATE sessions SET activity = NULL WHERE id = 'session-d'").run();

  const theirs = f.admit('session-a', f.collaborator.user.id);
  const theirSend = await f.tool('session-a', f.collaborator.user.id, theirs, { action: 'send', targetSessionId: 'session-b', message: 'hi' });
  assert.equal(theirSend.status, 202, JSON.stringify(theirSend.body));
  assert.equal((theirSend.body.message as CrossSessionMessage).actorId, f.collaborator.user.id, 'a collaborator messages every session of the workspace, as themself');
  const started = await f.tool('session-a', f.collaborator.user.id, theirs, { action: 'create', title: 'Their sub-task' });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.deepEqual([(started.body.session as CrossSessionSummary).ownerId, (started.body.session as CrossSessionSummary).parentSessionId], [f.collaborator.user.id, 'session-a']);
});

test('an agent stops and archives sessions as its sender may, and starts linked sessions every member sees', async t => {
  const f = await fixture(t);
  const ownerId = f.owner.user.id;
  f.allow('session-a', 'sessions');
  const write = f.admit('session-a', ownerId);
  const stopped = await f.tool('session-a', ownerId, write, { action: 'stop', targetSessionId: 'session-b' });
  assert.deepEqual([stopped.status, stopped.body], [200, { stopped: 1 }]);
  assert.equal(f.fake('session-b').stopped, 1);

  const readOnly = f.admit('session-a', ownerId, { access: 'read' });
  const spaced = { action: 'create', title: '  Spaced title  ' } as const;
  await f.refused(f.tool('session-a', ownerId, readOnly, spaced, 'create-1'), 403, 'write_not_allowed');
  const spacedChild = await f.tool('session-a', ownerId, write, spaced, 'create-2');
  assert.equal(spacedChild.status, 201, JSON.stringify(spacedChild.body));
  assert.equal((spacedChild.body.session as CrossSessionSummary).title, 'Spaced title');

  const sessions = () => f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n;
  const sessionsBefore = sessions();
  await f.refused(f.tool('session-a', ownerId, write, { action: 'create', title: 'Kept to myself', message: 'Document the API', visibility: 'private' }), 400, 'private_session_unavailable');
  assert.equal(sessions(), sessionsBefore, 'a private session asked for in a shared workspace is refused, not made visible');
  const created = await f.tool('session-a', ownerId, write, { action: 'create', title: 'Write the docs', message: 'Document the API', notify: true, visibility: 'workspace' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const child = created.body.session as CrossSessionSummary;
  const opening = created.body.message as CrossSessionMessage;
  assert.deepEqual([child.title, child.parentSessionId, child.ownerId, child.status], ['Write the docs', 'session-a', ownerId, 'ready']);
  assert.equal((await f.collaborator.request('GET', `/api/sessions/${child.id}`)).status, 200, 'every member sees the new session');
  assert.deepEqual([opening.kind, opening.targetSessionId, opening.notify], ['create', child.id, 'pending']);
  assert.match(String(f.fake(child.id).submitted[0]!.body.content), /^\[Pikibun cross-session opening message xs:\S+ · from session "Coordinator"/);
  const record = (await (await f.owner.request('GET', `/api/sessions/${child.id}`)).json() as { session: SessionRecord }).session;
  assert.equal(record.parentSessionId, 'session-a');
  const connections = await (await f.owner.request('GET', '/api/sessions/session-a/connections')).json() as SessionConnections;
  assert.deepEqual(connections.children.map(item => item.id).sort(), [child.id, (spacedChild.body.session as CrossSessionSummary).id].sort());
  assert.deepEqual(connections.messages.map(item => [item.id, item.otherTitle]), [[opening.id, 'Write the docs']]);
  const fromChild = await (await f.owner.request('GET', `/api/sessions/${child.id}/connections`)).json() as SessionConnections;
  assert.equal(fromChild.parent?.id, 'session-a');

  await f.refused(f.tool('session-a', ownerId, write, { action: 'archive', targetSessionId: 'session-a' }), 409, 'same_session');
  const archived = await f.tool('session-a', ownerId, write, { action: 'archive', targetSessionId: child.id });
  assert.deepEqual([archived.status, archived.body], [200, { archived: child.id }]);
  assert.equal(f.sqlite.prepare('SELECT status FROM sessions WHERE id = ?').get(child.id)!.status, 'archived');
  const actions = f.sqlite.prepare("SELECT action FROM audit WHERE action LIKE 'session.cross_session.%' ORDER BY rowid").all().map(row => row.action);
  assert.deepEqual(actions, ['session.cross_session.stopped', 'session.cross_session.created', 'session.cross_session.created', 'session.cross_session.sent', 'session.cross_session.archived']);

  f.share('session-a');
  const before = f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n;
  const consent = await f.tool('session-a', ownerId, write, { action: 'create', title: 'Secret', message: 'Look', notify: true });
  assert.equal(consent.body.consent, 'audience', JSON.stringify(consent.body));
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, before);

  f.sqlite.prepare("UPDATE sessions SET parent_session_id = 'session-a' WHERE id = 'session-b'").run();
  for (let index = 3; index < crossSessionLimits.children; index++) {
    f.seed(`filler-${index}`, 'filler');
    f.sqlite.prepare("UPDATE sessions SET parent_session_id = 'session-a' WHERE id = ?").run(`filler-${index}`);
  }
  await f.refused(f.tool('session-a', ownerId, f.admit('session-a', ownerId), { action: 'create' }), 429, 'cross_session_limit');
});

test('every member reads every session of the workspace, so content passes between them without asking', async t => {
  const f = await fixture(t);
  const now = new Date().toISOString();
  const memberId = 'test:xs-member'; const adminId = 'test:xs-admin';
  for (const [id, role] of [[memberId, 'member'], [adminId, 'admin']] as const) {
    f.sqlite.prepare("INSERT INTO users (id,display_name,git_name,git_email,env_json,auth_kind,created_at) VALUES (?,?,?,?,'{}','test',?)").run(id, id, id, `${id}@example.test`, now);
    f.sqlite.prepare('INSERT INTO workspace_members (workspace_id,user_id,role,created_at) VALUES (?,?,?,?)').run(f.workspace.id, id, role, now);
  }
  const own = (id: string, ownerId: string) => {
    f.sqlite.prepare("INSERT INTO sessions (id,workspace_id,owner_id,agent_version_id,title,status,created_at,visibility,repository_mode) VALUES (?,?,?,?,?,'ready',?,'workspace','clone')")
      .run(id, f.workspace.id, ownerId, f.agent.id, id, now);
    f.fake(id).view.owner = { id: ownerId, displayName: ownerId, gitName: ownerId, gitEmail: `${ownerId}@example.test`, githubLogin: null };
    f.allow(id, 'sessions');
  };
  own('member-session', memberId);
  own('admin-session', adminId);

  const adminWrite = f.admit('admin-session', adminId);
  const listed = await f.tool('admin-session', adminId, adminWrite, { action: 'list' });
  assert.deepEqual((listed.body.sessions as CrossSessionSummary[]).find(item => item.id === 'member-session')?.permissions, ['read', 'ask', 'write', 'manage']);
  const read = await f.tool('admin-session', adminId, adminWrite, { action: 'read', targetSessionId: 'member-session' });
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.ok(!('consent' in read.body), JSON.stringify(read.body));
  const delivered = await f.tool('admin-session', adminId, adminWrite, { action: 'send', targetSessionId: 'member-session', message: 'Look at this' });
  assert.equal(delivered.status, 202, JSON.stringify(delivered.body));
  assert.equal(f.fake('member-session').submitted.length, 1);
  assert.equal(f.sqlite.prepare("SELECT actor_id FROM run_admissions WHERE session_id = 'member-session' AND request_id LIKE 'xs:%'").get()!.actor_id, adminId);

  const memberWrite = f.admit('member-session', memberId);
  await f.refused(f.tool('member-session', memberId, memberWrite, { action: 'list' }), 403, 'tool_not_in_group');
  const grouped = await (await f.owner.request('POST', `/api/workspaces/${f.workspace.id}/tool-groups`, { name: 'Coordinators', tools: ['read_file', 'sessions'] })).json() as ToolGroupSettings;
  const coordinators = grouped.groups.find(group => group.name === 'Coordinators')!;
  assert.equal((await f.owner.request('PUT', `/api/workspaces/${f.workspace.id}/members/${memberId}/tool-group`, { groupId: coordinators.id })).status, 200);
  const memberRead = await f.tool('member-session', memberId, memberWrite, { action: 'read', targetSessionId: 'admin-session' });
  assert.equal(memberRead.status, 200, JSON.stringify(memberRead.body));
  assert.ok(!('consent' in memberRead.body), JSON.stringify(memberRead.body));
  const created = await f.tool('member-session', memberId, memberWrite, { action: 'create', title: 'Sub-task', message: 'Do it', notify: true });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const child = created.body.session as CrossSessionSummary;
  assert.deepEqual([child.ownerId, child.parentSessionId], [memberId, 'member-session']);
});

test('a notification brings a finished message\'s outcome back to its origin, once, while the origin is idle', async t => {
  const f = await fixture(t);
  const ownerId = f.owner.user.id;
  f.allow('session-a', 'sessions');
  const write = f.admit('session-a', ownerId);
  const sent = await f.tool('session-a', ownerId, write, { action: 'send', targetSessionId: 'session-b', message: 'Fix the flaky test', notify: true });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  const message = sent.body.message as CrossSessionMessage;
  assert.equal(message.notify, 'pending');
  const coordinator = f.fake('session-a');
  const worker = f.fake('session-b');

  assert.deepEqual(await runCrossSessionNotifications(f.env), [{ messageId: message.id, waiting: 'target_working' }]);
  assert.equal(coordinator.submitted.length, 0);
  worker.view.entries.push({ id: '0:50', kind: 'message', role: 'assistant', text: 'Fixed: the test waited on a timer.', conversationId: '0' });
  worker.view.queue![0]!.status = 'settled';
  await nextView();
  f.sqlite.prepare("UPDATE sessions SET activity = 'working' WHERE id = 'session-a'").run();
  assert.deepEqual(await runCrossSessionNotifications(f.env), [{ messageId: message.id, waiting: 'session_busy' }]);
  f.sqlite.prepare("UPDATE sessions SET activity = 'done' WHERE id = 'session-a'").run();
  assert.deepEqual(await runCrossSessionNotifications(f.env), [{ messageId: message.id, delivered: `${message.id}-n` }]);
  assert.equal(coordinator.submitted.length, 1);
  assert.equal(coordinator.submitted[0]!.body.requestId, `xs:${message.id}-n`);
  assert.equal(coordinator.submitted[0]!.body.content, `[Pikibun notification xs:${message.id}-n · session "Worker" (session-b) finished message xs:${message.id} · for test:xs-owner · hop 2]`
    + '\n\nIts message ended: settled.\n\nIts reply:\n\nFixed: the test waited on a timer.');
  assert.deepEqual(await runCrossSessionNotifications(f.env), [], 'once');
  const row = f.sqlite.prepare('SELECT notify_status, notify_message_id FROM session_messages WHERE id = ?').get(message.id)!;
  assert.deepEqual([row.notify_status, row.notify_message_id], ['delivered', `${message.id}-n`]);
  const notification = f.sqlite.prepare('SELECT kind, origin_session_id, target_session_id, hops, reply_to FROM session_messages WHERE id = ?').get(`${message.id}-n`)!;
  assert.deepEqual({ ...notification }, { kind: 'notify', origin_session_id: 'session-b', target_session_id: 'session-a', hops: 2, reply_to: message.id });

  const followUp = f.admit('session-a', ownerId, { requestId: `xs:${message.id}-n` });
  const again = await f.tool('session-a', ownerId, followUp, { action: 'ask', targetSessionId: 'session-b', message: 'Which timer?' });
  assert.equal(again.status, 202, JSON.stringify(again.body));
  assert.equal((again.body.message as CrossSessionMessage).hops, 3);

  const pending = await f.tool('session-a', ownerId, write, { action: 'ask', targetSessionId: 'session-b', message: 'Anything else?', notify: true });
  const later = (pending.body.message as CrossSessionMessage).id;
  f.sqlite.prepare("UPDATE session_messages SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 25 * 3600_000).toISOString(), later);
  assert.deepEqual(await runCrossSessionNotifications(f.env), [{ messageId: later, failed: 'expired' }]);
});

test('a session an agent starts, messages or notifies acts, unless the agent chose Read only or its own message was', async t => {
  const f = await fixture(t);
  const ownerId = f.owner.user.id;
  const at = new Date().toISOString();
  const capabilities = { platform: 'linux', sandbox: true, productionShell: true, approvalFree: true, chatOptions: true, plainGit: true };
  f.sqlite.prepare('INSERT INTO connectors (id, owner_id, name, credential_hash, connection_hash, capabilities_json, models_json, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('sandbox-host', ownerId, 'Sandbox', 'h'.repeat(43), 'c'.repeat(43), JSON.stringify(capabilities), JSON.stringify([{ provider: 'faux', modelId: 'faux-3', name: 'Faux 3' }]), at);
  f.sqlite.prepare('INSERT INTO connector_workspaces (connector_id, workspace_id, created_at) VALUES (?,?,?)').run('sandbox-host', f.workspace.id, at);
  f.sqlite.prepare('INSERT INTO models (id, workspace_id, name, provider, model_id, created_at, connector_id, connector_owner_id) VALUES (?,?,?,?,?,?,?,?)')
    .run('hosted-model', f.workspace.id, 'Faux 3', 'faux', 'faux-3', at, 'sandbox-host', ownerId);
  const submits: { sessionId: string; body: Record<string, unknown> }[] = [];
  f.env.CONNECTOR_HUB = fakeHub({ rpc(_connectorId, envelope) {
    const { action, sessionId } = envelope.request.ticket;
    if (action === 'create') return Response.json({ ok: true }, { status: 201 });
    if (action === 'view') return Response.json({ view: { ...f.fake(sessionId).view, sessionId } });
    if (action === 'submit') {
      const body = JSON.parse(envelope.request.body) as Record<string, unknown>;
      submits.push({ sessionId, body });
      const submissionId = `hosted-${submits.length}`;
      f.fake(sessionId).view.queue!.push({ submissionId, actorId: ownerId, mode: 'write', status: 'queued' });
      return Response.json({ submissionId, conversationId: '0', status: 'queued' });
    }
    return Response.json({ error: 'unexpected' }, { status: 503 });
  } });
  const last = () => submits.at(-1)!;
  const sentAccess = () => (last().body.options as { access?: string } | undefined)?.access;

  const write = f.admit('session-a', ownerId, { access: 'auto', autoMerge: true });
  const started = await f.tool('session-a', ownerId, write, { action: 'create', title: 'Worker', modelId: 'hosted-model', message: 'Build it' });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const worker = (started.body.session as CrossSessionSummary).id;
  assert.equal((started.body.message as CrossSessionMessage).access, 'auto');
  assert.equal(sentAccess(), undefined, 'a message that acts names no access');

  const chosen = await f.tool('session-a', ownerId, write, { action: 'send', targetSessionId: worker, message: 'Only look', access: 'read' });
  assert.equal(chosen.status, 202, JSON.stringify(chosen.body));
  assert.equal((chosen.body.message as CrossSessionMessage).access, 'read', 'Read only, the agent\'s choice, stands');
  assert.equal(sentAccess(), 'read');

  const inWorker = f.admit(worker, ownerId);
  const message = { id: 'review-1', submissionId: 'review-sub' };
  f.sqlite.prepare(`INSERT INTO session_messages (id, workspace_id, origin_session_id, target_session_id, actor_id, kind, origin_admission_id, origin_call_id,
      submission_id, conversation_id, hops, chain_json, access, notify_status, created_at, updated_at) VALUES (?,?,?,?,?,'send',?,'call-review',?,'0',1,?,'auto','pending',?,?)`)
    .run(message.id, f.workspace.id, worker, 'session-b', ownerId, inWorker, message.submissionId, JSON.stringify([worker]), at, at);
  const reviewer = f.fake('session-b');
  reviewer.view.entries.push({ id: '0:69', kind: 'message', role: 'user', text: `[Pikibun cross-session message xs:${message.id} · …]\n\nReview it`, conversationId: '0' },
    { id: '0:70', kind: 'message', role: 'assistant', text: 'Looks good.', conversationId: '0' });
  reviewer.view.queue!.push({ submissionId: message.submissionId, actorId: ownerId, mode: 'write', status: 'settled' });
  await nextView();
  assert.deepEqual(await runCrossSessionNotifications(f.env), [{ messageId: message.id, delivered: `${message.id}-n` }]);
  assert.equal(last().sessionId, worker);
  assert.equal(last().body.requestId, `xs:${message.id}-n`);
  assert.equal(sentAccess(), undefined, 'its outcome comes back acting, as the message that sent it did');

  const reading = f.admit(worker, ownerId, { access: 'read' });
  const asked = { id: 'side-1', submissionId: 'side-sub' };
  f.sqlite.prepare(`INSERT INTO session_messages (id, workspace_id, origin_session_id, target_session_id, actor_id, kind, origin_admission_id, origin_call_id,
      submission_id, conversation_id, hops, chain_json, notify_status, created_at, updated_at) VALUES (?,?,?,?,?,'ask',?,'call-side',?,'7',1,?,'pending',?,?)`)
    .run(asked.id, f.workspace.id, worker, 'session-b', ownerId, reading, asked.submissionId, JSON.stringify([worker]), at, at);
  reviewer.view.conversations.push({ id: '7', mode: 'ask' });
  reviewer.view.entries.push({ id: '7:80', kind: 'message', role: 'user', text: `[Pikibun cross-session side ask xs:${asked.id} \u00b7 \u2026]\n\nHow?`, conversationId: '7' },
    { id: '7:81', kind: 'message', role: 'assistant', text: 'Like this.', conversationId: '7' });
  reviewer.view.queue!.push({ submissionId: asked.submissionId, actorId: ownerId, mode: 'ask', status: 'settled' });
  await nextView();
  assert.deepEqual(await runCrossSessionNotifications(f.env), [{ messageId: asked.id, delivered: `${asked.id}-n` }]);
  assert.equal(last().body.requestId, `xs:${asked.id}-n`);
  assert.equal(sentAccess(), 'read', 'the answer to a Read-only message\'s question comes back Read only');
});


test('placement starts a sub-task on the least loaded host that meets its conditions, among hosts the agent may start sessions on', async t => {
  const f = await fixture(t);
  const ownerId = f.owner.user.id;
  const collaboratorId = f.collaborator.user.id;
  const GiB = 1024 ** 3;
  const at = new Date().toISOString();
  const machine = (cpus: number, memoryGb: number, freeGb: number, load: number, gpus: unknown[] = []) => JSON.stringify({ platform: 'linux', release: '6.8.0', arch: 'x64',
    cpuModel: 'Fixture CPU', cpus, memoryBytes: memoryGb * GiB, freeMemoryBytes: freeGb * GiB, diskBytes: 500 * GiB, freeDiskBytes: 200 * GiB, load: [load, load, load], gpus });
  const nvidia = [{ vendor: 'nvidia', name: 'Fixture RTX', memoryBytes: 24 * GiB }];
  const host = (id: string, owner: string, hardware: string | null, capabilities: Record<string, unknown> = {}, models = [{ provider: 'faux', modelId: 'faux-9', name: 'Faux 9', thinkingLevels: ['off', 'low'] }]) => {
    f.sqlite.prepare('INSERT INTO connectors (id, owner_id, name, credential_hash, connection_hash, capabilities_json, models_json, created_at, hardware_json, hardware_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, owner, `Host ${id}`, id.padEnd(43, 'h'), id.padEnd(43, 'c'), JSON.stringify({ platform: 'linux', sandbox: true, productionShell: true, approvalFree: true, chatOptions: true, plainGit: true, ...capabilities }),
        JSON.stringify(models), at, hardware, hardware ? at : null);
    f.sqlite.prepare('INSERT INTO connector_workspaces (connector_id, workspace_id, created_at) VALUES (?,?,?)').run(id, f.workspace.id, at);
    for (const model of models) {
      f.sqlite.prepare('INSERT INTO models (id, workspace_id, name, provider, model_id, created_at, connector_id, connector_owner_id) VALUES (?,?,?,?,?,?,?,?)')
        .run(`${id}-${model.modelId}`, f.workspace.id, model.name, model.provider, model.modelId, at, id, owner);
    }
  };
  host('gpu-host', ownerId, machine(32, 64, 40, 2, nvidia), { gpu: 'render' });
  f.sqlite.prepare('INSERT INTO connector_configs (connector_id, gpu, updated_at) VALUES (?,?,?)').run('gpu-host', 1, at);
  host('unlent-gpu-host', ownerId, machine(64, 256, 200, 0, nvidia), { gpu: 'render' });
  host('busy-host', ownerId, machine(8, 16, 8, 1));
  host('idle-host', ownerId, null, {}, [{ provider: 'faux', modelId: 'faux-9', name: 'Faux 9', thinkingLevels: ['off', 'low'] }, { provider: 'other', modelId: 'big-1', name: 'Big', thinkingLevels: ['off'] }]);
  host('offline-host', ownerId, machine(128, 512, 500, 0));
  host('teammate-host', collaboratorId, machine(128, 512, 500, 0, nvidia), { gpu: 'render' });
  f.sqlite.prepare('INSERT INTO connector_shares (connector_id, workspace_id, created_at) VALUES (?,?,?)').run('teammate-host', f.workspace.id, at);
  f.sqlite.prepare('INSERT INTO connector_configs (connector_id, gpu, updated_at) VALUES (?,?,?)').run('teammate-host', 1, at);
  for (const id of ['busy-1', 'busy-2']) {
    f.sqlite.prepare("INSERT INTO sessions (id,workspace_id,owner_id,agent_version_id,title,status,created_at,visibility,repository_mode,connector_id,connector_owner_id,activity) VALUES (?,?,?,?,?,?,?,'workspace','clone',?,?,?)")
      .run(id, f.workspace.id, ownerId, f.agent.id, id, 'ready', at, 'busy-host', ownerId, 'working');
  }
  const parentAgent = seedAgentVersion(f.sqlite, { authorId: ownerId, modelId: 'busy-host-faux-9', tools: ['identity'] });
  f.sqlite.prepare("INSERT INTO sessions (id,workspace_id,owner_id,agent_version_id,title,status,created_at,visibility,repository_mode) VALUES (?,?,?,?,?,?,?,'workspace','clone')")
    .run('session-p', f.workspace.id, ownerId, parentAgent.id, 'Planner', 'ready', at);
  f.allow('session-p', 'sessions');
  const created: { connectorId: string; sessionId: string }[] = [];
  f.env.CONNECTOR_HUB = { ...fakeHub({ rpc(connectorId, envelope) {
    const { action, sessionId } = envelope.request.ticket;
    if (action === 'create') { created.push({ connectorId, sessionId }); return Response.json({ ok: true }, { status: 201 }); }
    if (action === 'view') return Response.json({ view: { ...f.fake(sessionId).view, sessionId } });
    if (action === 'submit') return Response.json({ submissionId: `placed-${sessionId}`, conversationId: '0', status: 'queued' });
    return Response.json({ error: 'unexpected' }, { status: 503 });
  } }), async status(connectorId: string) { return connectorId !== 'offline-host'; } };
  const write = f.admit('session-p', ownerId);
  const childHost = (body: Record<string, unknown>) => f.sqlite.prepare('SELECT connector_id FROM sessions WHERE id = ?').get((body.session as CrossSessionSummary).id)!.connector_id;
  const childModel = (sessionId: string) => f.sqlite.prepare('SELECT a.model_id FROM sessions s JOIN agent_versions a ON a.id = s.agent_version_id WHERE s.id = ?').get(sessionId)!.model_id;

  const listed = await f.tool('session-p', ownerId, write, { action: 'list' });
  const hosts = listed.body.hosts as { id: string; online: boolean; agentMayStart: boolean; gpu: boolean; activeSessions: number; yours?: true; hardware?: { cpus: number; gpus: unknown[] } }[];
  const byId = new Map(hosts.map(item => [item.id, item]));
  assert.deepEqual([...byId.keys()].sort(), ['busy-host', 'gpu-host', 'idle-host', 'offline-host', 'teammate-host', 'unlent-gpu-host']);
  assert.deepEqual(byId.get('gpu-host'), { ...byId.get('gpu-host'), online: true, agentMayStart: true, gpu: true, yours: true, activeSessions: 0 });
  assert.equal(byId.get('unlent-gpu-host')!.gpu, false, 'a GPU the host doesn\'t lend to sandboxed commands');
  assert.equal(byId.get('busy-host')!.activeSessions, 2);
  assert.equal(byId.get('offline-host')!.online, false);
  assert.deepEqual([byId.get('teammate-host')!.agentMayStart, byId.get('teammate-host')!.yours], [false, undefined]);
  assert.equal(byId.get('idle-host')!.hardware, undefined);
  assert.equal(byId.get('gpu-host')!.hardware!.cpus, 32);
  assert.equal((listed.body.models as { id: string; host?: string }[]).find(model => model.id === 'gpu-host-faux-9')!.host, 'gpu-host');

  const gpu = await f.tool('session-p', ownerId, write, { action: 'create', title: 'Render', message: 'Go', placement: { gpu: true, gpuVendor: 'nvidia', minMemoryGb: 32 } });
  assert.equal(gpu.status, 201, JSON.stringify(gpu.body));
  assert.equal(childHost(gpu.body), 'gpu-host');
  assert.deepEqual(gpu.body.model, { id: 'gpu-host-faux-9', provider: 'faux', modelId: 'faux-9' });
  assert.deepEqual(gpu.body.placement, { host: { id: 'gpu-host', name: 'Host gpu-host' }, conditions: 'gpu true, gpu_vendor nvidia, min_memory_gb 32',
    load: 0.438, activeSessions: 0, qualified: 1, considered: 6 });
  const audit = JSON.parse(String(f.sqlite.prepare("SELECT detail_json FROM audit WHERE action = 'session.cross_session.created' AND detail_json LIKE ?")
    .get(`%${(gpu.body.session as CrossSessionSummary).id}%`)!.detail_json)) as Record<string, unknown>;
  assert.deepEqual(audit.placement, { hostId: 'gpu-host', conditions: 'gpu true, gpu_vendor nvidia, min_memory_gb 32', load: 0.438, qualified: 1 });
  const relisted = (await f.tool('session-p', ownerId, write, { action: 'list' })).body.hosts as { id: string; activeSessions: number }[];
  assert.equal(relisted.find(item => item.id === 'gpu-host')!.activeSessions, 1, 'a sub-task just started counts before its host reports it at work, so the next goes elsewhere');

  const spread = await f.tool('session-p', ownerId, write, { action: 'create', title: 'Spread', placement: {} });
  assert.equal(spread.status, 201, JSON.stringify(spread.body));
  assert.equal(childHost(spread.body), 'unlent-gpu-host', 'the same model as this session, on the least loaded host offering it');
  const named = await f.tool('session-p', ownerId, write, { action: 'create', title: 'Named', modelId: 'busy-host-faux-9', placement: { hosts: ['busy-host', 'idle-host'] } });
  assert.equal(named.status, 201, JSON.stringify(named.body));
  assert.equal(childHost(named.body), 'idle-host', 'a named model moves to whichever listed host offering it is less loaded');
  const patterned = await f.tool('session-p', ownerId, write, { action: 'create', title: 'Big', placement: { models: ['other/*'] } });
  assert.equal(patterned.status, 201, JSON.stringify(patterned.body));
  assert.deepEqual([childHost(patterned.body), (patterned.body.model as { modelId: string }).modelId], ['idle-host', 'big-1']);

  const before = f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n;
  const unsatisfied = await f.tool('session-p', ownerId, write, { action: 'create', title: 'Huge', placement: { minCpus: 100 } });
  assert.deepEqual([unsatisfied.status, unsatisfied.body.code], [409, 'placement_unsatisfied']);
  assert.match(String(unsatisfied.body.error), /of 6 hosts offering a matching model, 1 offline; 1 another member's host, where only a person can start a session; 4 failing min_cpus/);
  await f.refused(f.tool('session-p', ownerId, write, { action: 'create', placement: { models: ['nothing/*'] } }), 409, 'placement_unsatisfied');
  await f.refused(f.tool('session-p', ownerId, write, { action: 'create', message: 'Go', thinkingLevel: 'high', placement: {} }), 409, 'placement_unsatisfied');
  await f.refused(f.tool('session-p', ownerId, write, { action: 'create', modelId: 'busy-host-faux-9', placement: { models: ['faux/*'] } }), 400, 'invalid_input');
  await f.refused(f.tool('session-p', ownerId, write, { action: 'create', placement: { ram: 8 } }), 400, 'invalid_input');
  await f.refused(f.tool('session-p', ownerId, write, { action: 'list', placement: {} }), 400, 'invalid_input');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, before, 'a refused placement starts nothing');
  assert.equal(sessionsToolTarget({ action: 'create', placement: { gpu: true, models: ['a/*'] }, message: 'Go' }), 'create · placement models a/*, gpu true · message:\nGo');
  assert.ok(!created.some(item => item.connectorId === 'teammate-host' || item.connectorId === 'offline-host'));

  f.allow('session-a', 'sessions');
  const hostless = f.admit('session-a', ownerId);
  const unplaced = await f.tool('session-a', ownerId, hostless, { action: 'create', title: 'Hostless model', placement: {} });
  assert.equal(unplaced.status, 201, `an empty placement leaves a model without a host where it is: ${JSON.stringify(unplaced.body)}`);
  assert.equal(childModel((unplaced.body.session as CrossSessionSummary).id), f.model.id);
  assert.equal(unplaced.body.placement, undefined);
  await f.refused(f.tool('session-a', ownerId, hostless, { action: 'create', placement: { gpu: true } }), 409, 'placement_unsatisfied');

  await f.owner.request('PUT', `/api/workspaces/${f.workspace.id}/child-sessions`, { childModels: false });
  await f.refused(f.tool('session-p', ownerId, write, { action: 'create', placement: { models: ['other/*'] } }), 403, 'child_models_disabled');
  const parentModel = await f.tool('session-p', ownerId, write, { action: 'create', title: 'Parent model elsewhere', placement: { gpu: true } });
  assert.equal(parentModel.status, 201, JSON.stringify(parentModel.body));
  assert.equal(childHost(parentModel.body), 'gpu-host');
});

test('an agent starts a session directly on a host only in a message a person sent, naming that one host, and the host\'s own checks still apply', async t => {
  const f = await fixture(t);
  const ownerId = f.owner.user.id;
  const at = new Date().toISOString();
  const host = (id: string, capabilities: Record<string, unknown>) => {
    f.sqlite.prepare('INSERT INTO connectors (id, owner_id, name, credential_hash, connection_hash, capabilities_json, models_json, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, ownerId, `Host ${id}`, id.padEnd(43, 'h'), id.padEnd(43, 'c'), JSON.stringify({ platform: 'linux', sandbox: true, productionShell: true, approvalFree: true,
        chatOptions: true, plainGit: true, ...capabilities }), JSON.stringify([{ provider: 'faux', modelId: 'faux-9', name: 'Faux 9' }]), at);
    f.sqlite.prepare('INSERT INTO connector_workspaces (connector_id, workspace_id, created_at) VALUES (?,?,?)').run(id, f.workspace.id, at);
    f.sqlite.prepare('INSERT INTO models (id, workspace_id, name, provider, model_id, created_at, connector_id, connector_owner_id) VALUES (?,?,?,?,?,?,?,?)')
      .run(`${id}-faux-9`, f.workspace.id, 'Faux 9', 'faux', 'faux-9', at, id, ownerId);
  };
  host('own-host', { hostConfig: true, ownerHostSessions: true });
  host('second-host', { hostConfig: true, ownerHostSessions: true });
  host('old-host', {});
  const bindings: { connectorId: string; binding: { session: { id: string; hostEnvironment?: boolean } } }[] = [];
  f.env.CONNECTOR_HUB = { ...fakeHub({ rpc(connectorId, envelope) {
    const { action, sessionId } = envelope.request.ticket;
    if (action === 'create') { bindings.push({ connectorId, binding: JSON.parse(envelope.request.body) }); return Response.json({ ok: true }, { status: 201 }); }
    if (action === 'view') return Response.json({ view: { ...f.fake(sessionId).view, sessionId } });
    if (action === 'submit') return Response.json({ submissionId: `on-host-${sessionId}`, conversationId: '0', status: 'queued' });
    return Response.json({ error: 'unexpected' }, { status: 503 });
  } }), async status() { return true; } };
  f.allow('session-a', 'sessions');
  const onHost = (sessionId: string) => f.sqlite.prepare('SELECT host_environment, connector_id FROM sessions WHERE id = ?').get(sessionId)!;
  const count = () => f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n;
  const create = { action: 'create', title: 'On the host', modelId: 'own-host-faux-9', message: 'Render it', placement: { hosts: ['own-host'] }, hostEnvironment: true };

  const person = f.admit('session-a', ownerId);
  const started = await f.tool('session-a', ownerId, person, create);
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const child = (started.body.session as CrossSessionSummary).id;
  assert.equal(started.body.hostEnvironment, true);
  assert.deepEqual({ ...onHost(child) }, { host_environment: 1, connector_id: 'own-host' });
  assert.equal(bindings.at(-1)!.binding.session.hostEnvironment, true, 'the host learns it from the binding, as for a person\'s');
  const audit = JSON.parse(String(f.sqlite.prepare("SELECT detail_json FROM audit WHERE action = 'session.cross_session.created' AND detail_json LIKE ?").get(`%${child}%`)!.detail_json));
  assert.equal(audit.hostEnvironment, true);
  assert.equal(JSON.parse(String(f.sqlite.prepare("SELECT detail_json FROM audit WHERE action = 'session.created' AND session_id = ?").get(child)!.detail_json)).hostEnvironment, true);

  const sandboxed = await f.tool('session-a', ownerId, person, { ...create, hostEnvironment: undefined, title: 'Sandboxed' });
  assert.equal(sandboxed.status, 201, JSON.stringify(sandboxed.body));
  assert.equal(sandboxed.body.hostEnvironment, undefined);
  assert.equal(onHost((sandboxed.body.session as CrossSessionSummary).id).host_environment, 0, 'left out, the session runs in the sandbox as before');

  const before = count();
  for (const requestId of ['xs:from-another-session', 'schedule:nightly:2026-01-01T00:00:00Z']) {
    await f.refused(f.tool('session-a', ownerId, f.admit('session-a', ownerId, { requestId }), create), 403, 'host_session_person_required');
  }
  await f.refused(f.tool('session-a', ownerId, person, { ...create, placement: undefined }), 400, 'invalid_input');
  await f.refused(f.tool('session-a', ownerId, person, { ...create, placement: {} }), 400, 'invalid_input');
  await f.refused(f.tool('session-a', ownerId, person, { ...create, placement: { hosts: ['own-host', 'second-host'] } }), 400, 'invalid_input');
  await f.refused(f.tool('session-a', ownerId, person, { ...create, hostEnvironment: 'yes' }), 400, 'invalid_input');
  await f.refused(f.tool('session-a', ownerId, person, { action: 'list', hostEnvironment: true }), 400, 'invalid_input');
  await f.refused(f.tool('session-a', ownerId, person, { ...create, modelId: 'old-host-faux-9', placement: { hosts: ['old-host'] } }), 409, 'connector_update_required');
  await f.refused(f.tool('session-a', ownerId, f.admit('session-a', ownerId, { access: 'read' }), create), 403, 'write_not_allowed');
  assert.equal(count(), before, 'a refused create starts nothing');
  assert.equal(sessionsToolTarget({ action: 'create', placement: { hosts: ['own-host'] }, hostEnvironment: true }),
    'create · placement hosts own-host · directly on the host, without the sandbox');

  const own = { leftOut: true, personSent: true, actorId: ownerId, parent: { hostEnvironment: true, connectorId: 'own-host' }, host: { connectorId: 'own-host', ownerId } };
  assert.equal(subSessionInheritsHost(own), true, 'left out, a session started from one on its host, on that host, by its owner\'s own message, runs there too');
  for (const [why, other] of [
    ['asked for the sandbox', { ...own, leftOut: false }], ['a chain of agents or a schedule', { ...own, personSent: false }],
    ['a sandboxed parent', { ...own, parent: { ...own.parent, hostEnvironment: false } }], ['another host', { ...own, host: { connectorId: 'second-host', ownerId } }],
    ['someone else\'s host', { ...own, host: { connectorId: 'own-host', ownerId: 'test:grace' } }], ['no host', { ...own, parent: { hostEnvironment: true, connectorId: null }, host: { connectorId: null, ownerId } }],
  ] as const) assert.equal(subSessionInheritsHost(other), false, why);
});

test('a sandboxed session\'s agent starts sessions only on sandboxed hosts, unless a person\'s message names the unsandboxed host itself', async t => {
  const f = await fixture(t);
  const ownerId = f.owner.user.id;
  const at = new Date().toISOString();
  const host = (id: string, capabilities: Record<string, unknown>, owner = ownerId) => {
    f.sqlite.prepare('INSERT INTO connectors (id, owner_id, name, credential_hash, connection_hash, capabilities_json, models_json, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, owner, `Host ${id}`, id.padEnd(43, 'h'), id.padEnd(43, 'c'), JSON.stringify({ platform: 'linux', productionShell: true, approvalFree: true,
        chatOptions: true, plainGit: true, ...capabilities }), JSON.stringify([{ provider: 'faux', modelId: 'faux-9', name: 'Faux 9' }]), at);
    f.sqlite.prepare('INSERT INTO connector_workspaces (connector_id, workspace_id, created_at) VALUES (?,?,?)').run(id, f.workspace.id, at);
    f.sqlite.prepare('INSERT INTO models (id, workspace_id, name, provider, model_id, created_at, connector_id, connector_owner_id) VALUES (?,?,?,?,?,?,?,?)')
      .run(`${id}-faux-9`, f.workspace.id, 'Faux 9', 'faux', 'faux-9', at, id, owner);
  };
  host('box', { sandbox: true });
  host('bare', { sandbox: false, unsandboxed: true });
  host('theirs', { sandbox: false, unsandboxed: true }, f.collaborator.user.id);
  f.sqlite.prepare('INSERT INTO connector_shares (connector_id, workspace_id, created_at) VALUES (?,?,?)').run('theirs', f.workspace.id, at);
  for (const id of ['busy-1', 'busy-2']) {
    f.sqlite.prepare("INSERT INTO sessions (id,workspace_id,owner_id,agent_version_id,title,status,created_at,visibility,repository_mode,connector_id,connector_owner_id,activity) VALUES (?,?,?,?,?,?,?,'workspace','clone',?,?,?)")
      .run(id, f.workspace.id, ownerId, f.agent.id, id, 'ready', at, 'box', ownerId, 'working');
  }
  const boxAgent = seedAgentVersion(f.sqlite, { authorId: ownerId, modelId: 'box-faux-9', tools: ['identity'] });
  for (const [id, onHost] of [['session-s', 0], ['session-h', 1]] as const) {
    f.sqlite.prepare("INSERT INTO sessions (id,workspace_id,owner_id,agent_version_id,title,status,created_at,visibility,repository_mode,host_environment) VALUES (?,?,?,?,?,?,?,'workspace','clone',?)")
      .run(id, f.workspace.id, ownerId, boxAgent.id, id, 'ready', at, onHost);
    f.allow(id, 'sessions');
  }
  f.env.CONNECTOR_HUB = { ...fakeHub({ rpc(_connectorId, envelope) {
    const { action, sessionId } = envelope.request.ticket;
    if (action === 'create') return Response.json({ ok: true }, { status: 201 });
    if (action === 'view') return Response.json({ view: { ...f.fake(sessionId).view, sessionId } });
    if (action === 'submit') return Response.json({ submissionId: `kept-${sessionId}`, conversationId: '0', status: 'queued' });
    return Response.json({ error: 'unexpected' }, { status: 503 });
  } }), async status() { return true; } };
  const where = (body: Record<string, unknown>) => ({ ...f.sqlite.prepare('SELECT connector_id, host_environment FROM sessions WHERE id = ?').get((body.session as CrossSessionSummary).id)! });
  const count = () => f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n;

  assert.equal(await sessionSandboxed(f.env, { connector_id: 'box', host_environment: 0 }), true);
  assert.equal(await sessionSandboxed(f.env, { connector_id: 'box', host_environment: 1 }), false, 'a session directly on its host');
  assert.equal(await sessionSandboxed(f.env, { connector_id: 'bare', host_environment: 0 }), false, 'a session on a host without a sandbox');

  const person = f.admit('session-s', ownerId);
  const hosts = (await f.tool('session-s', ownerId, person, { action: 'list' })).body.hosts as { id: string; sandbox: string; agentMayStart: boolean }[];
  assert.deepEqual(hosts.map(item => [item.id, item.sandbox, item.agentMayStart]).sort(), [['bare', 'unsandboxed', true], ['box', 'sandbox', true], ['theirs', 'unsandboxed', false]]);

  const balanced = await f.tool('session-s', ownerId, person, { action: 'create', title: 'Balanced', message: 'Go', placement: {} });
  assert.equal(balanced.status, 201, JSON.stringify(balanced.body));
  assert.deepEqual(where(balanced.body), { connector_id: 'box', host_environment: 0 }, 'the idle host without a sandbox is passed over for the busier sandboxed one');
  assert.deepEqual([(balanced.body.placement as { qualified: number; considered: number }).qualified, (balanced.body.placement as { considered: number }).considered], [1, 3]);

  const moved = await f.tool('session-s', ownerId, person, { action: 'create', title: 'Moved', modelId: 'bare-faux-9', placement: {} });
  assert.equal(moved.status, 201, JSON.stringify(moved.body));
  assert.equal(where(moved.body).connector_id, 'box', 'placement moves a model named on the unsandboxed host to a sandboxed host offering it');

  const before = count();
  const named = await f.tool('session-s', ownerId, person, { action: 'create', title: 'Named', modelId: 'bare-faux-9', message: 'Go' });
  assert.deepEqual([named.status, named.body.code], [403, 'sandbox_required'], JSON.stringify(named.body));
  assert.match(String(named.body.error), /runs sessions without one.*host_environment: true and placement \{hosts: \[its id\]\}/);
  const placedThere = await f.tool('session-s', ownerId, person, { action: 'create', title: 'Placed', placement: { hosts: ['bare'] } });
  assert.deepEqual([placedThere.status, placedThere.body.code], [409, 'placement_unsatisfied'], JSON.stringify(placedThere.body));
  assert.match(String(placedThere.body.error), /2 not among placement hosts; 1 running sessions without a sandbox, where this sandboxed session's agent starts none on its own\..*host_environment: true/);
  await f.refused(f.tool('session-s', ownerId, person, { action: 'create', placement: { models: ['bare-faux-9'] } }), 409, 'placement_unsatisfied');
  const explicit = { action: 'create', title: 'Chosen', message: 'Go', placement: { hosts: ['bare'] }, hostEnvironment: true };
  for (const requestId of ['xs:from-another-session', 'schedule:nightly:2026-01-01T00:00:00Z']) {
    const admission = f.admit('session-s', ownerId, { requestId });
    await f.refused(f.tool('session-s', ownerId, admission, explicit), 403, 'host_session_person_required');
    await f.refused(f.tool('session-s', ownerId, admission, { action: 'create', modelId: 'bare-faux-9' }), 403, 'sandbox_required');
  }
  await f.refused(f.tool('session-s', ownerId, person, { action: 'create', modelId: 'theirs-faux-9' }), 403, 'connector_trust_required');
  assert.equal(count(), before, 'a refused create starts nothing');

  const chosen = await f.tool('session-s', ownerId, person, explicit);
  assert.equal(chosen.status, 201, JSON.stringify(chosen.body));
  assert.deepEqual(where(chosen.body), { connector_id: 'bare', host_environment: 0 }, 'the host has no sandbox to leave, so the session is an ordinary one there');
  assert.equal(chosen.body.hostEnvironment, true);
  const audit = JSON.parse(String(f.sqlite.prepare("SELECT detail_json FROM audit WHERE action = 'session.cross_session.created' AND detail_json LIKE ?")
    .get(`%${(chosen.body.session as CrossSessionSummary).id}%`)!.detail_json)) as Record<string, unknown>;
  assert.deepEqual([audit.hostEnvironment, audit.unsandboxedHost], [true, true]);

  const onHost = f.admit('session-h', ownerId);
  const free = await f.tool('session-h', ownerId, onHost, { action: 'create', title: 'From the host', message: 'Go', placement: {} });
  assert.equal(free.status, 201, JSON.stringify(free.body));
  assert.equal(where(free.body).connector_id, 'bare', 'a session that already runs without a sandbox places as before');
  const direct = await f.tool('session-h', ownerId, onHost, { action: 'create', title: 'Named from the host', modelId: 'bare-faux-9' });
  assert.equal(direct.status, 201, JSON.stringify(direct.body));
  assert.equal(direct.body.hostEnvironment, undefined);
});

test('a sandboxed session\'s agent messages or asks a session that runs without a sandbox only in a message a person sent', async t => {
  const f = await fixture(t);
  const ownerId = f.owner.user.id;
  const at = new Date().toISOString();
  f.sqlite.prepare('INSERT INTO connectors (id, owner_id, name, credential_hash, connection_hash, capabilities_json, models_json, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('bare', ownerId, 'Host bare', 'bare'.padEnd(43, 'h'), 'bare'.padEnd(43, 'c'), JSON.stringify({ platform: 'linux', productionShell: true, approvalFree: true,
      chatOptions: true, plainGit: true, sandbox: false, unsandboxed: true }), JSON.stringify([{ provider: 'faux', modelId: 'faux-9', name: 'Faux 9' }]), at);
  f.sqlite.prepare('INSERT INTO connector_workspaces (connector_id, workspace_id, created_at) VALUES (?,?,?)').run('bare', f.workspace.id, at);
  f.sqlite.prepare('INSERT INTO models (id, workspace_id, name, provider, model_id, created_at, connector_id, connector_owner_id) VALUES (?,?,?,?,?,?,?,?)')
    .run('bare-faux-9', f.workspace.id, 'Faux 9', 'faux', 'faux-9', at, 'bare', ownerId);
  const bareAgent = seedAgentVersion(f.sqlite, { authorId: ownerId, modelId: 'bare-faux-9', tools: ['identity'] });
  f.seed('session-c', 'Sandboxed peer');
  f.seed('direct', 'Directly on its host');
  f.sqlite.prepare("UPDATE sessions SET host_environment = 1 WHERE id = 'direct'").run();
  f.sqlite.prepare("INSERT INTO sessions (id,workspace_id,owner_id,agent_version_id,title,status,created_at,visibility,repository_mode,connector_id,connector_owner_id) VALUES (?,?,?,?,?,?,?,'workspace','clone',?,?)")
    .run('on-bare', f.workspace.id, ownerId, bareAgent.id, 'On a host without a sandbox', 'ready', at, 'bare', ownerId);
  for (const id of ['session-a', 'session-b', 'direct']) f.allow(id, 'sessions');
  const messages = () => f.sqlite.prepare('SELECT COUNT(*) AS n FROM session_messages').get()!.n;

  const person = f.admit('session-a', ownerId);
  const asked = await f.tool('session-a', ownerId, person, { action: 'send', targetSessionId: 'direct', message: 'Run the release script' });
  assert.equal(asked.status, 202, `a person's own message decides: ${JSON.stringify(asked.body)}`);
  const first = await f.tool('session-a', ownerId, person, { action: 'send', targetSessionId: 'session-b', message: 'Coordinate the release' });
  assert.equal(first.status, 202, JSON.stringify(first.body));

  const relayed = f.admit('session-b', ownerId, { requestId: `xs:${(first.body.message as CrossSessionMessage).id}` });
  const scheduled = f.admit('session-b', ownerId, { requestId: 'schedule:nightly:2026-01-01T00:00:00Z' });
  const before = messages();
  for (const admission of [relayed, scheduled]) {
    for (const target of ['direct', 'on-bare']) {
      for (const action of ['send', 'ask'] as const) {
        const refused = await f.tool('session-b', ownerId, admission, { action, targetSessionId: target, message: 'Run this there' });
        assert.deepEqual([refused.status, refused.body.code], [403, 'sandbox_required'], `${action} to ${target}: ${JSON.stringify(refused.body)}`);
        assert.match(String(refused.body.error), new RegExp(`runs without one .* doesn't ${action === 'ask' ? 'ask' : 'message'} that session's agent from a message that came from another session or a scheduled run\\. Only a message a person sent`));
      }
    }
    await f.refused(f.tool('session-b', ownerId, admission, { action: 'send', targetSessionId: 'direct', message: 'Only look', access: 'read' }), 403, 'sandbox_required');
  }
  assert.equal(messages(), before, 'a refused message is neither delivered nor recorded');
  assert.equal(f.fake('direct').submitted.length, 1, 'only the person\'s own message reached the session on its host');
  assert.equal(f.fake('on-bare').submitted.length, 0);

  const peer = await f.tool('session-b', ownerId, relayed, { action: 'send', targetSessionId: 'session-c', message: 'Sandboxed to sandboxed' });
  assert.equal(peer.status, 202, JSON.stringify(peer.body));
  assert.equal((await f.tool('session-b', ownerId, relayed, { action: 'read', targetSessionId: 'direct' })).status, 200, 'reading drives no agent');
  assert.equal((await f.tool('session-b', ownerId, relayed, { action: 'stop', targetSessionId: 'direct' })).status, 200, 'stopping drives no agent');

  const reached: string[] = [];
  f.env.CONNECTOR_HUB = { ...fakeHub({ rpc(_connectorId, envelope) {
    const { action, sessionId } = envelope.request.ticket;
    if (action === 'view') return Response.json({ view: { ...f.fake(sessionId).view, sessionId } });
    if (action === 'submit') { reached.push(sessionId); return Response.json({ submissionId: `bare-${sessionId}`, conversationId: '0', status: 'queued' }); }
    return Response.json({ error: 'unexpected' }, { status: 503 });
  } }), async status() { return true; } };
  const inDirect = f.admit('direct', ownerId, { requestId: `xs:${(asked.body.message as CrossSessionMessage).id}` });
  const onward = await f.tool('direct', ownerId, inDirect, { action: 'send', targetSessionId: 'on-bare', message: 'From one host session to another' });
  assert.equal(onward.status, 202, `a session already outside a sandbox is not restricted: ${JSON.stringify(onward.body)}`);
  assert.deepEqual(reached, ['on-bare']);
});

test('lists nest the sessions an agent started under the session that started them', () => {
  const sessions = [{ id: 'c', parentSessionId: 'a' }, { id: 'b' }, { id: 'a' }, { id: 'd', parentSessionId: 'c' }, { id: 'e', parentSessionId: 'gone' },
    { id: 'x', parentSessionId: 'y' }, { id: 'y', parentSessionId: 'x' }];
  assert.deepEqual(nestSessions(sessions).map(({ session, depth }) => `${session.id}${depth}`), ['b0', 'a0', 'c1', 'd2', 'e0', 'x0', 'y1']);
});

test('a session an agent starts runs on the model and reasoning level it chose, where the workspace allows that, and else on its parent\'s current ones', async t => {
  const f = await fixture(t);
  const ownerId = f.owner.user.id;
  const path = `/api/workspaces/${f.workspace.id}/child-sessions`;
  f.allow('session-a', 'sessions');
  const childModel = (sessionId: string) => f.sqlite.prepare('SELECT a.model_id FROM sessions s JOIN agent_versions a ON a.id = s.agent_version_id WHERE s.id = ?').get(sessionId)!.model_id;

  assert.deepEqual(await (await f.collaborator.request('GET', path)).json(), { settings: { childModels: true } });
  assert.equal((await f.collaborator.request('PUT', path, { childModels: false })).status, 403);
  assert.equal((await f.owner.request('PUT', path, { childModels: 'no' })).status, 400);
  assert.equal((await f.owner.request('PUT', path, { childModels: false, other: 1 })).status, 400);

  const deep = (await (await f.owner.request('POST', `/api/workspaces/${f.workspace.id}/models`, { name: 'deep', provider: 'faux', modelId: 'faux-2' })).json() as { model: { id: string } }).model;
  f.fake('session-a').view.agent = { provider: 'faux', modelId: 'faux-2', thinkingLevel: 'high' };
  const write = f.admit('session-a', ownerId);
  const listed = await f.tool('session-a', ownerId, write, { action: 'list' });
  assert.equal(listed.body.childModels, true);
  assert.deepEqual((listed.body.models as { id: string }[]).map(model => model.id).sort(), [f.model.id, deep.id].sort());

  const inherited = await f.tool('session-a', ownerId, write, { action: 'create', title: 'Inherits', message: 'Go' });
  assert.equal(inherited.status, 201, JSON.stringify(inherited.body));
  const inheritedId = (inherited.body.session as CrossSessionSummary).id;
  assert.equal(childModel(inheritedId), deep.id);
  assert.deepEqual(inherited.body.model, { id: deep.id, provider: 'faux', modelId: 'faux-2' });
  assert.equal((f.fake(inheritedId).submitted[0]!.body.options as Record<string, unknown> | undefined)?.thinkingLevel, undefined);

  const chosen = await f.tool('session-a', ownerId, write, { action: 'create', title: 'Chosen', modelId: f.model.id });
  assert.equal(chosen.status, 201, JSON.stringify(chosen.body));
  assert.equal(childModel((chosen.body.session as CrossSessionSummary).id), f.model.id);
  assert.equal(sessionsToolTarget({ action: 'create', modelId: 'm', thinkingLevel: 'low', message: 'Go' }), 'create · model m · thinking low · message:\nGo');
  const before = f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n;
  await f.refused(f.tool('session-a', ownerId, write, { action: 'create', thinkingLevel: 'low' }), 400, 'invalid_input');
  await f.refused(f.tool('session-a', ownerId, write, { action: 'create', message: 'Go', thinkingLevel: 'huge' }), 400, 'invalid_input');
  await f.refused(f.tool('session-a', ownerId, write, { action: 'create', message: 'Go', thinkingLevel: 'low' }), 409, 'thinking_unsupported');
  f.sqlite.prepare('INSERT INTO connectors (id, owner_id, name, credential_hash, connection_hash, capabilities_json, models_json, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('levels-host', ownerId, 'Levels', 'h'.repeat(43), 'c'.repeat(43), JSON.stringify({ platform: 'linux', sandbox: true, productionShell: true, approvalFree: true, chatOptions: true, plainGit: true }),
      JSON.stringify([{ provider: 'faux', modelId: 'faux-3', name: 'Faux 3', thinkingLevels: ['off', 'low'], thinkingLevel: 'low' }]), new Date().toISOString());
  f.sqlite.prepare('INSERT INTO connector_workspaces (connector_id, workspace_id, created_at) VALUES (?,?,?)').run('levels-host', f.workspace.id, new Date().toISOString());
  f.sqlite.prepare('INSERT INTO models (id, workspace_id, name, provider, model_id, created_at, connector_id, connector_owner_id) VALUES (?,?,?,?,?,?,?,?)')
    .run('hosted-model', f.workspace.id, 'Faux 3', 'faux', 'faux-3', new Date().toISOString(), 'levels-host', ownerId);
  const unsupported = await f.tool('session-a', ownerId, write, { action: 'create', message: 'Go', modelId: 'hosted-model', thinkingLevel: 'high' });
  assert.deepEqual([unsupported.status, unsupported.body.code], [400, 'thinking_unsupported']);
  assert.match(String((unsupported.body as { message?: string }).message ?? JSON.stringify(unsupported.body)), /off, low/);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, before);

  const hostedSubmits: Record<string, unknown>[] = [];
  f.env.CONNECTOR_HUB = fakeHub({ rpc(_connectorId, envelope) {
    const { action, sessionId } = envelope.request.ticket;
    if (action === 'create') return Response.json({ ok: true }, { status: 201 });
    if (action === 'view') return Response.json({ view: { ...f.fake(sessionId).view, sessionId } });
    if (action === 'submit') {
      hostedSubmits.push(JSON.parse(envelope.request.body) as Record<string, unknown>);
      return Response.json({ submissionId: `hosted-${hostedSubmits.length}`, conversationId: '0', status: 'queued' });
    }
    return Response.json({ error: 'unexpected' }, { status: 503 });
  } });
  const createdAudit = (childId: string) => JSON.parse(String(f.sqlite.prepare("SELECT detail_json FROM audit WHERE action = 'session.cross_session.created' AND detail_json LIKE ?")
    .get(`%${childId}%`)!.detail_json)) as Record<string, unknown>;
  f.fake('session-a').view.agent = { provider: 'faux', modelId: 'faux-2', thinkingLevel: 'low' };
  await nextView();
  const offered = await f.tool('session-a', ownerId, write, { action: 'create', title: 'Offered', modelId: 'hosted-model', message: 'Go' });
  assert.equal(offered.status, 201, JSON.stringify(offered.body));
  assert.deepEqual(offered.body.model, { id: 'hosted-model', provider: 'faux', modelId: 'faux-3', thinkingLevel: 'low' });
  assert.equal((hostedSubmits[0]!.options as Record<string, unknown>).thinkingLevel, 'low');
  const offeredAudit = createdAudit((offered.body.session as CrossSessionSummary).id);
  assert.deepEqual([offeredAudit.modelId, offeredAudit.thinkingLevel, offeredAudit.inheritedThinking, offeredAudit.inheritedModel], ['hosted-model', 'low', true, undefined]);
  f.fake('session-a').view.agent = { provider: 'faux', modelId: 'faux-2', thinkingLevel: 'high' };
  await nextView();
  const notOffered = await f.tool('session-a', ownerId, write, { action: 'create', title: 'Not offered', modelId: 'hosted-model', message: 'Go' });
  assert.equal(notOffered.status, 201, JSON.stringify(notOffered.body));
  assert.deepEqual(notOffered.body.model, { id: 'hosted-model', provider: 'faux', modelId: 'faux-3' });
  assert.equal((hostedSubmits[1]!.options as Record<string, unknown> | undefined)?.thinkingLevel, undefined);
  const notOfferedAudit = createdAudit((notOffered.body.session as CrossSessionSummary).id);
  assert.deepEqual([notOfferedAudit.thinkingLevel, notOfferedAudit.inheritedThinking, notOfferedAudit.inheritedModel], [undefined, undefined, undefined]);
  const own = await f.tool('session-a', ownerId, write, { action: 'create', title: 'Own level', modelId: 'hosted-model', message: 'Go', thinkingLevel: 'off' });
  assert.equal(own.status, 201, JSON.stringify(own.body));
  assert.equal((hostedSubmits[2]!.options as Record<string, unknown>).thinkingLevel, 'off');
  assert.equal(createdAudit((own.body.session as CrossSessionSummary).id).inheritedThinking, undefined);
  assert.equal(createdAudit(inheritedId).inheritedModel, true);

  const off = await f.owner.request('PUT', path, { childModels: false });
  assert.deepEqual(await off.json(), { settings: { childModels: false } });
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'workspace.child_sessions.updated'").get()!.n, 1);
  assert.equal((await f.tool('session-a', ownerId, write, { action: 'list' })).body.childModels, false);
  await f.refused(f.tool('session-a', ownerId, write, { action: 'create', modelId: f.model.id }), 403, 'child_models_disabled');
  await f.refused(f.tool('session-a', ownerId, write, { action: 'create', message: 'Go', thinkingLevel: 'low' }), 403, 'child_models_disabled');
  const parentOnly = await f.tool('session-a', ownerId, write, { action: 'create', title: 'Parent only' });
  assert.equal(parentOnly.status, 201, JSON.stringify(parentOnly.body));
  assert.equal(childModel((parentOnly.body.session as CrossSessionSummary).id), deep.id);
});

test('an agent searches the sessions its sender can read for what one of them did, without content its own readers couldn\'t see', async t => {
  const f = await fixture(t);
  const ownerId = f.owner.user.id;
  const write = f.admit('session-a', ownerId);
  for (const body of [{ action: 'search' }, { action: 'search', query: '  "" ' }, { action: 'search', query: 'x'.repeat(crossSessionLimits.queryChars + 1) },
    { action: 'search', query: 'pool', targetSessionId: 'session-b' }, { action: 'list', query: 'pool' }]) {
    await f.refused(f.tool('session-a', ownerId, write, body), 400, 'invalid_input');
  }
  f.seed('session-c', 'Connection pool for Postgres');
  f.seed('session-d', 'Offline worker');
  const message = (id: string, role: string, text: string, conversationId = '0') => ({ id, kind: 'message' as const, role, text, conversationId });
  f.fake('session-a').view.entries.push(message('0:1', 'assistant', 'The connection pool for Postgres lives in db.ts.'));
  const worker = f.fake('session-b');
  worker.view.entries.push(message('0:1', 'user', 'Why is Postgres slow?'), message('0:2', 'assistant', `${'x '.repeat(600)}We moved the Connection Pool to PgBouncer for Postgres. ${'y '.repeat(600)}`),
    message('0:3', 'toolResult', 'connection pool postgres'), message('7:4', 'assistant', 'connection pool postgres in a side ask', '7'));
  worker.view.conversations.push({ id: '7', mode: 'ask' });
  f.fake('session-d').view = undefined as never;

  const found = await f.tool('session-a', ownerId, write, { action: 'search', query: 'postgres "connection pool"' });
  assert.equal(found.status, 200, JSON.stringify(found.body));
  const result = found.body as { query: string; searched: number; results: { session: CrossSessionSummary; titleMatch?: true; matches: { entryId: string; role: string; text: string }[] }[];
    skipped?: { id: string; reason: string }[] };
  assert.equal(result.searched, 3, 'every session the sender reads but this one');
  const byId = new Map(result.results.map(item => [item.session.id, item]));
  assert.ok(!byId.has('session-a'), 'never this session itself');
  assert.deepEqual(byId.get('session-b')!.matches.map(match => [match.entryId, match.role]), [['0:2', 'assistant']], 'the shared conversation\'s messages, not tool output or side asks');
  assert.match(byId.get('session-b')!.matches[0]!.text, /^….*Connection Pool to PgBouncer for Postgres.*…$/);
  assert.ok(byId.get('session-b')!.matches[0]!.text.length <= crossSessionLimits.snippetChars + 2);
  assert.deepEqual([byId.get('session-c')!.titleMatch, byId.get('session-c')!.matches], [true, []], 'a title that matches counts too');
  assert.deepEqual(result.skipped, [{ id: 'session-d', title: 'Offline worker', reason: 'unavailable' }]);
  assert.equal((await f.tool('session-a', ownerId, write, { action: 'search', query: 'nothing like this' })).body.results instanceof Array, true);
  assert.deepEqual((await f.tool('session-a', ownerId, write, { action: 'search', query: 'nothing like this' })).body.results, []);
  const one = await f.tool('session-a', ownerId, write, { action: 'search', query: 'postgres', limit: 1 });
  assert.equal((one.body.results as unknown[]).length, 1);
  assert.equal(one.body.more, 1);

  f.share('session-a');
  const shared = await f.tool('session-a', ownerId, write, { action: 'search', query: 'postgres "connection pool"' });
  const sharedResult = shared.body as { results: { session: CrossSessionSummary; titleMatch?: true; matches: unknown[] }[]; skipped?: { id: string; reason: string }[] };
  assert.ok(sharedResult.skipped?.some(item => item.id === 'session-b' && item.reason === 'audience'),
    'a session shared by link brings in nothing its link\'s readers couldn\'t read');
  assert.ok(sharedResult.results.every(item => !item.matches.length), JSON.stringify(sharedResult.results));
  assert.equal((await f.owner.request('PUT', '/api/sessions/session-a/audience-sharing', { enabled: true })).status, 200);
  const allowed = await f.tool('session-a', ownerId, write, { action: 'search', query: 'postgres "connection pool"' });
  assert.ok((allowed.body.results as { session: { id: string }; matches: unknown[] }[]).some(item => item.session.id === 'session-b' && item.matches.length),
    'once its owner lets content through, it is searched');
});
