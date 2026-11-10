import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { app } from '../apps/server/src/index.js';
import { addDocumentSourceExtension, addPikiExtensions, sessionExtensionSources, workspaceExtensions } from '../apps/server/src/authority/extension-policy.js';
import { documentKindsOff, pikiSessionToolExtensions, sessionToolExtensionOn, sessionToolsOff } from '../packages/shared/src/piki-extensions.js';
import type { Env } from '../apps/server/src/types.js';
import { fakeHub, testDatabase } from './helpers/control-plane.js';
import type { ConnectorCredentials, ConnectorPairing } from '../packages/shared/src/connector.js';
import type { ExtensionAvailability, HostExtensionsReport, WorkspaceExtension } from '../packages/shared/src/host-extensions.js';
import { sha256 } from '../packages/shared/src/crypto.js';
import { defaultWorkspaceExtensions, withSessionToolsListed } from '../packages/shared/src/host-extensions.js';
import { retiredGroupTools } from '../packages/shared/src/tool-groups.js';

const origin = 'http://localhost:8787';
const testSecret = 'extensions-test-secret-not-for-deployment';
const manifest = {
  models: [{ provider: 'local-native', modelId: 'local/model-v1', name: 'Local model' }],
  capabilities: { platform: 'linux', sandbox: true, productionShell: false, approvalFree: true, plainGit: true, extensions: true },
};
const token = () => Buffer.from(randomBytes(32)).toString('base64url');

type ApiRequest = (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Response | Promise<Response>;
interface Client { user: { id: string }; request: ApiRequest }
interface Fixture { sqlite: DatabaseSync; env: Env; request: ApiRequest; client(name: string): Promise<Client> }
type Connected = ConnectorCredentials & { connectionToken: string };

async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  return body as T;
}

async function denied(response: Response, status: number, code: string) {
  assert.equal((await json<{ code: string }>(response, status)).code, code);
}

async function fixture(t: TestContext): Promise<Fixture> {
  const { db, sqlite } = await testDatabase();
  t.after(() => db.close());
  const hub = fakeHub({ rpc: () => Response.json({ error: 'Unsupported test relay request' }, { status: 503 }) });
  const env: Env = { DB: db, APP_ORIGIN: origin, TEST_AUTH_ENABLED: 'true', TEST_AUTH_SECRET: testSecret,
    TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(), VAULT_KEY: Buffer.alloc(32, 7).toString('base64url'), CONNECTOR_HUB: hub };
  function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    return app.request(path, { method, headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) }, env);
  }
  async function client(name: string): Promise<Client> {
    const response = await request('POST', '/api/auth/test', { id: name, displayName: name, gitName: name, gitEmail: `${name}@example.test` },
      { Authorization: `Bearer ${testSecret}` });
    const { user } = await json<{ user: { id: string } }>(response);
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const { csrfToken } = await json<{ csrfToken: string }>(await request('GET', '/api/auth/csrf', undefined, { Cookie: cookie }));
    return { user, request: (method, path, body, headers = {}) => request(method, path, body, { Cookie: cookie, 'X-CSRF-Token': csrfToken, ...headers }) };
  }
  return { sqlite, env, request, client };
}

async function connect(f: Fixture, owner: Client): Promise<Connected> {
  const { pairing } = await json<{ pairing: ConnectorPairing }>(await owner.request('POST', '/api/connectors/pairings', { name: 'Local Pi' }), 201);
  const { credentials } = await json<{ credentials: ConnectorCredentials }>(
    await f.request('POST', `/api/connectors/pairings/${pairing.id}/claim`, { code: pairing.code, ...manifest }), 201);
  const connectionToken = token();
  f.sqlite.prepare('UPDATE connectors SET connection_hash = ? WHERE id = ?').run(await sha256(connectionToken), credentials.connectorId);
  return { ...credentials, connectionToken };
}

function self(f: Fixture, connector: Connected, path: string, body: unknown) {
  return f.request('POST', `/api/connectors/self/${path}`, body, { Authorization: `Bearer ${connector.token}`, 'X-Connection-Token': connector.connectionToken });
}

async function team(f: Fixture) {
  const alice = await f.client('alice'); const bob = await f.client('bob'); const carol = await f.client('carol');
  const { workspace } = await json<{ workspace: { id: string } }>(await alice.request('POST', '/api/workspaces', { name: 'Team' }), 201);
  f.sqlite.prepare('DELETE FROM workspace_extensions WHERE workspace_id = ?').run(workspace.id);
  await json(await alice.request('POST', `/api/workspaces/${workspace.id}/members`, { userId: bob.user.id, role: 'member' }));
  await json(await alice.request('POST', `/api/workspaces/${workspace.id}/members`, { userId: carol.user.id, role: 'admin' }));
  const connector = await connect(f, alice);
  f.sqlite.prepare('INSERT INTO connector_shares (connector_id, workspace_id, created_at) VALUES (?, ?, ?)').run(connector.connectorId, workspace.id, new Date().toISOString());
  return { alice, bob, carol, workspaceId: workspace.id, connector };
}

const report = (installed: HostExtensionsReport['installed'], remoteInstalls = true): HostExtensionsReport => ({ installed, remoteInstalls });
const installed = (source: string, dev = false) => ({ source, dev, modules: [] });

test('a workspace\'s owners and admins choose its extensions, one version of each package in its place; members read them', async t => {
  const f = await fixture(t); const s = await team(f);
  const path = `/api/workspaces/${s.workspaceId}/extensions`;
  type Listing = { extensions: WorkspaceExtension[]; admin: boolean };
  assert.deepEqual(await json<Listing>(await s.bob.request('GET', path)), { extensions: withSessionToolsListed([]), hosts: [{ id: s.connector.connectorId, name: 'Local Pi', ownerId: s.alice.user.id, ownerName: 'alice' }], admin: false });
  await denied(await s.bob.request('PUT', path, { source: 'npm:pi-memory@0.4.2' }), 403, 'forbidden');
  await denied(await s.alice.request('PUT', path, { source: 'npm:pi-memory@latest' }), 400, 'invalid_extension');
  await denied(await s.alice.request('PUT', path, { source: 'npm:pi-memory@0.4.2', settings: { key: { nested: true } } }), 400, 'invalid_extension');
  await json(await s.alice.request('PUT', path, { source: 'npm:pi-memory@0.4.2' }));
  await json(await s.carol.request('PUT', path, { source: 'npm:cc-safety-net@2.7.2', tools: 'automatic', settings: { strict: true } }));
  const changed = await json<Listing>(await s.alice.request('PUT', path, { source: 'npm:pi-memory@0.5.0', enabled: false }));
  assert.deepEqual(changed.extensions, withSessionToolsListed([
    { source: 'npm:pi-memory@0.5.0', enabled: false, tools: 'automatic', settings: {} },
    { source: 'npm:cc-safety-net@2.7.2', enabled: true, tools: 'automatic', settings: { strict: true } },
  ]));
  assert.deepEqual((await json<Listing>(await s.bob.request('GET', path))).extensions, changed.extensions);
  await denied(await s.bob.request('DELETE', `${path}?source=npm:pi-memory@0.5.0`), 403, 'forbidden');
  await denied(await s.alice.request('DELETE', `${path}?source=npm:unknown@1.0.0`), 404, 'not_found');
  assert.deepEqual((await json<Listing>(await s.carol.request('DELETE', `${path}?source=${encodeURIComponent('npm:pi-memory@9.9.9')}`))).extensions.map(item => item.source).filter(source => !source.startsWith('piki:')),
    ['npm:cc-safety-net@2.7.2'], 'removing names the package, whatever the version');
  for (let index = 1; index < 32; index++) await json(await s.alice.request('PUT', path, { source: `npm:extension-${index}@1.0.0` }));
  await denied(await s.alice.request('PUT', path, { source: 'npm:one-too-many@1.0.0' }), 409, 'extension_limit');
  const switched = await json<Listing>(await s.alice.request('PUT', path, { source: 'piki:schedule', enabled: false, tools: 'automatic', settings: { strict: true } }));
  assert.deepEqual(switched.extensions.find(item => item.source === 'piki:schedule'), { source: 'piki:schedule', enabled: false, tools: 'automatic', settings: {} });
  await denied(await s.alice.request('PUT', path, { source: 'piki:files', enabled: false }), 400, 'invalid_extension');
  await denied(await s.alice.request('PUT', path, { source: 'npm:one-too-many@1.0.0' }), 409, 'extension_limit');
  await json(await s.alice.request('PUT', path, { source: 'npm:extension-1@2.0.0' }), 200);
  const audits = f.sqlite.prepare("SELECT action FROM audit WHERE action LIKE 'workspace.extension.%'").all().map(row => row.action);
  assert.equal(audits.filter(action => action === 'workspace.extension.removed').length, 1);
});

test('a host reports its extensions, its owner asks for installs it carries out when it syncs, and workspaces see where it stands', async t => {
  const f = await fixture(t); const s = await team(f);
  const id = s.connector.connectorId;
  await json(await s.alice.request('PUT', `/api/workspaces/${s.workspaceId}/extensions`, { source: 'npm:pi-memory@0.4.2' }));
  await json(await s.alice.request('PUT', `/api/workspaces/${s.workspaceId}/extensions`, { source: 'npm:cc-safety-net@2.7.2' }));
  await json(await s.alice.request('PUT', `/api/workspaces/${s.workspaceId}/extensions`, { source: 'npm:pi-web-search@1.7.0', enabled: false }));
  assert.deepEqual(await json(await self(f, s.connector, 'extensions', { report: report([installed('npm:pi-memory@0.3.0'), installed('local:/home/alice/dev.ts', true)]), results: [] })), { requests: [] });
  await denied(await self(f, s.connector, 'extensions', { report: { installed: [{ source: 'npm:x@latest', dev: false, modules: [] }], remoteInstalls: true }, results: [] }), 400, 'invalid_extensions');

  type HostPage = { role: string; report: HostExtensionsReport; automaticTools: boolean; requests: { id: string; action: string; source: string; status: string; error?: string }[];
    workspaces: { id: string; shared: boolean; extensions: { source: string; availability: ExtensionAvailability }[] }[] };
  const page = await json<HostPage>(await s.alice.request('GET', `/api/connectors/${id}/extensions`));
  assert.equal(page.automaticTools, false);
  assert.deepEqual(page.workspaces, [{ id: s.workspaceId, name: 'Team', shared: true, extensions: [
    { source: 'npm:pi-memory@0.4.2', availability: { status: 'other-version', installed: 'npm:pi-memory@0.3.0' } },
    { source: 'npm:cc-safety-net@2.7.2', availability: { status: 'missing' } },
  ] }], 'only enabled ones, as the workspace uses them');
  assert.equal(page.report.installed.length, 2, 'its owner sees the dev extension');
  type Listing = { hosts: { id: string; report?: HostExtensionsReport; availability?: Record<string, ExtensionAvailability> }[] };
  const listed = (await json<Listing>(await s.bob.request('GET', `/api/workspaces/${s.workspaceId}/extensions`))).hosts[0]!;
  assert.deepEqual(listed.report!.installed.map(item => item.source), ['npm:pi-memory@0.3.0']);
  assert.deepEqual(listed.availability!['npm:cc-safety-net@2.7.2'], { status: 'missing' });

  const requests = `/api/connectors/${id}/extensions/requests`;
  await denied(await s.carol.request('POST', requests, { action: 'install', source: 'npm:cc-safety-net@2.7.2' }), 404, 'not_found');
  await denied(await s.alice.request('POST', requests, { action: 'install', source: 'npm:cc-safety-net@latest' }), 400, 'invalid_extension_request');
  const install = (await json<{ request: { id: string } }>(await s.alice.request('POST', requests, { action: 'install', source: 'npm:cc-safety-net@2.7.2' }), 201)).request;
  assert.equal((await json<{ request: { id: string } }>(await s.alice.request('POST', requests, { action: 'install', source: 'npm:cc-safety-net@2.7.2' }))).request.id, install.id,
    'asking again while it waits is the same request');
  await new Promise(resolve => setTimeout(resolve, 2));
  const update = (await json<{ request: { id: string } }>(await s.alice.request('POST', requests, { action: 'install', source: 'npm:pi-memory@0.4.2' }), 201)).request;
  const answer = await json<{ requests: { id: string; action: string; source: string }[] }>(await self(f, s.connector, 'extensions', { report: page.report, results: [] }));
  assert.deepEqual(answer.requests, [{ id: install.id, action: 'install', source: 'npm:cc-safety-net@2.7.2' }, { id: update.id, action: 'install', source: 'npm:pi-memory@0.4.2' }]);
  assert.deepEqual(await json(await self(f, s.connector, 'extensions', {
    report: report([installed('npm:pi-memory@0.3.0'), installed('npm:cc-safety-net@2.7.2')]),
    results: [{ id: install.id, ok: true }, { id: update.id, ok: false, error: 'npm install failed' }, { id: 'someone-elses', ok: true }],
  })), { requests: [] });
  const after = await json<HostPage>(await s.alice.request('GET', `/api/connectors/${id}/extensions`));
  assert.deepEqual(after.requests.map(item => [item.source, item.status, item.error]).sort(),
    [['npm:cc-safety-net@2.7.2', 'done', undefined], ['npm:pi-memory@0.4.2', 'failed', 'npm install failed']]);
  assert.deepEqual(after.workspaces[0]!.extensions.map(item => item.availability.status), ['other-version', 'installed']);
  assert.deepEqual(f.sqlite.prepare("SELECT action FROM audit WHERE action LIKE 'connector.extension.%' ORDER BY created_at, action").all().map(row => row.action).sort(),
    ['connector.extension.failed', 'connector.extension.installed', 'connector.extension.requested', 'connector.extension.requested']);

  await json(await self(f, s.connector, 'extensions', { report: report([], false), results: [] }));
  await denied(await s.alice.request('POST', requests, { action: 'remove', source: 'npm:cc-safety-net@2.7.2' }), 409, 'remote_installs_off');
});

test('a host reports how its browser stands: its owner sees where it is on the host, its workspaces only how it stands', async t => {
  const f = await fixture(t); const s = await team(f);
  const id = s.connector.connectorId;
  const browser = { source: 'path', state: 'ready', executable: '/home/alice/chromium/chrome', downloadable: true } as const;
  assert.deepEqual(await json(await self(f, s.connector, 'extensions', { report: { ...report([]), browser }, results: [] })), { requests: [] });
  type HostPage = { report: HostExtensionsReport };
  assert.deepEqual((await json<HostPage>(await s.alice.request('GET', `/api/connectors/${id}/extensions`))).report.browser, browser);
  type Listing = { hosts: { id: string; report?: HostExtensionsReport }[] };
  assert.deepEqual((await json<Listing>(await s.bob.request('GET', `/api/workspaces/${s.workspaceId}/extensions`))).hosts[0]!.report!.browser,
    { source: 'path', state: 'ready', downloadable: true });
  const missing = { source: 'path', state: 'missing', error: 'Nothing is at /home/alice/clients/acme/chrome', downloadable: true } as const;
  await json(await self(f, s.connector, 'extensions', { report: { ...report([]), browser: missing }, results: [] }));
  assert.deepEqual((await json<HostPage>(await s.alice.request('GET', `/api/connectors/${id}/extensions`))).report.browser, missing);
  assert.deepEqual((await json<Listing>(await s.bob.request('GET', `/api/workspaces/${s.workspaceId}/extensions`))).hosts[0]!.report!.browser,
    { source: 'path', state: 'missing', downloadable: true });
  for (const invalid of [{ ...browser, state: 'broken' }, { ...browser, error: 'x'.repeat(1025) }, { ...browser, extra: true }]) {
    await denied(await self(f, s.connector, 'extensions', { report: { ...report([]), browser: invalid }, results: [] }), 400, 'invalid_extensions');
  }
  await json(await self(f, s.connector, 'extensions', { report: report([]), results: [] }));
  assert.equal((await json<HostPage>(await s.alice.request('GET', `/api/connectors/${id}/extensions`))).report.browser, undefined);
});

test('a host\'s sessions get their workspace\'s extensions and its owner\'s switch; tool cards name an extension the session may run', async t => {
  const f = await fixture(t); const s = await team(f);
  await json(await s.alice.request('PUT', `/api/workspaces/${s.workspaceId}/extensions`, { source: 'npm:pi-memory@0.4.2', tools: 'automatic' }));
  await json(await s.alice.request('PUT', `/api/workspaces/${s.workspaceId}/extensions`, { source: 'npm:off@1.0.0', enabled: false }));
  type Answer = { extensions: WorkspaceExtension[]; automaticTools: boolean };
  const ask = (workspaceId: string) => self(f, s.connector, 'extensions/workspace', { workspaceId });
  assert.deepEqual(await json<Answer>(await ask(s.workspaceId)), { extensions: [
    { source: 'npm:pi-memory@0.4.2', enabled: true, tools: 'automatic', settings: {} },
    { source: 'npm:off@1.0.0', enabled: false, tools: 'automatic', settings: {} },
  ], automaticTools: false, toolGroups: {
    'test:bob': { name: 'Members', off: ['git_push', 'tunnel', 'github_comment', 'github_issue', 'github_merge', 'schedule', 'sessions', ...retiredGroupTools] },
  } }, 'a member\'s sessions lack the tools their role leaves out, which the host learns with the extensions');
  await denied(await s.carol.request('PATCH', `/api/connectors/${s.connector.connectorId}/extensions`, { automaticTools: true }), 404, 'not_found');
  await json(await s.alice.request('PATCH', `/api/connectors/${s.connector.connectorId}/extensions`, { automaticTools: true }));
  assert.equal((await json<Answer>(await ask(s.workspaceId))).automaticTools, true);
  const dave = await f.client('dave');
  const { workspace: other } = await json<{ workspace: { id: string } }>(await dave.request('POST', '/api/workspaces', { name: 'Other' }), 201);
  await denied(await ask(other.id), 404, 'not_found');

  const sources = await sessionExtensionSources(f.env, { workspace_id: s.workspaceId, owner_id: s.bob.user.id, connector_owner_id: s.alice.user.id });
  assert.deepEqual(['npm:pi-memory@0.4.2', 'npm:off@1.0.0', 'local:/home/alice/dev.ts'].map(sources), [true, false, false]);
  const own = await sessionExtensionSources(f.env, { workspace_id: s.workspaceId, owner_id: s.alice.user.id, connector_owner_id: s.alice.user.id });
  assert.equal(own('local:/home/alice/dev.ts'), true, 'a dev extension in its host owner\'s own session');
});

test('Pikibun extensions: hosts aren\'t asked to install them, and a connector that predates them gets its workspace\'s others', async t => {
  const f = await fixture(t); const s = await team(f);
  const path = `/api/workspaces/${s.workspaceId}/extensions`;
  await json(await s.alice.request('PUT', path, { source: 'piki:gh' }));
  await json(await s.alice.request('PUT', path, { source: 'npm:pi-memory@0.4.2' }));
  await denied(await s.alice.request('POST', `/api/connectors/${s.connector.connectorId}/extensions/requests`, { action: 'install', source: 'piki:gh' }), 400, 'piki_extension');
  type Answer = { extensions: WorkspaceExtension[] };
  const ask = async () => (await json<Answer>(await self(f, s.connector, 'extensions/workspace', { workspaceId: s.workspaceId }))).extensions.map(item => item.source);
  assert.deepEqual(await ask(), ['npm:pi-memory@0.4.2'], 'before a report that names Pikibun extensions');
  await json(await self(f, s.connector, 'extensions', { report: report([installed('npm:pi-memory@0.4.2')]), results: [] }));
  assert.deepEqual(await ask(), ['npm:pi-memory@0.4.2'], 'an older connector would refuse the whole list');
  await json(await self(f, s.connector, 'extensions', { report: report([installed('piki:gh'), installed('piki:glab'), installed('npm:pi-memory@0.4.2')]), results: [] }));
  assert.deepEqual(await ask(), ['piki:gh', 'npm:pi-memory@0.4.2']);
  const listed = await json<{ hosts: { availability?: Record<string, ExtensionAvailability> }[] }>(await s.bob.request('GET', path));
  assert.deepEqual(listed.hosts[0]!.availability!['piki:gh'], { status: 'installed' });
  const sources = await sessionExtensionSources(f.env, { workspace_id: s.workspaceId, owner_id: s.bob.user.id, connector_owner_id: s.alice.user.id });
  assert.deepEqual(['piki:gh', 'piki:glab'].map(sources), [true, false], 'a tool card names one the workspace runs');
});

test('every workspace starts with popular extensions, turned off, and existing ones got them after their own', async t => {
  const f = await fixture(t);
  const alice = await f.client('alice');
  const off = (source: string) => ({ source, enabled: false, tools: 'automatic' as const, settings: {} });
  const expected = ['npm:pi-web-access@0.46.0', 'npm:pi-web-search@1.7.0', 'npm:cc-safety-net@2.7.2'];
  assert.deepEqual(defaultWorkspaceExtensions, expected);
  const { workspace } = await json<{ workspace: { id: string } }>(await alice.request('POST', '/api/workspaces', { name: 'New' }), 201);
  const path = `/api/workspaces/${workspace.id}/extensions`;
  assert.deepEqual((await json<{ extensions: WorkspaceExtension[] }>(await alice.request('GET', path))).extensions, withSessionToolsListed(expected.map(off)));
  const sources = await sessionExtensionSources(f.env, { workspace_id: workspace.id, owner_id: alice.user.id, connector_owner_id: alice.user.id });
  assert.deepEqual(expected.map(sources), [false, false, false]);

  const { workspace: older } = await json<{ workspace: { id: string } }>(await alice.request('POST', '/api/workspaces', { name: 'Older' }), 201);
  const { workspace: full } = await json<{ workspace: { id: string } }>(await alice.request('POST', '/api/workspaces', { name: 'Full' }), 201);
  f.sqlite.prepare('DELETE FROM workspace_extensions WHERE workspace_id IN (?, ?)').run(older.id, full.id);
  await json(await alice.request('PUT', `/api/workspaces/${older.id}/extensions`, { source: 'npm:pi-memory@0.4.2' }));
  await json(await alice.request('PUT', `/api/workspaces/${older.id}/extensions`, { source: 'npm:pi-web-search@1.6.0', enabled: true }));
  for (let index = 0; index < 32; index++) await json(await alice.request('PUT', `/api/workspaces/${full.id}/extensions`, { source: `npm:extension-${index}@1.0.0` }));
  f.sqlite.exec(readFileSync(new URL('../apps/server/migrations/sqlite/0049_default_extensions.sql', import.meta.url), 'utf8'));
  const listed = async (id: string) => (await json<{ extensions: WorkspaceExtension[] }>(await alice.request('GET', `/api/workspaces/${id}/extensions`))).extensions
    .filter(item => !item.source.startsWith('piki:'));
  assert.deepEqual(await listed(older.id), [
    { source: 'npm:pi-memory@0.4.2', enabled: true, tools: 'automatic', settings: {} },
    { source: 'npm:pi-web-search@1.6.0', enabled: true, tools: 'automatic', settings: {} },
    off('npm:pi-web-access@0.46.0'),
    off('npm:cc-safety-net@2.7.2'),
  ]);
  assert.deepEqual(await listed(workspace.id), expected.map(off), 'a workspace that has them is left as it is');
  assert.equal((await listed(full.id)).length, 32, 'a workspace at the limit gets no more');
  const row = f.sqlite.prepare('SELECT updated_by, updated_at FROM workspace_extensions WHERE workspace_id = ? AND package_key = ?').get(older.id, 'npm:pi-web-access') as { updated_by: string; updated_at: string };
  assert.equal(row.updated_by, alice.user.id, 'set by the workspace\'s owner');
  assert.match(row.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('piki:sources, split into one extension per kind of document source, reaches connectors that have only it as whether any kind is on', async () => {
  const { connectorWorkspaceExtensions } = await import('../apps/server/src/extensions.js');
  const entry = (source: string, enabled: boolean) => ({ source, enabled, tools: 'automatic' as const, settings: {} });
  const kinds = ['piki:notion', 'piki:google-drive', 'piki:dropbox', 'piki:onedrive', 'piki:feishu', 'piki:tencent-docs'];
  const older = [{ source: 'piki:gh' }, { source: 'piki:sources' }];
  const current = [...older, ...kinds.map(source => ({ source }))];
  assert.deepEqual(connectorWorkspaceExtensions([entry('piki:notion', false)], current), [entry('piki:notion', false)]);
  assert.deepEqual(connectorWorkspaceExtensions([entry('piki:notion', false)], older), []);
  assert.deepEqual(connectorWorkspaceExtensions([entry('piki:sources', false), entry('piki:notion', true)], older), []);
  assert.deepEqual(connectorWorkspaceExtensions(kinds.map(source => entry(source, false)), older), [entry('piki:sources', false)]);
  assert.deepEqual(connectorWorkspaceExtensions([entry('piki:gh', true), entry('piki:sources', false)], older), [entry('piki:gh', true), entry('piki:sources', false)]);
  assert.deepEqual(connectorWorkspaceExtensions(kinds.map(source => entry(source, false)), [{ source: 'piki:gh' }]), []);
});

test('a workspace at its 32 extensions that turned a session tool off: connectors that have it read all 33, older ones get the 32 (review of #168)', async () => {
  const { connectorWorkspaceExtensions } = await import('../apps/server/src/extensions.js');
  const { parseWorkspaceExtensions, parseWorkspaceExtensionsAnswer } = await import('../packages/shared/src/host-extensions.js');
  const regular = Array.from({ length: 32 }, (_, index) => ({ source: `npm:extension-${index}@1.0.0`, enabled: true, tools: 'automatic' as const, settings: {} }));
  const off = { source: 'piki:schedule', enabled: false, tools: 'automatic' as const, settings: {} };
  const gh = { source: 'piki:gh', enabled: true, tools: 'automatic' as const, settings: {} };
  const all = [...regular, off];
  const current = connectorWorkspaceExtensions(all, [{ source: 'piki:gh' }, { source: 'piki:schedule' }]);
  assert.equal(current.length, 33);
  assert.equal(parseWorkspaceExtensionsAnswer({ extensions: current, automaticTools: false }).extensions.length, 33);
  assert.deepEqual(connectorWorkspaceExtensions(all, [{ source: 'piki:gh' }]).map(item => item.source), regular.map(item => item.source));
  assert.deepEqual(connectorWorkspaceExtensions([...regular.slice(0, 31), gh, off], [{ source: 'npm:extension-0@1.0.0' }]).map(item => item.source), regular.slice(0, 31).map(item => item.source));
  assert.deepEqual(connectorWorkspaceExtensions([gh, off], undefined), [], 'a connector that never reported');
  assert.throws(() => parseWorkspaceExtensions([...regular, { source: 'npm:one-too-many@1.0.0' }]), /Invalid extensions/);
  assert.throws(() => parseWorkspaceExtensions([...regular.slice(1), { source: 'npm:one-too-many@1.0.0' }, { source: 'npm:two-too-many@1.0.0' }, off]), /Invalid extensions/,
    'a session tool\'s place isn\'t one a regular extension can take');
});

test('Pikibun\'s session tools are in no workspace by default: pages and connectors get them listed off until one is added, and removing one turns it off', async t => {
  const f = await fixture(t); const s = await team(f);
  const path = `/api/workspaces/${s.workspaceId}/extensions`;
  const page = async () => (await json<{ extensions: WorkspaceExtension[] }>(await s.bob.request('GET', path))).extensions;
  const entry = (source: string, enabled: boolean) => ({ source, enabled, tools: 'automatic', settings: {} });
  assert.deepEqual(await page(), pikiSessionToolExtensions().filter(item => !item.core && item.source !== 'piki:sources').map(item => entry(item.source, false)));
  for (const source of ['piki:git', 'piki:node', 'piki:github', 'piki:notion', 'piki:schedule', 'piki:tunnel']) assert.equal(sessionToolExtensionOn(await page(), source), false, source);
  assert.equal(sessionToolExtensionOn(await page(), 'piki:files'), true, 'the file tools are always on');

  await json(await self(f, s.connector, 'extensions', { report: report([installed('piki:gh'), installed('piki:schedule'), installed('piki:node'), installed('piki:files')]), results: [] }));
  const { parseWorkspaceExtensionsAnswer } = await import('../packages/shared/src/host-extensions.js');
  const ask = async () => parseWorkspaceExtensionsAnswer(await json(await self(f, s.connector, 'extensions/workspace', { workspaceId: s.workspaceId }))).extensions;
  assert.deepEqual(await ask(), [entry('piki:schedule', false), entry('piki:node', false)]);
  assert.ok(sessionToolsOff(await ask()).has('node') && sessionToolsOff(await ask()).has('schedule'));

  await json(await s.alice.request('PUT', path, { source: 'piki:node' }));
  assert.deepEqual(await ask(), [entry('piki:node', true), entry('piki:schedule', false)]);
  assert.equal(sessionToolsOff(await ask()).has('node'), false);
  assert.equal(sessionToolExtensionOn(await page(), 'piki:node'), true);
  await json(await s.alice.request('DELETE', `${path}?source=${encodeURIComponent('piki:node')}`));
  assert.deepEqual(await ask(), [entry('piki:schedule', false), entry('piki:node', false)]);

  const { workspace } = await json<{ workspace: { id: string } }>(await s.alice.request('POST', '/api/workspaces', { name: 'Fresh' }), 201);
  const fresh = await workspaceExtensions(f.env, workspace.id);
  assert.deepEqual(fresh.filter(item => item.source.startsWith('piki:') && item.enabled), []);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM workspace_extensions WHERE workspace_id = ? AND package_key LIKE 'piki:%'").get(workspace.id)!.n, 0);
});

test('a workspace\'s first repository brings piki:git (and piki:github on GitHub), its first source of a kind that kind\'s extension; one turned off stays off', async t => {
  const f = await fixture(t); const s = await team(f);
  const actor = s.alice.user.id; const workspaceId = s.workspaceId;
  const path = `/api/workspaces/${workspaceId}/extensions`;
  const repository = f.sqlite.prepare(`INSERT INTO workspace_repositories (id, workspace_id, provider, host, repository_id, full_name, ref, private, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'main', 0, '2026-03-01')`);
  repository.run('r1', workspaceId, 'gitlab', 'gitlab.com', '1', 'acme/one');
  assert.deepEqual(await addPikiExtensions(f.env, workspaceId, 'gitlab', actor), ['piki:glab', 'piki:git']);
  repository.run('r2', workspaceId, 'github', 'github.com', '2', 'acme/two');
  assert.deepEqual(await addPikiExtensions(f.env, workspaceId, 'github', actor), ['piki:gh', 'piki:github'], 'piki:git came with the first repository');

  const source = f.sqlite.prepare("INSERT INTO workspace_sources (id, workspace_id, kind, repository_binding_id, created_at) VALUES (?, ?, ?, NULL, '2026-03-01')");
  const detail = f.sqlite.prepare("INSERT INTO document_sources (source_id, workspace_id, kind, item_id, item_type, title, url, created_by) VALUES (?, ?, ?, ?, 'page', 'Specs', 'https://example.test/specs', ?)");
  const addSource = (id: string, kind: string) => { source.run(id, workspaceId, kind); detail.run(id, workspaceId, kind, id, actor); };
  addSource('n1', 'notion');
  assert.deepEqual(await addDocumentSourceExtension(f.env, workspaceId, 'notion', actor), ['piki:notion']);
  assert.deepEqual(await addDocumentSourceExtension(f.env, workspaceId, 'notion', actor), [], 'once');
  await json(await s.alice.request('DELETE', `${path}?source=${encodeURIComponent('piki:notion')}`));
  addSource('n2', 'notion');
  assert.deepEqual(await addDocumentSourceExtension(f.env, workspaceId, 'notion', actor), []);
  await json(await s.alice.request('PUT', path, { source: 'piki:dropbox', enabled: false }));
  addSource('d1', 'dropbox');
  assert.deepEqual(await addDocumentSourceExtension(f.env, workspaceId, 'dropbox', actor), []);
  addSource('g1', 'google-drive');
  assert.deepEqual(await addDocumentSourceExtension(f.env, workspaceId, 'google-drive', actor), ['piki:google-drive']);

  const extensions = await workspaceExtensions(f.env, workspaceId);
  assert.deepEqual([...documentKindsOff(extensions)].sort(), ['dropbox', 'feishu', 'notion', 'onedrive', 'tencent-docs']);
  for (const [source, on] of [['piki:git', true], ['piki:github', true], ['piki:node', false], ['piki:dropbox', false]] as const) {
    assert.equal(sessionToolExtensionOn(extensions, source), on, source);
  }
  const audits = f.sqlite.prepare("SELECT detail_json FROM audit WHERE action = 'workspace.extension.updated'").all().map(row => JSON.parse(String(row.detail_json)));
  assert.deepEqual(audits.filter(item => item.reason).map(item => `${item.source} ${item.reason}`).sort(),
    ['piki:gh repository', 'piki:git repository', 'piki:github repository', 'piki:glab repository', 'piki:google-drive source', 'piki:notion source']);
});
