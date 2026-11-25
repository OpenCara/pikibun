import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { app } from '../apps/server/src/index.js';
import type { Env } from '../apps/server/src/types.js';
import type { ConnectorCredentials, ConnectorPairing } from '../packages/shared/src/connector.js';
import { sha256 } from '../packages/shared/src/crypto.js';
import { parseWorkspaceExtensionsAnswer, withPrivateWorkspaceTools, type WorkspaceExtension } from '../packages/shared/src/host-extensions.js';
import { isPrivateWorkspaceTool, privateWorkspaceTools, sessionToolsOff } from '../packages/shared/src/piki-extensions.js';
import type { Workspace } from '../packages/shared/src/types.js';
import { fakeHub, testDatabase } from './helpers/control-plane.js';

const origin = 'http://localhost:8787';
const testSecret = 'private-workspace-tools-test-secret';
const manifest = {
  models: [{ provider: 'local-native', modelId: 'local/model-v1', name: 'Local model' }],
  capabilities: { platform: 'linux', sandbox: true, productionShell: false, approvalFree: true, plainGit: true, hostConfig: true, extensions: true },
};
const commandTools = ['git', 'git_push', 'node', 'python', 'rust', 'go', 'dotnet', 'make', 'github_read', 'sessions', 'schedule'];

async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  return body as T;
}

async function fixture(t: TestContext) {
  const { db, sqlite } = await testDatabase();
  t.after(() => db.close());
  const env: Env = { DB: db, APP_ORIGIN: origin, TEST_AUTH_ENABLED: 'true', TEST_AUTH_SECRET: testSecret,
    TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(), VAULT_KEY: Buffer.alloc(32, 9).toString('base64url'),
    CONNECTOR_HUB: fakeHub({ rpc: () => Response.json({ error: 'Unsupported test relay request' }, { status: 503 }) }) };
  const request = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => Promise.resolve(app.request(path, { method,
    headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) }, env));
  const signIn = await request('POST', '/api/auth/test', { id: 'alice', displayName: 'alice', gitName: 'alice', gitEmail: 'alice@example.test' },
    { Authorization: `Bearer ${testSecret}` });
  await json(signIn);
  const cookie = signIn.headers.get('set-cookie')!.split(';')[0]!;
  const { csrfToken } = await json<{ csrfToken: string }>(await request('GET', '/api/auth/csrf', undefined, { Cookie: cookie }));
  const alice = (method: string, path: string, body?: unknown) => request(method, path, body, { Cookie: cookie, 'X-CSRF-Token': csrfToken });
  const personal = (await json<{ workspaces: Workspace[] }>(await alice('GET', '/api/workspaces'))).workspaces.find(item => item.personal)!;
  const { workspace: team } = await json<{ workspace: Workspace }>(await alice('POST', '/api/workspaces', { name: 'Team' }), 201);
  const { pairing } = await json<{ pairing: ConnectorPairing }>(await alice('POST', '/api/connectors/pairings', { name: 'Local Pi', workspaceId: team.id }), 201);
  const { credentials } = await json<{ credentials: ConnectorCredentials }>(await request('POST', `/api/connectors/pairings/${pairing.id}/claim`, { code: pairing.code, ...manifest }), 201);
  const connectionToken = Buffer.from(randomBytes(32)).toString('base64url');
  sqlite.prepare('UPDATE connectors SET connection_hash = ? WHERE id = ?').run(await sha256(connectionToken), credentials.connectorId);
  const host = { Authorization: `Bearer ${credentials.token}`, 'X-Connection-Token': connectionToken };
  const answer = async (workspaceId: string) => parseWorkspaceExtensionsAnswer(await json(await request('POST', '/api/connectors/self/extensions/workspace',
    { workspaceId, sessionToolSwitches: true }, host)));
  const old = (workspaceId: string) => {
    sqlite.prepare(`DELETE FROM workspace_extensions WHERE workspace_id = ? AND package_key IN ('piki:git', 'piki:node', 'piki:sessions', 'piki:schedule', 'piki:gh')`).run(workspaceId);
    sqlite.prepare(`UPDATE workspace_extensions SET enabled = 0 WHERE workspace_id = ? AND package_key LIKE 'piki:%'`).run(workspaceId);
  };
  return { alice, personal, team, answer, old };
}

test('the always-on tools are Pikibun\'s commands, GitHub, sessions and schedule, not opt-in features, retired tools or document sources', () => {
  const sources = privateWorkspaceTools().map(item => item.source).sort();
  assert.deepEqual(sources, ['piki:azure-cli', 'piki:browser', 'piki:dotnet', 'piki:gh', 'piki:git', 'piki:github', 'piki:glab', 'piki:go', 'piki:make',
    'piki:node', 'piki:python', 'piki:rust', 'piki:schedule', 'piki:sessions']);
  for (const source of ['piki:files', 'piki:shell', 'piki:host-shell', 'piki:tunnel', 'piki:workspace', 'piki:memory', 'piki:notion', 'piki:prompt-audit']) {
    assert.equal(isPrivateWorkspaceTool(source), false, source);
  }
  const off: WorkspaceExtension[] = [{ source: 'piki:git', enabled: false, tools: 'automatic', settings: {} }, { source: 'piki:tunnel', enabled: false, tools: 'automatic', settings: {} }];
  const shown = withPrivateWorkspaceTools(off);
  assert.equal(shown.find(item => item.source === 'piki:git')?.enabled, true, 'a row turned off is shown on');
  assert.equal(shown.find(item => item.source === 'piki:tunnel')?.enabled, false, 'an opt-in one stays as chosen');
  assert.equal(shown.filter(item => item.source === 'piki:git').length, 1, 'listed once');
  assert.equal(shown.find(item => item.source === 'piki:node')?.enabled, true, 'a missing one is added on');
});

test('in an older private workspace a host gets Pikibun\'s command tools on, whatever its rows say; a shared workspace keeps its switches', async t => {
  const f = await fixture(t);
  f.old(f.personal.id);
  f.old(f.team.id);
  const personal = await f.answer(f.personal.id);
  const offHere = sessionToolsOff(personal.extensions);
  for (const tool of commandTools) assert.equal(offHere.has(tool), false, `${tool} is on in the private workspace`);
  assert.equal(personal.extensions.find(item => item.source === 'piki:gh')?.enabled, true, 'the GitHub CLI too');
  assert.equal(offHere.has('tunnel'), true, 'an opt-in tool stays off until chosen');
  const offThere = sessionToolsOff((await f.answer(f.team.id)).extensions);
  for (const tool of ['git', 'node', 'python', 'sessions']) assert.equal(offThere.has(tool), true, `${tool} stays off in the shared workspace`);
  const listed = await json<{ extensions: WorkspaceExtension[] }>(await f.alice('GET', `/api/workspaces/${f.personal.id}/extensions`));
  assert.equal(listed.extensions.find(item => item.source === 'piki:git')?.enabled, true, 'the Extensions page shows what sessions get');
});

test('in the private workspace its always-on tools can\'t be turned off or removed; elsewhere they can', async t => {
  const f = await fixture(t);
  const off = { source: 'piki:node', enabled: false, tools: 'automatic', settings: {} };
  const refused = await json<{ code: string; error: string }>(await f.alice('PUT', `/api/workspaces/${f.personal.id}/extensions`, off), 400);
  assert.match(refused.error, /always on in your private workspace/);
  await json(await f.alice('DELETE', `/api/workspaces/${f.personal.id}/extensions?source=piki:node`), 400);
  await json(await f.alice('PUT', `/api/workspaces/${f.personal.id}/extensions`, { ...off, enabled: true }));
  await json(await f.alice('PUT', `/api/workspaces/${f.personal.id}/extensions`, { source: 'piki:tunnel', enabled: false, tools: 'automatic', settings: {} }));
  await json(await f.alice('PUT', `/api/workspaces/${f.team.id}/extensions`, off));
  assert.equal(sessionToolsOff((await f.answer(f.team.id)).extensions).has('node'), true);
});
