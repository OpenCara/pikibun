import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { defineTool } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { DEFERRED_TOOLS, deferredToolsExtension, loadedToolNames, SessionBuiltins, TOOL_SEARCH, upFrontTools } from "../apps/runner/src/extensions/builtin.js";
import { RunnerService } from "../apps/runner/src/server.js";
import type { RunnerSession } from "../apps/runner/src/session.js";
import { COMPACTED } from "../apps/runner/src/session/commands.js";
import { builtinExtensions, defaultHostConfig, parseBuiltinExtensions, type HostConfig } from "../packages/shared/src/host-config.js";
import type { AuthorizationRequest, EntryView, RunnerAction, RunnerBinding, RunnerTicket, SessionView, SubmitInput } from "../packages/shared/src/types.js";
import { sha256 } from "../packages/shared/src/crypto.js";

const ALICE = "test:alice";

type Request = { conversation: string; offered: string[]; system: string; messages: string[] };

function binding(id: string): RunnerBinding {
  const createdAt = "2026-01-01T00:00:00Z";
  return {
    session: { id, workspaceId: "workspace", ownerId: ALICE, agentVersionId: "version-1", title: "Deferral", policyVersion: 1, status: "ready", createdAt, repositories: [], repositoryMode: "clone" },
    owner: { id: ALICE, githubId: null, githubLogin: "alice", displayName: "alice", gitName: "Owner", gitEmail: "owner@example.test", env: {}, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: ALICE, workspaceId: "workspace", version: 1, name: "Agent", description: "", instructions: "Use tools.", tools: ["identity"], modelId: "model-1", createdAt },
    model: { id: "model-1", workspaceId: "workspace", name: "Model", provider: "faux", modelId: "faux-1" },
  };
}

async function ticket(session: RunnerSession, action: RunnerAction): Promise<RunnerTicket> {
  const now = Math.floor(Date.now() / 1000);
  return { aud: "runner", sessionId: session.binding.session.id, actorId: ALICE, ownerId: ALICE, action, policyVersion: 1, iat: now, exp: now + 60, jti: randomUUID(), bodyHash: await sha256("") };
}

function text(content: unknown): string {
  return typeof content === "string" ? content : (content as { type: string; text?: string }[]).filter(part => part.type === "text").map(part => part.text).join("");
}

function stable(value: unknown): string {
  return JSON.stringify(value, (key, item) => key === "timestamp" ? undefined : item);
}

async function fixture(t: TestContext, initial: HostConfig) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pikibun-deferral-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let hostConfig = initial;
  const requests: Request[] = [];
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  const respond: FauxResponseFactory = async context => {
    faux.appendResponses([respond]);
    const offered = new Set<string>();
    for (const message of context.messages) {
      if (message.role !== "system") continue;
      for (const tool of message.toolsAdded ?? []) offered.add(tool.name);
      for (const tool of message.toolsRemoved ?? []) offered.delete(typeof tool === "string" ? tool : (tool as { name: string }).name);
    }
    const firstUser = context.messages.find(message => message.role === "user");
    requests.push({ conversation: text(firstUser?.content ?? ""), offered: [...offered], system: stable(context.messages.find(message => message.role === "system")),
      messages: context.messages.map(message => stable(message)) });
    const latest = context.messages.findLast(message => message.role !== "system");
    if (latest?.role === "toolResult") return fauxAssistantMessage(`done ${latest.toolName}`);
    const prompt = text(latest?.role === "user" ? latest.content : "");
    if (prompt.startsWith("search:")) return fauxAssistantMessage([fauxToolCall("tool_search", { query: prompt.slice("search:".length) })], { stopReason: "toolUse" });
    if (prompt.startsWith("call:")) {
      const [, name, args] = /^call:([a-z_]+):(.*)$/s.exec(prompt)!;
      return fauxAssistantMessage([fauxToolCall(name!, JSON.parse(args!))], { stopReason: "toolUse" });
    }
    return fauxAssistantMessage("ok");
  };
  faux.setResponses([respond]);
  const models = createModels();
  models.setProvider(faux.provider);
  const config = {
    dataDir: directory, sharedSecret: "runner-deferral-test-secret-not-a-production-secret", controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, unsandboxed: true,
    authorize: async (input: AuthorizationRequest) => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async (model: RunnerBinding["model"]) => ({ models, provider: model.provider, modelId: model.modelId }),
    hostConfig: async () => hostConfig,
  };
  let service = new RunnerService(config);
  await service.initialize();
  t.after(() => service.close());
  return {
    requests,
    get service() { return service; },
    set config(next: HostConfig) { hostConfig = next; },
    async provision(id: string) {
      const now = Math.floor(Date.now() / 1000);
      return service.provision(binding(id), { aud: "runner", sessionId: id, actorId: ALICE, ownerId: ALICE, action: "create", policyVersion: 1, iat: now, exp: now + 60, jti: randomUUID(), bodyHash: await sha256("") });
    },
    async reopen(id: string) {
      await service.close();
      service = new RunnerService(config);
      await service.initialize();
      return service.get(id);
    },
  };
}

async function idle(session: RunnerSession): Promise<SessionView> {
  for (let count = 0; count < 1000; count++) {
    const view = await session.view();
    if (!view.busy) return view;
    await delay(20);
  }
  assert.fail("runner did not settle");
}

async function send(session: RunnerSession, content: string, options?: SubmitInput["options"]): Promise<SessionView> {
  await session.submit(await ticket(session, "submit"), { content, requestId: randomUUID(), admissionId: await sha256(randomUUID()), ...(options ? { options } : {}) }, "write");
  return idle(session);
}

function shared(view: SessionView): EntryView[] {
  const write = new Set(view.conversations.filter(conversation => conversation.mode === "write").map(conversation => conversation.id));
  return view.entries.filter(entry => entry.conversationId !== undefined && write.has(entry.conversationId));
}

function lastToolResult(view: SessionView): string {
  const entry = shared(view).filter(item => item.role === "toolResult").at(-1);
  assert.ok(entry, "no tool result");
  return entry.text;
}

const off: HostConfig = { ...defaultHostConfig, builtinExtensions: [] };
const on: HostConfig = { ...defaultHostConfig, builtinExtensions: parseBuiltinExtensions([TOOL_SEARCH]) };
const scheduleCreate = `call:schedule:${JSON.stringify({ action: "create", message: "nightly", cron: "0 3 * * *" })}`;

test("tool search is a built-in of its own, off unless the host turns it on, and defers all but the tools every session uses", t => {
  const builtins = new SessionBuiltins();
  t.after(() => builtins.close());
  const item = builtinExtensions.find(candidate => candidate.name === TOOL_SEARCH)!;
  assert.deepEqual(item.tools, ["tool_search"]);
  assert.ok(!("core" in item), "never on by default");
  assert.deepEqual(defaultHostConfig.builtinExtensions, []);
  assert.deepEqual(builtins.select([], new Set()).map(entry => entry.name), ["pi:codemode"]);
  assert.deepEqual(builtins.select([TOOL_SEARCH], new Set()).map(entry => entry.name), ["pi:codemode", TOOL_SEARCH]);
  assert.deepEqual(builtins.select([TOOL_SEARCH], new Set(["tool_search"])).map(entry => entry.name), ["pi:codemode"], "a workspace's extension offering tool_search replaces it");
  assert.deepEqual(builtins.extensions.get(TOOL_SEARCH)!.tools!.map(tool => tool.name), ["tool_search"]);

  const tool = (name: string, callers?: ("model" | "tools")[]) => defineTool({ name, description: name, parameters: obj({}, { open: true }), ...(callers ? { callers } : {}),
    execute: async () => ({ output: [{ type: "text", text: name }] }) });
  const deferral = deferredToolsExtension(["read", "git", "codemode", "schedule", "tunnel", "rust", "web_search", "schedule", "hidden"].map(name => tool(name, name === "hidden" ? ["tools"] : undefined)));
  assert.equal(deferral.name, DEFERRED_TOOLS);
  assert.deepEqual(deferral.tools!.map(item => [item.name, item.deferred]), [["schedule", true], ["tunnel", true], ["rust", true], ["web_search", true]]);
  for (const name of ["read", "write", "edit", "ls", "grep", "find", "git", "codemode", "tool_search"]) assert.ok(upFrontTools.has(name), name);
  assert.deepEqual(loadedToolNames([{ role: "toolResult", toolName: "tool_search", details: { loaded: ["schedule", 3, "tunnel"] } },
    { role: "toolResult", toolName: "other", details: { loaded: ["x"] } }, { role: "user" }]), ["schedule", "tunnel"]);
});

test("with tool search off, the tool list and the system prompt are byte for byte what they were, and stay so after it was on", async t => {
  const runner = await fixture(t, off);
  const session = await runner.provision("deferral-off");
  await send(session, "one");
  await send(session, "two");
  const [first, second] = runner.requests;
  assert.ok(!first!.offered.includes("tool_search"));
  for (const name of ["schedule", "sessions", "rust", "go", "dotnet", "make", "source_read", "codemode"]) assert.ok(first!.offered.includes(name), name);
  assert.equal(second!.system, first!.system, "the second message's prompt and tools are the first's");
  assert.ok(!/deferred|tool_search/.test(first!.system));

  const before = await runner.provision("deferral-before");
  runner.config = { ...defaultHostConfig, builtinExtensions: parseBuiltinExtensions(["pi:codemode"]) };
  await send(before, "one");
  assert.equal(runner.requests.at(-1)!.system, first!.system, "a host that lists only code mode, as hosts did before, sends the same");

  runner.config = on;
  await send(session, "three");
  assert.ok(runner.requests.at(-1)!.offered.includes("tool_search"));
  runner.config = off;
  const fresh = await runner.provision("deferral-after");
  await send(fresh, "one");
  assert.equal(runner.requests.at(-1)!.system, first!.system, "turned off again, a new session's first request is as before");
});

test("with tool search on, rare tools wait to be loaded, the prompt stays a prefix of the next, and loaded tools survive restart, compaction and forks", async t => {
  const runner = await fixture(t, { ...on, compaction: { keepRecentTokens: 1 } });
  let session = await runner.provision("deferral-on");
  await send(session, "one");
  const first = runner.requests.at(-1)!;
  for (const name of ["read", "write", "edit", "ls", "grep", "find", "git", "python", "node", "github_read", "codemode", "tool_search"]) assert.ok(first.offered.includes(name), name);
  for (const name of ["schedule", "sessions", "rust", "go", "dotnet", "make", "source_read", "tunnel", "browser"]) assert.ok(!first.offered.includes(name), name);
  await send(session, "two");
  assert.equal(runner.requests.at(-1)!.system, first.system, "the prompt and tool list stay the same from message to message");

  let view = await send(session, "search:schedule cron prompts");
  assert.match(lastToolResult(view), /Loaded \d+ tools?[\s\S]*- schedule:/);
  const loaded = runner.requests.at(-1)!;
  assert.ok(loaded.offered.includes("schedule"), "the next request offers it");
  assert.equal(loaded.system, first.system, "loading appends: the first system message is unchanged");
  assert.deepEqual(loaded.offered.slice(0, first.offered.length), first.offered, "a loaded tool follows the others");
  await send(session, "four");
  const conversationRequests = runner.requests.filter(request => request.conversation === "one");
  for (let index = 1; index < conversationRequests.length; index++) {
    const previous = conversationRequests[index - 1]!.messages;
    assert.deepEqual(conversationRequests[index]!.messages.slice(0, previous.length), previous, `request ${index} starts with the one before it, so the prompt cache holds`);
  }

  view = await send(session, `call:schedule:${JSON.stringify({ action: "list" })}`);
  assert.doesNotMatch(lastToolResult(view), /not available|unavailable/i, "a loaded tool runs");
  view = await send(session, scheduleCreate, { access: "read" });
  const readOnlyRefusal = lastToolResult(view);
  assert.match(readOnlyRefusal, /Read-only message/);
  view = await send(session, `call:tunnel:${JSON.stringify({ port: 3000 })}`);
  const tunnelRefusal = lastToolResult(view);
  view = await send(session, "search:tunnel public server online");
  assert.doesNotMatch(lastToolResult(view), /- tunnel:/, "a tool this session can't use isn't found");
  const offered = runner.requests.at(-1)!.offered;
  assert.ok(!offered.includes("tunnel") && !offered.includes("browser") && !offered.includes("source_read"), offered.join());

  session = await runner.reopen("deferral-on");
  await send(session, "after restart");
  assert.deepEqual(runner.requests.at(-1)!.offered, offered, "loaded tools survive a restart");

  view = await send(session, "/compact");
  for (let count = 0; count < 200 && !(await session.view()).entries.some(entry => entry.text.includes(COMPACTED)); count++) await delay(20);
  assert.ok((await session.view()).entries.some(entry => entry.text.includes(COMPACTED)), "compacted");
  await send(session, "after compaction");
  assert.deepEqual(runner.requests.at(-1)!.offered, offered, "loaded tools survive a compaction");

  view = await session.view();
  const afterCompaction = shared(view).find(entry => entry.role === "user" && entry.text === "after compaction")!;
  await session.revert(await ticket(session, "revert"), { entryId: afterCompaction.id });
  await send(session, "after going back");
  assert.deepEqual(runner.requests.at(-1)!.offered, offered, "loaded tools survive going back to a later message");

  const target = await runner.provision("deferral-fork");
  view = await session.view();
  const reply = shared(view).filter(entry => entry.role === "assistant" && entry.text === "ok").at(-1)!;
  await runner.service.fork(target, await ticket(target, "fork"), { sourceSessionId: "deferral-on", entryId: reply.id });
  await send(target, "in the fork");
  assert.deepEqual(runner.requests.at(-1)!.offered, offered, "loaded tools survive a fork into a new session");

  runner.config = off;
  const plain = await runner.provision("deferral-compare");
  view = await send(plain, scheduleCreate, { access: "read" });
  assert.equal(lastToolResult(view), readOnlyRefusal, "a loaded tool refuses in a Read-only message exactly as an offered one does");
  view = await send(plain, `call:tunnel:${JSON.stringify({ port: 3000 })}`);
  assert.equal(lastToolResult(view), tunnelRefusal, "an unavailable tool keeps its refusal");
});
