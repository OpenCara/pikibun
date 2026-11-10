import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { app } from '../apps/server/src/index.js';
import type { ConnectorRelayEnvelope } from '../apps/server/src/connector-transport.js';
import type { Env } from '../apps/server/src/types.js';
import type { ConnectorCredentials, ConnectorPairing } from '../packages/shared/src/connector.js';
import { sha256 } from '../packages/shared/src/crypto.js';
import type { HostConfig } from '../packages/shared/src/host-config.js';
import type { ModelDefinition, SessionRecord } from '../packages/shared/src/types.js';
import { fakeHub, testDatabase } from './helpers/control-plane.js';

const origin = 'http://localhost:8787';
const testSecret = 'session-tunnels-test-secret-not-for-deployment';
const manifest = {
  models: [{ provider: 'local-native', modelId: 'local/model-v1', name: 'Local model' }],
  capabilities: { platform: 'linux', sandbox: true, productionShell: false, plainGit: true, hostConfig: true },
};
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
type ApiRequest = (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<Response>;
interface Client { user: { id: string }; request: ApiRequest }
type AuditEvent = { actorId: string | null; action: string; detail: Record<string, unknown> };

async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  return body as T;
}

async function fixture(t: TestContext) {
  const { db, sqlite } = await testDatabase();
  t.after(() => db.close());
  const relayed: { action: string; body: unknown; actorId: string }[] = [];
  let online = true;
  const env: Env = { DB: db, APP_ORIGIN: origin, TEST_AUTH_ENABLED: 'true', TEST_AUTH_SECRET: testSecret,
    TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(), VAULT_KEY: Buffer.alloc(32, 9).toString('base64url'),
    CONNECTOR_HUB: fakeHub({ rpc: (_id, envelope: ConnectorRelayEnvelope) => {
      const { ticket, body, path } = envelope.request;
      if (ticket.action === 'create') return Response.json({ ok: true }, { status: 201 });
      if (ticket.action === 'tunnel') {
        assert.equal(path, `/v1/sessions/${ticket.sessionId}/tunnel`);
        relayed.push({ action: ticket.action, body: JSON.parse(body), actorId: ticket.actorId });
        const stopped = online;
        online = false;
        return Response.json({ stopped, ...(stopped ? { url: 'https://quiet-river.trycloudflare.com' } : {}) });
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
  const alice = await client('alice'); const bob = await client('bob'); const carol = await client('carol'); const dave = await client('dave');
  const { workspace } = await json<{ workspace: { id: string } }>(await alice.request('POST', '/api/workspaces', { name: 'Team' }), 201);
  for (const member of [bob, carol, dave]) await json(await alice.request('POST', `/api/workspaces/${workspace.id}/members`, { userId: member.user.id, role: 'member' }));
  const { pairing } = await json<{ pairing: ConnectorPairing }>(await alice.request('POST', '/api/connectors/pairings', { name: 'Local Pi', workspaceId: workspace.id }), 201);
  const { credentials } = await json<{ credentials: ConnectorCredentials }>(await request('POST', `/api/connectors/pairings/${pairing.id}/claim`, { code: pairing.code, ...manifest }), 201);
  const connectionToken = b64(randomBytes(32));
  sqlite.prepare('UPDATE connectors SET connection_hash = ? WHERE id = ?').run(await sha256(connectionToken), credentials.connectorId);
  const { models } = await json<{ models: ModelDefinition[] }>(await alice.request('GET', `/api/workspaces/${workspace.id}/models`));
  const { session } = await json<{ session: SessionRecord }>(await alice.request('POST', '/api/sessions', { workspaceId: workspace.id, modelId: models[0]!.id, title: 'Preview', visibility: 'private' }), 201);
  await json(await alice.request('POST', `/api/sessions/${session.id}/grants`, { userId: bob.user.id, role: 'collaborator' }));
  await json(await alice.request('POST', `/api/sessions/${session.id}/grants`, { userId: dave.user.id, role: 'viewer' }));
  const host = { Authorization: `Bearer ${credentials.token}`, 'X-Connection-Token': connectionToken };
  const report = (body: unknown) => request('POST', '/api/connectors/self/tunnel', body, host);
  const audit = async () => (await json<{ events: AuditEvent[] }>(await alice.request('GET', `/api/sessions/${session.id}/audit`))).events
    .filter(event => event.action.startsWith('session.tunnel.')).reverse();
  const listed = async (client: Client) => (await json<{ sessions: SessionRecord[] }>(await client.request('GET', '/api/sessions'))).sessions.find(item => item.id === session.id);
  return { env, sqlite, request, alice, bob, carol, dave, workspace, session, credentials, host, report, audit, listed, relayed, setOnline(value: boolean) { online = value; } };
}

test('a host reports its sessions\' tunnels: the audit log records each start and stop with the address, and the session list marks them online meanwhile', async t => {
  const f = await fixture(t);
  const expiresAt = new Date(Date.now() + 4 * 3600_000).toISOString();
  await json(await f.report({ sessionId: f.session.id, event: 'started', url: 'https://quiet-river.trycloudflare.com', actorId: f.bob.user.id, expiresAt }));
  assert.deepEqual((await f.listed(f.alice))?.tunnel, { url: 'https://quiet-river.trycloudflare.com', expiresAt });
  assert.deepEqual((await f.listed(f.bob))?.tunnel?.url, 'https://quiet-river.trycloudflare.com', 'everyone the session is shared with sees it online');
  assert.equal(await f.listed(f.carol), undefined);
  const single = await json<{ session: SessionRecord }>(await f.alice.request('GET', `/api/sessions/${f.session.id}`));
  assert.equal(single.session.tunnel?.url, 'https://quiet-river.trycloudflare.com');
  await json(await f.report({ sessionId: f.session.id, event: 'stopped', url: 'https://quiet-river.trycloudflare.com', reason: 'lifetime' }));
  assert.equal((await f.listed(f.alice))?.tunnel, undefined);
  assert.deepEqual((await f.audit()).map(({ actorId, action, detail }) => ({ actorId, action, detail })), [
    { actorId: f.bob.user.id, action: 'session.tunnel.started', detail: { connectorId: f.credentials.connectorId, url: 'https://quiet-river.trycloudflare.com', expiresAt } },
    { actorId: null, action: 'session.tunnel.stopped', detail: { connectorId: f.credentials.connectorId, url: 'https://quiet-river.trycloudflare.com', reason: 'lifetime' } },
  ], 'who started it, and why it stopped');
});

test('a stop reported after a newer start leaves that one\'s mark, an expired one shows nothing, and a host names only its own sessions\' tunnels', async t => {
  const f = await fixture(t);
  const later = new Date(Date.now() + 3600_000).toISOString();
  await json(await f.report({ sessionId: f.session.id, event: 'started', url: 'https://first-one.trycloudflare.com', actorId: f.alice.user.id, expiresAt: later }));
  await json(await f.report({ sessionId: f.session.id, event: 'started', url: 'https://second-one.trycloudflare.com', actorId: f.alice.user.id, expiresAt: later }));
  await json(await f.report({ sessionId: f.session.id, event: 'stopped', url: 'https://first-one.trycloudflare.com', reason: 'replaced' }));
  assert.equal((await f.listed(f.alice))?.tunnel?.url, 'https://second-one.trycloudflare.com');
  f.sqlite.prepare('UPDATE sessions SET tunnel_expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), f.session.id);
  assert.equal((await f.listed(f.alice))?.tunnel, undefined);
  await json(await f.report({ sessionId: f.session.id, event: 'stopped', url: 'https://second-one.trycloudflare.com', reason: 'stop', actorId: 'github:999' }));
  assert.equal((await f.audit()).at(-1)!.actorId, null);
  for (const body of [{ sessionId: f.session.id, event: 'started', url: 'https://evil.example.com', expiresAt: later },
    { sessionId: f.session.id, event: 'started', url: 'https://api.trycloudflare.com', expiresAt: later },
    { sessionId: f.session.id, event: 'stopped', url: 'https://second-one.trycloudflare.com', reason: 'because' }]) {
    assert.equal((await f.report(body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await f.request('POST', '/api/connectors/self/tunnel', { sessionId: f.session.id, event: 'started', url: 'https://x-y.trycloudflare.com', expiresAt: later })).status, 401);
  const audited = (await f.audit()).length;
  assert.equal(audited, 4, 'refused reports leave no audit entry');
});

test('the session panel\'s Stop asks the session\'s host to take its server offline, for those who may write to the session; archiving takes it offline first', async t => {
  const f = await fixture(t);
  const expiresAt = new Date(Date.now() + 3600_000).toISOString();
  await json(await f.report({ sessionId: f.session.id, event: 'started', url: 'https://quiet-river.trycloudflare.com', actorId: f.alice.user.id, expiresAt }));
  assert.equal((await f.dave.request('POST', `/api/sessions/${f.session.id}/tunnel/stop`, {})).status, 403);
  assert.equal((await f.carol.request('POST', `/api/sessions/${f.session.id}/tunnel/stop`, {})).status, 404);
  assert.deepEqual(f.relayed, []);
  assert.deepEqual(await json(await f.bob.request('POST', `/api/sessions/${f.session.id}/tunnel/stop`, {})), { stopped: true });
  assert.deepEqual(f.relayed, [{ action: 'tunnel', body: { action: 'stop' }, actorId: f.bob.user.id }]);
  assert.deepEqual(await json(await f.bob.request('POST', `/api/sessions/${f.session.id}/tunnel/stop`, {})), { stopped: false }, 'nothing was online any more');

  f.setOnline(true);
  await json(await f.report({ sessionId: f.session.id, event: 'started', url: 'https://other-river.trycloudflare.com', actorId: f.alice.user.id, expiresAt }));
  await json(await f.alice.request('POST', `/api/sessions/${f.session.id}/archive`, {}));
  assert.deepEqual({ ...f.sqlite.prepare('SELECT tunnel_url, tunnel_expires_at FROM sessions WHERE id = ?').get(f.session.id) }, { tunnel_url: null, tunnel_expires_at: null });
  await json(await f.report({ sessionId: f.session.id, event: 'started', url: 'https://late-river.trycloudflare.com', actorId: f.alice.user.id, expiresAt }));
  assert.equal((await json<{ session: SessionRecord }>(await f.alice.request('GET', `/api/sessions/${f.session.id}`))).session.tunnel, undefined);
  assert.equal((await f.audit()).at(-1)!.detail.url, 'https://late-river.trycloudflare.com');
  assert.deepEqual(f.relayed.at(-1), { action: 'tunnel', body: { action: 'stop', reason: 'archived' }, actorId: f.alice.user.id });
  assert.equal((await json<{ session: SessionRecord }>(await f.alice.request('GET', `/api/sessions/${f.session.id}`))).session.status, 'archived');
  assert.equal((await f.alice.request('POST', `/api/sessions/${f.session.id}/tunnel/stop`, {})).status, 409);
});

test('a host\'s owner chooses where its cloudflared comes from, or refuses tunnels on it, and the service lifetime; its connector reads both', async t => {
  const f = await fixture(t);
  const path = `/api/connectors/${f.credentials.connectorId}/config`;
  const saved = await json<{ config: HostConfig }>(await f.alice.request('PATCH', path, { tunnel: { source: 'off' }, serviceLifetimeSeconds: 3600 }));
  assert.deepEqual([saved.config.tunnel, saved.config.serviceLifetimeSeconds], [{ source: 'off' }, 3600]);
  for (const invalid of [{ tunnel: { source: 'path', path: 'cloudflared' } }, { serviceLifetimeSeconds: 60 }, { serviceLifetimeSeconds: 86_401 }, { tunnel: { source: 'auto', token: 'x' } }]) {
    assert.equal((await f.alice.request('PATCH', path, invalid)).status, 400, JSON.stringify(invalid));
  }
  const read = await json<{ config: HostConfig }>(await f.request('POST', '/api/connectors/self/config', {}, f.host));
  assert.deepEqual([read.config.tunnel, read.config.serviceLifetimeSeconds], [{ source: 'off' }, 3600]);
  const audited = f.sqlite.prepare(`SELECT detail_json FROM audit WHERE action = 'host.config.updated' ORDER BY created_at DESC, rowid DESC LIMIT 1`).get() as { detail_json: string };
  assert.deepEqual([JSON.parse(audited.detail_json).tunnel, JSON.parse(audited.detail_json).serviceLifetimeSeconds], [{ source: 'off' }, 3600]);
});
