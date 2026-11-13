import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionExtensions, type ExtensionHost } from "../apps/runner/src/extensions/adapter.js";
import { HostExtensions, MANAGED_RETRY_MS } from "../apps/runner/src/extensions/host.js";
import { connectorPikiExtensions, managedSource, type PikiExtension } from "../apps/runner/src/extensions/piki/index.js";
import { ExtensionStore } from "../apps/runner/src/extensions/store.js";
import { parseExtensionsSyncAnswer, parseHostExtensionsReport } from "../packages/shared/src/host-extensions.js";
import { compareVersions, connectorRunsPin, managedExtensions, parseManagedExtensions, type ManagedExtensionPin } from "../packages/shared/src/managed-extensions.js";
import { pikiExtension } from "../packages/shared/src/piki-extensions.js";

const digest = (text: string) => `sha512-${createHash("sha512").update(text).digest("base64")}`;

const pin = (overrides: Partial<ManagedExtensionPin> = {}): ManagedExtensionPin => ({
  source: "piki:pr-flow", package: "@pikibun/pi-pr-flow", version: "0.2.0", integrity: digest("@pikibun/pi-pr-flow@0.2.0"), minimumConnector: "0.30.0", ...overrides,
});

const bundledPrFlow = connectorPikiExtensions.filter(item => item.info.source === "piki:pr-flow");
const withBundled = (version: string): PikiExtension[] => [{ ...bundledPrFlow[0]!, version }];
const prFlowPin = (version: string, overrides: Partial<ManagedExtensionPin> = {}) => pin({ version, integrity: digest(`@pikibun/pi-pr-flow@${version}`), ...overrides });
const helloPin = (version: string, overrides: Partial<ManagedExtensionPin> = {}) => pin({ source: "piki:hello", package: "@pikibun/pi-hello", version,
  integrity: digest(`@pikibun/pi-hello@${version}`), ...overrides });
const tampered = { integrity: digest("tampered") };

interface Published {
  version?: string;
  integrity?: string;
  module?: string;
  others?: string[];
  lock?: false;
}

async function fixture(t: test.TestContext, published: Record<string, Published> = {}) {
  const root = await mkdtemp(join(tmpdir(), "pikibun-managed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installs: { args: string[]; cwd: string }[] = [];
  const store = new ExtensionStore(join(root, "state", "extensions"), async (args, cwd) => {
    installs.push({ args, cwd });
    const spec = args.at(-1)!;
    const at = spec.lastIndexOf("@");
    const name = spec.slice(0, at);
    const requested = spec.slice(at + 1);
    const served = published[name];
    if (!served) throw new Error(`npm install failed: 404 ${name}`);
    const version = served.version ?? requested;
    const directory = join(cwd, "node_modules", ...name.split("/"));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify({ name, version, description: `${name}, published`, type: "module", pi: { extensions: ["./index.js"] } }));
    await writeFile(join(directory, "index.js"), served.module
      ?? `export default function (pi) { pi.on("before_agent_start", event => ({ systemPrompt: event.systemPrompt + "\\n\\nfrom ${name}@${version}" })); }`);
    const manifest = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
    manifest.dependencies[name] = version;
    await writeFile(join(cwd, "package.json"), JSON.stringify(manifest));
    if (served.lock === false) return;
    const packages: Record<string, unknown> = { "": { dependencies: { [name]: version } },
      [`node_modules/${name}`]: { version, resolved: `https://registry.npmjs.org/${name}/-/x-${version}.tgz`, integrity: served.integrity ?? digest(`${name}@${version}`) } };
    for (const other of served.others ?? []) packages[`node_modules/${other}`] = { version: "1.0.0", integrity: digest(other) };
    await writeFile(join(cwd, "package-lock.json"), JSON.stringify({ name: "pikibun-managed-extension", lockfileVersion: 3, requires: true, packages }));
  });
  const logs: string[] = [];
  let now = 1_000_000;
  const host = (options: { managed?: boolean; remoteInstalls?: boolean; connectorVersion?: string; pikiExtensions?: readonly PikiExtension[] } = {}) => new HostExtensions(store, {
    remoteInstalls: options.remoteInstalls ?? true, managed: options.managed ?? true, connectorVersion: "connectorVersion" in options ? options.connectorVersion : "0.31.0",
    pikiExtensions: options.pikiExtensions ?? bundledPrFlow, log: line => { logs.push(line); }, now: () => now,
  });
  return { root, store, installs, logs, host, advance: (ms: number) => { now += ms; } };
}

const entry = (host: HostExtensions, source: string) => host.loaded.find(item => item.summary.source === source);

function runs(host: HostExtensions, source: string): string {
  const item = entry(host, source);
  return !item ? "nothing" : item.summary.error !== undefined ? "missing" : item.factories ? "bundled" : `managed ${item.managed!.version}`;
}

async function prompt(session: SessionExtensions): Promise<string> {
  return (await session.beforeAgentStart("hello", undefined))["piki:pr-flow"] ?? "";
}

function extensionHost(directory: string): ExtensionHost {
  return { directory, model: () => undefined, state: async () => ({ active: true, settings: {} }), runTool: async (_call, execute) => execute(new AbortController().signal),
    hookTimeoutMs: 5000, warn: (_source, message) => assert.fail(message) };
}

test("the pins Pikibun's release holds: none yet, each checked field by field, and an answer without them parses as before", () => {
  assert.deepEqual(managedExtensions, [], "the first pins come with a release");
  assert.deepEqual(parseManagedExtensions([pin()]), [pin()]);
  assert.deepEqual(parseManagedExtensions(undefined), []);
  assert.deepEqual(parseManagedExtensions("all of them"), []);
  for (const bad of [{ ...pin(), source: "npm:x@1.0.0" }, { ...pin(), version: "^0.2.0" }, { ...pin(), version: "latest" }, { ...pin(), integrity: "sha1-abc" },
    { ...pin(), minimumConnector: "dev" }, { ...pin(), package: "Not A Package" }, { ...pin(), extra: true }]) {
    assert.deepEqual(parseManagedExtensions([bad]), [], JSON.stringify(bad));
  }
  assert.deepEqual(parseManagedExtensions([pin(), pin({ version: "0.3.0" })]), [pin()], "one pin per source, the first");
  assert.deepEqual(parseExtensionsSyncAnswer({ requests: [] }), { requests: [] }, "a control plane from before sends none");
  assert.deepEqual(parseExtensionsSyncAnswer({ requests: [{ id: "r1", action: "install", source: "npm:a@1.0.0" }], managed: [{ source: "piki:x" }, pin()] }),
    { requests: [{ id: "r1", action: "install", source: "npm:a@1.0.0" }], managed: [pin()] }, "a bad pin is dropped, not the answer");
  assert.equal(connectorRunsPin(pin(), "0.30.0"), true);
  assert.equal(connectorRunsPin(pin(), "0.31.2-beta.1"), true);
  assert.equal(connectorRunsPin(pin(), "0.29.9"), false);
  assert.equal(connectorRunsPin(pin(), "dev"), false, "a connector run from source runs the working tree's extensions");
  assert.equal(connectorRunsPin(pin(), undefined), false);
  const ordered = ["0.1.0-alpha", "0.1.0-alpha.1", "0.1.0-alpha.beta", "0.1.0-beta", "0.1.0-beta.2", "0.1.0-beta.11", "0.1.0-rc.1", "0.1.0", "0.1.1", "0.2.0", "0.10.0", "1.0.0"];
  for (const [index, version] of ordered.entries()) {
    for (const [other, than] of ordered.entries()) assert.equal(compareVersions(version, than), Math.sign(index - other), `${version} against ${than}`);
  }
  assert.equal(compareVersions("1.0.0+build.1", "1.0.0"), 0);
});

test("a bundled copy's version is the one committed in its package, which the extension release publishes", async () => {
  for (const extension of connectorPikiExtensions.filter(item => item.version !== undefined)) {
    const manifest = JSON.parse(await readFile(join(import.meta.dirname, "..", "extensions", extension.info.name, "package.json"), "utf8"));
    assert.equal(extension.version, manifest.version, extension.info.source);
  }
  assert.deepEqual(connectorPikiExtensions.filter(item => item.version !== undefined).map(item => item.info.source), ["piki:prompt-audit", "piki:pr-flow", "piki:context-files"]);
  assert.deepEqual(connectorPikiExtensions.filter(item => managedSource(item.info.source)).map(item => item.info.source), ["piki:pr-flow", "piki:context-files"],
    "the prompt audit runs only as built in until it can run in the extension process");
});

test("a pinned package that passes every check loads in place of the bundled copy, reports its version, and isn't an installed extension", async t => {
  const f = await fixture(t, { "@pikibun/pi-pr-flow": {} });
  const host = f.host();
  await host.load();
  assert.ok(entry(host, "piki:pr-flow")!.factories, "the bundled copy until the first answer");
  assert.equal(await host.applyManaged([pin()]), true);
  const loaded = entry(host, "piki:pr-flow")!;
  assert.equal(loaded.factories, undefined);
  assert.equal(loaded.managed?.version, "0.2.0");
  assert.deepEqual({ ...host.report().installed[0]!, modules: [] }, { source: "piki:pr-flow", dev: false, version: "0.2.0", name: "@pikibun/pi-pr-flow",
    description: "@pikibun/pi-pr-flow, published", modules: [] });
  assert.deepEqual(host.report().installed[0]!.modules.map(module => [module.path, module.events, module.error]), [["index.js", ["before_agent_start"], undefined]]);
  assert.deepEqual(f.installs.map(install => install.args), [["install", "--save-exact", "--no-audit", "--no-fund", "--legacy-peer-deps", "--ignore-scripts", "@pikibun/pi-pr-flow@0.2.0"]]);
  assert.match(f.installs[0]!.cwd, /extensions[/\\]managed[/\\][0-9a-f]{16}$/);
  assert.deepEqual(await f.store.list(), [], "not one of the host's installed sources");
  assert.deepEqual((await f.store.listManaged()).map(item => `${item.source} ${item.package}@${item.version} ${item.loaded}`), ["piki:pr-flow @pikibun/pi-pr-flow@0.2.0 true"]);

  const before = host.loaded;
  await host.refreshIfChanged();
  assert.equal(host.loaded, before, "a managed source isn't taken for a store source that went away");
  assert.equal(await host.applyManaged([pin()]), false, "the same pin changes nothing");
  assert.equal(f.installs.length, 1);
  await assert.rejects(f.store.remove("@pikibun/pi-pr-flow"), /which Pikibun manages: it can't be removed/);
  await assert.rejects(f.store.remove("piki:pr-flow"), /built into the connector/);

  const again = f.host();
  await again.load();
  assert.equal(runs(again, "piki:pr-flow"), "managed 0.2.0", "a restarted connector runs it before it hears from Pikibun");
  await again.applyManaged([pin()]);
  assert.equal(runs(again, "piki:pr-flow"), "managed 0.2.0");
  assert.equal(f.installs.length, 1);
});

test("the newest version the host can vouch for runs: the pinned package, the newest it ran before, or its bundled copy", async t => {
  const rows: { bundled?: string; loaded?: string; pin?: string; fails?: boolean; runs: string; installs?: number }[] = [
    { bundled: "0.2.0", pin: "0.3.0", runs: "managed 0.3.0", installs: 1 },
    { bundled: "0.2.0", pin: "0.1.5", runs: "bundled", installs: 0 },
    { bundled: "0.2.0", loaded: "0.4.0", pin: "0.2.5", runs: "managed 0.4.0", installs: 0 },
    { bundled: "0.3.0", loaded: "0.4.0", pin: "0.2.5", runs: "managed 0.4.0", installs: 0 },
    { bundled: "0.2.0", loaded: "0.4.0", pin: "0.5.0", fails: true, runs: "managed 0.4.0", installs: 1 },
    { bundled: "0.5.0", loaded: "0.4.0", pin: "0.6.0", fails: true, runs: "bundled", installs: 1 },
    { bundled: "0.5.0", loaded: "0.4.0", runs: "bundled", installs: 0 },
    { bundled: "0.2.0", loaded: "0.2.0", pin: "0.2.0", runs: "managed 0.2.0", installs: 0 },
    { bundled: "0.3.0", pin: "0.3.0", runs: "managed 0.3.0", installs: 1 },
    { loaded: "0.1.0", runs: "managed 0.1.0", installs: 0 },
    { loaded: "0.1.0", pin: "0.2.0", fails: true, runs: "managed 0.1.0", installs: 1 },
    { pin: "0.1.0", fails: true, runs: "missing", installs: 1 },
  ];
  for (const row of rows) {
    const name = `bundled ${row.bundled ?? "none"}, ran before ${row.loaded ?? "none"}, pinned ${row.pin ?? "none"}${row.fails ? " failing" : ""}: ${row.runs}`;
    await t.test(name, async t => {
      const f = await fixture(t, { "@pikibun/pi-pr-flow": {}, "@pikibun/pi-hello": {} });
      const source = row.bundled ? "piki:pr-flow" : "piki:hello";
      const pinOf = (version: string, overrides: Partial<ManagedExtensionPin> = {}) => row.bundled ? prFlowPin(version, overrides) : helloPin(version, overrides);
      if (row.loaded) {
        const earlier = f.host({ pikiExtensions: row.bundled ? withBundled("0.0.1") : [] });
        await earlier.load();
        await earlier.applyManaged([pinOf(row.loaded)]);
        assert.equal(runs(earlier, source), `managed ${row.loaded}`);
      }
      const installed = f.installs.length;
      const host = f.host({ pikiExtensions: row.bundled ? withBundled(row.bundled) : [] });
      await host.load();
      await host.applyManaged(row.pin ? [pinOf(row.pin, row.fails ? tampered : {})] : []);
      assert.equal(runs(host, source), row.runs);
      assert.equal(f.installs.length - installed, row.installs, "a pin is installed only where it would run");
      if (row.loaded) {
        assert.ok((await f.store.listManaged()).some(item => item.version === row.loaded), "the version it ran before is kept");
        const restarted = f.host({ pikiExtensions: row.bundled ? withBundled(row.bundled) : [] });
        await restarted.load();
        await restarted.applyManaged([]);
        assert.equal(runs(restarted, source), row.runs, "and after the next restart's pruning");
      }
    });
  }
});

test("a connector from source, one with --no-remote-installs and one without --managed-extensions run the bundled copy, with a newer version on disk", async t => {
  const f = await fixture(t, { "@pikibun/pi-pr-flow": {}, "@pikibun/pi-hello": {} });
  const earlier = f.host();
  await earlier.load();
  await earlier.applyManaged([prFlowPin("0.4.0"), helloPin("1.0.0")]);
  assert.equal(runs(earlier, "piki:pr-flow"), "managed 0.4.0");
  const installs = f.installs.length;
  for (const options of [{ remoteInstalls: false }, { managed: false }, { connectorVersion: "dev" }, { connectorVersion: undefined }]) {
    const host = f.host(options);
    await host.load();
    assert.equal(host.managesExtensions, false, JSON.stringify(options));
    assert.equal(await host.applyManaged([prFlowPin("0.5.0")]), false);
    assert.equal(runs(host, "piki:pr-flow"), "bundled", JSON.stringify(options));
    assert.equal(runs(host, "piki:hello"), "nothing", JSON.stringify(options));
  }
  assert.equal(f.installs.length, installs);
  assert.equal((await f.store.listManaged()).length, 2, "nor do they delete anything");
});

test("a control plane without pins changes nothing on a host that never ran a managed version", async t => {
  const f = await fixture(t, { "@pikibun/pi-pr-flow": {} });
  const host = f.host();
  await host.load();
  const report = host.report();
  assert.equal(await host.applyManaged(parseExtensionsSyncAnswer({ requests: [] }).managed), false);
  assert.deepEqual(host.report(), report);
  assert.equal(runs(host, "piki:pr-flow"), "bundled");
  assert.equal(f.installs.length, 0);
});

test("each failed check makes the pin no candidate, and leaves nothing installed", async t => {
  const cases: { name: string; published: Published; pin?: Partial<ManagedExtensionPin>; reason: RegExp; installs: number }[] = [
    { name: "a wrong digest", published: { integrity: digest("something else") }, reason: /digest isn't the one Pikibun pinned/, installs: 1 },
    { name: "a second package in the lock file", published: { others: ["left-pad"] }, reason: /npm installed left-pad with @pikibun\/pi-pr-flow@0.2.0/, installs: 1 },
    { name: "another version than pinned", published: { version: "0.2.1" }, reason: /npm installed @pikibun\/pi-pr-flow@0.2.1, not 0.2.0/, installs: 1 },
    { name: "no lock file", published: { lock: false }, reason: /no package-lock.json/, installs: 1 },
    { name: "another scope", published: {}, pin: { package: "@acme/pi-pr-flow" }, reason: /@acme\/pi-pr-flow is not a @pikibun\/ package/, installs: 0 },
    { name: "a newer minimumConnector", published: {}, pin: { minimumConnector: "0.32.0" }, reason: /needs connector 0.32.0 or later/, installs: 0 },
    { name: "a module that fails to load", published: { module: "export default function () { throw new Error('broken on purpose'); }" }, reason: /didn't load: .*broken on purpose/, installs: 1 },
    { name: "an install that fails", published: {}, pin: { package: "@pikibun/pi-unpublished" }, reason: /404/, installs: 1 },
  ];
  for (const item of cases) {
    await t.test(item.name, async t => {
      const f = await fixture(t, { "@pikibun/pi-pr-flow": item.published, "@acme/pi-pr-flow": item.published });
      const host = f.host();
      await host.load();
      assert.equal(await host.applyManaged([pin(item.pin)]), false);
      assert.equal(runs(host, "piki:pr-flow"), "bundled");
      assert.equal(host.report().installed.length, 1);
      assert.equal(f.installs.length, item.installs);
      assert.ok(f.logs.some(line => item.reason.test(line)), f.logs.join("\n"));
      assert.deepEqual(await f.store.listManaged(), []);
      assert.deepEqual(existsSync(join(f.root, "state", "extensions", "managed")) ? await readdir(join(f.root, "state", "extensions", "managed")) : [], []);
    });
  }
});

test("a failed pin is tried again no sooner than ten minutes later, and once more after a restart", async t => {
  const f = await fixture(t, { "@pikibun/pi-pr-flow": { integrity: digest("tampered") } });
  const host = f.host();
  await host.load();
  await host.applyManaged([pin()]);
  await host.applyManaged([pin()]);
  f.advance(MANAGED_RETRY_MS - 1);
  await host.applyManaged([pin()]);
  assert.equal(f.installs.length, 1);
  f.advance(1);
  await host.applyManaged([pin()]);
  assert.equal(f.installs.length, 2);
  const restarted = f.host();
  await restarted.load();
  await restarted.applyManaged([pin()]);
  assert.equal(f.installs.length, 3);
});

test("a pin for a piki: name this connector doesn't know installs and loads it; where it has none to run, the host reports it missing with the reason", async t => {
  const f = await fixture(t, { "@pikibun/pi-hello": {} });
  const host = f.host();
  await host.load();
  assert.equal(pikiExtension("piki:hello"), undefined);
  assert.equal(await host.applyManaged([helloPin("1.0.0")]), true);
  assert.deepEqual(host.report().installed.map(item => [item.source, item.version, item.name, item.error]),
    [["piki:pr-flow", undefined, pikiExtension("piki:pr-flow")!.title, undefined], ["piki:hello", "1.0.0", "@pikibun/pi-hello", undefined]]);
  assert.deepEqual(parseHostExtensionsReport(host.report()), host.report(), "the control plane takes the report");

  assert.equal(await host.applyManaged([helloPin("1.1.0", { minimumConnector: "9.0.0" })]), false, "a newer pin it can't run leaves the one it ran");
  assert.equal(runs(host, "piki:hello"), "managed 1.0.0");
  assert.ok(f.logs.some(line => /@pikibun\/pi-hello@1.1.0 needs connector 9.0.0 or later/.test(line)));

  assert.equal(await host.applyManaged([pin({ source: "piki:gone", package: "@pikibun/pi-gone", version: "1.0.0", integrity: digest("@pikibun/pi-gone@1.0.0") })]), true);
  assert.match(host.report().installed.find(item => item.source === "piki:gone")!.error!, /404 @pikibun\/pi-gone/);
  assert.deepEqual(parseHostExtensionsReport(host.report()), host.report());
  assert.equal(runs(host, "piki:hello"), "managed 1.0.0", "no longer pinned, but it ran here");
  assert.equal(await host.applyManaged([pin({ source: "piki:gone", package: "@pikibun/pi-gone", version: "1.0.0", integrity: digest("@pikibun/pi-gone@1.0.0"), minimumConnector: "9.0.0" })]), true);
  assert.equal(host.report().installed.find(item => item.source === "piki:gone")!.error, "@pikibun/pi-gone@1.0.0 needs connector 9.0.0 or later: update it (npx pikibun@latest connect)");
});

test("a pin can't replace what the connector runs itself: its command and session-tool extensions, and the prompt audit until it can run elsewhere", async t => {
  const f = await fixture(t, { "@pikibun/pi-gh": {}, "@pikibun/pi-prompt-audit": {}, "@pikibun/pi-auto-mode": {}, "@pikibun/pi-schedule": {} });
  const host = f.host({ pikiExtensions: connectorPikiExtensions });
  await host.load();
  const sources = host.loaded.map(item => item.summary.source);
  assert.equal(await host.applyManaged([pin({ source: "piki:gh", package: "@pikibun/pi-gh", version: "9.0.0" }),
    pin({ source: "piki:prompt-audit", package: "@pikibun/pi-prompt-audit", version: "9.0.0" }), pin({ source: "piki:auto-mode", package: "@pikibun/pi-auto-mode" }),
    pin({ source: "piki:schedule", package: "@pikibun/pi-schedule" })]), false);
  assert.deepEqual(host.loaded.map(item => item.summary.source), sources);
  assert.ok(host.loaded.every(item => item.factories));
  assert.equal(f.installs.length, 0);
  assert.ok(f.logs.some(line => /piki:prompt-audit: the pin for @pikibun\/pi-prompt-audit@9.0.0 is ignored/.test(line)));
});

test("an open session keeps the version it opened with; a session opened after the pin runs the managed package", async t => {
  const f = await fixture(t, { "@pikibun/pi-pr-flow": {} });
  const host = f.host();
  await host.load();
  const worktree = join(f.root, "worktree");
  await mkdir(worktree);
  const runner = extensionHost(worktree);
  const open = new SessionExtensions(runner);
  await open.ensure(host.loaded);
  assert.match(await prompt(open), /^## Pull request flow/);

  await host.applyManaged([pin()]);
  await open.ensure(host.loaded);
  assert.match(await prompt(open), /^## Pull request flow/, "a session never changes version under a running message");
  assert.doesNotMatch(await prompt(open), /from @pikibun/);
  const later = new SessionExtensions(runner);
  await later.ensure(host.loaded);
  assert.match(await prompt(later), /from @pikibun\/pi-pr-flow@0.2.0/);

  await host.applyManaged([prFlowPin("0.3.0")]);
  assert.equal(existsSync(join(f.store.directory, "managed", (await f.store.listManaged())[0]!.directory)), true,
    "a version no longer pinned stays on disk while the connector runs: an open session may still run it");
  assert.equal((await f.store.listManaged()).length, 2);
  const newest = new SessionExtensions(runner);
  await newest.ensure(host.loaded);
  assert.match(await prompt(newest), /from @pikibun\/pi-pr-flow@0.3.0/);
  assert.match(await prompt(later), /from @pikibun\/pi-pr-flow@0.2.0/);

  const restarted = f.host();
  await restarted.load();
  await restarted.applyManaged([prFlowPin("0.3.0")]);
  assert.deepEqual((await f.store.listManaged()).map(item => item.version), ["0.3.0"], "the next start deletes what is neither pinned nor the newest it ran");
  assert.deepEqual(await readdir(join(f.store.directory, "managed")), [(await f.store.listManaged())[0]!.directory]);
  assert.ok(f.logs.some(line => /removed @pikibun\/pi-pr-flow@0.2.0, which is neither pinned nor the newest version this host has run/.test(line)));
});
