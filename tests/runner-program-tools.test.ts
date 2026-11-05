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
import { browserAt, hostBrowser, SANDBOX_BROWSER_DRIVER } from "../apps/runner/src/browser-toolchain.js";
import { linuxSandboxMissing } from "./helpers/workspaces.js";

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

/** A Chromium for the browser tool's session test: PIKIBUN_TEST_BROWSER, or the host's own. */
const chromium = process.env.PIKIBUN_TEST_BROWSER ? browserAt(process.env.PIKIBUN_TEST_BROWSER) : hostBrowser();

test("the browser tool drives the host's Chromium in the session's sandbox as one exact command card, answering with the page and its screenshot; piki:browser turns it off",
  { skip: linuxSandboxMissing() ?? ((!chromium && "no Chromium on this host (PIKIBUN_TEST_BROWSER names one)") || undefined) }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pikibun-browser-tool-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  let seen: unknown;
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("browser", { url: "javascript:alert(1)" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("write_file", { path: "site/index.html", content: "<!doctype html><title>Faux app</title><h1>Hello from the sandbox</h1><button>Go</button>" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("browser", { serve: { program: "python3", args: ["-m", "http.server", String(port), "--bind", "127.0.0.1"], port, directory: "site" }, url: `http://127.0.0.1:${port}/`,
      actions: [{ action: "evaluate", expression: "document.querySelector('h1').textContent" }] })], { stopReason: "toolUse" }),
    context => { seen = context.messages.at(-1); return fauxAssistantMessage("Seen."); },
    fauxAssistantMessage([fauxToolCall("browser", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage("Off."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  let answer: WorkspaceExtensionsAnswer = { extensions: [], automaticTools: false };
  const service = new RunnerService({
    dataDir: directory, sharedSecret: "runner-browser-test-secret-not-a-production-secret", controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, allowTestShell: true,
    authorize: async (input: AuthorizationRequest) => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    extensions: { installed: () => [], workspace: async () => answer },
    browser: chromium,
  });
  await service.initialize();
  t.after(() => service.close());
  const id = "browser-session";
  // Not a clone session: its sandbox needs nothing of the control plane's repositories.
  const sandboxed = binding(id);
  delete sandboxed.session.repositoryMode;
  const session = await service.provision(sandboxed, await ticket(id, "create"));
  await session.submit(await ticket(id, "submit"), { content: "Look at the app.", requestId: "look", admissionId: await sha256("browser admission") }, "write");
  const approval = await pendingApproval(session);
  // A program operation of its own: the driver, and the host's Chromium where the sandbox gives it.
  assert.equal(approval.operation.kind, "program");
  assert.equal(approval.operation.kind === "program" && approval.operation.tool, "browser");
  const command = approval.operation.kind === "program" ? approval.operation.command : "";
  assert.equal(session.sandbox.browser!.driver, SANDBOX_BROWSER_DRIVER);
  assert.ok(command.startsWith(`'${SANDBOX_BROWSER_DRIVER}' '--chrome' '${session.sandbox.browser!.chromium}' '--time-limit' '30' '{"url":"http://127.0.0.1:${port}/"`), command);
  await session.decide(await ticket(id, "approve"), approval.id, { decision: "approve", operation: approval.operation });
  await idle(session);
  let view = await session.view();
  assert.equal(view.approvals.length, 1, "the refused call left no card");
  assert.equal(view.approvals[0]!.status, "executed", view.approvals[0]!.result?.slice(0, 4000));
  const transcript = view.entries.map(entry => entry.text).join("\n");
  assert.match(transcript, /url is an http, https or file URL, or about:blank\. Nothing ran\./);
  assert.match(transcript, /Seen\./);
  // The model got the report, without the raw output, and the screenshot as an image.
  const result = seen as { role: string; toolName: string; content: { type: string; text?: string; mimeType?: string }[] };
  assert.equal(result.role, "toolResult");
  assert.equal(result.toolName, "browser");
  const answerText = JSON.parse(result.content.find(part => part.type === "text")!.text!) as { status: string; result?: string; report: { title: string; actions: { value?: string }[]; screenshot: string } };
  assert.equal(answerText.status, "executed");
  assert.equal(answerText.result, undefined);
  assert.equal(answerText.report.title, "Faux app");
  assert.equal(answerText.report.actions[0]!.value, "Hello from the sandbox");
  assert.ok(result.content.some(part => part.type === "image" && /^image\/(png|jpeg|webp)$/.test(part.mimeType ?? "")), "the screenshot reached the model");
  // The Browser tab reads the same report and screenshot from the worktree.
  const listing = await session.sandbox.browse("browser-output", async () => {});
  assert.equal(listing.type, "directory");
  assert.ok(listing.type === "directory" && listing.entries.some(entry => entry.name === answerText.report.screenshot.split("/").at(-1)));

  answer = { extensions: [{ source: "piki:browser", enabled: false, tools: "approval", settings: {} }], automaticTools: false };
  await session.submit(await ticket(id, "submit"), { content: "Again?", requestId: "off", admissionId: await sha256("browser admission off") }, "write");
  await idle(session);
  view = await session.view();
  assert.match(view.entries.map(entry => entry.text).join("\n"), /Tool browser is not available/);
  assert.equal(view.approvals.length, 1);
});

test("a session on the host is never offered the browser tool, even where the host has a Chromium: it runs only in the session's sandbox", { skip: process.platform === "win32" }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pikibun-browser-host-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("browser", { url: "https://example.com/" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("None."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const service = new RunnerService({
    dataDir: directory, sharedSecret: "runner-browser-host-secret-not-a-production-secret", controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, unsandboxed: true,
    authorize: async (input: AuthorizationRequest) => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    extensions: { installed: () => [], workspace: async () => ({ extensions: [], automaticTools: false }) },
    browser: { executable: "/opt/google/chrome/chrome", directory: "/opt/google/chrome" },
  });
  await service.initialize();
  t.after(() => service.close());
  const id = "browser-host-session";
  const session = await service.provision(binding(id), await ticket(id, "create"));
  assert.equal(session.sandbox.browser, undefined);
  await session.submit(await ticket(id, "submit"), { content: "Look.", requestId: "look", admissionId: await sha256("browser host admission") }, "write");
  await idle(session);
  const view = await session.view();
  assert.match(view.entries.map(entry => entry.text).join("\n"), /Tool browser is not available/);
  assert.equal(view.approvals.length, 0, "nothing ran on the host");
});
