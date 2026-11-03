import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { app } from '../apps/server/src/index.js';
import { sessionExtensionSources } from '../apps/server/src/extensions.js';
import type { Env } from '../apps/server/src/types.js';
import { fakeHub, testDatabase } from './helpers/control-plane.js';
import type { ConnectorCredentials, ConnectorPairing } from '../packages/shared/src/connector.js';
import type { ExtensionAvailability, HostExtensionsReport, WorkspaceExtension } from '../packages/shared/src/host-extensions.js';
import { sha256 } from '../packages/shared/src/crypto.js';

const origin = 'http://localhost:8787';
const testSecret = 'extensions-test-secret-not-for-deployment';
const manifest = {
  models: [{ provider: 'local-native', modelId: 'local/model-v1', name: 'Local model' }],
  capabilities: { platform: 'linux', sandbox: true, productionShell: false, plainGit: true, extensions: true },
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

/** Alice's workspace, where Bob is a member and Carol an admin, and Alice's host, shared there. */
async function team(f: Fixture) {
  const alice = await f.client('alice'); const bob = await f.client('bob'); const carol = await f.client('carol');
  const { workspace } = await json<{ workspace: { id: string } }>(await alice.request('POST', '/api/workspaces', { name: 'Team' }), 201);
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
  assert.deepEqual(await json<Listing>(await s.bob.request('GET', path)), { extensions: [], hosts: [{ id: s.connector.connectorId, name: 'Local Pi', ownerId: s.alice.user.id, ownerName: 'alice' }], admin: false });
  await denied(await s.bob.request('PUT', path, { source: 'npm:pi-memory@0.4.2' }), 403, 'forbidden');
  await denied(await s.alice.request('PUT', path, { source: 'npm:pi-memory@latest' }), 400, 'invalid_extension');
  await denied(await s.alice.request('PUT', path, { source: 'npm:pi-memory@0.4.2', settings: { key: { nested: true } } }), 400, 'invalid_extension');
  await json(await s.alice.request('PUT', path, { source: 'npm:pi-memory@0.4.2' }));
  await json(await s.carol.request('PUT', path, { source: 'npm:cc-safety-net@2.7.2', tools: 'automatic', settings: { strict: true } }));
  // A new version of a package takes its entry's place.
  const changed = await json<Listing>(await s.alice.request('PUT', path, { source: 'npm:pi-memory@0.5.0', enabled: false }));
  assert.deepEqual(changed.extensions, [
    { source: 'npm:pi-memory@0.5.0', enabled: false, tools: 'approval', settings: {} },
    { source: 'npm:cc-safety-net@2.7.2', enabled: true, tools: 'automatic', settings: { strict: true } },
  ]);
  assert.deepEqual((await json<Listing>(await s.bob.request('GET', path))).extensions, changed.extensions);
  await denied(await s.bob.request('DELETE', `${path}?source=npm:pi-memory@0.5.0`), 403, 'forbidden');
  await denied(await s.alice.request('DELETE', `${path}?source=npm:unknown@1.0.0`), 404, 'not_found');
  assert.deepEqual((await json<Listing>(await s.carol.request('DELETE', `${path}?source=${encodeURIComponent('npm:pi-memory@9.9.9')}`))).extensions.map(item => item.source),
    ['npm:cc-safety-net@2.7.2'], 'removing names the package, whatever the version');
  for (let index = 1; index < 32; index++) await json(await s.alice.request('PUT', path, { source: `npm:extension-${index}@1.0.0` }));
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
  // The first sync: what it has, nothing asked for yet.
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
  // Members see where it stands, without its owner's dev paths.
  type Listing = { hosts: { id: string; report?: HostExtensionsReport; availability?: Record<string, ExtensionAvailability> }[] };
  const listed = (await json<Listing>(await s.bob.request('GET', `/api/workspaces/${s.workspaceId}/extensions`))).hosts[0]!;
  assert.deepEqual(listed.report!.installed.map(item => item.source), ['npm:pi-memory@0.3.0']);
  assert.deepEqual(listed.availability!['npm:cc-safety-net@2.7.2'], { status: 'missing' });

  // Only its owner asks; an admin of the workspace can't, and nobody else sees the host's page.
  const requests = `/api/connectors/${id}/extensions/requests`;
  await denied(await s.carol.request('POST', requests, { action: 'install', source: 'npm:cc-safety-net@2.7.2' }), 404, 'not_found');
  await denied(await s.alice.request('POST', requests, { action: 'install', source: 'npm:cc-safety-net@latest' }), 400, 'invalid_extension_request');
  const install = (await json<{ request: { id: string } }>(await s.alice.request('POST', requests, { action: 'install', source: 'npm:cc-safety-net@2.7.2' }), 201)).request;
  assert.equal((await json<{ request: { id: string } }>(await s.alice.request('POST', requests, { action: 'install', source: 'npm:cc-safety-net@2.7.2' }))).request.id, install.id,
    'asking again while it waits is the same request');
  const update = (await json<{ request: { id: string } }>(await s.alice.request('POST', requests, { action: 'install', source: 'npm:pi-memory@0.4.2' }), 201)).request;
  const answer = await json<{ requests: { id: string; action: string; source: string }[] }>(await self(f, s.connector, 'extensions', { report: page.report, results: [] }));
  assert.deepEqual(answer.requests, [{ id: install.id, action: 'install', source: 'npm:cc-safety-net@2.7.2' }, { id: update.id, action: 'install', source: 'npm:pi-memory@0.4.2' }]);
  // It reports how they went: one done, one failed, and an id it never got is ignored.
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

  // A connector that refuses remote installs isn't asked.
  await json(await self(f, s.connector, 'extensions', { report: report([], false), results: [] }));
  await denied(await s.alice.request('POST', requests, { action: 'remove', source: 'npm:cc-safety-net@2.7.2' }), 409, 'remote_installs_off');
});

test('a host\'s sessions get their workspace\'s extensions and its owner\'s switch; tool cards name an extension the session may run', async t => {
  const f = await fixture(t); const s = await team(f);
  await json(await s.alice.request('PUT', `/api/workspaces/${s.workspaceId}/extensions`, { source: 'npm:pi-memory@0.4.2', tools: 'automatic' }));
  await json(await s.alice.request('PUT', `/api/workspaces/${s.workspaceId}/extensions`, { source: 'npm:off@1.0.0', enabled: false }));
  type Answer = { extensions: WorkspaceExtension[]; automaticTools: boolean };
  const ask = (workspaceId: string) => self(f, s.connector, 'extensions/workspace', { workspaceId });
  assert.deepEqual(await json<Answer>(await ask(s.workspaceId)), { extensions: [
    { source: 'npm:pi-memory@0.4.2', enabled: true, tools: 'automatic', settings: {} },
    { source: 'npm:off@1.0.0', enabled: false, tools: 'approval', settings: {} },
  ], automaticTools: false });
  // Only the host's owner turns the switch.
  await denied(await s.carol.request('PATCH', `/api/connectors/${s.connector.connectorId}/extensions`, { automaticTools: true }), 404, 'not_found');
  await json(await s.alice.request('PATCH', `/api/connectors/${s.connector.connectorId}/extensions`, { automaticTools: true }));
  assert.equal((await json<Answer>(await ask(s.workspaceId))).automaticTools, true);
  // A workspace the host isn't connected to isn't its to ask.
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
