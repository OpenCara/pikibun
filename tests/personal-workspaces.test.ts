import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { app } from '../apps/server/src/index.js';
import type { Env } from '../apps/server/src/types.js';
import { ensurePersonalWorkspace } from '../apps/server/src/catalog.js';
import { cloneRepositories } from '../apps/server/src/authority/index.js';
import { testDatabase } from './helpers/control-plane.js';
import type { Workspace } from '../packages/shared/src/types.js';

// Every user's private workspace: made on their first list, pinned first, and theirs alone.
const origin = 'http://localhost:8787';
const testSecret = 'personal-workspaces-test-secret-not-for-deployment';

type ApiRequest = (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Response | Promise<Response>;
interface Client { user: { id: string }; request: ApiRequest }

async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  return body as T;
}

async function denied(response: Response, status: number, code: string) {
  const body = await json<{ code: string }>(response, status);
  assert.equal(body.code, code);
}

async function fixture(t: TestContext): Promise<{ env: Env; sqlite: DatabaseSync; client(name: string): Promise<Client> }> {
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
    return { user, request: (method, path, body, headers = {}) => request(method, path, body, { Cookie: cookie, 'X-CSRF-Token': csrfToken, ...headers }) };
  }
  return { env, sqlite, client };
}

const list = async (client: Client) => (await json<{ workspaces: Workspace[] }>(await client.request('GET', '/api/workspaces'))).workspaces;

test('every user gets one private workspace, listed first, the first time they list their workspaces', async t => {
  const f = await fixture(t);
  const alice = await f.client('alice');
  const bob = await f.client('bob');
  // Nothing exists before the first list.
  assert.equal((f.sqlite.prepare('SELECT COUNT(*) AS n FROM personal_workspaces').get() as { n: number }).n, 0);

  // Two lists at once still make one.
  const [first, second] = await Promise.all([list(alice), list(alice)]);
  assert.deepEqual(first, second);
  assert.equal(first.length, 1);
  const [own] = first;
  assert.deepEqual({ ...own, id: '' }, { id: '', name: 'Private', ownerId: alice.user.id, role: 'owner', personal: true });
  assert.equal((f.sqlite.prepare('SELECT COUNT(*) AS n FROM personal_workspaces WHERE user_id = ?').get(alice.user.id) as { n: number }).n, 1);
  assert.equal((f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'workspace.create' AND workspace_id = ?").get(own.id) as { n: number }).n, 1);

  // Workspaces made, or joined, later follow it: the private one stays pinned first.
  const team = (await json<{ workspace: Workspace }>(await bob.request('POST', '/api/workspaces', { name: 'Team' }), 201)).workspace;
  assert.equal(team.personal, false);
  await json(await bob.request('POST', `/api/workspaces/${team.id}/members`, { userId: alice.user.id, role: 'member' }));
  const later = (await json<{ workspace: Workspace }>(await alice.request('POST', '/api/workspaces', { name: 'Later' }), 201)).workspace;
  assert.deepEqual((await list(alice)).map(item => [item.id, item.personal]), [[own.id, true], [team.id, false], [later.id, false]]);

  // Bob's own is his, not Alice's, and Alice's never shows to him.
  const bobs = await list(bob);
  assert.deepEqual(bobs.map(item => [item.name, item.personal, item.ownerId]), [['Private', true, bob.user.id], ['Team', false, bob.user.id]]);
  assert.ok(!bobs.some(item => item.id === own.id));
  await denied(await bob.request('GET', `/api/workspaces/${own.id}/members`), 404, 'not_found');

  // Asking again finds the same one.
  await ensurePersonalWorkspace(f.env, alice.user.id);
  assert.equal((await list(alice))[0]!.id, own.id);
});

test('a private workspace takes no members and no invite link', async t => {
  const f = await fixture(t);
  const alice = await f.client('alice');
  const bob = await f.client('bob');
  const [own] = await list(alice);
  const path = `/api/workspaces/${own!.id}`;

  for (const role of ['admin', 'collaborator', 'member', 'viewer']) {
    await denied(await alice.request('POST', `${path}/members`, { userId: bob.user.id, role }), 409, 'personal_workspace');
  }
  const members = (await json<{ members: { userId: string; role: string }[] }>(await alice.request('GET', `${path}/members`))).members;
  assert.deepEqual(members.map(item => [item.userId, item.role]), [[alice.user.id, 'owner']]);

  await denied(await alice.request('PUT', `${path}/invite-link`), 409, 'personal_workspace');
  assert.equal((await json<{ link: null }>(await alice.request('GET', `${path}/invite-link`))).link, null);
  assert.equal((f.sqlite.prepare('SELECT COUNT(*) AS n FROM workspace_invite_links').get() as { n: number }).n, 0);

  // Any other workspace still takes members as before.
  const team = (await json<{ workspace: Workspace }>(await alice.request('POST', '/api/workspaces', { name: 'Team' }), 201)).workspace;
  await json(await alice.request('POST', `/api/workspaces/${team.id}/members`, { userId: bob.user.id, role: 'member' }));
});

test('a session in a private workspace needs no source; elsewhere it still does', async t => {
  const f = await fixture(t);
  // A GitHub account: test accounts start sessions without sources anyway.
  const insert = f.sqlite.prepare(`INSERT INTO users (id, github_id, github_login, display_name, git_name, git_email, env_json, auth_kind, created_at)
    VALUES (?, ?, ?, ?, ?, ?, '{}', 'github', '2026-01-01')`);
  insert.run('github:1', '1', 'carol', 'Carol', 'Carol', 'carol@example.test');
  insert.run('github:2', '2', 'dave', 'Dave', 'Dave', 'dave@example.test');
  await ensurePersonalWorkspace(f.env, 'github:1');
  await ensurePersonalWorkspace(f.env, 'github:2');
  const personal = (userId: string) => (f.sqlite.prepare('SELECT workspace_id FROM personal_workspaces WHERE user_id = ?').get(userId) as { workspace_id: string }).workspace_id;

  const resolved = await cloneRepositories(f.env, personal('github:1'), 'github:1');
  assert.equal(resolved.sourceIds, '[]');
  assert.equal(resolved.sourcesOptional, true);
  // Someone else's private workspace isn't theirs to use.
  await assert.rejects(cloneRepositories(f.env, personal('github:2'), 'github:1'), (error: Error & { status?: number }) => error.status === 404);

  // A shared workspace without sources is refused as before.
  f.sqlite.prepare("INSERT INTO workspaces (id, name, owner_id, created_at) VALUES ('team', 'Team', 'github:1', '2026-01-01')").run();
  f.sqlite.prepare("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ('team', 'github:1', 'owner', '2026-01-01')").run();
  await assert.rejects(cloneRepositories(f.env, 'team', 'github:1'), (error: Error & { status?: number }) => error.status === 409);
});
