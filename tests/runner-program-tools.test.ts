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
import type { AuthorizationRequest, RunnerAction, RunnerBinding, RunnerTicket } from "../packages/shared/src/types.js";
import { toolNames } from "../packages/shared/src/types.js";
import type { WorkspaceExtensionsAnswer } from "../packages/shared/src/host-extensions.js";
import { sha256 } from "../packages/shared/src/crypto.js";

function binding(id: string): RunnerBinding {
  return {
    session: { id, workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1", title: "Git", policyVersion: 1, status: "ready", createdAt: "2026-01-01T00:00:00Z", repositories: [], repositoryMode: "clone" },
    owner: { id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice Owner", gitEmail: "alice@example.test", env: {}, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: "test:alice", workspaceId: "workspace", version: 1, name: "Agent", description: "", instructions: "Use tools.", tools: [...toolNames], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "workspace", name: "Model", provider: "faux", modelId: "faux-1" },
  };
}

async function ticket(id: string, action: RunnerAction): Promise<RunnerTicket> {
  const now = Math.floor(Date.now() / 1000);
  return { aud: "runner", sessionId: id, actorId: "test:alice", ownerId: "test:alice", action, policyVersion: 1, iat: now, exp: now + 60, jti: randomUUID(), bodyHash: await sha256("") };
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

test("the git tool runs Git without a shell: refused calls ask nobody, others get one exact command card; piki:git turns it off", { skip: process.platform === "win32" }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pikibun-git-tool-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("git", { args: ["config", "core.fsmonitor", "touch pwned"] })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("git", { args: ["status"], directory: "../elsewhere" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("git", { args: ["init", "-q", "my repo"] })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Initialized."),
    fauxAssistantMessage([fauxToolCall("git", { args: ["status"], directory: "my repo" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Off."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  let answer: WorkspaceExtensionsAnswer = { extensions: [], automaticTools: false };
  const service = new RunnerService({
    dataDir: directory, sharedSecret: "runner-git-test-secret-not-a-production-secret", controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, unsandboxed: true,
    authorize: async (input: AuthorizationRequest) => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    extensions: { installed: () => [], workspace: async () => answer },
  });
  await service.initialize();
  t.after(() => service.close());
  const id = "git-session";
  const session = await service.provision(binding(id), await ticket(id, "create"));
  await session.submit(await ticket(id, "submit"), { content: "Make a repository.", requestId: "init", admissionId: await sha256("git admission") }, "write");

  const approval = await pendingApproval(session);
  assert.deepEqual(approval.operation, { kind: "program", tool: "git", command: "GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true GIT_TERMINAL_PROMPT=0 git --no-pager 'init' '-q' 'my repo' </dev/null 2>&1" });
  await session.decide(await ticket(id, "approve"), approval.id, { decision: "approve", operation: approval.operation });
  await idle(session);
  let view = await session.view();
  assert.match(await session.sandbox.readFile("my repo/.git/HEAD", async () => {}), /^ref: refs\/heads\//);
  assert.equal(view.approvals.length, 1, "the refused calls left no card");
  assert.equal(view.approvals[0]!.status, "executed");
  let transcript = view.entries.map(entry => entry.text).join("\n");
  assert.match(transcript, /git config isn't one the git tool runs/);
  assert.match(transcript, /within the session's worktree/);
  assert.match(transcript, /Initialized\./);

  // Turned off in the workspace: neither offered nor run.
  answer = { extensions: [{ source: "piki:git", enabled: false, tools: "approval", settings: {} }], automaticTools: false };
  await session.submit(await ticket(id, "submit"), { content: "Status?", requestId: "off", admissionId: await sha256("git admission off") }, "write");
  await idle(session);
  view = await session.view();
  transcript = view.entries.map(entry => entry.text).join("\n");
  // Not offered, so the model can't call it; a code mode script calling it by name is refused (requireSessionTool).
  assert.match(transcript, /Tool git is not available/);
  assert.equal(view.approvals.length, 1);
});

test("in a session from before the git tool, allowing git for the session runs the owner's git commands without asking, as allowing bash does", { skip: process.platform === "win32" }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pikibun-git-grant-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("git", { args: ["init", "-q", "first"] })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("git", { args: ["init", "-q", "second"] })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Both."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const service = new RunnerService({
    dataDir: directory, sharedSecret: "runner-git-grant-secret-not-a-production-secret", controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, unsandboxed: true,
    authorize: async (input: AuthorizationRequest) => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
  });
  await service.initialize();
  t.after(() => service.close());
  const id = "git-grant-session";
  const old = binding(id);
  old.agent.tools = ["read_file", "bash"];
  const session = await service.provision(old, await ticket(id, "create"));
  await session.submit(await ticket(id, "submit"), { content: "Make two repositories.", requestId: "grant", admissionId: await sha256("git grant admission") }, "write");
  const permission = await pendingApproval(session);
  assert.equal(permission.operation.kind, "permission");
  assert.equal(permission.operation.kind === "permission" && permission.operation.tool, "git");
  await session.decide(await ticket(id, "approve"), permission.id, { decision: "approve", operation: permission.operation, scope: "session" });
  await idle(session);
  const view = await session.view();
  assert.deepEqual(view.approvals.filter(approval => approval.operation.kind !== "permission"), [], "no command card");
  assert.deepEqual(view.entries.flatMap(entry => entry.autoApproved ?? []), [{ tool: "git", status: "executed" }, { tool: "git", status: "executed" }]);
  assert.match(await session.sandbox.readFile("first/.git/HEAD", async () => {}), /^ref: refs\/heads\//);
  assert.match(await session.sandbox.readFile("second/.git/HEAD", async () => {}), /^ref: refs\/heads\//);
});

test("the node tool runs Node.js without a shell, as one exact command card; piki:node turns it off", { skip: process.platform === "win32" }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pikibun-node-tool-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("node", { program: "npm", args: ["publish"] })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("node", { program: "node", args: ["-e", "console.log('node-tool-' + (6 * 7))"] })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Ran."),
    fauxAssistantMessage([fauxToolCall("node", { program: "node", args: ["--version"] })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Off."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  let answer: WorkspaceExtensionsAnswer = { extensions: [], automaticTools: false };
  const service = new RunnerService({
    dataDir: directory, sharedSecret: "runner-node-test-secret-not-a-production-secret", controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, unsandboxed: true,
    authorize: async (input: AuthorizationRequest) => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    extensions: { installed: () => [], workspace: async () => answer },
  });
  await service.initialize();
  t.after(() => service.close());
  const id = "node-session";
  const session = await service.provision(binding(id), await ticket(id, "create"));
  await session.submit(await ticket(id, "submit"), { content: "Run it.", requestId: "run", admissionId: await sha256("node admission") }, "write");
  const approval = await pendingApproval(session);
  assert.deepEqual(approval.operation, { kind: "program", tool: "node",
    command: "PATH=\"${PATH:-/usr/bin:/bin}\":'/usr/local/bin' NO_COLOR=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 npm_config_yes=true node '-e' 'console.log('\\''node-tool-'\\'' + (6 * 7))' </dev/null 2>&1" });
  await session.decide(await ticket(id, "approve"), approval.id, { decision: "approve", operation: approval.operation });
  await idle(session);
  let view = await session.view();
  assert.equal(view.approvals.length, 1, "the refused call left no card");
  assert.equal(view.approvals[0]!.status, "executed");
  assert.match(view.approvals[0]!.result!, /node-tool-42/);
  assert.match(view.entries.map(entry => entry.text).join("\n"), /npm publish acts on a package registry as an account/);

  answer = { extensions: [{ source: "piki:node", enabled: false, tools: "approval", settings: {} }], automaticTools: false };
  await session.submit(await ticket(id, "submit"), { content: "Version?", requestId: "off", admissionId: await sha256("node admission off") }, "write");
  await idle(session);
  view = await session.view();
  assert.match(view.entries.map(entry => entry.text).join("\n"), /Tool node is not available/);
  assert.equal(view.approvals.length, 1);
});

test("the python tool runs Python without a shell, in a virtual environment it names; piki:python turns it off", { skip: process.platform === "win32" }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pikibun-python-tool-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("python", { program: "uv", args: ["publish"] })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("python", { program: "python3", args: ["-m", "venv", "--without-pip", ".venv"] })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("python", { program: "python3", args: ["-c", "import os, subprocess, sys; os.chdir('/'); "
      + "print('venv-python', sys.prefix != sys.base_prefix, subprocess.run(['python3', '-c', 'import sys; print(sys.prefix != sys.base_prefix)'], capture_output=True, text=True).stdout.strip())"], venv: ".venv" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Ran."),
    fauxAssistantMessage([fauxToolCall("python", { program: "python3", args: ["--version"] })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Off."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  let answer: WorkspaceExtensionsAnswer = { extensions: [], automaticTools: false };
  const service = new RunnerService({
    dataDir: directory, sharedSecret: "runner-python-test-secret-not-a-production-secret", controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, unsandboxed: true,
    authorize: async (input: AuthorizationRequest) => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    extensions: { installed: () => [], workspace: async () => answer },
  });
  await service.initialize();
  t.after(() => service.close());
  const id = "python-session";
  const session = await service.provision(binding(id), await ticket(id, "create"));
  await session.submit(await ticket(id, "submit"), { content: "Run it.", requestId: "run", admissionId: await sha256("python admission"), options: { access: "auto" } }, "write");
  await idle(session);
  let view = await session.view();
  assert.deepEqual(view.entries.flatMap(entry => entry.autoApproved ?? []), [{ tool: "python", status: "executed" }, { tool: "python", status: "executed" }],
    "the refused call ran nothing; the others ran under Auto-approve");
  // The environment's python3 also for a program that left its directory: on PATH as an absolute path (review of #186).
  assert.match(view.entries.map(entry => entry.text).join("\n"), /venv-python True True/);
  assert.match(view.entries.map(entry => entry.text).join("\n"), /uv publish acts on a package index as an account/);

  answer = { extensions: [{ source: "piki:python", enabled: false, tools: "approval", settings: {} }], automaticTools: false };
  await session.submit(await ticket(id, "submit"), { content: "Version?", requestId: "off", admissionId: await sha256("python admission off") }, "write");
  await idle(session);
  view = await session.view();
  assert.match(view.entries.map(entry => entry.text).join("\n"), /Tool python is not available/);
  assert.equal(view.entries.flatMap(entry => entry.autoApproved ?? []).length, 2);
});

test("the rust, go and dotnet tools run their programs without a shell, as one exact command card; their switches turn them off", { skip: process.platform === "win32" }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pikibun-ecosystem-tools-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let instructions = "";
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses([
    ((context: unknown) => {
      instructions = JSON.stringify(context);
      return fauxAssistantMessage([fauxToolCall("rust", { program: "cargo", args: ["+nightly", "publish"] })], { stopReason: "toolUse" });
    }) as never,
    fauxAssistantMessage([fauxToolCall("dotnet", { program: "dotnet", args: ["nuget", "push", "app.nupkg"] })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("go", { program: "go", args: ["test", "./..."], directory: "app" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Asked."),
    fauxAssistantMessage([fauxToolCall("rust", { program: "cargo", args: ["--version"] })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Off."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  let answer: WorkspaceExtensionsAnswer = { extensions: [], automaticTools: false };
  const service = new RunnerService({
    dataDir: directory, sharedSecret: "runner-ecosystem-test-secret-not-a-production-secret", controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, unsandboxed: true,
    authorize: async (input: AuthorizationRequest) => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    extensions: { installed: () => [], workspace: async () => answer },
  });
  await service.initialize();
  t.after(() => service.close());
  const id = "ecosystem-session";
  const session = await service.provision(binding(id), await ticket(id, "create"));
  await session.submit(await ticket(id, "submit"), { content: "Test it.", requestId: "run", admissionId: await sha256("ecosystem admission") }, "write");
  // No toolchain needed: the card shows the exact command, and denying it runs nothing.
  const approval = await pendingApproval(session);
  assert.deepEqual(approval.operation, { kind: "program", tool: "go",
    command: "cd -- './app' && PATH=\"${PATH:-/usr/bin:/bin}\":'/usr/local/go/bin':'/usr/lib/go/bin':'/usr/local/bin' NO_COLOR=1 go 'test' './...' </dev/null 2>&1" });
  await session.decide(await ticket(id, "approve"), approval.id, { decision: "deny", operation: approval.operation });
  await idle(session);
  let view = await session.view();
  assert.equal(view.approvals.length, 1, "the refused calls left no card");
  assert.equal(view.approvals[0]!.status, "denied");
  const said = view.entries.map(entry => entry.text).join("\n");
  assert.match(said, /cargo publish acts on a package registry as an account/);
  assert.match(said, /dotnet nuget push acts on a package registry as an account/);
  assert.match(instructions, /Run cargo, rustc and rustup, go and gofmt, dotnet with the rust, go, dotnet tools/, "the agent is told how to use them");

  answer = { extensions: [{ source: "piki:rust", enabled: false, tools: "approval", settings: {} }], automaticTools: false };
  await session.submit(await ticket(id, "submit"), { content: "Version?", requestId: "off", admissionId: await sha256("ecosystem admission off") }, "write");
  await idle(session);
  view = await session.view();
  assert.match(view.entries.map(entry => entry.text).join("\n"), /Tool rust is not available/);
  assert.equal(view.approvals.length, 1);
});
