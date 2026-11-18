import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { RunnerService } from '../apps/runner/src/server.js';
import { sha256 } from '../packages/shared/src/crypto.js';
import { toolNames, type AuthorizationRequest, type RunnerAction, type RunnerBinding, type RunnerTicket } from '../packages/shared/src/types.js';
import { cpuTime, parseSessionResources, resourceBytes, resourceLines, type SessionResourcesView } from '../packages/shared/src/session-resources.js';
import {
  cpuCredit, descendants, diskUsage, parseNvidiaApps, parseProcStat, parsePs, procTableReader, ProcessRoots, readCgroups, SessionResources,
  type ProcessInfo, type ProcessTable,
} from '../apps/runner/src/session-resources.js';

const MiB = 1024 * 1024;

async function temporary(t: test.TestContext, prefix: string): Promise<string> {
  const directory = await mkdtemp(join(await realpath(tmpdir()), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function info(pid: number, ppid: number, cpuSeconds: number, rssBytes = 0, childSeconds = 0): ProcessInfo {
  return { pid, ppid, start: String(pid * 10), cpuSeconds, childSeconds, rssBytes };
}

function table(...items: ProcessInfo[]): ProcessTable {
  return new Map(items.map(item => [item.pid, item]));
}

test('a /proc stat line gives its parent, CPU time and resident memory, whatever its command is called', () => {
  const fields = (utime: number, stime: number, cutime: number, cstime: number, start: number, rss: number) =>
    ['S', '41', '42', '42', '0', '-1', '4194304', '100', '0', '0', '0', String(utime), String(stime), String(cutime), String(cstime), '20', '0', '1', '0', String(start), '1000', String(rss)].join(' ');
  assert.deepEqual(parseProcStat(`42 (node) ${fields(150, 50, 300, 100, 777, 256)}`, 100, 4096),
    { pid: 42, ppid: 41, start: '777', cpuSeconds: 2, childSeconds: 4, rssBytes: 256 * 4096 });
  assert.equal(parseProcStat(`43 (a) (b c) ${fields(100, 0, 0, 0, 1, 1)}`, 100, 4096)?.cpuSeconds, 1);
  assert.equal(parseProcStat('44 (short) S 1 2', 100, 4096), undefined);
  assert.equal(parseProcStat('garbage', 100, 4096), undefined);
});

test('ps output gives every process with its CPU time in any of the forms ps prints', () => {
  const parsed = parsePs(' 1 0 1024 1-02:03:04.50\n 20 1 2048 03:04.25\n 21 20 10 0:00.10\nbad line\n');
  assert.deepEqual([...parsed.keys()], [1, 20, 21]);
  assert.equal(parsed.get(1)!.cpuSeconds, 86400 + 2 * 3600 + 3 * 60 + 4.5);
  assert.equal(parsed.get(20)!.cpuSeconds, 184.25);
  assert.equal(parsed.get(20)!.rssBytes, 2048 * 1024);
});

test('a session owns the processes below the ones it started, and nothing else', () => {
  const processes = table(info(1, 0, 0), info(10, 1, 1), info(11, 10, 2), info(12, 11, 3), info(20, 1, 4), info(21, 20, 5));
  assert.deepEqual(descendants(processes, [10]).map(item => item.pid).sort(), [10, 11, 12]);
  assert.deepEqual(descendants(processes, [10, 21, 99]).map(item => item.pid).sort(), [10, 11, 12, 21]);
  assert.deepEqual(descendants(processes, []), []);
});

test('CPU time counts each process once, whether it is still running or a process of the session reaped it', () => {
  let state = cpuCredit(new Map(), [info(10, 1, 1), info(11, 10, 2)]);
  assert.equal(state.credit, 3);
  state = cpuCredit(state.seen, [info(10, 1, 1.5, 0, 2.5)]);
  assert.equal(state.credit, 0.5 + 2.5 - 2);
  state = cpuCredit(state.seen, [info(10, 1, 1.5, 0, 6.5)]);
  assert.equal(state.credit, 4, 'a child that started and ended between samples still counts, through its parent');
  state = cpuCredit(state.seen, []);
  assert.equal(state.credit, 0, 'a process gone with no parent of the session left is never subtracted');
});

test('nvidia-smi compute apps give GPU memory by process', () => {
  assert.deepEqual([...parseNvidiaApps('101, 512\n102, 1024\n101, 512\nNo running processes found\n')], [[101, 1024 * MiB], [102, 1024 * MiB]]);
});

test('a fake /proc is read for each process, skipping ones that vanish or are not processes', async t => {
  const root = await temporary(t, 'proc-');
  const stat = (pid: number, ppid: number) => `${pid} (sh) S ${ppid} ${pid} ${pid} 0 -1 0 0 0 0 0 200 100 0 0 20 0 1 0 5 1000 10`;
  for (const [pid, ppid] of [[1, 0], [7, 1]]) {
    await mkdir(join(root, String(pid)));
    await writeFile(join(root, String(pid), 'stat'), stat(pid, ppid));
  }
  await mkdir(join(root, '9'));
  await mkdir(join(root, 'self'));
  const read = procTableReader(root, async (_file, args) => (args[0] === 'CLK_TCK' ? '100\n' : '4096\n'));
  const processes = (await read())!;
  assert.deepEqual([...processes.keys()].sort(), [1, 7]);
  assert.deepEqual(processes.get(7), { pid: 7, ppid: 1, start: '5', cpuSeconds: 3, childSeconds: 0, rssBytes: 10 * 4096 });
});

test('a session samples its processes for CPU, memory and GPU memory, and stops sampling once nothing runs', async () => {
  const roots = new ProcessRoots();
  let now = 1_000_000;
  let processes = table(info(1, 0, 0), info(10, 1, 0, 100 * MiB));
  let reads = 0;
  const resources = new SessionResources({
    roots, directory: '/nowhere', table: async () => { reads++; return processes; },
    gpu: async () => new Map([[11, 300 * MiB], [99, 5 * MiB]]), disk: async () => ({ bytes: 4096, partial: false }), now: () => now, sampleMs: 60_000,
  });
  const idle = await resources.view();
  assert.equal(idle.source, 'processes');
  assert.equal(idle.processes, 0);
  assert.equal(reads, 0, 'nothing running: no process table is read');
  const done = roots.add(10);
  processes = table(info(1, 0, 0), info(10, 1, 1, 100 * MiB), info(11, 10, 1, 50 * MiB));
  now += 60_000;
  const first = await resources.view();
  assert.equal(first.processes, 2);
  assert.equal(first.memoryBytes, 150 * MiB);
  assert.equal(first.gpuMemoryBytes, 300 * MiB);
  assert.equal(first.cpuSeconds, 2);
  assert.equal(first.diskBytes, 4096);
  now += 1000;
  assert.deepEqual(await resources.view(), first, 'a fresh sample is reused');
  processes = table(info(1, 0, 0), info(10, 1, 5, 20 * MiB, 1));
  now += 60_000;
  const second = await resources.view();
  assert.equal(second.cpuSeconds, 6);
  assert.equal(second.cpuCores, Math.round(4 / 61 * 100) / 100);
  assert.equal(second.memoryBytes, 20 * MiB);
  assert.equal(second.peakMemoryBytes, 150 * MiB);
  done();
  now += 60_000;
  const after = await resources.view();
  assert.equal(after.processes, 0);
  assert.equal(after.memoryBytes, 0);
  assert.equal(after.cpuSeconds, 6);
  assert.equal(after.cpuCores, 0);
  assert.equal(after.gpuMemoryBytes, undefined);
  resources.close();
});

test('a host that cannot list its processes says so rather than report nothing used', async () => {
  const roots = new ProcessRoots();
  roots.add(5);
  const resources = new SessionResources({ roots, directory: '/nowhere', table: async () => undefined, gpu: async () => undefined, disk: async () => ({ bytes: 1, partial: true }) });
  const view = await resources.view();
  assert.deepEqual({ source: view.source, processes: view.processes, cpu: view.cpuSeconds }, { source: 'unmeasured', processes: 1, cpu: undefined });
  resources.close();
});

test('with resource limits, a session reads its cgroups, counting CPU from when its host opened it', async t => {
  const root = await temporary(t, 'cgroups-');
  const commands = join(root, 'session-a');
  const services = join(root, 'session-b');
  await mkdir(commands);
  const write = async (directory: string, cpu: number, memory: number, pids: number) => {
    await writeFile(join(directory, 'cpu.stat'), `usage_usec ${cpu}\nuser_usec 1\nsystem_usec 1\n`);
    await writeFile(join(directory, 'memory.current'), `${memory}\n`);
    await writeFile(join(directory, 'pids.current'), `${pids}\n`);
  };
  await write(commands, 10_000_000, 1000, 0);
  assert.deepEqual(await readCgroups([commands, services]), { cpuSeconds: 10, memoryBytes: 1000, processes: 0 });
  let now = 5_000_000;
  const resources = new SessionResources({ roots: new ProcessRoots(), directory: root, groups: { directories: [commands, services], limits: { cpuCores: 2, memoryBytes: 4096 * MiB } },
    gpu: async () => undefined, disk: async () => ({ bytes: 0, partial: false }), now: () => now });
  await resources.view();
  await write(commands, 13_000_000, 200 * MiB, 3);
  await mkdir(services);
  await write(services, 1_000_000, 100 * MiB, 1);
  now += 10_000;
  const view = await resources.view();
  assert.equal(view.source, 'cgroup');
  assert.equal(view.cpuSeconds, 4);
  assert.equal(view.cpuCores, 0.4);
  assert.equal(view.memoryBytes, 300 * MiB);
  assert.equal(view.processes, 4);
  assert.deepEqual(view.limits, { cpuCores: 2, memoryBytes: 4096 * MiB });
  resources.close();
});

test('disk use adds up the session folder, and says when it stopped counting', async t => {
  const root = await temporary(t, 'disk-');
  await mkdir(join(root, 'a', 'b'), { recursive: true });
  await writeFile(join(root, 'a', 'one'), Buffer.alloc(64 * 1024));
  await writeFile(join(root, 'a', 'b', 'two'), Buffer.alloc(32 * 1024));
  const whole = await diskUsage(root);
  assert.equal(whole.partial, false);
  assert.ok(whole.bytes >= 96 * 1024, `${whole.bytes}`);
  const cut = await diskUsage(root, { maxEntries: 2 });
  assert.equal(cut.partial, true);
  assert.ok(cut.bytes < whole.bytes);
  assert.deepEqual(await diskUsage(join(root, 'missing')), { bytes: 0, partial: false });
});

test('the connector finds the processes its commands start on this machine', { skip: process.platform !== 'linux' }, async t => {
  const roots = new ProcessRoots();
  const child = spawn(process.execPath, ['-e', 'require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" }); setInterval(() => {}, 1000)'],
    { stdio: 'ignore', detached: true });
  t.after(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { } });
  const done = roots.add(child.pid);
  const resources = new SessionResources({ roots, directory: '/nowhere', gpu: async () => undefined, disk: async () => ({ bytes: 0, partial: false }), sampleMs: 1 });
  let view: SessionResourcesView | undefined;
  for (let attempt = 0; attempt < 50; attempt++) {
    view = await resources.view();
    if (view.processes >= 2) break;
    await delay(100);
  }
  assert.equal(view!.source, 'processes');
  assert.ok(view!.processes >= 2, `${view!.processes} processes`);
  assert.ok(view!.memoryBytes! > 10 * MiB, `${view!.memoryBytes} bytes`);
  done();
  resources.close();
});

function binding(id: string): RunnerBinding {
  return {
    session: { id, workspaceId: 'workspace', ownerId: 'test:alice', agentVersionId: 'version-1', title: 'Resources', policyVersion: 1, status: 'ready', createdAt: '2026-01-01T00:00:00Z', repositories: [], repositoryMode: 'clone' },
    owner: { id: 'test:alice', githubId: null, githubLogin: 'alice', displayName: 'Alice', gitName: 'Alice Owner', gitEmail: 'alice@example.test', env: {}, githubConnected: false },
    agent: { id: 'version-1', agentId: 'agent', authorId: 'test:alice', workspaceId: 'workspace', version: 1, name: 'Agent', description: '', instructions: 'Use tools.',
      tools: [...toolNames], modelId: 'model-1', createdAt: '2026-01-01T00:00:00Z' },
    model: { id: 'model-1', workspaceId: 'workspace', name: 'Model', provider: 'faux', modelId: 'faux-1' },
  };
}

async function ticket(id: string, action: RunnerAction): Promise<RunnerTicket> {
  const now = Math.floor(Date.now() / 1000);
  return { aud: 'runner', sessionId: id, actorId: 'test:alice', ownerId: 'test:alice', action, policyVersion: 1, iat: now, exp: now + 60, jti: randomUUID(), bodyHash: await sha256('') };
}

test('a session on the host shows the CPU and memory of the command it runs, and its CPU time and disk once it ended', { skip: process.platform !== 'linux' }, async t => {
  const directory = await temporary(t, 'pikibun-resources-');
  const faux = fauxProvider({ models: [{ id: 'faux-1' }] });
  const busy = 'const end = Date.now() + 2500; let x = 0; while (Date.now() < end) x++; console.log(x > 0)';
  faux.setResponses([fauxAssistantMessage([fauxToolCall('node', { program: 'node', args: ['-e', busy] })], { stopReason: 'toolUse' }), fauxAssistantMessage('Done.')] as never);
  const models = createModels();
  models.setProvider(faux.provider);
  const service = new RunnerService({
    dataDir: directory, sharedSecret: 'runner-resources-secret-not-a-production-secret', controlPlaneUrl: 'http://127.0.0.1:8787', allowFaux: true, unsandboxed: true,
    authorize: async (input: AuthorizationRequest) => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
  });
  await service.initialize();
  t.after(() => service.close());
  const id = 'resources-session';
  const session = await service.provision(binding(id), await ticket(id, 'create'));
  assert.equal((await session.view()).resources?.processes, 0);
  await session.submit(await ticket(id, 'submit'), { content: 'Work.', requestId: 'first', admissionId: await sha256('resources first') }, 'write');
  let running: SessionResourcesView | undefined;
  for (let attempt = 0; attempt < 200 && !running; attempt++) {
    const resources = (await session.view()).resources;
    if (resources && resources.processes > 0 && resources.memoryBytes! > 0) running = resources;
    else await delay(50);
  }
  assert.ok(running, 'the running command shows');
  assert.equal(running.source, 'processes');
  for (let count = 0; count < 1000 && (await session.view()).busy; count++) await delay(20);
  const after = (await session.view()).resources!;
  assert.equal(after.processes, 0);
  assert.ok(after.cpuSeconds! >= 1, `${after.cpuSeconds} s of CPU time`);
  assert.ok(after.peakMemoryBytes! > 10 * MiB, `${after.peakMemoryBytes} bytes at most`);
  assert.ok(after.diskBytes! > 0, `${after.diskBytes} bytes on disk`);
  assert.match((await session.view()).entries.map(entry => entry.text).join('\n'), /true/);
});

test('a resources view is accepted only in the shape the connector sends, and reads as lines', () => {
  const view: SessionResourcesView = { sampledAt: '2026-06-01T12:00:00.000Z', source: 'cgroup', processes: 3, cpuSeconds: 125, cpuCores: 1.5, memoryBytes: 512 * MiB,
    peakMemoryBytes: 1536 * MiB, limits: { cpuCores: 2, memoryBytes: 4096 * MiB }, diskBytes: 2.5 * 1024 * MiB, gpuMemoryBytes: 300 * MiB };
  assert.deepEqual(parseSessionResources(view), view);
  for (const bad of [{ ...view, secret: 1 }, { ...view, processes: -1 }, { ...view, cpuCores: Infinity }, { ...view, source: 'magic' }, { ...view, sampledAt: 'later' },
    { ...view, limits: { cpuCores: 1 } }, { ...view, diskPartial: false }, { ...view, memoryBytes: 1.5 }, null, []]) assert.equal(parseSessionResources(bad), undefined);
  assert.deepEqual(resourceLines(view).map(line => [line.key, line.title, line.hint]), [
    ['cpu', '1.5 CPUs in use of 2 CPUs it may use', '2.1 min of CPU time since the session opened on its host'],
    ['memory', '512 MB memory of 4 GB it may use', 'At most 1.5 GB since the session opened on its host'],
    ['processes', '3 processes running', 'Commands, servers and tools the session started on its host'],
    ['gpu', '300 MB GPU memory', "What its processes hold on the host's NVIDIA GPUs"],
    ['disk', '2.5 GB on disk', "The session's folder on the host: its files, clones and conversation"],
  ]);
  assert.deepEqual(resourceLines({ sampledAt: view.sampledAt, source: 'unmeasured', processes: 0, diskBytes: 10, diskPartial: true }).map(line => line.title),
    ['Nothing running', 'More than 10 B on disk']);
  assert.equal(resourceBytes(999 * 1024), '999 KB');
  assert.equal(resourceBytes(1000 * 1024), '1 MB');
  assert.equal(cpuTime(5.25), '5.3 s');
  assert.equal(cpuTime(7200), '2 h');
});
