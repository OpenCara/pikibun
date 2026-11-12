import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { app } from '../apps/server/src/index.js';
import { connectorWorkspaceExtensions } from '../apps/server/src/extensions.js';
import type { Env } from '../apps/server/src/types.js';
import { fakeHub, testDatabase } from './helpers/control-plane.js';
import { assessTask, autoChoice, autoModeOn, autoThinkingLevel, modelTier, rankModels } from '../packages/shared/src/auto-mode.js';
import type { ConnectorCredentials, ConnectorInfo, ConnectorPairing, LocalModelSummary } from '../packages/shared/src/connector.js';
import { sha256 } from '../packages/shared/src/crypto.js';
import { isControlPlaneExtension, pikiControlPlaneExtensions, pikiExtension, pikiExtensionOn } from '../packages/shared/src/piki-extensions.js';
import { extensionOffer } from '../packages/shared/src/workspace-tools.js';

const haiku: LocalModelSummary = { provider: 'anthropic', modelId: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', thinkingLevels: ['off', 'low', 'medium', 'high'] };
const sonnet: LocalModelSummary = { provider: 'anthropic', modelId: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', thinkingLevels: ['off', 'low', 'medium', 'high'] };
const opus: LocalModelSummary = { provider: 'anthropic', modelId: 'claude-opus-4-1', name: 'Claude Opus 4.1', thinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh'] };

const simpleTask = 'Fix the typo in the README';
const complexTask = `Refactor the session runner across the whole codebase: split the queue, the tool registry and the transcript into their own modules,
keep the public API, and investigate the race condition between stop and submit.
- move the queue
- move the registry
- add tests for each`;

function host(overrides: Partial<ConnectorInfo> = {}): ConnectorInfo {
  return { id: 'c1', ownerId: 'u1', ownerName: 'ada', name: 'ada-mac', createdAt: '2026-11-01T00:00:00.000Z', revokedAt: null, online: true,
    models: [haiku, sonnet, opus], workspaceIds: ['w1'], capabilities: { platform: 'linux', sandbox: true, productionShell: true, chatOptions: true }, ...overrides };
}

test('a task\'s complexity comes from its length, its structure and what it asks for', () => {
  assert.equal(assessTask(simpleTask).complexity, 'simple');
  assert.equal(assessTask('What does parseManifest do?').complexity, 'simple');
  assert.equal(assessTask('Explain the login flow').complexity, 'simple');
  assert.equal(assessTask('Add a dark mode').complexity, 'moderate');
  assert.equal(assessTask('').complexity, 'moderate', 'a session started without a task gets a balanced choice');
  const complex = assessTask(complexTask);
  assert.equal(complex.complexity, 'complex');
  assert.ok(complex.signals.includes('a refactor') && complex.signals.includes('concurrency'), complex.signals.join());
  assert.equal(assessTask('Fine-tune the model on the GPU box').gpu, true);
  assert.equal(assessTask(simpleTask).gpu, false);
});

test('models fall into light, standard and frontier tiers, and each complexity gets the closest without falling short', () => {
  assert.deepEqual([haiku, sonnet, opus].map(modelTier), [1, 2, 3]);
  assert.equal(modelTier({ modelId: 'gpt-5-mini', name: 'GPT-5 mini' }), 1);
  assert.equal(modelTier({ modelId: 'gpt-5', name: 'GPT-5' }), 3);
  assert.equal(modelTier({ modelId: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }), 3);
  assert.equal(modelTier({ modelId: 'llama-3.1-8b', name: 'Llama 3.1 8B' }), 1);
  assert.equal(modelTier({ modelId: 'local/model-v1', name: 'Local model' }), 2);
  assert.equal(rankModels([opus, sonnet, haiku], 'simple')[0], haiku);
  assert.equal(rankModels([opus, sonnet, haiku], 'moderate')[0], sonnet);
  assert.equal(rankModels([haiku, sonnet, opus], 'complex')[0], opus);
  assert.equal(rankModels([haiku, sonnet], 'complex')[0], sonnet, 'the strongest there is when none is strong enough');
  assert.equal(autoThinkingLevel(opus, 'complex'), 'high');
  assert.equal(autoThinkingLevel(haiku, 'simple'), 'low');
  assert.equal(autoThinkingLevel({ ...sonnet, thinkingLevels: ['off', 'high'] }, 'moderate'), 'high');
  assert.equal(autoThinkingLevel({ ...sonnet, thinkingLevels: ['off', 'high'] }, 'simple'), 'off');
  assert.equal(autoThinkingLevel({ ...sonnet, thinkingLevels: undefined }, 'complex'), undefined);
});

test('auto chooses an online host it may use, preferring the user\'s own, the idle and the GPU one a task needs', () => {
  const base = { userId: 'u1', workspaceId: 'w1' };
  const own = host();
  const shared = host({ id: 'c2', ownerId: 'u2', ownerName: 'grace', name: 'grace-box' });
  assert.equal(autoChoice({ ...base, task: complexTask, hosts: [shared, own] })?.connectorId, 'c1');
  const choice = autoChoice({ ...base, task: complexTask, hosts: [own] })!;
  assert.deepEqual({ ...choice, reasons: [] }, { connectorId: 'c1', provider: 'anthropic', modelId: 'claude-opus-4-1', thinkingLevel: 'high', complexity: 'complex', reasons: [] });
  assert.match(choice.reasons.join(' '), /looks complex.*ada-mac: your host, idle.*Claude Opus 4\.1: a frontier model, with high reasoning/);
  assert.equal(autoChoice({ ...base, task: simpleTask, hosts: [own] })?.modelId, 'claude-haiku-4-5');
  assert.equal(autoChoice({ ...base, task: complexTask, hosts: [own, shared], working: { c1: 4 } })?.connectorId, 'c2', 'a busy host gives way');
  assert.equal(autoChoice({ ...base, task: complexTask, hosts: [host({ online: false }), shared] })?.connectorId, 'c2');
  assert.equal(autoChoice({ ...base, task: complexTask, hosts: [host({ ownerId: 'u3', workspaceIds: [] })] }), undefined, 'not shared with the workspace');
  assert.equal(autoChoice({ ...base, task: complexTask, hosts: [own, host({ id: 'c3', models: [haiku] })] })?.connectorId, 'c1', 'the host with the model the task needs');
  const gpu = host({ id: 'c4', ownerId: 'u2', capabilities: { ...own.capabilities, gpu: 'nvidia' } });
  assert.equal(autoChoice({ ...base, task: 'Fine-tune the model with CUDA', hosts: [own, gpu] })?.connectorId, 'c4');
  assert.equal(autoChoice({ ...base, task: complexTask, hosts: [own, shared], connectorId: 'c2' })?.connectorId, 'c2', 'a host the user kept');
  assert.equal(autoChoice({ ...base, task: complexTask, hosts: [own], model: { provider: 'anthropic', modelId: 'claude-sonnet-4-5' } })?.modelId, 'claude-sonnet-4-5', 'a model the user kept');
  assert.equal(autoChoice({ ...base, task: complexTask, hosts: [own], usable: (_, model) => model !== opus })?.modelId, 'claude-sonnet-4-5', 'only models the user may use');
});

test('piki:auto-mode is Pikibun\'s, off until a workspace turns it on, and never reaches hosts', () => {
  const info = pikiExtension('piki:auto-mode')!;
  assert.equal(info.controlPlane, true);
  assert.equal(isControlPlaneExtension('piki:auto-mode'), true);
  assert.equal(isControlPlaneExtension('piki:pr-flow'), false);
  assert.deepEqual(pikiControlPlaneExtensions().map(item => item.source), ['piki:auto-mode']);
  assert.equal(pikiExtensionOn(info, []), false);
  assert.equal(autoModeOn([]), false);
  assert.equal(autoModeOn([{ source: 'piki:auto-mode', enabled: false }]), false);
  assert.equal(autoModeOn([{ source: 'piki:auto-mode', enabled: true }]), true);
  assert.deepEqual(extensionOffer('piki:auto-mode', []), { description: info.description, tools: [] });
  const extensions = [{ source: 'piki:auto-mode', enabled: true, tools: 'automatic' as const, settings: {} },
    { source: 'piki:pr-flow', enabled: true, tools: 'automatic' as const, settings: {} }];
  assert.deepEqual(connectorWorkspaceExtensions(extensions, [{ source: 'piki:pr-flow' }]).map(item => item.source), ['piki:pr-flow']);
});

const origin = 'http://localhost:8787';
const testSecret = 'auto-mode-test-secret-not-for-deployment';
const manifest = {
  models: [haiku, sonnet, opus],
  capabilities: { platform: 'linux', sandbox: true, productionShell: false, chatOptions: true, plainGit: true },
};

type ApiRequest = (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Response | Promise<Response>;
interface Client { user: { id: string }; request: ApiRequest }

async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  return body as T;
}

async function fixture(t: TestContext) {
  const { db, sqlite } = await testDatabase();
  t.after(() => db.close());
  const env: Env = { DB: db, APP_ORIGIN: origin, TEST_AUTH_ENABLED: 'true', TEST_AUTH_SECRET: testSecret,
    TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(), VAULT_KEY: Buffer.alloc(32, 7).toString('base64url'), CONNECTOR_HUB: fakeHub() };
  const request: ApiRequest = (method, path, body, headers = {}) => app.request(path, { method,
    headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) }, env);
  async function client(name: string): Promise<Client> {
    const response = await request('POST', '/api/auth/test', { id: name, displayName: name, gitName: name, gitEmail: `${name}@example.test` },
      { Authorization: `Bearer ${testSecret}` });
    const { user } = await json<{ user: { id: string } }>(response);
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const { csrfToken } = await json<{ csrfToken: string }>(await request('GET', '/api/auth/csrf', undefined, { Cookie: cookie }));
    return { user, request: (method, path, body, extra = {}) => request(method, path, body, { Cookie: cookie, 'X-CSRF-Token': csrfToken, ...extra }) };
  }
  return { sqlite: sqlite as DatabaseSync, request, client };
}

test('a workspace with auto mode on answers with a host and model for the task; one without it refuses', async t => {
  const f = await fixture(t);
  const alice = await f.client('alice');
  const bob = await f.client('bob');
  const outsider = await f.client('mallory');
  const { workspace } = await json<{ workspace: { id: string } }>(await alice.request('POST', '/api/workspaces', { name: 'Team' }), 201);
  await json(await alice.request('POST', `/api/workspaces/${workspace.id}/members`, { userId: bob.user.id, role: 'member' }));
  const { pairing } = await json<{ pairing: ConnectorPairing }>(await alice.request('POST', '/api/connectors/pairings', { name: 'Local Pi' }), 201);
  const { credentials } = await json<{ credentials: ConnectorCredentials }>(
    await f.request('POST', `/api/connectors/pairings/${pairing.id}/claim`, { code: pairing.code, ...manifest }), 201);
  f.sqlite.prepare('UPDATE connectors SET connection_hash = ? WHERE id = ?').run(await sha256(Buffer.from(randomBytes(32)).toString('base64url')), credentials.connectorId);
  f.sqlite.prepare('INSERT INTO connector_shares (connector_id, workspace_id, created_at) VALUES (?, ?, ?)').run(credentials.connectorId, workspace.id, new Date().toISOString());
  const path = `/api/workspaces/${workspace.id}/auto-mode`;

  assert.deepEqual(await json(await bob.request('GET', path)), { enabled: false });
  assert.equal((await json<{ code: string }>(await bob.request('POST', path, { task: complexTask }), 409)).code, 'auto_mode_off');
  await json(await alice.request('PUT', `/api/workspaces/${workspace.id}/extensions`, { source: 'piki:auto-mode' }));
  assert.deepEqual(await json(await bob.request('GET', path)), { enabled: true });
  assert.equal((await outsider.request('GET', path)).status, 404);

  type Answer = { choice: { connectorId: string; modelId: string; thinkingLevel?: string; complexity: string; id?: string; reasons: string[] } };
  const complex = await json<Answer>(await bob.request('POST', path, { task: complexTask }));
  assert.equal(complex.choice.connectorId, credentials.connectorId);
  assert.equal(complex.choice.modelId, 'claude-opus-4-1');
  assert.equal(complex.choice.thinkingLevel, 'high');
  assert.equal(complex.choice.complexity, 'complex');
  assert.match(complex.choice.reasons[1]!, /alice's host, shared here, idle/);
  const { models } = await json<{ models: { id: string; connectorId: string; modelId: string }[] }>(await bob.request('GET', `/api/workspaces/${workspace.id}/models`));
  assert.equal(complex.choice.id, models.find(model => model.connectorId === credentials.connectorId && model.modelId === 'claude-opus-4-1')!.id);
  assert.equal((await json<Answer>(await bob.request('POST', path, { task: simpleTask }))).choice.modelId, 'claude-haiku-4-5');
  assert.equal((await json<Answer>(await bob.request('POST', path, { task: complexTask, model: { provider: 'anthropic', modelId: 'claude-sonnet-4-5' } }))).choice.modelId, 'claude-sonnet-4-5');
  assert.equal((await json<{ code: string }>(await bob.request('POST', path, { task: complexTask, connectorId: 'elsewhere' }), 409)).code, 'auto_mode_unavailable');
  assert.equal((await json<{ code: string }>(await bob.request('POST', path, { task: 1 }), 400)).code, 'invalid_input');
  assert.equal((await json<{ code: string }>(await bob.request('POST', path, { task: '', extra: true }), 400)).code, 'invalid_input');

  await json(await alice.request('PUT', `/api/workspaces/${workspace.id}/extensions`, { source: 'piki:auto-mode', enabled: false }));
  assert.deepEqual(await json(await bob.request('GET', path)), { enabled: false });
  assert.equal((await json<{ code: string }>(await bob.request('POST', path, { task: complexTask }), 409)).code, 'auto_mode_off');
});

test('a host can\'t require auto mode, which runs in Pikibun itself', async t => {
  const f = await fixture(t);
  const alice = await f.client('alice');
  const { pairing } = await json<{ pairing: ConnectorPairing }>(await alice.request('POST', '/api/connectors/pairings', { name: 'Local Pi' }), 201);
  const { credentials } = await json<{ credentials: ConnectorCredentials }>(
    await f.request('POST', `/api/connectors/pairings/${pairing.id}/claim`, { code: pairing.code, ...manifest }), 201);
  const response = await alice.request('PATCH', `/api/connectors/${credentials.connectorId}/config`, { requiredExtensions: [{ source: 'piki:auto-mode', settings: {} }] });
  const answer = await json<{ code: string; error: string }>(response, 400);
  assert.equal(answer.code, 'invalid_host_config');
  assert.match(answer.error, /runs in Pikibun itself/);
});
