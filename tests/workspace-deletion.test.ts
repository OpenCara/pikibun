import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { app } from '../apps/server/src/index.js';
import type { Env } from '../apps/server/src/types.js';
import { testDatabase } from './helpers/control-plane.js';
import type { Workspace } from '../packages/shared/src/types.js';

const origin = 'http://localhost:8787';
const testSecret = 'workspace-deletion-test-secret-not-for-deployment';

interface Client { user: { id: string }; request(method: string, path: string, body?: unknown): Promise<Response> }

async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  return body as T;
}

async function denied(response: Response, status: number, code: string) {
  assert.equal((await json<{ code: string }>(response, status)).code, code);
}

async function fixture(t: TestContext): Promise<{ sqlite: DatabaseSync; client(name: string): Promise<Client> }> {
  const { db, sqlite } = await testDatabase();
  t.after(() => db.close());
  const env: Env = { DB: db, APP_ORIGIN: origin, TEST_AUTH_ENABLED: 'true',
    TEST_AUTH_SECRET: testSecret, TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(),
    VAULT_KEY: Buffer.alloc(32, 7).toString('base64url') };
  async function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    return app.request(path, { method, headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) }, env);
  }
  async function client(name: string): Promise<Client> {
    const response = await request('POST', '/api/auth/test', { id: name, displayName: name, gitName: name, gitEmail: `${name}@example.test` },
      { Authorization: `Bearer ${testSecret}` });
    const { user } = await json<{ user: { id: string } }>(response);
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const { csrfToken } = await json<{ csrfToken: string }>(await request('GET', '/api/auth/csrf', undefined, { Cookie: cookie }));
    return { user, request: (method, path, body) => request(method, path, body, { Cookie: cookie, 'X-CSRF-Token': csrfToken }) };
  }
  return { sqlite, client };
}

const workspaces = async (client: Client) => (await json<{ workspaces: Workspace[] }>(await client.request('GET', '/api/workspaces'))).workspaces;
const count = (sqlite: DatabaseSync, sql: string, ...values: string[]) => (sqlite.prepare(sql).get(...values) as { n: number }).n;

test('the owner deletes a shared workspace with no sessions, with its settings, and its history stays audited', async t => {
  const f = await fixture(t);
  const alice = await f.client('alice');
  const bob = await f.client('bob');
  const team = (await json<{ workspace: Workspace }>(await alice.request('POST', '/api/workspaces', { name: 'Team' }), 201)).workspace;
  const path = `/api/workspaces/${team.id}`;
  await json(await alice.request('POST', `${path}/members`, { userId: bob.user.id, role: 'admin' }));
  await json(await alice.request('PATCH', path, { name: 'Team two' }));
  await json(await alice.request('PUT', `${path}/invite-link`), 201);
  f.sqlite.prepare("INSERT INTO models (id, workspace_id, name, provider, model_id, created_at) VALUES ('m1', ?, 'Model', 'faux', 'faux', '2026-01-01')").run(team.id);

  await denied(await bob.request('DELETE', path), 403, 'forbidden');
  const outsider = await f.client('carol');
  await denied(await outsider.request('DELETE', path), 404, 'not_found');

  const response = await alice.request('DELETE', path);
  assert.equal(response.status, 204);
  assert.ok(!(await workspaces(alice)).some(item => item.id === team.id));
  assert.ok(!(await workspaces(bob)).some(item => item.id === team.id));
  for (const table of ['workspaces WHERE id', 'workspace_members WHERE workspace_id', 'models WHERE workspace_id', 'workspace_invite_links WHERE workspace_id', 'audit WHERE workspace_id']) {
    assert.equal(count(f.sqlite, `SELECT COUNT(*) AS n FROM ${table} = ?`, team.id), 0, table);
  }
  assert.ok(count(f.sqlite, "SELECT COUNT(*) AS n FROM audit WHERE action = 'workspace.renamed'") >= 1);
  const audited = f.sqlite.prepare("SELECT actor_id AS actorId, detail_json AS detail FROM audit WHERE action = 'workspace.deleted'").all() as { actorId: string; detail: string }[];
  assert.deepEqual(audited.map(row => [row.actorId, JSON.parse(row.detail)]), [[alice.user.id, { workspaceId: team.id, name: 'Team two' }]]);
  await denied(await alice.request('DELETE', path), 404, 'not_found');
});

test('a private workspace, a workspace with sessions and one whose models agents use are kept', async t => {
  const f = await fixture(t);
  const alice = await f.client('alice');
  const [own] = await workspaces(alice);
  await denied(await alice.request('DELETE', `/api/workspaces/${own!.id}`), 409, 'personal_workspace');

  const used = (await json<{ workspace: Workspace }>(await alice.request('POST', '/api/workspaces', { name: 'Used' }), 201)).workspace;
  f.sqlite.prepare("INSERT INTO models (id, workspace_id, name, provider, model_id, created_at) VALUES ('m1', ?, 'Model', 'faux', 'faux', '2026-01-01')").run(used.id);
  f.sqlite.prepare("INSERT INTO agents (id, author_id, created_at) VALUES ('agent', ?, '2026-01-01')").run(alice.user.id);
  f.sqlite.prepare(`INSERT INTO agent_versions (id, agent_id, author_id, workspace_id, version, name, description, instructions, tools_json, model_id, created_at)
    VALUES ('v1', 'agent', ?, NULL, 1, 'Agent', '', '', '[]', 'm1', '2026-01-01')`).run(alice.user.id);
  await denied(await alice.request('DELETE', `/api/workspaces/${used.id}`), 409, 'workspace_in_use');
  assert.equal(count(f.sqlite, 'SELECT COUNT(*) AS n FROM workspaces WHERE id = ?', used.id), 1);
  assert.equal(count(f.sqlite, 'SELECT COUNT(*) AS n FROM audit WHERE workspace_id = ?', used.id), 1);
  assert.equal(count(f.sqlite, "SELECT COUNT(*) AS n FROM audit WHERE action = 'workspace.deleted'"), 0);

  f.sqlite.prepare(`INSERT INTO sessions (id, workspace_id, owner_id, agent_version_id, title, policy_version, status, created_at)
    VALUES ('s1', ?, ?, 'v1', 'Session', 1, 'archived', '2026-01-01')`).run(used.id, alice.user.id);
  await denied(await alice.request('DELETE', `/api/workspaces/${used.id}`), 409, 'workspace_in_use');
  assert.ok((await workspaces(alice)).some(item => item.id === used.id));
});
