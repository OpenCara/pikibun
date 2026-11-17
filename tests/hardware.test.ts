import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  hardwareFresh, hardwareSummary, loadScore, modelPatternMatches, parseHardware, parsePlacement, placementTarget, readReportedHardware, unmetConditions,
  type HostHardware,
} from '../packages/shared/src/hardware.js';
import { HardwareProbe, parseNvidiaSmi, parseSystemProfiler, probeGpus, sysfsGpus } from '../apps/runner/src/hardware.js';
import { placementRequest } from '../apps/runner/src/session/tools/sessions.js';

const GiB = 1024 ** 3;
const machine: HostHardware = { platform: 'linux', release: '6.8.0-45-generic', arch: 'x64', cpuModel: 'AMD Ryzen 9 7950X', cpus: 32, memoryBytes: 64 * GiB,
  freeMemoryBytes: 48 * GiB, diskBytes: 1000 * GiB, freeDiskBytes: 400 * GiB, load: [4, 3, 2], gpus: [{ vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4090', memoryBytes: 24 * GiB }] };

test('a hardware report is accepted only as the bounded shape the connector sends', () => {
  assert.deepEqual(parseHardware(machine), machine);
  assert.deepEqual(parseHardware({ ...machine, wsl: true }).wsl, true);
  const { diskBytes: _disk, freeDiskBytes: _free, load: _load, ...minimal } = machine;
  assert.deepEqual(parseHardware({ ...minimal, gpus: [] }), { ...minimal, gpus: [] });
  for (const [what, value] of [
    ['unknown field', { ...machine, token: 'x' }], ['platform syntax', { ...machine, platform: 'linux os' }], ['control characters', { ...machine, cpuModel: 'a\nb' }],
    ['long text', { ...machine, release: 'r'.repeat(121) }], ['no CPUs', { ...machine, cpus: 0 }], ['fractional CPUs', { ...machine, cpus: 1.5 }],
    ['negative memory', { ...machine, memoryBytes: -1 }], ['more free than total', { ...machine, freeMemoryBytes: 65 * GiB }],
    ['disk without free disk', { ...minimal, gpus: [], diskBytes: 1 }], ['free disk over total', { ...machine, freeDiskBytes: 1001 * GiB }],
    ['short load', { ...machine, load: [1, 2] }], ['infinite load', { ...machine, load: [1, 2, Infinity] }], ['unknown vendor', { ...machine, gpus: [{ vendor: 'voodoo' }] }],
    ['GPU secret', { ...machine, gpus: [{ vendor: 'nvidia', serial: 'x' }] }], ['too many GPUs', { ...machine, gpus: Array.from({ length: 17 }, () => ({ vendor: 'amd' })) }],
    ['wsl false', { ...machine, wsl: false }], ['not an object', []],
  ] as const) assert.throws(() => parseHardware(value), /Invalid hardware/, what);
  assert.equal(readReportedHardware('{"bad":1}', '2026-01-01T00:00:00.000Z'), undefined);
  assert.equal(readReportedHardware(JSON.stringify(machine), null), undefined);
  assert.equal(readReportedHardware(JSON.stringify(machine), '2026-01-01T00:00:00.000Z')?.reportedAt, '2026-01-01T00:00:00.000Z');
});

test('a summary names the machine, and its free memory only while the report is fresh', () => {
  const at = Date.parse('2026-06-01T12:00:00.000Z');
  const reported = { ...machine, reportedAt: new Date(at).toISOString() };
  assert.equal(hardwareSummary(reported, at + 60_000),
    'Linux 6.8.0-45-generic x64 · 32 CPUs (AMD Ryzen 9 7950X) · 64 GB memory, 48 GB free · 400 GB free disk · NVIDIA GeForce RTX 4090 (24 GB)');
  assert.equal(hardwareFresh(reported, at + 16 * 60_000), false);
  assert.match(hardwareSummary(reported, at + 16 * 60_000), /· 64 GB memory · /);
  const { diskBytes: _disk, freeDiskBytes: _free, ...diskless } = machine;
  assert.equal(hardwareSummary({ ...diskless, platform: 'darwin', cpus: 1, gpus: [] }),
    'macOS 6.8.0-45-generic x64 · 1 CPU (AMD Ryzen 9 7950X) · 64 GB memory, 48 GB free · no GPU found');
});

test('placement conditions are parsed strictly and shown as the agent wrote them', () => {
  assert.deepEqual(parsePlacement({}), {});
  const placement = parsePlacement({ hosts: ['a', 'a', 'b'], models: ['anthropic/*'], gpu: true, gpuVendor: 'nvidia', gpuMemoryGb: 16, minCpus: 8, minMemoryGb: 32,
    minFreeMemoryGb: 8, minFreeDiskGb: 20, platform: 'linux', arch: 'x64' });
  assert.deepEqual(placement.hosts, ['a', 'b']);
  assert.equal(placementTarget(placement), 'hosts a,b, models anthropic/*, gpu true, gpu_vendor nvidia, gpu_memory_gb 16, min_cpus 8, min_memory_gb 32, min_free_memory_gb 8, min_free_disk_gb 20, platform linux, arch x64');
  assert.equal(placementTarget({}), 'any host');
  for (const value of [[], { colour: 'red' }, { hosts: [] }, { models: ['a\nb'] }, { gpu: 'yes' }, { gpuVendor: 'voodoo' }, { minCpus: -1 }, { minMemoryGb: Infinity },
    { platform: 'linux; rm' }, { gpu: false, gpuVendor: 'nvidia' }, { models: Array.from({ length: 21 }, (_, i) => `m${i}`) }]) {
    assert.throws(() => parsePlacement(value), /placement/, JSON.stringify(value));
  }
  assert.deepEqual(placementRequest({ gpu: true, gpu_vendor: 'amd', min_memory_gb: 8, min_free_disk_gb: undefined }), { gpu: true, gpuVendor: 'amd', minMemoryGb: 8 });
  assert.equal(placementRequest(undefined), undefined);
  assert.throws(() => placementRequest({ ram: 8 }), /placement takes no ram/);
});

test('model patterns match a model id, provider/model exactly, or a glob over provider/model', () => {
  const model = { id: 'row-1', provider: 'anthropic', modelId: 'claude-sonnet-5' };
  assert.equal(modelPatternMatches('row-1', model), true);
  assert.equal(modelPatternMatches('anthropic/claude-sonnet-5', model), true);
  assert.equal(modelPatternMatches('anthropic/claude', model), false);
  assert.equal(modelPatternMatches('anthropic/*', model), true);
  assert.equal(modelPatternMatches('*/claude-sonnet-?', model), true);
  assert.equal(modelPatternMatches('openai/*', model), false);
  assert.equal(modelPatternMatches('anthropic/claude.sonnet-5*', model), false, 'a dot is a dot');
});

test('a host meets the conditions its hardware and GPU setting meet, and its load counts sessions, CPU and memory', () => {
  const now = Date.parse('2026-06-01T12:00:00.000Z');
  const host = { id: 'h', gpuUsable: true, hardware: { ...machine, reportedAt: new Date(now).toISOString() } };
  assert.deepEqual(unmetConditions(host, { gpu: true, gpuVendor: 'nvidia', gpuMemoryGb: 24, minCpus: 32, minMemoryGb: 64, minFreeMemoryGb: 48, minFreeDiskGb: 400, platform: 'Linux', arch: 'x64' }, now), []);
  assert.deepEqual(unmetConditions(host, { gpu: false, gpuVendor: 'amd', gpuMemoryGb: 25, minCpus: 33, minMemoryGb: 65, minFreeMemoryGb: 49, minFreeDiskGb: 401, platform: 'darwin', arch: 'arm64' }, now),
    ['gpu', 'gpuVendor', 'gpuMemoryGb', 'minCpus', 'minMemoryGb', 'minFreeMemoryGb', 'minFreeDiskGb', 'platform', 'arch']);
  assert.deepEqual(unmetConditions({ ...host, gpuUsable: false }, { gpu: true, gpuVendor: 'nvidia' }, now), ['gpu', 'gpuVendor'], 'a GPU sandboxed sessions can\'t reach doesn\'t count');
  assert.deepEqual(unmetConditions(host, { minFreeMemoryGb: 1, minMemoryGb: 1 }, now + 20 * 60_000), ['minFreeMemoryGb'], 'free memory is only trusted while fresh');
  assert.deepEqual(unmetConditions({ id: 'unknown', gpuUsable: false }, {}, now), []);
  assert.deepEqual(unmetConditions({ id: 'unknown', gpuUsable: false }, { minCpus: 1, platform: 'linux' }, now), ['minCpus', 'platform']);
  assert.equal(loadScore(host, 2, now), 2 + 4 / 32 + 0.25);
  assert.equal(loadScore(host, 0, now + 20 * 60_000), 1, 'a stale report counts as half busy');
  assert.equal(loadScore({}, 1, now), 2);
});

test('the connector reads GPUs from sysfs, nvidia-smi and system_profiler, best effort', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'hardware-probe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const device = async (name: string, files: Record<string, string>) => {
    const path = join(root, 'sys/devices/pci0000:00', name);
    await mkdir(path, { recursive: true });
    for (const [file, text] of Object.entries(files)) await writeFile(join(path, file), text);
    return path;
  };
  await mkdir(join(root, 'sys/class/drm'), { recursive: true });
  const amd = await device('0000:03:00.0', { vendor: '0x1002\n', mem_info_vram_total: String(16 * GiB) });
  const intel = await device('0000:00:02.0', { vendor: '0x8086\n', product_name: 'Intel Arc\u0007 A770\n' });
  const nvidia = await device('0000:01:00.0', { vendor: '0x10de\n' });
  for (const [card, path] of [['card0', amd], ['card1', intel], ['card2', nvidia], ['card3', amd]] as const) {
    await mkdir(join(root, 'sys/class/drm', card), { recursive: true });
    await symlink(path, join(root, 'sys/class/drm', card, 'device'));
  }
  await mkdir(join(root, 'sys/class/drm/card0-HDMI-A-1'), { recursive: true });
  assert.deepEqual(sysfsGpus(root), [{ vendor: 'amd', memoryBytes: 16 * GiB }, { vendor: 'intel', name: 'Intel Arc A770' }, { vendor: 'nvidia' }]);
  assert.deepEqual(sysfsGpus(join(root, 'missing')), []);

  assert.deepEqual(parseNvidiaSmi('NVIDIA GeForce RTX 4090, 24564\nNVIDIA A100, [N/A]\n'),
    [{ vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4090', memoryBytes: 24564 * 1024 * 1024 }, { vendor: 'nvidia', name: 'NVIDIA A100' }]);
  const calls: string[] = [];
  const run = async (file: string, args: string[]) => {
    calls.push([file, ...args].join(' '));
    if (file === 'nvidia-smi') return 'NVIDIA GeForce RTX 4090, 24564\n';
    throw new Error('missing');
  };
  assert.deepEqual(await probeGpus({ root, platform: 'linux', run }), [{ vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4090', memoryBytes: 24564 * 1024 * 1024 },
    { vendor: 'amd', memoryBytes: 16 * GiB }, { vendor: 'intel', name: 'Intel Arc A770' }], 'nvidia-smi names NVIDIA GPUs in place of sysfs');
  assert.deepEqual(calls, ['nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits']);

  const wsl = await mkdtemp(join(await realpath(tmpdir()), 'hardware-wsl-'));
  t.after(() => rm(wsl, { recursive: true, force: true }));
  await mkdir(join(wsl, 'dev'), { recursive: true });
  await writeFile(join(wsl, 'dev/dxg'), '');
  assert.deepEqual(await probeGpus({ root: wsl, platform: 'linux', run: async () => { throw new Error('none'); } }), [{ vendor: 'microsoft' }]);
  await mkdir(join(wsl, 'usr/lib/wsl/lib'), { recursive: true });
  await writeFile(join(wsl, 'usr/lib/wsl/lib/nvidia-smi'), '');
  const wslCalls: string[] = [];
  assert.deepEqual(await probeGpus({ root: wsl, platform: 'linux', run: async file => { wslCalls.push(file); return 'NVIDIA RTX 3080, 10240'; } }),
    [{ vendor: 'nvidia', name: 'NVIDIA RTX 3080', memoryBytes: 10240 * 1024 * 1024 }]);
  assert.deepEqual(wslCalls, ['/usr/lib/wsl/lib/nvidia-smi']);

  const profile = JSON.stringify({ SPDisplaysDataType: [{ sppci_model: 'Apple M3 Max', spdisplays_vendor: 'sppci_vendor_Apple', sppci_cores: '40' },
    { _name: 'Radeon Pro 5500M', spdisplays_vendor: 'sppci_vendor_amd', spdisplays_vram: '8 GB' }] });
  assert.deepEqual(parseSystemProfiler(profile), [{ vendor: 'apple', name: 'Apple M3 Max' }, { vendor: 'amd', name: 'Radeon Pro 5500M', memoryBytes: 8 * GiB }]);
  assert.deepEqual(parseSystemProfiler('not json'), []);
  assert.deepEqual(await probeGpus({ platform: 'darwin', run: async () => profile }), parseSystemProfiler(profile));
  assert.deepEqual(await probeGpus({ platform: 'win32', run: async () => { throw new Error('none'); } }), []);
});

test('the connector\'s report describes this machine and passes the server\'s checks', async t => {
  const dataDir = await mkdtemp(join(await realpath(tmpdir()), 'hardware-report-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let probes = 0;
  const probe = new HardwareProbe(dataDir, { run: async () => { probes++; throw new Error('none'); }, root: join(dataDir, 'no-root') });
  const report = await probe.report();
  assert.deepEqual(parseHardware(report), report);
  assert.equal(report.platform, process.platform);
  assert.ok(report.cpus >= 1 && report.memoryBytes > 0 && report.freeMemoryBytes <= report.memoryBytes);
  assert.ok(report.freeDiskBytes === undefined || report.freeDiskBytes <= report.diskBytes!);
  const before = probes;
  await probe.report();
  assert.equal(probes, before, 'GPUs are probed once per process');
});
