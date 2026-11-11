import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile, realpath } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createRegistry, defineDoc, Harness, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { signToken, sha256 } from "../packages/shared/src/crypto.js";
import type { ApprovalRecord, RunnerBinding, RunnerTicket, RunnerAction, Permission, AuthorizationRequest, SessionView } from "../packages/shared/src/types.js";
import { applyViewPatch, isRevision, type SessionViewPatch } from "../packages/shared/src/view-patch.js";
import type { RestoreDescriptor, RestoreInput } from "../packages/shared/src/connector.js";
import { RunnerError, assertId, requestKey, stableJson, validateBinding, validateOperation, verifyRunnerTicket } from "../apps/runner/src/protocol.js";
import { RunnerService, createRunnerApp } from "../apps/runner/src/server.js";
import { RunnerSession } from "../apps/runner/src/session.js";
import type { HostCommandPolicy } from "../apps/runner/src/session/host-commands.js";
import { commandLimits, type CommandLimits } from "../apps/runner/src/host-config.js";
import { HostWorkspace } from "../apps/runner/src/host-workspace.js";
import { defaultHostConfig } from "../packages/shared/src/host-config.js";
import { acquireRunnerLease } from "../apps/runner/src/lease.js";
import { runnerModels, testCommandArgs } from "../apps/runner/src/provider.js";
import { nodeRequest, nodeShellCommand } from "../apps/runner/src/node-command.js";

const SECRET = "runner-test-secret-not-a-production-secret-123456";
const allowTestOperation = async (): Promise<void> => {};
function binding(id: string, ownerId = "test:alice"): RunnerBinding {
  const name = ownerId === "test:alice" ? "Alice" : "Bob";
  return {
    session: { id, workspaceId: "workspace", ownerId, agentVersionId: "version-1", title: "Test", policyVersion: 1, status: "ready", createdAt: "2026-01-01T00:00:00Z" },
    owner: { id: ownerId, githubId: null, githubLogin: name.toLowerCase(), displayName: name, gitName: name, gitEmail: `${name.toLowerCase()}@example.test`, env: { APP_COLOR: name.toLowerCase() }, githubConnected: false },
    agent: { id: "version-1", agentId: "shared-agent", authorId: "test:author", workspaceId: "workspace", version: 1, name: "Shared", description: "Tests", instructions: "Use tools.", tools: ["identity", "read_file", "write_file", "list_files", "node", "bash", "github_comment"], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "workspace", name: "Explicit faux test provider", provider: "faux", modelId: "faux-1" },
  };
}
async function ticket(id: string, action: RunnerAction, actorId = "test:alice", body = "", ownerId = "test:alice"): Promise<RunnerTicket> {
  const now = Math.floor(Date.now() / 1000);
  return { aud: "runner", sessionId: id, actorId, ownerId, action, policyVersion: 1, iat: now, exp: now + 60, jti: randomUUID(), bodyHash: await sha256(body) };
}
async function idle(session: RunnerSession): Promise<void> {
  for (let count = 0; count < 500; count++) {
    if (!(await session.view()).busy) return;
    await delay(20);
  }
  assert.fail("runner did not settle");
}
function commandOperation(session: RunnerSession, command: string) {
  return { kind: "program" as const, tool: "node" as const, command: nodeShellCommand(nodeRequest(testCommandArgs(command)), session.sandbox.nodeBin) };
}

const toolOutput = (view: SessionView, marker: RegExp) => view.entries.some(entry => entry.role === "toolResult" && marker.test(entry.text));

async function records(session: RunnerSession): Promise<ApprovalRecord[]> {
  return Object.values((await (session as unknown as { metadata(): Promise<{ approvals: Record<string, ApprovalRecord> }> }).metadata()).approvals);
}
const ranCommands = async (session: RunnerSession) => (await records(session)).filter(record => record.operation.kind === "program" || record.operation.kind === "bash");
const hostRule = /only in sessions of the host's owner and of members they granted host commands/;
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), "runner-unit-"));
  const grants: Record<string, Permission[]> = { "test:alice": ["read", "ask", "write", "approve", "manage"], "test:bob": ["read", "ask", "write"] };
  const fetcher: typeof fetch = async (_url, init) => {
    const input = JSON.parse(String(init?.body)) as AuthorizationRequest;
    return Response.json({ allowed: grants[input.actorId]?.includes(input.permission) ?? false, ownerId: input.ownerId, policyVersion: 1 });
  };
  const service = new RunnerService({ dataDir: directory, sharedSecret: SECRET, controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, allowTestShell: true, fetch: fetcher });
  await service.initialize();
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, service, grants };
}

test("signed runner tickets bind action, body, audience, owner/session and expiry", async () => {
  const body = JSON.stringify({ content: "TEST_IDENTITY", requestId: "a" });
  const claims = await ticket("session-a", "submit", "test:alice", body);
  const token = await signToken(claims, SECRET);
  assert.deepEqual(await verifyRunnerTicket(token, SECRET, "submit", "session-a", body), claims);
  await assert.rejects(verifyRunnerTicket(token, SECRET, "ask", "session-a", body));
  await assert.rejects(verifyRunnerTicket(token, SECRET, "submit", "session-b", body));
  await assert.rejects(verifyRunnerTicket(token, SECRET, "submit", "session-a", `${body} `));
  await assert.rejects(verifyRunnerTicket(token, SECRET, "submit", "session-a", body, (claims.exp + 1) * 1000));
  const wrongAud = await signToken({ ...claims, aud: "worker" }, SECRET);
  await assert.rejects(verifyRunnerTicket(wrongAud, SECRET, "submit", "session-a", body));
});

test("path IDs, exact operations and composite dedup keys cannot collide", async () => {
  for (const value of ["../escape", "a/b", "a%2fb", "", ".", "x\\y"]) assert.throws(() => assertId(value));
  assert.equal(assertId("session_1-abc"), "session_1-abc");
  assert.notEqual(await requestKey("alice", "write", "id"), await requestKey("bob", "write", "id"));
  assert.notEqual(await requestKey("alice", "write", "id"), await requestKey("alice", "ask", "id"));
  assert.throws(() => validateOperation({ kind: "git.commit", message: "ok", hidden: true }));
  assert.throws(() => validateOperation({ kind: "github.comment", repository: "../escape/repo", issue: 1, body: "x" }));
  const issue = { kind: "github.issue", repository: "owner/repo", title: "Bug", body: "" };
  assert.deepEqual(validateOperation(issue), issue);
  for (const invalid of [{ ...issue, title: "Two\nlines" }, { ...issue, title: " " }, { ...issue, title: "x".repeat(257) }, { ...issue, body: "x".repeat(60001) },
    { ...issue, body: "nul\0" }, { ...issue, repository: "https://github.com/owner/repo" }, { ...issue, labels: ["bug"] }]) assert.throws(() => validateOperation(invalid));
  assert.throws(() => validateBinding({ ...binding("a"), owner: { ...binding("a").owner, env: { APP_TOKEN: "no" } } }, "a"));
  assert.equal(stableJson({ b: 2, a: 1 }), stableJson({ a: 1, b: 2 }));
  const native = binding("native");
  native.model.provider = "local-provider";
  native.session.connectorId = native.model.connectorId = "connector-a";
  native.session.connectorOwnerId = native.model.connectorOwnerId = "test:host";
  assert.throws(() => validateBinding(native, "native"));
  assert.equal(validateBinding(native, "native", true).model.provider, "local-provider");
  assert.throws(() => validateBinding({ ...native, model: { ...native.model, connectorId: "other" } }, "native", true));
  assert.throws(() => validateBinding({ ...native, model: { ...native.model, provider: "../provider" } }, "native", true));
});

test("unsigned HTTP session calls fail closed before opening a harness", async t => {
  const { service } = await fixture(t);
  const app = createRunnerApp(service);
  const response = await app.request("/v1/sessions/unknown/view");
  assert.equal(response.status, 401);
});

test("a view request naming a revision gets only what changed since it", { skip: process.platform !== "linux" }, async t => {
  const { service } = await fixture(t);
  const session = await service.provision(binding("revision-session"), await ticket("revision-session", "create"));
  const app = createRunnerApp(service);
  const get = async (path: string) => {
    const response = await app.request(path, { headers: { authorization: `Bearer ${await signToken(await ticket("revision-session", "view"), SECRET)}` } });
    assert.equal(response.status, 200);
    return response.json() as Promise<{ view?: SessionView; revision?: string; patch?: SessionViewPatch }>;
  };
  const whole = await get("/v1/sessions/revision-session/view");
  assert.ok(isRevision(whole.revision));
  assert.deepEqual(await get(`/v1/sessions/revision-session/view/${whole.revision}`), { patch: { base: whole.revision, revision: whole.revision } });
  await session.submit(await ticket("revision-session", "submit"), { content: "TEST_IDENTITY", requestId: "revision" }, "write");
  await idle(session);
  const { patch } = await get(`/v1/sessions/revision-session/view/${whole.revision}`);
  assert.ok(patch && patch.revision !== whole.revision);
  const latest = await get("/v1/sessions/revision-session/view");
  assert.equal(latest.revision, patch.revision);
  assert.deepEqual(applyViewPatch(whole.view!, patch), latest.view);
  assert.deepEqual(await get(`/v1/sessions/revision-session/view/${"f".repeat(32)}`), latest);
  for (const path of ["view/abc", `view/${"A".repeat(32)}`, `view/${whole.revision}/x`]) {
    const response = await app.request(`/v1/sessions/revision-session/${path}`, { headers: { authorization: `Bearer ${await signToken(await ticket("revision-session", "view"), SECRET)}` } });
    assert.equal(response.status, 404, path);
  }
});

test("real pi faux sessions isolate owners and retain actor attribution", { skip: process.platform !== "linux" }, async t => {
  const { service, grants } = await fixture(t);
  grants["test:bob"] = ["read", "ask", "write", "approve", "manage"];
  const alice = await service.provision(binding("alice-session"), await ticket("alice-session", "create"));
  const bob = await service.provision(binding("bob-session", "test:bob"), await ticket("bob-session", "create", "test:bob", "", "test:bob"));
  await alice.submit(await ticket("alice-session", "submit", "test:bob"), { content: "TEST_IDENTITY", requestId: "same" }, "write");
  await bob.submit(await ticket("bob-session", "submit", "test:bob", "", "test:bob"), { content: "TEST_IDENTITY", requestId: "same" }, "write");
  await Promise.all([idle(alice), idle(bob)]);
  const aliceView = await alice.view();
  const bobView = await bob.view();
  assert.ok(aliceView.entries.some(entry => entry.text.includes('"actingAs":"test:alice"') && entry.text.includes('"initiatedBy":"test:bob"')));
  assert.ok(bobView.entries.some(entry => entry.text.includes('"actingAs":"test:bob"')));
  assert.notEqual(alice.sandbox.home, bob.sandbox.home);
  assert.notEqual(alice.sandbox.worktree, bob.sandbox.worktree);
  assert.ok(aliceView.entries.filter(entry => entry.role === "user").every(entry => entry.actorId === "test:bob"));
});

test("read-only durable ask inherits transcript but cannot write; restart preserves dedup", { skip: process.platform !== "linux" }, async t => {
  const { service } = await fixture(t);
  const session = await service.provision(binding("readonly-session"), await ticket("readonly-session", "create"));
  const input = { content: "TEST_WRITE evidence.txt\noriginal", requestId: "stable" };
  const submitTicket = await ticket("readonly-session", "submit");
  const original = await session.submit(submitTicket, input, "write");
  await idle(session);
  const ask = await session.submit(await ticket("readonly-session", "ask", "test:bob"), { content: "TEST_WRITE evidence.txt\nchanged", requestId: "stable" }, "ask");
  assert.notEqual(ask.conversationId, original.conversationId);
  await idle(session);
  assert.equal(await session.sandbox.readFile("evidence.txt", allowTestOperation), "original");
  assert.ok((await session.view()).entries.some(entry => entry.conversationId === ask.conversationId && entry.text.includes("Denied:")));
  await session.restart();
  const duplicate = await session.submit(await ticket("readonly-session", "submit"), input, "write");
  assert.equal(duplicate.submissionId, original.submissionId);
  await assert.rejects(session.submit(await ticket("readonly-session", "submit"), { ...input, content: "changed" }, "write"));
  await assert.rejects(session.sandbox.readFile("../binding.json", allowTestOperation));
  await assert.rejects(session.sandbox.writeFile(".git/config", "unsafe", allowTestOperation));
});

test("a writer's command runs at once, as the session owner's git identity, and a revoked writer runs nothing more", { skip: process.platform !== "linux" }, async t => {
  const { service, grants } = await fixture(t);
  const session = await service.provision(binding("approval-session"), await ticket("approval-session", "create"));
  await session.submit(await ticket("approval-session", "submit", "test:bob"),
    { content: "TEST_BASH git init -q app && cd app && echo hello > hello.txt && git add -A && git commit -q -m 'Owner identity'", requestId: "identity" }, "write");
  await idle(session);
  const [ran] = await ranCommands(session);
  assert.equal(ran?.status, "executed", ran?.result);
  assert.equal(ran!.requestedBy, "test:bob");
  assert.equal(ran!.decidedBy, undefined, "nobody decided it");
  const log = await session.sandbox.execute({ kind: "bash", command: "cd app && git log -1 --format='%an <%ae> / %cn <%ce>'" }, true, allowTestOperation, { allowTestShell: true });
  assert.match(log, /Alice <alice@example.test> \/ Alice <alice@example.test>/);
  grants["test:bob"] = ["read"];
  await assert.rejects(session.submit(await ticket("approval-session", "submit", "test:bob"), { content: "TEST_IDENTITY", requestId: "revoked" }, "write"));
});

test("checkpointed backup carries SQLite binding/branches and recovers in a fresh service", { skip: process.platform !== "linux" }, async t => {
  const { service, directory } = await fixture(t);
  const session = await service.provision(binding("backup-session"), await ticket("backup-session", "create"));
  const request = { content: "TEST_WRITE persisted.txt\nbacked up", requestId: "backup-write" };
  const receipt = await session.submit(await ticket("backup-session", "submit"), request, "write");
  await idle(session);
  const backup = await session.backup(await ticket("backup-session", "backup"));
  assert.equal(backup.format, "pi-runner-backup-v1");
  assert.equal(Buffer.from(backup.sqlite, "base64").subarray(0, 15).toString(), "SQLite format 3");
  const restoreRoot = join(directory, "restored");
  const restoreSession = join(restoreRoot, "sessions", "backup-session");
  await mkdir(restoreSession, { recursive: true, mode: 0o700 });
  await writeFile(join(restoreSession, "binding.json"), JSON.stringify(backup.binding), { mode: 0o600 });
  await writeFile(join(restoreSession, "session.sqlite"), Buffer.from(backup.sqlite, "base64"), { mode: 0o600 });
  for (const file of backup.files) {
    const destination = join(restoreSession, "sandbox", file.path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, Buffer.from(file.data, "base64"), { mode: file.mode });
  }
  const restored = new RunnerService({ ...service.config, dataDir: restoreRoot });
  await restored.initialize();
  try {
    const recovered = await restored.get("backup-session");
    assert.equal(await recovered.sandbox.readFile("persisted.txt", allowTestOperation), "backed up");
    const duplicate = await recovered.submit(await ticket("backup-session", "submit"), request, "write");
    assert.equal(duplicate.submissionId, receipt.submissionId);
  } finally { await restored.close(); }
});

test("owner restore publishes a new idle session, drops old authority and leaves source untouched", { skip: process.platform !== "linux" }, async t => {
  const { service, directory } = await fixture(t);
  const source = await service.provision(binding("restore-source"), await ticket("restore-source", "create"));
  await source.submit(await ticket("restore-source", "submit"), { requestId: "source-write", content: "TEST_WRITE evidence.txt\noriginal" }, "write");
  await idle(source);
  const oldTicket = await ticket("restore-source", "submit");
  await source.consumeTicket(oldTicket);
  const backup = await source.backup(await ticket("restore-source", "backup"));
  const text = JSON.stringify(backup);
  const bytes = new TextEncoder().encode(text);
  const descriptor: RestoreDescriptor = { id: "restore-job", sourceSessionId: "restore-source", backupId: "backup-id", sha256: await sha256(text), size: bytes.byteLength, downloadToken: "opaque-scoped-test-capability" };
  const target = binding("restore-target");
  target.owner.gitName = "Alice Current";
  target.owner.env.APP_COLOR = "new-owner-profile";
  let pulls = 0;
  let policyVersion = 1;
  const restoredService = new RunnerService({ ...service.config,
    authorize: async request => ({ allowed: request.actorId === target.owner.id, ownerId: target.owner.id, policyVersion }),
    readBackup: async (requested, id) => {
    assert.deepEqual(requested, descriptor);
    assert.equal(id, target.session.id);
    pulls++;
    return bytes;
  } });
  await restoredService.initialize();
  t.after(() => restoredService.close());
  const sourceBytes = await readFile(join(directory, "sessions", source.binding.session.id, "session.sqlite"));
  const input: RestoreInput = { binding: target, restore: descriptor };
  await assert.rejects(restoredService.restore(input, await ticket(target.session.id, "restore", "test:bob")), /Only the immutable owner/);
  assert.equal(pulls, 0);
  const body = JSON.stringify(input);
  const claims = await ticket(target.session.id, "restore", "test:alice", body);
  const response = await createRunnerApp(restoredService).request(`/v1/sessions/${target.session.id}/restore`, {
    method: "POST", headers: { authorization: `Bearer ${await signToken(claims, SECRET)}`, "content-type": "application/json" }, body,
  });
  assert.equal(response.status, 201, await response.clone().text());
  assert.deepEqual((await response.json() as { restore: unknown }).restore, { id: descriptor.id, sha256: descriptor.sha256, targetSessionId: target.session.id });
  policyVersion = 2;
  const retryTicket = { ...await ticket(target.session.id, "restore"), policyVersion };
  await restoredService.restore(input, retryTicket);
  assert.equal(input.binding.session.policyVersion, 1, "publication binding stays historic while retry authorization uses current policy");
  assert.equal(pulls, 1, "durable matching marker reconciles an ambiguous response without downloading or overwriting");
  await assert.rejects(restoredService.restore({ ...input, restore: { ...descriptor, id: "another-job" } }, retryTicket), /receipt|conflict/i);
  assert.deepEqual(await readFile(join(directory, "sessions", source.binding.session.id, "session.sqlite")), sourceBytes);
  const restored = await restoredService.get(target.session.id);
  const view = await restored.view();
  assert.equal(view.busy, false);
  assert.equal(await restored.sandbox.readFile("evidence.txt", allowTestOperation), "original");
  assert.match(await readFile(join(directory, "sessions", target.session.id, "sandbox", "owner.gitconfig"), "utf8"), /Alice Current/);
  await restored.consumeTicket({ ...oldTicket, sessionId: target.session.id });
  await restored.submit({ ...await ticket(target.session.id, "submit"), policyVersion }, { requestId: "target-write", content: "TEST_WRITE evidence.txt\nnew session" }, "write");
  await idle(restored);
  await restored.submit({ ...await ticket(target.session.id, "submit"), policyVersion }, { requestId: "target-read", content: "TEST_WRITE allowed.txt\nagain", options: { access: "read" } }, "write");
  await idle(restored);
  await assert.rejects(restored.sandbox.readFile("allowed.txt", allowTestOperation), "a Read-only message writes nothing");
  assert.equal(await source.sandbox.readFile("evidence.txt", allowTestOperation), "original");
  await restoredService.close();
});

test("a conversation-only backup keeps the conversation, not the files, and its restore tells the agent so", { skip: process.platform !== "linux" }, async t => {
  const { service } = await fixture(t);
  const source = await service.provision(binding("conversation-source"), await ticket("conversation-source", "create"));
  await source.submit(await ticket("conversation-source", "submit"), { requestId: "conversation-write", content: "TEST_WRITE evidence.txt\noriginal" }, "write");
  await idle(source);
  const full = await source.backup(await ticket("conversation-source", "backup"));
  assert.ok(full.files.some(file => file.path === "worktree/evidence.txt"));
  assert.equal("conversationOnly" in full, false);
  const backup = await source.backup(await ticket("conversation-source", "backup"), { conversationOnly: true });
  assert.equal(backup.format, "pi-runner-backup-v1");
  assert.deepEqual(backup.files, []);
  assert.equal("clones" in backup, false);
  assert.equal((backup as { conversationOnly?: boolean }).conversationOnly, true);
  assert.equal(Buffer.from(backup.sqlite, "base64").subarray(0, 15).toString(), "SQLite format 3");
  const app = createRunnerApp(service);
  for (const [body, status] of [[JSON.stringify({ conversationOnly: true }), 200], [JSON.stringify({ conversationOnly: "yes" }), 400], [JSON.stringify({ files: false }), 400]] as const) {
    const response = await app.request("/v1/sessions/conversation-source/backup", { method: "POST",
      headers: { authorization: `Bearer ${await signToken(await ticket("conversation-source", "backup", "test:alice", body), SECRET)}`, "content-type": "application/json" }, body });
    assert.equal(response.status, status, await response.clone().text());
    if (status === 200) assert.deepEqual((await response.json() as { files: unknown[] }).files, []);
  }
  const text = JSON.stringify(backup);
  const bytes = new TextEncoder().encode(text);
  const descriptor: RestoreDescriptor = { id: "conversation-restore", sourceSessionId: "conversation-source", backupId: "conversation-backup", sha256: await sha256(text), size: bytes.byteLength, downloadToken: "opaque-scoped-test-capability" };
  const target = binding("conversation-target");
  const restoredService = new RunnerService({ ...service.config,
    authorize: async request => ({ allowed: request.actorId === target.owner.id, ownerId: target.owner.id, policyVersion: 1 }),
    readBackup: async () => bytes });
  await restoredService.initialize();
  t.after(() => restoredService.close());
  await restoredService.restore({ binding: target, restore: descriptor }, await ticket(target.session.id, "restore"));
  const restored = await restoredService.get(target.session.id);
  assert.ok((await restored.view()).entries.some(entry => entry.text.includes("TEST_WRITE evidence.txt")), "the conversation is restored");
  await assert.rejects(restored.sandbox.readFile("evidence.txt", allowTestOperation));
  const instructions = (restored as unknown as { agentInstructions(mode: "write"): string }).agentInstructions("write");
  assert.match(instructions, /restored from a backup that kept only its conversation/);
  assert.doesNotMatch((source as unknown as { agentInstructions(mode: "write"): string }).agentInstructions("write"), /kept only its conversation/);
  await restored.submit(await ticket(target.session.id, "submit"), { requestId: "conversation-again", content: "TEST_WRITE again.txt\nmade again" }, "write");
  await idle(restored);
  const again = await restored.backup(await ticket(target.session.id, "backup"));
  assert.equal(again.manifest.conversationOnlyRestore, true);
  const againText = JSON.stringify(again);
  const againBytes = new TextEncoder().encode(againText);
  const fullTarget = binding("conversation-full-target");
  const fullService = new RunnerService({ ...service.config,
    authorize: async request => ({ allowed: request.actorId === fullTarget.owner.id, ownerId: fullTarget.owner.id, policyVersion: 1 }),
    readBackup: async () => againBytes });
  await fullService.initialize();
  t.after(() => fullService.close());
  await fullService.restore({ binding: fullTarget, restore: { id: "conversation-full-restore", sourceSessionId: target.session.id, backupId: "full-backup",
    sha256: await sha256(againText), size: againBytes.byteLength, downloadToken: "opaque-scoped-test-capability" } }, await ticket(fullTarget.session.id, "restore"));
  const fullRestored = await fullService.get(fullTarget.session.id);
  assert.equal(await fullRestored.sandbox.readFile("again.txt", allowTestOperation), "made again");
  assert.doesNotMatch((fullRestored as unknown as { agentInstructions(mode: "write"): string }).agentInstructions("write"), /kept only its conversation/);
});

test("restore checks actual paused pi tasks, not only a manifest claiming idle", { skip: process.platform !== "linux" }, async t => {
  const { service, directory } = await fixture(t);
  const source = binding("hidden-task-source");
  const rootDir = join(directory, "hidden-task-stage");
  await mkdir(rootDir, { mode: 0o700 });
  const storage = await openNodeSqliteStorage(join(rootDir, "session.sqlite"));
  const harness = await Harness.open(storage, { models: runnerModels(source.model, true), registry: createRegistry() }, context);
  const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: source.model.modelId } } });
  const manifest = { binding: source, branches: [{ id: root.id, mode: "write" as const }], runs: {}, approvals: {}, toolActors: {} };
  const state = defineDoc<{ json: string }>({ kind: "workspace.runner", version: 1, scope: "session", initial: () => ({ json: "" }), checkpointWhen: () => true });
  await root.commit(async tx => { (await tx.doc(state)).json = JSON.stringify(manifest); }, context);
  await root.submit({ type: "input", content: "TEST_HOLD 5000", requestId: "hidden-live-task" }, context);
  await harness.close(context);
  const target = new RunnerSession(binding("hidden-task-target"), rootDir, service.config);
  await assert.rejects(target.prepareRestore(manifest), /incomplete durable tasks/);
});

test("queued sandbox effects recheck authority after admission and fail closed on revocation", { skip: process.platform !== "linux" }, async t => {
  const { service } = await fixture(t);
  const session = await service.provision(binding("queue-session"), await ticket("queue-session", "create"));
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const first = session.sandbox.writeFile("first.txt", "allowed", async () => {
    entered.resolve();
    await gate.promise;
  });
  await entered.promise;
  let revoked = false;
  const second = session.sandbox.writeFile("forbidden.txt", "denied", async () => {
    if (revoked) throw new Error("revoked after enqueue");
  });
  const denied = assert.rejects(second, /revoked after enqueue/);
  revoked = true;
  gate.resolve();
  await first;
  await denied;
  await assert.rejects(session.sandbox.readFile("forbidden.txt", allowTestOperation));
});

test("generic shell requires both explicit test flags and a faux binding", { skip: process.platform !== "linux" }, async t => {
  const { service, directory } = await fixture(t);
  const operation = { kind: "bash" as const, command: "true" };
  const refuses = (session: RunnerSession) => assert.throws(() => (session as unknown as { hostCommands: HostCommandPolicy }).hostCommands.requireShell(operation), /quota-backed/);
  refuses(new RunnerSession(binding("shell-disabled"), join(directory, "shell-disabled"), { ...service.config, allowTestShell: false }));
  const realBinding = binding("shell-real");
  realBinding.model.provider = "openai";
  refuses(new RunnerSession(realBinding, join(directory, "shell-real"), service.config));
  refuses(new RunnerSession(binding("shell-no-faux"), join(directory, "shell-no-faux"), { ...service.config, allowFaux: false }));
});

test("connected writes durably bind Worker admission to every tool call they make without exposing it to the model", { skip: process.platform !== "linux" }, async t => {
  const { service } = await fixture(t);
  const connectorId = "proof-connector";
  const target = binding("proof-session");
  target.session.connectorId = target.model.connectorId = connectorId;
  target.session.connectorOwnerId = target.model.connectorOwnerId = "test:host";
  const connected = new RunnerService({ ...service.config, connectorId, resolveModels: async model => {
    const models = createModels();
    const faux = fauxProvider({ models: [{ id: model.modelId }] });
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("github_comment", { repository: "example/repo", issue: 1, body: "Review this comment" }),
        fauxToolCall("github_comment", { repository: "example/repo", issue: 3, body: "And this one" }),
        fauxToolCall("github_comment", { repository: "example/repo", issue: 4, body: "And a third" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("Comments attempted."),
    ]);
    models.setProvider(faux.provider);
    return { models, provider: model.provider, modelId: model.modelId };
  } });
  await connected.initialize();
  t.after(() => connected.close());
  const session = await connected.provision(target, { ...await ticket(target.session.id, "create"), connectorId });
  const writer = { ...await ticket(target.session.id, "submit", "test:bob"), connectorId };
  const admissionId = await sha256("opaque Worker-issued write admission");
  const input = { content: "Post the three comments.", requestId: "proof-request", admissionId };
  await assert.rejects(session.submit(writer, { content: input.content, requestId: input.requestId }, "write"), /Worker write admission/);
  await assert.rejects(session.submit(writer, { ...input, admissionId: "malformed" }, "write"), /Worker write admission/);
  await assert.rejects(session.submit({ ...writer, action: "ask" }, input, "ask"), /Worker write admission/);
  const receipt = await session.submit(writer, input, "write");
  await idle(session);
  const calls = await records(session);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.requestedBy === "test:bob" && call.admissionId === admissionId));
  assert.deepEqual(calls.map(call => call.operation.kind), ["github.comment", "github.comment", "github.comment"]);
  assert.ok(calls.every(call => call.status !== "pending"), "nothing waits for anyone");
  const view = await session.view();
  assert.deepEqual(view.approvals, []);
  assert.ok(view.entries.every(entry => !entry.text.includes(admissionId)), "proof must not appear in user, tool-result, or model transcript content");
  assert.equal((await session.submit(writer, input, "write")).submissionId, receipt.submissionId);
  await assert.rejects(session.submit(writer, { ...input, admissionId: await sha256("replacement proof") }, "write"), /different Worker admission/);
  const backup = await session.backup({ ...await ticket(target.session.id, "backup"), connectorId });
  assert.equal(backup.manifest.runs[receipt.submissionId]!.admissionId, admissionId);
  await connected.close();
  const snapshot = JSON.stringify(backup);
  const restoredBinding = structuredClone(target);
  restoredBinding.session.id = "proof-restored";
  const restore: RestoreDescriptor = { id: "proof-restore", sourceSessionId: target.session.id, backupId: "proof-backup", size: Buffer.byteLength(snapshot), sha256: await sha256(snapshot), downloadToken: "scoped-proof-restore-capability" };
  const recoveredService = new RunnerService({ ...connected.config, readBackup: async () => new TextEncoder().encode(snapshot) });
  await recoveredService.initialize();
  t.after(() => recoveredService.close());
  await recoveredService.restore({ binding: restoredBinding, restore }, { ...await ticket(restoredBinding.session.id, "restore"), connectorId });
  const recovered = await recoveredService.get(restoredBinding.session.id);
  assert.ok((await records(recovered)).every(call => call.admissionId === undefined));
  const restoredBackup = await recovered.backup({ ...await ticket(restoredBinding.session.id, "backup"), connectorId });
  assert.equal(restoredBackup.manifest.runs[receipt.submissionId]!.admissionId, undefined, "restoring history never transfers source admission authority");
  await recoveredService.close();
});

test("the host's owner's own commands run without the resource limits the host lacks; nobody else's do without a host command grant", { skip: process.platform !== "linux" }, async t => {
  const { service } = await fixture(t);
  const connectorId = "limitless-connector";
  const limitless = new RunnerService({ ...service.config, connectorId, allowTestShell: false });
  await limitless.initialize();
  t.after(() => limitless.close());
  const admissionId = await sha256("limitless write admission");
  async function start(id: string, hostOwner: string, command: string) {
    const target = binding(id);
    target.session.connectorId = target.model.connectorId = connectorId;
    target.session.connectorOwnerId = target.model.connectorOwnerId = hostOwner;
    const session = await limitless.provision(target, { ...await ticket(id, "create"), connectorId });
    await session.submit({ ...await ticket(id, "submit"), connectorId }, { content: `TEST_BASH ${command}`, requestId: id, admissionId }, "write");
    await idle(session);
    return session;
  }
  const shared = await start("limitless-shared", "test:host", "echo shared");
  assert.deepEqual(await ranCommands(shared), [], "a member's command without the host's limits never runs without a grant");
  assert.ok((await shared.view()).entries.some(entry => entry.role === "toolResult" && hostRule.test(entry.text)));

  const own = await start("limitless-own", "test:alice", "echo unlimited-marker");
  const [ran] = await ranCommands(own);
  assert.equal(ran?.status, "executed", ran?.result);
  assert.equal(ran!.unbounded, true);
  assert.match(ran!.result ?? "", /unlimited-marker/);
});

test("a member granted host commands runs commands in the sandbox without the limits the host lacks, while the grant lasts", { skip: process.platform !== "linux" }, async t => {
  const { service, grants } = await fixture(t);
  const connectorId = "granted-shell-connector";
  const grant: { hostCommands?: "approve" | "auto" } = { hostCommands: "approve" };
  const asked: AuthorizationRequest[] = [];
  const authorize = async (input: AuthorizationRequest) => {
    asked.push(input);
    const allowed = grants[input.actorId]?.includes(input.permission) ?? false;
    return { allowed, ownerId: input.ownerId, policyVersion: 1,
      ...(allowed && input.host && input.actorId === "test:alice" && grant.hostCommands ? { hostCommands: grant.hostCommands } : {}) };
  };
  const runner = new RunnerService({ ...service.config, connectorId, allowTestShell: false, authorize });
  await runner.initialize();
  t.after(() => runner.close());
  const admissionId = await sha256("granted shell write admission");
  const value = binding("granted-shell");
  value.session.connectorId = value.model.connectorId = connectorId;
  value.session.connectorOwnerId = value.model.connectorOwnerId = "test:host";
  const session = await runner.provision(value, { ...await ticket("granted-shell", "create"), connectorId });
  assert.ok(!(session.sandbox instanceof HostWorkspace), "it runs in the sandbox");
  const submit = async (requestId: string, command: string) => {
    await session.submit({ ...await ticket("granted-shell", "submit"), connectorId }, { content: `TEST_BASH ${command}`, requestId, admissionId }, "write");
    await idle(session);
  };

  for (const level of ["approve", "auto"] as const) {
    grant.hostCommands = level;
    await submit(`granted-${level}`, `echo granted-${level}-marker`);
    const ran = (await ranCommands(session)).at(-1)!;
    assert.equal(ran.status, "executed", ran.result);
    assert.equal(ran.unbounded, true);
    assert.match(ran.result ?? "", new RegExp(`granted-${level}-marker`));
  }
  assert.ok(asked.some(input => input.actorId === "test:alice" && input.host), "the host checks their grant before the command runs");

  delete grant.hostCommands;
  const before = (await ranCommands(session)).length;
  await submit("ended", "echo after-the-grant");
  assert.equal((await ranCommands(session)).length, before, "nothing runs once the grant ended");
  assert.ok((await session.view()).entries.some(entry => entry.role === "toolResult" && hostRule.test(entry.text)));
});

test("a session its host's owner started on the host runs there whatever the host accepts from members", { skip: process.platform !== "linux" }, async t => {
  const { service } = await fixture(t);
  const connectorId = "host-sessions-connector";
  let accepted = true;
  const runner = new RunnerService({ ...service.config, connectorId, allowTestShell: false, hostConfig: async () => ({ ...defaultHostConfig, hostSessions: accepted }) });
  await runner.initialize();
  t.after(() => runner.close());
  const admissionId = await sha256("host session write admission");
  const value = binding("host-own");
  value.session.connectorId = value.model.connectorId = connectorId;
  value.session.connectorOwnerId = value.model.connectorOwnerId = "test:alice";
  value.session.hostEnvironment = true;
  const session = await runner.provision(value, { ...await ticket("host-own", "create"), connectorId });
  assert.ok(session.sandbox instanceof HostWorkspace, "no sandbox is created for it");
  await session.submit({ ...await ticket("host-own", "submit"), connectorId }, { content: "TEST_BASH pwd", requestId: "host-own", admissionId }, "write");
  await idle(session);
  const [ran] = await ranCommands(session);
  assert.equal(ran?.status, "executed", ran?.result);
  assert.ok(ran!.result?.includes(join(service.config.dataDir, "sessions", "host-own")), `it ran in the session's own worktree on the host: ${ran!.result}`);
  accepted = false;
  await session.submit({ ...await ticket("host-own", "submit"), connectorId }, { content: "TEST_BASH echo still-runs", requestId: "host-own-off", admissionId }, "write");
  await idle(session);
  const still = (await ranCommands(session)).at(-1)!;
  assert.equal(still.status, "executed", "the host's own owner needs no consent of the host's configuration");
  assert.match(still.result ?? "", /still-runs/);
});

test("a member the host's owner granted sessions on the host runs one there only while their grant includes it", { skip: process.platform !== "linux" }, async t => {
  const { service, grants } = await fixture(t);
  const connectorId = "member-host-sessions-connector";
  const grant: { hostCommands?: "approve" | "auto"; hostSessions?: true } = { hostCommands: "approve", hostSessions: true };
  const asked: AuthorizationRequest[] = [];
  const authorize = async (input: AuthorizationRequest) => {
    asked.push(input);
    const allowed = grants[input.actorId]?.includes(input.permission) ?? false;
    return { allowed, ownerId: input.ownerId, policyVersion: 1,
      ...(allowed && input.host && input.actorId === "test:alice" && grant.hostCommands ? { hostCommands: grant.hostCommands } : {}),
      ...(allowed && input.host && input.hostSessions && input.actorId === "test:alice" && grant.hostSessions ? { hostSessions: true as const } : {}) };
  };
  let accepted = true;
  const runner = new RunnerService({ ...service.config, connectorId, allowTestShell: false, authorize, hostConfig: async () => ({ ...defaultHostConfig, hostSessions: accepted }) });
  await runner.initialize();
  t.after(() => runner.close());
  const admissionId = await sha256("member host session write admission");
  const value = binding("host-member");
  value.session.connectorId = value.model.connectorId = connectorId;
  value.session.connectorOwnerId = value.model.connectorOwnerId = "test:host";
  value.session.hostEnvironment = true;
  const session = await runner.provision(value, { ...await ticket("host-member", "create"), connectorId });
  assert.ok(session.sandbox instanceof HostWorkspace, "no sandbox is created for it");
  const send = async (requestId: string, command: string) => {
    await session.submit({ ...await ticket("host-member", "submit"), connectorId }, { content: `TEST_BASH ${command}`, requestId, admissionId }, "write");
    await idle(session);
  };
  const toolText = async (text: string) => (await session.view()).entries.some(entry => entry.role === "toolResult" && entry.text.includes(text));

  for (const level of ["approve", "auto"] as const) {
    grant.hostCommands = level;
    await send(level, `echo member-${level}`);
    const ran = (await ranCommands(session)).at(-1)!;
    assert.equal(ran.status, "executed", ran.result);
    assert.match(ran.result ?? "", new RegExp(`member-${level}`));
  }
  assert.ok(asked.some(input => input.actorId === "test:alice" && input.host && input.hostSessions), "the host checks the grant before their command");

  const count = (await ranCommands(session)).length;
  accepted = false;
  await send("refused", "echo never-ran");
  assert.ok(await toolText("no longer runs members' sessions directly on it"));
  accepted = true;
  delete grant.hostSessions;
  await send("ended", "echo never-ran");
  assert.ok(await toolText("grant that let them has ended"));
  assert.ok(!await toolText("never-ran\n"));
  assert.equal((await ranCommands(session)).filter(record => record.status === "executed").length, count);
});

test("shell commands may reserve address space they never touch, as gh and node do when they start", { skip: process.platform !== "linux" }, async t => {
  const { service } = await fixture(t);
  const session = await service.provision(binding("reserve-session"), await ticket("reserve-session", "create"));
  const command = "python3 -I -c 'import mmap; mmap.mmap(-1, 16 << 30, flags=mmap.MAP_PRIVATE, prot=0); print(\"reserved\")'";
  assert.match(await session.sandbox.execute({ kind: "bash", command }, true, allowTestOperation, { allowTestShell: true }), /reserved/);
});

test("a longer command time limit gives builds room; the default keeps the limits of short commands", { skip: process.platform !== "linux" }, async t => {
  const { service } = await fixture(t);
  const session = await service.provision(binding("limits-session"), await ticket("limits-session", "create"));
  const limits = async (options: { limits?: CommandLimits } = {}) => (await session.sandbox.execute({ kind: "bash", command: "ulimit -t; ulimit -f; ulimit -n" }, true,
    allowTestOperation, { allowTestShell: true, ...options })).trim().split("\n");
  assert.deepEqual(await limits(), ["25", "65536", "256"]);
  assert.deepEqual(await limits({ limits: commandLimits(30) }), ["25", "65536", "256"]);
  const [cpu, size, files] = await limits({ limits: commandLimits(600, 2) });
  assert.equal(cpu, "1200", "every CPU for the whole time limit");
  assert.equal(size, String(16 * 1024 * 1024), "16 GiB, in ulimit's 1024-byte blocks");
  assert.ok(Number(files) > 256 && Number(files) <= 8192, files);
});

test("a stopped shell command ends at once, and one stopped before it starts never runs", { skip: process.platform !== "linux" }, async t => {
  const { service } = await fixture(t);
  const session = await service.provision(binding("stop-session"), await ticket("stop-session", "create"));
  const controller = new AbortController();
  const started = Date.now();
  const running = session.sandbox.execute({ kind: "bash", command: "sleep 20" }, false, allowTestOperation,
    { allowTestShell: true, limits: commandLimits(600), signal: controller.signal });
  setTimeout(() => controller.abort(), 200);
  await assert.rejects(running, /Command stopped/);
  assert.ok(Date.now() - started < 10_000);
  await assert.rejects(session.sandbox.execute({ kind: "bash", command: "touch never" }, false, allowTestOperation,
    { allowTestShell: true, signal: controller.signal }), /stopped before it started/);
  assert.doesNotMatch(await session.sandbox.execute({ kind: "bash", command: "ls -a" }, true, allowTestOperation, { allowTestShell: true }), /never/);
});

test("kernel runner lease admits one owner and releases without deleting stale files", { skip: process.platform !== "linux" }, async t => {
  const { directory } = await fixture(t);
  let lost = false;
  const release = await acquireRunnerLease(directory, () => { lost = true; });
  try {
    await assert.rejects(acquireRunnerLease(directory, () => {}), /owns DATA_DIR|flock/);
  } finally { await release(); }
  const next = await acquireRunnerLease(directory, () => { lost = true; });
  await next();
  assert.equal(lost, false);
});

const hostMode = { skip: !["linux", "darwin"].includes(process.platform) || spawnSync("git", ["--version"]).status !== 0 };
async function hostFixture(t: { after: (fn: () => Promise<void>) => void }, extra: Partial<RunnerService["config"]> = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "runner-host-")));
  const grants: Record<string, Permission[]> = { "test:alice": ["read", "ask", "write", "approve", "manage"], "test:bob": ["read", "ask", "write"] };
  const authorize = async (input: AuthorizationRequest) => ({ allowed: grants[input.actorId]?.includes(input.permission) ?? false, ownerId: input.ownerId, policyVersion: 1 });
  const service = new RunnerService({ dataDir: directory, sharedSecret: SECRET, controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, unsandboxed: true, authorize, ...extra });
  await service.initialize();
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { service, grants };
}

test("the agent gets a command's whole output; the session's record and the control plane keep an excerpt", hostMode, async t => {
  const { service } = await hostFixture(t);
  const session = await service.provision(binding("long-output"), await ticket("long-output", "create"));
  const command = "printf start-marker; head -c 20000 /dev/zero | tr '\\0' x; printf end-marker";
  const whole = new RegExp(`start-marker${"x".repeat(20000)}end-marker`);
  await session.submit(await ticket("long-output", "submit"), { content: `TEST_BASH ${command}`, requestId: "run" }, "write");
  await idle(session);
  assert.ok(toolOutput(await session.view(), whole), "the command's whole output reaches the agent");
  const [ran] = await ranCommands(session);
  assert.equal(ran?.status, "executed");
  assert.ok(ran!.result!.length <= 8192, "the control plane gets an excerpt it accepts");
  assert.match(ran!.result!, /^start-marker[\s\S]*characters omitted[\s\S]*end-marker$/);
});

test("a Read-only message changes nothing, and any other message runs commands at once, asking nobody", hostMode, async t => {
  const { service } = await hostFixture(t);
  const session = await service.provision(binding("options-session"), await ticket("options-session", "create"));
  await session.submit(await ticket("options-session", "submit"), { content: "TEST_WRITE read-only.txt\nleaked", requestId: "read", options: { access: "read" } }, "write");
  await idle(session);
  await assert.rejects(session.sandbox.readFile("read-only.txt", allowTestOperation));
  let view = await session.view();
  assert.ok(view.entries.some(entry => entry.role === "toolResult" && entry.text.includes("which a Read-only message doesn't do")));
  assert.equal(view.access, "read");
  assert.deepEqual(view.approvals, []);

  for (const [requestId, access] of [["auto", "auto"], ["default", undefined], ["approval", "approval"]] as const) {
    await session.submit(await ticket("options-session", "submit"), { content: `TEST_BASH echo ${requestId}-output-marker`, requestId, ...(access ? { options: { access } } : {}) }, "write");
    await idle(session);
    view = await session.view();
    assert.equal(view.access, "auto", `a message of access ${access} acts`);
    assert.ok(toolOutput(view, new RegExp(`${requestId}-output-marker`)), requestId);
    assert.equal((await ranCommands(session)).at(-1)!.status, "executed");
  }
  assert.deepEqual(view.approvals, []);
});

test("a tool outside the agent's pinned list runs at once for whoever sent the message, as any other does", hostMode, async t => {
  const { service } = await hostFixture(t);
  const id = "permission-session";
  const base = binding(id);
  const session = await service.provision({ ...base, agent: { ...base.agent, tools: ["identity", "read_file"] } }, await ticket(id, "create"));
  assert.equal((await session.view()).access, undefined, "no shared message has run at any access yet");
  await session.submit(await ticket(id, "submit", "test:bob"), { content: "TEST_BASH echo bob-marker", requestId: "bob" }, "write");
  await idle(session);
  const [ran] = await ranCommands(session);
  assert.deepEqual([ran?.operation, ran?.status, ran?.requestedBy], [commandOperation(session, "echo bob-marker"), "executed", "test:bob"]);
  assert.ok(toolOutput(await session.view(), /bob-marker/));
});

test("a round's calls of a tool outside the agent's pinned list all run", hostMode, async t => {
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("list_files", { path: "." }), fauxToolCall("list_files", { path: "" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Both listed."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const { service } = await hostFixture(t, { resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }) });
  const id = "permission-round";
  const base = binding(id);
  const session = await service.provision({ ...base, agent: { ...base.agent, tools: ["identity", "read_file"] } }, await ticket(id, "create"));
  await session.submit(await ticket(id, "submit"), { content: "Run both.", requestId: "both" }, "write");
  await idle(session);
  const view = await session.view();
  assert.deepEqual(view.approvals, []);
  const results = view.entries.filter(entry => entry.role === "toolResult");
  assert.equal(results.length, 2);
  assert.ok(results.every(entry => !/denied|not allowed|refused/i.test(entry.text)), JSON.stringify(results.map(entry => entry.text)));
});

test("chat options are validated against owner, mode, model and request idempotency", hostMode, async t => {
  const { service } = await hostFixture(t);
  const id = "validate-session";
  const session = await service.provision(binding(id), await ticket(id, "create"));
  const status = (code: number) => (error: unknown) => error instanceof RunnerError && error.status === code;
  await assert.rejects(session.submit(await ticket(id, "ask"), { content: "TEST_IDENTITY", requestId: "ask-access", options: { access: "read" } }, "ask"), status(422));
  await assert.rejects(session.submit(await ticket(id, "submit"), { content: "TEST_IDENTITY", requestId: "thinking", options: { thinkingLevel: "high" } }, "write"), status(422));
  await assert.rejects(session.submit(await ticket(id, "submit"), { content: "TEST_IDENTITY", requestId: "model", options: { model: { provider: "faux", modelId: "other" } } }, "write"), status(422));
  await assert.rejects(session.submit(await ticket(id, "submit"), { content: "TEST_IDENTITY", requestId: "extra", options: { access: "read", extra: true } as never }, "write"), status(422));
  const input = { content: "TEST_IDENTITY", requestId: "stable", options: { access: "read" as const, thinkingLevel: "off" as const, model: { provider: "faux", modelId: "faux-1" } } };
  const first = await session.submit(await ticket(id, "submit"), input, "write");
  assert.equal((await session.submit(await ticket(id, "submit"), input, "write")).submissionId, first.submissionId);
  await assert.rejects(session.submit(await ticket(id, "submit"), { ...input, options: { access: "approval" } }, "write"), status(409));
  await assert.rejects(session.submit(await ticket(id, "submit"), { content: input.content, requestId: input.requestId }, "write"), status(409));
  await idle(session);
  assert.deepEqual((await session.view()).agent, { provider: "faux", modelId: "faux-1", thinkingLevel: "off" });
});

test("failed model turns expose provider, model and HTTP status but never the provider message", hostMode, async t => {
  const providerText = "401 invalid key sk-provider-detail for account acct-private";
  const { service } = await hostFixture(t, { resolveModels: async model => {
    const models = createModels();
    const faux = fauxProvider({ models: [{ id: model.modelId }] });
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: providerText })]);
    models.setProvider(faux.provider);
    return { models, provider: model.provider, modelId: model.modelId };
  } });
  const session = await service.provision(binding("error-session"), await ticket("error-session", "create"));
  await session.submit(await ticket("error-session", "submit"), { content: "hello", requestId: "fails" }, "write");
  await idle(session);
  const view = await session.view();
  const failed = view.entries.find(entry => entry.error);
  assert.deepEqual(failed?.error, { provider: "faux", modelId: "faux-1", status: 401 });
  assert.equal(JSON.stringify(view).includes("sk-provider-detail"), false);
  assert.equal(JSON.stringify(view).includes("acct-private"), false);
});

test("a stream that keeps dropping on a large conversation says so, and starts compacting its context", hostMode, async t => {
  const dropped = "Anthropic stream ended without a stop reason";
  const faux = fauxProvider({ models: [{ id: "faux-1", contextWindow: 1_000_000 }] });
  faux.setResponses([
    ...Array.from({ length: 6 }, () => fauxAssistantMessage("ok")),
    ...Array.from({ length: 4 }, () => fauxAssistantMessage("", { stopReason: "error", errorMessage: dropped })),
    fauxAssistantMessage("The conversation so far, summarized."),
  ]);
  const { service } = await hostFixture(t, { resolveModels: async model => {
    const models = createModels();
    models.setProvider(faux.provider);
    return { models, provider: model.provider, modelId: model.modelId };
  } });
  const id = "dropped-stream-session";
  const session = await service.provision(binding(id), await ticket(id, "create"));
  const settled = async (seconds: number) => {
    for (const end = Date.now() + seconds * 1000; Date.now() < end; await delay(50)) if (!(await session.view()).busy) return;
    assert.fail("runner did not settle");
  };
  for (let index = 0; index < 6; index++) {
    await session.submit(await ticket(id, "submit"), { content: `${index} ${"x".repeat(99_990)}`, requestId: `large-${index}` }, "write");
    await settled(10);
  }
  await session.submit(await ticket(id, "submit"), { content: "and now?", requestId: "dropped" }, "write");
  await settled(40);
  const entries = (await session.view()).entries;
  const attempts = entries.filter(entry => entry.kind !== "workspace.run-failure" && entry.error);
  assert.equal(attempts.length, 4, "the first attempt and Pi's three retries");
  for (const attempt of attempts) assert.deepEqual(attempt.error, { provider: "faux", modelId: "faux-1", cause: "incomplete_stream" });
  const failure = entries.find(entry => entry.kind === "workspace.run-failure");
  assert.deepEqual(failure?.error, { provider: "faux", modelId: "faux-1", cause: "incomplete_stream", compacting: true });
  for (const end = Date.now() + 10_000; faux.getPendingResponseCount() > 0 && Date.now() < end;) await delay(50);
  assert.equal(faux.getPendingResponseCount(), 0, "the host asked for a compaction summary");
  let kinds: string[] = [];
  for (const end = Date.now() + 10_000; Date.now() < end; await delay(50)) {
    kinds = (await session.view()).entries.map(entry => entry.kind);
    if (kinds.some(kind => /compaction/.test(kind))) break;
  }
  assert.ok(kinds.some(kind => /compaction/.test(kind)), `the summary is in the transcript: ${kinds.join(", ")}`);
});

test("the view tells how full the shared conversation's context window is, and where Pi compacts it", hostMode, async t => {
  const faux = fauxProvider({ models: [{ id: "faux-1", reasoning: false, contextWindow: 200_000 }] });
  faux.setResponses([fauxAssistantMessage("ok")]);
  const { service } = await hostFixture(t, { resolveModels: async model => {
    const models = createModels();
    models.setProvider(faux.provider);
    return { models, provider: model.provider, modelId: model.modelId };
  } });
  const id = "context-session";
  const session = await service.provision(binding(id), await ticket(id, "create"));
  assert.deepEqual((await session.view()).context, { tokens: 0, window: 200_000, compactsAt: 200_000 - 16_384 });
  await session.submit(await ticket(id, "submit"), { content: "x".repeat(4000), requestId: "long" }, "write");
  await idle(session);
  const after = (await session.view()).context;
  assert.ok(after && after.tokens >= 1000, `about 4 characters a token, or the provider's count: ${JSON.stringify(after)}`);
  assert.equal(after.window, 200_000);
  assert.equal(after.compactsAt, 200_000 - 16_384);
});

test("a run Pi settles without an answer shows as a failed model turn instead of silence", hostMode, async t => {
  const { service } = await hostFixture(t, { resolveModels: async model => {
    const models = createModels();
    models.setProvider(fauxProvider({ models: [{ id: "another-model" }] }).provider);
    return { models, provider: model.provider, modelId: model.modelId };
  } });
  const id = "unanswered-session";
  const session = await service.provision(binding(id), await ticket(id, "create"));
  await session.submit(await ticket(id, "submit"), { content: "hello", requestId: "unanswered" }, "write");
  await idle(session);
  const entries = (await session.view()).entries;
  assert.deepEqual(entries.map(entry => [entry.role, entry.text]), [["user", "hello"], ["assistant", ""]]);
  assert.deepEqual(entries[1]!.error, { provider: "faux", modelId: "faux-1" });
  assert.equal(entries[1]!.actorId, "test:alice");
});

test("a conversation starts at the host's level for its model, and a model switch without a level takes the new model's", hostMode, async t => {
  const levels = { "faux-1": "high", "faux-2": "low" } as const;
  const { service } = await hostFixture(t, { resolveModels: async model => {
    const models = createModels();
    const faux = fauxProvider({ models: [{ id: "faux-1", reasoning: true }, { id: "faux-2", reasoning: true }] });
    faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
    models.setProvider(faux.provider);
    return { models, provider: model.provider, modelId: model.modelId, thinkingLevel: levels[model.modelId as keyof typeof levels] };
  } });
  const id = "level-session";
  const session = await service.provision(binding(id), await ticket(id, "create"));
  assert.deepEqual((await session.view()).agent, { provider: "faux", modelId: "faux-1", thinkingLevel: "high" });
  await session.submit(await ticket(id, "submit"), { content: "switch", requestId: "switch", options: { model: { provider: "faux", modelId: "faux-2" } } }, "write");
  await idle(session);
  assert.deepEqual((await session.view()).agent, { provider: "faux", modelId: "faux-2", thinkingLevel: "low" });
  await session.submit(await ticket(id, "submit"), { content: "back", requestId: "back", options: { model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "medium" } }, "write");
  await idle(session);
  assert.deepEqual((await session.view()).agent, { provider: "faux", modelId: "faux-1", thinkingLevel: "medium" });
});

test("edit_file replaces exact text in place, keeps a CRLF file CRLF, and refuses an ambiguous edit without writing", hostMode, async t => {
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("edit_file", { path: "notes.txt", edits: [{ oldText: "beta", newText: "BETA" }, { oldText: "alpha\n", newText: "ALPHA\n" }] })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Edited."),
    fauxAssistantMessage([fauxToolCall("edit_file", { path: "notes.txt", edits: [{ oldText: "a", newText: "b" }] })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Not edited."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const { service } = await hostFixture(t, { resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }) });
  const id = "edit-session";
  const base = binding(id);
  const session = await service.provision({ ...base, agent: { ...base.agent, tools: [...base.agent.tools, "edit_file"] } }, await ticket(id, "create"));
  await session.sandbox.writeFile("notes.txt", "alpha\r\nbeta\r\ngamma\r\n", allowTestOperation);
  await session.submit(await ticket(id, "submit"), { content: "Edit it.", requestId: "edit" }, "write");
  await idle(session);
  assert.equal(await session.sandbox.readFile("notes.txt", allowTestOperation), "ALPHA\r\nBETA\r\ngamma\r\n");
  await session.submit(await ticket(id, "submit"), { content: "Edit again.", requestId: "ambiguous" }, "write");
  await idle(session);
  assert.equal(await session.sandbox.readFile("notes.txt", allowTestOperation), "ALPHA\r\nBETA\r\ngamma\r\n");
  assert.ok(JSON.stringify((await session.view()).entries).includes("occurs 2 times in notes.txt"));
});

function faultyStorage(fault: { calls?: boolean; close?: boolean }) {
  return async (path: string): Promise<Storage> => {
    const storage = await openNodeSqliteStorage(path);
    return new Proxy(storage, { get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      if (key === "close") return async (...args: unknown[]) => {
        await Reflect.apply(value, target, args);
        if (fault.close) throw new Error("disk I/O error");
      };
      return (...args: unknown[]) => fault.calls ? Promise.reject(new Error("disk I/O error")) : Reflect.apply(value, target, args);
    } });
  };
}

test("a session whose storage failed is reopened from its SQLite file by the next request", hostMode, async t => {
  const fault = { calls: false };
  const { service } = await hostFixture(t, { openStorage: faultyStorage(fault) });
  const id = "storage-session";
  const session = await service.provision(binding(id), await ticket(id, "create"));
  await session.submit(await ticket(id, "submit"), { content: "TEST_IDENTITY", requestId: "before" }, "write");
  await idle(session);
  const before = (await session.view()).entries;

  fault.calls = true;
  await assert.rejects(session.submit(await ticket(id, "submit"), { content: "TEST_IDENTITY", requestId: "during" }, "write"));
  for (let count = 0; count < 200 && !session.failed; count++) await delay(10);
  assert.equal(session.failed, true);
  await assert.rejects(service.get(id));
  assert.equal(session.failed, true);

  fault.calls = false;
  assert.deepEqual(await Promise.all([service.get(id), service.get(id)]), [session, session]);
  assert.equal(session.failed, false);
  assert.deepEqual((await session.view()).entries, before);
  await session.submit(await ticket(id, "submit"), { content: "TEST_IDENTITY", requestId: "after" }, "write");
  await idle(session);
  assert.ok((await session.view()).entries.length > before.length);
});

test("a backup fails instead of copying a database that did not close cleanly", hostMode, async t => {
  const fault = { close: false };
  const { service } = await hostFixture(t, { openStorage: faultyStorage(fault) });
  const id = "backup-close-session";
  const session = await service.provision(binding(id), await ticket(id, "create"));
  await session.submit(await ticket(id, "submit"), { content: "TEST_IDENTITY", requestId: "before" }, "write");
  await idle(session);

  fault.close = true;
  await assert.rejects(session.backup(await ticket(id, "backup")), /disk I\/O error/);
  fault.close = false;
  assert.equal(await service.get(id), session);
  assert.ok((await session.view()).entries.length > 0);
});

test("entries carry how long each reply took and each tool ran", hostMode, async t => {
  const { service } = await hostFixture(t);
  const id = "duration-session";
  const session = await service.provision(binding(id), await ticket(id, "create"));
  await session.submit(await ticket(id, "submit"), { content: "TEST_IDENTITY", requestId: "timed" }, "write");
  await idle(session);
  const entries = (await session.view()).entries;
  const timed = (role: string) => entries.filter(entry => entry.role === role).map(entry => typeof entry.durationMs === "number" && entry.durationMs >= 0);
  assert.deepEqual(timed("assistant"), [true, true]);
  assert.deepEqual(timed("toolResult"), [true]);
  assert.deepEqual(timed("user"), [false]);
});

test("entries name which tool call each result answers, so clients show them together", hostMode, async t => {
  const { service } = await hostFixture(t);
  const id = "paired-session";
  const session = await service.provision(binding(id), await ticket(id, "create"));
  await session.submit(await ticket(id, "submit"), { content: "TEST_IDENTITY", requestId: "paired" }, "write");
  await idle(session);
  const entries = (await session.view()).entries;
  const call = entries.find(entry => entry.role === "assistant" && entry.toolCalls)!;
  const result = entries.find(entry => entry.role === "toolResult")!;
  assert.equal(call.toolCalls!.length, 1);
  assert.equal(call.toolCalls![0]!.name, "identity");
  assert.ok(call.toolCalls![0]!.id, "the model's id of the call");
  assert.deepEqual(result.toolResult, { callId: call.toolCalls![0]!.id, tool: "identity" });
  assert.ok(entries.filter(entry => entry.role !== "assistant").every(entry => entry.toolCalls === undefined));
  assert.ok(entries.filter(entry => entry.role !== "toolResult").every(entry => entry.toolResult === undefined));
});
