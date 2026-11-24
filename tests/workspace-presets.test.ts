import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { app } from '../apps/server/src/index.js';
import type { Env } from '../apps/server/src/types.js';
import { defaultExtensionIntegrity, defaultWorkspaceExtensions, starterWorkspaceExtensions, type WorkspaceExtension } from '../packages/shared/src/host-extensions.js';
import { pikiSessionToolExtensions, sessionToolsOff } from '../packages/shared/src/piki-extensions.js';
import { defaultWorkspacePreset, isWorkspacePreset, workspacePreset, workspacePresets } from '../packages/shared/src/workspace-presets.js';
import { testDatabase } from './helpers/control-plane.js';

const origin = 'http://localhost:8787';
const token = () => randomBytes(32).toString('base64url');

async function fixture(t: TestContext) {
  const database = await testDatabase();
  t.after(() => database.db.close());
  const env: Env = { DB: database.db, APP_ORIGIN: origin, SESSION_SECRET: token(), RUNNER_SHARED_SECRET: token(), TEST_AUTH_ENABLED: 'true', TEST_AUTH_SECRET: token(),
    TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600_000).toISOString(), VAULT_KEY: token() };
  async function client(id: string) {
    const login = await app.request(`${origin}/api/auth/test`, { method: 'POST', body: JSON.stringify({ id }),
      headers: { Authorization: `Bearer ${env.TEST_AUTH_SECRET}`, 'Content-Type': 'application/json', Origin: origin } }, env);
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const { csrfToken } = await (await app.request(`${origin}/api/auth/csrf`, { headers: { Cookie: cookie } }, env)).json() as { csrfToken: string };
    const { user } = await login.json() as { user: { id: string } };
    return { user, async request(method: string, path: string, body?: unknown) {
      return app.request(`${origin}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body),
        headers: { Cookie: cookie, Origin: origin, 'x-csrf-token': csrfToken, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) } }, env);
    } };
  }
  return { env, sqlite: database.sqlite, client };
}

async function json<T>(response: Response, status = 200): Promise<T> {
  const text = await response.text();
  assert.equal(response.status, status, text);
  return JSON.parse(text) as T;
}

type Client = Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['client']>>;

async function state(client: Client, id: string) {
  const { policy } = await json<{ policy: { mode: string; domains: string[]; packageRegistries: boolean } }>(await client.request('GET', `/api/workspaces/${id}/network-policy`));
  const { settings } = await json<{ settings: { anyRepository: boolean } }>(await client.request('GET', `/api/workspaces/${id}/github-reach`));
  const { extensions } = await json<{ extensions: WorkspaceExtension[] }>(await client.request('GET', `/api/workspaces/${id}/extensions`));
  return { policy, reach: settings.anyRepository, extensions, on: extensions.filter(item => item.enabled).map(item => item.source) };
}

test('the presets name what a workspace starts with: Open is the default, and each is narrower than the one before', () => {
  assert.deepEqual([...workspacePresets], ['open', 'balanced', 'locked']);
  assert.equal(defaultWorkspacePreset, 'open');
  assert.deepEqual(workspacePreset('open').extensions, starterWorkspaceExtensions);
  assert.deepEqual([workspacePreset('open').network.mode, workspacePreset('balanced').network.mode, workspacePreset('locked').network.mode], ['open', 'allowlist', 'off']);
  assert.deepEqual([workspacePreset('open').githubReach, workspacePreset('balanced').githubReach, workspacePreset('locked').githubReach], [true, true, false]);
  assert.ok(workspacePreset('balanced').extensions.every(source => source.startsWith('piki:') && starterWorkspaceExtensions.includes(source)), 'no third-party package');
  assert.deepEqual(workspacePreset('locked').extensions, ['piki:git']);
  for (const preset of workspacePresets) assert.ok(workspacePreset(preset).extensions.every(source => defaultWorkspaceExtensions.includes(source)), preset);
  assert.equal(isWorkspacePreset('everything'), false);
});

test('a workspace is created as the preset it names, and as Open when it names none', async t => {
  const f = await fixture(t);
  const ada = await f.client('ada');
  const create = async (body: Record<string, unknown>) => (await json<{ workspace: { id: string } }>(await ada.request('POST', '/api/workspaces', body), 201)).workspace.id;

  const open = await state(ada, await create({ name: 'Open' }));
  assert.deepEqual(open.policy, { mode: 'open', domains: [], packageRegistries: true });
  assert.equal(open.reach, true);
  assert.deepEqual(open.on, defaultWorkspaceExtensions.filter(source => starterWorkspaceExtensions.includes(source)));
  assert.equal(open.extensions.find(item => item.source === 'npm:pi-web-access@0.46.0')?.integrity, defaultExtensionIntegrity['npm:pi-web-access@0.46.0']);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM workspace_network_policies').get()!.n, 0, 'Open is the default, so it writes no rows');

  const balanced = await state(ada, await create({ name: 'Balanced', preset: 'balanced' }));
  assert.deepEqual(balanced.policy, { mode: 'allowlist', domains: [], packageRegistries: true });
  assert.equal(balanced.reach, true);
  assert.ok(balanced.on.length > 0 && balanced.on.every(source => source.startsWith('piki:')));
  assert.equal(sessionToolsOff(balanced.extensions).has('node'), false);

  const lockedId = await create({ name: 'Locked', preset: 'locked' });
  const locked = await state(ada, lockedId);
  assert.deepEqual(locked.policy, { mode: 'off', domains: [], packageRegistries: true });
  assert.equal(locked.reach, false);
  assert.deepEqual(locked.on, ['piki:git']);
  assert.ok(['node', 'python', 'workspace', 'sessions', 'github_merge'].every(tool => sessionToolsOff(locked.extensions).has(tool)));
  assert.equal(JSON.parse(String(f.sqlite.prepare("SELECT detail_json FROM audit WHERE action = 'workspace.create' AND workspace_id = ?").get(lockedId)!.detail_json)).preset, 'locked');

  assert.equal((await ada.request('POST', '/api/workspaces', { name: 'Unknown', preset: 'everything' })).status, 400);
});

test('owners and admins apply a preset to a workspace they have: it sets the network, their own reach and the default extensions, and members can\'t', async t => {
  const f = await fixture(t);
  const ada = await f.client('ada'); const bob = await f.client('bob'); const cy = await f.client('cy');
  const { workspace } = await json<{ workspace: { id: string } }>(await ada.request('POST', '/api/workspaces', { name: 'Team', preset: 'locked' }), 201);
  await json(await ada.request('POST', `/api/workspaces/${workspace.id}/members`, { userId: bob.user.id, role: 'admin' }));
  await json(await ada.request('POST', `/api/workspaces/${workspace.id}/members`, { userId: cy.user.id, role: 'member' }));
  const path = `/api/workspaces/${workspace.id}/preset`;
  await json(await ada.request('PUT', `/api/workspaces/${workspace.id}/extensions`, { source: 'piki:rust' }));
  await json(await ada.request('PUT', `/api/workspaces/${workspace.id}/extensions`, { source: 'piki:context-files', enabled: false, settings: { 'context-files': 'AGENTS.md' } }));

  assert.equal((await cy.request('POST', path, { preset: 'open' })).status, 403);
  assert.equal((await ada.request('POST', path, { preset: 'everything' })).status, 400);
  assert.equal((await ada.request('POST', path, { preset: 'open', extra: true })).status, 400);
  assert.equal((await (await f.client('outsider')).request('POST', path, { preset: 'open' })).status, 404);
  assert.deepEqual((await state(ada, workspace.id)).policy.mode, 'off', 'a refused request changes nothing');

  const applied = await json<{ preset: string; policy: { mode: string }; githubReach: { anyRepository: boolean }; extensions: WorkspaceExtension[] }>(await bob.request('POST', path, { preset: 'open' }));
  assert.deepEqual([applied.preset, applied.policy.mode, applied.githubReach.anyRepository], ['open', 'open', true]);
  const open = await state(ada, workspace.id);
  assert.equal(open.policy.mode, 'open');
  assert.equal(open.reach, false, 'a preset sets only the reach of whoever applied it: the owner turned theirs off by creating it locked');
  assert.equal((await state(bob, workspace.id)).reach, true);
  for (const source of starterWorkspaceExtensions) assert.ok(open.on.includes(source), source);
  assert.ok(open.on.includes('piki:rust'), 'Open turns nothing off');
  assert.deepEqual(open.extensions.find(item => item.source === 'piki:context-files')?.settings, { 'context-files': 'AGENTS.md' }, 'an extension it turns on keeps its settings');
  const audit = JSON.parse(String(f.sqlite.prepare("SELECT detail_json FROM audit WHERE action = 'workspace.preset.applied' AND actor_id = ?").get(bob.user.id)!.detail_json));
  assert.deepEqual([audit.preset, audit.network, audit.githubReach], ['open', 'open', true]);

  await json(await ada.request('PUT', `/api/workspaces/${workspace.id}/extensions`, { source: 'npm:cc-safety-net@2.7.2', enabled: true }));
  await json(await ada.request('POST', path, { preset: 'balanced' }));
  const balanced = await state(ada, workspace.id);
  assert.deepEqual(balanced.policy, { mode: 'allowlist', domains: [], packageRegistries: true });
  assert.equal(balanced.reach, true);
  assert.ok(balanced.on.every(source => source.startsWith('piki:')), `third-party packages are turned off: ${balanced.on.join()}`);
  assert.ok(balanced.on.includes('piki:rust'), 'Pikibun\'s own stay on');
  assert.ok(balanced.extensions.some(item => item.source === 'npm:cc-safety-net@2.7.2' && !item.enabled), 'turned off, not removed');

  await json(await ada.request('PUT', `/api/workspaces/${workspace.id}/extensions`, { source: 'piki:pr-flow', enabled: true }));
  await json(await ada.request('POST', path, { preset: 'balanced' }));
  assert.ok((await state(ada, workspace.id)).on.includes('piki:pr-flow'), 'only third-party packages (npm: and git:) are turned off');

  await json(await ada.request('POST', path, { preset: 'locked' }));
  const locked = await state(ada, workspace.id);
  assert.deepEqual([locked.policy.mode, locked.reach, locked.on], ['off', false, ['piki:git']]);
  assert.equal((await state(bob, workspace.id)).reach, true, 'another member\'s reach is theirs');
});

test('a preset locks web access to its digest in a workspace from before, and adds nothing past the workspace\'s 32 extensions', async t => {
  const f = await fixture(t);
  const ada = await f.client('ada');
  const webAccess = 'npm:pi-web-access@0.46.0';
  const create = async (name: string) => (await json<{ workspace: { id: string } }>(await ada.request('POST', '/api/workspaces', { name }), 201)).workspace.id;

  const before = await create('Before');
  f.sqlite.prepare("UPDATE workspace_extensions SET enabled = 0, integrity = NULL WHERE workspace_id = ? AND package_key = 'npm:pi-web-access'").run(before);
  assert.equal((await state(ada, before)).extensions.find(item => item.source === webAccess)?.integrity, undefined);
  await json(await ada.request('POST', `/api/workspaces/${before}/preset`, { preset: 'open' }));
  const opened = (await state(ada, before)).extensions.find(item => item.source === webAccess);
  assert.deepEqual([opened?.enabled, opened?.integrity], [true, defaultExtensionIntegrity[webAccess]], 'without the digest a sandboxed host would never fetch it');

  const other = await create('Another version');
  f.sqlite.prepare("UPDATE workspace_extensions SET source = 'npm:pi-web-access@0.45.0', enabled = 0, integrity = NULL WHERE workspace_id = ? AND package_key = 'npm:pi-web-access'").run(other);
  await json(await ada.request('POST', `/api/workspaces/${other}/preset`, { preset: 'open' }));
  assert.equal(f.sqlite.prepare("SELECT integrity FROM workspace_extensions WHERE workspace_id = ? AND package_key = 'npm:pi-web-access'").get(other)!.integrity, null,
    'another version of the package never gets this version\'s digest');

  const full = await create('Full');
  f.sqlite.prepare("DELETE FROM workspace_extensions WHERE workspace_id = ? AND package_key = 'piki:gh'").run(full);
  const sessionTools = new Set(pikiSessionToolExtensions().map(item => item.source));
  const taken = (f.sqlite.prepare('SELECT package_key FROM workspace_extensions WHERE workspace_id = ?').all(full) as { package_key: string }[])
    .filter(row => !sessionTools.has(row.package_key)).length;
  for (let index = taken; index < 32; index++) {
    f.sqlite.prepare("INSERT INTO workspace_extensions (workspace_id, package_key, source, position, enabled, tools_mode, settings_json, updated_by, updated_at) VALUES (?, ?, ?, ?, 1, 'automatic', '{}', ?, ?)")
      .run(full, `npm:filler-${index}`, `npm:filler-${index}@1.0.0`, 100 + index, ada.user.id, new Date().toISOString());
  }
  const rows = () => Number(f.sqlite.prepare('SELECT COUNT(*) AS n FROM workspace_extensions WHERE workspace_id = ?').get(full)!.n);
  const count = rows();
  const refused = await json<{ code: string; error: string }>(await ada.request('POST', `/api/workspaces/${full}/preset`, { preset: 'open' }), 409);
  assert.equal(refused.code, 'extension_limit');
  assert.match(refused.error, /this preset adds piki:gh/);
  assert.equal(rows(), count, 'a refused preset changes nothing');
  assert.equal((await state(ada, full)).policy.mode, 'open');
  await json(await ada.request('POST', `/api/workspaces/${full}/preset`, { preset: 'locked' }));
  assert.equal(rows(), count, 'a preset that adds nothing still applies to a full workspace');
  assert.deepEqual((await state(ada, full)).on, ['piki:git']);
});
