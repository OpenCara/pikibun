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
import { addedPrompt, ExtensionPrompts, SessionExtensions, type ExtensionHost } from "../apps/runner/src/extensions/adapter.js";
import { HostExtensions } from "../apps/runner/src/extensions/host.js";
import { RunnerService } from "../apps/runner/src/server.js";
import { sha256 } from "../packages/shared/src/crypto.js";
import type { ApprovalRecord, RunnerAction, RunnerBinding } from "../packages/shared/src/types.js";
import { loadInstalled } from "../apps/runner/src/extensions/load.js";
import { ExtensionStore, parseExtensionSource } from "../apps/runner/src/extensions/store.js";
import { extensionAvailability, extensionPackageKey, normalizeExtensionSource, parseHostExtensionsReport, parseWorkspaceExtensions,
  sessionExtensions, type ExtensionSettings, type InstalledExtension } from "../packages/shared/src/host-extensions.js";

const context = BACKGROUND_CONTEXT;

async function directory(t: test.TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pikibun-extensions-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

/** A store whose npm "installs" copy a package from `packages`, by name. */
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
  assert.deepEqual(parseWorkspaceExtensions([{ source: "npm:a@1.0.0" }]), [{ source: "npm:a@1.0.0", enabled: true, tools: "approval", settings: {} }]);
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
          pi.registerTool({ name: "bash", label: "Bash", description: "Mine.", parameters: Type.Object({}), async execute() { return { content: [], details: undefined }; } });
          pi.registerTool({ name: "web_search", label: "Web", description: "Search the web.", parameters: Type.Object({}), async execute() { return { content: [], details: undefined }; } });
          pi.registerCommand("search", { description: "x", handler: async () => {} });
          pi.registerProvider("proxy", { baseUrl: "https://proxy.example.com", api: "openai-completions", apiKey: "x", models: [] });
          pi.on("tool_call", () => undefined);
          pi.on("input", () => undefined);
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
  const loaded = await loadInstalled(store);
  const [search, notExtension, dev, broken] = loaded.map(item => item.summary);
  assert.deepEqual(search, { source: "npm:pi-search@1.0.0", dev: false, name: "pi-search", version: "1.0.0", description: "Searches.", modules: [{
    path: "src/index.ts", tools: [{ name: "team_search", description: "Search the index." }, { name: "web_search", description: "Search the web." }], events: ["tool_call"],
    flags: [{ name: "endpoint", type: "string", description: "Where to search", default: "https://search.example.com" }],
    noops: ["/search"], ignored: ["tool bash (one of Pikibun's own)", "input event", "provider proxy"],
  }] });
  assert.match(notExtension!.error!, /isn't a Pi extension package/);
  assert.equal(dev!.dev, true);
  assert.deepEqual(dev!.modules[0]!.events, ["session_start"]);
  assert.match(broken!.modules[0]!.error!, /broken on purpose/);
  // What the control plane accepts is what the connector reports.
  const report = { installed: loaded.map(item => item.summary), remoteInstalls: true };
  assert.deepEqual(parseHostExtensionsReport(report), report);
  // Versions sit side by side; removing names one.
  await assert.rejects(store.add(parseExtensionSource("npm:missing@1.0.0")), /no package missing/);
  assert.equal((await store.list()).length, 4, "a failed install leaves nothing behind");
  await store.remove("pi-search");
  assert.deepEqual((await store.list()).map(item => item.source), ["npm:not-an-extension@1.0.0", `local:${join(root, "dev.ts")}`, `local:${join(root, "broken.ts")}`]);
});

test("system prompt changes become the text they add", () => {
  assert.equal(addedPrompt("Base.", "Base.\n\nExtra."), "Extra.");
  assert.equal(addedPrompt("A\nB", "A\nInserted\nB"), "Inserted");
  assert.equal(addedPrompt("Same", "Same"), "");
});

/** A session's extensions on a faux model that calls `tool` with the user's text, then answers with the tool's result. */
async function session(t: test.TestContext, source: string, root: string, options: { tool: string; settings?: ExtensionSettings; active?: () => boolean }) {
  const store = new ExtensionStore(join(root, "state"));
  await store.add(parseExtensionSource(source));
  const loaded = await loadInstalled(store);
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
  for (const extension of extensions.extensions) registry.install(extension.extension);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
  t.after(() => harness.close(context));
  const root_ = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" },
    extensions: [workspace, ...extensions.extensions.map(item => item.extension)], tools: extensions.extensions.flatMap(item => item.tools) } });
  await extensions.sessionStart();
  const answer = async (content: string) => {
    // As Session.applyOptions does when a message starts.
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
  const host = new HostExtensions(store, { remoteInstalls: true });
  await host.load();
  assert.deepEqual(host.report(), { installed: [], remoteInstalls: true });
  assert.deepEqual(await host.apply([{ id: "r1", action: "install", source: "npm:pi-a@1.0.0" }, { id: "r2", action: "install", source: "npm:missing@1.0.0" }]),
    [{ id: "r1", ok: true }, { id: "r2", ok: false, error: "no package missing" }]);
  assert.deepEqual(host.report().installed.map(item => item.source), ["npm:pi-a@1.0.0"]);
  assert.deepEqual(await host.apply([{ id: "r3", action: "install", source: "npm:pi-a@1.0.0" }]), [{ id: "r3", ok: true }], "already installed is done");
  assert.deepEqual(await host.apply([{ id: "r4", action: "remove", source: "npm:pi-a@1.0.0" }, { id: "r5", action: "remove", source: "npm:pi-a@1.0.0" }]),
    [{ id: "r4", ok: true }, { id: "r5", ok: true }]);
  assert.deepEqual(host.report().installed, []);
  const refusing = new HostExtensions(store, { remoteInstalls: false });
  assert.match((await refusing.apply([{ id: "r6", action: "install", source: "npm:pi-a@1.0.0" }]))[0]!.error!, /--no-remote-installs/);

  let now = 0;
  let answer: unknown = { extensions: [{ source: "npm:pi-a@1.0.0" }], automaticTools: false };
  let asked = 0;
  const cached = new HostExtensions(store, { remoteInstalls: true, now: () => now });
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
});

test("an extension's tool waits for the host owner's decision, never runs in a Read-only message, and runs at once where the workspace and host allow it", { skip: !["linux", "darwin"].includes(process.platform) }, async t => {
  const root = await realpath(await directory(t));
  await writeFile(join(root, "shout.ts"), `import { Type } from "typebox";
    export default function (pi) {
      pi.registerTool({ name: "shout", label: "Shout", description: "Shout text.", parameters: Type.Object({ text: Type.String() }),
        async execute(_id, params) { return { content: [{ type: "text", text: params.text.toUpperCase() + "!" }], details: undefined }; } });
    }`);
  const store = new ExtensionStore(join(root, "state"));
  await store.add(parseExtensionSource(join(root, "shout.ts")));
  const [dev] = await loadInstalled(store);
  // The same code, as an npm extension the workspace chose.
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

  await send("hello", "approval");
  let card: ApprovalRecord | undefined;
  for (let count = 0; count < 500 && !card; count++) { card = (await session.view()).approvals.find(item => item.status === "pending"); await delay(20); }
  assert.deepEqual(card!.operation, { kind: "extension.tool", source: "npm:shout@1.0.0", tool: "shout", arguments: '{"text":"hello"}',
    digest: createHash("sha256").update('{"text":"hello"}').digest("hex") });
  // Decided like a host command: the session's owner can't, the host's owner can.
  await assert.rejects(session.decide(await claims("approve"), card!.id, { decision: "approve", operation: card!.operation }), /host owner/);
  await session.decide(await claims("approve", "test:bob"), card!.id, { decision: "approve", operation: card!.operation });
  await idle();
  const decided = (await session.view()).approvals.find(item => item.id === card!.id)!;
  assert.deepEqual([decided.status, decided.decidedBy, decided.result], ["executed", "test:bob", "HELLO!"]);
  assert.deepEqual((await session.view()).extensions, { running: [{ source: "npm:shout@1.0.0", dev: false, tools: ["shout"] }], missing: [] });
  assert.match((await results()).at(-1)!, /HELLO!/);

  await send("quietly", "read");
  await idle();
  assert.match((await results()).at(-1)!, /Read-only message doesn't run it/);

  // The workspace runs its tools automatically, but the host's owner hasn't allowed that: still a card.
  answer = { extensions: parseWorkspaceExtensions([{ source: "npm:shout@1.0.0", tools: "automatic" }]), automaticTools: false };
  await send("again", "approval");
  card = undefined;
  for (let count = 0; count < 500 && !card; count++) { card = (await session.view()).approvals.find(item => item.status === "pending"); await delay(20); }
  await session.decide(await claims("approve", "test:bob"), card!.id, { decision: "deny", operation: card!.operation });
  await idle();
  assert.match((await results()).at(-1)!, /wasn't approved/);

  answer = { ...answer, automaticTools: true };
  await new Promise(resolve => setTimeout(resolve, 10));
  await send("now", "approval");
  await idle();
  const automatic = (await session.view()).approvals.at(-1)!;
  assert.deepEqual([automatic.status, automatic.automatic, automatic.result], ["executed", true, "NOW!"]);

  // A version the host doesn't have: the session runs without it, and says so.
  answer = { extensions: parseWorkspaceExtensions([{ source: "npm:shout@2.0.0" }]), automaticTools: true };
  assert.deepEqual((await session.view()).extensions, { running: [], missing: ["npm:shout@2.0.0"] });
  // Turned off: its tool is no longer offered.
  answer = { extensions: [], automaticTools: true };
  await send("gone", "approval");
  await idle();
  assert.doesNotMatch((await results()).at(-1)!, /GONE!/);
});
