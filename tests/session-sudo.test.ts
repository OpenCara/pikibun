import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { app } from '../apps/server/src/index.js';
import type { ConnectorRelayEnvelope } from '../apps/server/src/connector-transport.js';
import type { Env } from '../apps/server/src/types.js';
import type { ConnectorCredentials, ConnectorPairing } from '../packages/shared/src/connector.js';
import { sha256 } from '../packages/shared/src/crypto.js';
import { parseWorkspaceExtensionsAnswer } from '../packages/shared/src/host-extensions.js';
import type { ModelDefinition, SessionRecord, Workspace } from '../packages/shared/src/types.js';
import { fakeHub, testDatabase } from './helpers/control-plane.js';

const origin = 'http://localhost:8787';
const testSecret = 'session-sudo-test-secret-not-for-deployment';
const manifest = {
  models: [{ provider: 'local-native', modelId: 'local/model-v1', name: 'Local model' }],
  capabilities: { platform: 'linux', sandbox: true, productionShell: false, approvalFree: true, plainGit: true, hostConfig: true, extensions: true },
};
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
type ApiRequest = (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<Response>;
interface Client { user: { id: string }; request: ApiRequest }

async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  return body as T;
}

async function fixture(t: TestContext) {
  const { db, sqlite } = await testDatabase();
  t.after(() => db.close());
  const relayed: { body: Record<string, unknown>; actorId: string; sessionId: string }[] = [];
  const env: Env = { DB: db, APP_ORIGIN: origin, TEST_AUTH_ENABLED: 'true', TEST_AUTH_SECRET: testSecret,
    TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(), VAULT_KEY: Buffer.alloc(32, 9).toString('base64url'),
    CONNECTOR_HUB: fakeHub({ rpc: (_id, envelope: ConnectorRelayEnvelope) => {
      const { ticket, body, path } = envelope.request;
      if (ticket.action === 'create') return Response.json({ ok: true }, { status: 201 });
      if (ticket.action === 'sudo') {
        assert.equal(path, `/v1/sessions/${ticket.sessionId}/sudo`);
        relayed.push({ body: JSON.parse(body), actorId: ticket.actorId, sessionId: ticket.sessionId });
        return Response.json({ answered: true });
      }
      return Response.json({ error: 'Unsupported test relay request' }, { status: 503 });
    } }) };
  const request = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => Promise.resolve(app.request(path, { method,
    headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) }, env));
  async function client(name: string): Promise<Client> {
    const response = await request('POST', '/api/auth/test', { id: name, displayName: name, gitName: name, gitEmail: `${name}@example.test` },
      { Authorization: `Bearer ${testSecret}` });
    const { user } = await json<{ user: { id: string } }>(response);
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const { csrfToken } = await json<{ csrfToken: string }>(await request('GET', '/api/auth/csrf', undefined, { Cookie: cookie }));
    return { user, request: (method, path, body, headers = {}) => request(method, path, body, { Cookie: cookie, 'X-CSRF-Token': csrfToken, ...headers }) };
  }
  const alice = await client('alice'); const bob = await client('bob');
  const personal = (await json<{ workspaces: Workspace[] }>(await alice.request('GET', '/api/workspaces'))).workspaces.find(item => item.personal)!;
  const { workspace: team } = await json<{ workspace: Workspace }>(await alice.request('POST', '/api/workspaces', { name: 'Team' }), 201);
  await json(await alice.request('POST', `/api/workspaces/${team.id}/members`, { userId: bob.user.id, role: 'member' }));
  const { pairing } = await json<{ pairing: ConnectorPairing }>(await alice.request('POST', '/api/connectors/pairings', { name: 'Local Pi', workspaceId: team.id }), 201);
  const { credentials } = await json<{ credentials: ConnectorCredentials }>(await request('POST', `/api/connectors/pairings/${pairing.id}/claim`, { code: pairing.code, ...manifest }), 201);
  const connectionToken = b64(randomBytes(32));
  sqlite.prepare('UPDATE connectors SET connection_hash = ? WHERE id = ?').run(await sha256(connectionToken), credentials.connectorId);
  const start = async (workspaceId: string) => {
    const { models } = await json<{ models: ModelDefinition[] }>(await alice.request('GET', `/api/workspaces/${workspaceId}/models`));
    return (await json<{ session: SessionRecord }>(await alice.request('POST', '/api/sessions', { workspaceId, modelId: models[0]!.id, title: 'Install', visibility: 'private' }), 201)).session;
  };
  const own = await start(personal.id);
  const shared = await start(team.id);
  await json(await alice.request('POST', `/api/sessions/${shared.id}/grants`, { userId: bob.user.id, role: 'collaborator' }));
  const host = { Authorization: `Bearer ${credentials.token}`, 'X-Connection-Token': connectionToken };
  const audit = async (sessionId: string) => (await json<{ events: { actorId: string; action: string; detail: Record<string, unknown> }[] }>(
    await alice.request('GET', `/api/sessions/${sessionId}/audit`))).events.filter(event => event.action.startsWith('session.sudo.'));
  return { request, alice, bob, personal, team, own, shared, host, relayed, audit };
}

test('the host\'s owner answers sudo in their private workspace\'s sessions: the password goes to the host once, and nothing keeps it', async t => {
  const f = await fixture(t);
  const password = 'correct horse battery staple';
  assert.deepEqual(await json(await f.alice.request('POST', `/api/sessions/${f.own.id}/sudo`, { id: 'prompt1', password })), { answered: true });
  assert.equal(f.relayed.length, 1);
  const [sent] = f.relayed;
  assert.equal(sent!.actorId, f.alice.user.id);
  assert.equal(sent!.sessionId, f.own.id);
  assert.equal(sent!.body.id, 'prompt1');
  assert.equal(sent!.body.password, password);
  assert.match(String(sent!.body.nonce), /^[a-f0-9]{32}$/, 'a nonce keeps the ticket\'s body hash from vouching for a guessed password');
  assert.deepEqual(Object.keys(sent!.body).sort(), ['id', 'nonce', 'password']);
  const events = await f.audit(f.own.id);
  assert.deepEqual(events.map(({ action, detail }) => ({ action, detail })), [{ action: 'session.sudo.answered', detail: { promptId: 'prompt1', answered: true } }]);
  assert.ok(!JSON.stringify(events).includes(password), 'the audit log never holds the password');

  await json(await f.alice.request('POST', `/api/sessions/${f.own.id}/sudo`, { id: 'prompt2', decline: true }));
  assert.deepEqual(Object.keys(f.relayed[1]!.body).sort(), ['decline', 'id', 'nonce']);
  assert.equal((await f.audit(f.own.id)).filter(event => event.action === 'session.sudo.declined').length, 1);
});

test('outside the private workspace sudo can only be declined, by the host\'s owner alone, and malformed answers go nowhere', async t => {
  const f = await fixture(t);
  const refused = await f.alice.request('POST', `/api/sessions/${f.shared.id}/sudo`, { id: 'prompt1', password: 'secret' });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json() as { code: string }).code, 'private_workspace_required');
  assert.deepEqual(await json(await f.alice.request('POST', `/api/sessions/${f.shared.id}/sudo`, { id: 'prompt1', decline: true })), { answered: true });
  const collaborator = await f.bob.request('POST', `/api/sessions/${f.shared.id}/sudo`, { id: 'prompt1', decline: true });
  assert.equal(collaborator.status, 403);
  assert.equal((await collaborator.json() as { code: string }).code, 'host_owner_required');
  assert.equal((await f.bob.request('POST', `/api/sessions/${f.own.id}/sudo`, { id: 'prompt1', password: 'x' })).status, 404);
  for (const body of [{ id: 'prompt1' }, { id: 'prompt1', password: 'x', decline: true }, { id: 'p 1', password: 'x' }, { id: 'prompt1', password: 'x\ny' },
    { id: 'prompt1', password: 'x', remember: true }]) {
    assert.equal((await f.alice.request('POST', `/api/sessions/${f.own.id}/sudo`, body)).status, 400, JSON.stringify(body));
  }
  assert.deepEqual(f.relayed.map(item => item.body.decline), [true], 'only the one decline reached the host');
});

test('a host learns which workspace is its owner\'s private one, where its sessions may ask for sudo\'s password', async t => {
  const f = await fixture(t);
  const answer = async (workspaceId: string) => parseWorkspaceExtensionsAnswer(await json(await f.request('POST', '/api/connectors/self/extensions/workspace', { workspaceId }, f.host)));
  assert.equal((await answer(f.personal.id)).ownerPrivate, true);
  assert.equal((await answer(f.team.id)).ownerPrivate, undefined);
});
