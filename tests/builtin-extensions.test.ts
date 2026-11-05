import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { glob, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { loadInstalled } from "../apps/runner/src/extensions/load.js";
import { ExtensionStore, parseExtensionSource } from "../apps/runner/src/extensions/store.js";
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage, ToolResultEntry } from "@earendil-works/pi-durable";
import { CODEMODE_SESSION_WORKERS, LimitedCodemodeSandbox, SessionBuiltins } from "../apps/runner/src/extensions/builtin.js";
import { RunnerService } from "../apps/runner/src/server.js";
import { sha256 } from "../packages/shared/src/crypto.js";
import { defaultHostConfig, type HostConfig } from "../packages/shared/src/host-config.js";
import { parseWorkspaceExtensions } from "../packages/shared/src/host-extensions.js";
import type { ApprovalRecord, RunnerAction, RunnerBinding } from "../packages/shared/src/types.js";

test("code mode is core: every session runs it, whatever the host's configuration lists, unless a workspace's extension offers its tool", async t => {
  const builtins = new SessionBuiltins();
  t.after(() => builtins.close());
  assert.deepEqual([...builtins.extensions.keys()], ["pi:codemode"]);
  assert.deepEqual(builtins.select([], new Set()).map(item => item.name), ["pi:codemode"], "on though the host's configuration lists nothing");
  assert.deepEqual(builtins.select(["pi:codemode"], new Set()).map(item => item.name), ["pi:codemode"]);
  assert.deepEqual(builtins.select([], new Set(["codemode"])), [], "a workspace's extension offering codemode still replaces it");
  assert.deepEqual(builtins.select(["pi:codemode"], new Set(["codemode"])), []);
  // Scripts get no models.* tools: only the codemode tool itself.
  assert.deepEqual(builtins.extensions.get("pi:codemode")!.tools!.map(tool => tool.name), ["codemode"]);
});

test("a script's VM stops once it has computed too long, while time its calls take doesn't count; long output goes to the worktree", async t => {
  const context = BACKGROUND_CONTEXT;
  const files = new Map<string, string>();
  const builtins = new SessionBuiltins({ computeLimitMs: 400,
    outputs: async () => ({ writeFile: async (path, content) => { files.set(path, content); } }) });
  t.after(() => builtins.close());
  const slow = defineTool({ name: "slow", description: "Waits a second.", parameters: Type.Object({}),
    execute: async () => { await delay(1000); return { output: [{ type: "text", text: "slow done" }] }; } });
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  const respond: FauxResponseFactory = async request => {
    faux.appendResponses([respond]);
    const last = request.messages.findLast(message => message.role !== "system");
    if (last?.role === "toolResult") return fauxAssistantMessage("done");
    return fauxAssistantMessage(fauxToolCall("codemode", { code: typeof last?.content === "string" ? last.content : "" }), { stopReason: "toolUse" });
  };
  faux.setResponses([respond]);
  const models = createModels(); models.setProvider(faux.provider);
  const registry = createRegistry();
  const workspace = defineExtension({ name: "workspace-tools", tools: [slow] });
  registry.install(workspace);
  const codemode = builtins.extensions.get("pi:codemode")!;
  registry.install(codemode);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
  t.after(() => harness.close(context));
  const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, extensions: [workspace, codemode], tools: [slow, ...codemode.tools!] } });
  const run = async (code: string) => {
    const settled = await (await root.submit({ type: "input", content: code }, context)).wait(context);
    assert.equal(settled.status, "done");
    return JSON.stringify((await root.context(context)).entries.filter(entry => entry.kind === ToolResultEntry.kind).at(-1));
  };
  const started = Date.now();
  assert.match(await run("while (true) {}"), /computed for more than 0 seconds/);
  assert.ok(Date.now() - started < 10_000);
  // Waiting a second on a call, past the limit, is no computing.
  assert.match(await run("const a = await tools.slow({});\nreturn a;"), /slow done/);
  assert.doesNotMatch(await run("return 'x'.repeat(10)"), /computed for more than/);
  // Output past the script's budget is cut, and kept whole in the worktree for read_file.
  const cut = await run('// @options: {"max_output_tokens": 50}\nreturn Array.from({ length: 2000 }, (_, i) => "line " + i).join("\\n");');
  const path = /Full output: (codemode-output\/[0-9a-f]{8}\/output\.txt)/.exec(cut)?.[1];
  assert.ok(path, cut);
  assert.match(files.get(path)!, /^line 0\nline 1\n[\s\S]*line 1999$/);
});

test("a session runs at most a few scripts at once", async t => {
  const sandbox = new LimitedCodemodeSandbox();
  t.after(() => sandbox.close());
  const runs = Array.from({ length: CODEMODE_SESSION_WORKERS + 1 }, (_, index) => sandbox.start("await tools.wait({});", {
    startedAt: Date.now(), seed: index, tools: [{ name: "wait" }], onCall: () => {} }));
  const extra = await runs.at(-1)!.result;
  assert.equal(extra.ok, false);
  assert.match(JSON.stringify(extra), /already runs 2 code mode scripts/);
  await sandbox.close();
  for (const item of runs.slice(0, -1)) assert.equal((await item.result).ok, false);
});

test("code mode runs in every session, and its scripts' calls are decided like the model's own", { skip: !["linux", "darwin"].includes(process.platform) }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pikibun-builtin-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "shout.ts"), `import { Type } from "typebox";
    export default function (pi) {
      pi.registerTool({ name: "shout", label: "Shout", description: "Shout text.", parameters: Type.Object({ text: Type.String() }),
        async execute(_id, params) { return { content: [{ type: "text", text: params.text.toUpperCase() + "!" }], details: undefined }; } });
    }`);
  const store = new ExtensionStore(join(root, "state"));
  await store.add(parseExtensionSource(join(root, "shout.ts")));
  const [dev] = await loadInstalled(store, []);
  const installed = [{ ...dev!, summary: { ...dev!.summary, source: "npm:shout@1.0.0", dev: false } }];
  const answer = { extensions: parseWorkspaceExtensions([{ source: "npm:shout@1.0.0" }]), automaticTools: false };
  let config: HostConfig = { ...defaultHostConfig, builtinExtensions: ["pi:codemode"] };
  // The tools each request offers the model.
  const offered: string[][] = [];
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  const respond: FauxResponseFactory = async request => {
    faux.appendResponses([respond]);
    const tools = new Set<string>();
    for (const message of request.messages) {
      if (message.role !== "system") continue;
      for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
      for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
    }
    offered.push([...tools]);
    const last = request.messages.findLast(message => message.role !== "system");
    if (last?.role === "toolResult") return fauxAssistantMessage(`done: ${last.content.map(part => part.type === "text" ? part.text : "").join("")}`);
    const text = typeof last?.content === "string" ? last.content : "";
    if (!offered.at(-1)!.includes("codemode")) return fauxAssistantMessage("no code mode");
    if (text === "long") return fauxAssistantMessage(fauxToolCall("codemode", { code: '// @options: {"max_output_tokens": 50}\nreturn Array.from({ length: 2000 }, (_, i) => "line " + i).join("\\n");' }), { stopReason: "toolUse" });
    return fauxAssistantMessage(fauxToolCall("codemode", { code: `const [a, b] = await Promise.all([tools.shout({ text: ${JSON.stringify(text)} }), tools.shout({ text: "twice" })]);\nreturn a + " " + b;` }),
      { stopReason: "toolUse" });
  };
  faux.setResponses([respond]);
  const models = createModels(); models.setProvider(faux.provider);
  const target: RunnerBinding = {
    session: { id: "builtin-session", workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1", title: "Code mode", policyVersion: 1, status: "ready",
      createdAt: "2026-01-01T00:00:00Z", repositories: [], repositoryMode: "clone", connectorId: "host-connector", connectorOwnerId: "test:bob" },
    owner: { id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice", gitEmail: "alice@example.test", env: {}, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: "test:alice", workspaceId: "workspace", version: 1, name: "Agent", description: "", instructions: "Use tools.", tools: ["read_file"], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "workspace", name: "Model", provider: "faux", modelId: "faux-1", connectorId: "host-connector", connectorOwnerId: "test:bob" },
  };
  const service = new RunnerService({
    dataDir: join(root, "runner"), sharedSecret: "builtin-test-secret-not-for-deployment-0000", controlPlaneUrl: "http://127.0.0.1:8787",
    connectorId: "host-connector", allowFaux: true, unsandboxed: true,
    authorize: async input => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    hostConfig: async () => config,
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
  const send = async (content: string) =>
    session.submit(await claims("submit"), { content, requestId: content, admissionId: await sha256(content), options: { access: "approval" } }, "write");
  const idle = async () => {
    for (let count = 0; count < 500 && (await session.view()).busy; count++) await delay(20);
  };
  const assistant = async () => (await session.view()).entries.filter(entry => entry.role === "assistant").map(entry => entry.text).at(-1);

  // On the host itself, a session has no browser, and says why.
  assert.deepEqual((await session.view()).extensions, { running: [{ source: "npm:shout@1.0.0", dev: false, tools: ["shout"] }], missing: [], builtin: ["pi:codemode"],
    unavailable: [{ source: "piki:browser", tools: ["browser"], reason: "on-host" }] });
  await send("hello");
  // Each call the script makes of the extension's tool is a card for the host's owner, as the model's own call would be.
  const decided = new Set<string>();
  for (let count = 0; count < 1000 && decided.size < 2; count++) {
    for (const card of (await session.view()).approvals.filter((item: ApprovalRecord) => item.status === "pending" && !decided.has(item.id))) {
      assert.equal(card.operation.kind, "extension.tool");
      await session.decide(await claims("approve", "test:bob"), card.id, { decision: "approve", operation: card.operation });
      decided.add(card.id);
    }
    await delay(20);
  }
  assert.equal(decided.size, 2);
  await idle();
  assert.ok(offered[0]!.includes("codemode") && offered[0]!.includes("shout"), offered[0]!.join());
  assert.match((await assistant())!, /HELLO! TWICE!/);

  // Output past the script's budget is kept whole in the session's worktree, where read_file reads it.
  await send("long");
  await idle();
  const toolText = (await session.view()).entries.filter(entry => entry.role === "toolResult").map(entry => entry.text).at(-1)!;
  const saved = /Full output: (codemode-output\/[0-9a-f]{8}\/output\.txt)/.exec(toolText)?.[1];
  assert.ok(saved, toolText);
  const found: string[] = [];
  for await (const file of glob(`**/${saved}`, { cwd: join(root, "runner") })) found.push(file);
  assert.equal(found.length, 1);
  assert.match(await readFile(join(root, "runner", found[0]!), "utf8"), /^line 0\n[\s\S]*line 1999$/);

  // Left out of the host's configuration: code mode is core, so the next message still offers it.
  config = { ...config, builtinExtensions: [] };
  assert.deepEqual((await session.view()).extensions?.builtin, ["pi:codemode"]);
  await send("later");
  await idle();
  assert.ok(offered.at(-1)!.includes("codemode"), offered.at(-1)!.join());
});
