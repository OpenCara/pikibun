import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { app } from '../apps/server/src/index.js';
import type { Env } from '../apps/server/src/types.js';
import type { HostAccountSettings } from '../packages/shared/src/host-account.js';
import { testDatabase } from './helpers/control-plane.js';

const origin = 'http://localhost:8787';
const secret = 'host-account-test-secret-not-for-deployment';

async function fixture(t: TestContext) {
  const { db, sqlite } = await testDatabase();
  t.after(() => db.close());
  const env: Env = { DB: db, APP_ORIGIN: origin, TEST_AUTH_ENABLED: 'true', TEST_AUTH_SECRET: secret,
    TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(), RUNNER_SHARED_SECRET: 'host-account-internal-secret-0123456789',
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
  const owner = await client('ha-owner');
  const member = await client('ha-member');
  const workspace = (await (await owner.request('POST', '/api/workspaces', { name: 'Host account' })).json() as { workspace: { id: string } }).workspace;
  const add = async () => assert.equal((await owner.request('POST', `/api/workspaces/${workspace.id}/members`, { userId: member.user.id, role: 'member' })).status, 200);
  await add();
  return { sqlite, owner, member, add, path: `/api/workspaces/${workspace.id}` };
}

async function settings(response: Response, status = 200): Promise<HostAccountSettings> {
  const value = await response.json() as { settings: HostAccountSettings };
  assert.equal(response.status, status, JSON.stringify(value));
  return value.settings;
}

test('a member\'s account on others\' hosts: off until they turn it on, and off again once they leave the workspace and come back', async t => {
  const f = await fixture(t);
  assert.deepEqual(await settings(await f.member.request('GET', `${f.path}/host-account`)), { othersHosts: false });
  assert.deepEqual(await settings(await f.member.request('PUT', `${f.path}/host-account`, { othersHosts: true })), { othersHosts: true });
  assert.deepEqual(await settings(await f.owner.request('GET', `${f.path}/host-account`)), { othersHosts: false }, 'each member\'s choice is their own');
  const rows = () => f.sqlite.prepare('SELECT COUNT(*) AS n FROM member_host_account WHERE user_id = ?').get(f.member.user.id)!.n;
  assert.equal(rows(), 1);

  assert.equal((await f.owner.request('DELETE', `${f.path}/members/${f.member.user.id}`)).status, 204);
  assert.equal(rows(), 0, 'removing a member removes their consent to share their token');
  await f.add();
  assert.deepEqual(await settings(await f.member.request('GET', `${f.path}/host-account`)), { othersHosts: false }, 're-added, they start off again');
});
