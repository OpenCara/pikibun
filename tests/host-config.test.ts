import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultHostConfig, ownerOnlyHostConfig, parseRequiredExtensions, parseHostCompaction, parseHostConfig, parseHostConfigChange, readHostConfig } from "../packages/shared/src/host-config.js";
import { commandLimits, detectGpu, gpuMounts, HostConfigSource } from "../apps/runner/src/host-config.js";
import { movedOptionsNotice } from "../apps/runner/src/connect-cli.js";
import { Sandbox } from "../apps/runner/src/sandbox.js";
import type { RunnerBinding } from "../packages/shared/src/types.js";
import { linuxSandboxMissing } from "./helpers/workspaces.js";

const MiB = 1024 * 1024;
const sandboxed = !linuxSandboxMissing();

const GPU_DEVICE = "sys/devices/pci0000:00/0000:00:02.0";

async function standInGpu(root: string): Promise<void> {
  await mkdir(join(root, "dev/dri"), { recursive: true });
  for (const name of ["card0", "renderD128", "renderD129"]) await writeFile(join(root, "dev/dri", name), "");
  await mkdir(join(root, GPU_DEVICE, "drm/renderD128"), { recursive: true });
  await writeFile(join(root, GPU_DEVICE, "drm/renderD128/dev"), "226:128\n");
  await symlink("../../../0000:00:02.0", join(root, GPU_DEVICE, "drm/renderD128/device"));
  await mkdir(join(root, "sys/class/drm"), { recursive: true });
  await symlink("../../devices/pci0000:00/0000:00:02.0/drm/renderD128", join(root, "sys/class/drm/renderD128"));
}

function fauxBinding(id: string): RunnerBinding {
  return {
    session: { id, workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1", title: "GPU test", policyVersion: 1,
      status: "ready", createdAt: "2026-01-01T00:00:00Z", repositories: [] },
    owner: { id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice Owner",
      gitEmail: "alice@example.test", env: {}, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: "test:template-author", workspaceId: "workspace", version: 1, name: "GPU agent",
      description: "Test", instructions: "Use tools.", tools: ["bash"], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "workspace", name: "Explicit faux test provider", provider: "faux", modelId: "gpu-faux" },
  };
}

test("a host configuration is whole and within bounds, or refused", () => {
  const config = { commandTimeoutSeconds: 600, gpu: true, gitCredentials: true, repositoryCache: "owner", hostSessions: true,
    compaction: { reserveTokens: 32_768, modelOverrides: { "anthropic/opus": { keepRecentTokens: 20_000 } } }, builtinExtensions: ["pi:codemode"],
    requiredExtensions: [{ source: "piki:prompt-audit", settings: { model: "anthropic/haiku", policy: "Never read ~/clients." } }, { source: "npm:cc-safety-net@2.7.2", settings: {} }],
    browser: { source: "path", path: "/usr/lib/chromium/chromium" }, serviceLifetimeSeconds: 7200, tunnel: { source: "path", path: "/usr/local/bin/cloudflared" },
    fakeIpTunnels: true };
  assert.deepEqual(parseHostConfig(config), config);
  for (const tunnel of [{ source: "auto" }, { source: "download" }, { source: "off" }]) assert.deepEqual(parseHostConfig({ ...config, tunnel }).tunnel, tunnel);
  for (const browser of [{ source: "auto" }, { source: "download" }, { source: "off" }]) assert.deepEqual(parseHostConfig({ ...config, browser }).browser, browser);
  assert.deepEqual(parseHostConfig({ ...defaultHostConfig }), { commandTimeoutSeconds: 30, gpu: false, gitCredentials: false, repositoryCache: "off", hostSessions: false, compaction: {}, builtinExtensions: [], requiredExtensions: [], browser: { source: "auto" }, serviceLifetimeSeconds: 14400, tunnel: { source: "auto" }, fakeIpTunnels: false });
  for (const invalid of [undefined, null, [], "config", { ...config, commandTimeoutSeconds: 29 }, { ...config, commandTimeoutSeconds: 3601 },
    { ...config, commandTimeoutSeconds: 60.5 }, { ...config, commandTimeoutSeconds: "60" }, { ...config, gpu: 1 }, { ...config, gitCredentials: "true" },
    { ...config, repositoryCache: "shared" }, { ...config, hostSessions: "true" }, { ...config, extra: true },
    { ...config, compaction: undefined }, { ...config, compaction: { reserveTokens: -1 } },
    { ...config, builtinExtensions: undefined }, { ...config, builtinExtensions: "codemode" }, { ...config, builtinExtensions: ["tool-search"] },
    { ...config, builtinExtensions: ["pi:codemode", "codemode"] },
    { ...config, requiredExtensions: undefined }, { ...config, requiredExtensions: [{ source: "npm:cc-safety-net" }] },
    { commandTimeoutSeconds: 60, gpu: false, gitCredentials: false, repositoryCache: "off", hostSessions: false },
    { ...config, browser: undefined }, { ...config, browser: "auto" }, { ...config, browser: { source: "anywhere" } }, { ...config, browser: { source: "path" } },
    { ...config, browser: { source: "path", path: "chromium" } }, { ...config, browser: { source: "path", path: "/opt/chrome\n--flag" } },
    { ...config, browser: { source: "path", path: `/${"x".repeat(4096)}` } }, { ...config, browser: { source: "download", path: "/opt/chrome/chrome" } },
    { ...config, browser: { source: "auto", version: "131" } },
    { ...config, serviceLifetimeSeconds: undefined }, { ...config, serviceLifetimeSeconds: 299 }, { ...config, serviceLifetimeSeconds: 86_401 },
    { ...config, serviceLifetimeSeconds: "3600" }, { ...config, serviceLifetimeSeconds: 600.5 },
    { ...config, tunnel: undefined }, { ...config, tunnel: { source: "everywhere" } }, { ...config, tunnel: { source: "path" } },
    { ...config, tunnel: { source: "path", path: "cloudflared" } }, { ...config, tunnel: { source: "off", path: "/usr/bin/cloudflared" } },
    { ...config, tunnel: { source: "auto", token: "secret" } },
    { ...config, fakeIpTunnels: undefined }, { ...config, fakeIpTunnels: "true" }, { ...config, fakeIpTunnels: 1 },
    { ...config, toString: "x" }]) {
    assert.throws(() => parseHostConfig(invalid), /host configuration|time limit|setting|token counts|[Bb]uilt-in extensions|required extension|[Bb]rowser|service lifetime|cloudflared/, JSON.stringify(invalid));
  }
});

test("a host requires extensions by normalized source, one version of each package, with valid settings, and only its owner sets them", () => {
  assert.deepEqual(parseRequiredExtensions([]), []);
  assert.deepEqual(parseRequiredExtensions([{ source: "piki:prompt-audit", settings: { policy: "Never read ~/clients.", audit: "all" } }, { source: "npm:cc-safety-net@2.7.2" }]),
    [{ source: "piki:prompt-audit", settings: { audit: "all", policy: "Never read ~/clients." } }, { source: "npm:cc-safety-net@2.7.2", settings: {} }]);
  assert.deepEqual(parseRequiredExtensions([{ source: "git:github.com/acme/guard@" + "a".repeat(40), settings: {} }]).map(item => item.source),
    ["git:https://github.com/acme/guard@" + "a".repeat(40)]);
  const many = Array.from({ length: 17 }, (_, index) => ({ source: `npm:guard-${index}@1.0.0`, settings: {} }));
  for (const invalid of [null, {}, "piki:prompt-audit", many, [null], [{}], [{ source: 5 }], [{ source: "npm:cc-safety-net" }], [{ source: "./guard.ts" }],
    [{ source: "piki:prompt-audit", settings: { policy: 5 } }], [{ source: "piki:prompt-audit", extra: true }],
    [{ source: "npm:cc-safety-net@2.7.2" }, { source: "npm:cc-safety-net@2.7.1" }]]) {
    assert.throws(() => parseRequiredExtensions(invalid), /required extension|requires|setting/i, JSON.stringify(invalid));
  }
  assert.ok(ownerOnlyHostConfig.includes("requiredExtensions"));
  assert.ok(ownerOnlyHostConfig.includes("tunnel"));
  assert.ok(ownerOnlyHostConfig.includes("fakeIpTunnels"));
  assert.ok(!ownerOnlyHostConfig.includes("serviceLifetimeSeconds"));
  const big = Array.from({ length: 9 }, (_, index) => ({ source: `npm:guard-${index}@1.0.0`, settings: { policy: "x".repeat(4000) } }));
  assert.throws(() => parseRequiredExtensions(big), /at most 32 KB/);
});

test("the extensions a host requires are kept from the control plane's last answer however old, and unknown until it has answered", async () => {
  let now = 0;
  const answers: unknown[] = [];
  const source = new HostConfigSource(async () => { const answer = answers.shift(); if (answer instanceof Error || answer === undefined) throw answer ?? new Error("none"); return answer; },
    { now: () => now, ttlMs: 30_000, staleMs: 300_000 });
  answers.push(new Error("control plane unreachable"));
  assert.equal(await source.required(), undefined, "never answered: unknown, not none");
  const required = [{ source: "piki:prompt-audit", settings: {} }];
  answers.push({ ...defaultHostConfig, requiredExtensions: required });
  assert.deepEqual(await source.required(), required);
  now += 3_600_000;
  answers.push(new Error("control plane unreachable"));
  assert.deepEqual((await source.current()).requiredExtensions, []);
  assert.deepEqual(await source.required(), required);
});

test("a change of configuration names one or more valid settings, and only those", () => {
  assert.deepEqual(parseHostConfigChange({ commandTimeoutSeconds: 120 }), { commandTimeoutSeconds: 120 });
  assert.deepEqual(parseHostConfigChange({ gpu: true, repositoryCache: "host" }), { gpu: true, repositoryCache: "host" });
  assert.deepEqual(parseHostConfigChange({ compaction: { keepRecentTokens: 8000 } }), { compaction: { keepRecentTokens: 8000 } });
  const whole = { commandTimeoutSeconds: 600, gpu: true, gitCredentials: true, repositoryCache: "owner", hostSessions: true, compaction: {}, builtinExtensions: [], requiredExtensions: [], browser: { source: "auto" }, serviceLifetimeSeconds: 14400, tunnel: { source: "auto" }, fakeIpTunnels: false };
  assert.deepEqual(parseHostConfigChange(whole), whole);
  for (const invalid of [undefined, null, [], "config", {}, { commandTimeoutSeconds: 29 }, { commandTimeoutSeconds: "60" }, { gpu: 1 },
    { repositoryCache: "shared" }, { hostSessions: "true" }, { gpu: true, extra: true }, { toString: "x" }, JSON.parse('{"__proto__": {"gpu": true}}'),
    { compaction: null }, { compaction: { reserveTokens: "8192" } }]) {
    assert.throws(() => parseHostConfigChange(invalid), /host configuration|time limit|setting|token counts/, JSON.stringify(invalid));
  }
});

test("a connector reads what it knows of a configuration: newer settings are left out, missing ones keep their defaults", () => {
  const sent = { commandTimeoutSeconds: 120, gpu: true, gitCredentials: false, repositoryCache: "host", hostSessions: true, compaction: { reserveTokens: 20_000 },
    builtinExtensions: ["pi:codemode"], requiredExtensions: [{ source: "piki:prompt-audit", settings: {} }], browser: { source: "download" },
    serviceLifetimeSeconds: 3600, tunnel: { source: "download" }, fakeIpTunnels: false };
  assert.deepEqual(readHostConfig({ ...sent, someLaterSetting: "on" }), sent);
  assert.deepEqual(readHostConfig({ ...sent, builtinExtensions: ["tool-search", "pi:codemode"] }), sent);
  assert.deepEqual(readHostConfig({ ...sent, builtinExtensions: ["codemode"] }), sent, "a control plane of before pi: names names them bare");
  assert.deepEqual(readHostConfig({ commandTimeoutSeconds: 120, gpu: true, gitCredentials: false, repositoryCache: "host" }), { ...sent, hostSessions: false, compaction: {}, builtinExtensions: [], requiredExtensions: [], browser: { source: "auto" }, serviceLifetimeSeconds: 14400, tunnel: { source: "auto" }, fakeIpTunnels: false },
    "a control plane that predates required extensions sends none: the host requires none");
  assert.deepEqual(readHostConfig({}), defaultHostConfig);
  for (const invalid of [undefined, null, [], { ...sent, hostSessions: "yes" }, { ...sent, commandTimeoutSeconds: 5 }, { ...sent, compaction: { reserveTokens: 1.5 } }]) {
    assert.throws(() => readHostConfig(invalid));
  }
});

test("compaction token counts are whole numbers in bounds, for every model and per provider/modelId, kept in one order", () => {
  assert.deepEqual(parseHostCompaction({}), {});
  assert.deepEqual(parseHostCompaction({ keepRecentTokens: 0, reserveTokens: 10_000_000 }), { reserveTokens: 10_000_000, keepRecentTokens: 0 });
  const parsed = parseHostCompaction({ modelOverrides: { "openai/gpt-5": { reserveTokens: 30_000 }, "anthropic/claude-opus-4": { keepRecentTokens: 1, reserveTokens: 65_536 },
    "relay/org/model": {}, "openrouter/meta/llama-4": { keepRecentTokens: 2000 } } });
  assert.deepEqual(parsed, { modelOverrides: { "anthropic/claude-opus-4": { reserveTokens: 65_536, keepRecentTokens: 1 }, "openai/gpt-5": { reserveTokens: 30_000 },
    "openrouter/meta/llama-4": { keepRecentTokens: 2000 } } });
  assert.equal(JSON.stringify(parsed), '{"modelOverrides":{"anthropic/claude-opus-4":{"reserveTokens":65536,"keepRecentTokens":1},"openai/gpt-5":{"reserveTokens":30000},"openrouter/meta/llama-4":{"keepRecentTokens":2000}}}');
  assert.deepEqual(parseHostCompaction({ modelOverrides: { "a/b": {} } }), {});
  const many = Object.fromEntries(Array.from({ length: 201 }, (_, index) => [`p/m${index}`, { reserveTokens: 1 }]));
  for (const invalid of [undefined, null, [], "{}", { reserveTokens: -1 }, { reserveTokens: 10_000_001 }, { reserveTokens: 1.5 }, { reserveTokens: "8192" },
    { keepRecentTokens: null }, { enabled: true }, { backgroundTokens: 1 }, { modelOverrides: [] }, { modelOverrides: { "no-slash": { reserveTokens: 1 } } },
    { modelOverrides: { "/model": { reserveTokens: 1 } } }, { modelOverrides: { "a/b c": { reserveTokens: 1 } } }, { modelOverrides: { "a/b": { reserveTokens: -5 } } },
    { modelOverrides: { "a/b": { modelOverrides: {} } } }, { modelOverrides: { "a/b": 5 } }, { modelOverrides: many }, JSON.parse('{"__proto__": {"reserveTokens": 1}}')]) {
    assert.throws(() => parseHostCompaction(invalid), /compaction|Compaction/, JSON.stringify(invalid));
  }
});

test("a longer command time limit gives builds room; the default keeps the short-command limits", () => {
  const short = { seconds: 30, cpuSeconds: 25, fileBytes: 64 * MiB, openFiles: 256 };
  assert.deepEqual(commandLimits(30, 8), short);
  assert.deepEqual(commandLimits(600, 8), { seconds: 600, cpuSeconds: 4800, fileBytes: 16 * 1024 * MiB, openFiles: 8192 });
  assert.equal(commandLimits(120, 0).cpuSeconds, 120, "at least one CPU");
  assert.deepEqual(commandLimits(5, 8), short);
  assert.deepEqual(commandLimits(Number.NaN, 8), short);
  assert.equal(commandLimits(99_999, 2).seconds, 3600);
  assert.equal(commandLimits(90.7, 1).seconds, 90);
});

test("the host's configuration is asked for again only after a while, and its last answer outlives a brief outage", async () => {
  let now = 0;
  let loads = 0;
  const answers: unknown[] = [];
  const source = new HostConfigSource(async () => {
    loads++;
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    return answer;
  }, { now: () => now, ttlMs: 30_000, staleMs: 300_000 });
  const first = { commandTimeoutSeconds: 120, gpu: true, gitCredentials: false, repositoryCache: "off", hostSessions: false, compaction: {}, builtinExtensions: [], requiredExtensions: [], browser: { source: "auto" }, serviceLifetimeSeconds: 14400, tunnel: { source: "auto" }, fakeIpTunnels: false };
  const second = { ...first, commandTimeoutSeconds: 1800 };
  answers.push(first);
  assert.deepEqual(await source.current(), first);
  now += 29_000;
  assert.deepEqual(await source.current(), first);
  assert.equal(loads, 1, "a fresh answer is reused");
  now += 2_000;
  answers.push(second);
  assert.deepEqual(await Promise.all([source.current(), source.current()]), [second, second]);
  assert.equal(loads, 2);
  now += 31_000;
  answers.push(new Error("control plane unreachable"));
  assert.deepEqual(await source.current(), second, "an outage keeps the last answer");
  now += 31_000;
  answers.push({ ...second, commandTimeoutSeconds: 5 });
  assert.deepEqual(await source.current(), second, "an invalid answer is no answer");
  now += 300_000;
  answers.push(new Error("still unreachable"));
  assert.deepEqual(await source.current(), defaultHostConfig, "a long outage falls back to the defaults");
  const empty = new HostConfigSource(async () => { throw new Error("no control plane"); });
  assert.deepEqual(await empty.current(), defaultHostConfig);
});

test("a new connection asks again and learns whether the control plane answered; a failed ask leaves the cache in use", async () => {
  const now = 0;
  let loads = 0;
  const answers: unknown[] = [];
  const source = new HostConfigSource(async () => {
    loads++;
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    return answer;
  }, { now: () => now, ttlMs: 30_000, staleMs: 300_000 });
  const first = { commandTimeoutSeconds: 120, gpu: true, gitCredentials: false, repositoryCache: "owner", hostSessions: false, compaction: {}, builtinExtensions: [], requiredExtensions: [], browser: { source: "auto" }, serviceLifetimeSeconds: 14400, tunnel: { source: "auto" }, fakeIpTunnels: false };
  const second = { ...first, repositoryCache: "off" };
  answers.push(first);
  assert.deepEqual(await source.refresh(), { config: first, answered: true });
  answers.push(second);
  assert.deepEqual(await source.refresh(), { config: second, answered: true }, "asked again though the cached answer was fresh");
  answers.push(new Error("control plane unreachable"));
  assert.deepEqual(await source.refresh(), { config: second, answered: false }, "the cached answer, said not to be a new one");
  assert.equal(loads, 3);
  assert.deepEqual(await source.current(), second);
  assert.deepEqual(await source.current(), second);
  assert.equal(loads, 3, "a failed ask leaves the cache serving callers for the rest of its time, not asking on each call");
  answers.push({ ...second, commandTimeoutSeconds: 5 });
  assert.deepEqual(await source.refresh(), { config: second, answered: false }, "an invalid answer is no answer");
});

test("a GPU is lent as its render device only: WSL's /dev/dxg, or DRM render nodes with their sysfs device", async t => {
  const root = await mkdtemp(join(tmpdir(), "pikibun-gpu-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = realpathSync(root);
  assert.equal(gpuMounts(root), undefined, "no device, nothing to lend");
  assert.equal(detectGpu(root), undefined);
  assert.equal(gpuMounts(join(root, "missing")), undefined);

  const device = GPU_DEVICE;
  await standInGpu(root);
  assert.deepEqual(gpuMounts(root), { kind: "render", env: {}, args: [
    "--dev-bind", join(base, "dev/dri/renderD128"), "/dev/dri/renderD128",
    "--ro-bind", join(base, device), `/${device}`,
    "--symlink", `/${device}/drm/renderD128`, "/sys/dev/char/226:128",
  ] });
  assert.equal(detectGpu(root), "render");
  await rm(join(root, "sys/class/drm/renderD128"));
  await mkdir(join(root, "elsewhere"), { recursive: true });
  await writeFile(join(root, "elsewhere/dev"), "226:128\n");
  await symlink("../../../elsewhere", join(root, "sys/class/drm/renderD128"));
  assert.equal(gpuMounts(root), undefined);

  await writeFile(join(root, "dev/dxg"), "");
  assert.deepEqual(gpuMounts(root), { kind: "dxg", args: ["--dev-bind", join(base, "dev/dxg"), "/dev/dxg"], env: {} });
  await mkdir(join(root, "usr/lib/wsl/lib"), { recursive: true });
  assert.deepEqual(gpuMounts(root), { kind: "dxg", args: ["--dev-bind", join(base, "dev/dxg"), "/dev/dxg"], env: { LD_LIBRARY_PATH: "/usr/lib/wsl/lib" } });
  assert.equal(detectGpu(root), "dxg");
});

test("a sandboxed command lent the GPU finds its render node, the node's sysfs device and the /sys/dev/char link that names it", { skip: !sandboxed }, async t => {
  const base = realpathSync(await mkdtemp(join(tmpdir(), "pikibun-gpu-sandbox-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  await standInGpu(join(base, "host"));
  const sandbox = new Sandbox(fauxBinding("gpu-sandbox"), join(base, "session"), undefined, { gpuRoot: join(base, "host") });
  t.after(() => sandbox.close());
  await sandbox.initialize();
  const shell = async (command: string, gpu: boolean) =>
    (await sandbox.execute({ kind: "bash", command }, true, async () => {}, { allowTestShell: true, gpu })).trim().split("\n");
  const device = `/${GPU_DEVICE}`;
  assert.deepEqual(await shell([
    "readlink /sys/dev/char/226:128", "cat /sys/dev/char/226:128/dev", "(cd -P /sys/dev/char/226:128/device && pwd)",
    "test -e /dev/dri/renderD128 && echo render-node", "test -e /dev/dri/card0 || echo no-card-node",
    "test -e /dev/dri/renderD129 || echo no-node-without-sysfs", `touch ${device}/written 2>/dev/null || echo read-only`,
  ].join("; "), true), [`${device}/drm/renderD128`, "226:128", device, "render-node", "no-card-node", "no-node-without-sysfs", "read-only"]);
  assert.deepEqual(await shell("if [ ! -e /sys/dev/char ] && [ ! -e /sys/devices ] && [ ! -e /dev/dri ]; then echo none; fi", false), ["none"]);
});

test("connect options that moved to Pikibun are named, and ignored, rather than refused", () => {
  assert.equal(movedOptionsNotice([]), "");
  assert.match(movedOptionsNotice(["git-credentials"]), /^--git-credentials is ignored: the host's owner sets it in Pikibun now \(Settings > Hosts > this host > Configuration\)/);
  assert.match(movedOptionsNotice(["repo-cache", "repo-cache-scope"]), /^--repo-cache, --repo-cache-scope are ignored: the host's owner sets them in Pikibun now/);
});
