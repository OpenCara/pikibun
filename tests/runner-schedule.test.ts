import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { RunnerService } from "../apps/runner/src/server.js";
import type { RunnerSession } from "../apps/runner/src/session.js";
import type { AuthorizationRequest, PermissionRequest, RunnerAction, RunnerBinding, RunnerTicket, ScheduleToolRequest, SessionSchedule } from "../packages/shared/src/types.js";
import { scheduleToolTarget } from "../packages/shared/src/cron.js";
import { documentKindsOff, sessionToolExtensionOn, sessionToolsOff } from "../packages/shared/src/piki-extensions.js";
import type { WorkspaceExtensionsAnswer } from "../packages/shared/src/host-extensions.js";
import { sha256 } from "../packages/shared/src/crypto.js";

function binding(id: string): RunnerBinding {
  return {
    session: { id, workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1", title: "Schedules", policyVersion: 1, status: "ready", createdAt: "2026-01-01T00:00:00Z", repositories: [], repositoryMode: "clone" },
    owner: { id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice Owner", gitEmail: "alice@example.test", env: {}, githubConnected: false },
    // A session from before the schedule tool: its agent lacks it.
    agent: { id: "version-1", agentId: "agent", authorId: "test:alice", workspaceId: "workspace", version: 1, name: "Agent", description: "", instructions: "Use tools.", tools: ["read_file"], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "workspace", name: "Model", provider: "faux", modelId: "faux-1" },
  };
}

async function ticket(id: string, action: RunnerAction, actorId = "test:alice"): Promise<RunnerTicket> {
  const now = Math.floor(Date.now() / 1000);
  return { aud: "runner", sessionId: id, actorId, ownerId: "test:alice", action, policyVersion: 1, iat: now, exp: now + 60, jti: randomUUID(), bodyHash: await sha256("") };
}

async function idle(session: RunnerSession): Promise<void> {
  for (let count = 0; count < 1000; count++) {
    if (!(await session.view()).busy) return;
    await delay(20);
  }
  assert.fail("runner did not settle");
}

async function pendingApproval(session: RunnerSession) {
  for (let count = 0; count < 1000; count++) {
    const approval = (await session.view()).approvals.find(candidate => candidate.status === "pending");
    if (approval) return approval;
    await delay(20);
  }
  assert.fail("no pending approval");
}

test("the agent schedules prompts from the chat for the session owner, never adding access its message lacked", async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pikibun-schedule-tool-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requests: ScheduleToolRequest[] = [];
  const schedule = { id: "schedule-1", name: "Check the build", cron: "0 9 * * 1-5", timeZone: "Europe/Berlin", access: "approval", enabled: true } as SessionSchedule;
  const create = { action: "create", message: "Check the build", cron: "0 9 * * 1-5", time_zone: "Europe/Berlin", run_in: "child" };
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("schedule", create)], { stopReason: "toolUse" }),
    fauxAssistantMessage("Scheduled."),
    fauxAssistantMessage([fauxToolCall("schedule", { ...create, access: "auto" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Not allowed."),
    fauxAssistantMessage([fauxToolCall("schedule", { action: "list" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Not allowed."),
    fauxAssistantMessage([fauxToolCall("schedule", { action: "update", id: "schedule-1", enabled: false })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Paused."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const service = new RunnerService({
    dataDir: directory, sharedSecret: "runner-schedule-test-secret-not-a-production-secret", controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, unsandboxed: true,
    authorize: async (input: AuthorizationRequest) => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    schedules: async request => { requests.push(request); return { schedule: { ...schedule, enabled: request.enabled ?? true } }; },
  });
  await service.initialize();
  t.after(() => service.close());
  const id = "schedule-session";
  const session = await service.provision(binding(id), await ticket(id, "create"));
  const admissionId = await sha256("schedule admission");
  const transcript = async () => (await session.view()).entries.map(entry => entry.text).join("\n");

  // The agent lacks the tool, so the owner allows this one call, seeing exactly what it schedules.
  await session.submit(await ticket(id, "submit"), { content: "Every weekday at nine, check the build.", requestId: "create", admissionId }, "write");
  const permission = await pendingApproval(session);
  const fields = { cron: "0 9 * * 1-5", timeZone: "Europe/Berlin", content: "Check the build", runIn: "child" as const };
  assert.equal((permission.operation as PermissionRequest).tool, "schedule");
  assert.equal((permission.operation as PermissionRequest).target, scheduleToolTarget({ action: "create", ...fields }));
  assert.match((permission.operation as PermissionRequest).target, /each run in a new child session/, "the card says where its runs go");
  assert.equal(requests.length, 0, "nothing is scheduled before the owner allows it");
  await session.decide(await ticket(id, "approve"), permission.id, { decision: "approve", operation: permission.operation });
  await idle(session);
  assert.equal(requests.length, 1);
  assert.deepEqual({ ...requests[0], callId: undefined }, { sessionId: id, actorId: "test:alice", admissionId, callId: undefined, action: "create", ...fields });
  assert.match(requests[0]!.callId, /^[A-Za-z0-9_-]+$/);
  assert.match(await transcript(), /schedule-1/);

  // Without the owner's Auto-approve, an auto-approved schedule is refused before it reaches the control plane.
  await session.submit(await ticket(id, "submit"), { content: "Schedule it with auto-approve.", requestId: "auto", admissionId }, "write");
  await idle(session);
  assert.match(await transcript(), /Only a message the session owner sent with auto-approve schedules an auto-approved prompt/);
  // A collaborator's message schedules nothing: each run would be the owner's.
  await session.submit(await ticket(id, "submit", "test:bob"), { content: "What is scheduled?", requestId: "bob", admissionId: await sha256("bob admission") }, "write");
  await idle(session);
  assert.match(await transcript(), /Only the session owner's messages schedule prompts/);
  assert.equal(requests.length, 1);

  // The owner's Auto-approve message needs no permission card.
  await session.submit(await ticket(id, "submit"), { content: "Pause it.", requestId: "pause", admissionId, options: { access: "auto" } }, "write");
  await idle(session);
  assert.equal(requests.length, 2);
  assert.deepEqual({ ...requests[1], callId: undefined }, { sessionId: id, actorId: "test:alice", admissionId, callId: undefined, action: "update", scheduleId: "schedule-1", enabled: false });
  assert.equal((await session.view()).approvals.filter(approval => approval.status === "pending").length, 0);
});

test("piki:schedule: the workspace turns the schedule tool off, and a call by name is refused; it stays on where the workspace never chose or can't be read", async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pikibun-schedule-switch-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requests: ScheduleToolRequest[] = [];
  const offered: string[][] = [];
  // Each message: the model notes the tools it was offered, then calls schedule anyway.
  const listing = (context: { messages: { role: string; toolsAdded?: { name: string }[]; toolsRemoved?: { name: string }[] }[] }) => {
    // The tools offered now: those the transcript's system messages added, less those they removed since.
    const tools = new Set<string>();
    for (const message of context.messages) {
      if (message.role !== "system") continue;
      for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
      for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
    }
    offered.push([...tools]);
    return fauxAssistantMessage([fauxToolCall("schedule", { action: "list" })], { stopReason: "toolUse" });
  };
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses([listing, fauxAssistantMessage("Listed."), listing, fauxAssistantMessage("Refused."), listing, fauxAssistantMessage("Listed.")] as never);
  const models = createModels();
  models.setProvider(faux.provider);
  let answer: WorkspaceExtensionsAnswer | Error = { extensions: [], automaticTools: false };
  const service = new RunnerService({
    dataDir: directory, sharedSecret: "runner-schedule-switch-secret-not-a-production-secret", controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, unsandboxed: true,
    authorize: async (input: AuthorizationRequest) => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    schedules: async request => { requests.push(request); return { schedules: [] }; },
    extensions: { installed: () => [], workspace: async () => { if (answer instanceof Error) throw answer; return answer; } },
  });
  await service.initialize();
  t.after(() => service.close());
  const id = "schedule-switch-session";
  const withTool = binding(id);
  withTool.agent.tools = ["read_file", "schedule"];
  const session = await service.provision(withTool, await ticket(id, "create"));
  const admissionId = await sha256("schedule switch admission");
  const transcript = async () => (await session.view()).entries.map(entry => entry.text).join("\n");
  const send = async (requestId: string) => {
    await session.submit(await ticket(id, "submit"), { content: "What is scheduled?", requestId, admissionId, options: { access: "auto" } }, "write");
    await idle(session);
  };

  // A workspace that never chose: on, as before it was switchable.
  await send("never-chose");
  assert.ok(offered[0]!.includes("schedule"));
  assert.equal(requests.length, 1);

  // Turned off: not offered, and a call by name never reaches the control plane.
  answer = { extensions: [{ source: "piki:schedule", enabled: false, tools: "approval", settings: {} }], automaticTools: false };
  await send("off");
  assert.ok(!offered[1]!.includes("schedule"), "the model isn't offered it");
  assert.ok(offered[1]!.includes("read_file"), "the session's other tools stay");
  assert.equal(requests.length, 1);
  // The harness refuses a tool the message wasn't offered; the tool itself refuses too, for a code mode script's call.
  assert.match(await transcript(), /Tool schedule is not available/);

  // The workspace's choice can't be read: its tools stay on rather than vanish.
  answer = new Error("control plane unreachable");
  await send("unreadable");
  assert.ok(offered[2]!.includes("schedule"));
  assert.equal(requests.length, 2);
});

test("sessionToolsOff: only a session-tool extension the workspace lists turned off turns its tools off, but an opt-in one is off unless listed on", () => {
  // piki:tunnel is opt-in: off until the workspace lists it enabled.
  assert.deepEqual([...sessionToolsOff([])], ["tunnel"]);
  assert.deepEqual([...sessionToolsOff([{ source: "piki:schedule", enabled: true }])], ["tunnel"]);
  assert.deepEqual([...sessionToolsOff([{ source: "piki:schedule", enabled: false }])], ["schedule", "tunnel"]);
  assert.deepEqual([...sessionToolsOff([{ source: "piki:gh", enabled: false }, { source: "npm:pi-web-access@0.46.0", enabled: false }])], ["tunnel"], "other extensions offer no session tools");
  assert.deepEqual([...sessionToolsOff([{ source: "piki:tunnel", enabled: true }])], []);
  assert.deepEqual([...sessionToolsOff([{ source: "piki:tunnel", enabled: false }])], ["tunnel"]);
  assert.deepEqual([...sessionToolsOff([{ source: "piki:tunnel", enabled: false }], { failClosedOnly: true })], ["tunnel"], "and fails closed: an answer that doesn't turn it on leaves it off");
  assert.equal(sessionToolExtensionOn([], "piki:tunnel"), false);
  assert.equal(sessionToolExtensionOn([{ source: "piki:tunnel", enabled: true }], "piki:tunnel"), true);
  assert.equal(sessionToolExtensionOn([], "piki:schedule"), true);
  assert.equal(sessionToolExtensionOn([{ source: "piki:schedule", enabled: false }], "piki:schedule"), false);
  assert.equal(sessionToolExtensionOn([{ source: "piki:files", enabled: false }], "piki:files"), true, "core tools stay on");
});

test("document sources: each kind has its own switch, source_read is off only once every kind is, and piki:sources still counts", () => {
  const off = (source: string) => ({ source, enabled: false });
  const kinds = ["piki:notion", "piki:google-drive", "piki:dropbox", "piki:onedrive", "piki:feishu", "piki:tencent-docs"];
  assert.deepEqual([...documentKindsOff([])], []);
  assert.deepEqual([...documentKindsOff([off("piki:notion")])], ["notion"]);
  // Whether source_read is off (the opt-in tunnel is off too, until a workspace turns it on).
  const sourcesOff = (workspace: { source: string; enabled: boolean }[]) => sessionToolsOff(workspace).has("source_read");
  assert.equal(sourcesOff([off("piki:notion")]), false, "source_read stays on for the other kinds");
  assert.equal(sourcesOff(kinds.map(off)), true);
  // Before the split, one switch turned them all off: a workspace that hasn't chosen a kind since follows it.
  assert.equal(sourcesOff([off("piki:sources")]), true);
  assert.deepEqual([...documentKindsOff([off("piki:sources")])].sort(), ["dropbox", "feishu", "google-drive", "notion", "onedrive", "tencent-docs"]);
  assert.deepEqual([...documentKindsOff([off("piki:sources"), { source: "piki:notion", enabled: true }])].sort(), ["dropbox", "feishu", "google-drive", "onedrive", "tencent-docs"]);
  assert.equal(sourcesOff([off("piki:sources"), { source: "piki:notion", enabled: true }]), false);
  assert.deepEqual([...documentKindsOff([{ source: "piki:sources", enabled: true }, off("piki:dropbox")])], ["dropbox"]);
});

test("bash and host_bash are retired: their switches turn nothing on or off, while git, node, python and the file tools stay", async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pikibun-shell-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const offered: string[][] = [];
  const noting = (context: { messages: { role: string; toolsAdded?: { name: string }[]; toolsRemoved?: { name: string }[] }[] }) => {
    const tools = new Set<string>();
    for (const message of context.messages) {
      if (message.role !== "system") continue;
      for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
      for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
    }
    offered.push([...tools]);
    return fauxAssistantMessage("Noted.");
  };
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses([noting, noting] as never);
  const models = createModels();
  models.setProvider(faux.provider);
  let current: WorkspaceExtensionsAnswer = { extensions: [], automaticTools: false };
  const service = new RunnerService({
    dataDir: directory, sharedSecret: "runner-shell-secret-not-a-production-secret", controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, unsandboxed: true,
    authorize: async (input: AuthorizationRequest) => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    extensions: { installed: () => [], workspace: async () => current, lastKnown: () => current },
  });
  await service.initialize();
  t.after(() => service.close());
  const id = "shell-session";
  const value = binding(id);
  // A stored agent may still name them.
  value.agent.tools = ["bash", "host_bash", "node", "python", "read_file", "write_file", "move_file"];
  const session = await service.provision(value, await ticket(id, "create"));
  const send = async (requestId: string) => {
    await session.submit(await ticket(id, "submit"), { content: "Which tools?", requestId, admissionId: await sha256(requestId) }, "write");
    await idle(session);
  };
  // Turned on, explicitly, as a workspace may have left them.
  const on = (source: string) => ({ source, enabled: true, tools: "approval" as const, settings: {} });
  current = { extensions: [on("piki:shell"), on("piki:host-shell")], automaticTools: false };
  await send("on");
  // And off.
  current = { extensions: [{ ...on("piki:shell"), enabled: false }, { ...on("piki:host-shell"), enabled: false }], automaticTools: false };
  await send("off");
  for (const tools of offered) {
    assert.ok(!tools.includes("bash") && !tools.includes("host_bash"), tools.join());
    for (const tool of ["node", "python", "read_file", "write_file", "move_file", "codemode"]) assert.ok(tools.includes(tool), `${tool}: ${tools.join()}`);
  }
  assert.equal(offered.length, 2);
});

test("the brokered tools have their own switches; the file tools have none that turns them off (piki:files is core)", async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pikibun-brokered-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let offered: string[] = [];
  let instructions = "";
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses([((context: { systemPrompt?: string; messages: { role: string; content?: unknown; toolsAdded?: { name: string }[] }[] }) => {
    offered = context.messages.flatMap(message => message.role === "system" ? (message.toolsAdded ?? []).map(tool => tool.name) : []);
    // All the model is given, instructions included, wherever the conversation puts them.
    instructions = JSON.stringify(context);
    return fauxAssistantMessage("Noted.");
  }) as never]);
  const models = createModels();
  models.setProvider(faux.provider);
  const disabled = (source: string) => ({ source, enabled: false, tools: "approval" as const, settings: {} });
  const answer: WorkspaceExtensionsAnswer = { extensions: ["piki:github", "piki:sources", "piki:sessions", "piki:git", "piki:files"].map(disabled), automaticTools: false };
  const service = new RunnerService({
    dataDir: directory, sharedSecret: "runner-brokered-secret-not-a-production-secret", controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, unsandboxed: true,
    authorize: async (input: AuthorizationRequest) => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    extensions: { installed: () => [], workspace: async () => answer },
  });
  await service.initialize();
  t.after(() => service.close());
  const id = "brokered-session";
  const every = binding(id);
  every.agent.tools = ["node", "git", "git_push", "github_read", "github_comment", "github_issue", "github_merge", "source_read", "sessions", "read_file", "write_file", "move_file", "search"];
  const session = await service.provision(every, await ticket(id, "create"));
  await session.submit(await ticket(id, "submit"), { content: "Which tools?", requestId: "brokered", admissionId: await sha256("brokered") }, "write");
  await idle(session);
  for (const tool of ["github_read", "github_comment", "github_issue", "github_merge", "source_read", "sessions", "git", "git_push"]) assert.ok(!offered.includes(tool), tool);
  for (const tool of ["node", "read_file", "write_file", "move_file", "search"]) assert.ok(offered.includes(tool), `${tool}: ${offered.join()}`);
  // Nor are they recommended to it while off (review of #189).
  assert.ok(instructions.includes("To find and read code"), "the instructions were read");
  assert.ok(!instructions.includes("github_read with wait"), "no github_read advice while piki:github is off");
  assert.ok(!instructions.includes("git_push publishes"), "no git_push advice while piki:git is off");
});
