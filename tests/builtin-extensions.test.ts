import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { loadInstalled } from "../apps/runner/src/extensions/load.js";
import { ExtensionStore, parseExtensionSource } from "../apps/runner/src/extensions/store.js";
import { SessionBuiltins } from "../apps/runner/src/extensions/builtin.js";
import { RunnerService } from "../apps/runner/src/server.js";
import { sha256 } from "../packages/shared/src/crypto.js";
import { defaultHostConfig, type HostConfig } from "../packages/shared/src/host-config.js";
import { parseWorkspaceExtensions } from "../packages/shared/src/host-extensions.js";
import type { ApprovalRecord, RunnerAction, RunnerBinding } from "../packages/shared/src/types.js";

test("a built-in extension steps aside where a workspace's extension offers a tool by its name", async t => {
  const builtins = new SessionBuiltins();
  t.after(() => builtins.close());
  assert.deepEqual([...builtins.extensions.keys()], ["codemode"]);
  assert.deepEqual(builtins.select([], new Set()), []);
  assert.deepEqual(builtins.select(["codemode"], new Set()).map(item => item.name), ["codemode"]);
  assert.deepEqual(builtins.select(["codemode"], new Set(["codemode"])), []);
  // Scripts get no models.* tools: only the codemode tool itself.
  assert.deepEqual(builtins.extensions.get("codemode")!.tools!.map(tool => tool.name), ["codemode"]);
});

test("code mode runs where the host's configuration turns it on, and its scripts' calls are decided like the model's own", { skip: !["linux", "darwin"].includes(process.platform) }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pikibun-builtin-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "shout.ts"), `import { Type } from "typebox";
    export default function (pi) {
      pi.registerTool({ name: "shout", label: "Shout", description: "Shout text.", parameters: Type.Object({ text: Type.String() }),
        async execute(_id, params) { return { content: [{ type: "text", text: params.text.toUpperCase() + "!" }], details: undefined }; } });
    }`);
  const store = new ExtensionStore(join(root, "state"));
  await store.add(parseExtensionSource(join(root, "shout.ts")));
  const [dev] = await loadInstalled(store);
  const installed = [{ ...dev!, summary: { ...dev!.summary, source: "npm:shout@1.0.0", dev: false } }];
  const answer = { extensions: parseWorkspaceExtensions([{ source: "npm:shout@1.0.0" }]), automaticTools: false };
  let config: HostConfig = { ...defaultHostConfig, builtinExtensions: ["codemode"] };
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

  assert.deepEqual((await session.view()).extensions, { running: [{ source: "npm:shout@1.0.0", dev: false, tools: ["shout"] }], missing: [], builtin: ["codemode"] });
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

  // Turned off in the host's configuration: the next message offers no code mode.
  config = { ...config, builtinExtensions: [] };
  assert.equal((await session.view()).extensions?.builtin, undefined);
  await send("later");
  await idle();
  assert.ok(!offered.at(-1)!.includes("codemode"), offered.at(-1)!.join());
  assert.equal(await assistant(), "no code mode");
});
