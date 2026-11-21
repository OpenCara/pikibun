import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { app } from '../apps/server/src/index.js';
import type { Env } from '../apps/server/src/types.js';
import { openLocalStateTakingOver, readDiscovery } from '../apps/server/src/local/discovery.js';
import { createPrivateHome } from '../apps/server/src/local/home.js';
import { startLocalServer } from '../apps/server/src/local/launch.js';
import { LocalStateBusyError, openLocalState } from '../apps/server/src/local/state.js';
import type { PrivateHome } from '../apps/runner/src/private-home.js';
import type { ConnectorRelayEnvelope } from '../apps/server/src/connector-transport.js';
import { sha256 } from '../packages/shared/src/crypto.js';
import {
  parsePrivateForwardRequest, PRIVATE_FORWARD_HEADER, privateRoute, type PrivateForwardRequest, type PrivateForwardResponse,
} from '../packages/shared/src/private-sessions.js';
import type { SessionRecord } from '../packages/shared/src/types.js';
import { fakeHub, testDatabase } from './helpers/control-plane.js';

const origin = 'http://localhost:8787';
const testSecret = 'private-sessions-auth-secret-not-for-deployment';

test('a computer forwards only the named session routes, with a plain query', () => {
  assert.deepEqual(privateRoute('GET', '/api/private-sessions'), {});
  assert.deepEqual(privateRoute('POST', '/api/private-sessions'), {});
  assert.deepEqual(privateRoute('GET', '/api/sessions/abc/view'), { sessionId: 'abc' });
  assert.deepEqual(privateRoute('GET', '/api/sessions/abc/events?since=0123456789abcdef0123456789abcdef'), { sessionId: 'abc' });
  assert.deepEqual(privateRoute('POST', '/api/sessions/abc/submit'), { sessionId: 'abc' });
  assert.deepEqual(privateRoute('PATCH', '/api/sessions/abc/schedules/s1'), { sessionId: 'abc' });
  assert.deepEqual(privateRoute('POST', '/api/sessions/abc/tunnel/stop'), { sessionId: 'abc' });
  for (const [method, path] of [['GET', '/api/me'], ['POST', '/api/sessions/abc/link'], ['GET', '/api/sessions/abc/link'], ['POST', '/api/sessions/abc/grants'],
    ['POST', '/api/sessions/abc/migrate'], ['DELETE', '/api/sessions/abc'], ['GET', '/api/sessions/abc/../../me'], ['GET', '/api/sessions/abc/view?x=<script>'],
    ['POST', '/api/sessions/abc/view'], ['GET', '/api/sessions'], ['POST', '/api/sessions']] as const) {
    assert.equal(privateRoute(method, path), null, `${method} ${path}`);
  }
  assert.equal(parsePrivateForwardRequest({ method: 'GET', path: '/api/sessions/abc/view', body: '{}' }), null, 'a GET carries no body');
  assert.equal(parsePrivateForwardRequest({ method: 'POST', path: '/api/sessions/abc/submit', extra: 1 }), null);
  assert.deepEqual(parsePrivateForwardRequest({ method: 'POST', path: '/api/sessions/abc/submit', body: '{"content":"hi"}' }),
    { method: 'POST', path: '/api/sessions/abc/submit', body: '{"content":"hi"}' });
});

interface Client { user: { id: string }; request(method: string, path: string, body?: unknown): Response | Promise<Response> }

async function json<T>(response: Response, expected = 200): Promise<T> {
  const body = await response.json();
  assert.equal(response.status, expected, JSON.stringify(body));
  return body as T;
}

const forwardAnswer = (status: number, value: unknown, contentType = 'application/json'): Response =>
  Response.json({ status, contentType, data: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64') } satisfies PrivateForwardResponse);

async function remote(t: TestContext, computer: (request: PrivateForwardRequest, envelope: ConnectorRelayEnvelope) => Response | Promise<Response>) {
  const { db, sqlite } = await testDatabase();
  t.after(() => db.close());
  const env: Env = { DB: db, APP_ORIGIN: origin, TEST_AUTH_ENABLED: 'true', TEST_AUTH_SECRET: testSecret,
    TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(), VAULT_KEY: Buffer.alloc(32, 7).toString('base64url'),
    CONNECTOR_HUB: fakeHub({ rpc: (_connector, envelope) => {
      assert.equal(envelope.request.ticket.action, 'private');
      return computer(parsePrivateForwardRequest(JSON.parse(envelope.request.body))!, envelope);
    } }) };
  const request = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => app.request(path, { method,
    headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) }, env);
  const signIn = async (id: string) => {
    const response = await request('POST', '/api/auth/test', { id, displayName: id, gitName: id, gitEmail: `${id}@example.test` }, { Authorization: `Bearer ${testSecret}` });
    const { user } = await json<{ user: { id: string } }>(response);
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const { csrfToken } = await json<{ csrfToken: string }>(await request('GET', '/api/auth/csrf', undefined, { Cookie: cookie }));
    const client: Client = { user, request: (method, path, body) => request(method, path, body, { Cookie: cookie, 'X-CSRF-Token': csrfToken }) };
    await json(await client.request('GET', '/api/workspaces'));
    return client;
  };
  const alice = await signIn('alice');
  const workspaceId = (sqlite.prepare('SELECT workspace_id FROM personal_workspaces WHERE user_id = ?').get(alice.user.id) as { workspace_id: string }).workspace_id;
  const pair = async (connectorId: string, credential: string, current: string, capabilities: Record<string, unknown>) => {
    sqlite.prepare(`INSERT INTO connectors (id, owner_id, name, credential_hash, connection_hash, models_json, capabilities_json, created_at)
      VALUES (?, ?, 'Alice''s Mac', ?, ?, '[{"provider":"faux","modelId":"faux-v1","name":"Model"}]', ?, '2026-01-01')`)
      .run(connectorId, alice.user.id, await sha256(credential), await sha256(current), JSON.stringify(capabilities));
    sqlite.prepare("INSERT INTO connector_workspaces (connector_id, workspace_id, created_at) VALUES (?, ?, '2026-01-01')").run(connectorId, workspaceId);
    sqlite.prepare(`INSERT INTO models (id, workspace_id, name, provider, model_id, connector_id, connector_owner_id, created_at)
      VALUES (?, ?, 'Model', 'faux', 'faux-v1', ?, ?, '2026-01-01')`).run(`model-${connectorId}`, workspaceId, connectorId, alice.user.id);
    return (path: string, body: unknown) => request('POST', path, body, { Authorization: `Bearer ${credential}`, 'X-Connection-Token': current });
  };
  const capabilities = { platform: 'linux', sandbox: true, productionShell: false, plainGit: true, hostConfig: true, ownerHostSessions: true, sessionBranches: true };
  const host = await pair('host', 'b'.repeat(43), 'c'.repeat(43), { ...capabilities, privateSessions: 1 });
  const older = await pair('older', 'd'.repeat(43), 'e'.repeat(43), capabilities);
  return { env, sqlite, alice, signIn, host, older, workspaceId };
}

const record = (id: string, extra: Partial<SessionRecord> = {}): SessionRecord => ({
  id, workspaceId: 'local-private', ownerId: 'password:ada', agentVersionId: 'local-agent', title: 'On my computer', policyVersion: 3, status: 'ready',
  createdAt: '2026-11-18T10:00:00.000Z', permissions: ['read', 'write', 'ask', 'manage'], connectorId: 'local-host', repositoryMode: 'clone', ...extra,
});

test('another server lists the private sessions a computer reports, forwards their routes to it, and makes new ones there', async t => {
  const forwarded: PrivateForwardRequest[] = [];
  const created = randomUUID();
  const f = await remote(t, request => {
    forwarded.push(request);
    if (request.path === '/api/private-sessions' && request.method === 'POST') return forwardAnswer(201, { session: record(created, { title: 'New on my computer' }) });
    if (request.path.split('?')[0]!.endsWith('/events')) return forwardAnswer(200, 'event: view\ndata: {}\n\n', 'text/event-stream');
    if (request.path.endsWith('/submit')) return forwardAnswer(202, { queued: true });
    if (request.path.endsWith('/stop')) return forwardAnswer(409, { error: 'Nothing to stop.', code: 'not_working' });
    if (request.method === 'DELETE') return Response.json({ status: 204, contentType: 'application/octet-stream', data: '' } satisfies PrivateForwardResponse);
    return forwardAnswer(200, { session: { ...record(request.path.split('/')[3]!, { title: 'Renamed\tthere' }), hostUnsandboxed: true } });
  });
  const sessionId = randomUUID();
  await json(await f.older('/api/connectors/self/private-sessions', { sessions: [record(sessionId)] }), 409);
  await json(await f.host('/api/connectors/self/private-sessions', { sessions: [record(sessionId, { activity: 'working' }), { id: 'bad id', title: 'x' }] }));

  const listed = (await json<{ sessions: SessionRecord[] }>(await f.alice.request('GET', '/api/sessions'))).sessions.filter(item => item.forwarded);
  assert.deepEqual(listed.map(item => [item.id, item.workspaceId, item.ownerId, item.connectorId, item.forwarded]),
    [[sessionId, f.workspaceId, f.alice.user.id, 'host', { hostName: 'Alice\'s Mac', online: true }]], 'shown in the private workspace, as its owner\'s');

  const events = await f.alice.request('GET', `/api/sessions/${sessionId}/events?since=${'a'.repeat(32)}`);
  assert.equal(events.status, 200);
  assert.equal(events.headers.get('content-type'), 'text/event-stream', `${[...events.headers.entries()].join(' ')} ${await events.clone().text()}`);
  assert.equal(await events.text(), 'event: view\ndata: {}\n\n');
  assert.deepEqual(forwarded.at(-1), { method: 'GET', path: `/api/sessions/${sessionId}/events?since=${'a'.repeat(32)}` });
  assert.equal((await json<{ queued: boolean }>(await f.alice.request('POST', `/api/sessions/${sessionId}/submit`, { content: 'hello' }), 202)).queued, true);
  assert.deepEqual(forwarded.at(-1), { method: 'POST', path: `/api/sessions/${sessionId}/submit`, body: '{"content":"hello"}' });
  assert.equal((await json<{ code: string }>(await f.alice.request('POST', `/api/sessions/${sessionId}/stop`, {}), 409)).code, 'not_working', 'the computer\'s answer comes back as it is');
  const renamed = await json<{ session: SessionRecord }>(await f.alice.request('PATCH', `/api/sessions/${sessionId}`, { title: 'Renamed there' }));
  assert.equal(renamed.session.workspaceId, f.workspaceId, 'records it answers with are shown as this server\'s');
  assert.equal(renamed.session.title, 'Renamed there', 'a title is shown on one plain line, not dropped');
  assert.equal(renamed.session.hostUnsandboxed, true, 'the computer\'s warning that its commands run unsandboxed comes along');
  const removed = await f.alice.request('DELETE', `/api/sessions/${sessionId}/schedules/nightly`);
  assert.equal(removed.status, 204, 'an answer without a body comes back as one');
  assert.equal(await removed.text(), '');
  const count = forwarded.length;
  assert.equal((await json<{ code: string }>(await f.alice.request('PUT', `/api/sessions/${sessionId}/link`, {}), 409)).code, 'private_session_here');
  assert.equal(forwarded.length, count, 'a route a computer doesn\'t forward never reaches it');

  const made = await json<{ session: SessionRecord }>(await f.alice.request('POST', '/api/sessions', { workspaceId: f.workspaceId, modelId: 'model-host', title: 'New', hostEnvironment: true, trustedConnectorId: 'x' }), 201);
  assert.deepEqual(forwarded.at(-1), { method: 'POST', path: '/api/private-sessions', body: JSON.stringify({ title: 'New', hostEnvironment: true, provider: 'faux', modelId: 'faux-v1' }) });
  assert.equal(made.session.id, created);
  assert.equal(made.session.forwarded?.online, true);
  assert.ok((await json<{ sessions: SessionRecord[] }>(await f.alice.request('GET', '/api/sessions'))).sessions.some(item => item.id === created), 'listed before the next report');
  assert.equal(f.sqlite.prepare('SELECT 1 FROM sessions WHERE id = ?').get(created), undefined, 'this server keeps no session of its own for it');

  await json(await f.host('/api/connectors/self/private-sessions', { sessions: [record(sessionId, { activity: 'done' })] }));
  const notified = f.sqlite.prepare('SELECT kind, forwarded_session_id AS session_id FROM notifications WHERE user_id = ?').all(f.alice.user.id) as { kind: string; session_id: string }[];
  assert.deepEqual(notified.map(row => [row.kind, row.session_id]), [['finished', sessionId]], 'its owner hears it finished');

  const bob = await f.signIn('bob');
  assert.equal((await bob.request('GET', `/api/sessions/${sessionId}/view`)).status, 404, 'nobody else reaches it');
  assert.ok(!(await json<{ sessions: SessionRecord[] }>(await bob.request('GET', '/api/sessions'))).sessions.some(item => item.id === sessionId));

  f.sqlite.prepare("UPDATE connectors SET connection_hash = NULL WHERE id = 'host'").run();
  const offline = (await json<{ sessions: SessionRecord[] }>(await f.alice.request('GET', '/api/sessions'))).sessions.find(item => item.id === sessionId);
  assert.deepEqual(offline?.forwarded, { hostName: 'Alice\'s Mac', online: false }, 'still listed while its computer is offline');
  assert.equal((await json<{ code: string }>(await f.alice.request('GET', `/api/sessions/${sessionId}/view`), 503)).code, 'computer_offline');
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

function cleanup(t: TestContext): (step: () => unknown) => void {
  const steps: Array<() => unknown> = [];
  t.after(async () => {
    const failures: unknown[] = [];
    for (const step of steps.reverse()) {
      try { await step(); } catch (error) { failures.push(error); }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'The test could not clean up after itself');
  });
  return step => { steps.push(step); };
}

function stopHome(home: PrivateHome, taken: () => { release(): Promise<void> } | undefined): () => Promise<void> {
  return async () => {
    const stopping = home.stop();
    await taken()?.release();
    await stopping;
  };
}

test('a headless Pikibun on this computer is found, answers forwarded requests only with its secret and only for its private sessions, and hands over', async t => {
  const later = cleanup(t);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'private-home-')));
  later(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, 'server');
  const { state, release } = await openLocalState(stateDir, { port: await freePort() });
  let handedOver = false;
  const server = await startLocalServer({ stateDir, state, release, mode: 'local', headless: true, onHandover: () => { handedOver = true; void server.close(); } });
  later(() => server.close().catch(() => {}));
  await assert.rejects(openLocalState(stateDir), LocalStateBusyError);
  const found = await readDiscovery(stateDir);
  assert.ok(found?.headless);
  assert.equal(found.origin, server.origin);

  const owner = await server.env.DB.query<{ id: string }>('SELECT user_id AS id FROM personal_workspaces').first();
  assert.deepEqual((await server.env.DB.query<{ id: string }>('SELECT id FROM users').all()).map(row => row.id), [owner!.id]);
  const workspace = await server.env.DB.query<{ workspace_id: string }>('SELECT workspace_id FROM personal_workspaces WHERE user_id = ?').bind(owner!.id).first();
  assert.ok(workspace, 'its owner and private workspace exist before anyone signs in');
  const db = server.env.DB;
  await db.query("INSERT INTO workspaces (id, name, owner_id, created_at) VALUES ('team', 'Team', ?, '2026-01-01')").bind(owner!.id).run();
  await db.query(`INSERT INTO connectors (id, owner_id, name, credential_hash, models_json, capabilities_json, created_at)
    VALUES ('local-host', ?, 'This computer', ?, '[]', '{}', '2026-01-01')`).bind(owner!.id, 'h'.repeat(43)).run();
  await db.query(`INSERT INTO models (id, workspace_id, name, provider, model_id, connector_id, connector_owner_id, created_at)
    VALUES ('local-model', ?, 'Model', 'anthropic', 'claude-test', 'local-host', ?, '2026-01-01')`).bind(workspace!.workspace_id, owner!.id).run();
  await db.query("INSERT INTO agents (id, author_id, created_at) VALUES ('agent', ?, '2026-01-01')").bind(owner!.id).run();
  await db.query(`INSERT INTO agent_versions (id, agent_id, author_id, workspace_id, version, name, description, instructions, tools_json, model_id, created_at)
    VALUES ('version', 'agent', ?, ?, 1, 'Agent', '', '', '[]', 'local-model', '2026-01-01')`).bind(owner!.id, workspace!.workspace_id).run();
  const insert = (id: string, workspaceId: string) => db.query(`INSERT INTO sessions (id, workspace_id, owner_id, agent_version_id, title, policy_version, status, created_at,
    connector_id, connector_owner_id, repositories_json, visibility, repository_mode)
    VALUES (?, ?, ?, 'version', 'Mine', 1, 'ready', '2026-01-01', 'local-host', ?, '[]', 'workspace', 'clone')`).bind(id, workspaceId, owner!.id, owner!.id).run();
  await insert('private-one', workspace!.workspace_id);
  await insert('team-one', 'team');

  const call = (path: string, secret?: string, method = 'GET') => fetch(`${server.origin}${path}`, { method,
    headers: { Origin: server.origin, ...(secret ? { [PRIVATE_FORWARD_HEADER]: secret } : {}) } });
  assert.equal((await call('/api/private-sessions')).status, 401);
  assert.equal((await call('/api/private-sessions', 'x'.repeat(43))).status, 401, 'only with the secret its discovery file holds');
  assert.equal((await call('/api/me', found.secret)).status, 403, 'and only for the routes it forwards');
  assert.equal((await call('/api/sessions/team-one', found.secret)).status, 404, 'and only for its private workspace\'s sessions');
  const read = await call('/api/sessions/private-one', found.secret);
  assert.equal(read.status, 200, await read.clone().text());
  const archived = await call('/api/sessions/private-one/archive', found.secret, 'POST');
  assert.equal(archived.status, 200, `it acts as its owner: ${await archived.clone().text()}`);

  const home = createPrivateHome({ localModels: { manifest: async () => [] } as never }, { stateDir, retryMs: 50 });
  let taken: { release(): Promise<void> } | undefined;
  later(stopHome(home, () => taken));
  const listed = await home.sessions(AbortSignal.timeout(5000));
  assert.deepEqual(listed?.map(item => [(item as SessionRecord).id, (item as SessionRecord).status]), [['private-one', 'archived']],
    'a second process finds the running one and lists its private sessions');
  const one = await home.forward({ method: 'GET', path: '/api/sessions/private-one' }, AbortSignal.timeout(5000));
  assert.equal(one.status, 200);
  assert.equal((JSON.parse(Buffer.from(one.data, 'base64').toString()) as { session: SessionRecord }).session.id, 'private-one');

  taken = await openLocalStateTakingOver(stateDir, {}, 10_000);
  assert.ok(handedOver, 'pikibun serve takes the state over from a headless one');
  assert.equal(await readDiscovery(stateDir), undefined);
  await assert.rejects(home.forward({ method: 'GET', path: '/api/private-sessions' }, AbortSignal.timeout(2000)));
  assert.equal(await home.sessions(AbortSignal.timeout(2000)), null);
});

test('a private home that was already waiting for the lease does not take it from a hand-over in progress', async t => {
  const later = cleanup(t);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'private-home-')));
  later(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, 'server');
  const { state, release } = await openLocalState(stateDir, { port: await freePort() });
  const server = await startLocalServer({ stateDir, state, release, mode: 'local', headless: true, onHandover: () => { void server.close(); } });
  later(() => server.close().catch(() => {}));
  const home = createPrivateHome({ localModels: { manifest: async () => [] } as never }, { stateDir, retryMs: 50 });
  let taken: { release(): Promise<void> } | undefined;
  later(stopHome(home, () => taken));
  await delay(500);
  taken = await openLocalStateTakingOver(stateDir, {}, 10_000);
  await server.close();
  assert.equal(await readDiscovery(stateDir), undefined, 'the home started no server of its own in the lease it was waiting for');
});
