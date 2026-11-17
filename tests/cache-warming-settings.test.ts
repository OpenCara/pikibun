import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { app } from '../apps/server/src/index.js';
import type { Env } from '../apps/server/src/types.js';
import type { ConnectorCredentials, ConnectorPairing } from '../packages/shared/src/connector.js';
import { sha256 } from '../packages/shared/src/crypto.js';
import { parseWorkspaceExtensionsAnswer } from '../packages/shared/src/host-extensions.js';
import type { Workspace } from '../packages/shared/src/types.js';
import { fakeHub, testDatabase } from './helpers/control-plane.js';

const origin = 'http://localhost:8787';
const testSecret = 'cache-warming-test-secret-not-for-deployment';
const manifest = {
  models: [{ provider: 'local-native', modelId: 'local/model-v1', name: 'Local model' }],
  capabilities: { platform: 'linux', sandbox: true, productionShell: false, approvalFree: true, plainGit: true, hostConfig: true, extensions: true },
};

async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  return body as T;
}

test('a workspace\'s owners and admins choose how its hosts warm prompt caches, members see it, and hosts learn it with the workspace\'s extensions', async t => {
  const { db, sqlite } = await testDatabase();
  t.after(() => db.close());
  const env: Env = { DB: db, APP_ORIGIN: origin, TEST_AUTH_ENABLED: 'true', TEST_AUTH_SECRET: testSecret,
    TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(), VAULT_KEY: Buffer.alloc(32, 5).toString('base64url'), CONNECTOR_HUB: fakeHub() };
  const request = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => Promise.resolve(app.request(path, { method,
    headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) }, env));
  const client = async (name: string) => {
    const response = await request('POST', '/api/auth/test', { id: name, displayName: name, gitName: name, gitEmail: `${name}@example.test` },
      { Authorization: `Bearer ${testSecret}` });
    const { user } = await json<{ user: { id: string } }>(response);
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const { csrfToken } = await json<{ csrfToken: string }>(await request('GET', '/api/auth/csrf', undefined, { Cookie: cookie }));
    return { user, request: (method: string, path: string, body?: unknown) => request(method, path, body, { Cookie: cookie, 'X-CSRF-Token': csrfToken }) };
  };
  const alice = await client('alice');
  const bob = await client('bob');
  const { workspace } = await json<{ workspace: Workspace }>(await alice.request('POST', '/api/workspaces', { name: 'Team' }), 201);
  await json(await alice.request('POST', `/api/workspaces/${workspace.id}/members`, { userId: bob.user.id, role: 'member' }));
  const path = `/api/workspaces/${workspace.id}/cache-warming`;

  assert.deepEqual(await json(await bob.request('GET', path)), { settings: { mode: 'idle' } }, 'idle until someone chooses');
  assert.equal((await bob.request('PUT', path, { mode: 'off' })).status, 403);
  for (const body of [{ mode: 'always' }, { mode: 'off', other: 1 }, {}]) assert.equal((await alice.request('PUT', path, body)).status, 400, JSON.stringify(body));
  assert.deepEqual(await json(await alice.request('PUT', path, { mode: 'streaming' })), { settings: { mode: 'streaming' } });
  assert.deepEqual(await json(await bob.request('GET', path)), { settings: { mode: 'streaming' } });
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'workspace.cache_warming.updated'").get()!.n, 1);
  const outsider = await client('carol');
  assert.equal((await outsider.request('GET', path)).status, 404);

  const { pairing } = await json<{ pairing: ConnectorPairing }>(await alice.request('POST', '/api/connectors/pairings', { name: 'Local Pi', workspaceId: workspace.id }), 201);
  const { credentials } = await json<{ credentials: ConnectorCredentials }>(await request('POST', `/api/connectors/pairings/${pairing.id}/claim`, { code: pairing.code, ...manifest }), 201);
  const connectionToken = Buffer.from(randomBytes(32)).toString('base64url');
  sqlite.prepare('UPDATE connectors SET connection_hash = ? WHERE id = ?').run(await sha256(connectionToken), credentials.connectorId);
  const host = { Authorization: `Bearer ${credentials.token}`, 'X-Connection-Token': connectionToken };
  const answer = async () => parseWorkspaceExtensionsAnswer(await json(await request('POST', '/api/connectors/self/extensions/workspace', { workspaceId: workspace.id }, host)));
  assert.equal((await answer()).cacheWarming, 'streaming');
  await json(await alice.request('PUT', path, { mode: 'off' }));
  assert.equal((await answer()).cacheWarming, 'off');
});
