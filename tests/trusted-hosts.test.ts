import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import { app } from '../apps/server/src/index.js';
import type { Env } from '../apps/server/src/types.js';
import { ownerTrustsHost } from '../apps/server/src/authority/trusted-hosts.js';
import type { TrustedHostsResponse } from '../packages/shared/src/trusted-hosts.js';
import { testDatabase } from './helpers/control-plane.js';

const origin = 'http://localhost:8787';
const secret = 'trusted-hosts-test-secret-not-for-deployment';

async function fixture(t: TestContext) {
  const { db, sqlite } = await testDatabase();
  t.after(() => db.close());
  const env: Env = { DB: db, APP_ORIGIN: origin, TEST_AUTH_ENABLED: 'true', TEST_AUTH_SECRET: secret,
    TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(), RUNNER_SHARED_SECRET: 'trusted-hosts-internal-secret-0123456789',
    VAULT_KEY: Buffer.alloc(32, 7).toString('base64url'), RUNNER_URL: 'https://runner.example.test' };
  async function client(name: string) {
    const login = await app.request('/api/auth/test', { method: 'POST', headers: { Origin: origin, Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
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
  const owner = await client('th-owner');
  const member = await client('th-member');
  const outsider = await client('th-outsider');
  const workspace = (await (await owner.request('POST', '/api/workspaces', { name: 'Trusted hosts' })).json() as { workspace: { id: string } }).workspace;
  assert.equal((await owner.request('POST', `/api/workspaces/${workspace.id}/members`, { userId: member.user.id, role: 'member' })).status, 200);
  const at = new Date().toISOString();
  const host = (id: string, ownerId: string, shared: boolean) => {
    sqlite.prepare('INSERT INTO connectors (id,owner_id,name,credential_hash,created_at,models_json,capabilities_json) VALUES (?,?,?,?,?,?,?)')
      .run(id, ownerId, id, `hash-${id}`, at, '[]', '{}');
    sqlite.prepare('INSERT INTO connector_workspaces (connector_id,workspace_id,created_at) VALUES (?,?,?)').run(id, workspace.id, at);
    if (shared) sqlite.prepare('INSERT INTO connector_shares (connector_id,workspace_id,created_at) VALUES (?,?,?)').run(id, workspace.id, at);
  };
  host('member-host', member.user.id, true);
  host('member-private', member.user.id, false);
  host('owner-host', owner.user.id, true);
  return { env, sqlite, owner, member, outsider };
}

async function hosts(response: Response, status = 200): Promise<string[]> {
  const value = await response.json() as TrustedHostsResponse;
  assert.equal(response.status, status, JSON.stringify(value));
  return value.hosts.map(item => item.connectorId);
}

test('a member trusts only hosts other members shared with them, each on its own, and takes it back', async t => {
  const f = await fixture(t);
  assert.deepEqual(await hosts(await f.owner.request('GET', '/api/trusted-hosts')), [], 'no host is trusted until its user trusts it');
  assert.equal(await ownerTrustsHost(f.env.DB, f.owner.user.id, 'member-host', f.member.user.id), false);

  assert.deepEqual(await hosts(await f.owner.request('PUT', '/api/trusted-hosts/member-host')), ['member-host']);
  assert.deepEqual(await hosts(await f.owner.request('PUT', '/api/trusted-hosts/member-host')), ['member-host'], 'trusting it again changes nothing');
  assert.equal(await ownerTrustsHost(f.env.DB, f.owner.user.id, 'member-host', f.member.user.id), true);
  assert.equal(await ownerTrustsHost(f.env.DB, f.owner.user.id, 'member-host', f.outsider.user.id), false, 'only while the host has the owner it had');
  assert.equal(await ownerTrustsHost(f.env.DB, f.member.user.id, 'member-host', f.member.user.id), false, 'a host\'s owner needs no trust in it');
  assert.deepEqual(await hosts(await f.member.request('GET', '/api/trusted-hosts')), [], 'each person\'s trust is their own');

  for (const [person, connectorId, why] of [
    [f.member, 'member-host', 'their own host'], [f.owner, 'member-private', 'a host not shared with them'], [f.outsider, 'member-host', 'a host of a workspace they aren\'t in'],
    [f.owner, 'missing', 'a host that doesn\'t exist'],
  ] as const) {
    assert.equal((await person.request('PUT', `/api/trusted-hosts/${connectorId}`)).status, 404, why);
  }

  f.sqlite.prepare('UPDATE connectors SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), 'member-host');
  assert.equal(await ownerTrustsHost(f.env.DB, f.owner.user.id, 'member-host', f.member.user.id), false, 'a revoked host gets no token');
  assert.deepEqual(await hosts(await f.owner.request('GET', '/api/trusted-hosts')), []);
  f.sqlite.prepare('UPDATE connectors SET revoked_at = NULL WHERE id = ?').run('member-host');

  assert.deepEqual(await hosts(await f.owner.request('DELETE', '/api/trusted-hosts/member-host')), []);
  assert.equal(await ownerTrustsHost(f.env.DB, f.owner.user.id, 'member-host', f.member.user.id), false);
  assert.deepEqual(await hosts(await f.owner.request('DELETE', '/api/trusted-hosts/member-host')), [], 'untrusting twice is fine');
  const actions = f.sqlite.prepare("SELECT action, actor_id FROM audit WHERE action LIKE 'host.%trusted' ORDER BY rowid").all().map(row => `${row.action} ${row.actor_id}`);
  assert.deepEqual(actions, [`host.trusted ${f.owner.user.id}`, `host.trusted ${f.owner.user.id}`, `host.untrusted ${f.owner.user.id}`]);
});

test('Postgres has the same migration', () => {
  assert.ok(readdirSync(new URL('../apps/server/migrations/postgres/', import.meta.url)).includes('0093_member_trusted_hosts.sql'));
});

test('removing a host for good ends every trust in it', async t => {
  const f = await fixture(t);
  assert.deepEqual(await hosts(await f.owner.request('PUT', '/api/trusted-hosts/member-host')), ['member-host']);
  assert.equal((await f.member.request('DELETE', '/api/connectors/member-host/permanent')).status, 204);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM member_trusted_hosts').get()!.n, 0);
  assert.deepEqual(await hosts(await f.owner.request('GET', '/api/trusted-hosts')), []);
});
