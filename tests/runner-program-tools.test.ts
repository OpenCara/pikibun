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
import type { ApprovalRecord, AuthorizationRequest, RunnerAction, RunnerBinding, RunnerTicket } from "../packages/shared/src/types.js";
import { toolNames } from "../packages/shared/src/types.js";
import type { WorkspaceExtensionsAnswer } from "../packages/shared/src/host-extensions.js";
import { sha256 } from "../packages/shared/src/crypto.js";
import { browserAt, hostBrowser, SANDBOX_BROWSER_DRIVER } from "../apps/runner/src/browser-toolchain.js";
import type { HostBrowserStatus } from "../packages/shared/src/browser.js";
import { linuxSandboxMissing } from "./helpers/workspaces.js";
import { bundledToolDefinitions, type ProgramToolDefinition } from "../packages/shared/src/tool-definitions.js";

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

async function records(session: RunnerSession): Promise<ApprovalRecord[]> {
  return Object.values((await (session as unknown as { metadata(): Promise<{ approvals: Record<string, ApprovalRecord> }> }).metadata()).approvals);
}

async function ranLast(session: RunnerSession): Promise<ApprovalRecord> {
  await idle(session);
  const ran = (await records(session)).at(-1);
  assert.ok(ran, "a program call ran");
  return ran;
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

  const approval = await ranLast(session);
  assert.deepEqual(approval.operation, { kind: "program", tool: "git", command: "GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true GIT_TERMINAL_PROMPT=0 git --no-pager 'init' '-q' 'my repo' </dev/null 2>&1" });
  await idle(session);
  let view = await session.view();
  assert.match(await session.sandbox.readFile("my repo/.git/HEAD", async () => {}), /^ref: refs\/heads\//);
  assert.equal((await records(session)).length, 1, "the refused calls left no card");
  assert.equal((await records(session))[0]!.status, "executed");
  let transcript = view.entries.map(entry => entry.text).join("\n");
  assert.match(transcript, /git config isn't one the git tool runs/);
  assert.match(transcript, /within the session's worktree/);
  assert.match(transcript, /Initialized\./);

  answer = { extensions: [{ source: "piki:git", enabled: false, tools: "automatic", settings: {} }], automaticTools: false };
  await session.submit(await ticket(id, "submit"), { content: "Status?", requestId: "off", admissionId: await sha256("git admission off") }, "write");
  await idle(session);
  view = await session.view();
  transcript = view.entries.map(entry => entry.text).join("\n");
  assert.match(transcript, /Tool git is not available/);
  assert.equal((await records(session)).length, 1);
});

test("in a session from before the git tool, git runs the owner's commands at once, as any tool does", { skip: process.platform === "win32" }, async t => {
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
  await idle(session);
  assert.deepEqual((await records(session)).map(record => [record.operation.kind === "program" && record.operation.tool, record.status]), [["git", "executed"], ["git", "executed"]]);
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
  const approval = await ranLast(session);
  assert.deepEqual(approval.operation, { kind: "program", tool: "node",
    command: "PATH=\"${PATH:-/usr/bin:/bin}\":'/usr/local/bin' NO_COLOR=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 npm_config_yes=true node '-e' 'console.log('\\''node-tool-'\\'' + (6 * 7))' </dev/null 2>&1" });
  await idle(session);
  let view = await session.view();
  assert.equal((await records(session)).length, 1, "the refused call left no card");
  assert.equal((await records(session))[0]!.status, "executed");
  assert.match((await records(session))[0]!.result!, /node-tool-42/);
  assert.match(view.entries.map(entry => entry.text).join("\n"), /npm publish acts on a package registry as an account/);

  answer = { extensions: [{ source: "piki:node", enabled: false, tools: "automatic", settings: {} }], automaticTools: false };
  await session.submit(await ticket(id, "submit"), { content: "Version?", requestId: "off", admissionId: await sha256("node admission off") }, "write");
  await idle(session);
  view = await session.view();
  assert.match(view.entries.map(entry => entry.text).join("\n"), /Tool node is not available/);
  assert.equal((await records(session)).length, 1);
});

test("a program call's timeout_seconds ends it sooner than the host's command time limit; one out of range runs nothing", { skip: process.platform === "win32" }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pikibun-call-timeout-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("node", { program: "node", args: ["-e", "setTimeout(() => {}, 1000)"], timeout_seconds: 0 })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("node", { program: "node", args: ["-e", "setTimeout(() => console.log('woke'), 25000)"], timeout_seconds: 2 })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("git", { args: ["init", "-q", "repo"], timeout_seconds: 600 })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Done."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const service = new RunnerService({
    dataDir: directory, sharedSecret: "runner-timeout-test-secret-not-a-production-secret", controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, unsandboxed: true,
    authorize: async (input: AuthorizationRequest) => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    extensions: { installed: () => [], workspace: async () => ({ extensions: [], automaticTools: false }) },
  });
  await service.initialize();
  t.after(() => service.close());
  const id = "timeout-session";
  const session = await service.provision(binding(id), await ticket(id, "create"));
  const started = Date.now();
  await session.submit(await ticket(id, "submit"), { content: "Wait.", requestId: "wait", admissionId: await sha256("timeout admission") }, "write");
  for (let count = 0; count < 1000 && (await records(session)).filter(record => record.status !== "executing").length < 2; count++) await delay(20);
  await idle(session);
  const ran = await records(session);
  assert.equal(ran.length, 2, "the call out of range left no card");
  assert.equal(ran[0]!.status, "failed");
  assert.match(ran[0]!.result!, /2000ms time limit/);
  assert.doesNotMatch(ran[0]!.result!, /woke/);
  assert.ok(Date.now() - started < 20_000, `the 2-second timeout took ${Date.now() - started} ms`);
  assert.equal(ran[1]!.status, "executed", "a timeout longer than the host's limit keeps the host's");
  assert.match(await session.sandbox.readFile("repo/.git/HEAD", async () => {}), /^ref: refs\/heads\//);
  assert.match((await session.view()).entries.map(entry => entry.text).join("\n"), /timeout_seconds: expected >= 1/);
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
  assert.deepEqual((await records(session)).map(record => [record.operation.kind === "program" && record.operation.tool, record.status]), [["python", "executed"], ["python", "executed"]],
    "the refused call ran nothing; the others ran at once");
  assert.match(view.entries.map(entry => entry.text).join("\n"), /venv-python True True/);
  assert.match(view.entries.map(entry => entry.text).join("\n"), /uv publish acts on a package index as an account/);

  answer = { extensions: [{ source: "piki:python", enabled: false, tools: "automatic", settings: {} }], automaticTools: false };
  await session.submit(await ticket(id, "submit"), { content: "Version?", requestId: "off", admissionId: await sha256("python admission off") }, "write");
  await idle(session);
  view = await session.view();
  assert.match(view.entries.map(entry => entry.text).join("\n"), /Tool python is not available/);
  assert.equal((await records(session)).length, 2);
});

test("the rust, go and dotnet tools run their programs without a shell, as one exact command card; their switches turn them off", { skip: process.platform === "win32" }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pikibun-ecosystem-tools-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let instructions = "";
  let offInstructions = "";
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses([
    ((context: unknown) => {
      instructions = JSON.stringify(context);
      return fauxAssistantMessage([fauxToolCall("rust", { program: "cargo", args: ["+nightly", "publish"] })], { stopReason: "toolUse" });
    }) as never,
    fauxAssistantMessage([fauxToolCall("dotnet", { program: "dotnet", args: ["nuget", "push", "app.nupkg"] })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("go", { program: "go", args: ["test", "./..."], directory: "app" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Asked."),
    ((context: unknown) => {
      offInstructions = JSON.stringify(context);
      return fauxAssistantMessage([fauxToolCall("rust", { program: "cargo", args: ["--version"] })], { stopReason: "toolUse" });
    }) as never,
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
  const approval = await ranLast(session);
  assert.deepEqual(approval.operation, { kind: "program", tool: "go",
    command: "cd -- './app' && PATH=\"${PATH:-/usr/bin:/bin}\":'/usr/local/go/bin':'/usr/lib/go/bin':'/usr/local/bin' NO_COLOR=1 go 'test' './...' </dev/null 2>&1" });
  await idle(session);
  let view = await session.view();
  assert.equal((await records(session)).length, 1, "the refused calls left no card");
  const said = view.entries.map(entry => entry.text).join("\n");
  assert.match(said, /cargo publish acts on a package registry as an account/);
  assert.match(said, /dotnet nuget push acts on a package registry as an account/);
  assert.match(instructions, /Run cargo, rustc, rustup and rustfmt, go and gofmt, dotnet, make with the rust, go, dotnet, make tools: .*such as rust \{program/, "the agent is told how to use them");

  answer = { extensions: [{ source: "piki:rust", enabled: false, tools: "automatic", settings: {} }], automaticTools: false };
  await session.submit(await ticket(id, "submit"), { content: "Version?", requestId: "off", admissionId: await sha256("ecosystem admission off") }, "write");
  await idle(session);
  view = await session.view();
  assert.match(view.entries.map(entry => entry.text).join("\n"), /Tool rust is not available/);
  assert.equal((await records(session)).length, 1);
  assert.match(offInstructions, /Run go and gofmt, dotnet, make with the go, dotnet, make tools: .*such as go \{program/);
});

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
    fauxAssistantMessage([fauxToolCall("write", { path: "site/index.html", content: "<!doctype html><title>Faux app</title><h1>Hello from the sandbox</h1><button>Go</button>" })], { stopReason: "toolUse" }),
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
  const sandboxed = binding(id);
  delete sandboxed.session.repositoryMode;
  const session = await service.provision(sandboxed, await ticket(id, "create"));
  await session.submit(await ticket(id, "submit"), { content: "Look at the app.", requestId: "look", admissionId: await sha256("browser admission") }, "write");
  const approval = await ranLast(session);
  assert.equal(approval.operation.kind, "program");
  assert.equal(approval.operation.kind === "program" && approval.operation.tool, "browser");
  const command = approval.operation.kind === "program" ? approval.operation.command : "";
  assert.equal(session.sandbox.browser!.driver, SANDBOX_BROWSER_DRIVER);
  assert.ok(command.startsWith(`'${SANDBOX_BROWSER_DRIVER}' '--chrome' '${session.sandbox.browser!.chromium}' '--time-limit' '30' '{"url":"http://127.0.0.1:${port}/"`), command);
  await idle(session);
  let view = await session.view();
  assert.equal((await records(session)).length, 1, "the refused call left no card");
  assert.equal((await records(session))[0]!.status, "executed", (await records(session))[0]!.result?.slice(0, 4000));
  const transcript = view.entries.map(entry => entry.text).join("\n");
  assert.match(transcript, /url is an http, https or file URL, or about:blank\. Nothing ran\./);
  assert.match(transcript, /Seen\./);
  const result = seen as { role: string; toolName: string; content: { type: string; text?: string; mimeType?: string }[] };
  assert.equal(result.role, "toolResult");
  assert.equal(result.toolName, "browser");
  const answerText = JSON.parse(result.content.find(part => part.type === "text")!.text!) as { status: string; result?: string; report: { title: string; actions: { value?: string }[]; screenshot: string } };
  assert.equal(answerText.status, "executed");
  assert.equal(answerText.result, undefined);
  assert.equal(answerText.report.title, "Faux app");
  assert.equal(answerText.report.actions[0]!.value, "Hello from the sandbox");
  assert.ok(result.content.some(part => part.type === "image" && /^image\/(png|jpeg|webp)$/.test(part.mimeType ?? "")), "the screenshot reached the model");
  const listing = await session.sandbox.browse("browser-output", async () => {});
  assert.equal(listing.type, "directory");
  assert.ok(listing.type === "directory" && listing.entries.some(entry => entry.name === answerText.report.screenshot.split("/").at(-1)));

  answer = { extensions: [{ source: "piki:browser", enabled: false, tools: "automatic", settings: {} }], automaticTools: false };
  await session.submit(await ticket(id, "submit"), { content: "Again?", requestId: "off", admissionId: await sha256("browser admission off") }, "write");
  await idle(session);
  view = await session.view();
  assert.match(view.entries.map(entry => entry.text).join("\n"), /Tool browser is not available/);
  assert.equal((await records(session)).length, 1);
});

test("a session on the host is never offered the browser tool, even where the host has a Chromium: it runs only in the session's sandbox", { skip: process.platform === "win32" }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pikibun-browser-host-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  let instructions = "";
  faux.setResponses([
    ((context: unknown) => {
      instructions = JSON.stringify(context);
      return fauxAssistantMessage([fauxToolCall("browser", { url: "https://example.com/" })], { stopReason: "toolUse" });
    }) as never,
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
  assert.equal((await records(session)).length, 0, "nothing ran on the host");
  assert.deepEqual(view.extensions?.unavailable, [{ source: "piki:browser", tools: ["browser"], reason: "on-host" }]);
  assert.match(instructions, /This session has no browser tool: The browser runs only in a session's sandbox, and this session runs on its host itself/);
});

test("a sandboxed session whose host has no Chromium yet says why it has no browser, and offers it once the host has one", { skip: linuxSandboxMissing() }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pikibun-browser-missing-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const offered: string[][] = [];
  const instructions: string[] = [];
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  const reply = ((context: { messages: { role: string; toolsAdded?: { name: string }[]; toolsRemoved?: string[] }[] }) => {
    offered.push(context.messages.flatMap(message => message.role === "system" ? (message.toolsAdded ?? []).map(tool => tool.name) : []));
    instructions.push(JSON.stringify(context));
    return fauxAssistantMessage("Noted.");
  }) as never;
  faux.setResponses([reply, reply]);
  const models = createModels();
  models.setProvider(faux.provider);
  let current: { executable: string; directory: string } | undefined;
  let status: HostBrowserStatus = { source: "download", state: "downloading", downloadable: true };
  const service = new RunnerService({
    dataDir: directory, sharedSecret: "runner-browser-missing-secret-not-a-production-secret", controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true,
    authorize: async (input: AuthorizationRequest) => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    extensions: { installed: () => [], workspace: async () => ({ extensions: [], automaticTools: false }) },
    browser: () => current, browserStatus: () => status,
  });
  await service.initialize();
  t.after(() => service.close());
  const id = "browser-missing-session";
  const session = await service.provision(binding(id), await ticket(id, "create"));
  assert.equal(session.sandbox.browser, undefined);
  const browserEntries = async () => (await session.view()).extensions?.unavailable?.filter(item => item.source === "piki:browser") ?? [];
  assert.deepEqual(await browserEntries(), [{ source: "piki:browser", tools: ["browser"], reason: "downloading" }]);
  await session.submit(await ticket(id, "submit"), { content: "Look.", requestId: "look", admissionId: await sha256("browser missing admission") }, "write");
  await idle(session);
  assert.ok(!offered[0]!.includes("browser"));
  assert.match(instructions[0]!, /This session has no browser tool: This host is downloading Chromium for the browser/);
  current = { executable: "/opt/chrome-headless-shell/chrome-headless-shell", directory: "/opt/chrome-headless-shell" };
  status = { source: "download", state: "ready", executable: current.executable, version: "131.0.6778.85", downloadable: true };
  assert.deepEqual(await browserEntries(), []);
  assert.deepEqual(session.sandbox.browser, { driver: SANDBOX_BROWSER_DRIVER, chromium: "/opt/pikibun/chromium/chrome-headless-shell" });
  await session.submit(await ticket(id, "submit"), { content: "Again.", requestId: "again", admissionId: await sha256("browser missing admission again") }, "write");
  await idle(session);
  assert.ok(offered.flat().includes("browser"), JSON.stringify(offered));
  assert.match(instructions[1]!, /To look at or test a web page, use the browser tool/);
});

test("the make tool runs make without a shell of its own, as one exact command card; piki:make turns it off", { skip: process.platform === "win32" }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pikibun-make-tool-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let instructions = "";
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses([
    ((context: unknown) => {
      instructions = JSON.stringify(context);
      return fauxAssistantMessage([fauxToolCall("make", { program: "make", args: ["-j4", "test"], directory: "app" })], { stopReason: "toolUse" });
    }) as never,
    fauxAssistantMessage("Asked."),
    fauxAssistantMessage([fauxToolCall("make", { program: "make", args: ["--version"] })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Off."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  let answer: WorkspaceExtensionsAnswer = { extensions: [], automaticTools: false };
  const service = new RunnerService({
    dataDir: directory, sharedSecret: "runner-make-test-secret-not-a-production-secret", controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, unsandboxed: true,
    authorize: async (input: AuthorizationRequest) => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    extensions: { installed: () => [], workspace: async () => answer },
  });
  await service.initialize();
  t.after(() => service.close());
  const id = "make-session";
  const session = await service.provision(binding(id), await ticket(id, "create"));
  await session.submit(await ticket(id, "submit"), { content: "Test it.", requestId: "run", admissionId: await sha256("make admission") }, "write");
  const approval = await ranLast(session);
  assert.deepEqual(approval.operation, { kind: "program", tool: "make", command: "cd -- './app' && PATH=\"${PATH:-/usr/bin:/bin}\":'/usr/local/bin' make '-j4' 'test' </dev/null 2>&1" });
  await idle(session);
  assert.match(instructions, /Run cargo, rustc, rustup and rustfmt, go and gofmt, dotnet, make with the rust, go, dotnet, make tools/);

  answer = { extensions: [{ source: "piki:make", enabled: false, tools: "automatic", settings: {} }], automaticTools: false };
  await session.submit(await ticket(id, "submit"), { content: "Version?", requestId: "off", admissionId: await sha256("make admission off") }, "write");
  await idle(session);
  const view = await session.view();
  assert.match(view.entries.map(entry => entry.text).join("\n"), /Tool make is not available/);
  assert.equal((await records(session)).length, 1);
});

test("in the Linux sandbox, a program tool's program the host lacks is named with how its owner installs it, and a call to it is refused before anyone is asked", { skip: linuxSandboxMissing() }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pikibun-missing-programs-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let instructions = "";
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses([
    ((context: unknown) => {
      instructions = JSON.stringify(context);
      return fauxAssistantMessage([fauxToolCall("frob", { program: "frob-not-installed-anywhere", args: ["test"] })], { stopReason: "toolUse" });
    }) as never,
    fauxAssistantMessage([fauxToolCall("frob", { program: "env", args: [] })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Asked."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  let answer: WorkspaceExtensionsAnswer = { extensions: [], automaticTools: false };
  const { summary: _summary, ...make } = bundledToolDefinitions.find(definition => definition.name === "make") as ProgramToolDefinition;
  const frob: ProgramToolDefinition = { ...make, name: "frob", extensions: ["piki:frob"], programs: ["frob-not-installed-anywhere", "env"] };
  const service = new RunnerService({
    dataDir: directory, sharedSecret: "runner-missing-programs-secret-not-a-production-secret", controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, allowTestShell: true,
    authorize: async (input: AuthorizationRequest) => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    extensions: { installed: () => [], workspace: async () => answer },
    toolDefinitions: async () => [frob],
  });
  await service.initialize();
  t.after(() => service.close());
  const id = "missing-programs-session";
  const bound = binding(id);
  delete bound.session.repositoryMode;
  const session = await service.provision({ ...bound, agent: { ...bound.agent, tools: [...bound.agent.tools, "frob"] } }, await ticket(id, "create"));
  assert.deepEqual((await session.view()).extensions?.unavailable?.find(item => item.source === "piki:frob"),
    { source: "piki:frob", tools: ["frob"], reason: "programs", programs: ["frob-not-installed-anywhere"] });
  await session.submit(await ticket(id, "submit"), { content: "Test it.", requestId: "run", admissionId: await sha256("missing programs admission") }, "write");
  await idle(session);
  const view = await session.view();
  assert.match(view.entries.map(entry => entry.text).join("\n"), /frob-not-installed-anywhere isn't installed on this host where the session's sandbox sees it[^]*Nothing ran\./);
  assert.match(instructions, /This host doesn't have the frob tool's frob-not-installed-anywhere[^.]* where the session's sandbox sees them/);
  assert.match(instructions, /Calls to them are refused before they run/);
  answer = { extensions: [{ source: "piki:frob", enabled: false, tools: "automatic", settings: {} }], automaticTools: false };
  assert.equal((await session.view()).extensions?.unavailable?.find(item => item.source === "piki:frob"), undefined);
});
