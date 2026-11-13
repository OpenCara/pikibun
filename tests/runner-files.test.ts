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
import { sha256 } from "../packages/shared/src/crypto.js";
import { storedToolResults } from "./helpers/tool-results.js";

function binding(id: string): RunnerBinding {
  return {
    session: { id, workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1", title: "Files", policyVersion: 1, status: "ready", createdAt: "2026-01-01T00:00:00Z", repositories: [], repositoryMode: "clone" },
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

test("search and read_file's line ranges: the agent finds code and reads around it without a shell or an approval", async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pikibun-files-tools-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("write_file", { path: "src/a.ts", content: "// a\nexport const answer = 42;\nexport const other = 1;\n" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("search", { pattern: "answer", glob: "*.ts" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("read_file", { path: "src/a.ts", offset: 2, limit: 2 })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("search", { pattern: "(" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Found it."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const service = new RunnerService({
    dataDir: directory, sharedSecret: "runner-files-test-secret-not-a-production-secret", controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, unsandboxed: true,
    authorize: async (input: AuthorizationRequest) => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
  });
  await service.initialize();
  t.after(() => service.close());
  const id = "files-session";
  const session = await service.provision(binding(id), await ticket(id, "create"));
  await session.submit(await ticket(id, "submit"), { content: "Where is answer defined?", requestId: "find", admissionId: await sha256("files admission") }, "write");
  await idle(session);
  const view = await session.view();
  const transcript = view.entries.map(entry => entry.text).join("\n");
  assert.equal(view.approvals.length, 0, "no approval card");
  assert.ok(transcript.includes("src/a.ts:2: export const answer = 42;"), "a match in Pi's grep words, with its path from where it searched");
  assert.ok(transcript.includes("export const answer = 42;\nexport const other = 1;\n\n[1 more lines in file. Use offset=4 to continue.]"), "the lines asked for, in Pi's read words");
  const stored = await storedToolResults(session, view.entries.find(entry => entry.role === "toolResult")!.conversationId!);
  const alice = { initiatedBy: "test:alice", actingAs: "test:alice", mode: "write" };
  assert.deepEqual(stored.map(result => [result.tool, result.details?.pikibun]), [["write_file", alice], ["search", alice], ["read_file", alice], ["search", undefined]],
    "who each call acted for is kept in its details; a refused call has none");
  assert.deepEqual(stored.find(result => result.tool === "write_file")?.text, "Successfully wrote to src/a.ts");
  assert.match(transcript, /invalid regular expression/);
  assert.match(transcript, /Found it\./);
});

test("move_file, copy_file and delete_file: the agent moves, copies and deletes without a shell or an approval", async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pikibun-file-operations-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("write_file", { path: "src/a.ts", content: "export const a = 1;\n" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("copy_file", { from: "src", to: "backup/src" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("move_file", { from: "src/a.ts", to: "lib/a.ts" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("delete_file", { path: "backup" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("delete_file", { path: "backup", recursive: true })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("list_files", { path: "." })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Reorganized."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const service = new RunnerService({
    dataDir: directory, sharedSecret: "runner-file-operations-secret-not-a-production-secret", controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, unsandboxed: true,
    authorize: async (input: AuthorizationRequest) => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
  });
  await service.initialize();
  t.after(() => service.close());
  const id = "file-operations-session";
  const session = await service.provision(binding(id), await ticket(id, "create"));
  await session.submit(await ticket(id, "submit"), { content: "Move a.ts to lib.", requestId: "reorganize", admissionId: await sha256("file operations admission") }, "write");
  await idle(session);
  const view = await session.view();
  const transcript = view.entries.map(entry => entry.text).join("\n");
  assert.equal(view.approvals.length, 0, "no approval card");
  assert.match(transcript, /"copied":"src","to":"backup\/src","entries":2,"bytes":20/);
  assert.match(transcript, /"moved":"src\/a\.ts","to":"lib\/a\.ts"/);
  assert.match(transcript, /the directory is not empty: delete it with recursive/);
  assert.match(transcript, /"deleted":"backup","entries":3/);
  assert.ok(transcript.includes(".git/\nlib/\nsrc/"), "the worktree listed as Pi's ls lists it");
  assert.equal(await session.sandbox.readFile("lib/a.ts", async () => {}), "export const a = 1;\n");
});
