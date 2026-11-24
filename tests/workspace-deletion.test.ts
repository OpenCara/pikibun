import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { app } from '../apps/server/src/index.js';
import type { Env } from '../apps/server/src/types.js';
import { sessionAccess } from '../apps/server/src/authority/index.js';
import { runScheduledPrompts } from '../apps/server/src/scheduled-prompts.js';
import { testDatabase } from './helpers/control-plane.js';
import type { DeletedWorkspace, Workspace } from '../packages/shared/src/types.js';

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

async function fixture(t: TestContext): Promise<{ env: Env; sqlite: DatabaseSync; client(name: string): Promise<Client> }> {
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
  return { env, sqlite, client };
}

const workspaces = async (client: Client) => (await json<{ workspaces: Workspace[] }>(await client.request('GET', '/api/workspaces'))).workspaces;
const deletedList = async (client: Client) => (await json<{ workspaces: DeletedWorkspace[] }>(await client.request('GET', '/api/deleted-workspaces'))).workspaces;
const count = (sqlite: DatabaseSync, sql: string, ...values: string[]) => (sqlite.prepare(sql).get(...values) as { n: number }).n;
const create = async (client: Client, name: string) => (await json<{ workspace: Workspace }>(await client.request('POST', '/api/workspaces', { name }), 201)).workspace;

function addSession(sqlite: DatabaseSync, workspaceId: string, ownerId: string, sessionId: string, status = 'ready') {
  sqlite.prepare("INSERT OR IGNORE INTO models (id, workspace_id, name, provider, model_id, created_at) VALUES (?, ?, 'Model', 'faux', 'faux', '2026-01-01')")
    .run(`model-${workspaceId}`, workspaceId);
  sqlite.prepare("INSERT OR IGNORE INTO agents (id, author_id, created_at) VALUES (?, ?, '2026-01-01')").run(`agent-${sessionId}`, ownerId);
  sqlite.prepare(`INSERT INTO agent_versions (id, agent_id, author_id, workspace_id, version, name, description, instructions, tools_json, model_id, created_at)
    VALUES (?, ?, ?, NULL, 1, 'Agent', '', '', '[]', ?, '2026-01-01')`).run(`version-${sessionId}`, `agent-${sessionId}`, ownerId, `model-${workspaceId}`);
  sqlite.prepare(`INSERT INTO sessions (id, workspace_id, owner_id, agent_version_id, title, policy_version, status, created_at)
    VALUES (?, ?, ?, ?, 'Session', 1, ?, '2026-01-01')`).run(sessionId, workspaceId, ownerId, `version-${sessionId}`, status);
}

test('the owner deletes a workspace with sessions: everyone loses it, everything in it is kept, and restoring brings it all back', async t => {
  const f = await fixture(t);
  const alice = await f.client('alice');
  const bob = await f.client('bob');
  const carol = await f.client('carol');
  const team = await create(alice, 'Team');
  const path = `/api/workspaces/${team.id}`;
  await json(await alice.request('POST', `${path}/members`, { userId: bob.user.id, role: 'collaborator' }));
  await json(await alice.request('PUT', `${path}/invite-link`), 201);
  f.sqlite.prepare("INSERT INTO workspace_join_requests (workspace_id, user_id, created_at) VALUES (?, ?, '2026-01-01')").run(team.id, carol.user.id);
  addSession(f.sqlite, team.id, bob.user.id, 's1');
  addSession(f.sqlite, team.id, alice.user.id, 's2', 'archived');
  assert.ok(await sessionAccess(f.env, 's1', alice.user.id));
  const policy = () => (f.sqlite.prepare("SELECT policy_version AS n FROM sessions WHERE id = 's1'").get() as { n: number }).n;
  const before = policy();

  const { workspace: deleted } = await json<{ workspace: DeletedWorkspace }>(await alice.request('DELETE', path));
  assert.deepEqual({ ...deleted, deletedAt: '' }, { id: team.id, name: 'Team', deletedAt: '', deletedBy: alice.user.id, members: 2, sessions: 2 });
  for (const client of [alice, bob]) {
    assert.ok(!(await workspaces(client)).some(item => item.id === team.id));
    await denied(await client.request('GET', `${path}/members`), 404, 'not_found');
    assert.equal(await sessionAccess(f.env, 's1', client.user.id), null);
  }
  await denied(await alice.request('DELETE', path), 404, 'not_found');
  assert.ok(policy() > before);
  assert.equal(count(f.sqlite, 'SELECT COUNT(*) AS n FROM sessions WHERE workspace_id = ?', team.id), 2);
  assert.equal(count(f.sqlite, 'SELECT COUNT(*) AS n FROM models WHERE workspace_id = ?', team.id), 1);
  assert.equal(count(f.sqlite, 'SELECT COUNT(*) AS n FROM workspace_invite_links WHERE workspace_id = ?', team.id), 0);
  assert.equal(count(f.sqlite, 'SELECT COUNT(*) AS n FROM workspace_join_requests WHERE workspace_id = ?', team.id), 0);

  assert.deepEqual((await deletedList(alice)).map(item => item.id), [team.id]);
  assert.deepEqual(await deletedList(bob), []);
  await denied(await bob.request('POST', `/api/deleted-workspaces/${team.id}/restore`), 404, 'not_found');
  await denied(await bob.request('DELETE', `/api/deleted-workspaces/${team.id}`), 404, 'not_found');
  await denied(await alice.request('DELETE', `/api/deleted-workspaces/${team.id}`), 409, 'workspace_in_use');

  const restored = (await json<{ workspace: Workspace }>(await alice.request('POST', `/api/deleted-workspaces/${team.id}/restore`))).workspace;
  assert.deepEqual(restored, { id: team.id, name: 'Team', ownerId: alice.user.id, role: 'owner', personal: false });
  const members = (await json<{ members: { userId: string; role: string }[] }>(await bob.request('GET', `${path}/members`))).members;
  assert.deepEqual(members.map(item => [item.userId, item.role]).sort(), [[alice.user.id, 'owner'], [bob.user.id, 'collaborator']].sort());
  assert.ok(await sessionAccess(f.env, 's1', bob.user.id));
  assert.deepEqual(await deletedList(alice), []);
  assert.equal(count(f.sqlite, 'SELECT COUNT(*) AS n FROM deleted_workspace_members'), 0);
  await denied(await alice.request('POST', `/api/deleted-workspaces/${team.id}/restore`), 404, 'not_found');
  const actions = (f.sqlite.prepare("SELECT action FROM audit WHERE workspace_id = ? AND action LIKE 'workspace.%' ORDER BY created_at, rowid").all(team.id) as { action: string }[])
    .map(row => row.action);
  assert.deepEqual(actions.filter(action => ['workspace.deleted', 'workspace.restored'].includes(action)), ['workspace.deleted', 'workspace.restored']);
});

test('only the owner deletes a workspace, and never their private one', async t => {
  const f = await fixture(t);
  const alice = await f.client('alice');
  const bob = await f.client('bob');
  const outsider = await f.client('carol');
  const team = await create(alice, 'Team');
  await json(await alice.request('POST', `/api/workspaces/${team.id}/members`, { userId: bob.user.id, role: 'admin' }));
  assert.deepEqual(await json(await bob.request('DELETE', `/api/workspaces/${team.id}`), 403), { code: 'forbidden', error: 'Only the workspace owner can delete it.' });
  await denied(await outsider.request('DELETE', `/api/workspaces/${team.id}`), 404, 'not_found');
  const [own] = await workspaces(alice);
  await denied(await alice.request('DELETE', `/api/workspaces/${own!.id}`), 409, 'personal_workspace');
  assert.equal(count(f.sqlite, 'SELECT COUNT(*) AS n FROM deleted_workspaces'), 0);
});

test('a deleted workspace without sessions can be deleted for good; its history stays audited, detached', async t => {
  const f = await fixture(t);
  const alice = await f.client('alice');
  const empty = await create(alice, 'Empty');
  await denied(await alice.request('DELETE', `/api/deleted-workspaces/${empty.id}`), 404, 'not_found');
  await json(await alice.request('DELETE', `/api/workspaces/${empty.id}`));
  assert.equal((await alice.request('DELETE', `/api/deleted-workspaces/${empty.id}`)).status, 204);
  for (const table of ['workspaces WHERE id', 'deleted_workspaces WHERE workspace_id', 'workspace_members WHERE workspace_id', 'audit WHERE workspace_id']) {
    assert.equal(count(f.sqlite, `SELECT COUNT(*) AS n FROM ${table} = ?`, empty.id), 0, table);
  }
  assert.equal(count(f.sqlite, "SELECT COUNT(*) AS n FROM audit WHERE action = 'workspace.deleted'"), 1);
  const purged = f.sqlite.prepare("SELECT actor_id AS actorId, detail_json AS detail FROM audit WHERE action = 'workspace.purged'").all() as { actorId: string; detail: string }[];
  assert.deepEqual(purged.map(row => [row.actorId, JSON.parse(row.detail)]), [[alice.user.id, { workspaceId: empty.id, name: 'Empty' }]]);

  const used = await create(alice, 'Used');
  f.sqlite.prepare("INSERT INTO models (id, workspace_id, name, provider, model_id, created_at) VALUES ('m1', ?, 'Model', 'faux', 'faux', '2026-01-01')").run(used.id);
  f.sqlite.prepare("INSERT INTO agents (id, author_id, created_at) VALUES ('agent', ?, '2026-01-01')").run(alice.user.id);
  f.sqlite.prepare(`INSERT INTO agent_versions (id, agent_id, author_id, workspace_id, version, name, description, instructions, tools_json, model_id, created_at)
    VALUES ('v1', 'agent', ?, NULL, 1, 'Agent', '', '', '[]', 'm1', '2026-01-01')`).run(alice.user.id);
  await json(await alice.request('DELETE', `/api/workspaces/${used.id}`));
  await denied(await alice.request('DELETE', `/api/deleted-workspaces/${used.id}`), 409, 'workspace_in_use');
  assert.deepEqual((await deletedList(alice)).map(item => item.id), [used.id]);
  await json(await alice.request('POST', `/api/deleted-workspaces/${used.id}/restore`));
  assert.ok((await workspaces(alice)).some(item => item.id === used.id));
});

test('a deleted workspace\'s schedules are skipped, not paused, and run again once it is restored', async t => {
  const f = await fixture(t);
  const alice = await f.client('alice');
  const team = await create(alice, 'Team');
  const due = '2030-01-01T08:59:59.000Z';
  f.sqlite.prepare(`INSERT INTO schedules (id, workspace_id, owner_id, created_by, name, cron, time_zone, content, enabled, next_run_at, created_at, updated_at)
    VALUES ('nightly', ?, ?, ?, 'Nightly', '0 9 * * *', 'UTC', 'Triage', 1, ?, ?, ?)`).run(team.id, alice.user.id, alice.user.id, due, due, due);
  await json(await alice.request('DELETE', `/api/workspaces/${team.id}`));
  const outcomes = await runScheduledPrompts(f.env, Date.parse('2030-01-01T09:00:00Z'));
  assert.deepEqual(outcomes.map(outcome => 'error' in outcome ? outcome.error : 'sent'), ['workspace_deleted']);
  const row = f.sqlite.prepare("SELECT enabled, next_run_at AS next FROM schedules WHERE id = 'nightly'").get() as { enabled: number; next: string };
  assert.equal(row.enabled, 1);
  assert.equal(row.next, '2030-01-02T09:00:00.000Z');

  await json(await alice.request('POST', `/api/deleted-workspaces/${team.id}/restore`));
  const again = await runScheduledPrompts(f.env, Date.parse('2030-01-02T09:00:00Z'));
  assert.equal(again.length, 1);
  assert.notEqual('error' in again[0]! ? again[0].error : 'sent', 'workspace_deleted');
});
