import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionExtensions, type ExtensionHost } from "../apps/runner/src/extensions/adapter.js";
import { HostExtensions, MANAGED_RETRY_MS } from "../apps/runner/src/extensions/host.js";
import { connectorPikiExtensions, type PikiExtension } from "../apps/runner/src/extensions/piki/index.js";
import { ExtensionStore } from "../apps/runner/src/extensions/store.js";
import { parseExtensionsSyncAnswer, parseHostExtensionsReport } from "../packages/shared/src/host-extensions.js";
import { connectorRunsPin, managedExtensions, parseManagedExtensions, type ManagedExtensionPin } from "../packages/shared/src/managed-extensions.js";
import { pikiExtension } from "../packages/shared/src/piki-extensions.js";

const digest = (text: string) => `sha512-${createHash("sha512").update(text).digest("base64")}`;

const pin = (overrides: Partial<ManagedExtensionPin> = {}): ManagedExtensionPin => ({
  source: "piki:pr-flow", package: "@pikibun/pi-pr-flow", version: "0.2.0", integrity: digest("@pikibun/pi-pr-flow@0.2.0"), minimumConnector: "0.30.0", ...overrides,
});

const bundledPrFlow = connectorPikiExtensions.filter(item => item.info.source === "piki:pr-flow");

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
  assert.deepEqual((await f.store.listManaged()).map(item => `${item.source} ${item.package}@${item.version}`), ["piki:pr-flow @pikibun/pi-pr-flow@0.2.0"]);

  const before = host.loaded;
  await host.refreshIfChanged();
  assert.equal(host.loaded, before, "a managed source isn't taken for a store source that went away");
  assert.equal(await host.applyManaged([pin()]), false, "the same pin changes nothing");
  assert.equal(f.installs.length, 1);
  await assert.rejects(f.store.remove("@pikibun/pi-pr-flow"), /which Pikibun manages: it can't be removed/);
  await assert.rejects(f.store.remove("piki:pr-flow"), /built into the connector/);

  const again = f.host();
  await again.load();
  await again.applyManaged([pin()]);
  assert.equal(entry(again, "piki:pr-flow")!.managed?.version, "0.2.0", "a restarted connector finds it installed");
  assert.equal(f.installs.length, 1);
});

test("each failed check falls back to the bundled copy and leaves nothing installed", async t => {
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
      const loaded = entry(host, "piki:pr-flow")!;
      assert.ok(loaded.factories, "the bundled copy");
      assert.equal(loaded.summary.error, undefined);
      assert.equal(host.report().installed.length, 1);
      assert.equal(f.installs.length, item.installs);
      assert.ok(f.logs.some(line => item.reason.test(line)), f.logs.join("\n"));
      assert.deepEqual(await f.store.listManaged(), []);
      assert.deepEqual(existsSync(join(f.root, "state", "extensions", "managed")) ? await readdir(join(f.root, "state", "extensions", "managed")) : [], []);
    });
  }
});

test("a failed pin is tried again no sooner than ten minutes later", async t => {
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
});

test("--no-remote-installs, the option off, a connector run from source and an answer without pins all run the bundled copy and install nothing", async t => {
  const f = await fixture(t, { "@pikibun/pi-pr-flow": {} });
  for (const options of [{ remoteInstalls: false }, { managed: false }, { connectorVersion: "dev" }, { connectorVersion: undefined }]) {
    const host = f.host(options);
    await host.load();
    assert.equal(host.managesExtensions, false, JSON.stringify(options));
    assert.equal(await host.applyManaged([pin()]), false);
    assert.ok(entry(host, "piki:pr-flow")!.factories, JSON.stringify(options));
  }
  const host = f.host();
  await host.load();
  const report = host.report();
  assert.equal(await host.applyManaged(parseExtensionsSyncAnswer({ requests: [] }).managed), false, "a control plane from before");
  assert.deepEqual(host.report(), report);
  assert.equal(f.installs.length, 0);
});

test("a pin for a piki: name this connector doesn't know installs and loads it; where it can't, the host reports it missing with the reason", async t => {
  const f = await fixture(t, { "@pikibun/pi-hello": {} });
  const host = f.host();
  await host.load();
  assert.equal(pikiExtension("piki:hello"), undefined);
  assert.equal(await host.applyManaged([pin({ source: "piki:hello", package: "@pikibun/pi-hello", version: "1.0.0", integrity: digest("@pikibun/pi-hello@1.0.0") })]), true);
  assert.deepEqual(host.report().installed.map(item => [item.source, item.version, item.name, item.error]),
    [["piki:pr-flow", undefined, pikiExtension("piki:pr-flow")!.title, undefined], ["piki:hello", "1.0.0", "@pikibun/pi-hello", undefined]]);
  assert.deepEqual(parseHostExtensionsReport(host.report()), host.report(), "the control plane takes the report");

  assert.equal(await host.applyManaged([pin({ source: "piki:hello", package: "@pikibun/pi-hello", version: "1.1.0", integrity: digest("@pikibun/pi-hello@1.1.0"), minimumConnector: "9.0.0" })]), true);
  assert.deepEqual(host.report().installed.find(item => item.source === "piki:hello"), { source: "piki:hello", dev: false, modules: [],
    error: "@pikibun/pi-hello@1.1.0 needs connector 9.0.0 or later: update it (npx pikibun@latest connect)" });
  assert.equal(await host.applyManaged([pin({ source: "piki:gone", package: "@pikibun/pi-gone", version: "1.0.0", integrity: digest("@pikibun/pi-gone@1.0.0") })]), true);
  assert.match(host.report().installed.find(item => item.source === "piki:gone")!.error!, /404 @pikibun\/pi-gone/);
  assert.deepEqual(parseHostExtensionsReport(host.report()), host.report());
  assert.equal(host.report().installed.some(item => item.source === "piki:hello"), false, "no longer pinned, so no longer run");
  assert.equal(await host.applyManaged([]), true);
  assert.deepEqual(host.report().installed.map(item => item.source), ["piki:pr-flow"]);
});

test("a pin can't replace what the connector runs itself: its command and session-tool extensions, and the prompt audit until it can run elsewhere", async t => {
  const f = await fixture(t, { "@pikibun/pi-gh": {}, "@pikibun/pi-prompt-audit": {}, "@pikibun/pi-auto-mode": {} });
  const host = f.host({ pikiExtensions: connectorPikiExtensions });
  await host.load();
  const sources = host.loaded.map(item => item.summary.source);
  assert.equal(await host.applyManaged([pin({ source: "piki:gh", package: "@pikibun/pi-gh" }), pin({ source: "piki:prompt-audit", package: "@pikibun/pi-prompt-audit" }),
    pin({ source: "piki:auto-mode", package: "@pikibun/pi-auto-mode" })]), false);
  assert.deepEqual(host.loaded.map(item => item.summary.source), sources);
  assert.ok(host.loaded.every(item => item.factories));
  assert.equal(f.installs.length, 0);
  assert.deepEqual(connectorPikiExtensions.filter(item => item.managed).map(item => item.info.source), ["piki:pr-flow", "piki:context-files"]);
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

  await host.applyManaged([pin({ version: "0.3.0", integrity: digest("@pikibun/pi-pr-flow@0.3.0") })]);
  assert.equal(existsSync(join(f.store.directory, "managed", (await f.store.listManaged())[0]!.directory)), true,
    "a version no longer pinned stays on disk while the connector runs: an open session may still run it");
  assert.equal((await f.store.listManaged()).length, 2);
  const newest = new SessionExtensions(runner);
  await newest.ensure(host.loaded);
  assert.match(await prompt(newest), /from @pikibun\/pi-pr-flow@0.3.0/);
  assert.match(await prompt(later), /from @pikibun\/pi-pr-flow@0.2.0/);

  const restarted = f.host();
  await restarted.load();
  await restarted.applyManaged([pin({ version: "0.3.0", integrity: digest("@pikibun/pi-pr-flow@0.3.0") })]);
  assert.deepEqual((await f.store.listManaged()).map(item => item.version), ["0.3.0"], "the next start deletes what is no longer pinned");
  assert.deepEqual(await readdir(join(f.store.directory, "managed")), [(await f.store.listManaged())[0]!.directory]);
  assert.ok(f.logs.some(line => /removed @pikibun\/pi-pr-flow@0.2.0, which is no longer pinned/.test(line)));
});
