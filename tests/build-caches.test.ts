import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { app } from '../apps/server/src/index.js';
import type { Env } from '../apps/server/src/types.js';
import {
  buildCacheEnvAllowed, buildCacheScope, buildCacheWrites, parseBuildCache, parseSessionBuildCaches, sessionBuildCaches, type BuildCacheSender, type BuildCacheWriter,
  type SessionBuildCaches, type StoredBuildCache,
} from '../packages/shared/src/build-caches.js';
import type { ConnectorCredentials, ConnectorPairing } from '../packages/shared/src/connector.js';
import { sha256 } from '../packages/shared/src/crypto.js';
import { defaultHostConfig, parseHostConfig, parseHostConfigChange, readHostConfig } from '../packages/shared/src/host-config.js';
import { roleTools, type ToolGroupSettings } from '../packages/shared/src/tool-groups.js';
import type { ModelDefinition, SessionRecord, Workspace } from '../packages/shared/src/types.js';
import { fakeHub, testDatabase } from './helpers/control-plane.js';

const writer = (change: Partial<BuildCacheWriter> = {}): BuildCacheWriter => ({
  role: 'collaborator', tools: roleTools.collaborator, groupId: null, personal: false, workspaceOwner: false, ...change,
});

test('a session shares a workspace\'s build cache only where its owner can already change every reader\'s sessions', () => {
  const open = { writerGroups: [] };
  assert.equal(buildCacheScope(writer({ role: 'owner', tools: roleTools.owner, workspaceOwner: true }), open), 'shared');
  assert.equal(buildCacheScope(writer({ role: 'admin', tools: roleTools.admin }), open), 'shared');
  assert.equal(buildCacheScope(writer(), open), 'shared', 'collaborators message every session and write files there');
  assert.equal(buildCacheScope(writer({ role: 'member', tools: roleTools.member }), open), 'owner', 'members act in their own sessions only');
  assert.equal(buildCacheScope(writer({ role: 'viewer', tools: roleTools.viewer }), open), 'owner');
  assert.equal(buildCacheScope(writer({ tools: roleTools.collaborator.filter(tool => tool !== 'write'), groupId: 'readers' }), open), 'owner',
    'a collaborator whose group can\'t write files can\'t change anyone\'s sessions');
  assert.equal(buildCacheScope(writer({ role: 'member', tools: roleTools.owner, groupId: 'everything' }), open), 'owner', 'a group gives tools, never the role\'s reach');
  assert.equal(buildCacheScope(writer({ role: 'member', tools: roleTools.member, personal: true }), open), 'shared', 'a private workspace has one person');
  assert.equal(buildCacheScope(writer({ role: 'owner', tools: roleTools.owner, workspaceOwner: true }), open, 'owner'), 'owner', 'a host in owner mode shares nothing');

  const narrowed = { writerGroups: ['builders'] };
  assert.equal(buildCacheScope(writer({ groupId: 'builders' }), narrowed), 'shared');
  assert.equal(buildCacheScope(writer(), narrowed), 'owner', 'writer groups narrow the role rule');
  assert.equal(buildCacheScope(writer({ role: 'admin', tools: roleTools.admin }), narrowed), 'owner');
  assert.equal(buildCacheScope(writer({ role: 'owner', tools: roleTools.owner, workspaceOwner: true }), narrowed), 'shared', 'the workspace owner always writes');
  assert.equal(buildCacheScope(writer({ role: 'member', tools: roleTools.member, groupId: 'builders' }), narrowed), 'owner', 'and never widen it');
  assert.equal(buildCacheScope(writer({ groupId: 'builders' }), { writerGroups: ['deleted-group'] }), 'owner', 'a deleted group leaves the workspace owner, never everyone');

  const caches = [{ name: 'ccache', env: 'CCACHE_DIR', writerGroups: [] }, { name: 'assets', env: 'PARADISE_EXPORT_CACHE', writerGroups: ['builders'] }];
  const self = { kind: 'message', sender: { ...writer(), owns: true }, granted: [] } as const;
  assert.deepEqual(sessionBuildCaches(writer(), caches, 'workspace', self), { caches: [{ name: 'ccache', env: 'CCACHE_DIR', scope: 'shared', access: 'write' },
    { name: 'assets', env: 'PARADISE_EXPORT_CACHE', scope: 'owner', access: 'write' }] });
  assert.deepEqual(sessionBuildCaches(writer(), caches, 'off', self), { caches: [] });
  assert.deepEqual(sessionBuildCaches(writer({ role: null }), caches, 'workspace', self), { caches: [] }, 'someone who left the workspace gets none');
});

test('a message writes a session\'s copy of a build cache only where its sender, and everyone holding a session role there, could already change every reader\'s sessions', () => {
  const sender = (change: Partial<BuildCacheSender> = {}): BuildCacheSender => ({ ...writer(), owns: false, ...change });
  const admin = sender({ role: 'admin', tools: roleTools.admin });
  const member = sender({ role: 'member', tools: roleTools.member });
  const open = { writerGroups: [] };
  assert.equal(buildCacheWrites(admin, open, 'shared'), true);
  assert.equal(buildCacheWrites(sender(), open, 'shared'), true);
  assert.equal(buildCacheWrites(member, open, 'shared'), false, 'a member with a session role of Collaborator on an admin\'s session never writes the shared copy');
  assert.equal(buildCacheWrites(sender({ role: 'member', tools: roleTools.owner, groupId: 'everything' }), open, 'shared'), false, 'whatever their tool group');
  assert.equal(buildCacheWrites(sender({ tools: roleTools.collaborator.filter(tool => tool !== 'write') }), open, 'shared'), false);
  assert.equal(buildCacheWrites(sender({ role: null, tools: [] }), open, 'shared'), false, 'nor does someone outside the workspace');
  assert.equal(buildCacheWrites(admin, { writerGroups: ['builders'] }, 'shared'), false, 'writer groups narrow senders as they narrow owners');
  assert.equal(buildCacheWrites(sender({ groupId: 'builders' }), { writerGroups: ['builders'] }, 'shared'), true);
  assert.equal(buildCacheWrites(sender({ role: 'member', tools: roleTools.member, owns: true }), open, 'owner'), true, 'an owner writes their own copy');
  assert.equal(buildCacheWrites(admin, open, 'owner'), true, 'as does someone whose role messages every session of the workspace');
  assert.equal(buildCacheWrites(member, open, 'owner'), false, 'but not a member with a session role on one of the owner\'s sessions: every session of that owner reads the copy');
  assert.equal(buildCacheWrites(sender({ tools: roleTools.collaborator.filter(tool => tool !== 'write') }), open, 'owner'), false);

  const caches = [{ name: 'ccache', env: 'CCACHE_DIR', writerGroups: [] }];
  const owner = writer({ role: 'admin', tools: roleTools.admin });
  const owning = { ...owner, owns: true };
  const access = (senders: Parameters<typeof sessionBuildCaches>[3], mode: 'workspace' | 'owner' = 'workspace') => sessionBuildCaches(owner, caches, mode, senders).caches.map(cache => `${cache.scope} ${cache.access}`);
  assert.deepEqual(access({ kind: 'message', sender: owning, granted: [] }), ['shared write']);
  assert.deepEqual(access({ kind: 'message', sender: member, granted: [member] }), ['shared read'], 'the member\'s message reads the shared copy and never writes it');
  assert.deepEqual(access({ kind: 'message', sender: member, granted: [] }), ['shared read']);
  assert.deepEqual(access({ kind: 'message', sender: owning, granted: [member] }), ['shared read'],
    'nor does the owner\'s own message while the member holds the role: it runs what the member left in the worktree');
  assert.deepEqual(access({ kind: 'message', sender: owning, granted: [sender()] }), ['shared write'], 'a session role held by someone who writes the copy anyway changes nothing');
  assert.deepEqual(access({ kind: 'none' }), ['shared read'], 'what no message started, such as a service, only reads');
  assert.deepEqual(access({ kind: 'message', sender: owning, granted: [] }, 'owner'), ['owner write']);
  assert.deepEqual(access({ kind: 'message', sender: member, granted: [member] }, 'owner'), ['owner read']);
  assert.deepEqual(access({ kind: 'unknown', possible: [owning, admin, sender()] }), ['shared write'], 'a connector that names no sender gets a copy every possible sender writes');
  assert.deepEqual(access({ kind: 'unknown', possible: [owning, admin, member] }), [], 'and none at all where one of them doesn\'t, since it would mount it writable for them');
});

test('a build cache is a name and a variable the sandbox doesn\'t set, and a host reads only a valid answer', () => {
  assert.deepEqual(parseBuildCache('ccache', { env: 'CCACHE_DIR' }), { name: 'ccache', env: 'CCACHE_DIR', writerGroups: [] });
  assert.deepEqual(parseBuildCache('assets', { env: 'PARADISE_EXPORT_CACHE', writerGroups: ['b', 'a', 'b'] }).writerGroups, ['a', 'b']);
  for (const name of ['', 'Ccache', '-x', 'a'.repeat(41), 'a/b', '../x', 'a b']) assert.throws(() => parseBuildCache(name, { env: 'X' }), /name/, name);
  for (const env of ['PATH', 'HOME', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'PYTHONPATH', 'NODE_OPTIONS', 'GIT_DIR', 'SSH_AUTH_SOCK', 'HTTPS_PROXY', 'TMPDIR',
    'PIKIBUN_TOKEN', 'XDG_CACHE_HOME', 'BASH_ENV', 'LC_ALL', 'SANDBOX_MIRRORS', 'SANDBOX_WORKTREE', 'SDKROOT', 'CLANG_MODULE_CACHE_PATH']) {
    assert.throws(() => parseBuildCache('x', { env }), /sets? themselves/, env);
    assert.equal(buildCacheEnvAllowed(env), false, env);
  }
  for (const env of ['ccache_dir', '1X', 'A-B', 'A'.repeat(65), 7]) assert.throws(() => parseBuildCache('x', { env }), /variable/, String(env));
  assert.throws(() => parseBuildCache('x', { env: 'X', path: '/tmp' }), /takes env and writerGroups/);
  assert.throws(() => parseBuildCache('x', { env: 'X', writerGroups: ['bad id'] }), /tool group ids/);

  assert.deepEqual(parseSessionBuildCaches({ caches: [{ name: 'ccache', env: 'CCACHE_DIR', scope: 'owner', access: 'write' }] }),
    { caches: [{ name: 'ccache', env: 'CCACHE_DIR', scope: 'owner', access: 'write' }] });
  for (const access of [undefined, 'read', 'everything', true]) {
    assert.equal(parseSessionBuildCaches({ caches: [{ name: 'ccache', env: 'CCACHE_DIR', scope: 'shared', access }] }).caches[0]!.access, 'read', `${String(access)}: only an explicit write is writable`);
  }
  for (const value of [null, {}, { caches: {} }, { caches: [{ name: 'x', env: 'PATH', scope: 'owner' }] }, { caches: [{ name: 'x', env: 'X', scope: 'everyone' }] },
    { caches: [{ name: 'x', env: 'X', scope: 'owner' }, { name: 'x', env: 'Y', scope: 'owner' }] }, { caches: [{ name: 'x', env: 'X', scope: 'owner' }, { name: 'y', env: 'X', scope: 'owner' }] },
    { caches: Array.from({ length: 17 }, (_, index) => ({ name: `c${index}`, env: `C${index}`, scope: 'owner' })) }]) {
    assert.throws(() => parseSessionBuildCaches(value), /Invalid build caches/, JSON.stringify(value));
  }
});

test('a host keeps build caches only once its owner turns them on, within a size limit', () => {
  assert.equal(defaultHostConfig.buildCaches, 'off');
  assert.equal(defaultHostConfig.buildCacheGiB, 20);
  assert.deepEqual(parseHostConfigChange({ buildCaches: 'workspace', buildCacheGiB: 100, commandTimeoutUnlimited: false }), { buildCaches: 'workspace', buildCacheGiB: 100, commandTimeoutUnlimited: false });
  for (const change of [{ buildCaches: 'on' }, { buildCaches: true }, { buildCacheGiB: 0, commandTimeoutUnlimited: false }, { buildCacheGiB: 10_001 }, { buildCacheGiB: 1.5 }, { buildCacheGiB: '20' }]) {
    assert.throws(() => parseHostConfigChange(change), JSON.stringify(change));
  }
  assert.throws(() => parseHostConfig({ ...defaultHostConfig, buildCaches: undefined }));
  const older = Object.fromEntries(Object.entries(defaultHostConfig).filter(([key]) => key !== 'buildCaches' && key !== 'buildCacheGiB'));
  assert.deepEqual(readHostConfig(older), { ...defaultHostConfig }, 'an answer from before build caches keeps them off');
});

const origin = 'http://localhost:8787';
const testSecret = 'build-caches-test-secret-not-for-deployment';
const manifest = {
  models: [{ provider: 'local-native', modelId: 'local/model-v1', name: 'Local model' }],
  capabilities: { platform: 'linux', sandbox: true, productionShell: false, approvalFree: true, plainGit: true, hostConfig: true, extensions: true, buildCaches: true },
};

async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  return body as T;
}

type CacheList = { caches: StoredBuildCache[]; admin: boolean };

test('a workspace\'s owners and admins declare build caches, and a host learns for each session which copy it gets', async t => {
  const { db, sqlite } = await testDatabase();
  t.after(() => db.close());
  const env: Env = { DB: db, APP_ORIGIN: origin, TEST_AUTH_ENABLED: 'true', TEST_AUTH_SECRET: testSecret,
    TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(), VAULT_KEY: Buffer.alloc(32, 5).toString('base64url'),
    CONNECTOR_HUB: fakeHub({ rpc: () => Response.json({ ok: true }, { status: 201 }) }) };
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
  const carol = await client('carol');
  const dave = await client('dave');
  const { workspace } = await json<{ workspace: Workspace }>(await alice.request('POST', '/api/workspaces', { name: 'Team' }), 201);
  for (const [person, role] of [[bob, 'member'], [carol, 'collaborator'], [dave, 'admin']] as const) {
    await json(await alice.request('POST', `/api/workspaces/${workspace.id}/members`, { userId: person.user.id, role }));
  }
  const path = `/api/workspaces/${workspace.id}/build-caches`;

  assert.deepEqual((await json<CacheList>(await bob.request('GET', path))).caches, []);
  assert.equal((await bob.request('PUT', `${path}/ccache`, { env: 'CCACHE_DIR' })).status, 403);
  assert.equal((await carol.request('PUT', `${path}/ccache`, { env: 'CCACHE_DIR' })).status, 403);
  for (const [name, body] of [['Bad', { env: 'X' }], ['ccache', { env: 'PATH' }], ['ccache', { env: 'X', other: 1 }], ['ccache', {}], ['ccache', { env: 'X', writerGroups: ['missing'] }]] as const) {
    assert.equal((await alice.request('PUT', `${path}/${name}`, body)).status, 400, `${name} ${JSON.stringify(body)}`);
  }
  const created = await json<CacheList>(await dave.request('PUT', `${path}/ccache`, { env: 'CCACHE_DIR' }), 201);
  assert.deepEqual(created.caches.map(cache => [cache.name, cache.env, cache.writerGroups]), [['ccache', 'CCACHE_DIR', []]]);
  assert.equal((await alice.request('PUT', `${path}/other`, { env: 'CCACHE_DIR' })).status, 409, 'one variable names one cache');
  const groups = await json<ToolGroupSettings>(await alice.request('POST', `/api/workspaces/${workspace.id}/tool-groups`,
    { name: 'Builders', tools: roleTools.collaborator }), 201);
  const builders = groups.groups[0]!.id;
  await json(await alice.request('PUT', `${path}/assets`, { env: 'PARADISE_EXPORT_CACHE', writerGroups: [builders] }), 201);
  assert.deepEqual((await json<CacheList>(await bob.request('GET', path))).caches.map(cache => cache.name), ['assets', 'ccache'], 'members see them');
  await json(await alice.request('PUT', `${path}/ccache`, { env: 'CCACHE_DIR' }));
  for (let index = 0; index < 14; index += 1) await json(await alice.request('PUT', `${path}/c${index}`, { env: `C${index}` }), 201);
  assert.equal((await alice.request('PUT', `${path}/one-more`, { env: 'ONE_MORE' })).status, 409, 'at most 16');
  for (let index = 0; index < 14; index += 1) await json(await alice.request('DELETE', `${path}/c${index}`));
  assert.equal((await alice.request('DELETE', `${path}/c0`)).status, 404);
  assert.equal((await bob.request('DELETE', `${path}/ccache`)).status, 403);
  assert.equal((await (await client('erin')).request('GET', path)).status, 404);

  const { pairing } = await json<{ pairing: ConnectorPairing }>(await alice.request('POST', '/api/connectors/pairings', { name: 'Local Pi', workspaceId: workspace.id }), 201);
  const { credentials } = await json<{ credentials: ConnectorCredentials }>(await request('POST', `/api/connectors/pairings/${pairing.id}/claim`, { code: pairing.code, ...manifest }), 201);
  const connectionToken = Buffer.from(randomBytes(32)).toString('base64url');
  sqlite.prepare('UPDATE connectors SET connection_hash = ? WHERE id = ?').run(await sha256(connectionToken), credentials.connectorId);
  const host = { Authorization: `Bearer ${credentials.token}`, 'X-Connection-Token': connectionToken };
  const { models } = await json<{ models: ModelDefinition[] }>(await alice.request('GET', `/api/workspaces/${workspace.id}/models`));
  const { session } = await json<{ session: SessionRecord }>(await alice.request('POST', '/api/sessions', { workspaceId: workspace.id, modelId: models[0]!.id, title: 'Work' }), 201);
  sqlite.exec('DROP TRIGGER sessions_owner_immutable');
  sqlite.prepare('INSERT INTO connector_shares (connector_id, workspace_id, created_at) VALUES (?, ?, ?)').run(credentials.connectorId, workspace.id, new Date().toISOString());
  const unnamed = Symbol('no sender');
  const answer = async (owner: string, sender: string | null | typeof unnamed = owner) => {
    sqlite.prepare('UPDATE sessions SET owner_id = ? WHERE id = ?').run(owner, session.id);
    return Object.fromEntries((await json<SessionBuildCaches>(await request('POST', '/api/connectors/self/build-caches',
      { sessionId: session.id, ...(sender === unnamed ? {} : { senderId: sender }) }, host))).caches
      .map(cache => [cache.name, cache.access === 'write' ? cache.scope : `${cache.scope} read`]));
  };
  const older = (owner: string) => answer(owner, unnamed);
  assert.deepEqual(await answer(alice.user.id), {}, 'a host keeps none until its owner turns them on');
  await json(await alice.request('PATCH', `/api/connectors/${credentials.connectorId}/config`, { buildCaches: 'workspace' }));
  assert.deepEqual(await answer(alice.user.id), { assets: 'shared', ccache: 'shared' });

  assert.deepEqual(await answer(dave.user.id, bob.user.id), { assets: 'owner read', ccache: 'shared read' }, 'a member\'s message never writes an admin\'s copies');
  assert.deepEqual(await answer(dave.user.id, carol.user.id), { assets: 'owner', ccache: 'shared' }, 'a collaborator\'s does: they message every session');
  assert.deepEqual(await answer(alice.user.id, dave.user.id), { assets: 'shared read', ccache: 'shared' }, 'a sender outside a cache\'s writer groups reads it');
  assert.deepEqual(await answer(bob.user.id, carol.user.id), { assets: 'owner', ccache: 'owner' });
  assert.deepEqual(await answer(dave.user.id, 'test:nobody'), { assets: 'owner read', ccache: 'shared read' }, 'someone outside the workspace writes nothing');
  assert.deepEqual(await answer(dave.user.id, null), { assets: 'owner read', ccache: 'shared read' }, 'what no message started only reads');
  assert.deepEqual(await older(dave.user.id), { assets: 'owner', ccache: 'shared' }, 'an older connector names no sender: everyone who may message this session writes these copies');
  assert.deepEqual(await older(alice.user.id), { ccache: 'shared' }, 'and it gets no copy that one of them doesn\'t write');
  sqlite.prepare('UPDATE sessions SET owner_id = ? WHERE id = ?').run(dave.user.id, session.id);
  await json(await alice.request('POST', `/api/sessions/${session.id}/grants`, { userId: bob.user.id, role: 'collaborator' }));
  assert.deepEqual(await answer(dave.user.id, bob.user.id), { assets: 'owner read', ccache: 'shared read' },
    'a member with a session role of Collaborator on an admin\'s session reads the shared copy and never writes it');
  assert.deepEqual(await answer(dave.user.id), { assets: 'owner read', ccache: 'shared read' }, 'nor does the admin\'s own message there, which runs what the member left');
  assert.deepEqual(await older(dave.user.id), {}, 'an older connector, which would mount them writable for the member, gets none');
  await json(await alice.request('POST', `/api/sessions/${session.id}/grants`, { userId: bob.user.id, role: 'viewer' }));
  assert.deepEqual(await answer(dave.user.id), { assets: 'owner', ccache: 'shared' }, 'a session role that can\'t send messages changes nothing');
  await json(await alice.request('POST', `/api/sessions/${session.id}/grants`, { userId: bob.user.id, role: 'collaborator' }));
  assert.deepEqual(await answer(dave.user.id), { assets: 'owner read', ccache: 'shared read' });
  await json(await alice.request('DELETE', `/api/sessions/${session.id}/grants/${bob.user.id}`));
  assert.deepEqual(await answer(dave.user.id), { assets: 'owner', ccache: 'shared' }, 'once the role is gone the admin writes again');
  assert.deepEqual(await older(dave.user.id), { assets: 'owner', ccache: 'shared' });
  assert.deepEqual(await answer(dave.user.id), { assets: 'owner', ccache: 'shared' }, 'an admin outside the writer groups');
  assert.deepEqual(await answer(carol.user.id), { assets: 'owner', ccache: 'shared' });
  assert.deepEqual(await answer(bob.user.id), { assets: 'owner', ccache: 'owner' });
  await json(await alice.request('PUT', `/api/workspaces/${workspace.id}/members/${carol.user.id}/tool-group`, { groupId: builders }));
  assert.deepEqual(await answer(carol.user.id), { assets: 'shared', ccache: 'shared' });
  await json(await alice.request('PUT', `/api/workspaces/${workspace.id}/members/${bob.user.id}/tool-group`, { groupId: builders }));
  assert.deepEqual(await answer(bob.user.id), { assets: 'owner', ccache: 'owner' }, 'a group never widens a member\'s reach');
  await json(await alice.request('DELETE', `/api/workspaces/${workspace.id}/tool-groups/${builders}`));
  assert.deepEqual(await answer(carol.user.id), { assets: 'owner', ccache: 'shared' }, 'a deleted writer group leaves its cache to the workspace owner');
  assert.deepEqual(await answer(alice.user.id), { assets: 'shared', ccache: 'shared' });
  await json(await alice.request('PATCH', `/api/connectors/${credentials.connectorId}/config`, { buildCaches: 'owner' }));
  assert.deepEqual(await answer(alice.user.id), { assets: 'owner', ccache: 'owner' });
  await json(await alice.request('PATCH', `/api/connectors/${credentials.connectorId}/config`, { buildCaches: 'off' }));
  assert.deepEqual(await answer(alice.user.id), {});

  sqlite.prepare('UPDATE sessions SET owner_id = ? WHERE id = ?').run(alice.user.id, session.id);
  assert.equal((await request('POST', '/api/connectors/self/build-caches', { sessionId: 'missing' }, host)).status, 404);
  assert.equal((await request('POST', '/api/connectors/self/build-caches', { sessionId: session.id, other: 1 }, host)).status, 400);
  assert.equal((await request('POST', '/api/connectors/self/build-caches', { sessionId: session.id }, { Authorization: 'Bearer nope', 'X-Connection-Token': connectionToken })).status, 401);
  const actions = sqlite.prepare("SELECT action FROM audit WHERE action LIKE 'workspace.build_cache.%' ORDER BY rowid").all().map(row => row.action);
  assert.deepEqual(actions.slice(0, 3), ['workspace.build_cache.created', 'workspace.build_cache.created', 'workspace.build_cache.updated']);
  assert.equal(actions.filter(action => action === 'workspace.build_cache.deleted').length, 14);
});
