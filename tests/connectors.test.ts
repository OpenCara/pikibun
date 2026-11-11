import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { HTTPException } from 'hono/http-exception';
import { app } from '../apps/server/src/index.js';
import { authenticateConnectorSocket } from '../apps/server/src/authority/hosts.js';
import { type ConnectorRelayEnvelope } from '../apps/server/src/connector-transport.js';
import type { Env } from '../apps/server/src/types.js';
import { decryptToken, encryptToken } from '../apps/server/src/authority/vault.js';
import { runScheduledPrompts } from '../apps/server/src/scheduled-prompts.js';
import { runAutomaticPacking } from '../apps/server/src/automatic-packing.js';
import { fakeHub, seedAgentVersion, seedSavedAgentSession, testDatabase, type FakeHub } from './helpers/control-plane.js';
import type { ConnectorCredentials, ConnectorInfo, ConnectorPairing, HostCommandGrant, HostModelSettings } from '../packages/shared/src/connector.js';
import type { AgentVersion, GitHubIssueView, ModelDefinition, Operation, RunnerBinding, SessionRecord, SessionView } from '../packages/shared/src/types.js';
import { retiredToolNames, toolNames } from '../packages/shared/src/types.js';
import { sha256 } from '../packages/shared/src/crypto.js';
import { fileUploadLimits } from '../packages/shared/src/file-uploads.js';
import { diffView } from '../packages/shared/src/view-patch.js';
import type { SourceReadView, WorkspaceDocumentSource } from '../packages/shared/src/sources.js';
import { bundledToolDefinitions, parseToolDefinitions } from '../packages/shared/src/tool-definitions.js';
import type { WorkspaceConnection } from '../packages/shared/src/workspace-connections.js';
import { groupTools, type ToolGroupSettings } from '../packages/shared/src/tool-groups.js';

const origin = 'http://localhost:8787';
const testSecret = 'connectors-test-secret-not-for-deployment';
const internalSecret = 'connectors-internal-secret-not-for-deployment';
const githubToken = 'github-vault-secret-never-in-connector-metadata';
const manifest = {
  models: [{ provider: 'local-native', modelId: 'local/model-v1', name: 'Local model' }],
  capabilities: { platform: 'linux', sandbox: true, productionShell: false, approvalFree: true, plainGit: true },
};
const token = () => Buffer.from(randomBytes(32)).toString('base64url');
const changedToken = (value: string) => `${value[0] === 'A' ? 'B' : 'A'}${value.slice(1)}`;

type ApiRequest = (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Response | Promise<Response>;
interface Client {
  user: { id: string };
  cookie: string;
  csrf: string;
  request: ApiRequest;
}
interface Fixture {
  sqlite: DatabaseSync;
  env: Env;
  request: ApiRequest;
  client(name: string): Promise<Client>;
  githubClient(): Promise<Client>;
  queryCount(): number;
  setBeforeQuery(hook?: (sql: string) => void): void;
}
type Connected = ConnectorCredentials & { connectionToken: string; pairing: ConnectorPairing };

async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  return body as T;
}

async function denied(response: Response, status: number, code: string) {
  const body = await json<{ code: string }>(response, status);
  assert.equal(body.code, code);
}

async function fixture(t: TestContext): Promise<Fixture> {
  const { db, sqlite, queryCount, setBeforeQuery } = await testDatabase();
  t.after(() => db.close());
  const env: Env = { DB: db, APP_ORIGIN: origin, TEST_AUTH_ENABLED: 'true',
    TEST_AUTH_SECRET: testSecret, TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(),
    RUNNER_SHARED_SECRET: internalSecret, VAULT_KEY: Buffer.alloc(32, 7).toString('base64url') };
  function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    return app.request(path, { method, headers: { Origin: origin,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) }, env);
  }
  async function browser(user: { id: string }, cookie: string): Promise<Client> {
    const { csrfToken } = await json<{ csrfToken: string }>(await request('GET', '/api/auth/csrf', undefined, { Cookie: cookie }));
    return { user, cookie, csrf: csrfToken,
      request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
        return request(method, path, body, { Cookie: cookie, 'X-CSRF-Token': csrfToken, ...headers });
      } };
  }
  async function client(name: string) {
    const response = await request('POST', '/api/auth/test', { id: name, displayName: name, gitName: name,
      gitEmail: `${name}@example.test` }, { Authorization: `Bearer ${testSecret}` });
    const { user } = await json<{ user: { id: string } }>(response);
    return browser(user, response.headers.get('set-cookie')!.split(';')[0]);
  }
  async function githubClient() {
    const id = 'github:7'; const createdAt = new Date().toISOString(); const cookieToken = token();
    sqlite.prepare('INSERT INTO users (id,github_id,github_login,display_name,git_name,git_email,auth_kind,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, '7', 'creator', 'Creator', 'Creator', 'creator@example.test', 'github', createdAt);
    sqlite.prepare('INSERT INTO auth_sessions (token_hash,user_id,csrf_token,expires_at,created_at) VALUES (?,?,?,?,?)')
      .run(await sha256(cookieToken), id, token(), Date.now() + 3600000, createdAt);
    sqlite.prepare('INSERT INTO github_tokens (user_id,ciphertext,updated_at) VALUES (?,?,?)')
      .run(id, await encryptToken(env, id, githubToken), createdAt);
    return browser({ id }, `test-auth=${cookieToken}`);
  }
  return { sqlite, env, request, client, githubClient, queryCount, setBeforeQuery };
}

async function pairing(owner: Client, name = 'Local Pi', workspaceId?: string) {
  return (await json<{ pairing: ConnectorPairing }>(await owner.request('POST', '/api/connectors/pairings', { name, workspaceId }), 201)).pairing;
}

function claim(f: Fixture, pending: ConnectorPairing, body: unknown = { code: pending.code, ...manifest }, headers: Record<string, string> = {}) {
  return f.request('POST', `/api/connectors/pairings/${pending.id}/claim`, body, headers);
}

async function connect(f: Fixture, owner: Client, workspaceId?: string): Promise<Connected> {
  const pending = await pairing(owner, 'Local Pi', workspaceId);
  const { credentials } = await json<{ credentials: ConnectorCredentials }>(await claim(f, pending), 201);
  const connectionToken = token();
  f.sqlite.prepare('UPDATE connectors SET connection_hash = ? WHERE id = ?').run(await sha256(connectionToken), credentials.connectorId);
  return { ...credentials, connectionToken, pairing: pending };
}

function self(f: Fixture, connector: Connected, path: string, body: unknown, connection: string | null = connector.connectionToken) {
  return f.request('POST', `/api/connectors/self/${path}`, body, { Authorization: `Bearer ${connector.token}`,
    ...(connection === null ? {} : { 'X-Connection-Token': connection }) });
}

async function workspace(owner: Client) {
  return (await json<{ workspace: { id: string } }>(await owner.request('POST', '/api/workspaces', { name: 'Team' }), 201)).workspace;
}

async function addMember(admin: Client, workspaceId: string, member: Client) {
  await json(await admin.request('POST', `/api/workspaces/${workspaceId}/members`, { userId: member.user.id, role: 'member' }));
}

async function allTools(admin: Client, workspaceId: string, ...members: Client[]) {
  const created = await json<ToolGroupSettings>(await admin.request('POST', `/api/workspaces/${workspaceId}/tool-groups`, { name: 'All tools', tools: groupTools }), 201);
  const group = created.groups.find(item => item.name === 'All tools')!;
  for (const member of members) await json(await admin.request('PUT', `/api/workspaces/${workspaceId}/members/${member.user.id}/tool-group`, { groupId: group.id }));
}

async function inGroup(admin: Client, workspaceId: string, member: Client, name: string, tools: string[] = []) {
  let settings = await json<ToolGroupSettings>(await admin.request('GET', `/api/workspaces/${workspaceId}/tool-groups`));
  if (!settings.groups.some(group => group.name === name)) {
    settings = await json<ToolGroupSettings>(await admin.request('POST', `/api/workspaces/${workspaceId}/tool-groups`, { name, tools }), 201);
  }
  const group = settings.groups.find(item => item.name === name)!;
  await json(await admin.request('PUT', `/api/workspaces/${workspaceId}/members/${member.user.id}/tool-group`, { groupId: group.id }));
}

function provisionHub(f: Fixture) {
  const requests: ConnectorRelayEnvelope[] = [];
  const unexpected: string[] = [];
  f.env.CONNECTOR_HUB = fakeHub({ rpc(connectorId, envelope) {
    requests.push(envelope);
    if (envelope.connectorId === connectorId && envelope.request.ticket.action === 'create') return Response.json({ ok: true }, { status: 201 });
    unexpected.push(`rpc ${connectorId} ${envelope.request.ticket.action}`);
    return Response.json({ error: 'Unsupported test relay request' }, { status: 503 });
  } });
  return { requests, unexpected };
}

function rpcHub(f: Fixture, connector: Connected, respond: (envelope: ConnectorRelayEnvelope) => Response | Promise<Response>) {
  const requests: ConnectorRelayEnvelope[] = [];
  f.env.CONNECTOR_HUB = fakeHub({ async rpc(connectorId, envelope) {
    assert.equal(connectorId, connector.connectorId);
    requests.push(envelope);
    assert.equal(envelope.connectorId, connector.connectorId);
    assert.equal(envelope.connectionHash, await sha256(connector.connectionToken));
    return respond(envelope);
  } });
  return requests;
}

async function sharedHost(f: Fixture) {
  const admin = await f.client('admin'); const host = await f.client('host'); const creator = await f.githubClient();
  const team = await workspace(admin);
  await addMember(admin, team.id, host); await addMember(admin, team.id, creator);
  await allTools(admin, team.id, host, creator);
  f.sqlite.prepare(`INSERT INTO workspace_repositories
    (id, workspace_id, repository_id, full_name, ref, private, created_at) VALUES (?,?,?,?,?,?,?)`)
    .run('shared-repository', team.id, '7', 'owner/repo', 'main', 1, new Date().toISOString());
  const creatorRequest = creator.request;
  creator.request = async (method, path, body, headers) => {
    if (method !== 'POST' || path !== '/api/sessions') return creatorRequest(method, path, body, headers);
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== 'https://api.github.com/repos/owner/repo' &&
          url !== 'https://api.github.com/repos/owner/repo/commits/main') return previousFetch(input, init);
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${githubToken}`);
      assert.equal(init?.redirect, 'manual');
      assert.equal(init?.method ?? 'GET', 'GET');
      return Response.json(url.endsWith('/commits/main') ? { sha: 'a'.repeat(40) } :
        { id: 7, full_name: 'owner/repo', default_branch: 'main', private: true });
    };
    try { return await creatorRequest(method, path, body, headers); }
    finally { globalThis.fetch = previousFetch; }
  };
  const connector = await connect(f, host);
  await json(await host.request('PUT', `/api/connectors/${connector.connectorId}/shares/${team.id}`));
  const { models } = await json<{ models: ModelDefinition[] }>(await creator.request('GET', `/api/workspaces/${team.id}/models`));
  assert.equal(models.length, 1);
  const model = models[0];
  const hub = provisionHub(f);
  const input = { workspaceId: team.id, modelId: model.id, title: 'Creator session' };
  return { admin, host, creator, team, connector, model, hub, input };
}

async function sharedSession(f: Fixture, tools: AgentVersion['tools'] = ['identity', 'github_comment']) {
  const setup = await sharedHost(f);
  const { session: started } = await json<{ session: SessionRecord }>(await setup.creator.request('POST', '/api/sessions', {
    ...setup.input, trustedConnectorId: setup.connector.connectorId,
  }), 201);
  assert.equal(started.status, 'ready');
  assert.deepEqual(started.repositories, []);
  assert.equal(started.repositoryMode, 'clone');
  assert.equal(setup.hub.requests.length, 1);
  assert.deepEqual(setup.hub.unexpected, []);
  const agent = seedAgentVersion(f.sqlite, { authorId: setup.host.user.id, workspaceId: setup.team.id, modelId: setup.model.id, tools,
    name: 'Published local agent' });
  const session: SessionRecord = { ...started, id: seedSavedAgentSession(f.sqlite, started.id, agent), agentVersionId: agent.id };
  return { ...setup, agent, session };
}

async function privateWorkspace(f: Fixture) {
  const owner = await f.client('private-owner'); const member = await f.client('private-member');
  const outsider = await f.client('private-outsider'); const team = await workspace(owner);
  await addMember(owner, team.id, member);
  const connector = await connect(f, owner, team.id);
  const { models } = await json<{ models: ModelDefinition[] }>(await owner.request('GET', `/api/workspaces/${team.id}/models`));
  assert.equal(models.length, 1);
  const model = models[0];
  const hub = provisionHub(f);
  const input = { workspaceId: team.id, modelId: model.id, title: 'Workspace-readable own session' };
  return { owner, member, outsider, team, connector, model, hub, input };
}

async function privateHostSession(f: Fixture) {
  const setup = await privateWorkspace(f);
  const { session } = await json<{ session: SessionRecord }>(await setup.owner.request('POST', '/api/sessions', setup.input), 201);
  assert.equal(session.status, 'ready');
  const view: SessionView = {
    sessionId: session.id,
    owner: { id: setup.owner.user.id, displayName: 'Owner', gitName: 'Owner', gitEmail: 'owner@example.test', githubLogin: null },
    entries: [], approvals: [], conversations: [], busy: false,
  };
  return { ...setup, session, view };
}

function authorization(session: SessionRecord, actorId = session.ownerId) {
  return { sessionId: session.id, actorId, ownerId: session.ownerId, permission: 'write' };
}

async function approvedOperation(f: Fixture, session: SessionRecord, _operation: Operation, _actorId: string, requestedBy: string) {
  const admissionId = admit(f, session.id, requestedBy);
  return { sessionId: session.id, actorId: requestedBy, approvalId: `tool-${token().slice(0, 32)}`, admissionId };
}

async function brokerPayload(f: Fixture, session: SessionRecord, actorId = session.ownerId, requestedBy = session.ownerId) {
  const operation = { kind: 'github.comment' as const, repository: 'owner/repo', issue: 3, body: 'Exactly approved text' };
  return { ...await approvedOperation(f, session, operation, actorId, requestedBy), repository: operation.repository, issue: operation.issue, body: operation.body };
}

const headSha = 'c'.repeat(40);
const mergedSha = 'd'.repeat(40);

async function mergePayload(f: Fixture, session: SessionRecord, repository = 'owner/repo') {
  const operation = { kind: 'github.merge' as const, repository, pull: 5, sha: headSha, method: 'squash' as const };
  return { ...await approvedOperation(f, session, operation, session.ownerId, session.ownerId),
    repository, pull: operation.pull, sha: operation.sha, method: operation.method };
}

function mergeFetch(t: TestContext, merge: () => Response) {
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    assert.equal(init?.redirect, 'manual');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${githubToken}`);
    if (url === 'https://api.github.com/repos/owner/repo') {
      assert.equal(init?.method ?? 'GET', 'GET');
      return Response.json({ id: 7, full_name: 'owner/repo', default_branch: 'main', private: true });
    }
    assert.equal(url, 'https://api.github.com/repos/owner/repo/pulls/5/merge');
    assert.equal(init?.method, 'PUT');
    assert.deepEqual(JSON.parse(String(init?.body)), { sha: headSha, merge_method: 'squash' });
    return merge();
  });
  return calls;
}

async function issuePayload(f: Fixture, session: SessionRecord, repository = 'owner/repo') {
  const operation = { kind: 'github.issue' as const, repository, title: 'Sandbox has no CA certificates', body: 'Exactly approved **text**' };
  return { ...await approvedOperation(f, session, operation, session.ownerId, session.ownerId),
    repository, title: operation.title, body: operation.body };
}

function issueFetch(t: TestContext, open: () => Response) {
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    assert.equal(init?.redirect, 'manual');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${githubToken}`);
    if (url === 'https://api.github.com/repos/owner/repo') {
      assert.equal(init?.method ?? 'GET', 'GET');
      return Response.json({ id: 7, full_name: 'owner/repo', default_branch: 'main', private: true });
    }
    assert.equal(url, 'https://api.github.com/repos/owner/repo/issues');
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), { title: 'Sandbox has no CA certificates', body: 'Exactly approved **text**' });
    return open();
  });
  return calls;
}

function admit(f: Fixture, sessionId: string, actorId: string, options: { expiresAt?: number; mode?: 'write' | 'ask' } = {}) {
  const id = token();
  f.sqlite.prepare(`INSERT INTO run_admissions (id,session_id,actor_id,mode,request_id,content_hash,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, sessionId, actorId, options.mode ?? 'write', `request-${id}`, 'h'.repeat(43),
      options.expiresAt ?? Math.floor(Date.now() / 1000) + 3600, new Date().toISOString());
  return id;
}

function githubFetch(t: TestContext) {
  return t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), 'https://api.github.com/repos/owner/repo/issues/3/comments');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'manual');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${githubToken}`);
    assert.deepEqual(JSON.parse(String(init?.body)), { body: 'Exactly approved text' });
    return Response.json({ id: 99, html_url: 'https://github.com/owner/repo/issues/3#issuecomment-99', secret: githubToken });
  });
}

for (const revoked of [false, true]) {
  test(`permanent host removal preserves history and fences access (revoked=${revoked})`, async t => {
    const f = await fixture(t);
    const s = await privateHostSession(f);
    const path = `/api/connectors/${s.connector.connectorId}/permanent`;
    await denied(await s.member.request('DELETE', path), 404, 'not_found');
    await denied(await f.request('DELETE', path, undefined, { Cookie: s.owner.cookie }), 403, 'invalid_csrf');
    await json(await s.owner.request('PUT', `/api/connectors/${s.connector.connectorId}/shares/${s.team.id}`));
    if (revoked) assert.equal((await s.owner.request('DELETE', `/api/connectors/${s.connector.connectorId}`)).status, 204);
    delete f.env.CONNECTOR_HUB;
    assert.equal((await s.owner.request('DELETE', path)).status, 204);
    assert.deepEqual(await json(await s.owner.request('GET', '/api/connectors')), { connectors: [] });
    assert.deepEqual(await json(await s.member.request('GET', `/api/workspaces/${s.team.id}/connectors`)), { connectors: [] });
    const row = f.sqlite.prepare('SELECT * FROM connectors WHERE id = ?').get(s.connector.connectorId)!;
    assert.ok(row.removed_at);
    assert.ok(row.revoked_at);
    assert.equal(row.connection_hash, null);
    assert.notEqual(row.credential_hash, await sha256(s.connector.token));
    assert.equal(f.sqlite.prepare('SELECT connector_id FROM sessions WHERE id = ?').get(s.session.id)!.connector_id, s.connector.connectorId);
    assert.equal(f.sqlite.prepare('SELECT available FROM models WHERE id = ?').get(s.model.id)!.available, 0);
    for (const table of ['connector_shares', 'connector_workspaces']) {
      assert.equal(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE connector_id = ?`).get(s.connector.connectorId)!.n, 0);
    }
    assert.deepEqual(f.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
    await denied(await self(f, s.connector, 'manifest', manifest), 401, 'connector_authentication_required');
    await denied(await s.owner.request('DELETE', path), 404, 'not_found');
    await denied(await s.owner.request('PUT', `/api/connectors/${s.connector.connectorId}/shares/${s.team.id}`), 404, 'not_found');
  });
}

test('pairings require a CSRF-protected cookie, retain its owner, are single-use, and hash secrets at rest', async t => {
  const f = await fixture(t); const alice = await f.client('alice'); const bob = await f.client('bob');
  await denied(await f.request('POST', '/api/connectors/pairings', { name: 'Pi' }), 401, 'unauthorized');
  await denied(await f.request('POST', '/api/connectors/pairings', { name: 'Pi' }, { Cookie: alice.cookie }), 403, 'invalid_csrf');
  await denied(await alice.request('POST', '/api/connectors/pairings', { name: 'Pi' }, { Origin: 'https://hostile.invalid' }), 403, 'invalid_origin');
  await denied(await alice.request('POST', '/api/connectors/pairings', { name: 'Pi', ownerId: bob.user.id }), 400, 'invalid_metadata');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM connector_pairings').get()!.n, 0);
  const pending = await pairing(alice);
  const row = f.sqlite.prepare('SELECT * FROM connector_pairings WHERE id = ?').get(pending.id)!;
  assert.equal(row.owner_id, alice.user.id);
  assert.equal(row.code_hash, await sha256(pending.code));
  assert.equal(row.claimed_at, null);
  assert.equal(row.expires_at, Date.parse(pending.expiresAt) / 1000);
  assert.ok(Date.parse(pending.expiresAt) > Date.now());
  assert.ok(Date.parse(pending.expiresAt) <= Date.now() + 600000);
  assert.ok(!JSON.stringify(row).includes(pending.code));
  await denied(await claim(f, pending, { code: changedToken(pending.code), ...manifest }), 403, 'invalid_pairing');
  await denied(await claim(f, { ...pending, id: 'unknown-pairing' }), 403, 'invalid_pairing');
  await denied(await claim(f, pending, undefined, { Origin: 'https://hostile.invalid' }), 403, 'invalid_origin');
  assert.equal(f.sqlite.prepare('SELECT claimed_at FROM connector_pairings WHERE id = ?').get(pending.id)!.claimed_at, null);
  const { credentials } = await json<{ credentials: ConnectorCredentials }>(await claim(f, pending, undefined, { Cookie: bob.cookie }), 201);
  assert.match(credentials.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(credentials.controlPlaneUrl, origin);
  const connector = f.sqlite.prepare('SELECT * FROM connectors WHERE id = ?').get(credentials.connectorId)!;
  assert.equal(connector.owner_id, alice.user.id);
  assert.equal(connector.credential_hash, await sha256(credentials.token));
  assert.ok(!JSON.stringify(connector).includes(credentials.token));
  assert.ok(f.sqlite.prepare('SELECT claimed_at FROM connector_pairings WHERE id = ?').get(pending.id)!.claimed_at);
  await denied(await claim(f, pending), 403, 'invalid_pairing');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM connectors').get()!.n, 1);
  const listed = await json<{ connectors: ConnectorInfo[] }>(await alice.request('GET', '/api/connectors'));
  assert.equal(listed.connectors[0].ownerId, alice.user.id);
  assert.ok(!JSON.stringify(listed).includes(credentials.token));
  assert.ok(!JSON.stringify(listed).includes(String(connector.credential_hash)));
  assert.deepEqual(await json(await bob.request('GET', '/api/connectors')), { connectors: [] });
});

test('pairing expiry is enforced at claim time and the ten-minute per-owner bound includes claimed pairings', async t => {
  const f = await fixture(t); const alice = await f.client('alice'); const bob = await f.client('bob');
  const pending: ConnectorPairing[] = [];
  for (let i = 0; i < 5; i++) pending.push(await pairing(alice));
  await denied(await alice.request('POST', '/api/connectors/pairings', { name: 'Sixth' }), 429, 'pairing_limit');
  await pairing(bob);
  f.sqlite.prepare('UPDATE connector_pairings SET expires_at = ? WHERE id = ?')
    .run(Math.floor(Date.now() / 1000) - 1, pending[0].id);
  await denied(await claim(f, pending[0]), 403, 'invalid_pairing');
  assert.equal(f.sqlite.prepare('SELECT claimed_at FROM connector_pairings WHERE id = ?').get(pending[0].id)!.claimed_at, null);
  await pairing(alice);
  assert.equal(f.sqlite.prepare('SELECT id FROM connector_pairings WHERE id = ?').get(pending[0].id), undefined);
  await json(await claim(f, pending[1]), 201);
  await denied(await alice.request('POST', '/api/connectors/pairings', { name: 'Claimed still counts' }), 429, 'pairing_limit');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM connector_pairings WHERE owner_id = ?').get(alice.user.id)!.n, 5);
  f.sqlite.prepare('UPDATE connector_pairings SET expires_at = ? WHERE id = ?')
    .run(Math.floor(Date.now() / 1000) - 1, pending[1].id);
  await pairing(alice);
  assert.equal(f.sqlite.prepare('SELECT id FROM connector_pairings WHERE id = ?').get(pending[1].id), undefined);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM connector_pairings WHERE owner_id = ?').get(alice.user.id)!.n, 5);
});

test('the active connector bound is checked again at claim and revocation releases capacity', async t => {
  const f = await fixture(t); const owner = await f.client('owner');
  const insert = f.sqlite.prepare('INSERT INTO connectors (id,owner_id,name,credential_hash,created_at) VALUES (?,?,?,?,?)');
  for (let i = 0; i < 19; i++) insert.run(`existing-${i}`, owner.user.id, 'Existing', await sha256(token()), new Date().toISOString());
  const first = await pairing(owner); const second = await pairing(owner);
  const { credentials } = await json<{ credentials: ConnectorCredentials }>(await claim(f, first), 201);
  await denied(await claim(f, second), 403, 'invalid_pairing');
  assert.equal(f.sqlite.prepare('SELECT claimed_at FROM connector_pairings WHERE id = ?').get(second.id)!.claimed_at, null);
  await denied(await owner.request('POST', '/api/connectors/pairings', { name: 'Over limit' }), 429, 'pairing_limit');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM connectors WHERE revoked_at IS NULL').get()!.n, 20);
  assert.equal((await owner.request('DELETE', `/api/connectors/${credentials.connectorId}`)).status, 204);
  await json(await claim(f, second), 201);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM connectors WHERE revoked_at IS NULL').get()!.n, 20);
});

test('claim and manifest updates reject malformed metadata and secret-bearing fields without storing them', async t => {
  const f = await fixture(t); const owner = await f.client('owner'); const connector = await connect(f, owner);
  const pending = await pairing(owner); const secret = 'provider-credential-must-never-be-persisted';
  const invalid: { name: string; value: object; code: string }[] = [
    ...['apiKey', 'token', 'env', 'auth'].map(field => ({ name: `top-level ${field}`, value: { ...manifest, [field]: secret }, code: 'invalid_metadata' })),
    ...['apiKey', 'headers', 'baseUrl', 'credentials'].map(field => ({ name: `model ${field}`,
      value: { ...manifest, models: [{ ...manifest.models[0], [field]: secret }] }, code: 'invalid_metadata' })),
    ...['env', 'token'].map(field => ({ name: `capability ${field}`,
      value: { ...manifest, capabilities: { ...manifest.capabilities, [field]: secret } }, code: 'invalid_metadata' })),
    { name: 'duplicate models', value: { ...manifest, models: [manifest.models[0], manifest.models[0]] }, code: 'invalid_manifest' },
    { name: 'too many models', value: { ...manifest, models: Array.from({ length: 201 }, (_, i) => ({ ...manifest.models[0], modelId: `model-${i}` })) }, code: 'invalid_manifest' },
    { name: 'non-array models', value: { ...manifest, models: {} }, code: 'invalid_manifest' },
    { name: 'null model', value: { ...manifest, models: [null] }, code: 'invalid_manifest' },
    { name: 'provider syntax', value: { ...manifest, models: [{ ...manifest.models[0], provider: 'https://provider.invalid' }] }, code: 'invalid_manifest' },
    { name: 'control characters', value: { ...manifest, models: [{ ...manifest.models[0], name: 'model\nsecret' }] }, code: 'invalid_manifest' },
    { name: 'missing capabilities', value: { models: manifest.models }, code: 'invalid_manifest' },
    { name: 'platform syntax', value: { ...manifest, capabilities: { ...manifest.capabilities, platform: 'linux/secret' } }, code: 'invalid_manifest' },
    { name: 'non-boolean capability', value: { ...manifest, capabilities: { ...manifest.capabilities, sandbox: 'true' } }, code: 'invalid_manifest' },
    { name: 'unsandboxed production shell', value: { ...manifest, capabilities: { ...manifest.capabilities, sandbox: false, productionShell: true } }, code: 'invalid_manifest' },
    { name: 'sandboxed host claiming no sandbox', value: { ...manifest, capabilities: { ...manifest.capabilities, sandbox: true, unsandboxed: true } }, code: 'invalid_manifest' },
    { name: 'non-boolean unsandboxed', value: { ...manifest, capabilities: { ...manifest.capabilities, sandbox: false, unsandboxed: 'yes' } }, code: 'invalid_manifest' },
    { name: 'unknown thinking level', value: { ...manifest, models: [{ ...manifest.models[0], thinkingLevels: ['off', 'extreme'] }] }, code: 'invalid_manifest' },
    { name: 'duplicate thinking level', value: { ...manifest, models: [{ ...manifest.models[0], thinkingLevels: ['off', 'off'] }] }, code: 'invalid_manifest' },
    { name: 'empty thinking levels', value: { ...manifest, models: [{ ...manifest.models[0], thinkingLevels: [] }] }, code: 'invalid_manifest' },
    { name: 'starting level the model lacks', value: { ...manifest, models: [{ ...manifest.models[0], thinkingLevels: ['low', 'high'], thinkingLevel: 'medium' }] }, code: 'invalid_manifest' },
    { name: 'unknown starting level', value: { ...manifest, models: [{ ...manifest.models[0], thinkingLevel: 'extreme' }] }, code: 'invalid_manifest' },
    { name: 'non-boolean chat options', value: { ...manifest, capabilities: { ...manifest.capabilities, chatOptions: 'true' } }, code: 'invalid_manifest' },
    { name: 'non-boolean chat images', value: { ...manifest, capabilities: { ...manifest.capabilities, chatImages: 'true' } }, code: 'invalid_manifest' },
    { name: 'non-boolean git providers', value: { ...manifest, capabilities: { ...manifest.capabilities, gitProviders: 1 } }, code: 'invalid_manifest' },
    { name: 'git credentials without pushes', value: { ...manifest, capabilities: { ...manifest.capabilities, gitCredentials: true } }, code: 'invalid_manifest' },
    { name: 'non-boolean session branches', value: { ...manifest, capabilities: { ...manifest.capabilities, sessionBranches: 'true' } }, code: 'invalid_manifest' },
    { name: 'session branches without plain Git', value: { ...manifest, capabilities: { ...manifest.capabilities, plainGit: false, sessionBranches: true } }, code: 'invalid_manifest' },
    { name: 'non-boolean host configuration', value: { ...manifest, capabilities: { ...manifest.capabilities, hostConfig: 'true' } }, code: 'invalid_manifest' },
    { name: 'unknown GPU device', value: { ...manifest, capabilities: { ...manifest.capabilities, gpu: 'cuda' } }, code: 'invalid_manifest' },
    { name: 'GPU lent by an unsandboxed host', value: { ...manifest, capabilities: { platform: 'darwin', sandbox: false, productionShell: false, unsandboxed: true, gpu: 'render' } }, code: 'invalid_manifest' },
    { name: 'unbounded shell grants without host grants', value: { ...manifest, capabilities: { ...manifest.capabilities, hostCommands: true, unboundedShellGrants: true } }, code: 'invalid_manifest' },
    { name: 'non-boolean unbounded shell grants', value: { ...manifest, capabilities: { ...manifest.capabilities, hostCommands: true, hostGrants: true, unboundedShellGrants: 'yes' } }, code: 'invalid_manifest' },
    { name: 'non-boolean owner host sessions', value: { ...manifest, capabilities: { ...manifest.capabilities, hostConfig: true, ownerHostSessions: 'yes' } }, code: 'invalid_manifest' },
  ];
  const before = f.sqlite.prepare('SELECT * FROM connectors WHERE id = ?').get(connector.connectorId);
  for (const entry of invalid) {
    await t.test(entry.name, async () => {
      await denied(await claim(f, pending, { code: pending.code, ...entry.value }), 400, entry.code);
      await denied(await self(f, connector, 'manifest', entry.value), 400, entry.code);
      assert.equal(f.sqlite.prepare('SELECT claimed_at FROM connector_pairings WHERE id = ?').get(pending.id)!.claimed_at, null);
      assert.deepEqual(f.sqlite.prepare('SELECT * FROM connectors WHERE id = ?').get(connector.connectorId), before);
      assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM connectors').get()!.n, 1);
    });
  }
  await json(await claim(f, pending), 201);
  await json(await self(f, connector, 'manifest', manifest));
  const unsandboxed = { platform: 'darwin', sandbox: false, productionShell: false, unsandboxed: true, gitPush: true, gitCredentials: true };
  await json(await self(f, connector, 'manifest', { ...manifest, capabilities: unsandboxed }));
  assert.deepEqual(JSON.parse(String(f.sqlite.prepare('SELECT capabilities_json FROM connectors WHERE id = ?').get(connector.connectorId)!.capabilities_json)), unsandboxed,
    'an owner-disabled sandbox and owner-offered Git credentials must stay disclosed in stored host metadata');
  const named = { ...manifest.capabilities, sessionBranches: true };
  await json(await self(f, connector, 'manifest', { ...manifest, capabilities: named }));
  assert.equal(JSON.parse(String(f.sqlite.prepare('SELECT capabilities_json FROM connectors WHERE id = ?').get(connector.connectorId)!.capabilities_json)).sessionBranches, true);
  const configured = { ...manifest.capabilities, hostConfig: true, gpu: 'dxg' };
  await json(await self(f, connector, 'manifest', { ...manifest, capabilities: configured }));
  assert.deepEqual(JSON.parse(String(f.sqlite.prepare('SELECT capabilities_json FROM connectors WHERE id = ?').get(connector.connectorId)!.capabilities_json)), configured);
  for (const table of ['connectors', 'connector_pairings', 'models', 'audit']) {
    assert.ok(!JSON.stringify(f.sqlite.prepare(`SELECT * FROM ${table}`).all()).includes(secret));
  }
});

test('connector bearer credentials cannot authenticate browser or internal APIs, and self routes require the current connection', async t => {
  const f = await fixture(t); const owner = await f.client('owner'); const connector = await connect(f, owner);
  const headers = { Authorization: `Bearer ${connector.token}`, 'X-Connection-Token': connector.connectionToken };
  await denied(await f.request('GET', '/api/me', undefined, headers), 401, 'unauthorized');
  await denied(await f.request('POST', '/api/connectors/pairings', { name: 'Bearer only' }, headers), 401, 'unauthorized');
  for (const path of ['/api/internal/authorize', '/api/internal/github/comment', '/api/internal/github/read', '/api/internal/github/merge', '/api/internal/github/issue',
    '/api/internal/restores/unknown/download', '/api/internal/git/direct']) {
    await denied(await f.request('POST', path, {}, headers), 401, 'unauthorized');
  }
  for (const path of ['manifest', 'authorize', 'activity', 'github/comment', 'github/read', 'github/merge', 'github/issue', 'restores/unknown/download', 'git/direct', 'tools']) {
    await denied(await owner.request('POST', `/api/connectors/self/${path}`, {}), 401, 'connector_authentication_required');
    await denied(await self(f, connector, path, {}, null), 401, 'stale_connection');
    await denied(await self(f, connector, path, {}, 'malformed'), 401, 'stale_connection');
    await denied(await self(f, connector, path, {}, changedToken(connector.connectionToken)), 401, 'stale_connection');
    await denied(await f.request('POST', `/api/connectors/self/${path}`, {}, { ...headers, Authorization: `Bearer ${internalSecret}` }), 401, 'connector_authentication_required');
  }
  await json(await self(f, connector, 'manifest', manifest));
  const oldConnection = connector.connectionToken;
  connector.connectionToken = token();
  f.sqlite.prepare('UPDATE connectors SET connection_hash = ? WHERE id = ?').run(await sha256(connector.connectionToken), connector.connectorId);
  for (const path of ['manifest', 'authorize', 'activity', 'github/comment', 'github/read', 'github/merge', 'github/issue', 'restores/unknown/download', 'git/direct', 'tools']) {
    await denied(await self(f, connector, path, {}, oldConnection), 401, 'stale_connection');
  }
  await json(await self(f, connector, 'manifest', manifest));
  const stored = f.sqlite.prepare('SELECT * FROM connectors WHERE id = ?').get(connector.connectorId)!;
  assert.equal(stored.connection_hash, await sha256(connector.connectionToken));
  assert.ok(!JSON.stringify(stored).includes(connector.connectionToken));
});

test('sharing is connector-owner-only with live workspace membership and imports only safe catalog metadata', async t => {
  const f = await fixture(t); const admin = await f.client('admin'); const host = await f.client('host'); const outsider = await f.client('outsider');
  const team = await workspace(admin); const connector = await connect(f, host);
  const path = `/api/connectors/${connector.connectorId}/shares/${team.id}`;
  await denied(await admin.request('PUT', path), 404, 'not_found');
  await denied(await admin.request('DELETE', path), 404, 'not_found');
  await denied(await admin.request('DELETE', `/api/connectors/${connector.connectorId}`), 404, 'not_found');
  await denied(await host.request('PUT', path), 404, 'not_found');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM connector_shares').get()!.n, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM models').get()!.n, 0);
  await addMember(admin, team.id, host);
  const shared = await json<{ connector: ConnectorInfo }>(await host.request('PUT', path));
  assert.deepEqual(Object.keys(shared.connector).sort(), ['id', 'ownerId', 'ownerName', 'name', 'createdAt', 'revokedAt', 'online', 'models', 'workspaceIds', 'connectedWorkspaceIds', 'capabilities'].sort());
  assert.deepEqual(shared.connector.models, manifest.models);
  assert.deepEqual(shared.connector.capabilities, manifest.capabilities);
  assert.deepEqual(shared.connector.workspaceIds, [team.id]);
  assert.deepEqual(shared.connector.connectedWorkspaceIds, [team.id]);
  await json(await host.request('PUT', path));
  const catalog = await json<{ models: ModelDefinition[] }>(await admin.request('GET', `/api/workspaces/${team.id}/models`));
  assert.equal(catalog.models.length, 1);
  const model = catalog.models[0];
  assert.deepEqual(model, { id: model.id, workspaceId: team.id, ...manifest.models[0], connectorId: connector.connectorId, connectorOwnerId: host.user.id });
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM models').get()!.n, 1);
  await denied(await outsider.request('GET', `/api/workspaces/${team.id}/connectors`), 404, 'not_found');
  await denied(await outsider.request('GET', `/api/workspaces/${team.id}/models`), 404, 'not_found');
  await denied(await admin.request('POST', `/api/workspaces/${team.id}/models`, {
    name: 'Forged', provider: 'openai', modelId: 'model', connectorId: connector.connectorId, connectorOwnerId: host.user.id,
  }), 400, 'invalid_input');
  const listed = await json<{ connectors: ConnectorInfo[] }>(await admin.request('GET', `/api/workspaces/${team.id}/connectors`));
  assert.deepEqual(listed.connectors, [shared.connector]);
  const visible = JSON.stringify({ shared, catalog, listed });
  for (const secret of [connector.token, connector.connectionToken, connector.pairing.code, await sha256(connector.token), await sha256(connector.connectionToken)]) {
    assert.ok(!visible.includes(secret));
  }
  await json(await self(f, connector, 'manifest', { ...manifest, models: [] }));
  assert.deepEqual(await json(await admin.request('GET', `/api/workspaces/${team.id}/models`)), { models: [] });
  assert.equal(f.sqlite.prepare('SELECT available FROM models WHERE id = ?').get(model.id)!.available, 0);
  await json(await self(f, connector, 'manifest', { ...manifest, models: [{ ...manifest.models[0], name: 'Renamed' }] }));
  const refreshed = await json<{ models: ModelDefinition[] }>(await admin.request('GET', `/api/workspaces/${team.id}/models`));
  assert.deepEqual(refreshed.models, [{ ...model, name: 'Renamed' }]);
  assert.equal((await admin.request('DELETE', `/api/workspaces/${team.id}/members/${encodeURIComponent(host.user.id)}`)).status, 204);
  await denied(await host.request('PUT', path), 404, 'not_found');
  assert.deepEqual(await json(await admin.request('GET', `/api/workspaces/${team.id}/connectors`)), { connectors: [] });
  assert.deepEqual(await json(await admin.request('GET', `/api/workspaces/${team.id}/models`)), { models: [] });
});

test('foreign-host sessions require exact trust and retain the creator identity in storage and the provisioning envelope', async t => {
  const f = await fixture(t); const s = await sharedHost(f);
  for (const trustedConnectorId of [undefined, 'another-connector', s.host.user.id]) {
    await denied(await s.creator.request('POST', '/api/sessions', { ...s.input, trustedConnectorId }), 400, 'connector_trust_required');
  }
  await denied(await s.creator.request('POST', '/api/sessions', {
    ...s.input, trustedConnectorId: s.connector.connectorId, ownerId: s.host.user.id,
  }), 400, 'server_owned_identity');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 0);
  assert.equal(s.hub.requests.length, 0);
  const { session } = await json<{ session: SessionRecord }>(await s.creator.request('POST', '/api/sessions', {
    ...s.input, trustedConnectorId: s.connector.connectorId, visibility: 'private',
  }), 201);
  assert.equal(session.status, 'ready');
  assert.equal(session.ownerId, s.creator.user.id);
  assert.equal(session.connectorId, s.connector.connectorId);
  assert.equal(session.connectorOwnerId, s.host.user.id);
  const stored = f.sqlite.prepare('SELECT * FROM sessions WHERE id = ?').get(session.id)!;
  assert.equal(stored.owner_id, s.creator.user.id);
  assert.equal(stored.agent_version_id, session.agentVersionId);
  assert.equal(stored.connector_id, s.connector.connectorId);
  assert.equal(stored.connector_owner_id, s.host.user.id);
  assert.equal(s.hub.requests.length, 1);
  const envelope = s.hub.requests[0]; const request = envelope.request;
  assert.equal(envelope.connectorId, s.connector.connectorId);
  assert.equal(envelope.credentialHash, await sha256(s.connector.token));
  assert.equal(envelope.connectionHash, await sha256(s.connector.connectionToken));
  assert.equal(request.type, 'request');
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/v1/sessions');
  assert.equal(request.id, request.ticket.jti);
  assert.equal(request.ticket.action, 'create');
  assert.equal(request.ticket.actorId, s.creator.user.id);
  assert.equal(request.ticket.ownerId, s.creator.user.id);
  assert.equal(request.ticket.connectorId, s.connector.connectorId);
  assert.equal(request.ticket.sessionId, session.id);
  assert.equal(request.ticket.policyVersion, session.policyVersion);
  assert.equal(request.ticket.bodyHash, await sha256(request.body));
  const binding = JSON.parse(request.body) as RunnerBinding;
  assert.equal(binding.owner.id, s.creator.user.id);
  assert.equal(binding.owner.gitEmail, 'creator@example.test');
  assert.equal(binding.session.ownerId, s.creator.user.id);
  assert.equal(binding.agent.authorId, s.creator.user.id);
  assert.equal(binding.agent.id, session.agentVersionId);
  assert.deepEqual(binding.model, s.model);
  for (const secret of [s.connector.token, s.connector.connectionToken, s.connector.pairing.code, githubToken]) assert.ok(!JSON.stringify(envelope).includes(secret));
  await denied(await s.host.request('GET', `/api/sessions/${session.id}`), 404, 'not_found');
  assert.equal((await s.creator.request('GET', `/api/sessions/${session.id}`)).status, 200);
  const own = await json<{ session: SessionRecord }>(await s.host.request('POST', '/api/sessions', s.input), 201);
  assert.equal(own.session.ownerId, s.host.user.id);
  assert.deepEqual(own.session.repositories, []);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 2);
  assert.equal(s.hub.requests.length, 2);
  assert.deepEqual(s.hub.unexpected, []);
});

test('API-created model and session routing bindings cannot be rewritten through the database', async t => {
  const f = await fixture(t); const s = await sharedSession(f); const other = await connect(f, s.host);
  const modelBefore = f.sqlite.prepare('SELECT * FROM models WHERE id = ?').get(s.model.id);
  for (const [column, value] of [
    ['workspace_id', 'different-workspace'], ['provider', 'different-provider'], ['model_id', 'different-model'],
    ['connector_id', other.connectorId], ['connector_owner_id', s.creator.user.id], ['connector_id', null], ['connector_owner_id', null],
  ] as const) {
    assert.throws(() => f.sqlite.prepare(`UPDATE models SET ${column} = ? WHERE id = ?`).run(value, s.model.id), /model identity is immutable/);
  }
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM models WHERE id = ?').get(s.model.id), modelBefore);
  const sessionBefore = f.sqlite.prepare('SELECT * FROM sessions WHERE id = ?').get(s.session.id);
  for (const [column, value] of [
    ['owner_id', s.host.user.id], ['workspace_id', 'different-workspace'], ['agent_version_id', 'different-version'],
    ['connector_id', other.connectorId], ['connector_owner_id', s.creator.user.id], ['connector_id', null], ['connector_owner_id', null],
  ] as const) {
    assert.throws(() => f.sqlite.prepare(`UPDATE sessions SET ${column} = ? WHERE id = ?`).run(value, s.session.id), /immutable/);
  }
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM sessions WHERE id = ?').get(s.session.id), sessionBefore);
  assert.throws(() => f.sqlite.prepare('UPDATE agent_versions SET model_id = ? WHERE id = ?').run('another-model', s.agent.id), /immutable/);
  assert.deepEqual(f.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal((await json<{ allowed: boolean }>(await self(f, s.connector, 'authorize', authorization(s.session)))).allowed, true);
});

test('callbacks are scoped to the exact session connector, not merely its owner or a shared workspace', async t => {
  const f = await fixture(t); const s = await sharedSession(f); const fetch = githubFetch(t);
  const sameHost = await connect(f, s.host); const otherHost = await connect(f, s.admin);
  const payload = await brokerPayload(f, s.session);
  for (const [connector, owner] of [[sameHost, s.host], [otherHost, s.admin]] as const) {
    await json(await owner.request('PUT', `/api/connectors/${connector.connectorId}/shares/${s.team.id}`));
    await denied(await self(f, connector, 'authorize', authorization(s.session)), 403, 'connector_binding_mismatch');
    await denied(await self(f, connector, 'github/comment', payload), 403, 'connector_binding_mismatch');
  }
  for (const [path, body] of [['authorize', authorization(s.session)], ['github/comment', payload]] as const) {
    await denied(await f.request('POST', `/api/internal/${path}`, body, { Authorization: `Bearer ${internalSecret}` }), 403, 'connector_scope_required');
  }
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal((await json<{ allowed: boolean }>(await self(f, s.connector, 'authorize', authorization(s.session)))).allowed, true);
  assert.equal((await json<{ allowed: boolean }>(await self(f, s.connector, 'authorize', { ...authorization(s.session), ownerId: s.host.user.id }))).allowed, false);
  assert.equal((await json<{ allowed: boolean }>(await self(f, s.connector, 'authorize', authorization(s.session, s.host.user.id)))).allowed, false);
  assert.equal((await self(f, s.connector, 'github/comment', payload)).status, 200);
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(s.hub.unexpected, []);
});

for (const mutation of ['revoke', 'unshare', 'remove-host', 'remove-owner', 'remove-requester'] as const) {
  test(`${mutation} immediately denies existing connector callbacks and the brokered effects of messages already admitted`, async t => {
    const f = await fixture(t); const s = await sharedSession(f); const fetch = githubFetch(t);
    const collaborator = await f.client('collaborator');
    await addMember(s.admin, s.team.id, collaborator);
    await json(await s.creator.request('POST', `/api/sessions/${s.session.id}/grants`, { userId: collaborator.user.id, permissions: ['write', 'approve'] }));
    const actorId = s.creator.user.id;
    const requestedBy = mutation === 'remove-requester' ? collaborator.user.id : s.creator.user.id;
    const auth = authorization(s.session, mutation === 'remove-requester' ? collaborator.user.id : actorId);
    assert.equal((await json<{ allowed: boolean }>(await self(f, s.connector, 'authorize', auth))).allowed, true);
    const first = await brokerPayload(f, s.session, actorId, requestedBy);
    assert.equal((await self(f, s.connector, 'github/comment', first)).status, 200);
    assert.equal(fetch.mock.callCount(), 1);
    const pending = await brokerPayload(f, s.session, actorId, requestedBy);
    const versionBefore = Number(f.sqlite.prepare('SELECT policy_version FROM sessions WHERE id = ?').get(s.session.id)!.policy_version);
    delete f.env.CONNECTOR_HUB;
    if (mutation === 'revoke') {
      assert.equal((await s.host.request('DELETE', `/api/connectors/${s.connector.connectorId}`)).status, 204);
      const row = f.sqlite.prepare('SELECT revoked_at,connection_hash FROM connectors WHERE id = ?').get(s.connector.connectorId)!;
      assert.ok(row.revoked_at); assert.equal(row.connection_hash, null);
    } else if (mutation === 'unshare') {
      assert.equal((await s.host.request('DELETE', `/api/connectors/${s.connector.connectorId}/shares/${s.team.id}`)).status, 204);
    } else {
      const removed = mutation === 'remove-host' ? s.host : mutation === 'remove-owner' ? s.creator : collaborator;
      assert.equal((await s.admin.request('DELETE', `/api/workspaces/${s.team.id}/members/${encodeURIComponent(removed.user.id)}`)).status, 204);
    }
    const stored = f.sqlite.prepare('SELECT * FROM sessions WHERE id = ?').get(s.session.id)!;
    assert.equal(stored.owner_id, s.creator.user.id);
    assert.equal(stored.connector_id, s.connector.connectorId);
    assert.equal(stored.connector_owner_id, s.host.user.id);
    assert.equal(stored.policy_version, versionBefore + 1);
    if (mutation === 'revoke') {
      await denied(await self(f, s.connector, 'authorize', auth), 401, 'connector_authentication_required');
      await denied(await self(f, s.connector, 'github/comment', pending), 401, 'connector_authentication_required');
      await denied(await self(f, s.connector, 'manifest', manifest), 401, 'connector_authentication_required');
    } else if (mutation === 'unshare' || mutation === 'remove-host') {
      await denied(await self(f, s.connector, 'authorize', auth), 403, 'connector_unavailable');
      await denied(await self(f, s.connector, 'github/comment', pending), 403, 'connector_unavailable');
    } else {
      assert.equal((await json<{ allowed: boolean }>(await self(f, s.connector, 'authorize', auth))).allowed, false);
      await denied(await self(f, s.connector, 'github/comment', pending), 403, 'permission_revoked');
    }
    assert.equal(fetch.mock.callCount(), 1, 'Denied callbacks must not perform another external effect');
    if (mutation === 'revoke' || mutation === 'unshare' || mutation === 'remove-host') {
      assert.deepEqual(await json(await s.admin.request('GET', `/api/workspaces/${s.team.id}/connectors`)), { connectors: [] });
      assert.deepEqual(await json(await s.admin.request('GET', `/api/workspaces/${s.team.id}/models`)), { models: [] });
    }
    assert.deepEqual(s.hub.unexpected, []);
  });
}

test('broker authentication needs the internal secret, a writer\'s live admission and a tool call, before any fetch', async t => {
  const f = await fixture(t); const s = await sharedSession(f); const fetch = githubFetch(t);
  const payload = await brokerPayload(f, s.session);
  for (const secret of [internalSecret.slice(1), `${internalSecret}-suffix`, changedToken(internalSecret)]) {
    await denied(await f.request('POST', '/api/internal/github/comment', payload, { Authorization: `Bearer ${secret}` }), 401, 'unauthorized');
  }
  await denied(await self(f, s.connector, 'github/comment', { ...payload, capability: token() }), 410, 'approvals_removed');
  await denied(await self(f, s.connector, 'github/comment', { ...payload, approvalId: 'another-approval' }), 400, 'invalid_input');
  assert.equal(fetch.mock.callCount(), 0);
  const result = await json(await self(f, s.connector, 'github/comment', payload));
  assert.deepEqual(result, { id: 99, url: 'https://github.com/owner/repo/issues/3#issuecomment-99' });
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal((await self(f, s.connector, 'github/comment', payload)).status, 409, 'a tool call posts once');
  assert.equal(fetch.mock.callCount(), 1);
});

test('connector shares are bounded at fifty, idempotent at the limit, and unsharing releases a slot', async t => {
  const f = await fixture(t); const owner = await f.client('owner'); const connector = await connect(f, owner);
  const createdAt = new Date().toISOString();
  for (let i = 0; i < 51; i++) {
    const workspaceId = `workspace-${i}`;
    f.sqlite.prepare('INSERT INTO workspaces (id,name,owner_id,created_at) VALUES (?,?,?,?)')
      .run(workspaceId, 'Team', owner.user.id, createdAt);
    f.sqlite.prepare('INSERT INTO workspace_members (workspace_id,user_id,role,created_at) VALUES (?,?,?,?)')
      .run(workspaceId, owner.user.id, 'owner', createdAt);
    if (i < 49) f.sqlite.prepare('INSERT INTO connector_shares (connector_id,workspace_id,created_at) VALUES (?,?,?)')
      .run(connector.connectorId, workspaceId, createdAt);
  }
  const base = `/api/connectors/${connector.connectorId}/shares`;
  await json(await owner.request('PUT', `${base}/workspace-49`));
  await json(await owner.request('PUT', `${base}/workspace-49`));
  await denied(await owner.request('PUT', `${base}/workspace-50`), 429, 'share_limit');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM connector_shares WHERE connector_id = ?').get(connector.connectorId)!.n, 50);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM models WHERE workspace_id = ?').get('workspace-50')!.n, 0);
  assert.equal((await owner.request('DELETE', `${base}/workspace-0`)).status, 204);
  await json(await owner.request('PUT', `${base}/workspace-50`));
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM connector_shares WHERE connector_id = ?').get(connector.connectorId)!.n, 50);
  const { models } = await json<{ models: ModelDefinition[] }>(await owner.request('GET', '/api/workspaces/workspace-50/models'));
  assert.equal(models.length, 1);
  assert.equal(models[0].connectorId, connector.connectorId);
});

test('callbacks require both an available imported model and its exact provider/model in the live manifest', async t => {
  const f = await fixture(t); const s = await sharedSession(f); const fetch = githubFetch(t);
  const payload = await brokerPayload(f, s.session);
  assert.equal((await json<{ allowed: boolean }>(await self(f, s.connector, 'authorize', authorization(s.session)))).allowed, true);
  await json(await self(f, s.connector, 'manifest', { ...manifest, models: [] }));
  assert.equal(f.sqlite.prepare('SELECT available FROM models WHERE id = ?').get(s.model.id)!.available, 0);
  await denied(await self(f, s.connector, 'authorize', authorization(s.session)), 403, 'connector_unavailable');
  await denied(await self(f, s.connector, 'github/comment', payload), 403, 'connector_unavailable');
  for (const models of [[], [{ ...manifest.models[0], provider: 'other-provider' }], [{ ...manifest.models[0], modelId: 'other-model' }]]) {
    f.sqlite.prepare('UPDATE connectors SET models_json = ? WHERE id = ?').run(JSON.stringify(models), s.connector.connectorId);
    f.sqlite.prepare('UPDATE models SET available = 1 WHERE id = ?').run(s.model.id);
    await denied(await self(f, s.connector, 'authorize', authorization(s.session)), 403, 'connector_unavailable');
    await denied(await self(f, s.connector, 'github/comment', payload), 403, 'connector_unavailable');
  }
  f.sqlite.prepare('UPDATE connectors SET models_json = ? WHERE id = ?').run(JSON.stringify(manifest.models), s.connector.connectorId);
  f.sqlite.prepare('UPDATE models SET available = 0 WHERE id = ?').run(s.model.id);
  await denied(await self(f, s.connector, 'authorize', authorization(s.session)), 403, 'connector_unavailable');
  await denied(await self(f, s.connector, 'github/comment', payload), 403, 'connector_unavailable');
  assert.equal(fetch.mock.callCount(), 0);
  await json(await self(f, s.connector, 'manifest', manifest));
  const restored = await json<{ models: ModelDefinition[] }>(await s.creator.request('GET', `/api/workspaces/${s.team.id}/models`));
  assert.deepEqual(restored.models, [s.model], 'Reimport must retain the model identity pinned by the existing session');
  assert.equal((await json<{ allowed: boolean }>(await self(f, s.connector, 'authorize', authorization(s.session)))).allowed, true);
  assert.equal((await self(f, s.connector, 'github/comment', payload)).status, 200);
  assert.equal(fetch.mock.callCount(), 1);
});

test('claim, socket, and self routes require TLS except for explicitly enabled loopback tests', async t => {
  const f = await fixture(t); const owner = await f.githubClient(); const team = await workspace(owner);
  f.sqlite.prepare(`INSERT INTO workspace_repositories
    (id, workspace_id, repository_id, full_name, ref, private, created_at) VALUES (?,?,?,?,?,?,?)`)
    .run('tls-repository', team.id, '7', 'owner/repo', 'main', 1, new Date().toISOString());
  const connector = await connect(f, owner, team.id);
  const pending = await pairing(owner, 'Local Pi', team.id);
  const claimBody = { code: pending.code, ...manifest };
  const headers = { Authorization: `Bearer ${connector.token}`, 'X-Connection-Token': connector.connectionToken };
  const routes = [
    { method: 'POST', path: `/api/connectors/pairings/${pending.id}/claim`, body: claimBody },
    { method: 'POST', path: '/api/connectors/self/manifest', body: manifest },
  ];
  const socketHeaders = new Headers({ 'Sec-WebSocket-Protocol': `opencara-pi-v1, bearer.${connector.token}` });
  f.env.CONNECTOR_HUB = fakeHub();
  for (const route of routes) {
    await denied(await f.request(route.method, `http://remote.invalid${route.path}`, route.body, headers), 400, 'secure_transport_required');
  }
  await socketDenied(f, socketHeaders, new URL('http://remote.invalid/api/connectors/socket'), 400, 'secure_transport_required');
  await json(await self(f, connector, 'manifest', manifest));
  assert.deepEqual(await authenticateConnectorSocket(f.env, socketHeaders, new URL(`${origin}/api/connectors/socket`)),
    { connectorId: connector.connectorId, credentialHash: await sha256(connector.token) });
  f.env.TEST_AUTH_ENABLED = 'false';
  f.env.APP_ORIGIN = 'https://workspace.example.test';
  for (const route of routes) {
    await denied(await f.request(route.method, `${origin}${route.path}`, route.body, headers), 400, 'secure_transport_required');
  }
  await socketDenied(f, socketHeaders, new URL(`${origin}/api/connectors/socket`), 400, 'secure_transport_required');
  const secureHeaders = { ...headers, Origin: f.env.APP_ORIGIN };
  await json(await f.request('POST', `${f.env.APP_ORIGIN}/api/connectors/pairings/${pending.id}/claim`, claimBody, secureHeaders), 201);
  await json(await f.request('POST', `${f.env.APP_ORIGIN}/api/connectors/self/manifest`, manifest, secureHeaders));
  assert.deepEqual(await authenticateConnectorSocket(f.env, socketHeaders, new URL(`${f.env.APP_ORIGIN}/api/connectors/socket`)),
    { connectorId: connector.connectorId, credentialHash: await sha256(connector.token) });
});

test('a connector names its version in its manifest, which its host lists, and the server names its own in /api/health', async t => {
  const f = await fixture(t); const owner = await f.client('owner'); const connector = await connect(f, owner);
  const report = (version?: string) => f.request('POST', '/api/connectors/self/manifest', manifest, { Authorization: `Bearer ${connector.token}`,
    'X-Connection-Token': connector.connectionToken, ...(version === undefined ? {} : { 'X-Pikibun-Version': version }) });
  const listed = async () => (await json<{ connectors: ConnectorInfo[] }>(await owner.request('GET', '/api/connectors'))).connectors[0]!.version;
  assert.equal(await listed(), undefined);
  await json(await report('0.24.0'));
  assert.equal(await listed(), '0.24.0');
  await json(await report('desktop 0.9.0'));
  assert.equal(await listed(), 'desktop 0.9.0');
  await json(await report('<script>'));
  assert.equal(await listed(), undefined);
  await json(await report('0.24.0'));
  await json(await report());
  assert.equal(await listed(), undefined);

  const health = async () => (await json<{ version: string | null }>(await f.request('GET', '/api/health'))).version;
  assert.equal(await health(), null);
  f.env.PIKIBUN_VERSION = '0.24.0';
  assert.equal(await health(), '0.24.0');
});

async function socketDenied(f: Fixture, headers: Headers, url: URL, status: number, code: string) {
  let response: Response | undefined;
  await assert.rejects(authenticateConnectorSocket(f.env, headers, url), (error: unknown) => {
    assert.ok(error instanceof HTTPException);
    response = error.getResponse();
    return true;
  });
  assert.ok(response);
  await denied(response, status, code);
}

test('socket upgrades are authenticated outside Hono with the connector credential subprotocol', async t => {
  const f = await fixture(t); const owner = await f.client('owner'); const connector = await connect(f, owner);
  const url = new URL(`${origin}/api/connectors/socket`);
  const valid = () => new Headers({ 'Sec-WebSocket-Protocol': `opencara-pi-v1, bearer.${connector.token}` });
  await denied(await f.request('GET', '/api/connectors/socket', undefined, { Upgrade: 'websocket' }), 426, 'upgrade_required');
  await socketDenied(f, valid(), url, 503, 'connector_unavailable');
  f.env.CONNECTOR_HUB = fakeHub();
  assert.deepEqual(await authenticateConnectorSocket(f.env, valid(), url), { connectorId: connector.connectorId, credentialHash: await sha256(connector.token) });
  const hostile = valid(); hostile.set('Origin', 'https://evil.example.test');
  await socketDenied(f, hostile, url, 403, 'invalid_origin');
  const crossSite = valid(); crossSite.set('Sec-Fetch-Site', 'cross-site');
  await socketDenied(f, crossSite, url, 403, 'invalid_origin');
  const browser = valid(); browser.set('Cookie', 'test-auth=abc');
  await socketDenied(f, browser, url, 401, 'connector_authentication_required');
  await socketDenied(f, new Headers({ 'Sec-WebSocket-Protocol': `bearer.${connector.token}` }), url, 401, 'connector_authentication_required');
  await socketDenied(f, new Headers({ 'Sec-WebSocket-Protocol': `opencara-pi-v1, bearer.${connector.token}, extra` }), url, 401, 'connector_authentication_required');
  await socketDenied(f, new Headers({ 'Sec-WebSocket-Protocol': `opencara-pi-v1, bearer.${'x'.repeat(43)}` }), url, 401, 'connector_authentication_required');
  await socketDenied(f, new Headers({ 'Sec-WebSocket-Protocol': 'opencara-pi-v1, chat' }), url, 401, 'connector_authentication_required');
  assert.equal((await owner.request('DELETE', `/api/connectors/${connector.connectorId}`)).status, 204);
  assert.deepEqual((f.env.CONNECTOR_HUB as FakeHub).revoked, [connector.connectorId]);
  await socketDenied(f, valid(), url, 401, 'connector_authentication_required');
});

test('production session creation rejects a legacy non-connector model even for an authenticated GitHub owner', async t => {
  const f = await fixture(t); const owner = await f.githubClient(); const team = await workspace(owner);
  const { model } = await json<{ model: ModelDefinition }>(await owner.request('POST', `/api/workspaces/${team.id}/models`, {
    name: 'Legacy model', provider: 'openai', modelId: 'legacy-model',
  }), 201);
  assert.equal(f.sqlite.prepare('SELECT connector_id FROM models WHERE id = ?').get(model.id)!.connector_id, null);
  f.env.TEST_AUTH_ENABLED = 'false';
  f.env.APP_ORIGIN = 'https://workspace.example.test';
  const headers = { Cookie: owner.cookie.replace(/^test-auth=/, '__Host-auth='), Origin: f.env.APP_ORIGIN, 'X-CSRF-Token': owner.csrf };
  const profile = await json<{ user: { id: string } }>(await f.request('GET', `${f.env.APP_ORIGIN}/api/me`, undefined, headers));
  assert.equal(profile.user.id, owner.user.id);
  await denied(await f.request('POST', `${f.env.APP_ORIGIN}/api/sessions`, {
    workspaceId: team.id, modelId: model.id, title: 'No legacy provisioning in production',
  }, headers), 400, 'connector_required');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 0);
});

test('connected SSE emits only two authoritative snapshots within the fifty-query budget', async t => {
  const f = await fixture(t); const s = await sharedSession(f);
  await json(await s.creator.request('POST', `/api/sessions/${s.session.id}/grants`, { userId: s.admin.user.id, permissions: ['read'] }));
  const view: SessionView = {
    sessionId: s.session.id,
    owner: { id: s.creator.user.id, displayName: 'Creator', gitName: 'Creator', gitEmail: 'creator@example.test', githubLogin: 'creator' },
    entries: [], approvals: [], conversations: [], busy: false,
  };
  const requests = rpcHub(f, s.connector, envelope => {
    assert.equal(envelope.request.ticket.action, 'view');
    assert.equal(envelope.request.ticket.actorId, s.admin.user.id);
    assert.equal(envelope.request.method, 'GET');
    assert.equal(envelope.request.path, `/v1/sessions/${s.session.id}/view`);
    return Response.json({ view });
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const before = f.queryCount();
  const response = await s.admin.request('GET', `/api/sessions/${s.session.id}/events`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  const reader = response.body!.getReader();
  t.after(() => reader.cancel());
  let body = '';
  for (let snapshot = 0; snapshot < 2; snapshot++) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    body += new TextDecoder().decode(chunk.value);
    await new Promise<void>(resolve => setImmediate(resolve));
    t.mock.timers.tick(1000);
  }
  assert.equal((await reader.read()).done, true);
  assert.equal(requests.length, 2);
  assert.equal((body.match(/event: view/g) ?? []).length, 2);
  const data = body.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  assert.deepEqual(data, [{ view }, { view }]);
  const queries = f.queryCount() - before;
  assert.ok(queries > 0, 'Count the real control-plane authorization queries, not only relay calls');
  assert.ok(queries + requests.length <= 50, `Connected polling used ${queries} database queries plus ${requests.length} relay calls`);
});

test('a host is asked for what changed only on the connection that reported the revision', async t => {
  const f = await fixture(t); const s = await sharedSession(f);
  const view: SessionView = {
    sessionId: s.session.id,
    owner: { id: s.creator.user.id, displayName: 'Creator', gitName: 'Creator', gitEmail: 'creator@example.test', githubLogin: 'creator' },
    entries: [{ id: '0:1', kind: 'message', role: 'user', text: 'hello' }], approvals: [], conversations: [], busy: false,
  };
  const busy: SessionView = { ...view, busy: true };
  const [first, second] = ['a'.repeat(32), 'b'.repeat(32)];
  const seen: { path: string; connection: string }[] = [];
  f.env.CONNECTOR_HUB = fakeHub({ async rpc(_connectorId, envelope) {
    seen.push({ path: envelope.request.path, connection: envelope.connectionHash });
    if (envelope.request.path.endsWith(`/view/${first}`)) return Response.json({ patch: diffView(view, busy, first, second) });
    return Response.json({ view, revision: first });
  } });
  const read = async () => (await json<{ view: SessionView }>(await s.creator.request('GET', `/api/sessions/${s.session.id}/view`))).view;
  assert.deepEqual(await read(), view);
  assert.deepEqual(await read(), busy);
  const base = `/v1/sessions/${s.session.id}/view`;
  assert.deepEqual(seen.map(item => item.path), [base, `${base}/${first}`]);
  f.sqlite.prepare('UPDATE connectors SET connection_hash = ? WHERE id = ?').run(await sha256(token()), s.connector.connectorId);
  assert.deepEqual(await read(), view);
  assert.equal(seen[2]!.path, base);
  assert.notEqual(seen[2]!.connection, seen[1]!.connection);
});

test('per-message chat options are checked against the session host, mode and owner before reaching the runtime', async t => {
  const f = await fixture(t); const s = await sharedSession(f);
  await json(await s.creator.request('POST', `/api/sessions/${s.session.id}/grants`, { userId: s.admin.user.id, permissions: ['read', 'ask', 'write'] }));
  const receipt = { submissionId: 'submission', conversationId: 'conversation', status: 'queued' };
  const requests = rpcHub(f, s.connector, () => Response.json(receipt, { status: 202 }));
  const path = `/api/sessions/${s.session.id}`;
  const model = { provider: manifest.models[0].provider, modelId: manifest.models[0].modelId };
  await denied(await s.creator.request('POST', `${path}/submit`, { content: 'Hi', requestId: 'outdated', options: { access: 'read' } }), 409, 'connector_update_required');
  await json(await s.creator.request('POST', `${path}/submit`, { content: 'Hi', requestId: 'empty', options: {} }), 202);
  assert.equal(Object.hasOwn(JSON.parse(requests.at(-1)!.request.body), 'options'), false);
  await json(await self(f, s.connector, 'manifest', {
    models: [{ ...manifest.models[0], thinkingLevels: ['off', 'high'] }], capabilities: { ...manifest.capabilities, chatOptions: true },
  }));
  const before = requests.length;
  await denied(await s.creator.request('POST', `${path}/submit`, { content: 'Hi', requestId: 'foreign', options: { model: { provider: 'local-native', modelId: 'not-on-host' } } }), 403, 'model_not_on_host');
  await denied(await s.creator.request('POST', `${path}/submit`, { content: 'Hi', requestId: 'level', options: { model, thinkingLevel: 'xhigh' } }), 400, 'invalid_options');
  await denied(await s.creator.request('POST', `${path}/ask`, { content: 'Hi', requestId: 'ask-access', options: { access: 'read' } }), 400, 'invalid_options');
  assert.equal(requests.length, before, 'rejected choices never reach the host');
  await json(await s.admin.request('POST', `${path}/submit`, { content: 'Hi', requestId: 'writer-read', options: { access: 'read' } }), 202);
  assert.deepEqual(JSON.parse(requests.at(-1)!.request.body).options, { access: 'read' });
  const options = { model, thinkingLevel: 'high' };
  await json(await s.creator.request('POST', `${path}/submit`, { content: 'Hi', requestId: 'owner-auto', options: { ...options, access: 'auto' } }), 202);
  assert.deepEqual(JSON.parse(requests.at(-1)!.request.body).options, options, 'a message that acts names no access: only Read only does');
  await json(await s.admin.request('POST', `${path}/submit`, { content: 'Hi', requestId: 'writer-auto', options: { access: 'auto' } }), 202);
  assert.equal(Object.hasOwn(JSON.parse(requests.at(-1)!.request.body), 'options'), false);
  await json(await s.creator.request('POST', `${path}/ask`, { content: 'Hi', requestId: 'ask-model', options: { model, thinkingLevel: 'off' } }), 202);
  assert.equal(requests.at(-1)!.request.ticket.action, 'ask');
  assert.deepEqual(JSON.parse(requests.at(-1)!.request.body).options, { model, thinkingLevel: 'off' });
});

test('pasted images are checked and go only to a host whose connector gives them to the model', async t => {
  const f = await fixture(t); const s = await sharedSession(f);
  const receipt = { submissionId: 'submission', conversationId: 'conversation', status: 'queued' };
  const requests = rpcHub(f, s.connector, () => Response.json(receipt, { status: 202 }));
  const path = `/api/sessions/${s.session.id}`;
  const image = { mimeType: 'image/png', data: 'iVBORw0KGgo=' };
  await denied(await s.creator.request('POST', `${path}/submit`, { content: 'Look', requestId: 'outdated', images: [image] }), 409, 'connector_update_required');
  await json(await s.creator.request('POST', `${path}/submit`, { content: 'Hi', requestId: 'none', images: [] }), 202);
  assert.equal(Object.hasOwn(JSON.parse(requests.at(-1)!.request.body), 'images'), false);
  await json(await self(f, s.connector, 'manifest', { models: manifest.models, capabilities: { ...manifest.capabilities, chatImages: true } }));
  const before = requests.length;
  await denied(await s.creator.request('POST', `${path}/submit`, { content: 'Look', requestId: 'svg', images: [{ ...image, mimeType: 'image/svg+xml' }] }), 400, 'invalid_images');
  await denied(await s.creator.request('POST', `${path}/submit`, { content: 'Look', requestId: 'many', images: Array(5).fill(image) }), 400, 'invalid_images');
  await denied(await s.creator.request('POST', `${path}/submit`, { content: 'Look', requestId: 'large', images: [{ ...image, data: 'A'.repeat(512 * 1024 + 4) }] }), 400, 'invalid_images');
  await denied(await s.creator.request('POST', `${path}/submit`, { content: '', requestId: 'empty' }), 400, 'invalid_input');
  const third = 'A'.repeat(240 * 1024);
  await denied(await s.creator.request('POST', `${path}/submit`, { content: '\u0001'.repeat(60000), requestId: 'too-large',
    images: [{ ...image, data: third }, { ...image, data: third }, { ...image, data: third }] }), 413, 'message_too_large');
  assert.equal(requests.length, before, 'refused images never reach the host');
  await json(await s.creator.request('POST', `${path}/submit`, { content: '', requestId: 'alone', images: [image] }), 202);
  const sent = JSON.parse(requests.at(-1)!.request.body);
  assert.equal(sent.content, '');
  assert.deepEqual(sent.images, [image]);
  assert.match(sent.admissionId, /^[A-Za-z0-9_-]{43}$/);
  await json(await s.creator.request('POST', `${path}/ask`, { content: 'What is this?', requestId: 'ask', images: [image, image] }), 202);
  assert.equal(requests.at(-1)!.request.ticket.action, 'ask');
  assert.deepEqual(JSON.parse(requests.at(-1)!.request.body).images, [image, image]);
  await json(await s.creator.request('POST', `${path}/submit`, { content: 'Same', requestId: 'same', images: [image] }), 202);
  await json(await s.creator.request('POST', `${path}/submit`, { content: 'Same', requestId: 'same', images: [image] }), 202);
  await denied(await s.creator.request('POST', `${path}/submit`, { content: 'Same', requestId: 'same', images: [{ ...image, data: 'AAAA' }] }), 409, 'admission_conflict');
  await denied(await s.creator.request('POST', `${path}/submit`, { content: 'Same', requestId: 'same' }), 409, 'admission_conflict');
  const audit = f.sqlite.prepare(`SELECT detail_json FROM audit WHERE session_id = ? AND action = 'session.submit'`).all(s.session.id) as { detail_json: string }[];
  assert.deepEqual(audit.map(row => JSON.parse(row.detail_json).images ?? 0).sort(), [0, 1, 1, 1]);
});

test('broker callbacks need github_comment among the tools of the session owner\'s group, whatever the message', async t => {
  const f = await fixture(t); const s = await sharedSession(f, ['identity']); const fetch = githubFetch(t);
  assert.equal((await json<{ allowed: boolean }>(await self(f, s.connector, 'authorize', authorization(s.session)))).allowed, true);
  await inGroup(s.admin, s.team.id, s.creator, 'Readers', ['identity', 'read_file']);
  const payload = await brokerPayload(f, s.session);
  await denied(await self(f, s.connector, 'github/comment', payload), 403, 'tool_not_in_group');
  assert.equal(fetch.mock.callCount(), 0);
});

test('github merges need a pinned repository, run once per tool call, and tell GitHub refusals apart from unknown outcomes', async t => {
  const f = await fixture(t); const s = await sharedSession(f, ['identity', 'github_merge']);
  let answer = () => Response.json({ merged: true, sha: mergedSha, message: 'Pull Request successfully merged' });
  const calls = mergeFetch(t, () => answer());
  const consumed = (approvalId: string) => f.sqlite.prepare('SELECT created_at FROM automatic_github_effects WHERE approval_id = ?').get(approvalId)?.created_at ?? null;
  const audits = (action: string) => Number(f.sqlite.prepare('SELECT COUNT(*) AS n FROM audit WHERE action = ?').get(action)!.n);

  const unpinned = await mergePayload(f, s.session, 'owner/other');
  await denied(await self(f, s.connector, 'github/merge', unpinned), 403, 'repository_not_pinned');
  assert.deepEqual(calls, []);
  assert.equal(consumed(unpinned.approvalId), null);

  const payload = await mergePayload(f, s.session);
  assert.deepEqual(await json(await self(f, s.connector, 'github/merge', payload)), { sha: mergedSha, url: 'https://github.com/owner/repo/pull/5' });
  assert.deepEqual(calls, ['GET https://api.github.com/repos/owner/repo', 'PUT https://api.github.com/repos/owner/repo/pulls/5/merge']);
  assert.ok(consumed(payload.approvalId));
  assert.equal(audits('github.merge.attempted'), 1);
  assert.equal(audits('github.merge.completed'), 1);
  await denied(await self(f, s.connector, 'github/merge', payload), 409, 'capability_consumed');
  assert.equal(calls.length, 2);

  answer = () => Response.json({ message: 'Pull Request is not mergeable' }, { status: 405 });
  const refused = await mergePayload(f, s.session);
  const refusal = await json<{ code: string; error: string }>(await self(f, s.connector, 'github/merge', refused), 422);
  assert.equal(refusal.code, 'github_merge_refused');
  assert.ok(refusal.error.includes('Pull Request is not mergeable'), refusal.error);
  assert.ok(refusal.error.includes('owner/repo#5'), refusal.error);
  assert.ok(consumed(refused.approvalId));
  assert.equal(audits('github.merge.failed'), 1);
  assert.equal(calls.length, 4);

  answer = () => Response.json({ message: 'Server Error' }, { status: 502 });
  const unknown = await mergePayload(f, s.session);
  await denied(await self(f, s.connector, 'github/merge', unknown), 502, 'github_outcome_unknown');
  assert.ok(consumed(unknown.approvalId));
  assert.equal(audits('github.merge.ambiguous'), 1);
  assert.equal(calls.length, 6);
  assert.ok(!JSON.stringify(f.sqlite.prepare('SELECT * FROM audit').all()).includes(githubToken));
});

test('github issues need a workspace repository, run once per tool call, and tell GitHub refusals apart from unknown outcomes', async t => {
  const f = await fixture(t); const s = await sharedSession(f, ['identity', 'github_issue']);
  let answer = () => Response.json({ number: 63, html_url: 'https://github.com/owner/repo/issues/63', title: 'Sandbox has no CA certificates' }, { status: 201 });
  const calls = issueFetch(t, () => answer());
  const consumed = (approvalId: string) => f.sqlite.prepare('SELECT created_at FROM automatic_github_effects WHERE approval_id = ?').get(approvalId)?.created_at ?? null;
  const audits = (action: string) => Number(f.sqlite.prepare('SELECT COUNT(*) AS n FROM audit WHERE action = ?').get(action)!.n);

  const outside = await issuePayload(f, s.session, 'owner/other');
  await denied(await self(f, s.connector, 'github/issue', outside), 403, 'repository_not_pinned');
  assert.deepEqual(calls, []);
  assert.equal(consumed(outside.approvalId), null);
  const altered = await issuePayload(f, s.session);
  await denied(await self(f, s.connector, 'github/issue', { ...altered, title: 'Two\nlines' }), 400, 'invalid_operation');
  await denied(await self(f, s.connector, 'github/issue', { ...altered, labels: ['bug'] }), 400, 'invalid_input');
  assert.deepEqual(calls, []);

  const payload = await issuePayload(f, s.session);
  assert.deepEqual(await json(await self(f, s.connector, 'github/issue', payload)), { number: 63, url: 'https://github.com/owner/repo/issues/63' });
  assert.deepEqual(calls, ['GET https://api.github.com/repos/owner/repo', 'POST https://api.github.com/repos/owner/repo/issues']);
  assert.ok(consumed(payload.approvalId));
  assert.equal(audits('github.issue.attempted'), 1);
  assert.equal(audits('github.issue.completed'), 1);
  await denied(await self(f, s.connector, 'github/issue', payload), 409, 'capability_consumed');
  assert.equal(calls.length, 2);

  answer = () => Response.json({ message: 'Issues are disabled for this repo' }, { status: 410 });
  const refused = await issuePayload(f, s.session);
  const refusal = await json<{ code: string; error: string }>(await self(f, s.connector, 'github/issue', refused), 422);
  assert.equal(refusal.code, 'github_issue_refused');
  assert.ok(refusal.error.includes('Issues are disabled for this repo'), refusal.error);
  assert.ok(refusal.error.includes('owner/repo'), refusal.error);
  assert.ok(consumed(refused.approvalId));
  assert.equal(audits('github.issue.failed'), 1);
  assert.equal(calls.length, 4);

  for (const unclear of [() => Response.json({ message: 'Server Error' }, { status: 502 }), () => Response.json({}, { status: 201 })]) {
    answer = unclear;
    const unknown = await issuePayload(f, s.session);
    await denied(await self(f, s.connector, 'github/issue', unknown), 502, 'github_outcome_unknown');
    assert.ok(consumed(unknown.approvalId));
  }
  assert.equal(audits('github.issue.ambiguous'), 2);
  assert.equal(calls.length, 8);
  assert.ok(!JSON.stringify(f.sqlite.prepare('SELECT * FROM audit').all()).includes(githubToken));
});

test('github reads need the requester\'s live write admission, github_read among the owner\'s tools, and a pinned repository before any GitHub call', async t => {
  const f = await fixture(t); const s = await sharedSession(f, ['identity']);
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('GitHub must not be called'); });
  await json(await s.creator.request('POST', `/api/sessions/${s.session.id}/grants`, { userId: s.admin.user.id, permissions: ['write'] }));
  const owner = s.session.ownerId;
  const read = (admissionId: string, body: Record<string, unknown> = {}) => self(f, s.connector, 'github/read', {
    sessionId: s.session.id, actorId: owner, admissionId, callId: 'call-1', repository: 'owner/other', issue: 5, ...body,
  });
  for (const admissionId of [
    token(), admit(f, s.session.id, owner, { expiresAt: Math.floor(Date.now() / 1000) - 1 }),
    admit(f, s.session.id, owner, { mode: 'ask' }), admit(f, s.session.id, s.admin.user.id),
  ]) {
    await denied(await read(admissionId), 403, 'github_read_not_admitted');
  }
  const admissionId = admit(f, s.session.id, owner);
  await inGroup(s.admin, s.team.id, s.creator, 'Readers', ['identity', 'read_file']);
  await denied(await read(admissionId), 403, 'tool_not_in_group');
  await inGroup(s.admin, s.team.id, s.creator, 'All tools', [...groupTools]);
  await denied(await read(admissionId), 403, 'repository_not_pinned');
  await denied(await read(admissionId, { callId: 'call-3', issue: 6 }), 403, 'repository_not_pinned');
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'github.read'").get()!.n, 0);
});

test('a github read returns the owner\'s view of a pull request with its reviews, review comments and checks, bounded and audited', async t => {
  const f = await fixture(t); const s = await sharedSession(f, ['identity', 'github_read']);
  const api = 'https://api.github.com/repos/owner/repo';
  const createdAt = '2026-10-01T00:00:00Z';
  const hunk = `${'h'.repeat(10)}${'line\n'.repeat(300)}`;
  const comments = (from: number, count: number) => Array.from({ length: count }, (_, index) => ({
    id: from + index, user: { login: 'commenter' }, created_at: createdAt, body: `comment ${from + index}`, html_url: `https://github.com/owner/repo/pull/5#issuecomment-${from + index}`,
  }));
  const routes: Record<string, () => Response> = {
    [api]: () => Response.json({ id: 7, full_name: 'owner/repo', default_branch: 'main', private: true }),
    [`${api}/issues/5`]: () => Response.json({ html_url: 'https://github.com/owner/repo/pull/5', title: 'Fix it', state: 'open', user: { login: 'author' },
      created_at: createdAt, body: 'b'.repeat(16005), labels: [{ name: 'bug' }, 'plain'], pull_request: { url: `${api}/pulls/5` } }),
    [`${api}/issues/5/comments?per_page=100&page=1`]: () => Response.json(comments(1, 100), { headers: {
      Link: `<https://api.github.com/repositories/7/issues/5/comments?per_page=100&page=2>; rel="next", <https://api.github.com/repositories/7/issues/5/comments?per_page=100&page=3>; rel="last"`,
    } }),
    [`${api}/issues/5/comments?per_page=100&page=2`]: () => Response.json(comments(101, 100)),
    [`${api}/issues/5/comments?per_page=100&page=3`]: () => Response.json(comments(201, 30)),
    [`${api}/pulls/5`]: () => Response.json({ draft: false, merged: false, mergeable: true, mergeable_state: 'clean',
      head: { ref: 'feature', sha: headSha, repo: { full_name: 'owner/repo' } }, base: { ref: 'main', sha: 'a'.repeat(40) } }),
    [`${api}/pulls/5/reviews?per_page=100&page=1`]: () => Response.json([{ id: 11, user: { login: 'reviewer' }, state: 'CHANGES_REQUESTED',
      submitted_at: createdAt, commit_id: headSha, body: 'Please fix', html_url: 'https://github.com/owner/repo/pull/5#pullrequestreview-11' }]),
    [`${api}/pulls/5/comments?per_page=100&page=1`]: () => Response.json([{ id: 21, user: { login: 'reviewer' }, created_at: createdAt,
      path: 'src/a.ts', line: 12, original_line: 10, commit_id: headSha, body: 'Off by one', diff_hunk: hunk,
      html_url: 'https://github.com/owner/repo/pull/5#discussion_r21' }]),
    [`${api}/commits/${headSha}/check-runs?per_page=100&page=1`]: () => Response.json({ total_count: 101,
      check_runs: Array.from({ length: 100 }, (_, index) => ({ name: `run-${index + 1}`, status: 'completed', conclusion: 'success' })) }),
    [`${api}/commits/${headSha}/check-runs?per_page=100&page=2`]: () => Response.json({ total_count: 101,
      check_runs: [{ name: 'test', status: 'completed', conclusion: 'failure' }] }),
    [`${api}/commits/${headSha}/status?per_page=100&page=1`]: () => Response.json({ state: 'pending', total_count: 2, statuses: [
      { context: 'ci/legacy', state: 'pending' }, { context: 'ci/lint', state: 'success' },
    ] }),
    [`${api}/issues/6`]: () => Response.json({ message: 'Not Found' }, { status: 404 }),
    [`${api}/issues/8`]: () => Response.json({ html_url: 'https://github.com/owner/repo/issues/8', title: 'Long thread', state: 'open', user: { login: 'author' },
      created_at: createdAt, body: '€'.repeat(16000), labels: [] }),
    [`${api}/issues/8/comments?per_page=100&page=1`]: () => Response.json(comments(1, 100).map(item => ({ ...item, body: 'é'.repeat(1000) }))),
    [`${api}/issues/9`]: () => Response.json({ html_url: 'https://github.com/owner/repo/issues/9', title: '\u0001'.repeat(1000), state: 'open', user: { login: 'author' },
      created_at: createdAt, body: '\u0001'.repeat(16000), labels: [] }),
    [`${api}/issues/9/comments?per_page=100&page=1`]: () => Response.json([]),
  };
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    assert.equal(init?.method ?? 'GET', 'GET');
    assert.equal(init?.redirect, 'manual');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${githubToken}`);
    const route = routes[url];
    assert.ok(route, `unexpected GitHub call ${url}`);
    return route();
  });
  const audits = () => f.sqlite.prepare("SELECT detail_json FROM audit WHERE action = 'github.read'").all().map(row => JSON.parse(String(row.detail_json)));
  const admissionId = admit(f, s.session.id, s.session.ownerId);
  const read = (issue: number) => self(f, s.connector, 'github/read', {
    sessionId: s.session.id, actorId: s.session.ownerId, admissionId, callId: 'call-1', repository: 'OWNER/Repo', issue,
  });

  const view = await json<GitHubIssueView>(await read(5));
  assert.deepEqual([view.repository, view.number, view.url, view.title, view.state, view.author, view.createdAt, view.labels],
    ['owner/repo', 5, 'https://github.com/owner/repo/pull/5', 'Fix it', 'open', 'author', createdAt, ['bug', 'plain']]);
  assert.equal(view.body, `${'b'.repeat(16000)}\n… 5 more characters`);
  assert.equal(view.comments.length, 100);
  assert.deepEqual([view.comments[0].id, view.comments.at(-1)!.id], [131, 230]);
  assert.deepEqual(view.comments[0], { id: 131, author: 'commenter', createdAt, body: 'comment 131', url: 'https://github.com/owner/repo/pull/5#issuecomment-131' });
  assert.deepEqual(view.omitted, { comments: 130, checks: 3 });
  assert.deepEqual(view.pullRequest, {
    draft: false, merged: false, mergeable: true, mergeableState: 'clean',
    head: { ref: 'feature', sha: headSha, repository: 'owner/repo' }, base: { ref: 'main', sha: 'a'.repeat(40) },
    reviews: [{ id: 11, author: 'reviewer', state: 'CHANGES_REQUESTED', submittedAt: createdAt, commit: headSha, body: 'Please fix',
      url: 'https://github.com/owner/repo/pull/5#pullrequestreview-11' }],
    reviewComments: [{ id: 21, inReplyTo: null, author: 'reviewer', createdAt, path: 'src/a.ts', line: 12, originalLine: 10, commit: headSha,
      body: 'Off by one', diffHunk: `… 10 earlier characters\n${hunk.slice(-1500)}`, url: 'https://github.com/owner/repo/pull/5#discussion_r21' }],
    checks: [
      { name: 'test', status: 'completed', conclusion: 'failure' }, { name: 'ci/legacy', status: 'pending', conclusion: null },
      ...Array.from({ length: 98 }, (_, index) => ({ name: `run-${index + 1}`, status: 'completed', conclusion: 'success' })),
    ],
  });
  assert.equal(calls[0], api, 'the pin identity is checked before any read');
  const pullRoutes = Object.keys(routes).filter(url => !/\/issues\/[689]/.test(url));
  assert.deepEqual(calls.toSorted(), pullRoutes.toSorted());
  assert.ok(!JSON.stringify(view).includes(githubToken));
  assert.deepEqual(audits(), [{ repository: 'owner/repo', issue: 5, actingAs: s.session.ownerId }]);

  await denied(await read(6), 404, 'github_not_found');
  assert.equal(audits().length, 1);

  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  const thread = await json<GitHubIssueView>(await read(8));
  assert.ok(bytes(thread) <= 96 * 1024, String(bytes(thread)));
  assert.equal(thread.body, '€'.repeat(16000));
  assert.equal(thread.omitted!.comments! + thread.comments.length, 100);
  assert.ok(thread.comments.length > 0 && thread.comments.at(-1)!.id === 100);
  const escaped = await json<GitHubIssueView>(await read(9));
  assert.ok(bytes(escaped) <= 96 * 1024, String(bytes(escaped)));
  assert.equal(escaped.body, `${'\u0001'.repeat(8000)}\n… cut to fit the read limit`);
});

test('write admission quota follows an actor across sessions without blocking another owner or losing ambiguous receipts', async t => {
  const f = await fixture(t); const s = await sharedSession(f);
  const cloneSession = f.sqlite.prepare(`INSERT INTO sessions
    (id,workspace_id,owner_id,agent_version_id,title,policy_version,status,created_at,connector_id,connector_owner_id)
    SELECT ?,workspace_id,?,agent_version_id,title,policy_version,status,created_at,connector_id,connector_owner_id
    FROM sessions WHERE id = ?`);
  const sessionIds = [s.session.id];
  for (let index = 1; index < 10; index++) {
    const sessionId = `actor-budget-session-${index}`;
    cloneSession.run(sessionId, s.creator.user.id, s.session.id);
    sessionIds.push(sessionId);
  }
  cloneSession.run('unrelated-owner-session', s.admin.user.id, s.session.id);
  const content = 'Quota-bound write';
  const contentHash = await sha256(content);
  const createdAt = new Date().toISOString();
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const seed = f.sqlite.prepare(`INSERT INTO run_admissions
    (id,session_id,actor_id,mode,request_id,content_hash,expires_at,created_at) VALUES (?,?,?,'write',?,?,?,?)`);
  for (let index = 0; index < 999; index++) {
    seed.run(`actor-budget-${index}`.padEnd(43, '_'), sessionIds[index % sessionIds.length], s.creator.user.id,
      `seed-${index}`, contentHash, expiresAt, createdAt);
  }
  let failDispatch = true;
  const requests = rpcHub(f, s.connector, envelope => {
    assert.equal(envelope.request.ticket.action, 'submit');
    if (failDispatch) return Response.json({ error: 'Ambiguous dispatch' }, { status: 503 });
    return Response.json({ submissionId: 'quota-submission', conversationId: 'quota-conversation', status: 'queued' }, { status: 202 });
  });
  const path = `/api/sessions/${s.session.id}/submit`;
  const input = { content, requestId: 'last-actor-slot' };
  await denied(await s.creator.request('POST', path, input), 503, 'runner_error');
  const stored = f.sqlite.prepare('SELECT * FROM run_admissions WHERE session_id = ? AND actor_id = ? AND request_id = ?')
    .get(s.session.id, s.creator.user.id, input.requestId)!;
  assert.ok(stored, 'An ambiguous dispatch must retain its admission');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM run_admissions WHERE actor_id = ?').get(s.creator.user.id)!.n, 1000);
  await denied(await s.creator.request('POST', `/api/sessions/${sessionIds[1]}/submit`, {
    content, requestId: 'cannot-escape-through-another-session',
  }), 409, 'admission_unavailable');
  assert.equal(requests.length, 1, 'Quota denial must happen before relay dispatch');
  failDispatch = false;
  await json(await s.creator.request('POST', path, input), 202);
  assert.equal(JSON.parse(requests[1].request.body).admissionId, stored.id, 'A full quota must not replace an existing receipt');
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM run_admissions WHERE id = ?').get(stored.id as string), stored);
  await denied(await s.creator.request('POST', path, { ...input, content: 'Changed retry' }), 409, 'admission_conflict');
  assert.equal(requests.length, 2);
  await json(await s.admin.request('POST', '/api/sessions/unrelated-owner-session/submit', {
    content, requestId: 'unrelated-owner-write',
  }), 202);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM run_admissions').get()!.n, 1001);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM run_admissions WHERE actor_id = ?').get(s.admin.user.id)!.n, 1);
});

test('owner admission budgets aggregate collaborators but do not impose a cross-tenant global gate', async t => {
  const f = await fixture(t); const s = await sharedSession(f);
  const createdAt = new Date().toISOString();
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const content = 'Owner-budget write';
  const contentHash = await sha256(content);
  const cloneSession = f.sqlite.prepare(`INSERT INTO sessions
    (id,workspace_id,owner_id,agent_version_id,title,policy_version,status,created_at,connector_id,connector_owner_id)
    SELECT ?,workspace_id,?,agent_version_id,title,policy_version,status,created_at,connector_id,connector_owner_id
    FROM sessions WHERE id = ?`);
  const seed = f.sqlite.prepare(`INSERT INTO run_admissions
    (id,session_id,actor_id,mode,request_id,content_hash,expires_at,created_at) VALUES (?,?,?,'write',?,?,?,?)`);
  const grant = f.sqlite.prepare('INSERT INTO session_grants (session_id,user_id,permissions_json,created_at) VALUES (?,?,?,?)');
  const tenants: { owner: Client; sessionIds: string[]; actors: Client[] }[] = [];
  for (const [tenant, owner] of [s.creator, s.admin].entries()) {
    const sessionIds: string[] = [];
    const actors: Client[] = [];
    for (let index = 0; index < 10; index++) {
      const sessionId = `owner-budget-${tenant}-${index}`;
      cloneSession.run(sessionId, owner.user.id, s.session.id);
      sessionIds.push(sessionId);
    }
    for (let index = 0; index < 5; index++) {
      const actor = await f.client(`quota-writer-${tenant}-${index}`);
      await addMember(s.admin, s.team.id, actor);
      actors.push(actor);
      for (const sessionId of sessionIds) grant.run(sessionId, actor.user.id, '["write"]', createdAt);
    }
    tenants.push({ owner, sessionIds, actors });
    const count = tenant === 0 ? 4999 : 5000;
    for (let index = 0; index < count; index++) {
      seed.run(`owner-budget-${tenant}-${index}`.padEnd(43, '_'), sessionIds[index % sessionIds.length],
        actors[index % actors.length].user.id, `seed-${index}`, contentHash, expiresAt, createdAt);
    }
  }
  const requests = rpcHub(f, s.connector, envelope => {
    assert.equal(envelope.request.ticket.action, 'submit');
    return Response.json({ submissionId: 'owner-quota-submission', conversationId: 'owner-quota-conversation', status: 'queued' }, { status: 202 });
  });
  const target = tenants[0].sessionIds[0];
  const path = `/api/sessions/${target}/submit`;
  const input = { content, requestId: 'last-owner-slot' };
  await json(await s.creator.request('POST', path, input), 202);
  const admitted = f.sqlite.prepare('SELECT * FROM run_admissions WHERE session_id = ? AND actor_id = ? AND request_id = ?')
    .get(target, s.creator.user.id, input.requestId)!;
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM run_admissions').get()!.n, 10000);
  await denied(await s.creator.request('POST', `/api/sessions/${tenants[0].sessionIds[1]}/submit`, {
    content, requestId: 'cannot-escape-owner-budget',
  }), 409, 'admission_unavailable');
  assert.equal(requests.length, 1);
  await json(await s.creator.request('POST', path, input), 202);
  assert.equal(JSON.parse(requests[1].request.body).admissionId, admitted.id);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM run_admissions WHERE id = ?').get(admitted.id as string), admitted);
  cloneSession.run('third-owner-session', s.host.user.id, s.session.id);
  await json(await s.host.request('POST', '/api/sessions/third-owner-session/submit', {
    content, requestId: 'third-owner-is-independent',
  }), 202);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM run_admissions').get()!.n, 10001);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM run_admissions WHERE actor_id = ?').get(s.host.user.id)!.n, 1);
});

test('workspace pairing imports a private connector catalog without granting teammates discovery or guessed model access', async t => {
  const f = await fixture(t); const s = await privateWorkspace(f);
  const associations = f.sqlite.prepare('SELECT workspace_id FROM connector_workspaces WHERE connector_id = ?').all(s.connector.connectorId);
  assert.deepEqual(associations.map(row => row.workspace_id), [s.team.id]);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM connector_shares').get()!.n, 0);
  assert.equal(f.sqlite.prepare('SELECT available FROM models WHERE id = ?').get(s.model.id)!.available, 1);
  const own = await json<{ connectors: ConnectorInfo[] }>(await s.owner.request('GET', `/api/workspaces/${s.team.id}/connectors`));
  assert.equal(own.connectors.length, 1);
  assert.equal(own.connectors[0].id, s.connector.connectorId);
  assert.deepEqual(own.connectors[0].workspaceIds, []);
  assert.deepEqual(own.connectors[0].connectedWorkspaceIds, [s.team.id]);
  assert.deepEqual(await json(await s.member.request('GET', `/api/workspaces/${s.team.id}/connectors`)), { connectors: [] });
  assert.deepEqual(await json(await s.member.request('GET', `/api/workspaces/${s.team.id}/models`)), { models: [] });
  assert.deepEqual(await json(await s.member.request('GET', '/api/connectors')), { connectors: [] });
  await denied(await s.member.request('POST', '/api/sessions', { ...s.input, trustedConnectorId: s.connector.connectorId }), 404, 'not_found');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM agents').get()!.n, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM agent_versions').get()!.n, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 0);
  assert.equal(s.hub.requests.length, 0);
  await denied(await s.outsider.request('GET', `/api/workspaces/${s.team.id}/connectors`), 404, 'not_found');
  await denied(await s.outsider.request('GET', `/api/workspaces/${s.team.id}/models`), 404, 'not_found');
  await json(await self(f, s.connector, 'manifest', { ...manifest, models: [{ ...manifest.models[0], name: 'Private renamed model' }] }));
  const updated = await json<{ models: ModelDefinition[] }>(await s.owner.request('GET', `/api/workspaces/${s.team.id}/models`));
  assert.deepEqual(updated.models, [{ ...s.model, name: 'Private renamed model' }]);
  assert.deepEqual(await json(await s.member.request('GET', `/api/workspaces/${s.team.id}/models`)), { models: [] });
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM connector_shares').get()!.n, 0);
});

test('owner runs a session on an unshared host and the default session is listed and readable only as read by members', async t => {
  const f = await fixture(t); const s = await privateHostSession(f);
  assert.equal(s.session.visibility, 'workspace');
  assert.equal(f.sqlite.prepare('SELECT visibility FROM sessions WHERE id = ?').get(s.session.id)!.visibility, 'workspace');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM session_grants').get()!.n, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM connector_shares').get()!.n, 0);
  assert.deepEqual(s.session.permissions, ['read', 'ask', 'write', 'approve', 'manage']);
  assert.equal(s.hub.requests.length, 1);
  const binding = JSON.parse(s.hub.requests[0].request.body) as RunnerBinding;
  assert.equal(binding.owner.id, s.owner.user.id);
  assert.equal(binding.agent.id, s.session.agentVersionId);
  assert.equal(binding.agent.authorId, s.owner.user.id);
  assert.equal(binding.agent.workspaceId, null);
  assert.equal(binding.model.id, s.model.id);
  assert.equal(binding.session.visibility, undefined);
  assert.equal(binding.session.permissions, undefined);
  assert.equal(s.hub.requests[0].request.ticket.actorId, s.owner.user.id);
  const { session } = await json<{ session: SessionRecord }>(await s.member.request('GET', `/api/sessions/${s.session.id}`));
  assert.deepEqual(session.permissions, ['read']);
  assert.equal(session.visibility, 'workspace');
  assert.equal(session.cloneUnavailable, undefined);
  const { viewable, ...record } = session;
  assert.equal(viewable, true);
  const listed = await json<{ sessions: SessionRecord[] }>(await s.member.request('GET', '/api/sessions'));
  assert.deepEqual(listed.sessions, [record]);
  const requests = rpcHub(f, s.connector, envelope => {
    assert.equal(envelope.request.ticket.action, 'view');
    assert.equal(envelope.request.ticket.actorId, s.member.user.id);
    assert.equal(envelope.request.ticket.ownerId, s.owner.user.id);
    return Response.json({ view: s.view });
  });
  assert.deepEqual((await json<{ view: SessionView }>(await s.member.request('GET', `/api/sessions/${s.session.id}/view`))).view, s.view);
  assert.equal(requests.length, 1);
  await denied(await s.outsider.request('GET', `/api/sessions/${s.session.id}`), 404, 'not_found');
  await denied(await s.outsider.request('GET', `/api/sessions/${s.session.id}/view`), 404, 'not_found');
  assert.deepEqual(await json(await s.outsider.request('GET', '/api/sessions')), { sessions: [] });
  assert.equal(requests.length, 1);
});

test('a session starts from a model and gets its own chat agent with every tool its host carries', async t => {
  const f = await fixture(t); const s = await privateWorkspace(f);
  const start = (client: Client, body: Record<string, unknown>) => client.request('POST', '/api/sessions', { workspaceId: s.team.id, ...body });
  const offered = toolNames.filter(tool => !retiredToolNames.includes(tool));
  const startedAgent = () => (JSON.parse(s.hub.requests.at(-1)!.request.body) as RunnerBinding).agent;

  await denied(await start(s.owner, {}), 400, 'invalid_input');
  const saved = seedAgentVersion(f.sqlite, { authorId: s.owner.user.id, modelId: s.model.id, tools: ['identity'] });
  for (const body of [{ agentVersionId: saved.id }, { agentVersionId: saved.id, modelId: s.model.id }]) {
    await denied(await start(s.owner, body), 400, 'invalid_input');
  }
  await denied(await start(s.member, { modelId: s.model.id, trustedConnectorId: s.connector.connectorId }), 404, 'not_found');
  assert.equal(s.hub.requests.length, 0);

  const { session } = await json<{ session: SessionRecord }>(await start(s.owner, { modelId: s.model.id }), 201);
  assert.equal(session.status, 'ready');
  const agent = startedAgent();
  assert.equal(agent.id, session.agentVersionId);
  assert.deepEqual(agent.tools, offered.filter(tool => !['git_push', 'github_read', 'github_merge', 'host_bash', 'github_issue', 'schedule', 'sessions', 'source_read'].includes(tool)));
  assert.deepEqual([agent.name, agent.instructions, agent.workspaceId, agent.authorId, agent.modelId], [s.model.name, '', null, s.owner.user.id, s.model.id]);

  await denied(await s.owner.request('GET', '/api/agents'), 404, 'not_found');
  await denied(await s.owner.request('POST', `/api/agents/${agent.agentId}/versions`, { tools: ['identity'], modelId: s.model.id }), 404, 'not_found');
  await denied(await s.owner.request('POST', `/api/agents/${agent.agentId}/publish`, { workspaceId: s.team.id }), 404, 'not_found');

  await json(await self(f, s.connector, 'manifest', { ...manifest, capabilities: { ...manifest.capabilities, gitPush: true } }));
  const { session: second } = await json<{ session: SessionRecord }>(await start(s.owner, { modelId: s.model.id }), 201);
  assert.notEqual(second.agentVersionId, session.agentVersionId);
  assert.deepEqual(startedAgent().tools, offered.filter(tool => !['github_read', 'github_merge', 'host_bash', 'github_issue', 'schedule', 'sessions', 'source_read'].includes(tool)));

  await json(await self(f, s.connector, 'manifest', { ...manifest, capabilities: { ...manifest.capabilities, gitPush: true, github: true, hostCommands: true } }));
  const { session: third } = await json<{ session: SessionRecord }>(await start(s.owner, { modelId: s.model.id }), 201);
  assert.notEqual(third.agentVersionId, second.agentVersionId);
  assert.deepEqual(startedAgent().tools, offered.filter(tool => !['github_issue', 'schedule', 'sessions', 'source_read'].includes(tool)));

  await json(await self(f, s.connector, 'manifest', { ...manifest, capabilities: { ...manifest.capabilities, gitPush: true, github: true, githubIssues: true, schedules: true, crossSessions: true, sources: true, hostCommands: true, web: true } }));
  const { session: fourth } = await json<{ session: SessionRecord }>(await start(s.owner, { modelId: s.model.id }), 201);
  assert.notEqual(fourth.agentVersionId, third.agentVersionId);
  assert.deepEqual(startedAgent().tools, offered);
  assert.ok(offered.includes('github_issue') && offered.includes('schedule') && offered.includes('sessions'));
  assert.ok(!offered.includes('web_fetch') && !offered.includes('web_search'));
});

test('workspace read does not grant mutations, connector credentials, personal environment or backup access', async t => {
  const f = await fixture(t); const s = await privateHostSession(f);
  const path = `/api/sessions/${s.session.id}`;
  const personalValue = 'owner-personal-environment-not-for-teammates';
  await json(await s.owner.request('PATCH', '/api/me', { env: { APP_CONTEXT: personalValue } }));
  const ciphertext = await encryptToken(f.env, s.owner.user.id, githubToken);
  f.sqlite.prepare('INSERT INTO github_tokens (user_id,ciphertext,updated_at) VALUES (?,?,?)')
    .run(s.owner.user.id, ciphertext, new Date().toISOString());
  f.sqlite.prepare('INSERT INTO backups (id,session_id,owner_id,object_key,sha256,size,created_at) VALUES (?,?,?,?,?,?,?)')
    .run('private-backup', s.session.id, s.owner.user.id, 'private-object-key', 'private-digest', 1, new Date().toISOString());
  const requests = rpcHub(f, s.connector, () => Response.json({ view: s.view }));
  let storageCalls = 0;
  f.env.BUCKET = { provider: 'filesystem', async get() { storageCalls++; throw new Error('Unauthorized backup read'); },
    async put() { storageCalls++; throw new Error('Unauthorized backup write'); }, async delete() { storageCalls++; } };
  for (const [method, suffix, body] of [
    ['POST', '/ask', { content: 'Question', requestId: 'read-only-ask' }],
    ['POST', '/submit', { content: 'Write', requestId: 'read-only-write' }],
    ['POST', '/restart', {}],
    ['POST', '/stop', {}],
    ['POST', '/backup', {}],
    ['GET', '/backups', undefined],
    ['GET', '/backups/private-backup/download', undefined],
    ['GET', '/grants', undefined],
    ['POST', '/grants', { userId: s.member.user.id, permissions: ['manage'] }],
    ['DELETE', `/grants/${encodeURIComponent(s.owner.user.id)}`, undefined],
  ] as const) {
    await denied(await s.member.request(method, `${path}${suffix}`, body), 403, 'forbidden');
  }
  await denied(await s.member.request('PUT', `/api/connectors/${s.connector.connectorId}/shares/${s.team.id}`), 404, 'not_found');
  await denied(await s.member.request('DELETE', `/api/connectors/${s.connector.connectorId}`), 404, 'not_found');
  assert.equal(requests.length, 0);
  assert.equal(storageCalls, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM run_admissions').get()!.n, 0);
  const visible = [];
  for (const route of [path, `${path}/view`, `${path}/audit`, '/api/sessions', '/api/me',
    `/api/workspaces/${s.team.id}/members`, `/api/workspaces/${s.team.id}/connectors`, `/api/workspaces/${s.team.id}/models`]) {
    visible.push(await json(await s.member.request('GET', route)));
  }
  const serialized = JSON.stringify(visible);
  for (const secret of [personalValue, githubToken, ciphertext, s.connector.token, s.connector.connectionToken,
    s.connector.pairing.code, await sha256(s.connector.token), await sha256(s.connector.connectionToken), 'private-object-key', 'private-digest']) {
    assert.ok(!serialized.includes(secret), 'Read-only metadata must not contain credentials, environment or backup storage details');
  }
  assert.equal(storageCalls, 0);
  assert.equal(f.sqlite.prepare('SELECT ciphertext FROM github_tokens WHERE user_id = ?').get(s.owner.user.id)!.ciphertext, ciphertext);
});

test('root visibility PATCH is CSRF protected, for the owner and the workspace\'s owner and admins, versioned and unions rather than replaces explicit grants', async t => {
  const f = await fixture(t); const s = await privateHostSession(f);
  const path = `/api/sessions/${s.session.id}`;
  assert.equal((await s.member.request('PATCH', path, { visibility: 'private' })).status, 403);
  await json(await s.owner.request('POST', `/api/workspaces/${s.team.id}/members`, { userId: s.member.user.id, role: 'collaborator' }));
  const rowBefore = f.sqlite.prepare('SELECT * FROM sessions WHERE id = ?').get(s.session.id)!;
  assert.equal((await s.owner.request('PATCH', path, { visibility: 'private' }, { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await s.owner.request('PATCH', path, { visibility: 'private' }, { Origin: 'https://hostile.example' })).status, 403);
  assert.equal((await s.member.request('PATCH', path, { visibility: 'private' })).status, 403, 'Messaging a shared session is not managing it');
  await denied(await s.outsider.request('PATCH', path, { visibility: 'private' }), 404, 'not_found');
  for (const visibility of ['public', '', null, 1]) {
    assert.equal((await s.owner.request('PATCH', path, { visibility })).status, 400);
  }
  for (const body of [{}, { visibility: 'private', ownerId: s.member.user.id }, { visibility: 'private', title: 'Forged rename' }]) {
    assert.equal((await s.owner.request('PATCH', path, body)).status, 400);
  }
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM sessions WHERE id = ?').get(s.session.id), rowBefore);
  const privateResult = await json<{ session: SessionRecord }>(await s.owner.request('PATCH', path, { visibility: 'private' }));
  assert.equal(privateResult.session.visibility, 'private');
  assert.equal(privateResult.session.policyVersion, Number(rowBefore.policy_version) + 1);
  assert.deepEqual(privateResult.session.permissions, ['read', 'ask', 'write', 'approve', 'manage']);
  await denied(await s.member.request('GET', path), 404, 'not_found');
  assert.deepEqual(await json(await s.member.request('GET', '/api/sessions')), { sessions: [] });
  await json(await s.owner.request('POST', `${path}/grants`, { userId: s.member.user.id, permissions: ['ask', 'manage'] }));
  const granted = await json<{ session: SessionRecord }>(await s.member.request('GET', path));
  assert.deepEqual(granted.session.permissions, ['read', 'ask', 'manage']);
  await denied(await s.member.request('PATCH', path, { visibility: 'workspace' }), 403, 'owner_required');
  assert.equal(f.sqlite.prepare('SELECT policy_version FROM sessions WHERE id = ?').get(s.session.id)!.policy_version, granted.session.policyVersion);
  const grantBefore = f.sqlite.prepare('SELECT * FROM session_grants WHERE session_id = ?').all(s.session.id);
  const shared = await json<{ session: SessionRecord }>(await s.owner.request('PATCH', path, { visibility: 'workspace' }));
  assert.equal(shared.session.policyVersion, granted.session.policyVersion + 1);
  assert.equal(shared.session.visibility, 'workspace');
  assert.deepEqual((await json<{ session: SessionRecord }>(await s.member.request('GET', path))).session.permissions, ['read', 'ask', 'write', 'manage']);
  const privateAgain = await json<{ session: SessionRecord }>(await s.owner.request('PATCH', path, { visibility: 'private' }));
  assert.equal(privateAgain.session.policyVersion, shared.session.policyVersion + 1);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM session_grants WHERE session_id = ?').all(s.session.id), grantBefore);
  assert.deepEqual((await json<{ session: SessionRecord }>(await s.member.request('GET', path))).session.permissions, ['read', 'ask', 'manage']);
  await json(await s.owner.request('PATCH', path, { visibility: 'workspace' }));
  await json(await s.owner.request('DELETE', `${path}/grants/${encodeURIComponent(s.member.user.id)}`));
  assert.deepEqual((await json<{ session: SessionRecord }>(await s.member.request('GET', path))).session.permissions, ['read', 'ask', 'write']);
  await json(await s.owner.request('PATCH', path, { visibility: 'private' }));
  await denied(await s.member.request('GET', path), 404, 'not_found');
  assert.deepEqual(await json(await s.member.request('GET', '/api/sessions')), { sessions: [] });

  await json(await s.owner.request('POST', `/api/workspaces/${s.team.id}/members`, { userId: s.member.user.id, role: 'admin' }));
  const managed = await json<{ session: SessionRecord }>(await s.member.request('GET', path));
  assert.deepEqual(managed.session.permissions, ['read', 'ask', 'write', 'manage']);
  assert.deepEqual((await json<{ sessions: SessionRecord[] }>(await s.member.request('GET', '/api/sessions'))).sessions.map(session => session.id), [s.session.id]);
  const reshared = await json<{ session: SessionRecord }>(await s.member.request('PATCH', path, { visibility: 'workspace' }));
  assert.equal(reshared.session.visibility, 'workspace');
  assert.equal(reshared.session.policyVersion, managed.session.policyVersion + 1);
  assert.deepEqual(reshared.session.permissions, ['read', 'ask', 'write', 'manage'], 'what the admin holds, not the owner\'s access');
  assert.equal((await json<{ session: SessionRecord }>(await s.member.request('PATCH', path, { visibility: 'private' }))).session.visibility, 'private');
  assert.deepEqual(f.sqlite.prepare("SELECT actor_id FROM audit WHERE session_id = ? AND action = 'session.visibility.updated' ORDER BY created_at DESC, rowid DESC LIMIT 2")
    .all(s.session.id).map(row => row.actor_id), [s.member.user.id, s.member.user.id]);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM session_grants WHERE session_id = ?').all(s.session.id), []);
  const stored = f.sqlite.prepare('SELECT * FROM sessions WHERE id = ?').get(s.session.id)!;
  for (const key of ['owner_id', 'workspace_id', 'agent_version_id', 'connector_id', 'connector_owner_id', 'repositories_json']) {
    assert.equal(stored[key], rowBefore![key], key);
  }
  assert.equal(s.hub.requests.length, 1, 'Visibility changes must not reprovision the pinned runtime');
});

test('owners rename and archive sessions; archived sessions are read-only and unarchive to their exact status', async t => {
  const f = await fixture(t); const s = await privateHostSession(f);
  const path = `/api/sessions/${s.session.id}`;
  await json(await s.owner.request('POST', `${path}/grants`, { userId: s.member.user.id, permissions: ['manage'] }));
  const { policy_version: granted } = f.sqlite.prepare('SELECT policy_version FROM sessions WHERE id = ?').get(s.session.id) as { policy_version: number };
  await denied(await s.member.request('PATCH', path, { title: 'Hijacked' }), 403, 'owner_required');
  for (const title of ['', '   ', 'two\nlines', 'x'.repeat(201), 1, null]) {
    assert.equal((await s.owner.request('PATCH', path, { title })).status, 400, JSON.stringify(title));
  }
  assert.equal((await s.owner.request('PATCH', path, { title: 'Renamed', visibility: 'private' })).status, 400);
  const renamed = await json<{ session: SessionRecord }>(await s.owner.request('PATCH', path, { title: '  Renamed session  ' }));
  assert.equal(renamed.session.title, 'Renamed session');
  assert.equal(renamed.session.policyVersion, granted);

  await denied(await s.member.request('POST', `${path}/archive`), 403, 'owner_required');
  const archived = await json<{ session: SessionRecord }>(await s.owner.request('POST', `${path}/archive`));
  assert.equal(archived.session.status, 'archived');
  assert.equal(archived.session.policyVersion, granted + 1);
  assert.equal(f.sqlite.prepare('SELECT archived_status FROM sessions WHERE id = ?').get(s.session.id)!.archived_status, 'ready');
  await denied(await s.owner.request('POST', `${path}/archive`), 409, 'session_archived');
  await denied(await s.owner.request('PATCH', path, { title: 'While archived' }), 409, 'session_archived');
  await denied(await s.owner.request('PATCH', path, { visibility: 'private' }), 409, 'session_archived');
  await denied(await s.owner.request('POST', `${path}/submit`, { content: 'hi', requestId: 'archived-request' }), 409, 'session_archived');
  assert.equal((await json<{ session: SessionRecord }>(await s.owner.request('GET', path))).session.status, 'archived');

  await denied(await s.member.request('POST', `${path}/unarchive`), 403, 'owner_required');
  const restored = await json<{ session: SessionRecord }>(await s.owner.request('POST', `${path}/unarchive`));
  assert.equal(restored.session.status, 'ready');
  assert.equal(restored.session.policyVersion, granted + 2);
  assert.equal(f.sqlite.prepare('SELECT archived_status FROM sessions WHERE id = ?').get(s.session.id)!.archived_status, null);
  await denied(await s.owner.request('POST', `${path}/unarchive`), 409, 'session_not_archived');
  f.sqlite.prepare("UPDATE sessions SET status = 'error' WHERE id = ?").run(s.session.id);
  await json(await s.owner.request('POST', `${path}/archive`));
  assert.equal((await json<{ session: SessionRecord }>(await s.owner.request('POST', `${path}/unarchive`))).session.status, 'error');
  const actions = (f.sqlite.prepare('SELECT action FROM audit WHERE session_id = ? ORDER BY created_at, rowid').all(s.session.id) as { action: string }[]).map(row => row.action);
  for (const action of ['session.renamed', 'session.archived', 'session.unarchived']) assert.ok(actions.includes(action), action);
  assert.equal(s.hub.requests.length, 1, 'Renaming and archiving must not contact the host');
});

test('owners pack an archived session\'s files on its host, and unarchiving unpacks them first, as its owner, whoever of those who manage it unarchives it', async t => {
  const f = await fixture(t); const s = await privateHostSession(f);
  const path = `/api/sessions/${s.session.id}`;
  const actions: string[] = [];
  let packReply = () => Response.json({ packed: true, files: 3, clones: 1, bytes: 2048 });
  let unpackReply = () => Response.json({ unpacked: true });
  const requests = rpcHub(f, s.connector, envelope => {
    const { action } = envelope.request.ticket;
    actions.push(action);
    assert.equal(envelope.request.body, '{}');
    assert.equal(envelope.request.ticket.actorId, s.owner.user.id);
    if (action === 'pack') return packReply();
    if (action === 'unpack') return unpackReply();
    if (action === 'restart') return Response.json({ ok: true, sessionId: s.session.id });
    return Response.json({ error: 'Unexpected test relay request' }, { status: 503 });
  });
  const packedAt = () => (f.sqlite.prepare('SELECT packed_at FROM sessions WHERE id = ?').get(s.session.id) as { packed_at: string | null }).packed_at;
  const capabilities = (f.sqlite.prepare('SELECT capabilities_json FROM connectors WHERE id = ?').get(s.connector.connectorId) as { capabilities_json: string }).capabilities_json;
  await json(await s.owner.request('POST', `${path}/grants`, { userId: s.member.user.id, permissions: ['manage'] }));
  f.sqlite.prepare("UPDATE workspace_members SET role = 'admin' WHERE workspace_id = ? AND user_id = ?").run(s.team.id, s.member.user.id);

  await denied(await s.owner.request('POST', `${path}/pack`), 409, 'session_not_archived');
  await json(await s.owner.request('POST', `${path}/archive`));
  await denied(await s.owner.request('POST', `${path}/pack`), 409, 'connector_outdated');
  f.sqlite.prepare('UPDATE connectors SET capabilities_json = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(capabilities), sessionPacking: true }), s.connector.connectorId);
  await denied(await s.member.request('POST', `${path}/pack`), 403, 'owner_required');
  assert.deepEqual(actions, []);
  assert.equal(packedAt(), null);

  const packed = await json<{ session: SessionRecord }>(await s.owner.request('POST', `${path}/pack`));
  assert.equal(packed.session.packed, true);
  assert.equal(packed.session.status, 'archived');
  assert.deepEqual(actions, ['pack']);
  assert.equal(requests[0]!.request.path, `/v1/sessions/${s.session.id}/pack`);
  assert.ok(packedAt());
  const audit = f.sqlite.prepare("SELECT detail_json FROM audit WHERE session_id = ? AND action = 'session.packed'").get(s.session.id) as { detail_json: string };
  assert.deepEqual(JSON.parse(audit.detail_json), { files: 3, clones: 1, bytes: 2048 });
  assert.equal((await json<{ session: SessionRecord }>(await s.owner.request('GET', path))).session.packed, true);
  await denied(await s.owner.request('POST', `${path}/submit`, { content: 'hi', requestId: 'packed-request' }), 409, 'session_archived');

  const restored = await json<{ session: SessionRecord }>(await s.member.request('POST', `${path}/unarchive`));
  assert.equal(restored.session.status, 'ready');
  assert.equal(restored.session.packed, undefined);
  assert.deepEqual(actions, ['pack', 'unpack', 'restart']);
  assert.equal(requests[1]!.request.path, `/v1/sessions/${s.session.id}/unpack`);
  assert.equal(packedAt(), null);
  const recorded = (f.sqlite.prepare('SELECT action FROM audit WHERE session_id = ? ORDER BY created_at, rowid').all(s.session.id) as { action: string }[]).map(row => row.action);
  for (const action of ['session.packed', 'session.unpacked', 'session.unarchived']) assert.ok(recorded.includes(action), action);

  await json(await s.owner.request('POST', `${path}/archive`));
  packReply = () => Response.json({ error: 'This session\'s files are too large to pack: a pack holds at most 24 MiB' }, { status: 422 });
  const refused = await s.owner.request('POST', `${path}/pack`);
  const reason = await json<{ code: string; error: string }>(refused, 422);
  assert.equal(reason.code, 'runner_error');
  assert.match(reason.error, /too large to pack/);
  assert.equal(packedAt(), null);
  packReply = () => Response.json({ error: 'Runner operation failed' }, { status: 500 });
  assert.equal((await s.owner.request('POST', `${path}/pack`)).status, 502);
  assert.ok(packedAt());
  unpackReply = () => Response.json({ error: 'Unavailable' }, { status: 503 });
  assert.equal((await s.owner.request('POST', `${path}/unarchive`)).status, 503);
  assert.equal((await json<{ session: SessionRecord }>(await s.owner.request('GET', path))).session.status, 'archived', 'never unarchived without its files');
  unpackReply = () => Response.json({ unpacked: false });
  assert.equal((await json<{ session: SessionRecord }>(await s.owner.request('POST', `${path}/unarchive`))).session.status, 'ready');
  assert.equal(packedAt(), null);
  assert.deepEqual(actions, ['pack', 'unpack', 'restart', 'pack', 'pack', 'unpack', 'unpack', 'restart']);
  await json(await s.owner.request('POST', `${path}/archive`));
  await json(await s.owner.request('POST', `${path}/unarchive`));
  assert.equal(actions.length, 8);
});

test('archived sessions are packed a week on, where their host is online and keeps ignored files, as their owners would, unless their workspace turned it off', async t => {
  const f = await fixture(t); const s = await privateHostSession(f);
  const path = `/api/sessions/${s.session.id}`;
  const settings = `/api/workspaces/${s.team.id}/packing`;
  const actions: string[] = [];
  let packReply = () => Response.json({ packed: true, files: 3, clones: 1, bytes: 2048 });
  rpcHub(f, s.connector, envelope => {
    const { action } = envelope.request.ticket;
    actions.push(action);
    assert.equal(envelope.request.ticket.actorId, s.owner.user.id);
    if (action === 'pack') return packReply();
    if (action === 'unpack') return Response.json({ unpacked: true });
    if (action === 'restart') return Response.json({ ok: true, sessionId: s.session.id });
    return Response.json({ error: 'Unexpected test relay request' }, { status: 503 });
  });
  const row = () => ({ ...f.sqlite.prepare('SELECT pack_due_at, packed_at FROM sessions WHERE id = ?').get(s.session.id) as { pack_due_at: string | null; packed_at: string | null } });
  const capabilities = JSON.parse((f.sqlite.prepare('SELECT capabilities_json FROM connectors WHERE id = ?').get(s.connector.connectorId) as { capabilities_json: string }).capabilities_json);
  const host = (extra: Record<string, unknown>) => f.sqlite.prepare('UPDATE connectors SET capabilities_json = ? WHERE id = ?')
    .run(JSON.stringify({ ...capabilities, ...extra }), s.connector.connectorId);
  const audits = (action: string) => (f.sqlite.prepare('SELECT detail_json FROM audit WHERE session_id = ? AND action = ? ORDER BY created_at, rowid')
    .all(s.session.id, action) as { detail_json: string }[]).map(entry => JSON.parse(entry.detail_json));
  const week = 7 * 24 * 3600_000; const hour = 3600_000;
  const id = s.session.id;

  const before = Date.now();
  await json(await s.owner.request('POST', `${path}/archive`));
  const due = Date.parse(row().pack_due_at!);
  assert.ok(due >= before + week && due <= Date.now() + week, 'a week after archiving');
  await json(await s.owner.request('POST', `${path}/unarchive`));
  assert.equal(row().pack_due_at, null, 'unarchiving calls it off');
  await json(await s.owner.request('POST', `${path}/archive`));
  let at = Date.parse(row().pack_due_at!);
  assert.deepEqual(await runAutomaticPacking(f.env, at - 1000), [], 'not before its week is out');

  host({ sessionPacking: true });
  assert.deepEqual(await runAutomaticPacking(f.env, at), [{ sessionId: id, deferred: 'connector_outdated' }], 'an older host would drop ignored files');
  assert.equal(row().pack_due_at, new Date(at + 24 * hour).toISOString());
  host({ sessionPacking: true, packIgnoredFiles: true });
  at += 24 * hour;

  assert.deepEqual(await json<{ settings: { automatic: boolean } }>(await s.member.request('GET', settings)), { settings: { automatic: true } });
  await denied(await s.member.request('PUT', settings, { automatic: false }), 403, 'forbidden');
  assert.equal((await s.owner.request('PUT', settings, { automatic: 'no' })).status, 400);
  assert.deepEqual(await json(await s.owner.request('PUT', settings, { automatic: false })), { settings: { automatic: false } });
  assert.deepEqual(await runAutomaticPacking(f.env, at), [], 'turned off for the workspace');
  await json(await s.owner.request('PUT', settings, { automatic: true }));

  const connection = (f.sqlite.prepare('SELECT connection_hash FROM connectors WHERE id = ?').get(s.connector.connectorId) as { connection_hash: string }).connection_hash;
  f.sqlite.prepare('UPDATE connectors SET connection_hash = NULL WHERE id = ?').run(s.connector.connectorId);
  assert.deepEqual(await runAutomaticPacking(f.env, at), [], 'its host is offline');
  assert.equal(row().packed_at, null, 'never marked packed while its host is away');
  f.sqlite.prepare('UPDATE connectors SET connection_hash = ? WHERE id = ?').run(connection, s.connector.connectorId);

  packReply = () => Response.json({ error: 'Packing requires an idle session including queued work' }, { status: 409 });
  assert.deepEqual(await runAutomaticPacking(f.env, at), [{ sessionId: id, deferred: 'runner_error' }]);
  assert.deepEqual(row(), { pack_due_at: new Date(at + hour).toISOString(), packed_at: null }, 'tried again an hour on');
  assert.deepEqual(await runAutomaticPacking(f.env, at + hour - 1000), []);
  packReply = () => Response.json({ packed: true, files: 3, clones: 1, bytes: 2048 });
  assert.deepEqual(await runAutomaticPacking(f.env, at + hour), [{ sessionId: id, packed: true }]);
  assert.equal(row().pack_due_at, null);
  assert.ok(row().packed_at);
  assert.deepEqual(audits('session.packed'), [{ files: 3, clones: 1, bytes: 2048, automatic: true }]);
  assert.equal((await json<{ session: SessionRecord }>(await s.owner.request('GET', path))).session.packed, true);
  assert.deepEqual(await runAutomaticPacking(f.env, at + 30 * week), []);

  await json(await s.owner.request('POST', `${path}/unarchive`));
  await json(await s.owner.request('POST', `${path}/archive`));
  at = Date.parse(row().pack_due_at!);
  packReply = () => Response.json({ error: 'One of this session\'s clones has stashed changes (git stash), which a pack can\'t keep. Unarchive it to apply or drop them, or leave it unpacked' }, { status: 422 });
  assert.deepEqual(await runAutomaticPacking(f.env, at), [{ sessionId: id, refused: 'runner_error' }]);
  assert.deepEqual(row(), { pack_due_at: null, packed_at: null }, 'a refusal is final: its files stay as they are');
  assert.deepEqual(audits('session.pack_refused'), [{ automatic: true, code: 'runner_error',
    reason: 'One of this session\'s clones has stashed changes (git stash), which a pack can\'t keep. Unarchive it to apply or drop them, or leave it unpacked' }]);
  assert.deepEqual(await runAutomaticPacking(f.env, at + week), []);
  assert.deepEqual(actions, ['pack', 'pack', 'unpack', 'restart', 'pack'], 'each made as the owner');
});

test('the host\'s authorization callback admits reads of an archived session, packing and unpacking it, and nothing else of it', async t => {
  const f = await fixture(t); const s = await privateHostSession(f);
  const manage = { ...authorization(s.session), permission: 'manage' };
  const allowed = async (body: unknown) => (await json<{ allowed: boolean }>(await self(f, s.connector, 'authorize', body))).allowed;
  assert.equal(await allowed(manage), true);
  assert.equal(await allowed({ ...manage, archived: true }), false, 'only while archived');
  await json(await s.owner.request('POST', `/api/sessions/${s.session.id}/archive`));
  assert.equal(await allowed(manage), false);
  assert.equal(await allowed(authorization(s.session)), false);
  const read = { ...authorization(s.session), permission: 'read' };
  assert.equal(await allowed(read), true);
  assert.equal(await allowed({ ...read, host: true }), false);
  assert.equal(await allowed({ ...read, autoApprove: true }), false);
  assert.equal(await allowed({ ...read, permission: 'ask' }), false);
  assert.equal(await allowed({ ...manage, archived: true }), true);
  assert.equal(await allowed({ ...manage, archived: true, actorId: s.member.user.id }), false);
  for (const body of [{ ...manage, archived: false }, { ...manage, permission: 'write', archived: true }, { ...manage, archived: true, host: true }]) {
    await denied(await self(f, s.connector, 'authorize', body), 400, 'invalid_authorization');
  }
});

test('the workspace\'s owner and admins manage every session there, private ones included, but nothing that is its owner\'s alone', async t => {
  const f = await fixture(t); const s = await sharedHost(f);
  const { session } = await json<{ session: SessionRecord }>(await s.creator.request('POST', '/api/sessions', {
    ...s.input, visibility: 'private', trustedConnectorId: s.connector.connectorId,
  }), 201);
  const path = `/api/sessions/${session.id}`;
  const workspaceAdmin = await f.client('workspace-admin');
  await json(await s.admin.request('POST', `/api/workspaces/${s.team.id}/members`, { userId: workspaceAdmin.user.id, role: 'admin' }));
  const managed = ['read', 'ask', 'write', 'manage'];
  const held = async (client: Client) => (await json<{ session: SessionRecord }>(await client.request('GET', path))).session.permissions;

  await denied(await s.host.request('GET', path), 404, 'not_found');
  for (const manager of [s.admin, workspaceAdmin]) {
    assert.deepEqual(await held(manager), managed);
    const { sessions } = await json<{ sessions: SessionRecord[] }>(await manager.request('GET', '/api/sessions'));
    assert.deepEqual(sessions.find(item => item.id === session.id)?.permissions, managed);
  }

  const renamed = await json<{ session: SessionRecord }>(await workspaceAdmin.request('PATCH', path, { title: '  Tidied up  ' }));
  assert.equal(renamed.session.title, 'Tidied up');
  assert.deepEqual(renamed.session.permissions, managed);
  assert.equal((await json<{ session: SessionRecord }>(await s.admin.request('PATCH', path, { toolOutput: 'brief' }))).session.toolOutput, 'brief');
  assert.equal((await json<{ session: SessionRecord }>(await workspaceAdmin.request('PATCH', path, { visibility: 'workspace' }))).session.visibility, 'workspace');
  assert.deepEqual(await held(s.host), ['read']);
  await json(await workspaceAdmin.request('PATCH', path, { visibility: 'private' }));
  await denied(await s.host.request('GET', path), 404, 'not_found');

  await denied(await workspaceAdmin.request('POST', `${path}/grants`, { userId: s.host.user.id, role: 'admin' }), 403, 'grant_escalation');
  await json(await workspaceAdmin.request('POST', `${path}/grants`, { userId: s.host.user.id, role: 'collaborator' }));
  assert.deepEqual(await held(s.host), ['read', 'ask', 'write']);
  await json(await s.creator.request('POST', `${path}/grants`, { userId: s.host.user.id, role: 'admin' }));
  for (const [method, suffix, body] of [['PATCH', '', { title: 'Hijacked' }], ['PATCH', '', { visibility: 'workspace' }], ['PATCH', '', { toolOutput: 'full' }],
    ['POST', '/archive', undefined]] as const) {
    await denied(await s.host.request(method, `${path}${suffix}`, body), 403, 'owner_required');
  }
  await json(await s.admin.request('DELETE', `${path}/grants/${encodeURIComponent(s.host.user.id)}`));
  await denied(await s.host.request('GET', path), 404, 'not_found');

  for (const [method, suffix, body] of [['POST', '/backup', {}], ['GET', '/backups', undefined], ['POST', '/restart', {}], ['GET', '/export', undefined],
    ['GET', '/link', undefined], ['PUT', '/link', undefined], ['POST', '/schedules', { message: 'Nightly', cron: '0 3 * * *' }],
    ['POST', '/migrate', { requestId: 'manager-move', modelId: s.model.id }]] as const) {
    await denied(await workspaceAdmin.request(method, `${path}${suffix}`, body), 403, 'owner_required');
  }

  const archived = await json<{ session: SessionRecord }>(await workspaceAdmin.request('POST', `${path}/archive`));
  assert.equal(archived.session.status, 'archived');
  assert.deepEqual(archived.session.permissions, managed);
  const restored = await json<{ session: SessionRecord }>(await s.admin.request('POST', `${path}/unarchive`));
  assert.equal(restored.session.status, 'ready');
  const actors = Object.fromEntries((f.sqlite.prepare(`SELECT action, actor_id FROM audit WHERE session_id = ?
    AND action IN ('session.renamed', 'session.tool_output.updated', 'session.archived', 'session.unarchived')`).all(session.id) as { action: string; actor_id: string }[])
    .map(row => [row.action, row.actor_id]));
  assert.deepEqual(actors, { 'session.renamed': workspaceAdmin.user.id, 'session.tool_output.updated': s.admin.user.id,
    'session.archived': workspaceAdmin.user.id, 'session.unarchived': s.admin.user.id });

  await json(await s.admin.request('PATCH', `/api/workspaces/${s.team.id}/members/${encodeURIComponent(workspaceAdmin.user.id)}`, { role: 'collaborator' }));
  await denied(await workspaceAdmin.request('GET', path), 404, 'not_found');
  await denied(await workspaceAdmin.request('POST', `${path}/archive`), 404, 'not_found');
  assert.equal(s.hub.requests.length, 1, 'Managing a session never contacts its host');
  assert.deepEqual(s.hub.unexpected, []);
});

test('hosts report what the agent of each session they serve is doing; lists show it and the runner binding never carries it', async t => {
  const f = await fixture(t); const s = await privateHostSession(f);
  const path = `/api/sessions/${s.session.id}`;
  const report = (activity: unknown, sessionId: unknown = s.session.id, connector = s.connector) => self(f, connector, 'activity', { sessionId, activity });
  const listed = async (client = s.owner) => (await json<{ sessions: SessionRecord[] }>(await client.request('GET', '/api/sessions'))).sessions
    .find(session => session.id === s.session.id)!;
  const audits = () => f.sqlite.prepare('SELECT COUNT(*) AS n FROM audit WHERE session_id = ?').get(s.session.id)!.n;
  const audited = audits();
  assert.equal((await listed()).activity, undefined, 'unknown until the host reports it');
  const changedAt = () => (f.sqlite.prepare('SELECT changed_at FROM automatic_backups WHERE session_id = ?').get(s.session.id) as
    { changed_at: string | null } | undefined)?.changed_at ?? null;
  assert.equal(changedAt(), null);
  assert.deepEqual(await json(await report('working')), { ok: true });
  assert.equal((await listed()).activity, 'working');
  const firstChange = changedAt();
  assert.ok(firstChange);
  assert.equal((await listed(s.member)).activity, 'working', 'readers see what the owner sees');
  assert.equal((await json<{ session: SessionRecord }>(await s.owner.request('GET', path))).session.activity, 'working');
  for (const activity of ['busy', '', null, 3, ['done']]) await denied(await report(activity), 400, 'invalid_activity');
  await denied(await self(f, s.connector, 'activity', { sessionId: s.session.id, activity: 'done', status: 'ready' }), 400, 'invalid_activity');
  await denied(await report('done', 'missing-session'), 404, 'not_found');
  const other = await connect(f, s.owner, s.team.id);
  await denied(await report('done', s.session.id, other), 403, 'connector_binding_mismatch');
  assert.equal((await listed()).activity, 'working');

  await json(await report('failed'));
  await json(await report('working'));
  assert.equal(changedAt(), firstChange);
  await json(await report('failed'));
  assert.deepEqual({ ...f.sqlite.prepare('SELECT activity, policy_version FROM sessions WHERE id = ?').get(s.session.id) },
    { activity: 'failed', policy_version: s.session.policyVersion });
  assert.equal(audits(), audited);
  f.sqlite.prepare("UPDATE sessions SET status = 'error' WHERE id = ?").run(s.session.id);
  await json(await s.owner.request('POST', `${path}/restart`));
  const binding = JSON.parse(s.hub.requests.at(-1)!.request.body) as RunnerBinding;
  assert.equal(binding.session.id, s.session.id);
  assert.equal('activity' in binding.session, false);
  assert.equal((await listed()).activity, 'failed', 'restarting leaves the activity to the host to report');
  assert.deepEqual(s.hub.unexpected, []);
});

test('writers stop a session\'s work through its host, audited; archived sessions refuse', async t => {
  const f = await fixture(t); const s = await privateHostSession(f);
  const path = `/api/sessions/${s.session.id}`;
  let stopped: unknown = 2;
  const requests = rpcHub(f, s.connector, () => Response.json({ stopped }));
  assert.deepEqual(await json(await s.owner.request('POST', `${path}/stop`, {})), { stopped: 2 });
  assert.equal(requests.length, 1);
  const { request } = requests[0]!;
  assert.deepEqual([request.method, request.path, request.body, request.ticket.action, request.ticket.actorId],
    ['POST', `/v1/sessions/${s.session.id}/stop`, '{}', 'stop', s.owner.user.id]);
  const audit = f.sqlite.prepare("SELECT actor_id, detail_json FROM audit WHERE session_id = ? AND action = 'session.stopped'").all(s.session.id);
  assert.deepEqual(audit.map(row => ({ ...row })), [{ actor_id: s.owner.user.id, detail_json: JSON.stringify({ stopped: 2 }) }]);
  stopped = 'all';
  await denied(await s.owner.request('POST', `${path}/stop`, {}), 502, 'invalid_runner_response');
  await json(await s.owner.request('POST', `${path}/archive`));
  await denied(await s.owner.request('POST', `${path}/stop`, {}), 409, 'session_archived');
  assert.equal(requests.length, 2);
});

test('a sender takes a queued message back through its host, audited; readers, bad replies and archived sessions refuse', async t => {
  const f = await fixture(t); const s = await privateHostSession(f);
  const path = `/api/sessions/${s.session.id}`;
  const submissionId = 'a'.repeat(43);
  const image = { mimeType: 'image/png', data: 'iVBORw0KGgo=' };
  let answer: unknown = { content: 'Fix the tests', mode: 'write', images: [image] };
  const requests = rpcHub(f, s.connector, () => Response.json(answer));
  assert.deepEqual(await json(await s.owner.request('POST', `${path}/withdraw`, { submissionId })), { content: 'Fix the tests', mode: 'write', images: [image] });
  const { request } = requests[0]!;
  assert.deepEqual([request.method, request.path, request.body, request.ticket.action, request.ticket.actorId],
    ['POST', `/v1/sessions/${s.session.id}/withdraw`, JSON.stringify({ submissionId }), 'withdraw', s.owner.user.id]);
  const audit = f.sqlite.prepare("SELECT actor_id, detail_json FROM audit WHERE session_id = ? AND action = 'session.withdrawn'").all(s.session.id);
  assert.deepEqual(audit.map(row => ({ ...row })), [{ actor_id: s.owner.user.id, detail_json: JSON.stringify({ submissionId }) }]);
  answer = { content: 'Lost', mode: 'ask', imagesLost: true };
  assert.deepEqual(await json(await s.owner.request('POST', `${path}/withdraw`, { submissionId })), { content: 'Lost', mode: 'ask', imagesLost: true });
  for (const body of [{}, { submissionId: 'short' }, { submissionId: `${submissionId}!` }, { submissionId, extra: true }]) {
    await denied(await s.owner.request('POST', `${path}/withdraw`, body), 400, 'invalid_input');
  }
  await denied(await s.member.request('POST', `${path}/withdraw`, { submissionId }), 403, 'forbidden');
  for (const bad of [{}, { content: 'x', mode: 'manage' }, { content: 'x', mode: 'write', images: [{ mimeType: 'text/html', data: 'AAAA' }] }]) {
    answer = bad;
    await denied(await s.owner.request('POST', `${path}/withdraw`, { submissionId }), 502, 'invalid_runner_response');
  }
  await json(await s.owner.request('POST', `${path}/archive`));
  await denied(await s.owner.request('POST', `${path}/withdraw`, { submissionId }), 409, 'session_archived');
  assert.equal(requests.length, 5);
});

test('writers take the shared conversation back to a message through its host, audited; readers and archived sessions refuse', async t => {
  const f = await fixture(t); const s = await privateHostSession(f);
  const path = `/api/sessions/${s.session.id}`;
  let answer: unknown = { conversationId: '7' };
  const requests = rpcHub(f, s.connector, () => Response.json(answer));
  assert.deepEqual(await json(await s.owner.request('POST', `${path}/revert`, { entryId: '1:12' })), { conversationId: '7' });
  const { request } = requests[0]!;
  assert.deepEqual([request.method, request.path, request.body, request.ticket.action, request.ticket.actorId],
    ['POST', `/v1/sessions/${s.session.id}/revert`, JSON.stringify({ entryId: '1:12' }), 'revert', s.owner.user.id]);
  const audit = f.sqlite.prepare("SELECT actor_id, detail_json FROM audit WHERE session_id = ? AND action = 'session.reverted'").all(s.session.id);
  assert.deepEqual(audit.map(row => ({ ...row })), [{ actor_id: s.owner.user.id, detail_json: JSON.stringify({ entryId: '1:12' }) }]);
  for (const body of [{}, { entryId: 12 }, { entryId: '12' }, { entryId: '1:12', extra: true }]) {
    await denied(await s.owner.request('POST', `${path}/revert`, body), 400, 'invalid_input');
  }
  await denied(await s.member.request('POST', `${path}/revert`, { entryId: '1:12' }), 403, 'forbidden');
  answer = {};
  await denied(await s.owner.request('POST', `${path}/revert`, { entryId: '1:12' }), 502, 'invalid_runner_response');
  await json(await s.owner.request('POST', `${path}/archive`));
  await denied(await s.owner.request('POST', `${path}/revert`, { entryId: '1:12' }), 409, 'session_archived');
  assert.equal(requests.length, 2);
});

test('its owner forks a session from a message into a new one on the same host and current model, which the host fills; a failed fork is archived', async t => {
  const f = await fixture(t); const s = await privateHostSession(f);
  const path = `/api/sessions/${s.session.id}`;
  const columns = (f.sqlite.prepare('PRAGMA table_info(models)').all() as { name: string }[]).map(column => column.name);
  f.sqlite.prepare(`INSERT INTO models (${columns.join(',')}) SELECT ${columns.map(column => column === 'id' ? "'second-model'" : column === 'model_id' ? "'second'" : column).join(',')} FROM models WHERE id = ?`).run(s.model.id);
  const advertised = JSON.parse((f.sqlite.prepare('SELECT models_json FROM connectors WHERE id = ?').get(s.connector.connectorId) as { models_json: string }).models_json) as { modelId: string }[];
  f.sqlite.prepare('UPDATE connectors SET models_json = ? WHERE id = ?').run(JSON.stringify([...advertised, { ...advertised[0]!, modelId: 'second' }]), s.connector.connectorId);
  let agent: SessionView['agent'] = { provider: s.model.provider, modelId: 'second', thinkingLevel: 'high' };
  let forkAnswer: () => Response = () => Response.json({ conversationId: '1', entries: 4 });
  let memberForks = false;
  const requests = rpcHub(f, s.connector, envelope => envelope.request.ticket.action === 'fork' ? forkAnswer()
    : envelope.request.ticket.action === 'view' ? Response.json({ view: { ...s.view, ...(agent ? { agent } : {}), ...(memberForks ? { memberForks: true } : {}) } })
    : Response.json({ session: {} }, { status: 201 }));
  const { session } = await json<{ session: SessionRecord }>(await s.owner.request('POST', `${path}/fork`, { entryId: '1:12' }), 201);
  assert.notEqual(session.id, s.session.id);
  assert.deepEqual([session.title, session.visibility, session.status, session.connectorId, session.ownerId],
    [`Fork: ${s.session.title}`, s.session.visibility, 'ready', s.session.connectorId, s.owner.user.id]);
  assert.deepEqual(requests.map(({ request }) => [request.path, request.ticket.action, request.ticket.sessionId]), [
    [`/v1/sessions/${s.session.id}/view`, 'view', s.session.id],
    ['/v1/sessions', 'create', session.id],
    [`/v1/sessions/${session.id}/fork`, 'fork', session.id],
  ]);
  assert.deepEqual(JSON.parse(requests[2]!.request.body), { sourceSessionId: s.session.id, entryId: '1:12' });
  const model = (id: string) => (f.sqlite.prepare('SELECT a.model_id FROM sessions s JOIN agent_versions a ON a.id = s.agent_version_id WHERE s.id = ?').get(id) as { model_id: string }).model_id;
  assert.equal(model(session.id), 'second-model', 'the model the conversation uses now');
  assert.equal(model(s.session.id), s.model.id);
  const audit = f.sqlite.prepare("SELECT actor_id, detail_json FROM audit WHERE session_id = ? AND action = 'session.forked'").all(session.id);
  assert.deepEqual(audit.map(row => ({ ...row })), [{ actor_id: s.owner.user.id, detail_json: JSON.stringify({ sourceSessionId: s.session.id, entryId: '1:12' }) }]);

  const fallsBack = async () => {
    const { session: fallback } = await json<{ session: SessionRecord }>(await s.owner.request('POST', `${path}/fork`, { entryId: '1:12' }), 201);
    assert.equal(model(fallback.id), s.model.id);
  };
  for (const current of [undefined, { provider: s.model.provider, modelId: 'gone', thinkingLevel: 'high' as const }]) {
    agent = current;
    await fallsBack();
  }
  agent = { provider: s.model.provider, modelId: 'second', thinkingLevel: 'high' };
  f.sqlite.prepare('UPDATE models SET available = 0 WHERE id = ?').run('second-model');
  await fallsBack();
  f.sqlite.prepare('UPDATE models SET available = 1 WHERE id = ?').run('second-model');
  f.sqlite.prepare('INSERT INTO connector_disabled_models (connector_id, provider, model_id, disabled_by, disabled_at) VALUES (?,?,?,?,?)')
    .run(s.connector.connectorId, s.model.provider, 'second', s.owner.user.id, new Date().toISOString());
  await fallsBack();
  f.sqlite.prepare('DELETE FROM connector_disabled_models WHERE model_id = ?').run('second');
  const { session: titled } = await json<{ session: SessionRecord }>(await s.owner.request('POST', `${path}/fork`, { entryId: '1:12', title: 'Try another way' }), 201);
  assert.equal(titled.title, 'Try another way');
  for (const body of [{}, { entryId: '1:12', visibility: 'private' }, { entryId: 'x' }]) await denied(await s.owner.request('POST', `${path}/fork`, body), 400, 'invalid_input');
  await denied(await s.member.request('POST', `${path}/fork`, { entryId: '1:12' }), 403, 'forbidden');
  await json(await s.owner.request('POST', `${path}/grants`, { userId: s.member.user.id, permissions: ['read', 'ask', 'write'] }));
  const sessions = () => (f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;
  const count = sessions();
  await denied(await s.member.request('POST', `${path}/fork`, { entryId: '1:12' }), 409, 'connector_update_required');
  memberForks = true;
  await denied(await s.member.request('POST', `${path}/fork`, { entryId: '1:12' }), 404, 'not_found');
  assert.equal(sessions(), count, 'a refused fork starts no session');
  await json(await s.owner.request('PUT', `/api/connectors/${s.connector.connectorId}/shares/${s.team.id}`));
  const { session: theirs } = await json<{ session: SessionRecord }>(await s.member.request('POST', `${path}/fork`, { entryId: '1:12' }), 201);
  assert.deepEqual([theirs.title, theirs.visibility, theirs.status, theirs.connectorId, theirs.ownerId],
    [`Fork: ${s.session.title}`, s.session.visibility, 'ready', s.session.connectorId, s.member.user.id]);
  assert.deepEqual(JSON.parse(requests.at(-1)!.request.body), { sourceSessionId: s.session.id, entryId: '1:12' });
  assert.equal(requests.at(-1)!.request.ticket.actorId, s.member.user.id);
  assert.equal(model(theirs.id), 'second-model', 'the model the conversation uses now, which they may use too');
  assert.deepEqual(f.sqlite.prepare("SELECT actor_id, detail_json FROM audit WHERE session_id = ? AND action = 'session.forked'").all(theirs.id).map(row => ({ ...row })),
    [{ actor_id: s.member.user.id, detail_json: JSON.stringify({ sourceSessionId: s.session.id, entryId: '1:12', sourceOwnerId: s.owner.user.id }) }]);
  await json(await s.owner.request('POST', `${path}/grants`, { userId: s.member.user.id, permissions: ['read', 'ask'] }));
  await denied(await s.member.request('POST', `${path}/fork`, { entryId: '1:12' }), 403, 'forbidden');
  memberForks = false;

  const before = requests.length;
  forkAnswer = () => Response.json({ error: 'That message is no longer in the shared conversation; reload it' }, { status: 409 });
  await denied(await s.owner.request('POST', `${path}/fork`, { entryId: '1:12' }), 409, 'runner_error');
  const failed = requests.at(-1)!.request.ticket.sessionId;
  assert.equal(requests.length, before + 3);
  assert.equal((f.sqlite.prepare('SELECT status FROM sessions WHERE id = ?').get(failed) as { status: string }).status, 'archived');
});

test('explicitly private creation stays unlisted until granted and membership removal defeats both visibility and grants', async t => {
  const f = await fixture(t); const s = await privateHostSession(f);
  const { session: privateSession } = await json<{ session: SessionRecord }>(await s.owner.request('POST', '/api/sessions', {
    ...s.input, visibility: 'private',
  }), 201);
  assert.equal(privateSession.visibility, 'private');
  await denied(await s.member.request('GET', `/api/sessions/${privateSession.id}`), 404, 'not_found');
  let listed = await json<{ sessions: SessionRecord[] }>(await s.member.request('GET', '/api/sessions'));
  assert.deepEqual(listed.sessions.map(session => session.id), [s.session.id]);
  await json(await s.owner.request('POST', `/api/sessions/${privateSession.id}/grants`, { userId: s.member.user.id, permissions: ['read'] }));
  listed = await json<{ sessions: SessionRecord[] }>(await s.member.request('GET', '/api/sessions'));
  assert.deepEqual(listed.sessions.map(session => session.id).sort(), [s.session.id, privateSession.id].sort());
  assert.equal((await s.owner.request('DELETE', `/api/workspaces/${s.team.id}/members/${encodeURIComponent(s.member.user.id)}`)).status, 204);
  for (const session of [s.session, privateSession]) {
    await denied(await s.member.request('GET', `/api/sessions/${session.id}`), 404, 'not_found');
    await denied(await s.member.request('GET', `/api/sessions/${session.id}/view`), 404, 'not_found');
  }
  assert.deepEqual(await json(await s.member.request('GET', '/api/sessions')), { sessions: [] });
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM session_grants WHERE user_id = ?').get(s.member.user.id)!.n, 0);
  await addMember(s.owner, s.team.id, s.member);
  assert.deepEqual((await json<{ sessions: SessionRecord[] }>(await s.member.request('GET', '/api/sessions'))).sessions.map(session => session.id), [s.session.id]);
  await denied(await s.member.request('GET', `/api/sessions/${privateSession.id}`), 404, 'not_found');
});

for (const mutation of ['privacy', 'membership'] as const) {
  for (const transport of ['view', 'events'] as const) {
    test(`${mutation} revocation suppresses an in-flight workspace ${transport} response`, async t => {
      const f = await fixture(t); const s = await privateHostSession(f);
      const began = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
      t.after(() => release.resolve());
      if (transport === 'events') t.mock.timers.enable({ apis: ['setTimeout'] });
      let polls = 0;
      const requests = rpcHub(f, s.connector, async envelope => {
        assert.equal(envelope.request.ticket.action, 'view');
        if (transport === 'events' && ++polls === 1) {
          return Response.json({ view: { ...s.view, entries: [{ id: 'first', kind: 'message', role: 'assistant', text: 'authorized-before-revocation' }] } });
        }
        began.resolve();
        await release.promise;
        return Response.json({ view: { ...s.view, entries: [{ id: 'late', kind: 'message', role: 'assistant', text: 'revoked-must-not-leak' }] } });
      });
      const pending = Promise.resolve(s.member.request('GET', `/api/sessions/${s.session.id}/${transport}`));
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let body = '';
      if (transport === 'events') {
        const response = await pending;
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
        reader = response.body!.getReader();
        t.after(() => reader!.cancel());
        const first = await reader.read();
        assert.equal(first.done, false);
        body = new TextDecoder().decode(first.value);
        assert.ok(body.includes('authorized-before-revocation'));
        await new Promise<void>(resolve => setImmediate(resolve));
        t.mock.timers.tick(1000);
      }
      await began.promise;
      if (mutation === 'privacy') {
        await json(await s.owner.request('PATCH', `/api/sessions/${s.session.id}`, { visibility: 'private' }));
      } else {
        assert.equal((await s.owner.request('DELETE', `/api/workspaces/${s.team.id}/members/${encodeURIComponent(s.member.user.id)}`)).status, 204);
      }
      release.resolve();
      const response = await pending;
      if (transport === 'view') {
        assert.ok(!(await response.clone().text()).includes('revoked-must-not-leak'));
        await denied(response, 403, 'permission_revoked');
      } else {
        while (true) {
          const chunk = await reader!.read();
          if (chunk.done) break;
          body += new TextDecoder().decode(chunk.value);
        }
        assert.equal((body.match(/event: view/g) ?? []).length, 1);
        assert.ok(!body.includes('revoked-must-not-leak'));
        assert.ok(!body.includes('error'));
      }
      assert.equal(requests.length, transport === 'events' ? 2 : 1);
      await denied(await s.member.request('GET', `/api/sessions/${s.session.id}`), 404, 'not_found');
      assert.deepEqual(await json(await s.member.request('GET', '/api/sessions')), { sessions: [] });
    });
  }
}

test('opt-in sharing admits a teammate runtime; unshare blocks foreign sessions but preserves workspace views of the owner session; revoke blocks all runtimes', async t => {
  const f = await fixture(t); const s = await privateHostSession(f);
  const input = { workspaceId: s.team.id, modelId: s.model.id, trustedConnectorId: s.connector.connectorId };
  await denied(await s.member.request('POST', '/api/sessions', input), 404, 'not_found');
  assert.equal(s.hub.requests.length, 1);
  const sharePath = `/api/connectors/${s.connector.connectorId}/shares/${s.team.id}`;
  await json(await s.owner.request('PUT', sharePath));
  assert.deepEqual((await json<{ models: ModelDefinition[] }>(await s.member.request('GET', `/api/workspaces/${s.team.id}/models`))).models, [s.model]);
  const { session: foreign } = await json<{ session: SessionRecord }>(await s.member.request('POST', '/api/sessions', input), 201);
  assert.equal(foreign.status, 'ready');
  assert.equal(foreign.ownerId, s.member.user.id);
  assert.equal(foreign.connectorOwnerId, s.owner.user.id);
  const foreignBinding = JSON.parse(s.hub.requests[1].request.body) as RunnerBinding;
  assert.equal(foreignBinding.owner.id, s.member.user.id);
  const requests = rpcHub(f, s.connector, envelope => {
    const own = envelope.request.ticket.sessionId === s.session.id;
    return Response.json({ view: own ? s.view : { ...s.view, sessionId: foreign.id, owner: { ...s.view.owner, id: s.member.user.id } } });
  });
  await json(await s.member.request('GET', `/api/sessions/${foreign.id}/view`));
  await json(await s.member.request('GET', `/api/sessions/${s.session.id}/view`));
  const viewable = async (id: string) => (await json<{ session: SessionRecord }>(await s.member.request('GET', `/api/sessions/${id}`))).session.viewable;
  assert.equal(await viewable(foreign.id), true);
  assert.equal((await s.owner.request('DELETE', sharePath)).status, 204);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM connector_shares').get()!.n, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM connector_workspaces WHERE connector_id = ? AND workspace_id = ?').get(s.connector.connectorId, s.team.id)!.n, 1);
  assert.equal(f.sqlite.prepare('SELECT available FROM models WHERE id = ?').get(s.model.id)!.available, 1);
  assert.deepEqual(await json(await s.member.request('GET', `/api/workspaces/${s.team.id}/models`)), { models: [] });
  assert.deepEqual(await json(await s.member.request('GET', `/api/workspaces/${s.team.id}/connectors`)), { connectors: [] });
  assert.deepEqual((await json<{ models: ModelDefinition[] }>(await s.owner.request('GET', `/api/workspaces/${s.team.id}/models`))).models, [s.model]);
  const beforeDenied = requests.length;
  await denied(await s.member.request('GET', `/api/sessions/${foreign.id}/view`), 403, 'connector_unavailable');
  assert.equal(await viewable(foreign.id), false);
  assert.equal(await viewable(s.session.id), true);
  await denied(await self(f, s.connector, 'authorize', authorization(foreign)), 403, 'connector_unavailable');
  await denied(await s.member.request('POST', '/api/sessions', input), 404, 'not_found');
  assert.equal(requests.length, beforeDenied);
  assert.deepEqual((await json<{ view: SessionView }>(await s.member.request('GET', `/api/sessions/${s.session.id}/view`))).view, s.view);
  assert.equal((await json<{ allowed: boolean }>(await self(f, s.connector, 'authorize', authorization(s.session)))).allowed, true);
  assert.equal((await json<{ allowed: boolean }>(await self(f, s.connector, 'authorize', { ...authorization(s.session, s.member.user.id), permission: 'read' }))).allowed, true);
  assert.equal((await json<{ allowed: boolean }>(await self(f, s.connector, 'authorize', authorization(s.session, s.member.user.id)))).allowed, false);
  delete f.env.CONNECTOR_HUB;
  assert.equal((await s.owner.request('DELETE', `/api/connectors/${s.connector.connectorId}`)).status, 204);
  rpcHub(f, s.connector, () => { assert.fail('Revoked connector must not receive a runtime request'); });
  for (const session of [s.session, foreign]) {
    for (const actor of [s.owner, s.member]) {
      await denied(await actor.request('GET', `/api/sessions/${session.id}/view`), 403, 'connector_unavailable');
    }
    await denied(await self(f, s.connector, 'authorize', authorization(session)), 401, 'connector_authentication_required');
  }
  await denied(await s.owner.request('POST', '/api/sessions', s.input), 404, 'not_found');
  assert.deepEqual(await json(await s.owner.request('GET', `/api/workspaces/${s.team.id}/models`)), { models: [] });
  assert.deepEqual(await json(await s.owner.request('GET', `/api/workspaces/${s.team.id}/connectors`)), { connectors: [] });
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 2);
});

test('workspace session listing stays query-bounded with sixty implicit readers and still filters private and owner-membership policy', async t => {
  const f = await fixture(t); const s = await privateHostSession(f);
  const clone = f.sqlite.prepare(`INSERT INTO sessions
    (id,workspace_id,owner_id,agent_version_id,title,policy_version,status,created_at,connector_id,connector_owner_id,repositories_json,visibility)
    SELECT ?,workspace_id,?,agent_version_id,title,policy_version,status,created_at,connector_id,connector_owner_id,repositories_json,?
    FROM sessions WHERE id = ?`);
  const workspaceIds = [s.session.id];
  for (let index = 1; index < 60; index++) {
    const id = `workspace-listed-${index}`;
    clone.run(id, s.owner.user.id, 'workspace', s.session.id);
    workspaceIds.push(id);
  }
  clone.run('ungranted-private', s.owner.user.id, 'private', s.session.id);
  clone.run('granted-private', s.owner.user.id, 'private', s.session.id);
  clone.run('removed-owner', s.outsider.user.id, 'workspace', s.session.id);
  await json(await s.owner.request('POST', '/api/sessions/granted-private/grants', {
    userId: s.member.user.id, permissions: ['ask'],
  }));
  const before = f.queryCount();
  const { sessions } = await json<{ sessions: SessionRecord[] }>(await s.member.request('GET', '/api/sessions'));
  const queries = f.queryCount() - before;
  assert.ok(queries > 0 && queries <= 3, `Listing sixty workspace sessions must not perform per-session authorization queries; used ${queries}`);
  assert.deepEqual(sessions.map(session => session.id).sort(), [...workspaceIds, 'granted-private'].sort());
  for (const session of sessions) {
    assert.deepEqual(session.permissions, session.id === 'granted-private' ? ['read', 'ask'] : ['read']);
    assert.equal(session.visibility, session.id === 'granted-private' ? 'private' : 'workspace');
  }
  assert.equal(s.hub.requests.length, 1, 'Listing must not dispatch runtime work');
});

for (const mutation of ['owner-membership', 'policy-version'] as const) {
  test(`visibility PATCH compare-and-swap rejects a concurrent ${mutation} change without an audit or runtime effect`, async t => {
    const f = await fixture(t); const s = await sharedSession(f);
    const path = `/api/sessions/${s.session.id}`;
    const before = f.sqlite.prepare('SELECT * FROM sessions WHERE id = ?').get(s.session.id)!;
    let changed = false;
    f.setBeforeQuery(sql => {
      if (changed || !sql.startsWith('UPDATE sessions SET visibility =')) return;
      changed = true;
      if (mutation === 'owner-membership') {
        f.sqlite.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').run(s.team.id, s.creator.user.id);
      } else {
        f.sqlite.prepare("UPDATE sessions SET visibility = 'private', policy_version = policy_version + 1 WHERE id = ?").run(s.session.id);
      }
    });
    await denied(await s.creator.request('PATCH', path, { visibility: 'private' }), 409, 'policy_changed');
    f.setBeforeQuery();
    assert.equal(changed, true, 'The revocation must land after admission and before the conditional update');
    const after = f.sqlite.prepare('SELECT * FROM sessions WHERE id = ?').get(s.session.id)!;
    assert.deepEqual({ ...after }, mutation === 'owner-membership' ? { ...before }
      : { ...before, visibility: 'private', policy_version: Number(before.policy_version) + 1 });
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit WHERE session_id = ? AND action = 'session.visibility.updated'").get(s.session.id)!.n, 0);
    assert.equal(s.hub.requests.length, 1);
    if (mutation === 'owner-membership') await denied(await s.creator.request('GET', path), 404, 'not_found');
  });
}

for (const mutation of ['demoted', 'suspended'] as const) {
  test(`a workspace admin's changes to another member's session are refused once they are ${mutation} after admission`, async t => {
    const f = await fixture(t); const s = await sharedSession(f);
    const path = `/api/sessions/${s.session.id}`;
    const manager = await f.client(`manager-${mutation}`);
    const operations = [
      { name: 'archive', sql: 'UPDATE sessions SET archived_status = status', action: 'session.archived', send: () => manager.request('POST', `${path}/archive`) },
      { name: 'unarchive', sql: 'UPDATE sessions SET status = COALESCE', action: 'session.unarchived', send: () => manager.request('POST', `${path}/unarchive`) },
      { name: 'rename', sql: 'UPDATE sessions SET title =', action: 'session.renamed', send: () => manager.request('PATCH', path, { title: 'Renamed' }) },
      { name: 'visibility', sql: 'UPDATE sessions SET visibility =', action: 'session.visibility.updated', send: () => manager.request('PATCH', path, { visibility: 'private' }) },
      { name: 'tool output', sql: 'UPDATE sessions SET tool_output =', action: 'session.tool_output.updated', send: () => manager.request('PATCH', path, { toolOutput: 'brief' }) },
    ];
    for (const operation of operations) {
      f.sqlite.prepare("UPDATE users SET suspended_at = NULL WHERE id = ?").run(manager.user.id);
      await json(await s.admin.request('POST', `/api/workspaces/${s.team.id}/members`, { userId: manager.user.id, role: 'admin' }));
      if (operation.name === 'unarchive') await json(await s.creator.request('POST', `${path}/archive`));
      const before = f.sqlite.prepare('SELECT * FROM sessions WHERE id = ?').get(s.session.id)!;
      let changed = false;
      f.setBeforeQuery(sql => {
        if (changed || !sql.startsWith(operation.sql)) return;
        changed = true;
        if (mutation === 'demoted') f.sqlite.prepare("UPDATE workspace_members SET role = 'member' WHERE workspace_id = ? AND user_id = ?").run(s.team.id, manager.user.id);
        else f.sqlite.prepare('UPDATE users SET suspended_at = ? WHERE id = ?').run(new Date().toISOString(), manager.user.id);
      });
      await denied(await operation.send(), 409, 'policy_changed');
      f.setBeforeQuery();
      assert.equal(changed, true, `The ${mutation} change must land after admission and before the conditional ${operation.name}`);
      assert.deepEqual({ ...f.sqlite.prepare('SELECT * FROM sessions WHERE id = ?').get(s.session.id)! }, { ...before }, operation.name);
      assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM audit WHERE session_id = ? AND action = ? AND actor_id = ?')
        .get(s.session.id, operation.action, manager.user.id)!.n, 0, operation.name);
      if (operation.name === 'unarchive') await json(await s.creator.request('POST', `${path}/unarchive`));
    }
    assert.equal(s.hub.requests.length, 1);
  });
}

test('a collaborator sends a message to a workspace-visible session it does not own; a viewer cannot, whatever its grant', async t => {
  const f = await fixture(t); const s = await sharedSession(f);
  const collaborator = await f.client('collaborator'); const viewer = await f.client('viewer');
  for (const [client, role] of [[collaborator, 'collaborator'], [viewer, 'viewer']] as const) {
    await json(await s.admin.request('POST', `/api/workspaces/${s.team.id}/members`, { userId: client.user.id, role }));
  }
  const receipt = { submissionId: 'submission', conversationId: 'conversation', status: 'queued' };
  const requests = rpcHub(f, s.connector, envelope => {
    assert.ok(['submit', 'ask'].includes(envelope.request.ticket.action));
    assert.equal(envelope.request.ticket.actorId, collaborator.user.id);
    return Response.json(receipt, { status: 202 });
  });
  const path = `/api/sessions/${s.session.id}`;
  const { session } = await json<{ session: SessionRecord }>(await collaborator.request('GET', path));
  assert.deepEqual(session.permissions, ['read', 'ask', 'write']);
  assert.deepEqual(await json(await collaborator.request('POST', `${path}/submit`, { content: 'From a collaborator', requestId: 'collaborator-write' }), 202), receipt);
  const admission = f.sqlite.prepare('SELECT * FROM run_admissions WHERE session_id = ? AND actor_id = ?').get(s.session.id, collaborator.user.id)!;
  assert.equal(admission.mode, 'write');
  assert.equal(admission.request_id, 'collaborator-write');
  assert.deepEqual(await json(await collaborator.request('POST', `${path}/ask`, { content: 'A side question', requestId: 'collaborator-ask' }), 202), receipt);
  assert.equal(requests.length, 2);

  f.sqlite.prepare('INSERT INTO session_grants (session_id,user_id,permissions_json,created_at) VALUES (?,?,?,?)')
    .run(s.session.id, viewer.user.id, JSON.stringify(['read', 'ask', 'write']), new Date().toISOString());
  assert.deepEqual((await json<{ session: SessionRecord }>(await viewer.request('GET', path))).session.permissions, ['read']);
  const { grants } = await json<{ grants: { userId: string; permissions: string[] }[] }>(await s.creator.request('GET', `${path}/grants`));
  assert.deepEqual(grants.find(grant => grant.userId === viewer.user.id)?.permissions, ['read']);
  for (const mode of ['submit', 'ask']) {
    await denied(await viewer.request('POST', `${path}/${mode}`, { content: 'From a viewer', requestId: `viewer-${mode}` }), 403, 'forbidden');
  }
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM run_admissions WHERE actor_id = ?').get(viewer.user.id)!.n, 0);
  assert.equal(requests.length, 2);

  await json(await s.admin.request('POST', `/api/workspaces/${s.team.id}/members`, { userId: collaborator.user.id, role: 'member' }));
  await denied(await collaborator.request('POST', `${path}/submit`, { content: 'After demotion', requestId: 'demoted-write' }), 403, 'forbidden');
  assert.equal(requests.length, 2);
});

function autoAdmission(f: Fixture, sessionId: string, actorId: string, access: string | null = 'auto', autoMerge = false, expiresAt = Math.floor(Date.now() / 1000) + 600) {
  const id = token();
  f.sqlite.prepare(`INSERT INTO run_admissions (id,session_id,actor_id,mode,request_id,content_hash,expires_at,created_at,access,auto_merge) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, sessionId, actorId, 'write', `request-${id}`, 'h'.repeat(43), expiresAt, new Date().toISOString(), access, autoMerge ? 1 : 0);
  return id;
}

test('a merge runs for any message that may act, whatever its app asks, and never for a Read-only one', async t => {
  const f = await fixture(t); const s = await sharedSession(f, ['identity', 'github_merge']);
  const receipt = { submissionId: 'submission', conversationId: 'conversation', status: 'queued' };
  const requests = rpcHub(f, s.connector, () => Response.json(receipt, { status: 202 }));
  const path = `/api/sessions/${s.session.id}`;
  await json(await self(f, s.connector, 'manifest', { ...manifest, capabilities: { ...manifest.capabilities, chatOptions: true } }));
  const send = async (requestId: string, options: Record<string, unknown>) => {
    await json(await s.creator.request('POST', `${path}/submit`, { content: 'Hi', requestId, options }), 202);
    return String(f.sqlite.prepare('SELECT id FROM run_admissions WHERE request_id = ?').get(requestId)!.id);
  };
  const acting = await send('acting', { access: 'auto', autoMerge: true });
  assert.equal(Object.hasOwn(JSON.parse(requests.at(-1)!.request.body), 'options'), false, 'auto-merge is no longer a choice');
  const reading = await send('reading', { access: 'read' });
  await denied(await s.creator.request('POST', `${path}/submit`, { content: 'Hi', requestId: 'not-boolean', options: { autoMerge: 'yes' } }), 400, 'invalid_options');

  const calls = mergeFetch(t, () => Response.json({ merged: true, sha: mergedSha }));
  const merge = (approvalId: string, admissionId: string) => ({ sessionId: s.session.id, actorId: s.creator.user.id, approvalId, admissionId,
    repository: 'owner/repo', pull: 5, sha: headSha, method: 'squash' });
  await denied(await self(f, s.connector, 'github/merge', merge('tool-read', reading)), 403, 'automatic_github_not_admitted');
  assert.deepEqual(calls, []);
  assert.deepEqual(await json(await self(f, s.connector, 'github/merge', merge('tool-merge', acting))), { sha: mergedSha, url: 'https://github.com/owner/repo/pull/5' });
  assert.deepEqual(calls, ['GET https://api.github.com/repos/owner/repo', 'PUT https://api.github.com/repos/owner/repo/pulls/5/merge']);
});

test('a message that may act posts GitHub comments, once per tool call and only for its own sender', async t => {
  const f = await fixture(t); const s = await sharedSession(f, ['identity', 'github_comment']); const fetch = githubFetch(t);
  await json(await s.creator.request('POST', `/api/sessions/${s.session.id}/grants`, { userId: s.admin.user.id, permissions: ['write', 'approve'] }));
  const owner = s.creator.user.id;
  const comment = (approvalId: string, admissionId: string, actorId = owner) => ({ sessionId: s.session.id, actorId, approvalId, admissionId,
    repository: 'owner/repo', issue: 3, body: 'Exactly approved text' });
  const auto = autoAdmission(f, s.session.id, owner);
  await denied(await self(f, s.connector, 'github/comment', comment('manual-id', auto)), 400, 'invalid_input');
  await denied(await self(f, s.connector, 'github/comment', { ...comment('tool-both', auto), capability: token() }), 410, 'approvals_removed');
  await denied(await self(f, s.connector, 'github/comment', comment('tool-reading', autoAdmission(f, s.session.id, owner, 'read'))), 403, 'automatic_github_not_admitted');
  await denied(await self(f, s.connector, 'github/comment', comment('tool-expired', autoAdmission(f, s.session.id, owner, 'auto', false, Math.floor(Date.now() / 1000) - 1))), 403, 'automatic_github_not_admitted');
  await denied(await self(f, s.connector, 'github/comment', comment('tool-borrowed', auto, s.admin.user.id)), 403, 'automatic_github_not_admitted');
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM automatic_github_effects').get()!.n, 0);

  assert.deepEqual(await json(await self(f, s.connector, 'github/comment', comment('tool-comment', auto))), { id: 99, url: 'https://github.com/owner/repo/issues/3#issuecomment-99' });
  assert.equal(fetch.mock.callCount(), 1);
  await denied(await self(f, s.connector, 'github/comment', comment('tool-comment', auto)), 409, 'capability_consumed');
  assert.equal(fetch.mock.callCount(), 1);
  const attempt = f.sqlite.prepare(`SELECT detail_json FROM audit WHERE action = 'github.comment.attempted'`).get()!;
  assert.equal(JSON.parse(String(attempt.detail_json)).automatic, true);
  assert.ok(!String(attempt.detail_json).includes(auto), 'the admission is never audited');

  for (let index = 0; index < 19; index++) await json(await self(f, s.connector, 'github/comment', comment(`tool-more-${index}`, auto)));
  await denied(await self(f, s.connector, 'github/comment', comment('tool-over', auto)), 429, 'automatic_github_limit');
  assert.equal(fetch.mock.callCount(), 20);
  await json(await self(f, s.connector, 'github/comment', comment('tool-teammate', autoAdmission(f, s.session.id, s.admin.user.id), s.admin.user.id)));
  assert.equal(fetch.mock.callCount(), 21, 'another member who may write posts for their own message, as the owner');
});


test('host owners add admins who manage sharing and host command grants, and grants decide host command authority', async t => {
  const f = await fixture(t); const s = await sharedSession(f); const outsider = await f.client('outsider');
  const host = s.host; const creator = s.creator; const id = s.connector.connectorId;
  const admins = `/api/connectors/${id}/admins`; const grants = `/api/connectors/${id}/host-grants/${s.team.id}`;
  for (const userId of [host.user.id, s.admin.user.id]) {
    await json(await creator.request('POST', `/api/sessions/${s.session.id}/grants`, { userId, permissions: ['read', 'approve'] }));
  }
  const authority = async (actorId: string) => {
    const result = await json<{ allowed: boolean; hostCommands?: string }>(await self(f, s.connector, 'authorize', { ...authorization(s.session, actorId), permission: 'read', host: true }));
    assert.equal(result.allowed, true);
    return result.hostCommands;
  };
  assert.equal(await authority(creator.user.id), undefined);
  assert.equal(await authority(host.user.id), 'auto');
  assert.equal(Object.hasOwn(await json(await self(f, s.connector, 'authorize', authorization(s.session))), 'hostCommands'), false);

  await denied(await creator.request('PUT', `${admins}/${creator.user.id}`), 404, 'not_found');
  await denied(await host.request('PUT', `${admins}/${outsider.user.id}`), 409, 'admin_unavailable');
  await denied(await host.request('PUT', `${admins}/${host.user.id}`), 400, 'invalid_admin');
  const viewer = await f.client('viewer');
  await json(await s.admin.request('POST', `/api/workspaces/${s.team.id}/members`, { userId: viewer.user.id, role: 'viewer' }));
  await denied(await host.request('PUT', `${admins}/${viewer.user.id}`), 409, 'admin_unavailable');
  const added = await json<{ admins: { userId: string }[] }>(await host.request('PUT', `${admins}/${creator.user.id}`));
  assert.deepEqual(added.admins.map(admin => admin.userId), [creator.user.id]);
  const listed = (await json<{ connectors: ConnectorInfo[] }>(await creator.request('GET', '/api/connectors'))).connectors;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].role, 'admin');
  assert.deepEqual(listed[0].admins?.map(admin => admin.userId), [creator.user.id]);
  await denied(await creator.request('PUT', `${admins}/${s.admin.user.id}`), 403, 'host_owner_required');
  await denied(await creator.request('DELETE', `/api/connectors/${id}`), 404, 'not_found');
  await denied(await creator.request('DELETE', `/api/connectors/${id}/permanent`), 404, 'not_found');

  await denied(await creator.request('PUT', grants, { level: 'root' }), 400, 'invalid_grant');
  await denied(await creator.request('PUT', grants, { level: 'auto', userId: host.user.id }), 400, 'invalid_grant');
  await denied(await creator.request('PUT', grants, { level: 'auto', expiresAt: new Date(Date.now() - 1000).toISOString() }), 400, 'invalid_expiry');
  await denied(await outsider.request('PUT', grants, { level: 'auto' }), 404, 'not_found');
  await json(await creator.request('PUT', grants, { level: 'auto', userId: creator.user.id }));
  await json(await host.request('PUT', grants, { level: 'approve' }));
  assert.equal(await authority(creator.user.id), 'auto');
  assert.equal(await authority(s.admin.user.id), 'approve');
  const own = (await json<{ connectors: ConnectorInfo[] }>(await creator.request('GET', `/api/workspaces/${s.team.id}/connectors`))).connectors;
  assert.equal(own[0].hostCommandAccess, 'auto');
  const audits = f.sqlite.prepare(`SELECT action FROM audit WHERE action LIKE 'host.grant.%' OR action LIKE 'connector.admin.%' ORDER BY created_at, rowid`).all().map(row => row.action);
  assert.deepEqual(audits, ['connector.admin.added', 'host.grant.set', 'host.grant.set']);

  const other = await workspace(host);
  f.sqlite.prepare(`INSERT INTO workspace_repositories (id, workspace_id, repository_id, full_name, ref, private, created_at) VALUES (?,?,?,?,?,?,?)`)
    .run('other-repository', other.id, '8', 'owner/other', 'main', 1, new Date().toISOString());
  await json(await host.request('PUT', `/api/connectors/${id}/shares/${other.id}`));
  await json(await host.request('PUT', `/api/connectors/${id}/host-grants/${other.id}`, { level: 'approve' }));
  await denied(await creator.request('DELETE', `/api/connectors/${id}/shares/${other.id}`), 404, 'not_found');
  await denied(await creator.request('DELETE', `/api/connectors/${id}/host-grants/${other.id}`), 404, 'not_found');
  await denied(await creator.request('PUT', `/api/connectors/${id}/host-grants/${other.id}`, { level: 'auto' }), 404, 'not_found');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM connector_shares WHERE workspace_id = ?').get(other.id)!.n, 1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM connector_host_grants WHERE workspace_id = ?').get(other.id)!.n, 1);
  const shown = await json<{ hostGrants: { workspaceId: string }[] }>(await creator.request('PUT', grants, { level: 'auto', userId: creator.user.id }));
  assert.deepEqual([...new Set(shown.hostGrants.map(grant => grant.workspaceId))], [s.team.id], 'an admin sees only grants of their own workspaces');
  const asAdmin = (await json<{ connectors: ConnectorInfo[] }>(await creator.request('GET', '/api/connectors'))).connectors[0];
  assert.ok(!asAdmin.workspaceIds.includes(other.id) && !asAdmin.hostGrants?.some(grant => grant.workspaceId === other.id));
  const asOwner = (await json<{ connectors: ConnectorInfo[] }>(await host.request('GET', '/api/connectors'))).connectors[0];
  assert.ok(asOwner.workspaceIds.includes(other.id) && asOwner.hostGrants?.some(grant => grant.workspaceId === other.id));

  f.sqlite.prepare('UPDATE connector_host_grants SET expires_at = ? WHERE user_id = ?').run(Math.floor(Date.now() / 1000) - 1, creator.user.id);
  assert.equal(await authority(creator.user.id), 'approve');
  assert.equal((await creator.request('DELETE', grants)).status, 204);
  assert.equal(await authority(s.admin.user.id), undefined);

  await json(await creator.request('PUT', grants, { level: 'approve', userId: s.admin.user.id }));
  assert.equal((await creator.request('DELETE', `/api/connectors/${id}/shares/${s.team.id}`)).status, 204);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM connector_host_grants WHERE workspace_id = ?').get(s.team.id)!.n, 0);
  await denied(await creator.request('PUT', grants, { level: 'approve' }), 409, 'grant_unavailable');
  assert.equal((await creator.request('DELETE', `${admins}/${creator.user.id}`)).status, 204);
  await denied(await creator.request('PUT', `/api/connectors/${id}/shares/${s.team.id}`), 404, 'not_found');
});

test('host owners and admins configure how the host runs sessions, and only the owner decides whose credentials it uses', async t => {
  const f = await fixture(t); const s = await sharedHost(f); const outsider = await f.client('outsider');
  const { host, creator } = s; const id = s.connector.connectorId; const path = `/api/connectors/${id}/config`;
  const defaults = { commandTimeoutSeconds: 30, gpu: false, gitCredentials: false, repositoryCache: 'off', hostSessions: false, compaction: {}, builtinExtensions: [], requiredExtensions: [], browser: { source: 'auto' }, serviceLifetimeSeconds: 14400, tunnel: { source: 'auto' }, fakeIpTunnels: false };
  const listed = async (client: Client) => (await json<{ connectors: ConnectorInfo[] }>(await client.request('GET', '/api/connectors'))).connectors
    .find(item => item.id === id)?.config;
  assert.deepEqual(await listed(host), defaults);
  assert.deepEqual(await json(await self(f, s.connector, 'config', {})), { config: defaults });
  const shared = (await json<{ connectors: ConnectorInfo[] }>(await creator.request('GET', `/api/workspaces/${s.team.id}/connectors`))).connectors;
  assert.equal(shared.find(item => item.id === id)?.config, undefined);
  await denied(await creator.request('PATCH', path, defaults), 404, 'not_found');
  await denied(await outsider.request('PATCH', path, defaults), 404, 'not_found');

  for (const invalid of [{ commandTimeoutSeconds: 29 }, { commandTimeoutSeconds: 3601 }, { ...defaults, commandTimeoutSeconds: 60.5 },
    { commandTimeoutSeconds: '60' }, { gpu: 'yes' }, { ...defaults, gitCredentials: 1 }, { repositoryCache: 'shared' },
    { hostSessions: 1 }, { fakeIpTunnels: 'yes' }, { ...defaults, unknown: true }, { unknown: true }, {}, []]) {
    await denied(await host.request('PATCH', path, invalid), 400, 'invalid_host_config');
  }
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM connector_configs').get()!.n, 0);
  const owned = { commandTimeoutSeconds: 600, gpu: true, gitCredentials: true, repositoryCache: 'owner', hostSessions: true, compaction: {}, builtinExtensions: [], requiredExtensions: [], browser: { source: 'auto' }, serviceLifetimeSeconds: 14400, tunnel: { source: 'auto' }, fakeIpTunnels: false };
  assert.deepEqual(await json(await host.request('PATCH', path, owned)), { config: owned });
  assert.deepEqual(await listed(host), owned);
  assert.deepEqual(await json(await self(f, s.connector, 'config', {})), { config: owned });
  await denied(await self(f, s.connector, 'config', {}, null), 401, 'stale_connection');

  await json(await host.request('PUT', `/api/connectors/${id}/admins/${creator.user.id}`));
  assert.deepEqual(await listed(creator), owned);
  await denied(await creator.request('PATCH', path, { gitCredentials: false }), 403, 'host_owner_required');
  await denied(await creator.request('PATCH', path, { ...owned, repositoryCache: 'host' }), 403, 'host_owner_required');
  await denied(await creator.request('PATCH', path, { commandTimeoutSeconds: 60, hostSessions: false }), 403, 'host_owner_required');
  const tuned = { ...owned, commandTimeoutSeconds: 3600, gpu: false };
  assert.deepEqual(await json(await creator.request('PATCH', path, { commandTimeoutSeconds: 3600, gpu: false })), { config: tuned });
  assert.deepEqual(await json(await self(f, s.connector, 'config', {})), { config: tuned });
  const audits = f.sqlite.prepare(`SELECT actor_id, detail_json FROM audit WHERE action = 'host.config.updated' ORDER BY created_at, rowid`).all()
    .map(row => ({ actor: row.actor_id, detail: JSON.parse(String(row.detail_json)) }));
  assert.deepEqual(audits, [{ actor: host.user.id, detail: { connectorId: id, ...owned } }, { actor: creator.user.id, detail: { connectorId: id, ...tuned } }]);

  assert.equal((await host.request('DELETE', `/api/connectors/${id}`)).status, 204);
  await denied(await host.request('PATCH', path, defaults), 409, 'connector_revoked');
});

test('a save changes only the settings it names, so what someone else saved meanwhile stays', async t => {
  const f = await fixture(t); const s = await sharedHost(f);
  const { host, creator } = s; const id = s.connector.connectorId; const path = `/api/connectors/${id}/config`;
  const audits = () => f.sqlite.prepare(`SELECT COUNT(*) AS n FROM audit WHERE action = 'host.config.updated'`).get()!.n;
  await json(await host.request('PUT', `/api/connectors/${id}/admins/${creator.user.id}`));
  await json(await host.request('PATCH', path, { gitCredentials: true, repositoryCache: 'host' }));
  const both = { commandTimeoutSeconds: 120, gpu: false, gitCredentials: true, repositoryCache: 'host', hostSessions: false, compaction: {}, builtinExtensions: [], requiredExtensions: [], browser: { source: 'auto' }, serviceLifetimeSeconds: 14400, tunnel: { source: 'auto' }, fakeIpTunnels: false };
  assert.deepEqual(await json(await creator.request('PATCH', path, { commandTimeoutSeconds: 120 })), { config: both });
  assert.deepEqual(await json(await host.request('PATCH', path, { gpu: true })), { config: { ...both, gpu: true } });
  const saved = audits();
  assert.deepEqual(await json(await creator.request('PATCH', path, { gitCredentials: true })), { config: { ...both, gpu: true } });
  assert.equal(audits(), saved);
  await denied(await creator.request('PATCH', path, { gpu: false, gitCredentials: false }), 403, 'host_owner_required');
  assert.deepEqual(await json(await self(f, s.connector, 'config', {})), { config: { ...both, gpu: true } }, 'a refused save changes nothing');
});

test('only a host\'s owner chooses where its browser comes from; its connector reads it, and a saved one no longer valid looks for one', async t => {
  const f = await fixture(t); const s = await sharedHost(f);
  const { host, creator } = s; const id = s.connector.connectorId; const path = `/api/connectors/${id}/config`;
  type Config = { config: { browser: unknown } };
  assert.deepEqual((await json<Config>(await self(f, s.connector, 'config', {}))).config.browser, { source: 'auto' }, 'found on the host by default');
  await json(await host.request('PUT', `/api/connectors/${id}/admins/${creator.user.id}`));
  const chosen = { source: 'path', path: '/usr/lib/chromium/chromium' };
  assert.deepEqual((await json<Config>(await host.request('PATCH', path, { browser: chosen }))).config.browser, chosen);
  assert.deepEqual((await json<Config>(await self(f, s.connector, 'config', {}))).config.browser, chosen);
  await denied(await creator.request('PATCH', path, { browser: { source: 'download' } }), 403, 'host_owner_required');
  assert.deepEqual((await json<Config>(await creator.request('PATCH', path, { browser: chosen, gpu: true }))).config.browser, chosen, 'naming it as it is changes nothing');
  for (const invalid of [{ source: 'path' }, { source: 'path', path: 'chromium' }, { source: 'web' }, { source: 'off', path: '/opt/chrome/chrome' }, 'download']) {
    await denied(await host.request('PATCH', path, { browser: invalid }), 400, 'invalid_host_config');
  }
  assert.deepEqual((await json<Config>(await host.request('PATCH', path, { browser: { source: 'download' } }))).config.browser, { source: 'download' });
  f.sqlite.prepare('UPDATE connector_configs SET browser_json = ? WHERE connector_id = ?').run('{"source":"somewhere"}', id);
  assert.deepEqual((await json<Config>(await self(f, s.connector, 'config', {}))).config.browser, { source: 'auto' });
});

test('only a host\'s owner trusts its local fake-IP proxy for every host, which its connector reads with the rest of its configuration', async t => {
  const f = await fixture(t); const s = await sharedHost(f);
  const { host, creator } = s; const id = s.connector.connectorId; const path = `/api/connectors/${id}/config`;
  type Config = { config: { fakeIpTunnels: boolean } };
  assert.equal((await json<Config>(await self(f, s.connector, 'config', {}))).config.fakeIpTunnels, false, 'off by default');
  await json(await host.request('PUT', `/api/connectors/${id}/admins/${creator.user.id}`));
  await denied(await creator.request('PATCH', path, { fakeIpTunnels: true }), 403, 'host_owner_required');
  assert.equal((await json<Config>(await self(f, s.connector, 'config', {}))).config.fakeIpTunnels, false, 'a refused save changes nothing');
  assert.equal((await json<Config>(await host.request('PATCH', path, { fakeIpTunnels: true }))).config.fakeIpTunnels, true);
  assert.equal((await json<Config>(await self(f, s.connector, 'config', {}))).config.fakeIpTunnels, true);
  assert.equal(f.sqlite.prepare('SELECT fake_ip_tunnels FROM connector_configs WHERE connector_id = ?').get(id)!.fake_ip_tunnels, 1);
  assert.equal((await json<Config>(await creator.request('PATCH', path, { fakeIpTunnels: true, gpu: true }))).config.fakeIpTunnels, true, 'naming it as it is changes nothing');
  await denied(await creator.request('PATCH', path, { fakeIpTunnels: false }), 403, 'host_owner_required');
  assert.equal((await json<Config>(await host.request('PATCH', path, { fakeIpTunnels: false }))).config.fakeIpTunnels, false);
  assert.throws(() => f.sqlite.prepare('UPDATE connector_configs SET fake_ip_tunnels = 2 WHERE connector_id = ?').run(id), /CHECK constraint/);
});

test('an admin\'s first configuration of a host leaves the owner\'s settings at their defaults', async t => {
  const f = await fixture(t); const s = await sharedHost(f);
  const id = s.connector.connectorId; const path = `/api/connectors/${id}/config`;
  await json(await s.host.request('PUT', `/api/connectors/${id}/admins/${s.creator.user.id}`));
  const config = { commandTimeoutSeconds: 120, gpu: true, gitCredentials: false, repositoryCache: 'off', hostSessions: false, compaction: {}, builtinExtensions: [], requiredExtensions: [], browser: { source: 'auto' }, serviceLifetimeSeconds: 14400, tunnel: { source: 'auto' }, fakeIpTunnels: false };
  assert.deepEqual(await json(await s.creator.request('PATCH', path, config)), { config });
  assert.deepEqual({ ...f.sqlite.prepare('SELECT git_credentials, repository_cache, host_sessions, updated_by FROM connector_configs WHERE connector_id = ?').get(id) },
    { git_credentials: 0, repository_cache: 'off', host_sessions: 0, updated_by: s.creator.user.id });
});

test('a host\'s owner and admins set its compaction token counts, which its connector reads with the rest of its configuration', async t => {
  const f = await fixture(t); const s = await sharedHost(f);
  const { host, creator } = s; const id = s.connector.connectorId; const path = `/api/connectors/${id}/config`;
  const defaults = { commandTimeoutSeconds: 30, gpu: false, gitCredentials: false, repositoryCache: 'off', hostSessions: false, builtinExtensions: [], requiredExtensions: [], browser: { source: 'auto' }, serviceLifetimeSeconds: 14400, tunnel: { source: 'auto' }, fakeIpTunnels: false };
  for (const invalid of [{ compaction: null }, { compaction: [] }, { compaction: { reserveTokens: -1 } }, { compaction: { reserveTokens: 1.5 } },
    { compaction: { reserveTokens: 10_000_001 } }, { compaction: { enabled: false } }, { compaction: { modelOverrides: { model: { reserveTokens: 1 } } } },
    { compaction: { modelOverrides: { 'anthropic/opus': { keepRecentTokens: '1' } } } }]) {
    await denied(await host.request('PATCH', path, invalid), 400, 'invalid_host_config');
  }
  const compaction = { reserveTokens: 32_768, modelOverrides: { 'openai/gpt-5': { keepRecentTokens: 4000 }, 'anthropic/opus': { reserveTokens: 65_536, keepRecentTokens: 20_000 }, 'faux/none': {} } };
  const kept = { reserveTokens: 32_768, modelOverrides: { 'anthropic/opus': { reserveTokens: 65_536, keepRecentTokens: 20_000 }, 'openai/gpt-5': { keepRecentTokens: 4000 } } };
  assert.deepEqual(await json(await host.request('PATCH', path, { compaction })), { config: { ...defaults, compaction: kept } });
  assert.deepEqual(await json(await self(f, s.connector, 'config', {})), { config: { ...defaults, compaction: kept } });
  assert.equal(f.sqlite.prepare('SELECT compaction_json FROM connector_configs WHERE connector_id = ?').get(id)!.compaction_json, JSON.stringify(kept));
  assert.deepEqual(await json(await host.request('PATCH', path, { commandTimeoutSeconds: 120 })), { config: { ...defaults, commandTimeoutSeconds: 120, compaction: kept } });
  await json(await host.request('PUT', `/api/connectors/${id}/admins/${creator.user.id}`));
  const many = { modelOverrides: Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`${String(index).padStart(80, 'p')}/${'m'.repeat(200)}`, { reserveTokens: 1_000_000 + index, keepRecentTokens: 9_999_999 }])) };
  const saved = await json<{ config: { compaction: { modelOverrides: Record<string, unknown> } } }>(await creator.request('PATCH', path, { compaction: many }));
  assert.equal(Object.keys(saved.config.compaction.modelOverrides).length, 200);
  assert.deepEqual(await json(await creator.request('PATCH', path, { compaction: {} })), { config: { ...defaults, commandTimeoutSeconds: 120, compaction: {} } });
  f.sqlite.prepare('UPDATE connector_configs SET compaction_json = ? WHERE connector_id = ?').run('{"reserveTokens":"lots"}', id);
  assert.deepEqual(await json(await self(f, s.connector, 'config', {})), { config: { ...defaults, commandTimeoutSeconds: 120, compaction: {} } });
});

test('a host\'s owner and admins turn on Pi\'s built-in extensions for its sessions, which its connector reads with the rest of its configuration', async t => {
  const f = await fixture(t); const s = await sharedHost(f);
  const { host, creator } = s; const id = s.connector.connectorId; const path = `/api/connectors/${id}/config`;
  const defaults = { commandTimeoutSeconds: 30, gpu: false, gitCredentials: false, repositoryCache: 'off', hostSessions: false, compaction: {}, requiredExtensions: [], browser: { source: 'auto' }, serviceLifetimeSeconds: 14400, tunnel: { source: 'auto' }, fakeIpTunnels: false };
  assert.deepEqual(await json(await self(f, s.connector, 'config', {})), { config: { ...defaults, builtinExtensions: [] } });
  for (const invalid of [{ builtinExtensions: null }, { builtinExtensions: 'codemode' }, { builtinExtensions: ['tool-search'] }, { builtinExtensions: ['pi:codemode', 'codemode'] }, { builtinExtensions: ['piki:gh'] }]) {
    await denied(await host.request('PATCH', path, invalid), 400, 'invalid_host_config');
  }
  assert.deepEqual(await json(await host.request('PATCH', path, { builtinExtensions: ['codemode'] })), { config: { ...defaults, builtinExtensions: ['pi:codemode'] } }, 'a bare name is Pi\'s');
  assert.deepEqual(await json(await host.request('PATCH', path, { builtinExtensions: ['pi:codemode'] })), { config: { ...defaults, builtinExtensions: ['pi:codemode'] } });
  assert.deepEqual(await json(await self(f, s.connector, 'config', {})), { config: { ...defaults, builtinExtensions: ['pi:codemode'] } });
  assert.equal(f.sqlite.prepare('SELECT builtin_extensions_json FROM connector_configs WHERE connector_id = ?').get(id)!.builtin_extensions_json, '["pi:codemode"]');
  assert.deepEqual(await json(await host.request('PATCH', path, { commandTimeoutSeconds: 120 })), { config: { ...defaults, commandTimeoutSeconds: 120, builtinExtensions: ['pi:codemode'] } });
  await denied(await creator.request('PATCH', path, { builtinExtensions: [] }), 404, 'not_found');
  await json(await host.request('PUT', `/api/connectors/${id}/admins/${creator.user.id}`));
  assert.deepEqual(await json(await creator.request('PATCH', path, { builtinExtensions: [] })), { config: { ...defaults, commandTimeoutSeconds: 120, builtinExtensions: [] } });
  f.sqlite.prepare('UPDATE connector_configs SET builtin_extensions_json = ? WHERE connector_id = ?').run('["retired","codemode"]', id);
  assert.deepEqual(await json(await self(f, s.connector, 'config', {})), { config: { ...defaults, commandTimeoutSeconds: 120, builtinExtensions: ['pi:codemode'] } });
  f.sqlite.prepare('UPDATE connector_configs SET builtin_extensions_json = ? WHERE connector_id = ?').run('{', id);
  assert.deepEqual(await json(await self(f, s.connector, 'config', {})), { config: { ...defaults, commandTimeoutSeconds: 120, builtinExtensions: [] } });
});

test('only a host\'s owner requires extensions of every session on it, which its connector reads with the rest of its configuration', async t => {
  const f = await fixture(t); const s = await sharedHost(f);
  const { host, creator } = s; const id = s.connector.connectorId; const path = `/api/connectors/${id}/config`;
  const defaults = { commandTimeoutSeconds: 30, gpu: false, gitCredentials: false, repositoryCache: 'off', hostSessions: false, compaction: {}, builtinExtensions: [], browser: { source: 'auto' }, serviceLifetimeSeconds: 14400, tunnel: { source: 'auto' }, fakeIpTunnels: false };
  assert.deepEqual(await json(await self(f, s.connector, 'config', {})), { config: { ...defaults, requiredExtensions: [] } });
  for (const invalid of [{ requiredExtensions: null }, { requiredExtensions: ['piki:prompt-audit'] }, { requiredExtensions: [{ source: 'npm:cc-safety-net' }] },
    { requiredExtensions: [{ source: './guard.ts' }] }, { requiredExtensions: [{ source: 'piki:prompt-audit', settings: { policy: 5 } }] },
    { requiredExtensions: [{ source: 'piki:no-such-extension' }] }, { requiredExtensions: [{ source: 'piki:schedule' }] }]) {
    await denied(await host.request('PATCH', path, invalid), 400, 'invalid_host_config');
  }
  const required = [{ source: 'piki:prompt-audit', settings: { model: 'anthropic/haiku', policy: 'Never read ~/clients.' } }, { source: 'npm:cc-safety-net@2.7.2', settings: {} }];
  assert.deepEqual(await json(await host.request('PATCH', path, { requiredExtensions: required })), { config: { ...defaults, requiredExtensions: required } });
  assert.deepEqual(await json(await self(f, s.connector, 'config', {})), { config: { ...defaults, requiredExtensions: required } });
  await json(await host.request('PUT', `/api/connectors/${id}/admins/${creator.user.id}`));
  assert.deepEqual(await json(await creator.request('PATCH', path, { requiredExtensions: required, commandTimeoutSeconds: 120 })),
    { config: { ...defaults, commandTimeoutSeconds: 120, requiredExtensions: required } });
  await denied(await creator.request('PATCH', path, { requiredExtensions: [], browser: { source: 'auto' } }), 403, 'host_owner_required');
  f.sqlite.prepare('UPDATE connector_configs SET required_extensions_json = ? WHERE connector_id = ?').run(JSON.stringify([{ source: 'npm:broken' }, required[0]]), id);
  assert.deepEqual(await json(await self(f, s.connector, 'config', {})), { config: { ...defaults, commandTimeoutSeconds: 120, requiredExtensions: [required[0]] } });
});

test('a host\'s owner and admins disable its models for everyone: a disabled model is neither listed, started from nor chosen', async t => {
  const f = await fixture(t); const s = await sharedSession(f); const outsider = await f.client('outsider');
  const host = s.host; const creator = s.creator; const id = s.connector.connectorId;
  const settings = `/api/connectors/${id}/models`;
  const keys = (models?: { provider: string; modelId: string }[]) => (models ?? []).map(model => `${model.provider}/${model.modelId}`);
  const first = { provider: manifest.models[0].provider, modelId: manifest.models[0].modelId };
  const second = { provider: 'local-native', modelId: 'local/model-v2' };
  const receipt = { submissionId: 'submission', conversationId: 'conversation', status: 'queued' };
  const requests = rpcHub(f, s.connector, () => Response.json(receipt, { status: 202 }));
  const message = (client: Client, requestId: string, options?: unknown, mode = 'submit') =>
    client.request('POST', `/api/sessions/${s.session.id}/${mode}`, { content: 'Hi', requestId, ...(options === undefined ? {} : { options }) });
  const modelAudits = () => f.sqlite.prepare(`SELECT action, detail_json FROM audit WHERE action LIKE 'connector.model.%' ORDER BY created_at, rowid`).all()
    .map(row => [row.action, JSON.parse(String(row.detail_json)).modelId]);

  await denied(await f.request('PATCH', settings, { ...first, enabled: false }, { Cookie: host.cookie }), 403, 'invalid_csrf');
  await denied(await creator.request('PATCH', settings, { ...first, enabled: false }), 404, 'not_found');
  await denied(await outsider.request('PATCH', settings, { ...first, enabled: false }), 404, 'not_found');
  await denied(await host.request('PATCH', settings, first), 400, 'invalid_model_setting');
  await denied(await host.request('PATCH', settings, { ...first, enabled: 'no' }), 400, 'invalid_model_setting');
  await denied(await host.request('PATCH', settings, { ...first, enabled: false, name: 'Renamed' }), 400, 'invalid_model_setting');
  await denied(await host.request('PATCH', settings, { provider: first.provider, modelId: 'not-on-host', enabled: false }), 404, 'model_not_on_host');

  assert.deepEqual(keys((await json<HostModelSettings>(await host.request('PATCH', settings, { ...first, enabled: false }))).models), []);
  await denied(await message(creator, 'own-model-disabled'), 409, 'model_disabled');
  assert.equal(requests.length, 0);
  await json(await host.request('PATCH', settings, { ...first, enabled: true }));
  await json(await message(creator, 'own-model-enabled'), 202);

  await json(await self(f, s.connector, 'manifest', { models: [...manifest.models, { ...second, name: 'Second model' }],
    capabilities: { ...manifest.capabilities, chatOptions: true } }));
  const secondRow = f.sqlite.prepare('SELECT id FROM models WHERE workspace_id = ? AND connector_id = ? AND model_id = ?').get(s.team.id, id, second.modelId)!.id;
  const disabledSecond = await json<HostModelSettings>(await host.request('PATCH', settings, { ...second, enabled: false }));
  assert.deepEqual([keys(disabledSecond.models), keys(disabledSecond.disabledModels)], [keys([first]), keys([second])]);
  await json(await host.request('PATCH', settings, { ...second, enabled: false }));
  assert.deepEqual(modelAudits(), [['connector.model.disabled', first.modelId], ['connector.model.enabled', first.modelId], ['connector.model.disabled', second.modelId]]);

  const { models } = await json<{ models: ModelDefinition[] }>(await creator.request('GET', `/api/workspaces/${s.team.id}/models`));
  assert.deepEqual(models.map(model => model.id), [s.model.id]);
  const shared = (await json<{ connectors: ConnectorInfo[] }>(await creator.request('GET', `/api/workspaces/${s.team.id}/connectors`))).connectors[0];
  assert.deepEqual(keys(shared.models), keys([first]));
  assert.equal(Object.hasOwn(shared, 'disabledModels'), false);
  const managed = (await json<{ connectors: ConnectorInfo[] }>(await host.request('GET', '/api/connectors'))).connectors[0];
  assert.deepEqual([keys(managed.models), keys(managed.disabledModels)], [keys([first]), keys([second])]);
  const own = await workspace(host);
  assert.deepEqual(keys((await json<{ models: ModelDefinition[] }>(await host.request('GET', `/api/workspaces/${own.id}/models`))).models), keys([first]));

  await denied(await creator.request('POST', '/api/sessions', { ...s.input, modelId: secondRow, trustedConnectorId: id }), 403, 'model_disabled');
  const before = requests.length;
  await denied(await message(creator, 'disabled-model', { model: second }), 403, 'model_disabled');
  await denied(await message(creator, 'no-model'), 409, 'model_required');
  await denied(await message(creator, 'access-only', { access: 'read' }), 409, 'model_required');
  await denied(await message(creator, 'ask-no-model', undefined, 'ask'), 409, 'model_required');
  assert.equal(requests.length, before, 'refused messages never reach the host');
  await json(await message(creator, 'enabled-model', { model: first }), 202);
  assert.deepEqual(JSON.parse(requests.at(-1)!.request.body).options, { model: first });

  await json(await host.request('PUT', `/api/connectors/${id}/admins/${creator.user.id}`));
  const enabled = await json<HostModelSettings>(await creator.request('PATCH', settings, { ...second, enabled: true }));
  assert.deepEqual([keys(enabled.models), keys(enabled.disabledModels)], [keys([first, second]), []]);
  await json(await creator.request('PATCH', settings, { ...second, enabled: true }));
  await json(await creator.request('PATCH', settings, { ...first, enabled: false }));
  assert.deepEqual(modelAudits().slice(3), [['connector.model.enabled', second.modelId], ['connector.model.disabled', first.modelId]]);
  await json(await message(creator, 'switched-model', { model: second }), 202);
  await denied(await message(creator, 'current-model'), 409, 'model_required');

  await json(await self(f, s.connector, 'manifest', { models: [{ ...second, name: 'Second model' }], capabilities: { ...manifest.capabilities, chatOptions: true } }));
  const narrowed = (await json<{ connectors: ConnectorInfo[] }>(await host.request('GET', '/api/connectors'))).connectors[0];
  assert.deepEqual([keys(narrowed.models), keys(narrowed.disabledModels)], [keys([second]), []]);
  await json(await self(f, s.connector, 'manifest', { models: [...manifest.models, { ...second, name: 'Second model' }], capabilities: { ...manifest.capabilities, chatOptions: true } }));
  const restored = (await json<{ connectors: ConnectorInfo[] }>(await host.request('GET', '/api/connectors'))).connectors[0];
  assert.deepEqual([keys(restored.models), keys(restored.disabledModels)], [keys([second]), keys([first])]);

  assert.equal((await host.request('DELETE', `/api/connectors/${id}/shares/${s.team.id}`)).status, 204);
  await denied(await creator.request('POST', '/api/sessions', { ...s.input, trustedConnectorId: id }), 404, 'not_found');

  assert.equal((await host.request('DELETE', `/api/connectors/${id}`)).status, 204);
  await denied(await host.request('PATCH', settings, { ...first, enabled: true }), 409, 'connector_revoked');
  assert.equal((await host.request('DELETE', `/api/connectors/${id}/permanent`)).status, 204);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM connector_disabled_models WHERE connector_id = ?').get(id)!.n, 0);
});

test('messages the server writes itself name the conversation\'s current model while its host has a disabled model', async t => {
  const f = await fixture(t); const s = await sharedSession(f); const id = s.connector.connectorId;
  const settings = `/api/connectors/${id}/models`;
  const first = { provider: manifest.models[0].provider, modelId: manifest.models[0].modelId };
  const second = { provider: 'local-native', modelId: 'local/model-v2' };
  const third = { provider: 'local-native', modelId: 'local/model-v3' };
  await json(await self(f, s.connector, 'manifest', { models: [...manifest.models, { ...second, name: 'Second model' }, { ...third, name: 'Third model' }],
    capabilities: { ...manifest.capabilities, chatOptions: true } }));
  let agent: SessionView['agent'];
  const submitted: Record<string, unknown>[] = [];
  rpcHub(f, s.connector, envelope => {
    if (envelope.request.ticket.action === 'view') {
      return Response.json({ view: { sessionId: s.session.id, owner: { id: s.creator.user.id, displayName: 'Creator', gitName: 'Creator', gitEmail: 'creator@example.test', githubLogin: 'creator' },
        entries: [], approvals: [], conversations: [], busy: false, ...(agent ? { agent } : {}) } satisfies SessionView });
    }
    submitted.push(JSON.parse(envelope.request.body));
    return Response.json({ submissionId: `submission-${submitted.length}`, conversationId: 'conversation', status: 'queued' }, { status: 202 });
  });
  let run = 0;
  const schedule = async () => {
    const at = Date.parse('2030-01-01T00:00:00Z') + ++run * 3600_000;
    const due = new Date(at - 1000).toISOString();
    f.sqlite.prepare(`INSERT INTO session_schedules (id, session_id, created_by, name, cron, time_zone, content, access, enabled, next_run_at, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(`schedule-${run}`, s.session.id, s.creator.user.id, 'Nightly', '0 0 * * *', 'UTC', 'Check it', 'approval', 1, due, due, due);
    const outcomes = await runScheduledPrompts(f.env, at);
    assert.deepEqual(outcomes.map(outcome => 'error' in outcome ? outcome.error : 'sent'), ['sent']);
    f.sqlite.prepare('DELETE FROM session_schedules').run();
    return submitted.at(-1)!.options;
  };

  assert.equal(await schedule(), undefined);
  await json(await s.host.request('PATCH', settings, { ...third, enabled: false }));
  agent = { ...second, thinkingLevel: 'high' };
  assert.deepEqual(await schedule(), { model: second, thinkingLevel: 'high' });
  agent = undefined;
  assert.deepEqual(await schedule(), { model: first });
  agent = { ...third, thinkingLevel: 'high' };
  const before = submitted.length;
  f.sqlite.prepare(`INSERT INTO session_schedules (id, session_id, created_by, name, cron, time_zone, content, access, enabled, next_run_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run('schedule-disabled', s.session.id, s.creator.user.id, 'Nightly', '0 0 * * *', 'UTC', 'Check it', 'approval', 1,
    '2031-01-01T00:00:00Z', '2031-01-01T00:00:00Z', '2031-01-01T00:00:00Z');
  assert.deepEqual((await runScheduledPrompts(f.env, Date.parse('2031-01-01T00:00:01Z'))).map(outcome => 'error' in outcome && outcome.error), ['model_disabled']);
  assert.equal(submitted.length, before);
});

test('the sessions tool sends another session a message on the conversation\'s current model while its host has a disabled model', async t => {
  const f = await fixture(t); const s = await sharedSession(f, ['identity', 'sessions']); const id = s.connector.connectorId;
  const { session: target } = await json<{ session: SessionRecord }>(await s.creator.request('POST', '/api/sessions', {
    ...s.input, title: 'Worker', trustedConnectorId: id }), 201);
  const first = { provider: manifest.models[0].provider, modelId: manifest.models[0].modelId };
  const second = { provider: 'local-native', modelId: 'local/model-v2' };
  await json(await self(f, s.connector, 'manifest', { models: [...manifest.models, { ...second, name: 'Second model' }],
    capabilities: { ...manifest.capabilities, chatOptions: true } }));
  await json(await s.host.request('PATCH', `/api/connectors/${id}/models`, { ...second, enabled: false }));
  const submitted: { path: string; body: Record<string, unknown> }[] = [];
  rpcHub(f, s.connector, envelope => {
    if (envelope.request.ticket.action === 'view') {
      return Response.json({ view: { sessionId: target.id, owner: { id: s.creator.user.id, displayName: 'Creator', gitName: 'Creator', gitEmail: 'creator@example.test', githubLogin: 'creator' },
        entries: [], approvals: [], conversations: [], busy: false, agent: { ...first, thinkingLevel: 'low' } } satisfies SessionView });
    }
    submitted.push({ path: envelope.request.path, body: JSON.parse(envelope.request.body) });
    return Response.json({ submissionId: 'submission', conversationId: 'conversation', status: 'queued' }, { status: 202 });
  });
  const admissionId = admit(f, s.session.id, s.creator.user.id);
  const sent = await self(f, s.connector, 'sessions', { sessionId: s.session.id, actorId: s.creator.user.id, admissionId, callId: 'call-send',
    action: 'send', targetSessionId: target.id, message: 'The brief' });
  await json(sent, 202);
  assert.deepEqual(submitted.map(item => [item.path, item.body.options]), [[`/v1/sessions/${target.id}/submit`, { model: first, thinkingLevel: 'low' }]]);
  assert.match(String(submitted[0]!.body.content), /The brief$/);
});

for (const enabled of [false, true]) {
  test(`a host model setting checks again as it writes that its author still manages the host (enabled=${enabled})`, async t => {
    const f = await fixture(t); const s = await sharedSession(f); const id = s.connector.connectorId;
    const settings = `/api/connectors/${id}/models`;
    const model = { provider: manifest.models[0].provider, modelId: manifest.models[0].modelId };
    await json(await s.host.request('PUT', `/api/connectors/${id}/admins/${s.creator.user.id}`));
    if (enabled) await json(await s.host.request('PATCH', settings, { ...model, enabled: false }));
    let removed = false;
    f.setBeforeQuery(sql => {
      if (removed || !/^(INSERT INTO|DELETE FROM) connector_disabled_models\b/.test(sql)) return;
      removed = true;
      f.sqlite.prepare('DELETE FROM connector_admins WHERE connector_id = ? AND user_id = ?').run(id, s.creator.user.id);
    });
    await denied(await s.creator.request('PATCH', settings, { ...model, enabled }), 404, 'not_found');
    f.setBeforeQuery();
    assert.equal(removed, true, 'The admin must lose the host after the route read it and before its write');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM connector_disabled_models WHERE connector_id = ?').get(id)!.n, enabled ? 1 : 0);
    assert.equal(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM audit WHERE actor_id = ? AND action LIKE 'connector.model.%'`).get(s.creator.user.id)!.n, 0);
  });
}

test('the Files tab reads the session worktree through its host, for collaborators, with secrets hidden', async t => {
  const f = await fixture(t); const s = await sharedSession(f);
  const files = (path: string, client = s.creator) => client.request('GET', `/api/sessions/${s.session.id}/files?path=${encodeURIComponent(path)}`);
  const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ';
  const requests = rpcHub(f, s.connector, envelope => {
    const { path } = JSON.parse(envelope.request.body) as { path: string };
    if (path === 'huge') return Response.json({ files: { path, type: 'file', size: 300000, truncated: true, text: 'x'.repeat(300000) } });
    if (path === 'other') return Response.json({ files: { path: 'elsewhere', type: 'file', size: 1, truncated: false, text: 'x' } });
    return Response.json({ files: path === '.'
      ? { path, type: 'directory', entries: [{ name: 'src', type: 'directory' }, { name: '.env', type: 'file', size: 60 }], total: 2, truncated: false }
      : { path, type: 'file', size: 60, truncated: false, text: `API_KEY=${secret}\n` } });
  });
  await denied(await files('.'), 409, 'files_unsupported');
  assert.equal(requests.length, 0);
  await json(await self(f, s.connector, 'manifest', { ...manifest, capabilities: { ...manifest.capabilities, fileBrowser: true } }));

  const listing = await json<{ files: { type: string; entries: unknown[] } }>(await files('.'));
  assert.deepEqual(listing.files, { path: '.', type: 'directory', entries: [{ name: 'src', type: 'directory' }, { name: '.env', type: 'file', size: 60 }], total: 2, truncated: false });
  const request = requests.at(-1)!.request;
  assert.equal(request.method, 'POST');
  assert.equal(request.path, `/v1/sessions/${s.session.id}/files`);
  assert.equal(request.ticket.action, 'files');
  assert.deepEqual(JSON.parse(request.body), { path: '.' });

  const preview = await json<{ files: { text: string; redacted?: boolean } }>(await files('./.env'));
  assert.equal(JSON.parse(requests.at(-1)!.request.body).path, '.env');
  assert.equal(preview.files.redacted, true);
  assert.ok(!preview.files.text.includes(secret));

  await denied(await files('huge'), 502, 'invalid_runner_response');
  await denied(await files('other'), 502, 'invalid_runner_response');

  const before = requests.length;
  for (const path of ['/etc/passwd', '../outside', 'src/../../outside', 'a//b']) await denied(await files(path), 400, 'invalid_path');
  assert.equal(requests.length, before);

  await denied(await files('.', s.host), 403, 'forbidden');
  await json(await s.creator.request('PATCH', `/api/sessions/${s.session.id}`, { visibility: 'private' }));
  await denied(await files('.', s.host), 404, 'not_found');
  await json(await s.creator.request('POST', `/api/sessions/${s.session.id}/grants`, { userId: s.host.user.id, role: 'viewer' }));
  await denied(await files('.', s.host), 403, 'forbidden');
  await json(await s.creator.request('POST', `/api/sessions/${s.session.id}/grants`, { userId: s.host.user.id, role: 'collaborator' }));
  await json(await files('.', s.host));
  assert.equal(requests.at(-1)!.request.ticket.actorId, s.host.user.id);
  assert.equal(requests.length, before + 1);
});

test('transcript images come from the session host, as thumbnails or whole, for collaborators only', async t => {
  const f = await fixture(t); const s = await sharedSession(f);
  const image = (query: string, client = s.creator) => client.request('GET', `/api/sessions/${s.session.id}/images?${query}`);
  const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  const requests = rpcHub(f, s.connector, envelope => {
    const { entryId, size } = JSON.parse(envelope.request.body) as { entryId: string; size: string };
    if (entryId === '0:9') return Response.json({ image: { mimeType: 'image/png', data: 'A'.repeat(64 * 1024 + 4) } });
    if (entryId === '0:8') return Response.json({ image: { mimeType: 'image/svg+xml', data: png } });
    return Response.json({ image: { mimeType: 'image/png', data: png, ...(size === 'full' ? { extra: 1 } : {}) } });
  });

  assert.deepEqual(await json(await image('entry=0:3&index=1&size=thumbnail')), { image: { mimeType: 'image/png', data: png } });
  const request = requests.at(-1)!.request;
  assert.equal(request.method, 'POST');
  assert.equal(request.path, `/v1/sessions/${s.session.id}/image`);
  assert.equal(request.ticket.action, 'image');
  assert.deepEqual(JSON.parse(request.body), { entryId: '0:3', index: 1, size: 'thumbnail' });
  await json(await image('entry=0:3&index=0'));
  assert.equal(JSON.parse(requests.at(-1)!.request.body).size, 'thumbnail');
  assert.deepEqual(await json(await image('entry=0:3&index=0&size=full')), { image: { mimeType: 'image/png', data: png } });

  const before = requests.length;
  for (const query of ['entry=stopped:1&index=0', 'entry=0:3&index=-1', 'entry=0:3&index=64', 'entry=0:3&index=x', 'entry=0:3&index=0&size=huge', 'index=0']) {
    await denied(await image(query), 400, 'invalid_image');
  }
  assert.equal(requests.length, before);
  await denied(await image('entry=0:9&index=0'), 502, 'invalid_runner_response');
  await denied(await image('entry=0:8&index=0'), 502, 'invalid_runner_response');

  await denied(await image('entry=0:3&index=0', s.host), 403, 'forbidden');
  await json(await s.creator.request('PATCH', `/api/sessions/${s.session.id}`, { visibility: 'private' }));
  await json(await s.creator.request('POST', `/api/sessions/${s.session.id}/grants`, { userId: s.host.user.id, role: 'viewer' }));
  await denied(await image('entry=0:3&index=0', s.host), 403, 'forbidden');
  await json(await s.creator.request('POST', `/api/sessions/${s.session.id}/grants`, { userId: s.host.user.id, role: 'collaborator' }));
  await json(await image('entry=0:3&index=0', s.host));
  assert.equal(requests.at(-1)!.request.ticket.actorId, s.host.user.id);
});

test('files attached to messages go to the session host in chunks, within the workspace limit its admins set', async t => {
  const f = await fixture(t); const s = await sharedSession(f);
  const upload = (chunk: Record<string, unknown>, client = s.creator) => client.request('POST', `/api/sessions/${s.session.id}/uploads`, chunk);
  const chunk = (data: Buffer, offset: number, size: number, name = 'notes.txt') => ({ uploadId: 'upload-0001', name, size, offset, data: data.toString('base64') });
  const requests = rpcHub(f, s.connector, envelope => {
    const body = JSON.parse(envelope.request.body) as { offset: number; size: number; data: string; name: string };
    const received = body.offset + Buffer.from(body.data, 'base64').length;
    if (body.name === 'elsewhere.txt') return Response.json({ received, path: '../elsewhere.txt' });
    return Response.json(received === body.size ? { received, path: `attachments/${body.name}` } : { received });
  });
  await denied(await upload(chunk(Buffer.from('hi'), 0, 2)), 409, 'uploads_unsupported');
  assert.equal(requests.length, 0);
  await json(await self(f, s.connector, 'manifest', { ...manifest, capabilities: { ...manifest.capabilities, fileUploads: true } }));

  const first = Buffer.alloc(fileUploadLimits.chunkBytes, 1); const rest = Buffer.from('tail');
  assert.deepEqual(await json(await upload(chunk(first, 0, first.length + rest.length))), { received: first.length });
  const request = requests.at(-1)!.request;
  assert.equal(request.path, `/v1/sessions/${s.session.id}/upload`);
  assert.equal(request.ticket.action, 'upload');
  assert.equal(request.ticket.actorId, s.creator.user.id);
  assert.deepEqual(await json(await upload(chunk(rest, first.length, first.length + rest.length))),
    { received: first.length + rest.length, path: 'attachments/notes.txt' });
  await denied(await upload(chunk(Buffer.from('x'), 0, 1, 'elsewhere.txt')), 502, 'invalid_runner_response');

  const before = requests.length;
  await denied(await upload(chunk(Buffer.alloc(fileUploadLimits.chunkBytes + 3), 0, fileUploadLimits.chunkBytes + 3)), 400, 'invalid_upload');
  await denied(await upload(chunk(Buffer.from('x'), 0, 1, '../x')), 400, 'invalid_upload');
  await denied(await upload(chunk(Buffer.from('xy'), 0, 1)), 400, 'invalid_upload');
  await denied(await upload({ ...chunk(Buffer.from('x'), 0, 1), extra: true }), 400, 'invalid_upload');
  await denied(await upload(chunk(Buffer.from('x'), 0, fileUploadLimits.defaultBytes + 1)), 413, 'file_too_large');
  assert.equal(requests.length, before);

  const settings = `/api/workspaces/${s.team.id}/attachments`;
  assert.deepEqual((await json<{ settings: unknown }>(await s.creator.request('GET', settings))).settings, { maxFileBytes: fileUploadLimits.defaultBytes });
  await denied(await s.creator.request('PUT', settings, { maxFileBytes: 20 * 1024 * 1024 }), 403, 'forbidden');
  await denied(await s.admin.request('PUT', settings, { maxFileBytes: fileUploadLimits.maxBytes + 1 }), 400, 'invalid_input');
  await denied(await s.admin.request('PUT', settings, { maxFileBytes: 1024 }), 400, 'invalid_input');
  assert.deepEqual((await json<{ settings: unknown }>(await s.admin.request('PUT', settings, { maxFileBytes: 20 * 1024 * 1024 }))).settings, { maxFileBytes: 20 * 1024 * 1024 });
  assert.deepEqual(await json(await upload(chunk(Buffer.from('x'), 0, 15 * 1024 * 1024))), { received: 1 });
  await denied(await upload(chunk(Buffer.from('x'), 0, 20 * 1024 * 1024 + 1)), 413, 'file_too_large');

  await json(await s.creator.request('POST', `/api/sessions/${s.session.id}/grants`, { userId: s.host.user.id, role: 'viewer' }));
  await denied(await upload(chunk(Buffer.from('x'), 0, 1), s.host), 403, 'forbidden');
});

test('a desktop app hands a chunk to the session host on its own computer with a grant only this server signs', async t => {
  const f = await fixture(t); const s = await sharedSession(f);
  f.env.SESSION_SECRET = 'connectors-session-secret-not-for-deployment';
  const direct = (body: Record<string, unknown>, client = s.creator) => client.request('POST', `/api/sessions/${s.session.id}/uploads/direct`, body);
  const body = JSON.stringify({ uploadId: 'upload-0001', name: 'notes.txt', size: 2, offset: 0, data: 'aGk=' });
  const declared = { bodyHash: await sha256(body), size: 2 };
  await json(await self(f, s.connector, 'manifest', { ...manifest, capabilities: { ...manifest.capabilities, fileUploads: true } }));
  await denied(await direct(declared), 409, 'uploads_unsupported');
  await json(await self(f, s.connector, 'manifest', { ...manifest, capabilities: { ...manifest.capabilities, fileUploads: true, directUploads: true } }));
  await denied(await direct({ ...declared, size: fileUploadLimits.defaultBytes + 1 }), 413, 'file_too_large');
  await denied(await direct({ bodyHash: 'x', size: 2 }), 400, 'invalid_input');
  const { connectorId, grant } = await json<{ connectorId: string; grant: string }>(await direct(declared));
  assert.equal(connectorId, s.connector.connectorId);

  const verified = await json<{ ticket: { action: string; actorId: string; sessionId: string; bodyHash: string; connectorId: string }; size: number; path: string }>(
    await self(f, s.connector, 'uploads/verify', { grant }));
  assert.deepEqual([verified.ticket.action, verified.ticket.actorId, verified.ticket.sessionId, verified.ticket.bodyHash, verified.ticket.connectorId, verified.size, verified.path],
    ['upload', s.creator.user.id, s.session.id, declared.bodyHash, s.connector.connectorId, 2, `/v1/sessions/${s.session.id}/upload`]);
  const [header, payload, signature] = grant.split('.');
  const forged = JSON.parse(Buffer.from(payload!, 'base64url').toString()) as { size: number };
  forged.size = 1;
  await denied(await self(f, s.connector, 'uploads/verify', { grant: `${header}.${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${signature}` }), 403, 'invalid_grant');
  const other = await connect(f, s.host);
  await denied(await self(f, other, 'uploads/verify', { grant }), 403, 'invalid_grant');
  const viewer = await f.client('viewer');
  await addMember(s.admin, s.team.id, viewer);
  await json(await s.creator.request('POST', `/api/sessions/${s.session.id}/grants`, { userId: viewer.user.id, role: 'collaborator' }));
  const granted = await json<{ grant: string }>(await direct(declared, viewer));
  await json(await s.creator.request('POST', `/api/sessions/${s.session.id}/grants`, { userId: viewer.user.id, role: 'viewer' }));
  await denied(await self(f, s.connector, 'uploads/verify', { grant: granted.grant }), 403, 'permission_revoked');
});

test('a host\'s owner starts a session directly on the host, without its configuration accepting that once its connector allows it, and its binding says so', async t => {
  const f = await fixture(t); const s = await privateWorkspace(f);
  const id = s.connector.connectorId; const config = `/api/connectors/${id}/config`;
  const accept = (hostSessions: boolean) => s.owner.request('PATCH', config, { hostSessions });
  const start = (body: Record<string, unknown>) => s.owner.request('POST', '/api/sessions', { ...s.input, ...body });
  const listed = async () => (await json<{ connectors: ConnectorInfo[] }>(await s.owner.request('GET', `/api/workspaces/${s.team.id}/connectors`))).connectors.find(item => item.id === id);

  await denied(await start({ hostEnvironment: 'yes' }), 400, 'invalid_input');
  await json(await accept(true));
  await denied(await start({ hostEnvironment: true }), 409, 'connector_update_required');
  assert.equal((await listed())?.hostSessions, undefined);
  await json(await self(f, s.connector, 'manifest', { ...manifest, capabilities: { ...manifest.capabilities, hostConfig: true } }));
  assert.equal((await listed())?.hostSessions, true);
  const memberView = (await json<{ connectors: ConnectorInfo[] }>(await s.member.request('GET', `/api/workspaces/${s.team.id}/connectors`))).connectors;
  assert.equal(memberView.find(item => item.id === id)?.hostSessions, undefined);
  const before = s.hub.requests.length;
  const { session } = await json<{ session: SessionRecord }>(await start({ hostEnvironment: true }), 201);
  assert.equal(session.hostEnvironment, true);
  const binding = JSON.parse(s.hub.requests[before]!.request.body) as RunnerBinding;
  assert.equal(binding.session.hostEnvironment, true, 'the host learns it from the immutable binding');
  assert.equal(f.sqlite.prepare('SELECT host_environment FROM sessions WHERE id = ?').get(session.id)!.host_environment, 1);
  const read = (await json<{ session: SessionRecord }>(await s.owner.request('GET', `/api/sessions/${session.id}`))).session;
  assert.equal(read.hostEnvironment, true);
  assert.equal(read.hostUnsandboxed, true, 'everyone who reads it learns it runs without isolation');
  const audit = f.sqlite.prepare(`SELECT detail_json FROM audit WHERE action = 'session.created' AND session_id = ?`).get(session.id)!;
  assert.equal(JSON.parse(String(audit.detail_json)).hostEnvironment, true);
  for (const body of [{}, { hostEnvironment: false }]) {
    const sandboxed = (await json<{ session: SessionRecord }>(await start(body), 201)).session;
    assert.equal(sandboxed.hostEnvironment, undefined);
    assert.equal(JSON.parse(s.hub.requests.at(-1)!.request.body).session.hostEnvironment, undefined);
  }
  await json(await accept(false));
  await denied(await start({ hostEnvironment: true }), 409, 'host_sessions_off');
  assert.equal((await listed())?.hostSessions, undefined);
  assert.equal((await json<{ session: SessionRecord }>(await s.owner.request('GET', `/api/sessions/${session.id}`))).session.hostEnvironment, true);
  await json(await self(f, s.connector, 'manifest', { ...manifest, capabilities: { ...manifest.capabilities, hostConfig: true, ownerHostSessions: true } }));
  assert.equal((await listed())?.hostSessions, true, 'its owner is offered sessions on the host whatever the host accepts from members');
  const own = (await json<{ session: SessionRecord }>(await start({ hostEnvironment: true }), 201)).session;
  assert.equal(own.hostEnvironment, true);
  assert.equal((JSON.parse(s.hub.requests.at(-1)!.request.body) as RunnerBinding).session.hostEnvironment, true);
  assert.equal((await json<{ connectors: ConnectorInfo[] }>(await s.member.request('GET', `/api/workspaces/${s.team.id}/connectors`))).connectors
    .find(item => item.id === id)?.hostSessions, undefined);
  await json(await self(f, s.connector, 'manifest', { ...manifest, capabilities: { platform: 'darwin', sandbox: false, productionShell: false, unsandboxed: true, plainGit: true, hostConfig: true } }));
  await json(await accept(true));
  await denied(await start({ hostEnvironment: true }), 400, 'host_unsandboxed');
});

test('a member it is shared with starts sessions directly on a host only with a grant from its owner that includes them', async t => {
  const f = await fixture(t); const s = await sharedHost(f);
  const id = s.connector.connectorId; const grants = `/api/connectors/${id}/host-grants/${s.team.id}`;
  const capabilities = { ...manifest.capabilities, hostConfig: true, hostCommands: true, hostGrants: true };
  await json(await self(f, s.connector, 'manifest', { ...manifest, capabilities }));
  await json(await s.host.request('PATCH', `/api/connectors/${id}/config`, { hostSessions: true }));
  const start = () => s.creator.request('POST', '/api/sessions', { ...s.input, trustedConnectorId: id, hostEnvironment: true });
  const offered = async () => (await json<{ connectors: ConnectorInfo[] }>(await s.creator.request('GET', `/api/workspaces/${s.team.id}/connectors`))).connectors
    .find(item => item.id === id)?.hostSessions;
  const onHost = () => f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions WHERE host_environment = 1').get()!.n;

  assert.equal(await offered(), undefined);
  await denied(await start(), 403, 'host_owner_required');
  await json(await s.host.request('PUT', grants, { level: 'auto', userId: s.creator.user.id }));
  assert.equal(await offered(), undefined);
  await denied(await start(), 403, 'host_owner_required');
  await denied(await s.host.request('PUT', grants, { level: 'auto', userId: s.creator.user.id, hostSessions: 'yes' }), 400, 'invalid_grant');

  await json(await s.host.request('PUT', `/api/connectors/${id}/admins/${s.admin.user.id}`));
  await denied(await s.admin.request('PUT', grants, { level: 'auto', userId: s.creator.user.id, hostSessions: true }), 403, 'host_owner_required');
  const given = await json<{ hostGrants: HostCommandGrant[] }>(await s.host.request('PUT', grants, { level: 'approve', userId: s.creator.user.id, hostSessions: true }));
  assert.equal(given.hostGrants.find(grant => grant.userId === s.creator.user.id)?.hostSessions, true);
  const kept = await json<{ hostGrants: HostCommandGrant[] }>(await s.admin.request('PUT', grants, { level: 'auto', userId: s.creator.user.id }));
  assert.equal(kept.hostGrants.find(grant => grant.userId === s.creator.user.id)?.hostSessions, true, 'an admin changing its level keeps them');
  const audit = f.sqlite.prepare(`SELECT detail_json FROM audit WHERE action = 'host.grant.set' ORDER BY created_at DESC, rowid DESC LIMIT 1`).get()!;
  assert.equal(JSON.parse(String(audit.detail_json)).hostSessions, true);

  assert.equal(await offered(), undefined);
  await denied(await start(), 409, 'connector_update_required');
  assert.equal(onHost(), 0);
  await json(await self(f, s.connector, 'manifest', { ...manifest, capabilities: { ...capabilities, hostSessionGrants: true, ownerHostSessions: true } }));
  assert.equal(await offered(), true);
  const { session } = await json<{ session: SessionRecord }>(await start(), 201);
  assert.equal(session.hostEnvironment, true);
  assert.equal(session.ownerId, s.creator.user.id);
  assert.equal((JSON.parse(s.hub.requests.at(-1)!.request.body) as RunnerBinding).session.hostEnvironment, true);

  const asked = (body: Record<string, unknown>) => self(f, s.connector, 'authorize', { ...authorization(session), permission: 'write', ...body });
  const reply = await json<{ hostCommands?: string; hostSessions?: true }>(await asked({ host: true, hostSessions: true }));
  assert.deepEqual([reply.hostCommands, reply.hostSessions], ['auto', true]);
  assert.equal(Object.hasOwn(await json(await asked({ host: true })), 'hostSessions'), false);
  await denied(await asked({ hostSessions: true }), 400, 'invalid_authorization');

  await json(await s.admin.request('PUT', grants, { level: 'auto', userId: s.creator.user.id, hostSessions: false }));
  assert.equal(Object.hasOwn(await json(await asked({ host: true, hostSessions: true })), 'hostSessions'), false);
  assert.equal(await offered(), undefined);
  await denied(await start(), 403, 'host_owner_required');
  await json(await s.host.request('PUT', grants, { level: 'approve', hostSessions: true }));
  assert.equal(await offered(), true, 'a workspace-wide grant counts too');
  await json(await s.host.request('PATCH', `/api/connectors/${id}/config`, { hostSessions: false }));
  assert.equal(await offered(), undefined);
  await denied(await start(), 409, 'host_sessions_off');
  assert.equal(onHost(), 1);
});

test('the web tools are retired: hosts that still carry them are never offered them, and their searches are refused', async t => {
  const f = await fixture(t); const s = await sharedSession(f, ['identity']);
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('No search provider is called'); });
  const owner = s.session.ownerId;
  await denied(await self(f, s.connector, 'web/search', { sessionId: s.session.id, actorId: owner, admissionId: admit(f, s.session.id, owner),
    callId: 'call-1', query: 'pikibun' }), 410, 'web_search_retired');
  assert.equal(fetch.mock.callCount(), 0);
});

function notionFake(t: TestContext, tokens: Record<string, string>) {
  const ids = { root: '11111111-1111-4111-8111-111111111111', child: '22222222-2222-4222-8222-222222222222', block: '33333333-3333-4333-8333-333333333333',
    nested: '44444444-4444-4444-8444-444444444444', database: '55555555-5555-4555-8555-555555555555', row: '66666666-6666-4666-8666-666666666666',
    outside: '77777777-7777-4777-8777-777777777777' };
  const page = (id: string, title: string, parent: Record<string, unknown>) => ({ object: 'page', id, url: `https://www.notion.so/${title}-${id.replace(/-/g, '')}`,
    last_edited_time: '2026-10-01T00:00:00.000Z', parent, properties: { Name: { type: 'title', title: [{ plain_text: title }] } } });
  const text = (content: string, annotations: Record<string, boolean> = {}) => [{ plain_text: content, annotations, href: null }];
  const routes: Record<string, () => Response> = {
    'GET /users/me': () => Response.json({ object: 'user', id: 'bot', type: 'bot', name: 'Pikibun', bot: { workspace_name: 'Acme' } }),
    [`GET /pages/${ids.root}`]: () => Response.json(page(ids.root, 'Specs', { type: 'workspace', workspace: true })),
    [`GET /pages/${ids.child}`]: () => Response.json(page(ids.child, 'Design', { type: 'page_id', page_id: ids.root })),
    [`GET /blocks/${ids.block}`]: () => Response.json({ object: 'block', id: ids.block, type: 'toggle', parent: { type: 'page_id', page_id: ids.child } }),
    [`GET /pages/${ids.nested}`]: () => Response.json(page(ids.nested, 'Nested', { type: 'block_id', block_id: ids.block })),
    [`GET /pages/${ids.outside}`]: () => Response.json(page(ids.outside, 'Payroll', { type: 'workspace', workspace: true })),
    [`GET /pages/${ids.database}`]: () => Response.json({ object: 'error', status: 400, code: 'validation_error' }, { status: 400 }),
    [`GET /databases/${ids.database}`]: () => Response.json({ object: 'database', id: ids.database, url: `https://www.notion.so/${ids.database.replace(/-/g, '')}`,
      title: [{ plain_text: 'Tasks' }], last_edited_time: '2026-10-02T00:00:00.000Z', parent: { type: 'page_id', page_id: ids.root } }),
    [`POST /databases/${ids.database}/query`]: () => Response.json({ results: [page(ids.row, 'Write the spec', { type: 'database_id', database_id: ids.database })], has_more: false, next_cursor: null }),
    [`GET /blocks/${ids.root}/children?page_size=100`]: () => Response.json({ has_more: false, next_cursor: null, results: [
      { object: 'block', id: 'b1', type: 'heading_1', has_children: false, heading_1: { rich_text: text('Goals') } },
      { object: 'block', id: 'b2', type: 'paragraph', has_children: false, paragraph: { rich_text: text('Ship it', { bold: true }) } },
      { object: 'block', id: 'b3', type: 'bulleted_list_item', has_children: true, bulleted_list_item: { rich_text: text('First') } },
      { object: 'block', id: ids.child, type: 'child_page', has_children: true, child_page: { title: 'Design' } },
      { object: 'block', id: ids.database, type: 'child_database', has_children: false, child_database: { title: 'Tasks' } },
      { object: 'block', id: 'b4', type: 'code', has_children: false, code: { language: 'typescript', rich_text: text('const a = 1;') } },
    ] }),
    'GET /blocks/b3/children?page_size=100': () => Response.json({ has_more: false, next_cursor: null, results: [
      { object: 'block', id: 'b5', type: 'to_do', has_children: false, to_do: { checked: true, rich_text: text('Nested item') } },
    ] }),
    [`GET /blocks/${ids.nested}/children?page_size=100`]: () => Response.json({ has_more: false, next_cursor: null, results: [
      { object: 'block', id: 'b6', type: 'paragraph', has_children: false, paragraph: { rich_text: text('Deep down') } },
    ] }),
  };
  const calls: { route: string; token: string | null }[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    assert.ok(url.startsWith('https://api.notion.com/v1/'), `unexpected call ${url}`);
    assert.equal(init?.redirect, 'manual');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('notion-version'), '2022-06-28');
    const token = headers.get('authorization')?.replace(/^Bearer /, '') ?? null;
    const route = `${init?.method ?? 'GET'} ${url.slice('https://api.notion.com/v1'.length)}`;
    calls.push({ route, token });
    if (!token || !Object.values(tokens).includes(token)) return Response.json({ object: 'error', code: 'unauthorized' }, { status: 401 });
    const answer = routes[route];
    return answer ? answer() : Response.json({ object: 'error', code: 'object_not_found' }, { status: 404 });
  });
  return { ids, calls };
}

test('owners and admins bind Notion pages as workspace sources; sessions read them, and only them, with their owner\'s own Notion account', async t => {
  const f = await fixture(t); const s = await sharedSession(f, ['identity', 'source_read']);
  const tokens = { admin: 'ntn_admin_secret_0123456789abcdef', creator: 'ntn_creator_secret_0123456789abcdef' };
  const notion = notionFake(t, tokens);
  const owner = s.session.ownerId;
  await denied(await s.admin.request('PUT', '/api/source-accounts/notion', { token: 'short' }), 400, 'invalid_source_account');
  await denied(await s.admin.request('PUT', '/api/source-accounts/notion', { token: 'ntn_wrong_secret_0123456789abcdef' }), 403, 'source_account_rejected');
  await denied(await s.admin.request('POST', `/api/workspaces/${s.team.id}/sources`, { kind: 'notion', target: notion.ids.root }), 409, 'source_account_required');
  const connected = await json<{ provider: string; name: string }>(await s.admin.request('PUT', '/api/source-accounts/notion', { token: tokens.admin }));
  assert.deepEqual([connected.provider, connected.name], ['notion', 'Acme']);
  assert.equal((await json<{ accounts: unknown[] }>(await s.admin.request('GET', '/api/source-accounts'))).accounts.length, 1);
  assert.equal((await json<{ accounts: unknown[] }>(await s.creator.request('GET', '/api/source-accounts'))).accounts.length, 0);

  await denied(await s.host.request('POST', `/api/workspaces/${s.team.id}/sources`, { kind: 'notion', target: notion.ids.root }), 403, 'forbidden');
  await denied(await s.admin.request('POST', `/api/workspaces/${s.team.id}/sources`, { kind: 'notion', target: 'https://example.com/page' }), 400, 'invalid_source');
  await denied(await s.admin.request('POST', `/api/workspaces/${s.team.id}/sources`, { kind: 'drive', target: notion.ids.root }), 400, 'invalid_source');
  const { source, extensions: added } = await json<{ source: WorkspaceDocumentSource; extensions?: string[] }>(await s.admin.request('POST', `/api/workspaces/${s.team.id}/sources`,
    { kind: 'notion', target: `https://www.notion.so/acme/Specs-${notion.ids.root.replace(/-/g, '')}?pvs=4` }), 201);
  assert.deepEqual([source.kind, source.itemId, source.itemType, source.title], ['notion', notion.ids.root, 'page', 'Specs']);
  assert.deepEqual(added, ['piki:notion'], 'the workspace\'s first Notion source brings the extension that reads it');
  await denied(await s.admin.request('POST', `/api/workspaces/${s.team.id}/sources`, { kind: 'notion', target: notion.ids.root }), 409, 'source_exists');
  assert.deepEqual((await json<{ sources: WorkspaceDocumentSource[] }>(await s.creator.request('GET', `/api/workspaces/${s.team.id}/sources`))).sources.map(item => item.id), [source.id]);
  assert.equal((await json<{ sources: number }>(await s.creator.request('GET', `/api/workspaces/${s.team.id}/repositories`))).sources, 2);
  const grant = await json<{ sources: unknown[] }>(await self(f, s.connector, 'network', { sessionId: s.session.id }));
  assert.deepEqual(grant.sources, [{ id: source.id, kind: 'notion', type: 'page', title: 'Specs' }]);

  const admissionId = admit(f, s.session.id, owner);
  const read = (body: Record<string, unknown> = {}, admission = admissionId) => self(f, s.connector, 'sources/read', {
    sessionId: s.session.id, actorId: owner, admissionId: admission, callId: 'call-1', source: source.id, ...body,
  });
  await denied(await read({}, admit(f, s.session.id, owner, { mode: 'ask' })), 403, 'source_read_not_admitted');
  await denied(await read(), 409, 'source_account_required');
  await json(await s.creator.request('PUT', '/api/source-accounts/notion', { token: tokens.creator }));
  const before = notion.calls.length;
  const root = await json<SourceReadView>(await read());
  assert.ok(notion.calls.slice(before).every(call => call.token === tokens.creator));
  assert.deepEqual([root.title, root.type, root.truncated], ['Specs', 'page', false]);
  assert.equal(root.content, `# Goals\n**Ship it**\n- First\n  - [x] Nested item\n[Page: Design] (id ${notion.ids.child})\n[Database: Tasks] (id ${notion.ids.database})\n\`\`\`typescript\nconst a = 1;\n\`\`\``);
  assert.deepEqual(root.entries, [{ id: notion.ids.child, type: 'page', title: 'Design' }, { id: notion.ids.database, type: 'database', title: 'Tasks' }]);
  const tasks = await json<SourceReadView>(await read({ item: notion.ids.database }));
  assert.deepEqual(tasks.entries?.map(row => row.title), ['Write the spec']);
  const nested = await json<SourceReadView>(await read({ item: `https://www.notion.so/Nested-${notion.ids.nested.replace(/-/g, '')}` }));
  assert.equal(nested.content, 'Deep down');
  await denied(await read({ item: notion.ids.outside }), 403, 'source_outside');
  await denied(await read({ item: 'not a page' }), 400, 'invalid_input');
  await denied(await read({ source: 'shared-repository' }), 404, 'source_not_found');
  const audits = f.sqlite.prepare("SELECT detail_json FROM audit WHERE action = 'source.read'").all().map(row => JSON.parse(String(row.detail_json)));
  assert.deepEqual(audits.map(item => item.item), [notion.ids.root, notion.ids.database, notion.ids.nested]);
  const everything = JSON.stringify(f.sqlite.prepare('SELECT * FROM audit').all()) + JSON.stringify(f.sqlite.prepare('SELECT * FROM source_accounts').all());
  assert.ok(!everything.includes(tokens.admin) && !everything.includes(tokens.creator), 'Tokens are stored only encrypted and never audited');

  await denied(await s.admin.request('DELETE', `/api/workspaces/${s.team.id}/sources/shared-repository`), 409, 'invalid_source');
  await denied(await s.host.request('DELETE', `/api/workspaces/${s.team.id}/sources/${source.id}`), 403, 'forbidden');
  await json(await s.admin.request('DELETE', `/api/workspaces/${s.team.id}/sources/${source.id}`));
  await denied(await read(), 404, 'source_not_found');
  assert.deepEqual((await json<{ sources: unknown[] }>(await self(f, s.connector, 'network', { sessionId: s.session.id }))).sources, []);
  await json(await s.creator.request('DELETE', '/api/source-accounts/notion'));
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM source_accounts WHERE user_id = ?').get(s.creator.user.id)!.n, 0);
});

test('a source an admin sets to read as the workspace reads with the workspace\'s Notion connection, and only then', async t => {
  const f = await fixture(t); const s = await sharedSession(f, ['identity', 'source_read']);
  const tokens = { bot: 'ntn_workspace_bot_0123456789abcdef', creator: 'ntn_creator_secret_0123456789abcdef' };
  const notion = notionFake(t, tokens);
  const path = `/api/workspaces/${s.team.id}/connections`;
  await denied(await s.creator.request('POST', path, { family: 'document', provider: 'notion', token: tokens.bot }), 403, 'forbidden');
  await denied(await s.admin.request('POST', path, { family: 'document', provider: 'notion', token: 'ntn_wrong_secret_0123456789abcdef' }), 403, 'source_account_rejected');
  await denied(await s.admin.request('POST', path, { family: 'document', provider: 'dropbox', token: 'x'.repeat(40) }), 400, 'invalid_workspace_connection');
  await denied(await s.admin.request('POST', path, { family: 'svn', provider: 'notion', token: tokens.bot }), 400, 'invalid_workspace_connection');
  const { connection } = await json<{ connection: WorkspaceConnection }>(await s.admin.request('POST', path, { family: 'document', provider: 'notion', token: tokens.bot }), 201);
  assert.deepEqual([connection.family, connection.provider, connection.host, connection.name, connection.sources], ['document', 'notion', '', 'Acme', 0]);
  const listed = await s.creator.request('GET', path);
  const listedText = await listed.clone().text();
  assert.deepEqual((await json<{ connections: WorkspaceConnection[] }>(listed)).connections.map(item => item.id), [connection.id]);
  assert.ok(!listedText.includes(tokens.bot) && !listedText.includes('ciphertext'));
  assert.equal((await json<{ connection: WorkspaceConnection }>(await s.admin.request('POST', path, { family: 'document', provider: 'notion', token: tokens.bot }))).connection.id, connection.id);

  const { source } = await json<{ source: WorkspaceDocumentSource }>(await s.admin.request('POST', `/api/workspaces/${s.team.id}/sources`,
    { kind: 'notion', target: notion.ids.root, readAs: 'workspace' }), 201);
  assert.equal(source.readAs, 'workspace');
  assert.equal((await json<{ connections: WorkspaceConnection[] }>(await s.creator.request('GET', path))).connections[0]!.sources, 1);

  const owner = s.session.ownerId;
  const admissionId = admit(f, s.session.id, owner);
  const read = () => self(f, s.connector, 'sources/read', { sessionId: s.session.id, actorId: owner, admissionId, callId: 'call-1', source: source.id });
  const before = notion.calls.length;
  assert.equal((await json<SourceReadView>(await read())).title, 'Specs');
  assert.ok(notion.calls.slice(before).every(call => call.token === tokens.bot));
  const audit = f.sqlite.prepare("SELECT detail_json FROM audit WHERE action = 'source.read'").all().map(row => JSON.parse(String(row.detail_json)));
  assert.deepEqual(audit.map(item => item.readAs), ['workspace']);

  const extensions = `/api/workspaces/${s.team.id}/extensions`;
  const turn = async (source: string, enabled: boolean) => json(await s.admin.request('PUT', extensions, { source, enabled, tools: 'approval', settings: {} }));
  await turn('piki:notion', false);
  const quiet = notion.calls.length;
  const off = await read();
  await denied(off, 403, 'source_kind_off');
  assert.equal(notion.calls.length, quiet, 'nothing reached Notion');
  await turn('piki:notion', true);
  await turn('piki:google-drive', false);
  assert.equal((await json<SourceReadView>(await read())).title, 'Specs');
  await json(await s.admin.request('DELETE', `${extensions}?source=piki%3Anotion`));
  await denied(await read(), 403, 'source_kind_off');
  await turn('piki:sources', true);
  await denied(await read(), 403, 'source_kind_off');
  await turn('piki:notion', true);
  assert.equal((await json<SourceReadView>(await read())).title, 'Specs', 'added again, it is on');
  for (const source of ['piki:google-drive', 'piki:sources']) await json(await s.admin.request('DELETE', `${extensions}?source=${encodeURIComponent(source)}`));
  const reads = f.sqlite.prepare("SELECT detail_json FROM audit WHERE action = 'source.read'").all().length;

  const inner = globalThis.fetch;
  let flipped = false;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!flipped) { flipped = true; f.sqlite.prepare("UPDATE source_read_settings SET read_as = 'members' WHERE source_id = ?").run(source.id); }
    return inner(input, init);
  });
  await denied(await read(), 409, 'source_read_as_changed');
  assert.ok(flipped);
  f.sqlite.prepare("UPDATE source_read_settings SET read_as = 'workspace' WHERE source_id = ?").run(source.id);
  assert.deepEqual(f.sqlite.prepare("SELECT detail_json FROM audit WHERE action = 'source.read'").all().length, reads, 'The refused read is not audited as a read');

  await denied(await s.admin.request('DELETE', `${path}/${connection.id}`), 409, 'workspace_connection_in_use');
  await denied(await s.creator.request('PUT', `/api/workspaces/${s.team.id}/sources/${source.id}/read-as`, { readAs: 'members' }), 403, 'forbidden');
  await denied(await s.admin.request('PUT', `/api/workspaces/${s.team.id}/sources/${source.id}/read-as`, { readAs: 'bot' }), 400, 'invalid_read_as');
  assert.deepEqual(await json(await s.admin.request('PUT', `/api/workspaces/${s.team.id}/sources/${source.id}/read-as`, { readAs: 'members' })), { readAs: 'members' });
  await denied(await read(), 409, 'source_account_required');
  await json(await s.creator.request('PUT', '/api/source-accounts/notion', { token: tokens.creator }));
  const mine = notion.calls.length;
  await json<SourceReadView>(await read());
  assert.ok(notion.calls.slice(mine).every(call => call.token === tokens.creator));

  assert.equal((await s.admin.request('DELETE', `${path}/${connection.id}`)).status, 204);
  await denied(await s.admin.request('PUT', `/api/workspaces/${s.team.id}/sources/${source.id}/read-as`, { readAs: 'workspace' }), 409, 'workspace_connection_required');
  await denied(await s.admin.request('POST', `/api/workspaces/${s.team.id}/sources`, { kind: 'notion', target: notion.ids.child, readAs: 'workspace' }), 409, 'workspace_connection_required');
  const everything = JSON.stringify(f.sqlite.prepare('SELECT * FROM audit').all()) + JSON.stringify(f.sqlite.prepare('SELECT * FROM workspace_connections').all());
  assert.ok(!everything.includes(tokens.bot), 'The secret is stored only encrypted and never audited');
  const actions = f.sqlite.prepare("SELECT action FROM audit WHERE action LIKE 'workspace.connection.%' OR action = 'workspace.source.read_as' ORDER BY created_at").all().map(row => row.action);
  assert.deepEqual(actions.sort(), ['workspace.connection.connected', 'workspace.connection.connected', 'workspace.connection.removed', 'workspace.source.read_as']);
});

test('source reads need source_read among the tools of the session owner\'s group', async t => {
  const f = await fixture(t); const s = await sharedSession(f, ['identity']);
  const tokens = { admin: 'ntn_admin_secret_0123456789abcdef' };
  const notion = notionFake(t, tokens);
  await json(await s.admin.request('PUT', '/api/source-accounts/notion', { token: tokens.admin }));
  const { source } = await json<{ source: WorkspaceDocumentSource }>(await s.admin.request('POST', `/api/workspaces/${s.team.id}/sources`, { kind: 'notion', target: notion.ids.root }), 201);
  const before = notion.calls.length;
  const admissionId = admit(f, s.session.id, s.session.ownerId);
  const read = () => self(f, s.connector, 'sources/read', { sessionId: s.session.id, actorId: s.session.ownerId, admissionId, callId: 'call-1', source: source.id });
  await inGroup(s.admin, s.team.id, s.creator, 'Readers', ['identity', 'read_file']);
  await denied(await read(), 403, 'tool_not_in_group');
  await inGroup(s.admin, s.team.id, s.creator, 'All tools', [...groupTools]);
  await denied(await read(), 409, 'source_account_required');
  assert.equal(notion.calls.length, before);
});

test('a workspace whose only source is a Notion page can be shared with hosts and start sessions', async t => {
  const f = await fixture(t);
  const admin = await f.client('docs-admin'); const host = await f.githubClient();
  const docs = await workspace(admin);
  await addMember(admin, docs.id, host);
  const connector = await connect(f, host);
  await denied(await host.request('PUT', `/api/connectors/${connector.connectorId}/shares/${docs.id}`), 409, 'workspace_repositories_required');
  const tokens = { admin: 'ntn_admin_secret_0123456789abcdef' };
  const notion = notionFake(t, tokens);
  await json(await admin.request('PUT', '/api/source-accounts/notion', { token: tokens.admin }));
  await json(await admin.request('POST', `/api/workspaces/${docs.id}/sources`, { kind: 'notion', target: notion.ids.root }), 201);
  assert.deepEqual(await json(await host.request('GET', `/api/workspaces/${docs.id}/repositories`)), { repositories: [], required: true, sources: 1 });
  await json(await host.request('PUT', `/api/connectors/${connector.connectorId}/shares/${docs.id}`));
  const { models } = await json<{ models: ModelDefinition[] }>(await host.request('GET', `/api/workspaces/${docs.id}/models`));
  provisionHub(f);
  const { session } = await json<{ session: SessionRecord }>(await host.request('POST', '/api/sessions', { workspaceId: docs.id, modelId: models[0]!.id, title: 'Summarize the specs' }), 201);
  assert.equal(session.status, 'ready');
});

test('a connector reads the tools this server defines as data, only with its own credential', async t => {
  const f = await fixture(t); const s = await sharedSession(f, ['identity']);
  const { tools } = await json<{ tools: unknown[] }>(await self(f, s.connector, 'tools', {}));
  assert.deepEqual(parseToolDefinitions({ tools }), bundledToolDefinitions, 'they parse as a connector parses them, unchanged');
  assert.deepEqual(tools.map(tool => (tool as { name: string }).name), ['node', 'rust', 'go', 'dotnet', 'make', 'source_read']);
  await denied(await s.creator.request('POST', '/api/connectors/self/tools', {}), 401, 'connector_authentication_required');
});

function dropboxFake(t: TestContext) {
  const issued = new Map<string, { verifier: string; refresh: string }>();
  const access = new Set<string>();
  const calls: { url: string; authorization: string | null; body: string }[] = [];
  let serial = 0;
  const challenges = new Map<string, string>();
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? init.body : '';
    const authorization = new Headers(init?.headers).get('authorization');
    calls.push({ url, authorization, body });
    assert.equal(init?.redirect, 'manual');
    if (url === 'https://api.dropboxapi.com/oauth2/token') {
      const form = new URLSearchParams(body);
      assert.equal(form.get('client_id'), 'dropbox-app-key');
      assert.equal(form.get('client_secret'), 'dropbox-app-secret');
      if (form.get('grant_type') === 'authorization_code') {
        const code = form.get('code')!;
        const challenge = challenges.get(code);
        assert.equal(form.get('redirect_uri'), `${origin}/api/source-accounts/dropbox/oauth/callback`);
        if (!challenge || createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== challenge) return Response.json({ error: 'invalid_grant' }, { status: 400 });
        challenges.delete(code);
        const token = `sl.access-${++serial}`; const refresh = `refresh-${serial}`;
        access.add(token); issued.set(refresh, { verifier: '', refresh });
        return Response.json({ access_token: token, refresh_token: refresh, expires_in: 14400, token_type: 'bearer' });
      }
      if (form.get('grant_type') === 'refresh_token' && issued.has(form.get('refresh_token')!)) {
        const token = `sl.access-${++serial}`;
        access.add(token);
        return Response.json({ access_token: token, expires_in: 14400, token_type: 'bearer' });
      }
      return Response.json({ error: 'invalid_grant' }, { status: 400 });
    }
    const token = authorization?.replace(/^Bearer /, '') ?? '';
    if (!access.has(token)) return Response.json({ error: 'expired_access_token' }, { status: 401 });
    if (url === 'https://api.dropboxapi.com/2/users/get_current_account') return Response.json({ email: 'creator@example.test', name: { display_name: 'Creator' } });
    const folder = { '.tag': 'folder', id: 'id:folder00001', name: 'Specs', path_lower: '/specs', path_display: '/Specs' };
    const notes = { '.tag': 'file', id: 'id:notes000001', name: 'notes.md', path_lower: '/specs/notes.md', path_display: '/Specs/notes.md', server_modified: '2026-10-01T00:00:00Z' };
    const payroll = { '.tag': 'file', id: 'id:payroll0001', name: 'payroll.md', path_lower: '/hr/payroll.md', path_display: '/HR/payroll.md' };
    if (url === 'https://api.dropboxapi.com/2/files/get_metadata') {
      const path = JSON.parse(body).path;
      const found = [folder, notes, payroll].find(item => item.id === path || item.path_lower === String(path).toLowerCase());
      return found ? Response.json(found) : Response.json({ error_summary: 'path/not_found/' }, { status: 409 });
    }
    if (url === 'https://api.dropboxapi.com/2/files/list_folder') return Response.json({ entries: [notes], has_more: false, cursor: 'c' });
    if (url === 'https://content.dropboxapi.com/2/files/download') {
      assert.equal(JSON.parse(new Headers(init?.headers).get('dropbox-api-arg')!).path, 'id:notes000001');
      return new Response('# Notes\nShip it.');
    }
    return assert.fail(`unexpected Dropbox call ${url}`);
  });
  return { calls, challenges, access };
}

async function dropboxSignIn(f: Fixture, client: Client, dropbox: ReturnType<typeof dropboxFake>, code: string) {
  const start = await client.request('GET', '/api/source-accounts/dropbox/oauth/start');
  assert.equal(start.status, 302);
  const location = new URL(start.headers.get('location')!);
  assert.equal(`${location.origin}${location.pathname}`, 'https://www.dropbox.com/oauth2/authorize');
  assert.equal(location.searchParams.get('client_id'), 'dropbox-app-key');
  assert.equal(location.searchParams.get('redirect_uri'), `${origin}/api/source-accounts/dropbox/oauth/callback`);
  assert.equal(location.searchParams.get('token_access_type'), 'offline');
  assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
  const state = location.searchParams.get('state')!;
  const cookie = start.headers.get('set-cookie')!.match(/test-source-oauth=([^;]+)/)![1];
  assert.equal(cookie, state);
  dropbox.challenges.set(code, location.searchParams.get('code_challenge')!);
  return { state, callback: (query: Record<string, string>, withCookie = true) => client.request('GET', `/api/source-accounts/dropbox/oauth/callback?${new URLSearchParams(query)}`,
    undefined, withCookie ? { Cookie: `${client.cookie}; test-source-oauth=${state}` } : {}) };
}

function returned(response: Response) {
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get('location')!);
  assert.equal(location.origin, origin);
  assert.equal(location.hash, '#/settings/profile');
  return { result: location.searchParams.get('result'), reason: location.searchParams.get('reason') };
}

test('members connect Dropbox by signing in; the state, PKCE and the member are checked, and tokens are refreshed on the control plane', async t => {
  const f = await fixture(t); const s = await sharedSession(f, ['identity', 'source_read']);
  const dropbox = dropboxFake(t);
  assert.deepEqual((await json<{ oauth: string[] }>(await s.creator.request('GET', '/api/source-accounts'))).oauth, []);
  await denied(await s.creator.request('GET', '/api/source-accounts/dropbox/oauth/start'), 404, 'oauth_unavailable');
  Object.assign(f.env, { DROPBOX_CLIENT_ID: 'dropbox-app-key', DROPBOX_CLIENT_SECRET: 'dropbox-app-secret' });
  assert.deepEqual((await json<{ oauth: string[] }>(await s.creator.request('GET', '/api/source-accounts'))).oauth, ['dropbox']);
  await denied(await s.creator.request('PUT', '/api/source-accounts/dropbox', { token: 'x'.repeat(40) }), 400, 'oauth_required');

  const flow = await dropboxSignIn(f, s.creator, dropbox, 'code-1');
  assert.deepEqual(returned(await flow.callback({ code: 'code-1', state: flow.state }, false)), { result: 'error', reason: 'invalid_state' });
  const admins = await dropboxSignIn(f, s.admin, dropbox, 'code-2');
  assert.deepEqual(returned(await s.creator.request('GET', `/api/source-accounts/dropbox/oauth/callback?code=code-2&state=${admins.state}`, undefined,
    { Cookie: `${s.creator.cookie}; test-source-oauth=${admins.state}` })), { result: 'error', reason: 'invalid_state' });
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM source_accounts WHERE provider = 'dropbox'").get()!.n, 0);
  const second = await dropboxSignIn(f, s.creator, dropbox, 'code-3');
  dropbox.challenges.set('code-3', 'not-the-challenge');
  assert.deepEqual(returned(await second.callback({ code: 'code-3', state: second.state })), { result: 'error', reason: 'source_account_rejected' });
  const declined = await dropboxSignIn(f, s.creator, dropbox, 'code-4');
  assert.deepEqual(returned(await declined.callback({ error: 'access_denied', state: declined.state })), { result: 'error', reason: 'access_denied' });

  const good = await dropboxSignIn(f, s.creator, dropbox, 'code-5');
  assert.deepEqual(returned(await good.callback({ code: 'code-5', state: good.state })), { result: 'connected', reason: null });
  assert.deepEqual(returned(await good.callback({ code: 'code-5', state: good.state })), { result: 'error', reason: 'invalid_state' });
  const { accounts } = await json<{ accounts: { provider: string; method: string; name: string }[] }>(await s.creator.request('GET', '/api/source-accounts'));
  assert.deepEqual(accounts.map(account => [account.provider, account.method, account.name]), [['dropbox', 'oauth', 'creator@example.test']]);

  const adminFlow = await dropboxSignIn(f, s.admin, dropbox, 'code-6');
  assert.deepEqual(returned(await adminFlow.callback({ code: 'code-6', state: adminFlow.state })), { result: 'connected', reason: null });
  const { source } = await json<{ source: WorkspaceDocumentSource }>(await s.admin.request('POST', `/api/workspaces/${s.team.id}/sources`, { kind: 'dropbox', target: '/Specs' }), 201);
  assert.deepEqual([source.itemId, source.itemType, source.title, source.url], ['id:folder00001', 'folder', 'Specs', 'https://www.dropbox.com/home/Specs']);
  const admissionId = admit(f, s.session.id, s.session.ownerId);
  const read = (item?: string) => self(f, s.connector, 'sources/read', { sessionId: s.session.id, actorId: s.session.ownerId, admissionId, callId: 'call-1', source: source.id, ...(item ? { item } : {}) });
  const folder = await json<SourceReadView>(await read());
  assert.deepEqual(folder.entries?.map(entry => entry.id), ['id:notes000001']);
  assert.equal((await json<SourceReadView>(await read('id:notes000001'))).content, '# Notes\nShip it.');
  await denied(await read('/HR/payroll.md'), 403, 'source_outside');

  const row = f.sqlite.prepare("SELECT ciphertext FROM source_accounts WHERE user_id = ? AND provider = 'dropbox'").get(s.session.ownerId)!;
  const stored = JSON.parse(await decryptToken(f.env, s.session.ownerId, String(row.ciphertext)));
  const expired = { ...stored, expiresAt: Date.now() - 1000 };
  f.sqlite.prepare("UPDATE source_accounts SET ciphertext = ? WHERE user_id = ? AND provider = 'dropbox'").run(await encryptToken(f.env, s.session.ownerId, JSON.stringify(expired)), s.session.ownerId);
  dropbox.access.delete(stored.accessToken);
  const before = dropbox.calls.length;
  assert.equal((await json<SourceReadView>(await read('id:notes000001'))).content, '# Notes\nShip it.');
  const refresh = dropbox.calls.slice(before).find(call => call.url === 'https://api.dropboxapi.com/oauth2/token')!;
  assert.equal(new URLSearchParams(refresh.body).get('refresh_token'), stored.refreshToken);
  const renewed = JSON.parse(await decryptToken(f.env, s.session.ownerId, String(f.sqlite.prepare("SELECT ciphertext FROM source_accounts WHERE user_id = ? AND provider = 'dropbox'").get(s.session.ownerId)!.ciphertext)));
  assert.notEqual(renewed.accessToken, stored.accessToken);
  assert.equal(renewed.refreshToken, stored.refreshToken);
  assert.ok(renewed.expiresAt > Date.now());
  const audit = JSON.stringify(f.sqlite.prepare('SELECT * FROM audit').all());
  assert.ok(!/sl\.access-|refresh-\d/.test(audit));
  assert.ok(dropbox.calls.every(call => call.url === 'https://api.dropboxapi.com/oauth2/token' || !call.body.includes('refresh-')));
});
