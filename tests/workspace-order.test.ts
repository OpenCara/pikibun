import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { app } from '../apps/server/src/index.js';
import type { Env } from '../apps/server/src/types.js';
import { testDatabase } from './helpers/control-plane.js';
import type { Workspace } from '../packages/shared/src/types.js';
import { dropAt, dropIndex, movableIds, moveBy, orderWorkspaces } from '../apps/nsh/src/lib/workspace-order.js';

const origin = 'http://localhost:8787';
const testSecret = 'workspace-order-test-secret-not-for-deployment';

type ApiRequest = (method: string, path: string, body?: unknown) => Response | Promise<Response>;
interface Client { user: { id: string }; request: ApiRequest }

async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  return body as T;
}

async function fixture(t: TestContext): Promise<{ sqlite: DatabaseSync; client(name: string): Promise<Client> }> {
  const { db, sqlite } = await testDatabase();
  t.after(() => db.close());
  const env: Env = { DB: db, APP_ORIGIN: origin, TEST_AUTH_ENABLED: 'true',
    TEST_AUTH_SECRET: testSecret, TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(),
    VAULT_KEY: Buffer.alloc(32, 7).toString('base64url') };
  function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    return app.request(path, { method, headers: { Origin: origin,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) }, env);
  }
  async function client(name: string): Promise<Client> {
    const response = await request('POST', '/api/auth/test', { id: name, displayName: name, gitName: name,
      gitEmail: `${name}@example.test` }, { Authorization: `Bearer ${testSecret}` });
    const { user } = await json<{ user: { id: string } }>(response);
    const cookie = response.headers.get('set-cookie')!.split(';')[0];
    const { csrfToken } = await json<{ csrfToken: string }>(await request('GET', '/api/auth/csrf', undefined, { Cookie: cookie }));
    return { user, request: (method, path, body) => request(method, path, body, { Cookie: cookie, 'X-CSRF-Token': csrfToken }) };
  }
  return { sqlite, client };
}

const list = async (client: Client) => (await json<{ workspaces: Workspace[] }>(await client.request('GET', '/api/workspaces'))).workspaces;
const create = async (client: Client, name: string) =>
  (await json<{ workspace: Workspace }>(await client.request('POST', '/api/workspaces', { name }), 201)).workspace;

test('each member orders their own workspaces, the private one staying first and new ones going last', async t => {
  const f = await fixture(t);
  const alice = await f.client('alice');
  const bob = await f.client('bob');
  const [own] = await list(alice);
  const first = await create(alice, 'First');
  const second = await create(alice, 'Second');
  const team = await create(bob, 'Team');
  await json(await bob.request('POST', `/api/workspaces/${team.id}/members`, { userId: alice.user.id, role: 'member' }));
  assert.deepEqual((await list(alice)).map(item => item.name), ['Private', 'First', 'Second', 'Team']);

  const saved = await json<{ workspaces: Workspace[] }>(await alice.request('PUT', '/api/workspaces/order',
    { workspaceIds: [team.id, own!.id, second.id, 'unknown', first.id] }));
  assert.deepEqual(saved.workspaces.map(item => item.name), ['Private', 'Team', 'Second', 'First']);
  assert.deepEqual((await list(alice)).map(item => item.name), ['Private', 'Team', 'Second', 'First']);
  assert.equal((f.sqlite.prepare('SELECT COUNT(*) AS n FROM workspace_order WHERE user_id = ?').get(alice.user.id) as { n: number }).n, 3);
  assert.deepEqual((await list(bob)).map(item => item.name), ['Private', 'Team']);

  const later = await create(alice, 'Later');
  assert.deepEqual((await list(alice)).map(item => item.name), ['Private', 'Team', 'Second', 'First', 'Later']);
  await json(await alice.request('PUT', '/api/workspaces/order', { workspaceIds: [later.id, first.id] }));
  assert.deepEqual((await list(alice)).map(item => item.name), ['Private', 'Later', 'First', 'Second', 'Team']);

  assert.ok((await bob.request('DELETE', `/api/workspaces/${team.id}/members/${encodeURIComponent(alice.user.id)}`)).ok);
  assert.deepEqual((await list(alice)).map(item => item.name), ['Private', 'Later', 'First', 'Second']);
});

test('the order is checked: a list of distinct workspace IDs and nothing else', async t => {
  const f = await fixture(t);
  const alice = await f.client('alice');
  const own = (await list(alice))[0]!;
  for (const body of [{}, { workspaceIds: 'w1' }, { workspaceIds: [own.id, own.id] }, { workspaceIds: [7] }, { workspaceIds: [], extra: true },
    { workspaceIds: Array.from({ length: 1001 }, (_, index) => `w${index}`) }]) {
    const answer = await json<{ code: string }>(await alice.request('PUT', '/api/workspaces/order', body), 400);
    assert.equal(answer.code, 'invalid_input');
  }
  await json(await alice.request('PUT', '/api/workspaces/order', { workspaceIds: [] }));
});

test('the client orders, moves and drops workspaces as the sidebar shows them', () => {
  const listed = [{ id: 'p', personal: true }, { id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(orderWorkspaces(listed, ['c', 'p', 'a']).map(item => item.id), ['p', 'c', 'a', 'b']);
  assert.deepEqual(movableIds(listed), ['a', 'b', 'c']);
  assert.deepEqual(moveBy(['a', 'b', 'c'], 'a', 1), ['b', 'a', 'c']);
  assert.equal(moveBy(['a', 'b', 'c'], 'a', -1), null);
  assert.equal(moveBy(['a', 'b', 'c'], 'c', 1), null);

  const places = [{ id: 'a', top: 100, height: 40 }, { id: 'b', top: 200, height: 40 }, { id: 'c', top: 300, height: 40 }];
  assert.equal(dropIndex(['a', 'b', 'c'], 'c', places, 50), 0);
  assert.equal(dropIndex(['a', 'b', 'c'], 'c', places, 150), 1);
  assert.equal(dropIndex(['a', 'b', 'c'], 'a', places, 400), 2);
  assert.equal(dropIndex(['a', 'b', 'c'], 'a', places.slice(0, 2), 400), 1);
  assert.equal(dropIndex(['a', 'b', 'c'], 'b', [], 400), 1);
  assert.deepEqual(dropAt(['a', 'b', 'c'], 'c', 0), ['c', 'a', 'b']);
  assert.deepEqual(dropAt(['a', 'b', 'c'], 'a', 2), ['b', 'c', 'a']);
  assert.equal(dropAt(['a', 'b', 'c'], 'b', 1), null);
  assert.equal(dropAt(['a', 'b', 'c'], 'x', 0), null);
});
