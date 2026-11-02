import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry, createRegistry, defineExtension, Harness, MemoryStorage, ToolResultEntry, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { buildExtension, resolveSettings, type ExtensionHost } from "../apps/runner/src/extensions/adapter.js";
import { loadExtensions } from "../apps/runner/src/extensions/load.js";
import { ExtensionStore, parseExtensionSource } from "../apps/runner/src/extensions/store.js";
import { hostExtensionApplies, parseHostExtensionsConfig, parseHostExtensionSummaries } from "../packages/shared/src/host-extensions.js";

const context = BACKGROUND_CONTEXT;

async function directory(t: test.TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pikibun-extensions-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

/** A store whose sources are the given local modules, by file name. */
async function storeWith(t: test.TestContext, modules: Record<string, string>): Promise<ExtensionStore> {
  const root = await directory(t);
  const store = new ExtensionStore(join(root, "state", "extensions"), async () => { throw new Error("no npm in tests"); });
  for (const [name, source] of Object.entries(modules)) {
    const file = join(root, name);
    await writeFile(file, source);
    await store.add(parseExtensionSource(file));
  }
  return store;
}

test("sources are pinned: exact npm versions, full Git commits over https, or local paths", async t => {
  assert.deepEqual(parseExtensionSource("npm:@acme/search@1.2.3"), { kind: "npm", package: "@acme/search", version: "1.2.3" });
  assert.throws(() => parseExtensionSource("npm:@acme/search@^1.2.3"), /exact version/);
  assert.throws(() => parseExtensionSource("npm:@acme/search"), /exact version/);
  assert.throws(() => parseExtensionSource("npm:@acme/search@latest"), /exact version/);
  const commit = "0123456789abcdef0123456789abcdef01234567";
  assert.deepEqual(parseExtensionSource(`git:github.com/acme/search@${commit}`), { kind: "git", url: "https://github.com/acme/search", commit });
  assert.throws(() => parseExtensionSource("git:github.com/acme/search@main"), /full commit/);
  assert.throws(() => parseExtensionSource(`git:https://user:token@github.com/acme/search@${commit}`), /without credentials/);
  const root = await directory(t);
  await writeFile(join(root, "local.js"), "export default () => {};");
  assert.deepEqual(parseExtensionSource("./local.js", root), { kind: "local", path: join(root, "local.js") });
  assert.throws(() => parseExtensionSource("./missing.js", root), /No such file/);
});

test("the connector loads each extension once and advertises what it offers", async t => {
  const store = await storeWith(t, {
    "search.mjs": `export default function (pi) {
      pi.describe("Searches the team's index.");
      pi.settings(pi.Type.Object({ endpoint: pi.Type.String({ default: "https://search.example.com" }) }));
      pi.registerTool({ name: "team_search", description: "Search the index.", parameters: pi.Type.Object({ query: pi.Type.String() }),
        execute: async args => "found " + args.query });
      pi.on("before_agent_start", () => "Use team_search for internal questions.");
      pi.on("tool_call", () => undefined);
    }`,
    "clash.mjs": `export default function (pi) { pi.registerTool({ name: "bash", description: "x", parameters: {}, execute: async () => "" }); }`,
    "repeat.mjs": `export default function (pi) { pi.registerTool({ name: "team_search", description: "x", parameters: { type: "object" }, execute: async () => "" }); }`,
    "unknown.mjs": `export default function (pi) { pi.on("session_start", () => {}); }`,
    "nofactory.mjs": `export const tool = 1;`,
    "late.mjs": `export default function (pi) { setTimeout(() => pi.registerTool({}), 0); }`,
  });
  const loaded = await loadExtensions(store);
  const byName = Object.fromEntries(loaded.map(item => [item.summary.name, item.summary]));
  assert.deepEqual(byName.search, {
    name: "search", source: `local:${store.location((await store.list())[0]!)}`, description: "Searches the team's index.",
    tools: [{ name: "team_search", description: "Search the index." }], events: ["before_agent_start", "tool_call"],
    settingsSchema: { type: "object", properties: { endpoint: { type: "string", default: "https://search.example.com" } }, required: ["endpoint"] },
  });
  assert.match(byName.clash!.error!, /one of Pikibun's own tools/);
  assert.match(byName.repeat!.error!, /Another extension has a tool named team_search/);
  assert.match(byName.unknown!.error!, /no "session_start" event/);
  assert.match(byName.nofactory!.error!, /default export must be a function/);
  assert.equal(byName.late!.error, undefined, "registering late is ignored, never thrown from a timer");
  assert.deepEqual(byName.late!.tools, []);
  assert.ok(loaded.filter(item => item.summary.error).every(item => !item.factory), "a failed extension never runs");
  // What the control plane accepts is what the connector advertises.
  assert.deepEqual(parseHostExtensionSummaries(loaded.map(item => item.summary)), loaded.map(item => item.summary));
});

test("a package names its extensions in package.json, or keeps them in extensions/", async t => {
  const root = await directory(t);
  const store = new ExtensionStore(join(root, "state"), async () => { throw new Error("no npm"); });
  const declared = join(root, "declared");
  await mkdir(join(declared, "src"), { recursive: true });
  await writeFile(join(declared, "package.json"), JSON.stringify({ name: "@acme/declared", version: "2.0.0", pikibun: { extensions: ["./src/main.mjs"] } }));
  await writeFile(join(declared, "src", "main.mjs"), "export default pi => pi.describe('declared');");
  const folder = join(root, "folder");
  await mkdir(join(folder, "extensions", "beta"), { recursive: true });
  await writeFile(join(folder, "package.json"), JSON.stringify({ name: "folder", version: "0.1.0" }));
  await writeFile(join(folder, "extensions", "alpha.mjs"), "export default pi => pi.describe('alpha');");
  await writeFile(join(folder, "extensions", "beta", "index.mjs"), "export default pi => pi.describe('beta');");
  await store.add(parseExtensionSource(declared));
  await store.add(parseExtensionSource(folder));
  const loaded = await loadExtensions(store);
  assert.deepEqual(loaded.map(item => [item.summary.name, item.summary.version, item.summary.description, item.summary.error]), [
    ["@acme/declared", "2.0.0", "declared", undefined],
    ["folder/alpha", "0.1.0", "alpha", undefined],
    ["folder/beta", "0.1.0", "beta", undefined],
  ]);
  await assert.rejects(store.add(parseExtensionSource(folder)), /already installed/);
  await store.remove(folder);
  assert.deepEqual((await store.list()).map(item => item.path), [declared]);
});

test("settings: an extension's defaults fill in, and settings that don't match its schema stop it", () => {
  const schema = { type: "object", properties: { endpoint: { type: "string", default: "https://a.example" }, limit: { type: "number" } } } as never;
  assert.deepEqual(resolveSettings("x", schema, {}), { endpoint: "https://a.example" });
  assert.deepEqual(resolveSettings("x", schema, { endpoint: "https://b.example", limit: 3 }), { endpoint: "https://b.example", limit: 3 });
  assert.throws(() => resolveSettings("x", schema, { limit: "many" }), /don't match/);
  assert.deepEqual(parseHostExtensionsConfig({ search: { enabled: true, settings: { a: 1 } } }),
    { search: { enabled: true, scope: "owner", tools: "approval", settings: { a: 1 } } });
  assert.throws(() => parseHostExtensionsConfig({ search: { enabled: true, secret: "x" } }), /Invalid extension setting/);
  assert.throws(() => parseHostExtensionsConfig({ "Bad Name": {} }), /Invalid extension name/);
});

test("scope: the owner's sessions, sessions on the host, or every session", () => {
  const owner = { ownerId: "alice", connectorOwnerId: "alice", onHost: false };
  const member = { ownerId: "bob", connectorOwnerId: "alice", onHost: false };
  const onHost = { ownerId: "bob", connectorOwnerId: "alice", onHost: true };
  const set = (scope: "owner" | "host" | "all", enabled = true) => ({ enabled, scope, tools: "approval" as const, settings: {} });
  assert.deepEqual([owner, member, onHost].map(session => hostExtensionApplies(set("owner"), session)), [true, false, false]);
  assert.deepEqual([owner, member, onHost].map(session => hostExtensionApplies(set("host"), session)), [false, false, true]);
  assert.deepEqual([owner, member, onHost].map(session => hostExtensionApplies(set("all"), session)), [true, true, true]);
  assert.equal(hostExtensionApplies(set("all", false), owner), false);
  assert.equal(hostExtensionApplies(undefined, owner), false, "an extension without a setting is off");
});

test("in a session, an extension's tool, prompt and hooks run while it applies", async t => {
  const store = await storeWith(t, {
    "shout.mjs": `export default function (pi) {
      const settings = pi.settings(pi.Type.Object({ suffix: pi.Type.String({ default: "!" }) }));
      pi.registerTool({ name: "shout", description: "Shout text.", parameters: pi.Type.Object({ text: pi.Type.String() }),
        execute: async (args, ctx) => args.text.toUpperCase() + settings().suffix + " in " + ctx.session.id });
      pi.on("before_agent_start", ctx => "Shout for " + ctx.session.owner.id + ".");
      pi.on("tool_call", call => call.name === "shout" && call.arguments.text === "forbidden" ? { block: "Not that." } : undefined);
      pi.on("tool_result", (call, result) => ({ content: [{ type: "text", text: result.content[0].text + " (checked)" }] }));
    }`,
  });
  const [loaded] = await loadExtensions(store);
  assert.equal(loaded!.summary.error, undefined);
  let active = true;
  const ran: string[] = [];
  const host: ExtensionHost = {
    session: { id: "session-1", workspaceId: "workspace", owner: { id: "alice" }, onHost: false, directory: "/tmp/session-1" },
    state: async () => ({ active, settings: { suffix: "?!" } }),
    runTool: async (call, execute) => { ran.push(`${call.extension}/${call.tool} ${JSON.stringify(call.arguments)}`); return execute(call.signal); },
    hookTimeoutMs: 1000,
    warn: () => {},
  };
  const built = await buildExtension(loaded!, host);
  assert.ok(built);
  const prompts: string[] = [];
  const faux = fauxProvider({ models: [{ id: "faux-1", name: "faux" }] });
  const respond: FauxResponseFactory = async request => {
    faux.appendResponses([respond]);
    // The system prompt is the sections its system messages show, each a patch of the ones before (null removes one).
    const shown = new Map<string, string>();
    for (const message of request.messages) {
      if (message.role !== "system" || !("sections" in message) || !message.sections) continue;
      for (const [key, value] of Object.entries(message.sections as Record<string, string | null>)) value === null ? shown.delete(key) : shown.set(key, value);
    }
    prompts.push([...shown.values()].join("\n"));
    const last = request.messages.at(-1);
    if (last?.role === "toolResult") return fauxAssistantMessage(`done: ${last.content.map(part => part.type === "text" ? part.text : "").join("")}`);
    const text = last?.role === "user" ? (typeof last.content === "string" ? last.content : "") : "";
    return fauxAssistantMessage(fauxToolCall("shout", { text }), { stopReason: "toolUse" });
  };
  faux.setResponses([respond]);
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  const workspace = defineExtension({ name: "workspace-tools", tools: [] });
  registry.install(workspace);
  registry.install(built.extension);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
  t.after(() => harness.close(context));
  const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, extensions: [workspace, built.extension], tools: built.tools } });
  const answer = async (content: string) => {
    const settled = await (await root.submit({ type: "input", content }, context)).wait(context);
    assert.equal(settled.status, "done");
    const entries = (await root.context(context)).entries;
    const results = entries.filter(entry => entry.kind === ToolResultEntry.kind);
    return { last: entries.findLast(entry => entry.kind === AssistantEntry.kind), result: results.at(-1) };
  };
  const first = await answer("hello");
  assert.match(JSON.stringify(first.result), /HELLO\?! in session-1 \(checked\)/);
  assert.match(prompts.at(-1)!, /<host_extension name="shout">\nShout for alice\.\n<\/host_extension>/);
  assert.deepEqual(ran, ['shout/shout {"text":"hello"}']);
  const blocked = await answer("forbidden");
  assert.match(JSON.stringify(blocked.result), /Not that\./);
  assert.equal(ran.length, 1, "a blocked call never reaches the session's gate");
  active = false;
  const off = await answer("again");
  assert.match(JSON.stringify(off.result), /turned off for this session/);
  assert.doesNotMatch(prompts.at(-1)!, /host_extension/, "its prompt leaves with it");
  assert.equal(ran.length, 1);
});

test("a hook that fails is skipped, except a tool_call guard, which blocks the call", async t => {
  const store = await storeWith(t, {
    "broken.mjs": `export default function (pi) {
      pi.registerTool({ name: "noop", description: "Nothing.", parameters: pi.Type.Object({}), execute: async () => "ok" });
      pi.on("before_agent_start", () => { throw new Error("prompt broke"); });
      pi.on("tool_call", () => { throw new Error("guard broke"); });
    }`,
  });
  const [loaded] = await loadExtensions(store);
  const warnings: string[] = [];
  const built = (await buildExtension(loaded!, {
    session: { id: "s", workspaceId: "w", owner: { id: "alice" }, onHost: false, directory: "/tmp/s" },
    state: async () => ({ active: true, settings: {} }),
    runTool: async (_call, execute): Promise<ToolExecutionResult> => execute(new AbortController().signal),
    hookTimeoutMs: 1000,
    warn: (name, message) => { warnings.push(`${name}: ${message}`); },
  }))!;
  const faux = fauxProvider({ models: [{ id: "faux-1", name: "faux" }] });
  const respond: FauxResponseFactory = async request => {
    faux.appendResponses([respond]);
    return request.messages.at(-1)?.role === "toolResult" ? fauxAssistantMessage("done") : fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" });
  };
  faux.setResponses([respond]);
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(built.extension);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
  t.after(() => harness.close(context));
  const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, extensions: [built.extension], tools: built.tools } });
  assert.equal((await (await root.submit({ type: "input", content: "go" }, context)).wait(context)).status, "done");
  const result = (await root.context(context)).entries.findLast(entry => entry.kind === ToolResultEntry.kind);
  assert.match(JSON.stringify(result), /guard broke/);
  assert.deepEqual(warnings, ["broken: before_agent_start: prompt broke", "broken: before_agent_start: prompt broke"]);
});
