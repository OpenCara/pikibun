import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createRegistry, defineExtension, Harness, MemoryStorage, ToolResultEntry, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { addedPrompt, ExtensionPrompts, SessionExtensions, settleToolNames, type ExtensionHost } from "../apps/runner/src/extensions/adapter.js";
import { HostExtensions } from "../apps/runner/src/extensions/host.js";
import { RunnerService } from "../apps/runner/src/server.js";
import { sha256 } from "../packages/shared/src/crypto.js";
import type { ApprovalRecord, RunnerAction, RunnerBinding } from "../packages/shared/src/types.js";
import { loadInstalled } from "../apps/runner/src/extensions/load.js";
import { ExtensionStore, parseExtensionSource } from "../apps/runner/src/extensions/store.js";
import { extensionAvailability, extensionPackageKey, normalizeExtensionSource, parseHostExtensionsReport, parseWorkspaceExtensions,
  sessionExtensions, type ExtensionSettings, type InstalledExtension } from "../packages/shared/src/host-extensions.js";
import { extensionOffer, workspaceTools } from "../packages/shared/src/workspace-tools.js";

const context = BACKGROUND_CONTEXT;

async function directory(t: test.TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pikibun-extensions-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function storeWith(t: test.TestContext, packages: Record<string, Record<string, string>> = {}): Promise<{ store: ExtensionStore; root: string }> {
  const root = await directory(t);
  const store = new ExtensionStore(join(root, "state", "extensions"), async (args, cwd) => {
    const spec = args.at(-1)!;
    const name = spec.slice(0, spec.lastIndexOf("@"));
    const files = packages[name];
    if (!files) throw new Error(`no package ${name}`);
    for (const [file, text] of Object.entries(files)) {
      await mkdir(join(cwd, "node_modules", name, file, ".."), { recursive: true });
      await writeFile(join(cwd, "node_modules", name, file), text);
    }
    const manifest = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
    manifest.dependencies[name] = spec.slice(spec.lastIndexOf("@") + 1);
    await writeFile(join(cwd, "package.json"), JSON.stringify(manifest));
  });
  return { store, root };
}

test("sources are pinned and normalized; a workspace uses one version of each package", () => {
  assert.equal(normalizeExtensionSource("npm:@acme/search@1.2.3"), "npm:@acme/search@1.2.3");
  const commit = "0123456789abcdef0123456789abcdef01234567";
  assert.equal(normalizeExtensionSource(`git:github.com/acme/search.git@${commit}`), `git:https://github.com/acme/search@${commit}`);
  assert.equal(extensionPackageKey(`git:https://github.com/acme/search@${commit}`), "git:https://github.com/acme/search");
  for (const bad of ["npm:@acme/search@^1.2.3", "npm:@acme/search", "npm:@acme/search@latest", "git:github.com/acme/search@main",
    `git:https://user:token@github.com/acme/search@${commit}`, "http://example.com/x", "./local.ts"]) {
    assert.throws(() => normalizeExtensionSource(bad), /./, bad);
  }
  assert.deepEqual(parseWorkspaceExtensions([{ source: "npm:a@1.0.0" }]), [{ source: "npm:a@1.0.0", enabled: true, tools: "automatic", settings: {} }]);
  assert.deepEqual(parseWorkspaceExtensions([{ source: "npm:a@1.0.0", tools: "approval" }]), [{ source: "npm:a@1.0.0", enabled: true, tools: "automatic", settings: {} }],
    "a setting from before approvals were removed runs alike");
  assert.throws(() => parseWorkspaceExtensions([{ source: "npm:a@1.0.0" }, { source: "npm:a@2.0.0" }]), /one version/);
  assert.throws(() => parseWorkspaceExtensions([{ source: "npm:a@1.0.0", settings: { key: { nested: true } } }]), /true, false or text/);
  assert.throws(() => parseWorkspaceExtensions([{ source: "npm:a@1.0.0", secret: "x" }]), /Invalid extension/);
});

test("a session runs with the workspace's enabled extensions its host has at that version, and its owner's dev extensions", () => {
  const installed: InstalledExtension[] = [
    { source: "npm:a@1.0.0", dev: false, modules: [] }, { source: "npm:b@2.0.0", dev: false, modules: [] },
    { source: "npm:broken@1.0.0", dev: false, modules: [], error: "no" }, { source: "local:/home/alice/dev.ts", dev: true, modules: [] },
  ];
  const workspace = parseWorkspaceExtensions([{ source: "npm:a@1.0.0" }, { source: "npm:b@1.0.0" }, { source: "npm:c@1.0.0" },
    { source: "npm:broken@1.0.0" }]);
  assert.deepEqual(workspace.map(item => extensionAvailability(item.source, installed).status), ["installed", "other-version", "missing", "installed"]);
  const owner = sessionExtensions(workspace, installed, { ownerId: "alice", connectorOwnerId: "alice" });
  assert.deepEqual(owner.map(item => [item.source, item.dev]), [["npm:a@1.0.0", false], ["local:/home/alice/dev.ts", true]]);
  const member = sessionExtensions(workspace, installed, { ownerId: "bob", connectorOwnerId: "alice" });
  assert.deepEqual(member.map(item => item.source), ["npm:a@1.0.0"], "dev extensions run only in the host owner's own sessions");
  const disabled = sessionExtensions([{ ...workspace[0]!, enabled: false }], installed, { ownerId: "bob", connectorOwnerId: "alice" });
  assert.deepEqual(disabled, []);
});

test("Pi extensions load through Pi's own loader, and the host reports what each offers, does nothing with, or ignores", async t => {
  const { store, root } = await storeWith(t, {
    "pi-search": {
      "package.json": JSON.stringify({ name: "pi-search", version: "1.0.0", description: "Searches.", pi: { extensions: ["./src/index.ts"] } }),
      "src/index.ts": `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
        import { Type } from "typebox";
        export default function (pi: ExtensionAPI) {
          pi.registerFlag("endpoint", { description: "Where to search", type: "string", default: "https://search.example.com" });
          pi.registerTool({ name: "team_search", label: "Search", description: "Search the index.", parameters: Type.Object({ query: Type.String() }),
            async execute(_id, params) { return { content: [{ type: "text", text: "found " + params.query }], details: undefined }; } });
          pi.registerTool({ name: "read_file", label: "Read", description: "Mine.", parameters: Type.Object({}), async execute() { return { content: [], details: undefined }; } });
          pi.registerTool({ name: "web_search", label: "Web", description: "Search the web.", parameters: Type.Object({}), async execute() { return { content: [], details: undefined }; } });
          pi.registerCommand("search", { description: "x", handler: async () => {} });
          pi.registerProvider("proxy", { baseUrl: "https://proxy.example.com", api: "openai-completions", apiKey: "x", models: [] });
          pi.on("tool_call", () => undefined);
          pi.on("user_bash", () => undefined);
        }`,
    },
    "not-an-extension": { "package.json": JSON.stringify({ name: "not-an-extension", version: "1.0.0" }), "index.js": "module.exports = () => {};" },
  });
  await store.add(parseExtensionSource("npm:pi-search@1.0.0"));
  await store.add(parseExtensionSource("npm:not-an-extension@1.0.0"));
  await writeFile(join(root, "dev.ts"), `export default function (pi) { pi.on("session_start", () => {}); }`);
  await store.add(parseExtensionSource(join(root, "dev.ts")));
  await writeFile(join(root, "broken.ts"), `export default function (pi) { throw new Error("broken on purpose"); }`);
  await store.add(parseExtensionSource(join(root, "broken.ts")));
  const loaded = await loadInstalled(store, []);
  const [search, notExtension, dev, broken] = loaded.map(item => item.summary);
  assert.deepEqual(search, { source: "npm:pi-search@1.0.0", dev: false, name: "pi-search", version: "1.0.0", description: "Searches.", modules: [{
    path: "src/index.ts", tools: [{ name: "team_search", description: "Search the index." }, { name: "web_search", description: "Search the web." }], events: ["tool_call"],
    flags: [{ name: "endpoint", type: "string", description: "Where to search", default: "https://search.example.com" }],
    noops: ["/search"], ignored: ["tool read_file (one of Pikibun's own)", "user_bash event", "provider proxy"],
  }] });
  assert.match(notExtension!.error!, /isn't a Pi extension package/);
  assert.equal(dev!.dev, true);
  assert.deepEqual(dev!.modules[0]!.events, ["session_start"]);
  assert.match(broken!.modules[0]!.error!, /broken on purpose/);
  const report = { installed: loaded.map(item => item.summary), remoteInstalls: true };
  assert.deepEqual(parseHostExtensionsReport(report), report);
  await assert.rejects(store.add(parseExtensionSource("npm:missing@1.0.0")), /no package missing/);
  assert.equal((await store.list()).length, 4, "a failed install leaves nothing behind");
  await store.remove("pi-search");
  assert.deepEqual((await store.list()).map(item => item.source), ["npm:not-an-extension@1.0.0", `local:${join(root, "dev.ts")}`, `local:${join(root, "broken.ts")}`]);
});

test("the workspace page reads a host's real report: a tool named like one of Pikibun's own shows as left out, with its kept tools beside it", async t => {
  const { store } = await storeWith(t, {
    "pi-shell-helpers": {
      "package.json": JSON.stringify({ name: "pi-shell-helpers", version: "1.0.0", description: "Shell helpers.", pi: { extensions: ["./index.ts"] } }),
      "index.ts": `import { Type } from "typebox";
        export default function (pi) {
          for (const name of ["read_file", "lint", "git"]) pi.registerTool({ name, label: name, description: name + ", the extension's way.", parameters: Type.Object({}),
            async execute() { return { content: [], details: undefined }; } });
        }`,
    },
  });
  await store.add(parseExtensionSource("npm:pi-shell-helpers@1.0.0"));
  const [summary] = (await loadInstalled(store, [])).map(item => item.summary);
  assert.deepEqual(summary!.modules[0]!.tools.map(tool => tool.name), ["lint"]);
  const offer = extensionOffer("npm:pi-shell-helpers@1.0.0", [summary!]);
  assert.equal(offer?.description, "Shell helpers.");
  assert.deepEqual(offer?.tools.map(tool => [tool.name, !!tool.own]), [["lint", false], ["read_file", true], ["git", true]]);
  const usable = workspaceTools([{ source: "npm:pi-shell-helpers@1.0.0", enabled: true, tools: "approval", settings: {} }], [summary!]);
  assert.deepEqual(usable.shadowed, [
    { name: "read_file", source: "npm:pi-shell-helpers@1.0.0", by: "piki:files", kind: "own" },
    { name: "git", source: "npm:pi-shell-helpers@1.0.0", by: "piki:git", kind: "own" },
  ]);
  assert.deepEqual(usable.tools.filter(tool => tool.origin === "extension").map(tool => tool.name), ["lint"]);
});

test("a directory a package names loads as Pi loads it: its index alone, if it has one, else every module in it", async t => {
  const exits = `process.exit(3);`;
  const { store } = await storeWith(t, {
    "pi-bundled": {
      "package.json": JSON.stringify({ name: "pi-bundled", version: "1.0.0", pi: { extensions: ["./dist"] } }),
      "dist/index.js": `export default function (pi) { pi.on("session_start", () => {}); }`,
      "dist/mcp-cli.js": exits,
    },
    "pi-several": {
      "package.json": JSON.stringify({ name: "pi-several", version: "1.0.0", pi: { extensions: ["./extensions"] } }),
      "extensions/a.js": `export default function (pi) { pi.on("agent_start", () => {}); }`,
      "extensions/b/index.js": `export default function (pi) { pi.on("agent_end", () => {}); }`,
      "extensions/b/cli.js": exits,
    },
  });
  await store.add(parseExtensionSource("npm:pi-bundled@1.0.0"));
  await store.add(parseExtensionSource("npm:pi-several@1.0.0"));
  const [bundled, several] = (await loadInstalled(store)).map(item => item.summary).filter(item => item.source.startsWith("npm:"));
  assert.deepEqual(bundled!.modules.map(module => [module.path, module.events]), [["dist/index.js", ["session_start"]]]);
  assert.deepEqual(several!.modules.map(module => [module.path, module.events]), [["extensions/a.js", ["agent_start"]], ["extensions/b/index.js", ["agent_end"]]]);
});

test("system prompt changes become the text they add", () => {
  assert.equal(addedPrompt("Base.", "Base.\n\nExtra."), "Extra.");
  assert.equal(addedPrompt("A\nB", "A\nInserted\nB"), "Inserted");
  assert.equal(addedPrompt("Same", "Same"), "");
});

async function session(t: test.TestContext, source: string, root: string, options: { tool: string; settings?: ExtensionSettings; active?: () => boolean }) {
  const store = new ExtensionStore(join(root, "state"));
  await store.add(parseExtensionSource(source));
  const loaded = await loadInstalled(store, []);
  assert.equal(loaded[0]!.summary.error, undefined);
  const ran: string[] = [];
  const warnings: string[] = [];
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false } as never);
  const host: ExtensionHost = {
    directory: root, modelRegistry: new ModelRegistry(runtime), model: () => undefined,
    state: async () => ({ active: options.active?.() ?? true, settings: options.settings ?? {} }),
    runTool: async (call, execute): Promise<ToolExecutionResult> => { ran.push(`${call.tool} ${JSON.stringify(call.arguments)}`); return execute(call.signal); },
    hookTimeoutMs: 2000, warn: (_source, message) => { warnings.push(message); },
  };
  const extensions = new SessionExtensions(host, ["bash", "read_file"]);
  await extensions.ensure(loaded);
  t.after(() => extensions.shutdown());
  const prompts: string[] = [];
  const faux = fauxProvider({ models: [{ id: "faux-1", name: "faux" }] });
  const respond: FauxResponseFactory = async request => {
    faux.appendResponses([respond]);
    const shown = new Map<string, string>();
    for (const message of request.messages) {
      if (message.role !== "system" || !("sections" in message) || !message.sections) continue;
      for (const [key, value] of Object.entries(message.sections as Record<string, string | null>)) value === null ? shown.delete(key) : shown.set(key, value);
    }
    prompts.push([...shown.values()].join("\n"));
    const last = request.messages.findLast(message => message.role !== "system");
    if (last?.role === "toolResult") return fauxAssistantMessage(`done: ${last.content.map(part => part.type === "text" ? part.text : "").join("")}`);
    const text = last?.role === "user" ? (typeof last.content === "string" ? last.content : "") : "";
    return fauxAssistantMessage(fauxToolCall(options.tool, { text }), { stopReason: "toolUse" });
  };
  faux.setResponses([respond]);
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  const workspace = defineExtension({ name: "workspace-tools", tools: [] });
  registry.install(workspace);
  const { selected, created } = extensions.select(loaded.map(item => item.summary.source));
  for (const extension of created) registry.install(extension);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
  t.after(() => harness.close(context));
  const root_ = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" },
    extensions: [workspace, ...selected.map(item => item.extension)], tools: selected.flatMap(item => item.tools) } });
  await extensions.sessionStart();
  const answer = async (content: string) => {
    const added = await extensions.beforeAgentStart(content, undefined);
    await root_.commit(async tx => { (await tx.doc(ExtensionPrompts, root_.id)).prompts = added; }, context);
    const settled = await (await root_.submit({ type: "input", content }, context)).wait(context);
    assert.equal(settled.status, "done");
    return (await root_.context(context)).entries.filter(entry => entry.kind === ToolResultEntry.kind).at(-1);
  };
  return { answer, ran, warnings, prompts };
}

test("in a session, a Pi extension's tool, flags, prompt and hooks run while it applies", async t => {
  const root = await directory(t);
  await writeFile(join(root, "shout.ts"), `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
    import { Type } from "typebox";
    export default function (pi: ExtensionAPI) {
      pi.registerFlag("suffix", { type: "string", default: "!" });
      let starts = 0;
      pi.on("session_start", () => { starts++; });
      pi.registerTool({ name: "shout", label: "Shout", description: "Shout text.", parameters: Type.Object({ text: Type.String() }),
        async execute(id, params, signal, onUpdate, ctx) {
          const ui = await ctx.ui.confirm("Really?", "Shout?");
          return { content: [{ type: "text", text: params.text.toUpperCase() + pi.getFlag("suffix") + " starts=" + starts + " ui=" + ui + " hasUI=" + ctx.hasUI }], details: undefined };
        } });
      pi.on("before_agent_start", (event) => ({ systemPrompt: event.systemPrompt + "\\n\\nShout about: " + event.prompt }));
      pi.on("tool_call", (event) => {
        if (event.toolName === "shout" && event.input.text === "forbidden") return { block: true, reason: "Not that." };
        if (event.toolName === "shout" && event.input.text === "quiet") event.input.text = "loud";
      });
      pi.on("tool_result", (event) => ({ content: [{ type: "text", text: event.content[0].text + " (checked)" }] }));
      pi.registerCommand("shout", { description: "x", handler: async (_args, ctx) => { ctx.ui.notify("hi"); } });
    }`);
  let active = true;
  const s = await session(t, join(root, "shout.ts"), root, { tool: "shout", settings: { suffix: "?!" }, active: () => active });
  const first = await s.answer("hello");
  assert.match(JSON.stringify(first), /HELLO\?! starts=1 ui=false hasUI=false \(checked\)/, "flags come from the workspace's settings; the UI is print mode's");
  assert.match(s.prompts.at(-1)!, /<extension source="local:[^"]+shout\.ts">\nShout about: hello\n<\/extension>/);
  assert.deepEqual(s.ran, ['shout {"text":"hello"}']);
  assert.match(JSON.stringify(await s.answer("forbidden")), /Not that\./);
  assert.equal(s.ran.length, 1, "a blocked call never reaches the session's gate");
  assert.match(JSON.stringify(await s.answer("quiet")), /LOUD/, "a tool_call handler changes the call's input");
  assert.deepEqual(s.ran.at(-1), 'shout {"text":"loud"}');
  active = false;
  assert.match(JSON.stringify(await s.answer("again")), /no longer applies/);
  assert.doesNotMatch(s.prompts.at(-1)!, /<extension/, "its prompt leaves with it");
  assert.equal(s.ran.length, 2);
});

test("an extension hears tool_result only of calls that ran, and tool_execution_end only after its tool_execution_start", async t => {
  const events: string[] = [];
  (globalThis as { __toolEvents?: string[] }).__toolEvents = events;
  t.after(() => { delete (globalThis as { __toolEvents?: string[] }).__toolEvents; });
  const listener = (tool: string) => `import { Type } from "typebox";
    export default function (pi) {
      const log = (event) => globalThis.__toolEvents.push(event);
      pi.registerTool({ name: "${tool}", label: "Echo", description: "Echo text.", parameters: Type.Object({ text: Type.String() }),
        async execute(_id, params) { return { content: [{ type: "text", text: params.text }], details: undefined }; } });
      pi.on("tool_call", (event) => { log("call " + event.input.text); if (event.input.text === "forbidden") return { block: true, reason: "Not that." }; });
      pi.on("tool_execution_start", (event) => log("start " + event.args.text));
      pi.on("tool_result", (event) => log("result " + event.content[0].text));
      pi.on("tool_execution_end", (event) => log("end " + event.isError + " " + JSON.stringify(event.result)));
    }`;
  const root = await directory(t);
  await writeFile(join(root, "echo.ts"), listener("echo"));
  const s = await session(t, join(root, "echo.ts"), root, { tool: "echo" });
  await s.answer("hello");
  assert.deepEqual(events.splice(0), ["start hello", "call hello", "result hello", 'end false [{"type":"text","text":"hello"}]']);
  assert.match(JSON.stringify(await s.answer("forbidden")), /Not that\./);
  assert.deepEqual(events.splice(0), ["start forbidden", "call forbidden", 'end true [{"type":"text","text":"Tool call blocked: Not that."}]'],
    "a blocked call never ran: its end says why, and no tool_result handler sees it");
  const other = await directory(t);
  await writeFile(join(other, "echo.ts"), listener("echo"));
  const missing = await session(t, join(other, "echo.ts"), other, { tool: "missing" });
  assert.match(JSON.stringify(await missing.answer("lost")), /not available/);
  assert.deepEqual(events, []);
});

test("an extension's handler that fails is skipped, except a tool_call guard, which blocks the call", async t => {
  const root = await directory(t);
  await writeFile(join(root, "broken.ts"), `import { Type } from "typebox";
    export default function (pi) {
      pi.registerTool({ name: "noop", label: "Noop", description: "Nothing.", parameters: Type.Object({ text: Type.String() }),
        async execute() { return { content: [{ type: "text", text: "ok" }], details: undefined }; } });
      pi.on("before_agent_start", () => { throw new Error("prompt broke"); });
      pi.on("tool_call", () => { throw new Error("guard broke"); });
    }`);
  const s = await session(t, join(root, "broken.ts"), root, { tool: "noop" });
  assert.match(JSON.stringify(await s.answer("go")), /guard broke/);
  assert.deepEqual(s.ran, []);
  assert.ok(s.warnings.some(warning => /prompt broke/.test(warning)));
});

test("a host carries out the installs its owner asks for in Pikibun, unless it refuses them, and caches each workspace's choice", async t => {
  const { store } = await storeWith(t, {
    "pi-a": { "package.json": JSON.stringify({ name: "pi-a", version: "1.0.0", pi: { extensions: ["./index.js"] } }), "index.js": "export default function () {}" },
  });
  const host = new HostExtensions(store, { remoteInstalls: true, pikiExtensions: [] });
  await host.load();
  assert.deepEqual(host.report(), { installed: [], remoteInstalls: true });
  assert.deepEqual(await host.apply([{ id: "r1", action: "install", source: "npm:pi-a@1.0.0" }, { id: "r2", action: "install", source: "npm:missing@1.0.0" }]),
    [{ id: "r1", ok: true }, { id: "r2", ok: false, error: "no package missing" }]);
  assert.deepEqual(host.report().installed.map(item => item.source), ["npm:pi-a@1.0.0"]);
  assert.deepEqual(await host.apply([{ id: "r3", action: "install", source: "npm:pi-a@1.0.0" }]), [{ id: "r3", ok: true }], "already installed is done");
  assert.deepEqual(await host.apply([{ id: "r4", action: "remove", source: "npm:pi-a@1.0.0" }, { id: "r5", action: "remove", source: "npm:pi-a@1.0.0" }]),
    [{ id: "r4", ok: true }, { id: "r5", ok: true }]);
  assert.deepEqual(host.report().installed, []);
  const refusing = new HostExtensions(store, { remoteInstalls: false, pikiExtensions: [] });
  assert.match((await refusing.apply([{ id: "r6", action: "install", source: "npm:pi-a@1.0.0" }]))[0]!.error!, /--no-remote-installs/);

  let now = 0;
  let answer: unknown = { extensions: [{ source: "npm:pi-a@1.0.0" }], automaticTools: false };
  let asked = 0;
  const cached = new HostExtensions(store, { remoteInstalls: true, now: () => now, pikiExtensions: [] });
  const fetch = async () => { asked++; if (answer instanceof Error) throw answer; return answer; };
  assert.equal((await cached.workspace("w", fetch)).extensions[0]!.source, "npm:pi-a@1.0.0");
  now = 29_000;
  await cached.workspace("w", fetch);
  assert.equal(asked, 1, "asked again only after 30 seconds");
  answer = new Error("offline");
  now = 31_000;
  assert.equal((await cached.workspace("w", fetch)).extensions.length, 1, "a brief outage keeps the last answer");
  now = 6 * 60_000;
  assert.deepEqual(await cached.workspace("w", fetch), { extensions: [], automaticTools: false }, "a long one runs without extensions");
  assert.equal(cached.lastKnown("w")!.extensions[0]!.source, "npm:pi-a@1.0.0", "the last answer read is kept, however old, for fail-closed session tools");
  assert.equal(cached.lastKnown("other"), undefined, "none for a workspace never read");
  answer = { extensions: [], automaticTools: false };
  now = 7 * 60_000;
  await cached.workspace("w", fetch);
  assert.deepEqual(cached.lastKnown("w"), { extensions: [], automaticTools: false }, "a new answer replaces it");
});

test("an extension's tool runs only where the host's owner lets it, never in a Read-only message, and asks nobody", { skip: !["linux", "darwin"].includes(process.platform) }, async t => {
  const root = await realpath(await directory(t));
  await writeFile(join(root, "shout.ts"), `import { Type } from "typebox";
    export default function (pi) {
      pi.registerTool({ name: "shout", label: "Shout", description: "Shout text.", parameters: Type.Object({ text: Type.String() }),
        async execute(_id, params) { return { content: [{ type: "text", text: params.text.toUpperCase() + "!" }], details: undefined }; } });
    }`);
  const store = new ExtensionStore(join(root, "state"));
  await store.add(parseExtensionSource(join(root, "shout.ts")));
  const [dev] = await loadInstalled(store, []);
  const installed = [{ ...dev!, summary: { ...dev!.summary, source: "npm:shout@1.0.0", dev: false } }];
  let answer = { extensions: parseWorkspaceExtensions([{ source: "npm:shout@1.0.0" }]), automaticTools: false };
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  const respond: FauxResponseFactory = async request => {
    faux.appendResponses([respond]);
    const last = request.messages.findLast(message => message.role !== "system");
    if (last?.role === "toolResult") return fauxAssistantMessage(`done: ${last.content.map(part => part.type === "text" ? part.text : "").join("")}`);
    return fauxAssistantMessage(fauxToolCall("shout", { text: typeof last?.content === "string" ? last.content : "" }), { stopReason: "toolUse" });
  };
  faux.setResponses([respond]);
  const models = createModels(); models.setProvider(faux.provider);
  const target: RunnerBinding = {
    session: { id: "extension-session", workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1", title: "Extensions", policyVersion: 1, status: "ready",
      createdAt: "2026-01-01T00:00:00Z", repositories: [], repositoryMode: "clone", connectorId: "host-connector", connectorOwnerId: "test:bob" },
    owner: { id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice", gitEmail: "alice@example.test", env: {}, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: "test:alice", workspaceId: "workspace", version: 1, name: "Agent", description: "", instructions: "Use tools.", tools: ["read_file"], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "workspace", name: "Model", provider: "faux", modelId: "faux-1", connectorId: "host-connector", connectorOwnerId: "test:bob" },
  };
  const service = new RunnerService({
    dataDir: join(root, "runner"), sharedSecret: "extension-test-secret-not-for-deployment", controlPlaneUrl: "http://127.0.0.1:8787",
    connectorId: "host-connector", allowFaux: true, unsandboxed: true,
    authorize: async input => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    extensions: { installed: () => installed, workspace: async () => answer },
  });
  await service.initialize();
  t.after(() => service.close());
  const claims = async (action: RunnerAction, actorId = "test:alice", body = "") => {
    const now = Math.floor(Date.now() / 1000);
    return { aud: "runner" as const, sessionId: target.session.id, actorId, ownerId: "test:alice", action, policyVersion: 1, iat: now, exp: now + 60,
      jti: randomUUID(), bodyHash: await sha256(body), connectorId: "host-connector" };
  };
  const session = await service.provision(target, await claims("create"));
  const send = async (content: string, access: "read" | "approval" | "auto") =>
    session.submit(await claims("submit"), { content, requestId: content, admissionId: await sha256(content), options: { access } }, "write");
  const idle = async () => {
    for (let count = 0; count < 500 && (await session.view()).busy; count++) await delay(20);
  };
  const results = async () => (await session.view()).entries.filter(entry => entry.role === "toolResult").map(entry => entry.text);

  const records = async () => Object.values((await (session as unknown as { metadata(): Promise<{ approvals: Record<string, ApprovalRecord> }> }).metadata()).approvals);
  await send("hello", "auto");
  await idle();
  assert.match((await results()).at(-1)!, /shout comes from an extension, which runs on the host's own machine/, "the session's owner has no host command grant");
  assert.deepEqual(await records(), []);
  assert.deepEqual((await session.view()).extensions, { running: [{ source: "npm:shout@1.0.0", dev: false, tools: ["shout"] }], missing: [], builtin: ["pi:codemode"],
    unavailable: [{ source: "piki:browser", tools: ["browser"], reason: "on-host" }] });

  answer = { ...answer, automaticTools: true };
  await new Promise(resolve => setTimeout(resolve, 10));
  await send("quietly", "read");
  await idle();
  assert.match((await results()).at(-1)!, /Read-only message doesn't run it/);

  await send("now", "approval");
  await idle();
  const automatic = (await records()).at(-1)!;
  assert.deepEqual(automatic.operation, { kind: "extension.tool", source: "npm:shout@1.0.0", tool: "shout", arguments: '{"text":"now"}',
    digest: createHash("sha256").update('{"text":"now"}').digest("hex") });
  assert.match((await results()).at(-1)!, /NOW!/);
  assert.deepEqual((await session.view()).approvals, []);

  answer = { extensions: parseWorkspaceExtensions([{ source: "npm:shout@2.0.0" }]), automaticTools: true };
  assert.deepEqual((await session.view()).extensions, { running: [], missing: ["npm:shout@2.0.0"], builtin: ["pi:codemode"],
    unavailable: [{ source: "piki:browser", tools: ["browser"], reason: "on-host" }] });
  installed.push({ ...dev!, summary: { ...dev!.summary, source: "npm:shout@2.0.0", dev: false } });
  answer = { extensions: parseWorkspaceExtensions([{ source: "npm:shout@2.0.0", tools: "automatic" }]), automaticTools: true };
  assert.deepEqual((await session.view()).extensions, { running: [{ source: "npm:shout@2.0.0", dev: false, tools: ["shout"] }], missing: [], builtin: ["pi:codemode"],
    unavailable: [{ source: "piki:browser", tools: ["browser"], reason: "on-host" }] });
  await send("upgraded", "approval");
  await idle();
  const upgraded = (await records()).at(-1)!;
  assert.equal(upgraded.operation.kind === "extension.tool" && upgraded.operation.source, "npm:shout@2.0.0");
  assert.match((await results()).at(-1)!, /UPGRADED!/);
  answer = { extensions: [], automaticTools: true };
  await send("gone", "approval");
  await idle();
  assert.doesNotMatch((await results()).at(-1)!, /GONE!/);
});

test("a Pikibun extension's command runs with the host's own sign-in only where the session itself runs on its host", { skip: !["linux", "darwin"].includes(process.platform) }, async t => {
  const root = await realpath(await directory(t));
  await mkdir(join(root, "bin"));
  await writeFile(join(root, "bin", "gh"), "#!/bin/sh\necho \"gh ran: $*\"\n", { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${join(root, "bin")}:${path}`;
  t.after(() => { process.env.PATH = path; });
  const installed = await loadInstalled(new ExtensionStore(join(root, "state")));
  const answer = { extensions: parseWorkspaceExtensions([{ source: "piki:gh", tools: "automatic" }]), automaticTools: true };
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  const respond: FauxResponseFactory = async request => {
    faux.appendResponses([respond]);
    const last = request.messages.findLast(message => message.role !== "system");
    if (last?.role === "toolResult") return fauxAssistantMessage("done");
    return fauxAssistantMessage(fauxToolCall("gh", { args: ["pr", "list"] }), { stopReason: "toolUse" });
  };
  faux.setResponses([respond]);
  const models = createModels(); models.setProvider(faux.provider);
  const target: RunnerBinding = {
    session: { id: "piki-session", workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1", title: "Pikibun extensions", policyVersion: 1, status: "ready",
      createdAt: "2026-01-01T00:00:00Z", repositories: [], repositoryMode: "clone", connectorId: "host-connector", connectorOwnerId: "test:alice" },
    owner: { id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice", gitEmail: "alice@example.test", env: {}, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: "test:alice", workspaceId: "workspace", version: 1, name: "Agent", description: "", instructions: "Use tools.", tools: ["read_file"], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "workspace", name: "Model", provider: "faux", modelId: "faux-1", connectorId: "host-connector", connectorOwnerId: "test:alice" },
  };
  const service = new RunnerService({
    dataDir: join(root, "runner"), sharedSecret: "extension-test-secret-not-for-deployment", controlPlaneUrl: "http://127.0.0.1:8787",
    connectorId: "host-connector", allowFaux: true, unsandboxed: true,
    authorize: async input => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    extensions: { installed: () => installed, workspace: async () => answer },
  });
  await service.initialize();
  t.after(() => service.close());
  const now = Math.floor(Date.now() / 1000);
  const claims = async (action: RunnerAction, body = "") => ({ aud: "runner" as const, sessionId: target.session.id, actorId: "test:alice", ownerId: "test:alice", action,
    policyVersion: 1, iat: now, exp: now + 60, jti: randomUUID(), bodyHash: await sha256(body), connectorId: "host-connector" });
  const session = await service.provision(target, await claims("create"));
  await session.submit(await claims("submit"), { content: "list them", requestId: "list", admissionId: await sha256("list"), options: { access: "approval" } }, "write");
  for (let count = 0; count < 500 && (await session.view()).busy; count++) await delay(20);
  const card = Object.values((await (session as unknown as { metadata(): Promise<{ approvals: Record<string, ApprovalRecord> }> }).metadata()).approvals).at(-1)!;
  assert.deepEqual([card.operation.kind, card.status, card.result], ["extension.tool", "executed", "gh ran: pr list"]);
});

test("tool name clashes are settled per selection: another version of an extension gets its tools in an open session", async t => {
  const root = await directory(t);
  const module = (version: string) => `import { Type } from "typebox";
    export default function (pi) {
      pi.registerTool({ name: "shout", label: "Shout", description: "Shout ${version}.", parameters: Type.Object({}),
        async execute() { return { content: [{ type: "text", text: "${version}" }], details: undefined }; } });
      pi.registerTool({ name: "bash", label: "Bash", description: "Mine.", parameters: Type.Object({}), async execute() { return { content: [], details: undefined }; } });
    }`;
  await writeFile(join(root, "v1.ts"), module("v1"));
  await writeFile(join(root, "v2.ts"), module("v2"));
  const store = new ExtensionStore(join(root, "state"));
  await store.add(parseExtensionSource(join(root, "v1.ts")));
  await store.add(parseExtensionSource(join(root, "v2.ts")));
  const loaded = await loadInstalled(store, []);
  const [one, two] = loaded.map(item => item.summary.source);
  const warnings: string[] = [];
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false } as never);
  const extensions = new SessionExtensions({ directory: root, modelRegistry: new ModelRegistry(runtime), model: () => undefined, state: async () => ({ active: true, settings: {} }),
    runTool: async (call, execute) => execute(call.signal), hookTimeoutMs: 1000, warn: (_source, message) => { warnings.push(message); } }, ["bash"]);
  t.after(() => extensions.shutdown());
  await extensions.ensure(loaded);
  const names = (selection: ReturnType<SessionExtensions["select"]>) => selection.selected.map(item => [item.source, item.tools.map(tool => tool.name)]);
  const first = extensions.select([one!]);
  assert.deepEqual(names(first), [[one, ["shout"]]], "Pikibun's own bash stays reserved");
  const both = extensions.select([one!, two!]);
  assert.deepEqual(names(both), [[one, ["shout"]], [two, []]]);
  assert.notEqual(both.selected[1]!.extension.name, first.selected[0]!.extension.name);
  const upgraded = extensions.select([two!]);
  assert.deepEqual(names(upgraded), [[two, ["shout"]]]);
  assert.deepEqual(upgraded.created.map(item => item.name), [upgraded.selected[0]!.extension.name], "its whole Extension is new to the registry");
  assert.deepEqual(extensions.select([two!]).created, [], "and made once");
  assert.ok(warnings.some(message => /tool shout is left out/.test(message)));
});

test("each extension keeps the tools no earlier one, nor the session, has", () => {
  assert.deepEqual(settleToolNames([{ source: "a", tools: ["x", "bash"] }, { source: "b", tools: ["x", "y"] }, { source: "c", tools: [] }], ["bash"]), [
    { source: "a", kept: ["x"], lost: ["bash"] }, { source: "b", kept: ["y"], lost: ["x"] }, { source: "c", kept: [], lost: [] },
  ]);
});

test("an extension sees the model and reasoning level the running message uses, after a switch too", { skip: !["linux", "darwin"].includes(process.platform) }, async t => {
  const root = await realpath(await directory(t));
  await writeFile(join(root, "which.ts"), `import { Type } from "typebox";
    export default function (pi) {
      pi.registerTool({ name: "which_model", label: "Which", description: "Name the model.", parameters: Type.Object({}),
        async execute(_id, _params, _signal, _onUpdate, ctx) { return { content: [{ type: "text", text: ctx.model.provider + "/" + ctx.model.id + " " + pi.getThinkingLevel() }], details: undefined }; } });
    }`);
  const store = new ExtensionStore(join(root, "state"));
  await store.add(parseExtensionSource(join(root, "which.ts")));
  const installed = await loadInstalled(store);
  const faux = fauxProvider({ models: [{ id: "faux-1", reasoning: true }, { id: "faux-2", reasoning: true }] });
  const respond: FauxResponseFactory = async request => {
    faux.appendResponses([respond]);
    const last = request.messages.findLast(message => message.role !== "system");
    if (last?.role === "toolResult") return fauxAssistantMessage(`done: ${last.content.map(part => part.type === "text" ? part.text : "").join("")}`);
    return fauxAssistantMessage(fauxToolCall("which_model", {}), { stopReason: "toolUse" });
  };
  faux.setResponses([respond]);
  const models = createModels(); models.setProvider(faux.provider);
  const modelRegistry = { find: (provider: string, id: string) => ({ provider, id }) } as unknown as ModelRegistry;
  const target: RunnerBinding = {
    session: { id: "model-session", workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1", title: "Models", policyVersion: 1, status: "ready",
      createdAt: "2026-01-01T00:00:00Z", repositories: [], repositoryMode: "clone", connectorId: "host-connector", connectorOwnerId: "test:alice" },
    owner: { id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice", gitEmail: "alice@example.test", env: {}, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: "test:alice", workspaceId: "workspace", version: 1, name: "Agent", description: "", instructions: "Use tools.", tools: ["read_file"], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "workspace", name: "Model", provider: "faux", modelId: "faux-1", connectorId: "host-connector", connectorOwnerId: "test:alice" },
  };
  const service = new RunnerService({
    dataDir: join(root, "runner"), sharedSecret: "extension-test-secret-not-for-deployment", controlPlaneUrl: "http://127.0.0.1:8787",
    connectorId: "host-connector", allowFaux: true, unsandboxed: true,
    authorize: async input => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    extensions: { installed: () => installed, workspace: async () => ({ extensions: [], automaticTools: false }), modelRegistry },
  });
  await service.initialize();
  t.after(() => service.close());
  const claims = async (action: RunnerAction) => {
    const now = Math.floor(Date.now() / 1000);
    return { aud: "runner" as const, sessionId: target.session.id, actorId: "test:alice", ownerId: "test:alice", action, policyVersion: 1, iat: now, exp: now + 60,
      jti: randomUUID(), bodyHash: await sha256(""), connectorId: "host-connector" };
  };
  const session = await service.provision(target, await claims("create"));
  const ask = async (content: string, options: Record<string, unknown>) => {
    await session.submit(await claims("submit"), { content, requestId: content, admissionId: await sha256(content), options: { access: "auto", ...options } }, "write");
    for (let count = 0; count < 500 && (await session.view()).busy; count++) await delay(20);
    return (await session.view()).entries.filter(entry => entry.role === "toolResult").at(-1)!.text;
  };
  assert.match(await ask("first", { thinkingLevel: "low" }), /faux\/faux-1 low/);
  assert.match(await ask("second", { model: { provider: "faux", modelId: "faux-2" }, thinkingLevel: "high" }), /faux\/faux-2 high/);
});
