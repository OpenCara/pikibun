import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createExtensionRuntime, createEventBus } from '@earendil-works/pi-coding-agent';
import { azureCliSpec } from '../apps/runner/src/extensions/piki/azure-cli.js';
import { spawnSync } from 'node:child_process';
import { apiWrites, cliEnvironment, commandWords, optionValues, sandboxDirectory, sandboxShellCommand, type CliRun, type PikiSandboxRun,
  type PikiSession } from '../apps/runner/src/extensions/piki/command.js';
import { ghSpec } from '../apps/runner/src/extensions/piki/gh.js';
import { glabSpec } from '../apps/runner/src/extensions/piki/glab.js';
import { connectorPikiExtensions } from '../apps/runner/src/extensions/piki/index.js';
import { SessionExtensions, type ExtensionHost } from '../apps/runner/src/extensions/adapter.js';
import { HostExtensions } from '../apps/runner/src/extensions/host.js';
import { loadInstalled, loadSource } from '../apps/runner/src/extensions/load.js';
import { ExtensionStore, parseExtensionSource } from '../apps/runner/src/extensions/store.js';
import { pikiExtension, pikiExtensions, pikiExtensionsFor } from '../packages/shared/src/piki-extensions.js';
import { extensionAvailability, extensionPackageKey, normalizeExtensionSource, parseHostExtensionsReport, parseWorkspaceExtensions,
  sessionExtensions } from '../packages/shared/src/host-extensions.js';

async function directory(t: TestContext): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'pikibun-cli-')));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('Pikibun extension sources parse as piki:<name>, are their own package, and are never installed or removed on a host', async t => {
  assert.equal(normalizeExtensionSource('piki:gh'), 'piki:gh');
  assert.equal(extensionPackageKey('piki:azure-cli'), 'piki:azure-cli');
  for (const bad of ['piki:', 'piki:GH', 'piki:gh@1.0.0', 'piki:../x']) assert.throws(() => normalizeExtensionSource(bad), /./, bad);
  // A name a newer connector may have still parses, so reports and lists that hold one are taken.
  assert.equal(normalizeExtensionSource('piki:some-future-cli'), 'piki:some-future-cli');
  assert.deepEqual(parseWorkspaceExtensions([{ source: 'piki:gh' }, { source: 'npm:a@1.0.0' }]).map(item => item.source), ['piki:gh', 'npm:a@1.0.0']);
  assert.deepEqual(parseHostExtensionsReport({ installed: [{ source: 'piki:gh', dev: false, modules: [] }], remoteInstalls: true }).installed[0]!.source, 'piki:gh');
  const installed = [{ source: 'piki:gh', dev: false, modules: [] }];
  assert.equal(extensionAvailability('piki:gh', installed).status, 'installed');
  assert.equal(extensionAvailability('piki:glab', installed).status, 'missing', 'a connector that predates it lacks it');
  assert.deepEqual(sessionExtensions(parseWorkspaceExtensions([{ source: 'piki:gh' }, { source: 'piki:glab' }]), installed, { ownerId: 'bob', connectorOwnerId: 'alice' })
    .map(item => item.source), ['piki:gh'], 'every member\'s sessions run it, not only the host owner\'s');

  assert.deepEqual(pikiExtensions.map(item => item.source), ['piki:gh', 'piki:glab', 'piki:azure-cli', 'piki:schedule', 'piki:host-shell', 'piki:shell', 'piki:git', 'piki:node', 'piki:python', 'piki:rust', 'piki:go', 'piki:dotnet', 'piki:make', 'piki:browser', 'piki:files', 'piki:github', 'piki:sources', 'piki:sessions', 'piki:prompt-audit']);
  assert.deepEqual(pikiExtensionsFor('github-enterprise').map(item => item.source), ['piki:gh']);
  assert.deepEqual(pikiExtensionsFor('azure-devops').map(item => item.tool), ['az']);
  assert.deepEqual(pikiExtensionsFor('bitbucket'), []);
  assert.equal(pikiExtension('piki:nope'), undefined);

  assert.throws(() => parseExtensionSource('piki:gh'), /built into the connector/);
  const root = await directory(t);
  const store = new ExtensionStore(join(root, 'extensions'), async () => { throw new Error('npm never runs'); });
  await assert.rejects(store.add({ kind: 'piki', name: 'gh' } as never), /come with the connector/);
  await assert.rejects(store.remove('piki:gh'), /can't be removed/);
  const host = new HostExtensions(store, { remoteInstalls: true });
  assert.deepEqual(await host.apply([{ id: 'r1', action: 'install', source: 'piki:gh' }]), [{ id: 'r1', ok: false,
    error: 'piki:gh is built into the connector: update the connector instead (npx pikibun@latest connect).' }]);
});

test('every connector has its Pikibun extensions: each command-line one offers one tool and its read-only setting; the prompt audit handles input', async t => {
  const root = await directory(t);
  const store = new ExtensionStore(join(root, 'extensions'));
  const loaded = await loadInstalled(store);
  assert.deepEqual(loaded.map(item => item.summary.source), ['piki:gh', 'piki:glab', 'piki:azure-cli', 'piki:schedule', 'piki:host-shell', 'piki:shell', 'piki:git', 'piki:node', 'piki:python', 'piki:rust', 'piki:go', 'piki:dotnet', 'piki:make', 'piki:browser', 'piki:files', 'piki:github', 'piki:sources', 'piki:sessions', 'piki:prompt-audit']);
  for (const item of loaded) {
    assert.equal(item.summary.error, undefined);
    const [module] = item.summary.modules;
    assert.equal(module!.error, undefined, item.summary.source);
    if (pikiExtension(item.summary.source)!.sessionTools) {
      // A session-tool extension registers nothing in Pi: its tools are the session's own, which it switches.
      assert.deepEqual([module!.tools, module!.events, module!.flags, module!.noops, module!.ignored], [[], [], [], [], []], item.summary.source);
      continue;
    }
    if (item.summary.source === 'piki:prompt-audit') {
      // No tool: it checks each message on Pi's input event, with its settings.
      assert.deepEqual([module!.tools, module!.events, module!.noops, module!.ignored], [[], ['input'], [], []]);
      assert.deepEqual(module!.flags.map(flag => [flag.name, flag.type, flag.default]), [['audit', 'string', 'others'], ['model', 'string', ''], ['policy', 'string', '']]);
      continue;
    }
    assert.deepEqual(module!.tools.map(tool => tool.name), [pikiExtension(item.summary.source)!.tool]);
    assert.deepEqual(module!.flags, [{ name: 'read-only', type: 'boolean', default: false, description: module!.flags[0]!.description }]);
    assert.deepEqual([module!.noops, module!.ignored, module!.events], [[], [], []]);
  }
  const host = new HostExtensions(store, { remoteInstalls: true });
  await host.load();
  assert.deepEqual(host.report().installed.map(item => item.source), ['piki:gh', 'piki:glab', 'piki:azure-cli', 'piki:schedule', 'piki:host-shell', 'piki:shell', 'piki:git', 'piki:node', 'piki:python', 'piki:rust', 'piki:go', 'piki:dotnet', 'piki:make', 'piki:browser', 'piki:files', 'piki:github', 'piki:sources', 'piki:sessions', 'piki:prompt-audit']);
  assert.deepEqual(host.reportWithoutPikiExtensions().installed, [], 'a control plane that predates them gets the report without them');
  // Nothing is installed in the store: the CLI's changes are compared with what is installed only.
  await host.refreshIfChanged();
  assert.equal(host.loaded.length, pikiExtensions.length);
  assert.equal(connectorPikiExtensions.length, pikiExtensions.length);
});

test('arguments are read as the commands take them', () => {
  assert.deepEqual(commandWords(['pr', 'view', '42', '--repo', 'acme/app']), ['pr', 'view', '42']);
  assert.deepEqual(optionValues(['api', '-X', 'post', '--method=PATCH', '--method', 'GET'], ['-X', '--method']), ['post', 'PATCH', 'GET']);
  assert.equal(apiWrites(['api', 'repos/acme/app/actions/runs']), undefined);
  assert.equal(apiWrites(['api', 'repos/acme/app/issues', '-X', 'GET', '-f', 'state=open']), undefined, 'GET with fields sends them as a query');
  assert.match(apiWrites(['api', 'repos/acme/app/issues', '-f', 'title=x'])!, /POST/, 'fields make it a POST');
  assert.match(apiWrites(['api', 'repos/acme/app', '--method', 'DELETE'])!, /DELETE/);
  assert.match(apiWrites(['api', 'repos/acme/app', '-XDELETE'])!, /apart/, 'no joined short options');
  assert.match(apiWrites(['api', 'repos/acme/app', '-iX', 'POST'])!, /apart/, 'no option clusters');
  assert.match(apiWrites(['api', 'repos/acme/app', '--input', 'body.json'])!, /body/);
  assert.match(apiWrites(['api', 'repos/acme/app', '-X', 'GET', '-F', 'q=@/etc/passwd'])!, /host file/);
  assert.match(apiWrites(['api', 'repos/acme/app', '-H', 'X-HTTP-Method-Override: DELETE'])!, /overrides/);
  assert.equal(apiWrites(['api', 'graphql', '-f', 'query=query { viewer { login } }']), undefined);
  assert.match(apiWrites(['api', 'graphql', '-f', 'query=mutation { addStar(input: {}) { clientMutationId } }'])!, /mutation/);
  assert.match(apiWrites(['api', 'graphql', '-X', 'GET', '-f', 'query={ viewer { login } }'])!, /POST/);
});

test('gh: commands that would show its token never run; read-only runs only commands that read', () => {
  assert.match(ghSpec.refused(['auth', 'token'])!, /token/);
  assert.match(ghSpec.refused(['auth', 'status', '--show-token'])!, /token/);
  assert.match(ghSpec.refused(['auth', 'status', '-t'])!, /token/);
  assert.match(ghSpec.refused(['config', 'get', 'oauth_token', '-h', 'github.com'])!, /token/);
  assert.equal(ghSpec.refused(['auth', 'status']), undefined);
  assert.equal(ghSpec.refused(['pr', 'create', '--title', 'x']), undefined, 'everything else runs, with approval');
  for (const reads of [['pr', 'checks', '42', '--repo', 'acme/app'], ['run', 'view', '1', '--log-failed', '-R', 'acme/app'], ['search', 'issues', 'flaky'],
    ['issue', 'list'], ['release', 'view', 'v1.0.0'], ['api', 'repos/acme/app/pulls'], ['--version'], ['auth', 'status'], ['help', 'pr']]) {
    assert.equal(ghSpec.writes(reads), undefined, reads.join(' '));
  }
  for (const writes of [['pr', 'merge', '42'], ['pr', 'create'], ['issue', 'comment', '1', '--body', 'x'], ['run', 'rerun', '1'], ['run', 'download', '1'],
    ['repo', 'delete', 'acme/app'], ['extension', 'install', 'x/y'], ['alias', 'set', 'x', 'y'], ['pr', 'view', '42', '--web'], ['pr'], ['-R', 'acme/app', 'pr', 'list'],
    ['api', 'repos/acme/app/pulls/1/merge', '-X', 'PUT'], ['issue', 'create', '--title', '--help']]) {
    assert.ok(ghSpec.writes(writes), writes.join(' '));
  }
});

test('glab and az: the same, with their own commands', () => {
  assert.match(glabSpec.refused(['auth', 'status', '--show-token'])!, /token/);
  assert.match(glabSpec.refused(['config', 'get', 'token', '--host', 'gitlab.com'])!, /token/);
  for (const reads of [['mr', 'list', '--repo', 'group/app'], ['ci', 'trace', '123'], ['ci', 'status'], ['api', 'projects/1/pipelines'], ['issue', 'view', '3']]) {
    assert.equal(glabSpec.writes(reads), undefined, reads.join(' '));
  }
  for (const writes of [['mr', 'merge', '1'], ['ci', 'run'], ['ci', 'view'], ['mr', 'view', '1', '-w'], ['api', 'projects/1', '-X', 'DELETE']]) {
    assert.ok(glabSpec.writes(writes), writes.join(' '));
  }

  assert.match(azureCliSpec.refused(['account', 'get-access-token', '--resource', 'x'])!, /token/);
  assert.match(azureCliSpec.refused(['acr', 'login', '--name', 'r', '--expose-token'])!, /token/);
  assert.match(azureCliSpec.refused(['repos', 'pr', 'list', '--debug'])!, /credentials/);
  for (const reads of [['repos', 'pr', 'list', '--organization', 'https://dev.azure.com/acme', '--project', 'App'], ['pipelines', 'runs', 'show', '--id', '7'],
    ['boards', 'query', '--wiql', 'SELECT [System.Id] FROM workitems'], ['account', 'show'], ['--version'], ['rest', '--url', 'https://management.azure.com/x'],
    ['rest', '--method', 'get', '--url', 'https://x'], ['devops', 'invoke', '--area', 'build', '--resource', 'logs', '--route-parameters', 'project=App', 'buildId=7'],
    ['webapp', 'list', '--output', 'json']]) {
    assert.equal(azureCliSpec.writes(reads), undefined, reads.join(' '));
  }
  for (const writes of [['repos', 'pr', 'create', '--title', 'x'], ['pipelines', 'run', '--name', 'ci'], ['storage', 'account', 'keys', 'list', '-n', 'a'],
    ['keyvault', 'secret', 'show', '--name', 's'], ['webapp', 'config', 'appsettings', 'list'], ['redis', 'list-keys'], ['rest', '--method', 'post', '--url', 'https://x'],
    ['rest', '--meth', 'delete', '--url', 'https://x'], ['rest', '-mPUT', '--url', 'https://x'], ['rest', '--url', 'https://x', '--body', '{}'],
    ['devops', 'invoke', '--area', 'x', '--http-method', 'PATCH'], ['repos', 'show', '--repository', '@/etc/passwd'], ['aks', 'get-credentials', '-n', 'c'],
    ['pipelines', 'runs', 'artifact', 'download', '--path', '.']]) {
    assert.ok(azureCliSpec.writes(writes), writes.join(' '));
  }
});

test('refusals hold wherever options sit, clustered, abbreviated or in another case (review of #154)', () => {
  for (const args of [['auth', 'status', '-at'], ['auth', 'status', '-ta'], ['auth', '--hostname', 'github.com', 'token'], ['auth', '-h', 'github.com', 'token'],
    ['auth', 'status', '--show-token=true'], ['config', '-h', 'github.com', 'get', 'oauth_token'], ['--repo', 'x', 'auth', 'token']]) {
    assert.ok(ghSpec.refused(args), `gh ${args.join(' ')}`);
  }
  for (const args of [['auth', 'status', '-at'], ['auth', '--hostname', 'gitlab.com', 'status', '-t'], ['config', '--host', 'gitlab.com', 'get', 'token']]) {
    assert.ok(glabSpec.refused(args), `glab ${args.join(' ')}`);
  }
  for (const args of [['account', '--subscription', 'X', 'get-access-token'], ['account', 'GET-ACCESS-TOKEN'],
    ['account', 'get'], ['account', 'GET'], ['account', 'get-a'], ['account', 'get-access-t'], ['acc', 'get'], ['ac', 'g', '-o', 'json'], ['account', 'ge'], ['acr', 'login', '-n', 'r', '--EXPOSE-TOKEN'],
    ['acr', 'login', '-n', 'r', '--expose'], ['repos', 'list', '--deb'], ['repos', 'list', '--DEBUG']]) {
    assert.ok(azureCliSpec.refused(args), `az ${args.join(' ')}`);
  }
  assert.equal(ghSpec.refused(['auth', 'status', '-h', 'github.com']), undefined);
  assert.equal(azureCliSpec.refused(['repos', 'pr', 'list', '--detect', 'true']), undefined);
  for (const args of [['account', 'show'], ['account', 'list'], ['devops', 'invoke', '--area', 'build', '--http-method', 'GET'], ['acr', 'show', '-n', 'registry']]) {
    assert.equal(azureCliSpec.refused(args), undefined, `az ${args.join(' ')}`);
  }
  // gh keeps the last of repeated fields: a second query is refused, not left unchecked.
  assert.match(apiWrites(['api', 'graphql', '-f', 'query=query { viewer { login } }', '-f', 'query=mutation { addStar(input: {}) { clientMutationId } }'])!, /exactly one query/);
  assert.match(apiWrites(['api', 'graphql', '-f', 'owner=acme'])!, /exactly one query/);
  for (const args of [['pipelines', 'runs', 'artifact', 'list', '--output-f', 'x'], ['repos', 'list', '--fil', 'x'], ['repos', 'list', '--pat=x'], ['REPOS', 'PR', 'CREATE']]) {
    assert.ok(azureCliSpec.writes(args), `az ${args.join(' ')}`);
  }
  assert.equal(azureCliSpec.writes(['repos', 'list', '--output', 'json']), undefined, '--output is not --output-file');
  assert.equal(azureCliSpec.writes(['Repos', 'PR', 'List']), undefined);
});

test('a host\'s report holds its Pikibun extensions besides as many installed ones as it may have', () => {
  const installed = Array.from({ length: 64 }, (_, index) => ({ source: `npm:extension-${index}@1.0.0`, dev: false, modules: [] }));
  const report = parseHostExtensionsReport({ installed: [...connectorPikiExtensions.map(item => ({ source: item.info.source, dev: false, modules: [] })), ...installed], remoteInstalls: true });
  assert.equal(report.installed.length, 64 + connectorPikiExtensions.length);
});

test('the command gets its own sign-in and the host\'s tools from the connector\'s environment, never the connector\'s other secrets', () => {
  const env = cliEnvironment(ghSpec, { PATH: '/opt/bin:/usr/bin', HOME: '/home/alice', GH_TOKEN: 'gh-secret', HTTPS_PROXY: 'http://proxy:3128',
    PIKIBUN_CONNECTOR_TOKEN: 'never', OPENAI_API_KEY: 'never', AZURE_CONFIG_DIR: '/x' });
  assert.equal(env.GH_TOKEN, 'gh-secret');
  assert.equal(env.HTTPS_PROXY, 'http://proxy:3128');
  assert.equal(env.PATH, '/opt/bin:/usr/bin');
  assert.equal(env.GH_PROMPT_DISABLED, '1');
  for (const name of ['PIKIBUN_CONNECTOR_TOKEN', 'OPENAI_API_KEY', 'AZURE_CONFIG_DIR']) assert.equal(env[name], undefined, name);
  assert.equal(cliEnvironment(azureCliSpec, { AZURE_CONFIG_DIR: '/x', AZURE_DEVOPS_EXT_PAT: 'pat', GH_TOKEN: 'no' }).AZURE_DEVOPS_EXT_PAT, 'pat');
  assert.equal(cliEnvironment(azureCliSpec, { GH_TOKEN: 'no' }).GH_TOKEN, undefined);
});

/**
 * The gh tool of a session in `worktree`, with a fake gh first on PATH, and the read-only setting as given; by default as
 * a session that may use the host's sign-in runs it.
 */
async function ghTool(t: TestContext, readOnly = false, session: PikiSession = { hostSignIn: true }) {
  const root = await directory(t);
  const bin = join(root, 'bin');
  await mkdir(bin);
  // Prints where it ran, its arguments and a variable it must get; exits with $GH_FAKE_EXIT, or as `fail` asks.
  await writeFile(join(bin, 'gh'), `#!/bin/sh\necho "cwd=$(pwd)"\nfor arg in "$@"; do echo "arg=$arg"; done\necho "prompt=$GH_PROMPT_DISABLED secret=$PIKIBUN_TEST_SECRET"\n` +
    `[ "$1" = fail ] && { echo "boom" >&2; exit 3; }\n[ "$1" = big ] && head -c 300000 /dev/zero | tr '\\0' x\nexit 0\n`);
  await chmod(join(bin, 'gh'), 0o755);
  const worktree = join(root, 'worktree');
  await mkdir(join(worktree, 'app'), { recursive: true });
  await symlink(root, join(worktree, 'escape'));
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  process.env.PIKIBUN_TEST_SECRET = 'leaked';
  t.after(() => { process.env.PATH = path; delete process.env.PIKIBUN_TEST_SECRET; });
  const extension = connectorPikiExtensions.find(item => item.info.name === 'gh')!;
  const runtime = createExtensionRuntime();
  const result = await loadSource({ files: ['<piki:gh>'], factories: [{ path: '<piki:gh>', factory: extension.forSession(session) }] }, worktree, createEventBus(), runtime);
  if (readOnly) runtime.flagValues.set('read-only', true);
  const tool = result.extensions[0]!.tools.get('gh')!.definition;
  const call = (params: Record<string, unknown>) => tool.execute('call', params as never, new AbortController().signal, undefined, { cwd: worktree } as never)
    .then(output => (output.content[0] as { text: string }).text);
  return { call, worktree, root };
}

test('the gh tool runs gh in the worktree, or a directory in it, and returns its output; failures and refusals say why', async t => {
  const { call, worktree } = await ghTool(t);
  const text = await call({ args: ['pr', 'view', '42 with spaces', '--repo', 'acme/app'] });
  assert.match(text, new RegExp(`cwd=${worktree}\\n`));
  assert.match(text, /arg=pr\narg=view\narg=42 with spaces\narg=--repo\narg=acme\/app\n/, 'arguments pass as they are, without a shell');
  assert.match(text, /prompt=1 secret=$/m, 'no prompts, and none of the connector\'s other variables');
  assert.match(await call({ args: ['status'], directory: 'app' }), new RegExp(`cwd=${worktree}/app\\n`));
  await assert.rejects(call({ args: ['status'], directory: 'escape' }), /outside the session's worktree/);
  await assert.rejects(call({ args: ['status'], directory: '../' }), /outside the session's worktree/);
  await assert.rejects(call({ args: ['status'], directory: '/etc' }), /within the session's worktree/);
  await assert.rejects(call({ args: ['fail'] }), /exited with 3\.\n[\s\S]*boom/);
  await assert.rejects(call({ args: ['auth', 'token'] }), /Refused: gh auth token would show its token\. Nothing ran\./);
  const big = await call({ args: ['big'] });
  assert.ok(big.length < 140 * 1024, 'long output keeps its start and end');
  assert.match(big, /bytes left out/);
  assert.match(await call({ args: ['pr', 'merge', '1'] }), /arg=merge/, 'without read-only, anything runs (each call approved as the workspace sets)');
});

test('read-only: only commands that read run, and outside the worktree', async t => {
  const { call, worktree } = await ghTool(t, true);
  const text = await call({ args: ['run', 'view', '7', '--log-failed', '--repo', 'acme/app'] });
  assert.doesNotMatch(text, new RegExp(`cwd=${worktree}`));
  assert.match(text, /cwd=.*pikibun-gh-/);
  await assert.rejects(call({ args: ['pr', 'merge', '1'] }), /read-only, and gh pr merge is not a command that only reads\. Nothing ran\./);
  await assert.rejects(call({ args: ['pr', 'list'], directory: 'app' }), /leave out directory/);
});

test('a missing command says how its host\'s owner gets it', async t => {
  const { call } = await ghTool(t);
  process.env.PATH = '/nonexistent';
  await assert.rejects(call({ args: ['status'] }), /gh isn't installed on this host, or isn't on its PATH\. Its owner installs it \(https:\/\/cli\.github\.com\) and signs in with gh auth login\./);
});

test('a session runs a Pikibun extension like any other: its tool, behind the session\'s gate, with the workspace\'s settings', async t => {
  const { worktree } = await ghTool(t);
  const loaded = await loadInstalled(new ExtensionStore(join(worktree, '..', 'state')));
  const gated: string[] = [];
  const host: ExtensionHost = {
    directory: worktree, model: () => undefined, hookTimeoutMs: 2000, warn: (_source, message) => assert.fail(message), piki: { hostSignIn: true },
    state: async source => ({ active: source === 'piki:gh', settings: { 'read-only': true } }),
    runTool: async (call, execute) => { gated.push(`${call.source} ${call.tool} ${JSON.stringify(call.arguments)}`); return execute(call.signal); },
  };
  const extensions = new SessionExtensions(host, ['bash']);
  await extensions.ensure(loaded);
  t.after(() => extensions.shutdown());
  const { selected } = extensions.select(['piki:gh']);
  assert.deepEqual(selected.map(item => [item.source, item.tools.map(tool => tool.name)]), [['piki:gh', ['gh']]]);
  const tool = selected[0]!.tools[0]! as unknown as { execute(args: unknown, api: unknown, call: unknown): Promise<{ output: { text: string }[] }> };
  const result = await tool.execute({ args: ['pr', 'list', '--repo', 'acme/app'] }, { callId: 'call-1' }, { abortSignal: new AbortController().signal });
  assert.match(result.output[0]!.text, /arg=list/);
  assert.doesNotMatch(result.output[0]!.text, new RegExp(`cwd=${worktree}`), 'the workspace\'s read-only setting applies');
  await assert.rejects(tool.execute({ args: ['pr', 'merge', '1'] }, { callId: 'call-2' }, { abortSignal: new AbortController().signal }), /read-only/);
  assert.deepEqual(gated, ['piki:gh gh {"args":["pr","list","--repo","acme/app"]}', 'piki:gh gh {"args":["pr","merge","1"]}'], 'each call goes through the session\'s gate');
});

test('in the sandbox: the command runs as the session owner, through the session, which says how it ends', async t => {
  const runs: PikiSandboxRun[] = [];
  let answer: CliRun = { exitCode: 0, signal: null, output: 'ran\n' };
  const { call } = await ghTool(t, false, { hostSignIn: false, sandbox: async run => { runs.push(run); return answer; } });
  assert.equal(await call({ args: ['pr', 'create', '--fill'], directory: './app/' }), 'ran');
  assert.equal(runs.length, 1);
  const [run] = runs;
  assert.deepEqual([run!.callId, run!.command, run!.args, run!.directory, run!.readOnly, run!.timeoutSeconds], ['call', 'gh', ['pr', 'create', '--fill'], 'app', false, 300]);
  assert.deepEqual(run!.tokenEnv, ['GH_TOKEN', 'GITHUB_TOKEN'], 'the variables an approved call\'s write lease replaces');
  assert.equal(run!.env.GH_PROMPT_DISABLED, '1');
  assert.equal(run!.env.PIKIBUN_TEST_SECRET, undefined, 'none of the connector\'s variables');
  await assert.rejects(call({ args: ['status'], directory: '../elsewhere' }), /within the session's worktree/);
  await assert.rejects(call({ args: ['auth', 'token'] }), /Refused: gh auth token would show its token/);
  answer = { exitCode: 1, signal: null, output: 'HTTP 403: writes run only in an approved call' };
  await assert.rejects(call({ args: ['pr', 'merge', '1'] }), /It exited with 1\.\nHTTP 403/);
  answer = { exitCode: 127, signal: null, output: 'bash: line 1: exec: gh: not found' };
  await assert.rejects(call({ args: ['status'] }), /gh isn't installed where the session's sandbox finds it .*https:\/\/cli\.github\.com/);
  assert.equal(runs.length, 3, 'refusals never reach the sandbox');
});

test('in the sandbox, read-only: only commands that read, in the worktree mounted read-only', async t => {
  const runs: PikiSandboxRun[] = [];
  const { call } = await ghTool(t, true, { hostSignIn: false, sandbox: async run => { runs.push(run); return { exitCode: 0, signal: null, output: 'ok' }; } });
  await call({ args: ['pr', 'list'], directory: 'app' });
  assert.deepEqual([runs[0]!.readOnly, runs[0]!.directory], [true, 'app']);
  await assert.rejects(call({ args: ['pr', 'merge', '1'] }), /read-only, and gh pr merge is not a command that only reads/);
  assert.equal(runs.length, 1);
});

test('a session with neither a sandbox nor the host\'s sign-in doesn\'t run the command, and says why', async t => {
  const { call } = await ghTool(t, false, { hostSignIn: false });
  await assert.rejects(call({ args: ['status'] }), /gh can't run in this session: it runs in a session's sandbox, as the session owner/);
  // The connector's own copy, which only reports what the extension offers, is such a session.
  const extension = connectorPikiExtensions.find(item => item.info.name === 'gh')!;
  const runtime = createExtensionRuntime();
  const result = await loadSource({ files: ['<piki:gh>'], factories: [{ path: '<piki:gh>', factory: extension.factory }] }, tmpdir(), createEventBus(), runtime);
  const tool = result.extensions[0]!.tools.get('gh')!.definition;
  await assert.rejects(tool.execute('call', { args: ['status'] } as never, new AbortController().signal, undefined, { cwd: tmpdir() } as never), /can't run in this session/);
});

test('a session opens its Pikibun extensions as it runs them: in its sandbox', async t => {
  const { worktree } = await ghTool(t);
  const loaded = await loadInstalled(new ExtensionStore(join(worktree, '..', 'state')));
  const runs: PikiSandboxRun[] = [];
  const host: ExtensionHost = {
    directory: worktree, model: () => undefined, hookTimeoutMs: 2000, warn: (_source, message) => assert.fail(message),
    piki: { hostSignIn: false, sandbox: async run => { runs.push(run); return { exitCode: 0, signal: null, output: 'from the sandbox' }; } },
    state: async source => ({ active: source === 'piki:gh', settings: {} }),
    runTool: async (call, execute) => execute(call.signal),
  };
  const extensions = new SessionExtensions(host, ['bash']);
  await extensions.ensure(loaded);
  t.after(() => extensions.shutdown());
  const tool = extensions.select(['piki:gh']).selected[0]!.tools[0]! as unknown as { execute(args: unknown, api: unknown, call: unknown): Promise<{ output: { text: string }[] }> };
  const result = await tool.execute({ args: ['run', 'list'] }, { callId: 'call-7' }, { abortSignal: new AbortController().signal });
  assert.equal(result.output[0]!.text, 'from the sandbox');
  assert.deepEqual(runs.map(run => [run.callId, run.args]), [['call-7', ['run', 'list']]]);
});

test('the sandbox\'s shell command passes arguments and variables as they are, in the directory asked for', async t => {
  if (spawnSync('bash', ['-c', 'true']).status !== 0) return t.diagnostic('bash is not installed');
  const root = await directory(t);
  const bin = join(root, 'bin');
  await mkdir(bin);
  await mkdir(join(root, 'app'));
  // Named so that no real command, on the PATH or in /usr/local/bin, stands in for it.
  await writeFile(join(bin, 'pikibun-fake-gh'), '#!/bin/sh\necho "cwd=$(pwd)"\nfor arg in "$@"; do echo "arg=$arg"; done\necho "token=$GH_TOKEN"\necho oops >&2\n');
  await chmod(join(bin, 'pikibun-fake-gh'), 0o755);
  const args = ["it's", '$HOME', '`id`', 'a b', '; rm -rf /', '"quoted"'];
  const command = sandboxShellCommand('pikibun-fake-gh', args, { GH_TOKEN: "x'y $z" }, 'app');
  const run = spawnSync('bash', ['-c', command], { cwd: root, encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin` } });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, `cwd=${root}/app\n${args.map(arg => `arg=${arg}\n`).join('')}token=x'y $z\noops\n`, 'its errors come with its output');
  assert.throws(() => sandboxShellCommand('gh', [], { 'BAD NAME': 'x' }), /Invalid variable name/);
  // A directory named like one of cd's own arguments is still that directory; /usr/local/bin is searched last, after the
  // sandbox's own PATH, whose first entry may be its git shim (review of #158).
  await mkdir(join(root, '-'));
  await writeFile(join(bin, 'pikibun-fake-where'), '#!/bin/sh\necho "cwd=$(pwd) path=$PATH"\n');
  await chmod(join(bin, 'pikibun-fake-where'), 0o755);
  const dash = spawnSync('bash', ['-c', sandboxShellCommand('pikibun-fake-where', [], {}, '-')], { cwd: root, encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, OLDPWD: '/' } });
  assert.equal(dash.stdout, `cwd=${root}/- path=${bin}:/usr/bin:/bin:/usr/local/bin\n`);
  assert.equal(sandboxDirectory('./app//src/'), 'app/src');
  assert.equal(sandboxDirectory('.'), '.');
  for (const bad of ['/etc', '../x', 'a/../../b', 'C:\\x']) assert.throws(() => sandboxDirectory(bad), /within the session's worktree/, bad);
});

const migrations = new URL('../apps/server/migrations/sqlite/', import.meta.url);
const pikiMigration = '0048_piki_extensions.sql';

test('the migration gives workspaces that already have a repository on a forge its tool\'s extension, once', () => {
  const files = readdirSync(migrations).filter(name => name.endsWith('.sql')).sort();
  assert.ok(files.includes(pikiMigration));
  assert.ok(readdirSync(new URL('../apps/server/migrations/postgres/', import.meta.url)).includes('0041_piki_extensions.sql'), 'Postgres has the same migration');
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const file of files.filter(name => name < pikiMigration)) sqlite.exec(readFileSync(new URL(file, migrations), 'utf8'));
  sqlite.exec(`INSERT INTO users (id, display_name, git_name, git_email, auth_kind, created_at) VALUES ('owner', 'Owner', 'Owner', 'owner@example.test', 'test', '2026-01-01');
    INSERT INTO workspaces (id, name, owner_id, created_at) VALUES ('hub', 'Hub', 'owner', '2026-01-01'), ('lab', 'Lab', 'owner', '2026-01-01'),
      ('mixed', 'Mixed', 'owner', '2026-01-01'), ('plain', 'Plain', 'owner', '2026-01-01'), ('removed', 'Removed', 'owner', '2026-01-01');
    INSERT INTO workspace_extensions (workspace_id, package_key, source, position, enabled, tools_mode, settings_json, updated_by, updated_at)
      VALUES ('hub', 'npm:pi-memory', 'npm:pi-memory@1.0.0', 1, 1, 'approval', '{}', 'owner', '2026-01-02'),
        ('removed', 'piki:gh', 'piki:gh', 1, 0, 'approval', '{}', 'owner', '2026-01-02');`);
  const repository = sqlite.prepare(`INSERT INTO workspace_repositories (id, workspace_id, provider, host, repository_id, full_name, ref, private, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'main', 0, '2026-01-03')`);
  repository.run('r1', 'hub', 'github', 'github.com', '1', 'acme/one');
  repository.run('r2', 'hub', 'github', 'github.com', '2', 'acme/two');
  repository.run('r3', 'lab', 'gitlab', 'gitlab.com', '3', 'acme/three');
  repository.run('r4', 'mixed', 'github-enterprise', 'git.acme.test', '4', 'acme/four');
  repository.run('r5', 'mixed', 'azure-devops', 'dev.azure.com', '5', 'acme/App/five');
  repository.run('r6', 'plain', 'bitbucket', 'bitbucket.org', '6', 'acme/six');
  repository.run('r7', 'removed', 'github', 'github.com', '7', 'acme/seven');
  sqlite.exec(`INSERT INTO connectors (id, owner_id, name, credential_hash, created_at, models_json, capabilities_json) VALUES ('host', 'owner', 'Host', 'hash', '2026-01-01', '[]', '{}');
    INSERT INTO connector_configs (connector_id, builtin_extensions_json, updated_by, updated_at) VALUES ('host', '["codemode"]', 'owner', '2026-01-01');`);
  sqlite.exec(readFileSync(new URL(pikiMigration, migrations), 'utf8'));
  assert.equal(sqlite.prepare("SELECT builtin_extensions_json FROM connector_configs").get()!.builtin_extensions_json, '["pi:codemode"]', 'Pi\'s built-ins are named pi:<name>');
  const rows = sqlite.prepare('SELECT workspace_id, source, position, enabled, tools_mode, updated_by FROM workspace_extensions ORDER BY workspace_id, position').all()
    .map(row => [row.workspace_id, row.source, row.position, row.enabled, row.tools_mode, row.updated_by]);
  assert.deepEqual(rows, [
    ['hub', 'npm:pi-memory@1.0.0', 1, 1, 'approval', 'owner'], ['hub', 'piki:gh', 2, 1, 'approval', 'owner'],
    ['lab', 'piki:glab', 1, 1, 'approval', 'owner'],
    ['mixed', 'piki:gh', 1, 1, 'approval', 'owner'], ['mixed', 'piki:azure-cli', 2, 1, 'approval', 'owner'],
    ['removed', 'piki:gh', 1, 0, 'approval', 'owner'],
  ], 'one each, after what they had; a workspace that turned it off keeps it off');
  const updated = sqlite.prepare("SELECT updated_at FROM workspace_extensions WHERE workspace_id = 'lab'").get()!.updated_at as string;
  assert.match(updated, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
});
