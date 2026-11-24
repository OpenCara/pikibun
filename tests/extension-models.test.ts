import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadInstalled } from "../apps/runner/src/extensions/load.js";
import { loadProviderRegistrations, providerSources } from "../apps/runner/src/extensions/providers.js";
import { ExtensionStore } from "../apps/runner/src/extensions/store.js";
import { loadLocalPiModels } from "../apps/runner/src/local-pi.js";
import { connectorManifest } from "../apps/runner/src/connector.js";
import { connectorLimits } from "../packages/shared/src/connector.js";
import { defaultHostConfig, hostConfigLimits, ownerOnlyHostConfig, parseHostConfigChange, parseModelExtensions, readHostConfig } from "../packages/shared/src/host-config.js";

const faux = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai/providers/faux"));
const commit = "0123456789abcdef0123456789abcdef01234567";
const chat = { reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 };
const manifest = JSON.stringify({ pi: { extensions: ["./index.ts"] } });

const provider = `
import { fauxAssistantMessage, fauxProvider } from ${JSON.stringify(faux)};
const scope = globalThis as { fixtureProviderLoads?: number; fixtureProviderEvents?: string[] };
scope.fixtureProviderLoads = (scope.fixtureProviderLoads ?? 0) + 1;
export default function (pi) {
  const handle = fauxProvider({ provider: "ext-faux", models: [{ id: "one", name: "Extension one" }, { id: "two", name: "Extension two" }] });
  handle.setResponses([fauxAssistantMessage("answered by the extension's provider")]);
  pi.registerProvider(handle.provider);
  pi.registerProvider("ext-proxy", { baseUrl: "http://127.0.0.1:9/v1", apiKey: "fixture-literal-key", api: "openai-completions",
    models: [{ id: "relay", name: "Extension relay", ...${JSON.stringify(chat)} }] });
  pi.registerTool({ name: "fixture_tool", label: "Fixture", description: "Never offered from the connector's copy", parameters: { type: "object", properties: {} },
    execute: async () => { (scope.fixtureProviderEvents ??= []).push("tool"); return { content: [], details: {} }; } });
  for (const event of ["session_start", "before_agent_start", "tool_call", "input"]) pi.on(event, () => { (scope.fixtureProviderEvents ??= []).push(event); });
}
`;

const packages: Record<string, Record<string, string>> = {
  "pi-fixture-provider": { "package.json": manifest, "index.ts": provider },
  "pi-throws": { "package.json": manifest, "index.ts": `export default function () { throw new Error("the factory failed on purpose"); }\n` },
  "pi-refused": { "package.json": manifest, "index.ts": `export default function (pi) {
  pi.registerProvider("ext-early", { baseUrl: "http://127.0.0.1:9/v1", apiKey: "fixture-literal-key", api: "openai-completions", models: [{ id: "early", name: "Early", ...${JSON.stringify(chat)} }] });
  pi.registerProvider("ext-broken", { models: [{ id: "broken", name: "Broken", ...${JSON.stringify(chat)} }] });
}\n` },
  "pi-many": { "package.json": manifest, "index.ts": `export default function (pi) {
  pi.registerProvider("ext-many", { baseUrl: "http://127.0.0.1:9/v1", apiKey: "fixture-literal-key", api: "openai-completions",
    models: Array.from({ length: ${connectorLimits.models} }, (_, index) => ({ id: "model-" + index, name: "Model " + index, ...${JSON.stringify(chat)} })) });
}\n` },
  "pi-long": { "package.json": manifest, "index.ts": `export default function (pi) {
  pi.registerProvider("ext-long", { baseUrl: "http://127.0.0.1:9/v1", apiKey: "fixture-literal-key", api: "openai-completions",
    models: [{ id: "long", name: "${"n".repeat(150)}", ...${JSON.stringify(chat)} }] });
}\n` },
  "pi-none": { "package.json": manifest, "index.ts": `export default function (pi) { pi.on("session_start", () => { pi.registerProvider("ext-late", {}); }); }\n` },
  "pi-same": { "package.json": manifest, "index.ts": `export default function (pi) {
  pi.registerProvider("ext-proxy", { baseUrl: "http://127.0.0.1:9/v1", apiKey: "fixture-literal-key", api: "openai-completions", models: [{ id: "other", name: "Other", ...${JSON.stringify(chat)} }] });
}\n` },
};

async function hostFixture(t: test.TestContext, names: readonly string[]) {
  const root = await mkdtemp(join(tmpdir(), "pikibun-extension-models-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "auth.json"), "{}", { mode: 0o600 });
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "pi-own": { api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "fixture-literal-key", authHeader: false, models: [{ id: "base", name: "Pi's own" }] } } }), { mode: 0o600 });
  const store = new ExtensionStore(join(root, "state", "extensions"), async (args, cwd) => {
    const spec = args.at(-1)!;
    const name = spec.slice(0, spec.lastIndexOf("@"));
    for (const [file, text] of Object.entries(packages[name]!)) {
      await mkdir(join(cwd, "node_modules", name), { recursive: true });
      const existing = file === "package.json" ? { name, version: spec.slice(spec.lastIndexOf("@") + 1), ...JSON.parse(text) } : undefined;
      await writeFile(join(cwd, "node_modules", name, file), existing ? JSON.stringify(existing) : text);
    }
    const project = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
    project.dependencies[name] = spec.slice(spec.lastIndexOf("@") + 1);
    await writeFile(join(cwd, "package.json"), JSON.stringify(project));
  });
  for (const name of names) await store.add({ kind: "npm", package: name, version: "1.0.0" });
  const loaded = await loadInstalled(store, [], [], { describe: async () => [] });
  const marked = (...sources: string[]) => providerSources({ modelExtensions: sources }, loaded);
  return { root, agentDir, store, loaded, marked };
}

const ids = (models: readonly { provider: string; modelId: string }[]) => models.map(model => `${model.provider}/${model.modelId}`);
const scope = globalThis as { fixtureProviderLoads?: number; fixtureProviderEvents?: string[] };

test("the host owner's list names installed npm and Git sources, one version of a package, and only the owner changes it", () => {
  assert.deepEqual(defaultHostConfig.modelExtensions, []);
  assert.ok(ownerOnlyHostConfig.includes("modelExtensions"));
  assert.deepEqual(parseModelExtensions(["npm:pi-a@1.0.0", `git:github.com/acme/provider.git@${commit}`]), ["npm:pi-a@1.0.0", `git:https://github.com/acme/provider@${commit}`]);
  assert.deepEqual(parseHostConfigChange({ modelExtensions: ["npm:pi-a@1.0.0"] }), { modelExtensions: ["npm:pi-a@1.0.0"] });
  assert.throws(() => parseModelExtensions(["piki:gh"]), /only an extension installed from npm or Git/);
  assert.throws(() => parseModelExtensions(["npm:pi-a@1.0.0", "npm:pi-a@2.0.0"]), /One version/);
  assert.throws(() => parseModelExtensions(["npm:pi-a"]), /Invalid model extension/);
  assert.throws(() => parseModelExtensions(["local:/home/owner/provider.ts"]), /Invalid model extension/);
  assert.throws(() => parseModelExtensions([{ source: "npm:pi-a@1.0.0" }]), /Invalid model extension/);
  assert.throws(() => parseModelExtensions("npm:pi-a@1.0.0"), /Invalid model extensions/);
  assert.throws(() => parseModelExtensions(Array.from({ length: hostConfigLimits.modelExtensions + 1 }, (_, index) => `npm:pi-${index}@1.0.0`)), /At most 16/);
  const older = Object.fromEntries(Object.entries(defaultHostConfig).filter(([key]) => key !== "modelExtensions"));
  assert.deepEqual(readHostConfig(older).modelExtensions, [], "a Pikibun server from before the list means none");
});

test("an extension's models are offered only once the host's owner marked it, and only its providers are taken from it", async t => {
  const before = scope.fixtureProviderLoads ?? 0;
  scope.fixtureProviderEvents = [];
  const host = await hostFixture(t, ["pi-fixture-provider"]);
  const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("Loading a provider must not use the network"); });
  const local = await loadLocalPiModels({ agentDir: host.agentDir });
  assert.deepEqual(ids(await local.manifest()), ["pi-own/base"]);
  assert.equal(scope.fixtureProviderLoads ?? 0, before, "an installed extension is not loaded into the connector until it is marked");

  const none = host.marked();
  assert.deepEqual(none, { sources: [], missing: [] });
  assert.deepEqual(await local.provide!(none.sources), []);
  assert.deepEqual(ids(await local.manifest()), ["pi-own/base"]);
  assert.equal(scope.fixtureProviderLoads ?? 0, before);

  const chosen = host.marked("npm:pi-fixture-provider@1.0.0");
  assert.deepEqual(chosen.missing, []);
  assert.deepEqual(await local.provide!(chosen.sources), [{ source: "npm:pi-fixture-provider@1.0.0", providers: ["ext-proxy", "ext-faux"] }]);
  assert.deepEqual(ids(await local.manifest()), ["ext-faux/one", "ext-faux/two", "ext-proxy/relay", "pi-own/base"]);
  assert.deepEqual(ids(await connectorManifest(local)), ids(await local.manifest()), "they pass the checks every model of the manifest passes");
  assert.equal(scope.fixtureProviderLoads, before + 1);

  await local.provide!(chosen.sources);
  assert.equal(scope.fixtureProviderLoads, before + 1, "the same list loads nothing again");

  const resolved = await local.resolve({ id: "model", workspaceId: "workspace", name: "Label", provider: "ext-faux", modelId: "one", connectorId: "connector" });
  assert.ok(resolved.models instanceof ModelRuntime);
  const model = resolved.models.getModel("ext-faux", "one")!;
  const answer = await resolved.models.completeSimple(model, { messages: [{ role: "user", content: "hello", timestamp: 1 }] });
  assert.deepEqual(answer.content, [{ type: "text", text: "answered by the extension's provider" }], "a session's request goes through the extension's provider");
  assert.deepEqual(scope.fixtureProviderEvents, [], "the connector's copy runs no handler and no tool");

  assert.deepEqual(await local.provide!([]), []);
  assert.deepEqual(ids(await local.manifest()), ["pi-own/base"], "unmarking takes its models away");
  await assert.rejects(local.resolve({ id: "model", workspaceId: "workspace", name: "Label", provider: "ext-faux", modelId: "one", connectorId: "connector" }), /unavailable/);
  assert.equal(network.mock.callCount(), 0);
});

test("extension models are subject to enabledModels and to the 200-model limit", async t => {
  const host = await hostFixture(t, ["pi-fixture-provider", "pi-many", "pi-long"]);
  const scoped = await loadLocalPiModels({ agentDir: host.agentDir, enabledModels: ["ext-faux/two", "pi-own/*"] });
  assert.deepEqual(await scoped.provide!(host.marked("npm:pi-fixture-provider@1.0.0").sources), [{ source: "npm:pi-fixture-provider@1.0.0", providers: ["ext-proxy", "ext-faux"] }]);
  assert.deepEqual(ids(await scoped.manifest()), ["ext-faux/two", "pi-own/base"], "Pi's enabledModels narrows an extension's models like Pi's own");

  const local = await loadLocalPiModels({ agentDir: host.agentDir });
  const results = await local.provide!(host.marked("npm:pi-many@1.0.0", "npm:pi-fixture-provider@1.0.0", "npm:pi-long@1.0.0").sources);
  assert.match(results[0]!.error!, /exceeds 200 models/);
  assert.deepEqual(results[0]!.providers, []);
  assert.deepEqual(results[1], { source: "npm:pi-fixture-provider@1.0.0", providers: ["ext-proxy", "ext-faux"] });
  assert.match(results[2]!.error!, /longer than Pikibun takes/);
  assert.deepEqual(ids(await local.manifest()), ["ext-faux/one", "ext-faux/two", "ext-proxy/relay", "pi-own/base"], "the extension over the limit costs only its own models");
  assert.equal((await connectorManifest(local)).length, 4);

  const selected = await loadLocalPiModels({ agentDir: host.agentDir, models: [{ provider: "pi-own", modelId: "base" }] });
  assert.match((await selected.provide!(host.marked("npm:pi-fixture-provider@1.0.0").sources))[0]!.error!, /--model/);
  assert.deepEqual(ids(await selected.manifest()), ["pi-own/base"]);
});

test("an extension that throws, registers what Pi refuses, registers nothing or takes too long costs only its models", async t => {
  const host = await hostFixture(t, ["pi-throws", "pi-refused", "pi-none", "pi-fixture-provider", "pi-same"]);
  const local = await loadLocalPiModels({ agentDir: host.agentDir });
  const chosen = host.marked("npm:pi-throws@1.0.0", "npm:pi-refused@1.0.0", "npm:pi-none@1.0.0", "npm:pi-fixture-provider@1.0.0", "npm:pi-same@1.0.0");
  const results = await local.provide!(chosen.sources);
  assert.match(results[0]!.error!, /the factory failed on purpose/);
  assert.ok(results[1]!.error, "a registration ModelRuntime refuses fails the extension");
  assert.match(results[2]!.error!, /registers no provider as it loads/);
  assert.deepEqual(results[3], { source: "npm:pi-fixture-provider@1.0.0", providers: ["ext-proxy", "ext-faux"] });
  assert.match(results[4]!.error!, /Another extension already provides ext-proxy/);
  assert.deepEqual(results.map(result => result.providers.length), [0, 0, 0, 2, 0]);
  assert.deepEqual(ids(await local.manifest()), ["ext-faux/one", "ext-faux/two", "ext-proxy/relay", "pi-own/base"],
    "the provider registered before the refused one is withdrawn with it, and the working extension is offered");

  const loads = scope.fixtureProviderLoads;
  assert.deepEqual((await local.provide!(chosen.sources)).map(result => result.providers.length), [0, 0, 0, 2, 0]);
  assert.equal(scope.fixtureProviderLoads, loads, "the same list tries nothing again");
  assert.deepEqual(await local.provide!(host.marked("npm:pi-same@1.0.0").sources), [{ source: "npm:pi-same@1.0.0", providers: ["ext-proxy"] }],
    "once the list changes, an extension that failed is tried again: the one that held its provider is gone");
  assert.deepEqual(ids(await local.manifest()), ["ext-proxy/other", "pi-own/base"]);

  await assert.rejects(loadProviderRegistrations(host.loaded.find(item => item.summary.source === "npm:pi-throws@1.0.0")!.files), /the factory failed on purpose/);
  const slow = await loadLocalPiModels({ agentDir: host.agentDir, loadProviders: () => new Promise((_, reject) => { setTimeout(() => reject(new Error("It didn't load within 60 seconds")), 5); }) });
  assert.match((await slow.provide!(host.marked("npm:pi-fixture-provider@1.0.0").sources))[0]!.error!, /didn't load within/);
  assert.deepEqual(ids(await slow.manifest()), ["pi-own/base"]);
  const hanging = join(host.root, "hanging.ts");
  await writeFile(hanging, "export default async function () { await new Promise(() => {}); }\n");
  await assert.rejects(loadProviderRegistrations([hanging], 50), /didn't load within/);
});

test("only an extension the host's owner installed, at the marked version, can provide models", async t => {
  const host = await hostFixture(t, ["pi-fixture-provider"]);
  const described = (await loadInstalled(host.store, [])).find(item => item.summary.source === "npm:pi-fixture-provider@1.0.0")!;
  assert.equal(described.summary.error, undefined);
  assert.deepEqual(described.summary.modules.map(module => [module.error, module.ignored]), [[undefined, ["provider ext-proxy", "provider ext-faux"]]],
    "the extension process describes it, and still lists its providers as unsupported in sessions");
  assert.deepEqual(providerSources({ modelExtensions: ["npm:pi-fixture-provider@1.0.0"] }, [described]).sources.map(item => item.source), ["npm:pi-fixture-provider@1.0.0"]);
  await host.store.add({ kind: "local", path: join(host.root, "state", "extensions") });
  const loaded = [...await loadInstalled(host.store, [], [], { describe: async () => [] }),
    { installed: { source: "piki:gh" }, root: "", files: ["/connector/gh.ts"], factories: [], summary: { source: "piki:gh", dev: false, modules: [] } },
    { installed: { source: "piki:pr-flow" }, root: "/managed", files: ["/managed/index.ts"], managed: { source: "piki:pr-flow", package: "@pikibun/pi-pr-flow", version: "1.0.0", integrity: "sha512-x", directory: "0".repeat(16) },
      summary: { source: "piki:pr-flow", dev: false, modules: [] } },
    { installed: { source: "npm:pi-cached@1.0.0" }, root: "/cache", files: ["/cache/index.ts"], summary: { source: "npm:pi-cached@1.0.0", dev: false, modules: [] } },
    { installed: { source: "npm:pi-crashes@1.0.0", directory: "1".repeat(16), package: "pi-crashes" }, root: "/packages", files: ["/packages/index.ts"],
      summary: { source: "npm:pi-crashes@1.0.0", dev: false, modules: [], error: "Its description ended before it answered" } }];
  const local = (await host.store.list()).find(item => item.path)!.source;
  const { sources, missing } = providerSources({ modelExtensions: ["npm:pi-fixture-provider@2.0.0", "npm:pi-fixture-provider@1.0.0", "piki:gh", "piki:pr-flow", local,
    "npm:pi-cached@1.0.0", "npm:pi-crashes@1.0.0"] }, loaded);
  assert.deepEqual(sources.map(item => item.source), ["npm:pi-fixture-provider@1.0.0"]);
  assert.deepEqual(missing.map(item => [item.source, item.error]), [
    ["npm:pi-fixture-provider@2.0.0", "It isn't installed on this host at that version"],
    ["piki:gh", "Only an extension installed from npm or Git provides models"],
    ["piki:pr-flow", "Only an extension installed from npm or Git provides models"],
    [local, "Only an extension installed from npm or Git provides models"],
    ["npm:pi-cached@1.0.0", "It isn't installed on this host at that version"],
    ["npm:pi-crashes@1.0.0", "Its description ended before it answered"],
  ]);
});
