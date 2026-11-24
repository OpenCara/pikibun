import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { RunnerService } from '../apps/runner/src/server.js';
import type { RunnerSession } from '../apps/runner/src/session.js';
import type { WorkspaceExtensionsAnswer } from '../packages/shared/src/host-extensions.js';
import { sha256 } from '../packages/shared/src/crypto.js';
import { toolNames, type AuthorizationRequest, type RunnerAction, type RunnerBinding, type RunnerTicket } from '../packages/shared/src/types.js';
import { bundledToolDefinitions } from '../packages/shared/src/tool-definitions.js';
import { app } from '../apps/server/src/index.js';
import type { Env } from '../apps/server/src/types.js';
import { brokeredArguments } from '../apps/runner/src/defined-tools.js';
import { bundledToolDefinition, parseToolDefinition, type BrokeredToolDefinition } from '../packages/shared/src/tool-definitions.js';
import { pikiExtension, pikiExtensionOn } from '../packages/shared/src/piki-extensions.js';
import { roleTools } from '../packages/shared/src/tool-groups.js';
import {
  workspaceActionFields, workspaceReadActions, workspaceToolActions, workspaceToolDefinition, workspaceToolParameters, workspaceWriteActions,
} from '../packages/shared/src/workspace-management.js';
import { seedAgentVersion, testDatabase } from './helpers/control-plane.js';

test('the workspace tool is defined as data, switched by piki:workspace, off until added, and only owners and admins have it by default', () => {
  const definition = bundledToolDefinition('workspace') as BrokeredToolDefinition;
  assert.equal(definition, workspaceToolDefinition);
  assert.deepEqual(parseToolDefinition(JSON.parse(JSON.stringify(definition))), definition, 'a connector parses it as it is sent');
  assert.equal(definition.route, 'workspace');
  assert.deepEqual(definition.extensions, ['piki:workspace']);
  assert.deepEqual(Object.keys(definition.parameters), [...workspaceToolParameters], 'each parameter the control plane takes, and no other');
  assert.deepEqual([...workspaceToolActions].sort(), Object.keys(workspaceActionFields).sort());
  assert.equal(workspaceReadActions.length + workspaceWriteActions.length, workspaceToolActions.length);
  const extension = pikiExtension('piki:workspace');
  assert.deepEqual(extension?.sessionTools, ['workspace']);
  assert.equal(pikiExtensionOn(extension!, []), false, 'off where the workspace never added it');
  assert.equal(pikiExtensionOn(extension!, [{ source: 'piki:workspace', enabled: true }]), true);
  for (const role of ['owner', 'admin'] as const) assert.ok(roleTools[role].includes('workspace'), role);
  for (const role of ['collaborator', 'member', 'viewer'] as const) assert.ok(!roleTools[role].includes('workspace'), role);
  assert.deepEqual(brokeredArguments(definition, { action: 'set_role', user: 'github:42', role: 'collaborator' }), { action: 'set_role', user: 'github:42', role: 'collaborator' });
  assert.throws(() => brokeredArguments(definition, { action: 'drop_tables' }), /action is one of get, members/);
  assert.throws(() => brokeredArguments(definition, { action: 'set_role', user: 'root', role: 'admin' }), /user is a member's id/);
  assert.throws(() => brokeredArguments(definition, { action: 'set_role', user: 'github:42', role: 'owner' }), /role is one of admin, collaborator, member, viewer/);
  assert.throws(() => brokeredArguments(definition, { action: 'get', sessionId: 'other' }), /workspace takes no sessionId/);
});

function binding(id: string): RunnerBinding {
  return {
    session: { id, workspaceId: 'workspace', ownerId: 'test:alice', agentVersionId: 'version-1', title: 'Managed', policyVersion: 1, status: 'ready', createdAt: '2026-01-01T00:00:00Z', repositories: [], repositoryMode: 'clone' },
    owner: { id: 'test:alice', githubId: null, githubLogin: 'alice', displayName: 'Alice', gitName: 'Alice Owner', gitEmail: 'alice@example.test', env: {}, githubConnected: false },
    agent: { id: 'version-1', agentId: 'agent', authorId: 'test:alice', workspaceId: 'workspace', version: 1, name: 'Agent', description: '', instructions: 'Use tools.',
      tools: [...toolNames, 'workspace'], modelId: 'model-1', createdAt: '2026-01-01T00:00:00Z' },
    model: { id: 'model-1', workspaceId: 'workspace', name: 'Model', provider: 'faux', modelId: 'faux-1' },
  };
}

async function ticket(id: string, action: RunnerAction): Promise<RunnerTicket> {
  const now = Math.floor(Date.now() / 1000);
  return { aud: 'runner', sessionId: id, actorId: 'test:alice', ownerId: 'test:alice', action, policyVersion: 1, iat: now, exp: now + 60, jti: randomUUID(), bodyHash: await sha256('') };
}

async function idle(session: RunnerSession): Promise<void> {
  for (let count = 0; count < 1000; count++) {
    if (!(await session.view()).busy) return;
    await delay(20);
  }
  assert.fail('runner did not settle');
}

test('a session offers the workspace tool once piki:workspace is on, and forwards its calls to the control plane\'s workspace route',
  { skip: process.platform === 'win32' }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'pikibun-workspace-tool-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const offered: string[][] = [];
  const prompts: string[] = [];
  const noting = (reply: ReturnType<typeof fauxAssistantMessage>) => (context: { messages: { role: string; toolsAdded?: { name: string }[]; toolsRemoved?: { name: string }[] }[] }) => {
    const names = new Set<string>();
    for (const message of context.messages) {
      if (message.role !== 'system') continue;
      for (const tool of message.toolsAdded ?? []) names.add(tool.name);
      for (const tool of message.toolsRemoved ?? []) names.delete(tool.name);
    }
    offered.push([...names]);
    prompts.push(JSON.stringify(context));
    return reply;
  };
  const faux = fauxProvider({ models: [{ id: 'faux-1' }] });
  faux.setResponses([
    noting(fauxAssistantMessage([fauxToolCall('workspace', { action: 'members' })], { stopReason: 'toolUse' })),
    fauxAssistantMessage('Off.'),
    noting(fauxAssistantMessage([fauxToolCall('workspace', { action: 'set_role', user: 'github:42', role: 'collaborator' })], { stopReason: 'toolUse' })),
    fauxAssistantMessage([fauxToolCall('workspace', { action: 'set_role', user: 'root', role: 'collaborator' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage('Done.'),
  ] as never);
  const models = createModels();
  models.setProvider(faux.provider);
  let answer: WorkspaceExtensionsAnswer = { extensions: [], automaticTools: false };
  const calls: { route: string; request: Record<string, unknown> }[] = [];
  const service = new RunnerService({
    dataDir: directory, sharedSecret: 'runner-workspace-tool-secret-not-for-production', controlPlaneUrl: 'http://127.0.0.1:8787', allowFaux: true, unsandboxed: true,
    authorize: async (input: AuthorizationRequest) => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    extensions: { installed: () => [], workspace: async () => answer },
    toolDefinitions: async () => [...bundledToolDefinitions],
    brokered: async (route, request) => { calls.push({ route, request }); return { action: request.action, members: [] }; },
  });
  await service.initialize();
  t.after(() => service.close());
  const id = 'workspace-tool-session';
  const session = await service.provision(binding(id), await ticket(id, 'create'));
  await session.submit(await ticket(id, 'submit'), { content: 'Who is here?', requestId: 'first', admissionId: await sha256('workspace first') }, 'write');
  await idle(session);
  assert.ok(!offered[0]!.includes('workspace'), `off until the workspace adds piki:workspace: ${offered[0]!.join()}`);
  assert.equal(calls.length, 0);
  assert.match((await session.view()).entries.map(entry => entry.text).join('\n'), /Tool workspace is not available|workspace is turned off in this workspace \(piki:workspace\)/);

  answer = { extensions: [{ source: 'piki:workspace', enabled: true, tools: 'automatic', settings: {} }], automaticTools: false };
  await session.submit(await ticket(id, 'submit'), { content: 'Make 42 a collaborator.', requestId: 'second', admissionId: await sha256('workspace second') }, 'write');
  await idle(session);
  assert.ok(offered[1]!.includes('workspace'), offered[1]!.join());
  assert.match(prompts[1]!, /The workspace tool manages this session's own workspace/);
  assert.equal(calls.length, 1, 'the call with an invalid user never left the host');
  assert.equal(calls[0]!.route, 'workspace');
  assert.deepEqual({ ...calls[0]!.request, callId: undefined }, { sessionId: id, actorId: 'test:alice', admissionId: await sha256('workspace second'), callId: undefined,
    action: 'set_role', user: 'github:42', role: 'collaborator' });
  assert.match((await session.view()).entries.map(entry => entry.text).join('\n'), /user is a member's id/);
});

const origin = 'http://localhost:8787';
const testSecret = 'workspace-tool-test-secret-not-for-deployment';

async function fixture(t: TestContext) {
  const { db, sqlite } = await testDatabase();
  t.after(() => db.close());
  const env: Env = { DB: db, APP_ORIGIN: origin, TEST_AUTH_ENABLED: 'true', TEST_AUTH_SECRET: testSecret,
    TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(), RUNNER_SHARED_SECRET: 'workspace-tool-internal-secret-0123456789',
    VAULT_KEY: Buffer.alloc(32, 7).toString('base64url'), RUNNER_URL: 'https://runner.example.test' };
  async function client(name: string) {
    const login = await app.request('/api/auth/test', { method: 'POST', headers: { Origin: origin, Authorization: `Bearer ${testSecret}`, 'Content-Type': 'application/json' },
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
  const owner = await client('wt-owner');
  const admin = await client('wt-admin');
  const member = await client('wt-member');
  const workspace = (await (await owner.request('POST', '/api/workspaces', { name: 'Managed' })).json() as { workspace: { id: string } }).workspace;
  for (const [person, role] of [[admin, 'admin'], [member, 'member']] as const) {
    assert.equal((await owner.request('POST', `/api/workspaces/${workspace.id}/members`, { userId: person.user.id, role })).status, 200);
  }
  const model = (await (await owner.request('POST', `/api/workspaces/${workspace.id}/models`, { name: 'faux', provider: 'faux', modelId: 'faux-1' })).json() as { model: { id: string } }).model;
  const seed = (id: string, ownerId: string) => {
    const agent = seedAgentVersion(sqlite, { authorId: ownerId, modelId: model.id, tools: ['identity', 'workspace'] });
    sqlite.prepare("INSERT INTO sessions (id,workspace_id,owner_id,agent_version_id,title,status,created_at,visibility,repository_mode) VALUES (?,?,?,?,?,?,?,'workspace','clone')")
      .run(id, workspace.id, ownerId, agent.id, `Session of ${ownerId}`, 'ready', new Date().toISOString());
  };
  seed('owner-session', owner.user.id);
  seed('member-session', member.user.id);
  const admit = (sessionId: string, actorId: string, access?: 'read') => {
    const admission = randomBytes(32).toString('base64url');
    sqlite.prepare('INSERT INTO run_admissions (id,session_id,actor_id,mode,access,auto_merge,request_id,content_hash,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(admission, sessionId, actorId, 'write', access ?? null, 0, `request-${admission}`, 'h'.repeat(43), Math.floor(Date.now() / 1000) + 3600, new Date().toISOString());
    return admission;
  };
  let calls = 0;
  const tool = async (sessionId: string, actorId: string, admissionId: string, body: Record<string, unknown>) => {
    const response = await app.request('/api/internal/workspace', { method: 'POST', headers: { Authorization: `Bearer ${env.RUNNER_SHARED_SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, actorId, admissionId, callId: `call-${++calls}`, ...body }) }, env);
    return { status: response.status, body: await response.json() as Record<string, unknown> & { code?: string; error?: string } };
  };
  const ok = async <T = Record<string, unknown>>(result: Promise<{ status: number; body: Record<string, unknown> }>): Promise<T> => {
    const { status, body } = await result;
    assert.equal(status, 200, JSON.stringify(body));
    return body as T;
  };
  const refused = async (result: Promise<{ status: number; body: { code?: string } }>, status: number, code: string) => {
    const { status: actual, body } = await result;
    assert.equal(actual, status, JSON.stringify(body));
    assert.equal(body.code, code, JSON.stringify(body));
  };
  const turnOn = async () => assert.equal((await owner.request('PUT', `/api/workspaces/${workspace.id}/extensions`, { source: 'piki:workspace', enabled: true })).status, 200);
  return { env, sqlite, owner, admin, member, workspace, admit, tool, ok, refused, turnOn };
}

test('an agent reads and manages its workspace as its message\'s sender, through the workspace\'s own routes, while piki:workspace is on, as a new workspace starts', async t => {
  const f = await fixture(t);
  const ownerId = f.owner.user.id;
  const write = f.admit('owner-session', ownerId);
  assert.equal((await f.owner.request('PUT', `/api/workspaces/${f.workspace.id}/extensions`, { source: 'piki:workspace', enabled: false })).status, 200);
  await f.refused(f.tool('owner-session', ownerId, write, { action: 'get' }), 403, 'workspace_tool_off');
  await f.turnOn();

  const got = await f.ok<{ workspace: { id: string; name: string; role: string } }>(f.tool('owner-session', ownerId, write, { action: 'get' }));
  assert.deepEqual([got.workspace.id, got.workspace.name, got.workspace.role], [f.workspace.id, 'Managed', 'owner']);
  const members = await f.ok<{ members: { userId: string; role: string }[] }>(f.tool('owner-session', ownerId, write, { action: 'members' }));
  assert.deepEqual(members.members.map(item => [item.userId, item.role]), [[ownerId, 'owner'], [f.admin.user.id, 'admin'], [f.member.user.id, 'member']]);
  const listed = await f.ok<{ extensions: { source: string; enabled: boolean }[]; admin: boolean; hosts: unknown[] }>(f.tool('owner-session', ownerId, write, { action: 'extensions' }));
  assert.ok(listed.extensions.some(item => item.source === 'piki:workspace' && item.enabled));
  assert.equal(listed.admin, true);
  for (const action of ['repositories', 'sources', 'tool_groups', 'network', 'join_requests']) await f.ok(f.tool('owner-session', ownerId, write, { action }));

  assert.equal((await f.ok<{ workspace: { name: string } }>(f.tool('owner-session', ownerId, write, { action: 'rename', name: '  Renamed  ' }))).workspace.name, 'Renamed');
  const promoted = await f.ok<{ members: { userId: string; role: string }[] }>(f.tool('owner-session', ownerId, write, { action: 'set_role', user: f.member.user.id, role: 'collaborator' }));
  assert.equal(promoted.members.find(item => item.userId === f.member.user.id)?.role, 'collaborator');
  await f.ok(f.tool('owner-session', ownerId, write, { action: 'set_role', user: f.member.user.id, role: 'member' }));

  assert.equal((await f.ok<{ policy: { mode: string } }>(f.tool('owner-session', ownerId, write, { action: 'set_network_mode', mode: 'allowlist' }))).policy.mode, 'allowlist');
  const allowed = await f.ok<{ policy: { domains: string[] } }>(f.tool('owner-session', ownerId, write, { action: 'allow_domain', domain: 'Example.COM' }));
  assert.deepEqual(allowed.policy.domains, ['example.com']);
  assert.equal((await f.ok<{ unchanged?: boolean }>(f.tool('owner-session', ownerId, write, { action: 'allow_domain', domain: 'example.com' }))).unchanged, true);
  assert.deepEqual((await f.ok<{ policy: { domains: string[] } }>(f.tool('owner-session', ownerId, write, { action: 'disallow_domain', domain: 'example.com' }))).policy.domains, []);
  await f.refused(f.tool('owner-session', ownerId, write, { action: 'disallow_domain', domain: 'example.com' }), 404, 'not_found');

  const added = await f.ok<{ extension: { source: string; enabled: boolean; settings: Record<string, unknown> }; added?: boolean }>(
    f.tool('owner-session', ownerId, write, { action: 'set_extension', extension: 'piki:pr-flow', settings: '{"review-minutes":"5"}' }));
  assert.deepEqual([added.extension.source, added.extension.enabled, added.extension.settings, added.added], ['piki:pr-flow', true, { 'review-minutes': '5' }, true]);
  const off = await f.ok<{ extension: { enabled: boolean; settings: Record<string, unknown> } }>(
    f.tool('owner-session', ownerId, write, { action: 'set_extension', extension: 'piki:pr-flow', enabled: false }));
  assert.deepEqual([off.extension.enabled, off.extension.settings], [false, { 'review-minutes': '5' }], 'turning it off keeps its settings');
  const changed = await f.ok<{ extension: { enabled: boolean; settings: Record<string, unknown> } }>(
    f.tool('owner-session', ownerId, write, { action: 'set_extension', extension: 'piki:pr-flow', settings: '{"review-minutes":"10"}' }));
  assert.deepEqual([changed.extension.enabled, changed.extension.settings], [false, { 'review-minutes': '10' }], 'changing its settings leaves it off');
  await f.refused(f.tool('owner-session', ownerId, write, { action: 'set_extension', extension: 'piki:pr-flow', settings: '[1]' }), 400, 'invalid_input');
  await f.refused(f.tool('owner-session', ownerId, write, { action: 'set_extension', extension: 'not a source' }), 400, 'invalid_extension');
  assert.equal((await f.ok<{ removed: string }>(f.tool('owner-session', ownerId, write, { action: 'remove_extension', extension: 'piki:pr-flow' }))).removed, 'piki:pr-flow');
  await f.refused(f.tool('owner-session', ownerId, write, { action: 'remove_extension', extension: 'piki:pr-flow' }), 404, 'not_found');

  await f.ok(f.tool('owner-session', ownerId, write, { action: 'set_tool_group', user: f.member.user.id, group: 'role' }));
  await f.refused(f.tool('owner-session', ownerId, write, { action: 'set_tool_group', user: f.member.user.id, group: 'nope' }), 404, 'not_found');
  await f.refused(f.tool('owner-session', ownerId, write, { action: 'remove_repository', repository: 'acme/app' }), 404, 'not_found');
  await f.refused(f.tool('owner-session', ownerId, write, { action: 'add_repository', repository: 'acme/app', provider: 'gitlab' }), 409, 'git_account_required');
  await f.refused(f.tool('owner-session', ownerId, write, { action: 'add_repository', repository: 'https://gitlab.com/acme/app' }), 409, 'git_account_required');
  await f.refused(f.tool('owner-session', ownerId, write, { action: 'add_repository', repository: 'gitlab.com/acme/app' }), 409, 'git_account_required');
  await f.refused(f.tool('owner-session', ownerId, write, { action: 'add_repository', repository: 'https://github.com/acme' }), 400, 'invalid_input');
  await f.refused(f.tool('owner-session', ownerId, write, { action: 'decline_join_request', user: 'test:nobody' }), 404, 'not_found');

  const audited = f.sqlite.prepare("SELECT session_id, actor_id, detail_json FROM audit WHERE action = 'session.workspace_tool.changed' ORDER BY created_at").all() as
    { session_id: string; actor_id: string; detail_json: string }[];
  assert.ok(audited.length >= 8, `each change is recorded with the session it came from: ${audited.length}`);
  assert.ok(audited.every(row => row.session_id === 'owner-session' && row.actor_id === ownerId));
  assert.deepEqual(JSON.parse(audited[0]!.detail_json), { action: 'rename', callId: 'call-10', name: 'Renamed' });
  assert.ok(!audited.some(row => JSON.parse(row.detail_json).settings !== undefined), 'settings are never copied into the audit');

  assert.equal((await f.ok<{ removed: string }>(f.tool('owner-session', ownerId, write, { action: 'remove_member', user: f.member.user.id }))).removed, f.member.user.id);
  assert.equal((await f.ok<{ members: unknown[] }>(f.tool('owner-session', ownerId, write, { action: 'members' }))).members.length, 2);
});

test('the workspace tool adds only Pikibun\'s own extensions: a third-party source, or another version of a listed one, is a person\'s to add on the settings page', async t => {
  const f = await fixture(t);
  await f.turnOn();
  const ownerId = f.owner.user.id;
  const write = f.admit('owner-session', ownerId);
  const path = `/api/workspaces/${f.workspace.id}/extensions`;
  const sources = async () => (await (await f.owner.request('GET', path)).json() as { extensions: { source: string; enabled: boolean }[] }).extensions;
  const before = (await sources()).map(item => item.source);
  const commit = 'a'.repeat(40);
  const audits = () => (f.sqlite.prepare("SELECT COUNT(*) AS count FROM audit WHERE action IN ('session.workspace_tool.changed', 'workspace.extension.updated')").get() as { count: number }).count;
  const audited = audits();

  for (const extension of ['npm:left-pad@1.3.0', `git:https://github.com/acme/extension@${commit}`, `git:github.com/acme/extension@${commit}#extensions/one`]) {
    for (const more of [{}, { enabled: false }, { settings: '{"flag":true}' }]) {
      const { status, body } = await f.tool('owner-session', ownerId, write, { action: 'set_extension', extension, ...more });
      assert.deepEqual([status, body.code], [403, 'extension_source_not_listed'], JSON.stringify(body));
      assert.match(body.error!, /isn't in this workspace's extensions.*piki:<name>.*a person adds it under Settings → Workspaces → the workspace → Extensions/);
    }
  }
  assert.deepEqual((await sources()).map(item => item.source), before, 'nothing was added');
  assert.equal(audits(), audited, 'a refused call changed nothing to record');

  assert.equal((await f.owner.request('PUT', path, { source: 'npm:left-pad@1.3.0', enabled: false, settings: { flag: 'a' } })).status, 200);
  assert.equal((await f.owner.request('PUT', path, { source: `git:https://github.com/acme/extension@${commit}`, enabled: false })).status, 200);
  const on = await f.ok<{ extension: { source: string; enabled: boolean; settings: Record<string, unknown> }; added?: boolean }>(
    f.tool('owner-session', ownerId, write, { action: 'set_extension', extension: 'npm:left-pad@1.3.0', enabled: true }));
  assert.deepEqual([on.extension.source, on.extension.enabled, on.extension.settings, on.added], ['npm:left-pad@1.3.0', true, { flag: 'a' }, undefined],
    'a source a person listed is turned on with its settings kept');
  const changed = await f.ok<{ extension: { enabled: boolean; settings: Record<string, unknown> } }>(
    f.tool('owner-session', ownerId, write, { action: 'set_extension', extension: 'npm:left-pad@1.3.0', enabled: false, settings: '{"flag":"b"}' }));
  assert.deepEqual([changed.extension.enabled, changed.extension.settings], [false, { flag: 'b' }]);
  assert.equal((await f.ok<{ extension: { source: string; enabled: boolean } }>(
    f.tool('owner-session', ownerId, write, { action: 'set_extension', extension: `git:github.com/acme/extension.git@${commit}`, enabled: true }))).extension.enabled, true,
  'the same source written another way is the listed one');

  for (const extension of ['npm:left-pad@1.3.1', 'npm:left-pad@1.2.0', `git:https://github.com/acme/extension@${'b'.repeat(40)}`]) {
    const { status, body } = await f.tool('owner-session', ownerId, write, { action: 'set_extension', extension, enabled: true });
    assert.deepEqual([status, body.code], [403, 'extension_source_not_listed'], JSON.stringify(body));
    assert.match(body.error!, /This workspace lists (npm:left-pad@1\.3\.0|git:https:\/\/github\.com\/acme\/extension@a{40})\..*another version of it.*A person changes it under Settings → Workspaces → the workspace → Extensions/);
  }
  const after = await sources();
  assert.ok(after.some(item => item.source === 'npm:left-pad@1.3.0' && !item.enabled), 'the listed version stays');
  assert.ok(!after.some(item => item.source.startsWith('npm:left-pad@') && item.source !== 'npm:left-pad@1.3.0'));
  assert.ok(after.some(item => item.source === `git:https://github.com/acme/extension@${commit}`));

  const added = await f.ok<{ extension: { source: string; enabled: boolean }; added?: boolean }>(f.tool('owner-session', ownerId, write, { action: 'set_extension', extension: 'piki:pr-flow' }));
  assert.deepEqual([added.extension.source, added.extension.enabled, added.added], ['piki:pr-flow', true, true], 'a built-in is still added from a session');
  assert.equal((await f.ok<{ removed: string }>(f.tool('owner-session', ownerId, write, { action: 'remove_extension', extension: 'npm:left-pad@1.3.0' }))).removed, 'npm:left-pad');
  await f.refused(f.tool('owner-session', ownerId, write, { action: 'set_extension', extension: 'npm:left-pad@1.3.0' }), 403, 'extension_source_not_listed');
  assert.match(workspaceToolDefinition.description, /An npm: or git: source the workspace doesn't list yet, or another version or commit of one it lists, is refused/);
});

test('the workspace tool never does more than its sender may: their role, their tool group, a Read-only message and the request\'s own fields decide', async t => {
  const f = await fixture(t);
  await f.turnOn();
  const ownerId = f.owner.user.id;
  const adminId = f.admin.user.id;

  const readOnly = f.admit('owner-session', ownerId, 'read');
  await f.ok(f.tool('owner-session', ownerId, readOnly, { action: 'members' }));
  await f.refused(f.tool('owner-session', ownerId, readOnly, { action: 'rename', name: 'Nope' }), 403, 'write_not_allowed');

  const byAdmin = f.admit('owner-session', adminId);
  assert.equal((await f.ok<{ workspace: { role: string } }>(f.tool('owner-session', adminId, byAdmin, { action: 'get' }))).workspace.role, 'admin', 'as the sender, not the session\'s owner');
  await f.refused(f.tool('owner-session', adminId, byAdmin, { action: 'set_role', user: ownerId, role: 'member' }), 403, 'forbidden');
  await f.refused(f.tool('owner-session', adminId, byAdmin, { action: 'add_member', user: f.member.user.id, role: 'admin' }), 403, 'forbidden');
  await f.ok(f.tool('owner-session', adminId, byAdmin, { action: 'set_role', user: f.member.user.id, role: 'collaborator' }));

  const byMember = f.admit('member-session', f.member.user.id);
  await f.refused(f.tool('member-session', f.member.user.id, byMember, { action: 'get' }), 403, 'tool_not_in_group');
  await f.refused(f.tool('member-session', ownerId, f.admit('member-session', ownerId), { action: 'get' }), 403, 'tool_not_in_group',
  );
  await f.refused(f.tool('owner-session', ownerId, byAdmin, { action: 'get' }), 403, 'workspace_not_admitted');

  const write = f.admit('owner-session', ownerId);
  for (const body of [{ action: 'drop' }, { action: 'members', user: ownerId }, { action: 'rename' }, { action: 'set_role', user: 'root', role: 'admin' },
    { action: 'set_role', user: ownerId, role: 'owner' }, { action: 'set_extension', extension: 'piki:node', enabled: 'yes' }, { action: 'get', workspaceId: 'other' },
    { action: 'set_network_mode', mode: 'everything' }, { action: 'rename', name: 'a\nb' }]) {
    await f.refused(f.tool('owner-session', ownerId, write, body), 400, 'invalid_input');
  }

  assert.equal((await f.owner.request('PUT', `/api/workspaces/${f.workspace.id}/extensions`, { source: 'piki:workspace', enabled: false })).status, 200);
  await f.refused(f.tool('owner-session', ownerId, write, { action: 'get' }), 403, 'workspace_tool_off');
});
