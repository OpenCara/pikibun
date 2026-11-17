import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { loadInstalled } from "../apps/runner/src/extensions/load.js";
import { ExtensionStore } from "../apps/runner/src/extensions/store.js";
import { RunnerService } from "../apps/runner/src/server.js";
import type { SessionsToolRequest, SessionsToolResult } from "../packages/shared/src/cross-session.js";
import { sha256 } from "../packages/shared/src/crypto.js";
import { parseWorkspaceExtensions } from "../packages/shared/src/host-extensions.js";
import type { RunnerAction } from "../packages/shared/src/types.js";
import {
  DEFAULT_MAX_SUB_AGENTS, maxSubAgents, parsePlacementSetting, readSettings, subAgentsExtension, subAgentsPrompt, SubAgentsState,
} from "../extensions/sub-agents/sub-agents.ts";

function load(flags: Record<string, string | boolean> = {}) {
  const handlers = new Map<string, (event: unknown, ctx?: unknown) => unknown>();
  const registered: [string, unknown][] = [];
  subAgentsExtension({
    registerFlag: (name: string, options: { default: unknown }) => { registered.push([name, options.default]); },
    getFlag: (name: string) => flags[name] ?? registered.find(([flag]) => flag === name)?.[1],
    on: (event: string, handler: (event: unknown, ctx?: unknown) => unknown) => { handlers.set(event, handler); },
  } as never);
  const call = (input: Record<string, unknown>, toolName = "sessions") => {
    const event = { type: "tool_call", toolCallId: "c", toolName, input };
    return { answer: handlers.get("tool_call")!(event) as { block: true; reason: string } | undefined, input: event.input };
  };
  const result = (input: Record<string, unknown>, text: string, isError = false) =>
    handlers.get("tool_result")!({ toolName: "sessions", input, content: [{ type: "text", text }], isError }) as { content: { text: string }[] } | undefined;
  const start = () => (handlers.get("before_agent_start")!({ systemPrompt: "Base." }) as { systemPrompt: string }).systemPrompt;
  return { handlers, registered, call, result, start };
}

const created = (id: string, placement = true) => JSON.stringify({ initiatedBy: "test:a", session: { id, title: "T" }, model: { id: "m" },
  ...(placement ? { placement: { host: { id: "h1", name: "GPU box" }, conditions: "gpu true", load: 0.4, activeSessions: 0, qualified: 2, considered: 3 } } : {}),
  message: { id: `msg-${id}` } });

test("the placement setting reads key=value conditions, and leaves out what it can't use", () => {
  assert.deepEqual(parsePlacementSetting("gpu=yes, gpu_vendor=NVIDIA; min_cpus=8\nmin-memory-gb: 31.5, models=anthropic/*|openai/gpt-5, hosts=a|b|a, platform=linux, arch=arm64"), {
    placement: { gpu: true, gpu_vendor: "nvidia", min_cpus: 8, min_memory_gb: 31.5, models: ["anthropic/*", "openai/gpt-5"], hosts: ["a", "b"], platform: "linux", arch: "arm64" },
    ignored: [],
  });
  assert.deepEqual(parsePlacementSetting("min_cpus=0.5, gpu=maybe, colour=red, gpu_vendor=voodoo, platform=linux os, nonsense"), {
    placement: {}, ignored: ["min_cpus=0.5", "gpu=maybe", "colour=red", "gpu_vendor=voodoo", "platform=linux os", "nonsense"] });
  assert.deepEqual(parsePlacementSetting("gpu=false, gpu_vendor=amd"), { placement: { gpu: false }, ignored: ["gpu_vendor"] });
  assert.deepEqual(parsePlacementSetting(undefined), { placement: {}, ignored: [] });
  assert.equal(maxSubAgents("3"), 3);
  assert.equal(maxSubAgents("50"), 10);
  assert.equal(maxSubAgents("0"), 0);
  assert.equal(maxSubAgents("lots"), DEFAULT_MAX_SUB_AGENTS);
  const settings = readSettings(name => ({ models: "anthropic/*, openai/*|anthropic/*", balance: "off", notify: false, delegate: " When-Asked " } as Record<string, unknown>)[name]);
  assert.deepEqual([settings.models, settings.balance, settings.notify, settings.delegate, settings.maxSubAgents], [["anthropic/*", "openai/*"], false, false, "when-asked", 5]);
});

test("each sub-agent the agent starts gets the workspace's conditions where it set none, and a placement for the least loaded host", () => {
  const { registered, call } = load({ placement: "min_free_memory_gb=4, platform=linux", models: "anthropic/*" });
  assert.deepEqual(registered, [["placement", ""], ["models", ""], ["balance", true], ["max-sub-agents", "5"], ["notify", true], ["delegate", "when-useful"]]);
  assert.deepEqual(call({ action: "create", title: "A", message: "Go" }).input,
    { action: "create", title: "A", message: "Go", notify: true, placement: { min_free_memory_gb: 4, platform: "linux", models: ["anthropic/*"] } });
  assert.deepEqual(call({ action: "create", message: "Go", notify: false, placement: { platform: "darwin", gpu: true } }).input.placement,
    { min_free_memory_gb: 4, platform: "darwin", gpu: true, models: ["anthropic/*"] }, "the agent's own conditions win");
  assert.deepEqual(call({ action: "create", message: "Go", model: "m-1" }).input.placement, { min_free_memory_gb: 4, platform: "linux" },
    "a named model takes no models besides");
  assert.deepEqual(call({ action: "create", placement: { models: ["openai/*"] } }).input.placement, { min_free_memory_gb: 4, platform: "linux", models: ["openai/*"] });
  assert.equal(call({ action: "create" }).input.notify, undefined, "notify goes with a message only");
  for (const input of [{ action: "list" }, { action: "send", session: "s", message: "m" }]) assert.deepEqual(call(input).input, input);
  assert.deepEqual(call({ action: "create" }, "schedule").input, { action: "create" }, "only the sessions tool");

  const plain = load();
  assert.deepEqual(plain.call({ action: "create", message: "Go" }).input.placement, {}, "balance: an empty placement, so Pikibun picks the least loaded host");
  const unbalanced = load({ balance: false, notify: false });
  assert.deepEqual(unbalanced.call({ action: "create", message: "Go" }).input, { action: "create", message: "Go" });
});

test("a message starts at most max-sub-agents, counting those that started; the next message starts again", () => {
  const { call, result, start } = load({ "max-sub-agents": "2" });
  start();
  for (const id of ["a", "b"]) {
    const { answer, input } = call({ action: "create", message: "Go" });
    assert.equal(answer, undefined);
    result(input, created(id));
  }
  const refused = call({ action: "create", message: "Go" }).answer!;
  assert.equal(refused.block, true);
  assert.match(refused.reason, /already started 2 sub-agents, the most the workspace's max-sub-agents allows/);
  result({ action: "create" }, "No host qualifies for placement (gpu true)", true);
  start();
  assert.equal(call({ action: "create", message: "Go" }).answer, undefined, "a new message, a new count");
  const none = load({ "max-sub-agents": "0" });
  assert.match(none.call({ action: "create" }).answer!.reason, /lets no message start sub-agents/);
  assert.match(none.start(), /lets no message start sub-agent sessions/);
});

test("its notes say where a sub-agent runs and how to collect it, or why no host qualified", () => {
  const { call, result, start } = load({ placement: "gpu=true", "max-sub-agents": "3" });
  start();
  const { input } = call({ action: "create", message: "Render" });
  const noted = result(input, created("s1"))!;
  assert.equal(noted.content[0]!.text, created("s1"));
  assert.equal(noted.content[1]!.text, "[sub-agents] Sub-agent s1 started on host GPU box (load 0.4, the least loaded of 2 that qualified). It reports back when it finishes; "
    + "meanwhile carry on, and before you answer, collect its result with sessions wait {session: \"s1\", message_id: \"msg-s1\"}. 2 more may start in this message.");
  assert.match(result({ action: "create", notify: false }, created("s2", false))!.content[1]!.text,
    /^\[sub-agents\] Sub-agent s2 started\. Collect its result with sessions wait \{session: "s2", message_id: "msg-s2"\} before you answer\. 1 more/);
  assert.match(result({ action: "create" }, "No host qualifies for placement (gpu true): of 2 hosts ...", true)!.content[1]!.text,
    /^\[sub-agents\] No host met this sub-agent's conditions \(the workspace adds gpu=true to every sub-agent\)\. Relax/);
  assert.equal(result({ action: "list" }, "{}"), undefined);
  assert.equal(result({ action: "create" }, "Session not found.", true), undefined);
});

test("against a server without placement, or a workspace that keeps sub-agents on the session's model, it stops adding what they refuse", () => {
  const { call, result, start } = load({ models: "anthropic/*" });
  start();
  const refused = result(call({ action: "create", message: "Go" }).input, "A create takes no placement.", true)!;
  assert.match(refused.content[1]!.text, /can't place sessions by host conditions yet, so placement is left out from now on: call create again/);
  assert.deepEqual(call({ action: "create", message: "Go" }).input, { action: "create", message: "Go", notify: true });
  assert.match(start(), /this Pikibun server can't place by host conditions; name a model sessions list returns/);

  const kept = load({ models: "anthropic/*", placement: "models=openai/*, min_cpus=4" });
  kept.start();
  const off = kept.result(kept.call({ action: "create", message: "Go" }).input,
    "This workspace runs the sessions agents start on their parent's model and reasoning level. Leave out model, thinking and placement models.", true)!;
  assert.match(off.content[1]!.text, /models are left out of placement from now on/);
  assert.deepEqual(kept.call({ action: "create", message: "Go" }).input.placement, { min_cpus: 4 });
  assert.doesNotMatch(kept.start(), /models|anthropic|openai/);
});

test("each message's prompt carries the policy and the workspace's settings", () => {
  const prompt = load({ placement: "min_free_memory_gb=4", models: "anthropic/*", "max-sub-agents": "1" }).start();
  assert.match(prompt, /^Base\.\n\n## Sub-agents\n\n/);
  assert.match(prompt, /- When: split work into sub-agents where its parts are independent/);
  assert.match(prompt, /least loaded online host you may start sessions on that meets its placement/);
  assert.match(prompt, /yours win\): conditions min_free_memory_gb=4; models anthropic\/\* for sub-agents that name no model; placement on the least loaded qualifying host for every sub-agent\./);
  assert.match(prompt, /at most 1 sub-agent per message\./);
  assert.match(prompt, /reports back to this session when it finishes \(notify\)/);
  const asked = subAgentsPrompt(readSettings(name => ({ delegate: "when-asked", notify: false, balance: false } as Record<string, unknown>)[name]),
    { placementUnsupported: false, modelsRefused: false });
  assert.match(asked, /- When: only when the person asks/);
  assert.doesNotMatch(asked, /defaults/);
  assert.match(asked, /wait for each with sessions wait/);
  assert.equal(new SubAgentsState().started, 0);
});

test("in a session, the connector's piki:sub-agents gives the agent's sessions create the workspace's conditions before Pikibun places it", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pikibun-sub-agents-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  const prompts: string[] = [];
  faux.setResponses([
    async request => {
      prompts.push(JSON.stringify([request.systemPrompt, request.messages.filter(message => message.role === "system")]));
      return fauxAssistantMessage(fauxToolCall("sessions", { action: "create", title: "Render", message: "Render the scene", placement: { min_cpus: 8 } }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage(fauxToolCall("sessions", { action: "create", title: "Again", message: "One more" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Done."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const loaded = (await loadInstalled(new ExtensionStore(join(root, "extensions")))).filter(item => item.summary.source === "piki:sub-agents");
  assert.equal(loaded.length, 1);
  const requests: SessionsToolRequest[] = [];
  const service = new RunnerService({
    dataDir: join(root, "runner"), sharedSecret: "sub-agents-test-secret-not-for-deployment", controlPlaneUrl: "http://127.0.0.1:8787",
    connectorId: "host-connector", allowFaux: true, unsandboxed: true,
    authorize: async input => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    crossSessions: async request => {
      requests.push(request);
      return { session: { id: "child-1", title: "Render", ownerId: "test:alice", status: "ready", permissions: ["read"], createdAt: "" },
        model: { id: "m", provider: "faux", modelId: "faux-1" }, message: { id: "xs-1", kind: "create", originSessionId: "s", targetSessionId: "child-1", actorId: "test:alice",
          submissionId: "sub", conversationId: "0", hops: 1, createdAt: "" },
        placement: { host: { id: "gpu-host", name: "GPU box" }, conditions: "gpu true, min_cpus 8", load: 0.4, activeSessions: 0, qualified: 1, considered: 2 } } satisfies SessionsToolResult;
    },
    extensions: { installed: () => loaded, workspace: async () => ({ automaticTools: true,
      extensions: parseWorkspaceExtensions([{ source: "piki:sessions" }, { source: "piki:sub-agents", settings: { placement: "gpu=true, platform=linux", "max-sub-agents": "1" } }]) }) },
  });
  await service.initialize();
  t.after(() => service.close());
  const id = `sub-agents-${randomUUID().slice(0, 8)}`;
  const claims = async (action: RunnerAction) => {
    const now = Math.floor(Date.now() / 1000);
    return { aud: "runner" as const, sessionId: id, actorId: "test:alice", ownerId: "test:alice", action, policyVersion: 1, iat: now, exp: now + 60,
      jti: randomUUID(), bodyHash: await sha256(""), connectorId: "host-connector" };
  };
  const session = await service.provision({
    session: { id, workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1", title: "Planner", policyVersion: 1, status: "ready",
      createdAt: "2026-01-01T00:00:00Z", repositories: [], repositoryMode: "clone", connectorId: "host-connector", connectorOwnerId: "test:alice" },
    owner: { id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice", gitEmail: "alice@example.test", env: {}, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: "test:alice", workspaceId: "workspace", version: 1, name: "Agent", description: "", instructions: "Use tools.",
      tools: ["identity", "sessions"], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "workspace", name: "Model", provider: "faux", modelId: "faux-1", connectorId: "host-connector", connectorOwnerId: "test:alice" },
  }, await claims("create"));
  const content = "Render the scene somewhere with a GPU.";
  await session.submit(await claims("submit"), { content, requestId: randomUUID(), admissionId: await sha256(content) }, "write");
  for (let count = 0; count < 500 && (await session.view()).busy; count++) await delay(20);
  assert.equal(requests.length, 1, JSON.stringify((await session.view()).entries.map(entry => entry.text)));
  assert.deepEqual(requests[0]!.placement, { gpu: true, platform: "linux", minCpus: 8 }, "the workspace's conditions, with the agent's own");
  assert.equal(requests[0]!.notify, true);
  assert.match(prompts[0]!, /## Sub-agents.*at most 1 sub-agent per message/);
  const results = (await session.view()).entries.filter(entry => entry.role === "toolResult").map(entry => entry.text);
  assert.match(results[0]!, /\[sub-agents\] Sub-agent child-1 started on host GPU box/);
  assert.match(results[1]!, /already started 1 sub-agents, the most the workspace's max-sub-agents allows/, "the second is refused before it reaches Pikibun");
});

test("the package's module is the extension, and the connector's piki:sub-agents", async () => {
  assert.equal((await import("../extensions/sub-agents/index.ts")).default, subAgentsExtension);
  const { connectorPikiExtension, managedSource } = await import("../apps/runner/src/extensions/piki/index.ts");
  assert.equal(connectorPikiExtension("piki:sub-agents")!.factory, subAgentsExtension);
  assert.equal(managedSource("piki:sub-agents"), true);
});
