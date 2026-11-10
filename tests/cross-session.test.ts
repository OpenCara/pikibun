import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { app } from '../apps/server/src/index.js';
import type { Env } from '../apps/server/src/types.js';
import { runCrossSessionNotifications } from '../apps/server/src/cross-session.js';
import {
  audienceTarget, crossSessionHeader, crossSessionLimits, messageOutcome, sessionsToolTarget, type CrossSessionMessage, type CrossSessionSummary, type SessionConnections,
} from '../packages/shared/src/cross-session.js';
import type { EntryView, SessionRecord, SessionView } from '../packages/shared/src/types.js';
import { nestSessions } from '../packages/client/src/session-tree.js';
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
  assert.equal(messageOutcome({ ...older, approvals: [{ status: 'pending' } as SessionView['approvals'][number]] }, message).done, false);
  const long = sessionsToolTarget({ action: 'send', targetSessionId: 'b', message: 'x'.repeat(100_000) });
  assert.ok(long.length < 8192 && long.startsWith('send · session b · message:\n'));
  assert.equal(sessionsToolTarget({ action: 'read', targetSessionId: 'b', messageId: 'm1' }), 'read · session b · message m1');
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
  const seed = (id: string, title: string, visibility = 'private') => sqlite.prepare("INSERT INTO sessions (id,workspace_id,owner_id,agent_version_id,title,status,created_at,visibility,repository_mode) VALUES (?,?,?,?,?,?,?,?,'clone')")
    .run(id, workspace.id, owner.user.id, agent.id, title, 'ready', new Date().toISOString(), visibility);
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
  return { env, sqlite, owner, collaborator, workspace, model, agent, fake, admit, tool, allow, refused, seed };
}

const nextView = () => delay(1000);

test('an agent lists and reads the sessions its sender can see, and a read never shows people what they can\'t open', async t => {
  const f = await fixture(t);
  const ownerId = f.owner.user.id;
  const write = f.admit('session-a', ownerId);
  await f.refused(f.tool('session-a', ownerId, write, { action: 'list' }), 403, 'tool_not_allowed');
  f.allow('session-a', 'sessions');
  for (const [body, code] of [[{ action: 'read' }, 'invalid_input'], [{ action: 'list', targetSessionId: 'session-b' }, 'invalid_input'],
    [{ action: 'send', targetSessionId: 'session-b' }, 'invalid_input'], [{ action: 'jump' }, 'invalid_input'], [{ action: 'read', targetSessionId: 'session-b', limit: 51 }, 'invalid_input'],
    [{ action: 'ask', targetSessionId: 'session-b', message: 'hi', access: 'auto' }, 'invalid_input']] as const) {
    await f.refused(f.tool('session-a', ownerId, write, body), 400, code);
  }
  await f.refused(f.tool('session-a', ownerId, f.admit('session-b', ownerId), { action: 'list' }), 403, 'sessions_not_admitted');
  await f.refused(f.tool('session-a', f.collaborator.user.id, write, { action: 'list' }), 403, 'permission_revoked');

  const listed = await f.tool('session-a', ownerId, write, { action: 'list' });
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  const sessions = listed.body.sessions as CrossSessionSummary[];
  assert.deepEqual(sessions.map(session => [session.id, session.self ?? false]).sort(), [['session-a', true], ['session-b', false]]);
  assert.deepEqual((listed.body.models as { id: string }[]).map(model => model.id), [f.model.id]);

  assert.equal((await f.owner.request('POST', '/api/sessions/session-a/grants', { userId: f.collaborator.user.id, role: 'collaborator' })).status, 200);
  const worker = f.fake('session-b');
  worker.view.entries.push({ id: '0:1', kind: 'message', role: 'user', text: 'Build it', conversationId: '0', actorId: ownerId },
    { id: '0:2', kind: 'message', role: 'assistant', text: 'y'.repeat(5000), conversationId: '0' },
    { id: '7:3', kind: 'message', role: 'assistant', text: 'a side answer', conversationId: '7' });
  worker.view.conversations.push({ id: '7', mode: 'ask' });
  worker.view.approvals.push({ id: 'permission-1', sessionId: 'session-b', requestedBy: ownerId, createdAt: new Date().toISOString(), status: 'pending',
    operation: { kind: 'permission', tool: 'bash', target: 'make', needs: ['tool'] },
    admissionId: f.admit('session-b', ownerId) } as SessionView['approvals'][number]);
  const consent = await f.tool('session-a', ownerId, write, { action: 'read', targetSessionId: 'session-b' }, 'read-1');
  assert.deepEqual(consent.body, { consent: 'audience', target: audienceTarget({ id: 'session-b', title: 'Worker' }), reason: 'This session\'s readers include people who can\'t read that session.' });
  f.sqlite.prepare("INSERT INTO approval_reviews (session_id,approval_id,requested_by,operation_json,source,admission_id,review_hash,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run('session-a', 'permission-read-1_audience', ownerId, JSON.stringify({ kind: 'permission', tool: 'sessions', target: audienceTarget({ id: 'session-b', title: 'Worker' }), needs: ['audience'] }),
      'model', write, 'r'.repeat(43), new Date().toISOString());
  f.allow('session-a', 'sessions:audience', 'read-1', 'permission-read-1_audience');
  const read = await f.tool('session-a', ownerId, write, { action: 'read', targetSessionId: 'session-b' }, 'read-1');
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.ok(!('consent' in read.body), JSON.stringify(read.body));
  const entries = read.body.entries as EntryView[];
  assert.deepEqual(entries.map(entry => entry.id), ['0:1', '0:2'], 'the shared conversation only');
  assert.ok(entries[1]!.text.length < 2100 && entries[1]!.text.endsWith('3000 more characters'));
  assert.deepEqual(read.body.pendingApprovals, [{ id: 'permission-1', kind: 'permission', tool: 'bash', requestedBy: ownerId }]);
  assert.ok('consent' in (await f.tool('session-a', ownerId, write, { action: 'read', targetSessionId: 'session-b' }, 'read-2')).body);
  assert.equal((await f.owner.request('DELETE', `/api/sessions/session-a/grants/${f.collaborator.user.id}`)).status, 200);
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
    ['send', 'session-a', 'session-b', ownerId, 1, 'approval', undefined]);
  const delivered = worker.submitted.at(-1)!;
  assert.equal(delivered.mode, 'submit');
  assert.equal(delivered.body.requestId, `xs:${message.id}`);
  assert.equal(delivered.body.content, `[Pikibun cross-session message xs:${message.id} · from session "Coordinator" (session-a) · sent by test:xs-owner through its agent · hop 1]\n\nRun the tests`);
  assert.equal(delivered.body.options, undefined, 'approval, the default, sends no options');
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

  await f.refused(f.tool('session-a', ownerId, write, { action: 'send', targetSessionId: 'session-b', message: 'Go', access: 'auto' }), 403, 'automatic_message_not_admitted');
  await f.refused(f.tool('session-a', ownerId, f.admit('session-a', ownerId, { access: 'auto' }), { action: 'send', targetSessionId: 'session-b', message: 'Go', access: 'auto' }), 400, 'options_unsupported');
  const readOnly = f.admit('session-a', ownerId, { access: 'read' });
  await f.refused(f.tool('session-a', ownerId, readOnly, { action: 'send', targetSessionId: 'session-b', message: 'Go' }), 403, 'write_not_allowed');
  await f.refused(f.tool('session-a', ownerId, readOnly, { action: 'stop', targetSessionId: 'session-b' }), 403, 'write_not_allowed');
  assert.equal((await f.tool('session-a', ownerId, readOnly, { action: 'ask', targetSessionId: 'session-b', message: 'Status?' })).status, 202);
  f.allow('session-a', 'sessions:write');
  assert.equal((await f.tool('session-a', ownerId, readOnly, { action: 'send', targetSessionId: 'session-b', message: 'Go' })).status, 202);

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

  assert.equal((await f.owner.request('POST', '/api/sessions/session-a/grants', { userId: f.collaborator.user.id, role: 'collaborator' })).status, 200);
  const theirs = f.admit('session-a', f.collaborator.user.id);
  await f.refused(f.tool('session-a', f.collaborator.user.id, theirs, { action: 'send', targetSessionId: 'session-b', message: 'hi' }), 404, 'not_found');
  const started = await f.tool('session-a', f.collaborator.user.id, theirs, { action: 'create', title: 'Their sub-task' });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.deepEqual([(started.body.session as CrossSessionSummary).ownerId, (started.body.session as CrossSessionSummary).parentSessionId], [f.collaborator.user.id, 'session-a']);
});

test('an agent stops and archives sessions as its sender may, and starts linked sessions never wider than its own', async t => {
  const f = await fixture(t);
  const ownerId = f.owner.user.id;
  f.allow('session-a', 'sessions');
  const write = f.admit('session-a', ownerId);
  const stopped = await f.tool('session-a', ownerId, write, { action: 'stop', targetSessionId: 'session-b' });
  assert.deepEqual([stopped.status, stopped.body], [200, { stopped: 1 }]);
  assert.equal(f.fake('session-b').stopped, 1);

  const readOnly = f.admit('session-a', ownerId, { access: 'read' });
  const spaced = { action: 'create', title: '  Spaced title  ' } as const;
  f.sqlite.prepare("INSERT INTO approval_reviews (session_id,approval_id,requested_by,operation_json,source,admission_id,review_hash,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run('session-a', 'permission-create-1', ownerId, JSON.stringify({ kind: 'permission', tool: 'sessions', target: sessionsToolTarget(spaced), needs: ['write'] }),
      'model', readOnly, 'r'.repeat(43), new Date().toISOString());
  f.allow('session-a', 'sessions:write', 'create-1', 'permission-create-1');
  const spacedChild = await f.tool('session-a', ownerId, readOnly, spaced, 'create-1');
  assert.equal(spacedChild.status, 201, JSON.stringify(spacedChild.body));
  assert.equal((spacedChild.body.session as CrossSessionSummary).title, 'Spaced title');
  await f.refused(f.tool('session-a', ownerId, readOnly, spaced, 'create-2'), 403, 'write_not_allowed');

  await f.refused(f.tool('session-a', ownerId, write, { action: 'create', title: 'Wide', visibility: 'workspace' }), 403, 'visibility_wider');
  const created = await f.tool('session-a', ownerId, write, { action: 'create', title: 'Write the docs', message: 'Document the API', notify: true });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const child = created.body.session as CrossSessionSummary;
  const opening = created.body.message as CrossSessionMessage;
  assert.deepEqual([child.title, child.parentSessionId, child.visibility, child.ownerId, child.status], ['Write the docs', 'session-a', 'private', ownerId, 'ready']);
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

  assert.equal((await f.owner.request('POST', '/api/sessions/session-a/grants', { userId: f.collaborator.user.id, role: 'viewer' })).status, 200);
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

test('the workspace\'s owner and admins read every session there, so content passes between private sessions only they and the owner read without asking', async t => {
  const f = await fixture(t);
  const now = new Date().toISOString();
  const memberId = 'test:xs-member'; const adminId = 'test:xs-admin';
  for (const [id, role] of [[memberId, 'member'], [adminId, 'admin']] as const) {
    f.sqlite.prepare("INSERT INTO users (id,display_name,git_name,git_email,env_json,auth_kind,created_at) VALUES (?,?,?,?,'{}','test',?)").run(id, id, id, `${id}@example.test`, now);
    f.sqlite.prepare('INSERT INTO workspace_members (workspace_id,user_id,role,created_at) VALUES (?,?,?,?)').run(f.workspace.id, id, role, now);
  }
  const own = (id: string, ownerId: string) => {
    f.sqlite.prepare("INSERT INTO sessions (id,workspace_id,owner_id,agent_version_id,title,status,created_at,visibility,repository_mode) VALUES (?,?,?,?,?,'ready',?,'private','clone')")
      .run(id, f.workspace.id, ownerId, f.agent.id, id, now);
    f.fake(id).view.owner = { id: ownerId, displayName: ownerId, gitName: ownerId, gitEmail: `${ownerId}@example.test`, githubLogin: null };
    f.allow(id, 'sessions');
  };
  own('member-private', memberId);
  own('admin-private', adminId);

  const adminWrite = f.admit('admin-private', adminId);
  const listed = await f.tool('admin-private', adminId, adminWrite, { action: 'list' });
  assert.deepEqual((listed.body.sessions as CrossSessionSummary[]).find(item => item.id === 'member-private')?.permissions, ['read', 'ask', 'write', 'manage']);
  const read = await f.tool('admin-private', adminId, adminWrite, { action: 'read', targetSessionId: 'member-private' });
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.ok(!('consent' in read.body), JSON.stringify(read.body));
  const sent = await f.tool('admin-private', adminId, adminWrite, { action: 'send', targetSessionId: 'member-private', message: 'Look at this' });
  assert.equal(sent.body.consent, 'audience', JSON.stringify(sent.body));
  assert.deepEqual(f.fake('member-private').submitted, []);
  f.allow('admin-private', 'sessions:audience');
  const delivered = await f.tool('admin-private', adminId, adminWrite, { action: 'send', targetSessionId: 'member-private', message: 'Look at this' });
  assert.equal(delivered.status, 202, JSON.stringify(delivered.body));
  assert.equal(f.fake('member-private').submitted.length, 1);
  assert.equal(f.sqlite.prepare("SELECT actor_id FROM run_admissions WHERE session_id = 'member-private' AND request_id LIKE 'xs:%'").get()!.actor_id, adminId);

  const memberWrite = f.admit('member-private', memberId);
  await f.refused(f.tool('member-private', memberId, memberWrite, { action: 'read', targetSessionId: 'admin-private' }), 404, 'not_found');
  const created = await f.tool('member-private', memberId, memberWrite, { action: 'create', title: 'Sub-task', message: 'Do it', notify: true });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const child = created.body.session as CrossSessionSummary;
  assert.deepEqual([child.visibility, child.ownerId, child.parentSessionId], ['private', memberId, 'member-private']);
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

test('a sandboxed session an agent starts, messages or notifies runs on Auto-approve by default when the owner\'s own Auto-approve message sent it', async t => {
  const f = await fixture(t);
  const ownerId = f.owner.user.id;
  f.allow('session-a', 'sessions');
  const at = new Date().toISOString();
  const capabilities = { platform: 'linux', sandbox: true, productionShell: true, chatOptions: true, plainGit: true, automaticGitHub: true };
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
  const sentAccess = () => [(last().body.options as ChatOptionsSent | undefined)?.access, (last().body.options as ChatOptionsSent | undefined)?.autoMerge];

  const auto = f.admit('session-a', ownerId, { access: 'auto', autoMerge: true });
  const started = await f.tool('session-a', ownerId, auto, { action: 'create', title: 'Worker', modelId: 'hosted-model', message: 'Build it' });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const worker = (started.body.session as CrossSessionSummary).id;
  assert.equal((started.body.message as CrossSessionMessage).access, 'auto');
  assert.deepEqual(sentAccess(), ['auto', true], 'it merges without asking too, as the message that started it does');
  const audited = f.sqlite.prepare("SELECT detail_json FROM audit WHERE action = 'session.cross_session.sent' ORDER BY rowid DESC LIMIT 1").get()!;
  assert.deepEqual([JSON.parse(String(audited.detail_json)).inheritedAccess, JSON.parse(String(audited.detail_json)).inheritedAutoMerge], ['auto', true]);

  const sent = await f.tool('session-a', ownerId, auto, { action: 'send', targetSessionId: worker, message: 'And test it' });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  assert.equal((sent.body.message as CrossSessionMessage).access, 'auto');
  assert.deepEqual(sentAccess(), ['auto', true]);
  const chosen = await f.tool('session-a', ownerId, auto, { action: 'send', targetSessionId: worker, message: 'Ask me first', access: 'approval' });
  assert.equal((chosen.body.message as CrossSessionMessage).access, 'approval', 'an access the agent chooses stands');
  assert.equal(last().body.options && (last().body.options as ChatOptionsSent).access, undefined);

  const asking = f.admit('session-a', ownerId);
  const fromAsking = await f.tool('session-a', ownerId, asking, { action: 'create', title: 'Asks', modelId: 'hosted-model', message: 'Go' });
  assert.equal(fromAsking.status, 201, JSON.stringify(fromAsking.body));
  assert.equal((fromAsking.body.message as CrossSessionMessage).access, 'approval', 'no message gains more than the one that sent it');
  assert.deepEqual(sentAccess(), [undefined, undefined]);

  f.sqlite.prepare('UPDATE connectors SET capabilities_json = ? WHERE id = ?').run(JSON.stringify({ ...capabilities, unsandboxed: true }), 'sandbox-host');
  const unsandboxed = await f.tool('session-a', ownerId, auto, { action: 'send', targetSessionId: worker, message: 'On the bare host' });
  assert.equal((unsandboxed.body.message as CrossSessionMessage).access, 'approval', 'an unsandboxed session keeps asking');
  assert.deepEqual(sentAccess(), [undefined, undefined]);
  f.sqlite.prepare('UPDATE connectors SET capabilities_json = ? WHERE id = ?').run(JSON.stringify(capabilities), 'sandbox-host');

  // The worker's own Auto-approve message asked session-b for a review, to be notified of its outcome.
  const inWorker = f.admit(worker, ownerId, { access: 'auto', autoMerge: true });
  const message = { id: 'review-1', submissionId: 'review-sub' };
  f.sqlite.prepare(`INSERT INTO session_messages (id, workspace_id, origin_session_id, target_session_id, actor_id, kind, origin_admission_id, origin_call_id,
      submission_id, conversation_id, hops, chain_json, access, notify_status, created_at, updated_at) VALUES (?,?,?,?,?,'send',?,'call-review',?,'0',1,?,'approval','pending',?,?)`)
    .run(message.id, f.workspace.id, worker, 'session-b', ownerId, inWorker, message.submissionId, JSON.stringify([worker]), at, at);
  const reviewer = f.fake('session-b');
  reviewer.view.entries.push({ id: '0:69', kind: 'message', role: 'user', text: `[Pikibun cross-session message xs:${message.id} · …]\n\nReview it`, conversationId: '0' },
    { id: '0:70', kind: 'message', role: 'assistant', text: 'Looks good.', conversationId: '0' });
  reviewer.view.queue!.push({ submissionId: message.submissionId, actorId: ownerId, mode: 'write', status: 'settled' });
  await nextView();
  assert.deepEqual(await runCrossSessionNotifications(f.env), [{ messageId: message.id, delivered: `${message.id}-n` }]);
  assert.equal(last().sessionId, worker);
  assert.equal(last().body.requestId, `xs:${message.id}-n`);
  assert.deepEqual(sentAccess(), ['auto', undefined], 'its outcome comes back on Auto-approve, as the message that sent it went, but never merges without asking');

  const asked = { id: 'side-1', submissionId: 'side-sub' };
  f.sqlite.prepare(`INSERT INTO session_messages (id, workspace_id, origin_session_id, target_session_id, actor_id, kind, origin_admission_id, origin_call_id,
      submission_id, conversation_id, hops, chain_json, notify_status, created_at, updated_at) VALUES (?,?,?,?,?,'ask',?,'call-side',?,'7',1,?,'pending',?,?)`)
    .run(asked.id, f.workspace.id, worker, 'session-b', ownerId, inWorker, asked.submissionId, JSON.stringify([worker]), at, at);
  reviewer.view.conversations.push({ id: '7', mode: 'ask' });
  reviewer.view.entries.push({ id: '7:80', kind: 'message', role: 'user', text: `[Pikibun cross-session side ask xs:${asked.id} \u00b7 \u2026]\n\nHow?`, conversationId: '7' },
    { id: '7:81', kind: 'message', role: 'assistant', text: 'Like this.', conversationId: '7' });
  reviewer.view.queue!.push({ submissionId: asked.submissionId, actorId: ownerId, mode: 'ask', status: 'settled' });
  await nextView();
  assert.deepEqual(await runCrossSessionNotifications(f.env), [{ messageId: asked.id, delivered: `${asked.id}-n` }]);
  assert.equal(last().body.requestId, `xs:${asked.id}-n`);
  assert.deepEqual(sentAccess(), [undefined, undefined], 'a side ask\'s answer comes back asking, as a side ask never carries access');
});

type ChatOptionsSent = { access?: string; autoMerge?: boolean };

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
    .run('levels-host', ownerId, 'Levels', 'h'.repeat(43), 'c'.repeat(43), JSON.stringify({ platform: 'linux', sandbox: true, productionShell: true, chatOptions: true, plainGit: true }),
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
