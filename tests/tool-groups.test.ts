import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { app } from '../apps/server/src/index.js';
import type { Env } from '../apps/server/src/types.js';
import { memberToolGroups, requireSessionTool } from '../apps/server/src/authority/tool-groups.js';
import {
  groupTools, memberTools, parseGroupTools, parseMemberToolGroups, retiredGroupTools, roleTools, toolsLeftOut, toolsOff, unknownToolGroup, type ToolGroupSettings,
} from '../packages/shared/src/tool-groups.js';
import { parseWorkspaceExtensionsAnswer } from '../packages/shared/src/host-extensions.js';
import { testDatabase } from './helpers/control-plane.js';

test('each role\'s sessions get their tools, and a group\'s own tools replace them', () => {
  assert.deepEqual(roleTools.owner, groupTools);
  assert.deepEqual(roleTools.admin, groupTools);
  assert.deepEqual(toolsLeftOut(roleTools.collaborator), ['tunnel', 'github_merge'], 'collaborators neither merge nor put apps online');
  assert.deepEqual(toolsLeftOut(roleTools.member), ['git_push', 'tunnel', 'github_comment', 'github_issue', 'github_merge', 'schedule', 'sessions'],
    'members work in the sandbox: files, commands, the session branch and reading GitHub');
  assert.deepEqual(roleTools.viewer, ['identity', 'list_files', 'read_file', 'search']);
  assert.deepEqual(memberTools('member', { tools: ['github_merge', 'read_file', 'unknown'] }), ['read_file', 'github_merge'], 'a group replaces the role\'s tools');
  assert.deepEqual(memberTools('owner', null), [...groupTools]);
  assert.deepEqual(parseGroupTools(['sessions', 'git', 'git', 'read_file']), ['read_file', 'git', 'sessions'], 'in the catalog\'s order, each once');
  assert.deepEqual(parseGroupTools([]), []);
  assert.throws(() => parseGroupTools(['bash']), /bash isn't one of Pikibun's session tools/);
  assert.throws(() => parseGroupTools('git'), /list/);
  assert.deepEqual(parseMemberToolGroups(undefined), {});
  assert.deepEqual(parseMemberToolGroups({ u1: { name: 'Members', off: ['git_push'] } }), { u1: { name: 'Members', off: ['git_push'] } });
  assert.throws(() => parseMemberToolGroups({ u1: { name: 'Members', off: 'git_push' } }), /Invalid tool groups/);
  assert.deepEqual(parseWorkspaceExtensionsAnswer({ extensions: [], automaticTools: false, toolGroups: { u1: { name: 'Members', off: ['sessions'] } } }).toolGroups,
    { u1: { name: 'Members', off: ['sessions'] } }, 'hosts read the groups with the workspace\'s extensions');
  assert.equal(parseWorkspaceExtensionsAnswer({ extensions: [], automaticTools: false }).toolGroups, undefined);
  assert.ok(retiredGroupTools.includes('bash') && retiredGroupTools.includes('host_bash'));
  assert.deepEqual(toolsOff(groupTools), [], 'a session with every tool keeps the retired ones old agents may pin');
  assert.deepEqual(toolsOff(roleTools.collaborator), ['tunnel', 'github_merge', ...retiredGroupTools], 'any other session runs without them');
  assert.deepEqual(unknownToolGroup.off, toolsOff(roleTools.viewer), 'a host that has never heard of the workspace only reads files');
});

const origin = 'http://localhost:8787';
const secret = 'tool-groups-test-secret-not-for-deployment';

async function fixture(t: TestContext) {
  const { db, sqlite } = await testDatabase();
  t.after(() => db.close());
  const env: Env = { DB: db, APP_ORIGIN: origin, TEST_AUTH_ENABLED: 'true', TEST_AUTH_SECRET: secret,
    TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(), RUNNER_SHARED_SECRET: 'tool-groups-internal-secret-0123456789',
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
  const owner = await client('tg-owner');
  const admin = await client('tg-admin');
  const member = await client('tg-member');
  const other = await client('tg-other');
  const workspace = (await (await owner.request('POST', '/api/workspaces', { name: 'Tool groups' })).json() as { workspace: { id: string } }).workspace;
  for (const [person, role] of [[admin, 'admin'], [member, 'member'], [other, 'member']] as const) {
    assert.equal((await owner.request('POST', `/api/workspaces/${workspace.id}/members`, { userId: person.user.id, role })).status, 200);
  }
  return { env, sqlite, owner, admin, member, other, workspace, path: `/api/workspaces/${workspace.id}` };
}

async function body<T>(response: Response, status = 200): Promise<T> {
  const value = await response.json() as T;
  assert.equal(response.status, status, JSON.stringify(value));
  return value;
}

test('workspace owners and admins create tool groups and put members in them; the members\' sessions then run only those tools', async t => {
  const f = await fixture(t);
  const row = (userId: string) => ({ workspace_id: f.workspace.id, owner_id: userId });
  const refusedTool = async (userId: string, tool: string) => assert.rejects(requireSessionTool(f.env, row(userId), userId, tool),
    (error: { status?: number }) => error.status === 403);

  const initial = await body<ToolGroupSettings>(await f.member.request('GET', `${f.path}/tool-groups`));
  assert.equal(initial.admin, false, 'every member sees the groups; only owners and admins change them');
  assert.deepEqual(initial.groups, []);
  assert.deepEqual(initial.roles.member, [...roleTools.member]);
  assert.deepEqual(initial.members.map(item => [item.userId, item.role, item.groupId]),
    [[f.owner.user.id, 'owner', null], [f.admin.user.id, 'admin', null], [f.member.user.id, 'member', null], [f.other.user.id, 'member', null]]);
  await requireSessionTool(f.env, row(f.owner.user.id), f.owner.user.id, 'github_merge');
  await requireSessionTool(f.env, row(f.member.user.id), f.member.user.id, 'git');
  await refusedTool(f.member.user.id, 'git_push');
  await refusedTool(f.member.user.id, 'bash');
  await requireSessionTool(f.env, row(f.owner.user.id), f.owner.user.id, 'bash');
  await requireSessionTool(f.env, row(f.member.user.id), f.member.user.id, 'codemode');
  await refusedTool('test:stranger', 'read_file');
  assert.deepEqual(Object.keys(await memberToolGroups(f.env, f.workspace.id)).sort(), [f.member.user.id, f.other.user.id].sort());

  assert.equal((await f.member.request('POST', `${f.path}/tool-groups`, { name: 'Mine', tools: ['git_push'] })).status, 403);
  await body(await f.admin.request('POST', `${f.path}/tool-groups`, { name: 'Bad', tools: ['bash'] }), 400);
  await body(await f.admin.request('POST', `${f.path}/tool-groups`, { name: ' ', tools: [] }), 400);
  const refused = async (method: string, path: string, input: unknown) => (await body<{ error: string; code: string }>(await f.admin.request(method, `${f.path}${path}`, input), 400)).error;
  assert.equal(await refused('POST', '/tool-groups', { name: '', tools: [], extra: 1 }), 'A tool group has a name and tools.', 'the shape is named before a field');
  assert.equal(await refused('POST', '/tool-groups', { tools: [] }), 'Invalid name.');
  assert.equal(await refused('POST', '/tool-groups', { name: ' ', tools: [] }), 'A tool group\'s name is one non-empty line.');
  assert.equal(await refused('PUT', `/members/${f.member.user.id}/tool-group`, {}), 'Set groupId to a tool group of the workspace, or null for the member\'s role.');
  assert.equal(await refused('PUT', `/members/${f.member.user.id}/tool-group`, { groupId: null, extra: 1 }), 'Set groupId to a tool group of the workspace, or null for the member\'s role.');
  assert.equal(await refused('PUT', `/members/${f.member.user.id}/tool-group`, { groupId: 'bad id' }), 'Invalid groupId.');
  assert.equal(await refused('PUT', `/members/${f.member.user.id}/tool-group`, { groupId: 7 }), 'Invalid groupId.');
  const created = await body<ToolGroupSettings>(await f.admin.request('POST', `${f.path}/tool-groups`, { name: 'Releasers', tools: ['read_file', 'git', 'git_push', 'github_merge'] }), 201);
  const releasers = created.groups[0]!;
  assert.deepEqual([releasers.name, releasers.tools], ['Releasers', ['read_file', 'git', 'git_push', 'github_merge']]);
  await body(await f.owner.request('POST', `${f.path}/tool-groups`, { name: 'Releasers', tools: [] }), 409);

  await body(await f.admin.request('PUT', `${f.path}/members/${f.owner.user.id}/tool-group`, { groupId: releasers.id }), 403);
  await body(await f.admin.request('PUT', `${f.path}/members/${f.admin.user.id}/tool-group`, { groupId: releasers.id }), 403);
  await body(await f.admin.request('PUT', `${f.path}/members/${f.member.user.id}/tool-group`, { groupId: 'missing' }), 404);
  await body(await f.member.request('PUT', `${f.path}/members/${f.other.user.id}/tool-group`, { groupId: releasers.id }), 403);
  const assigned = await body<ToolGroupSettings>(await f.admin.request('PUT', `${f.path}/members/${f.member.user.id}/tool-group`, { groupId: releasers.id }));
  assert.equal(assigned.members.find(item => item.userId === f.member.user.id)!.groupId, releasers.id);
  await requireSessionTool(f.env, row(f.member.user.id), f.member.user.id, 'github_merge');
  await refusedTool(f.member.user.id, 'write_file');
  assert.deepEqual((await memberToolGroups(f.env, f.workspace.id))[f.member.user.id], { name: 'Releasers', off: toolsOff(['read_file', 'git', 'git_push', 'github_merge']) });

  const renamed = await body<ToolGroupSettings>(await f.owner.request('PATCH', `${f.path}/tool-groups/${releasers.id}`, { name: 'Shippers', tools: [...groupTools] }));
  assert.equal(renamed.groups[0]!.name, 'Shippers');
  assert.equal((await memberToolGroups(f.env, f.workspace.id))[f.member.user.id], undefined, 'a group with every tool leaves nothing out');
  await requireSessionTool(f.env, row(f.member.user.id), f.member.user.id, 'write_file');

  await body(await f.owner.request('PUT', `${f.path}/members/${f.member.user.id}/tool-group`, { groupId: null }));
  await refusedTool(f.member.user.id, 'git_push');
  await body(await f.owner.request('PUT', `${f.path}/members/${f.other.user.id}/tool-group`, { groupId: releasers.id }));
  const deleted = await body<ToolGroupSettings>(await f.admin.request('DELETE', `${f.path}/tool-groups/${releasers.id}`));
  assert.deepEqual([deleted.groups, deleted.members.find(item => item.userId === f.other.user.id)!.groupId], [[], null], 'its members go back to their role\'s tools');
  await body(await f.admin.request('DELETE', `${f.path}/tool-groups/${releasers.id}`), 404);
  await body(await f.admin.request('PATCH', `${f.path}/tool-groups/${releasers.id}`, { name: 'Late edit' }), 404);

  const again = (await body<ToolGroupSettings>(await f.owner.request('POST', `${f.path}/tool-groups`, { name: 'Again', tools: ['read_file'] }), 201)).groups[0]!;
  await body(await f.owner.request('PUT', `${f.path}/members/${f.other.user.id}/tool-group`, { groupId: again.id }));
  assert.ok((await f.owner.request('DELETE', `${f.path}/members/${f.other.user.id}`)).ok);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM workspace_member_tool_groups WHERE user_id = ?').get(f.other.user.id)!.n, 0, 'leaving the workspace leaves its group');
  const actions = f.sqlite.prepare("SELECT action FROM audit WHERE action LIKE 'workspace.%tool_group%' ORDER BY rowid").all().map(item => item.action);
  assert.deepEqual(actions, ['workspace.tool_group.created', 'workspace.member.tool_group', 'workspace.tool_group.updated', 'workspace.member.tool_group',
    'workspace.member.tool_group', 'workspace.tool_group.deleted', 'workspace.tool_group.created', 'workspace.member.tool_group']);
});
