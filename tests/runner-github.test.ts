import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { RunnerService, createRunnerApp } from "../apps/runner/src/server.js";
import { RunnerError } from "../apps/runner/src/protocol.js";
import type { RunnerSession } from "../apps/runner/src/session.js";
import type { ApprovalRecord, AuthorizationRequest, GitHubCommentRequest, GitHubIssueRequest, GitHubIssueResult, GitHubIssueView, GitHubMergeRequest, GitHubReadRequest, RunnerAction, RunnerBinding, RunnerTicket } from "../packages/shared/src/types.js";
import { sha256, signToken } from "../packages/shared/src/crypto.js";

const hostMode = { skip: !["linux", "darwin"].includes(process.platform) || spawnSync("git", ["--version"]).status !== 0 };
const head = "c".repeat(40);

function binding(id: string): RunnerBinding {
  return {
    session: { id, workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1", title: "GitHub", policyVersion: 1, status: "ready", createdAt: "2026-01-01T00:00:00Z", repositories: [], repositoryMode: "clone" },
    owner: { id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice Owner", gitEmail: "alice@example.test", env: {}, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: "test:alice", workspaceId: "workspace", version: 1, name: "Agent", description: "", instructions: "Use tools.", tools: ["read_file", "github_read", "github_merge"], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
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

test("agents read GitHub pull requests through the broker and merge at once for their message, failing definitely only on GitHub's refusal", hostMode, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pikibun-github-session-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reads: GitHubReadRequest[] = [];
  const merges: GitHubMergeRequest[] = [];
  let merge = async (): Promise<{ sha: string; url: string }> => ({ sha: "d".repeat(40), url: "https://github.com/acme/alpha/pull/7" });
  const view: GitHubIssueView = { repository: "acme/alpha", number: 7, url: "https://github.com/acme/alpha/pull/7", title: "Fix the parser", state: "open",
    author: "alice", createdAt: "2026-10-01T00:00:00Z", body: "", labels: [], comments: [] };
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("github_read", { repository: "ACME/Alpha", issue: 7 })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("github_read", { repository: "acme/beta", issue: 1 })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("github_merge", { repository: "acme/alpha", pull: 7, sha: "c0ffee", method: "squash" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("github_merge", { repository: "acme/alpha", pull: 7, sha: head, method: "squash" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Merged."),
    fauxAssistantMessage([fauxToolCall("github_merge", { repository: "acme/alpha", pull: 7, sha: head, method: "rebase" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Merge tried."),
    fauxAssistantMessage([fauxToolCall("github_merge", { repository: "acme/alpha", pull: 7, sha: head, method: "merge" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Merge tried."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const service = new RunnerService({
    dataDir: directory, sharedSecret: "runner-github-test-secret-not-a-production-secret", controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, unsandboxed: true,
    authorize: async (input: AuthorizationRequest) => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    githubRead: async request => {
      reads.push(request);
      if (request.repository.toLowerCase() !== "acme/alpha") throw new RunnerError(403, "acme/beta is not a GitHub repository of this workspace");
      return view;
    },
    githubMerge: async request => { merges.push(request); return merge(); },
  });
  await service.initialize();
  t.after(() => service.close());
  const id = "github-session";
  const session = await service.provision(binding(id), await ticket(id, "create"));

  const admissionId = await sha256("github admission");
  await session.submit(await ticket(id, "submit"), { content: "Read the review and merge.", requestId: "merge", admissionId }, "write");
  await idle(session);
  assert.equal(reads.length, 2);
  assert.deepEqual({ ...reads[0], callId: undefined }, { sessionId: id, actorId: "test:alice", admissionId, callId: undefined, repository: "ACME/Alpha", issue: 7 });
  assert.match(reads[0]!.callId, /^[A-Za-z0-9_-]+$/);
  const transcript = (await session.view()).entries.map(entry => entry.text).join("\n");
  assert.match(transcript, /Fix the parser/);
  assert.match(transcript, /acme\/beta is not a GitHub repository of this workspace/);
  assert.match(transcript, /full 40-character head commit/);
  assert.equal(merges.length, 1, "an abbreviated head commit never merges");
  const { approvalId, ...request } = merges[0]!;
  assert.match(approvalId, /^tool-/);
  assert.deepEqual(request, { sessionId: id, actorId: "test:alice", admissionId, repository: "acme/alpha", pull: 7, sha: head, method: "squash" });
  const [squash] = await records(session);
  assert.equal(squash?.status, "executed");
  assert.deepEqual(Object.keys(squash!.operation), ["kind", "repository", "pull", "sha", "method"]);
  assert.deepEqual(JSON.parse(squash!.result!), { merged: true, sha: "d".repeat(40), url: "https://github.com/acme/alpha/pull/7" });
  assert.ok((await session.view()).entries.some(entry => entry.role === "toolResult" && entry.text.includes('\\"merged\\":true')), "the agent learns the merge went through");

  for (const [requestId, failure, status, result] of [
    ["refused", new RunnerError(422, "GitHub did not merge acme/alpha#7: Head branch was modified. Review and try the merge again."), "failed", "GitHub did not merge acme/alpha#7: Head branch was modified. Review and try the merge again."],
    ["unknown", new RunnerError(502, "GitHub could not confirm the outcome."), "interrupted", "Effect failed or outcome is ambiguous. Inspect external state; automatic retry is prohibited."],
  ] as const) {
    merge = async () => { throw failure; };
    await session.submit(await ticket(id, "submit"), { content: "Merge again.", requestId, admissionId }, "write");
    await idle(session);
    const tried = (await records(session)).at(-1)!;
    assert.deepEqual([tried.status, tried.result], [status, result]);
  }
  assert.equal(merges.length, 3);
});

test("agents open GitHub issues through the broker at once, with the exact title and body", hostMode, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pikibun-github-issue-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const issues: GitHubIssueRequest[] = [];
  let open = async (): Promise<GitHubIssueResult> => ({ number: 63, url: "https://github.com/acme/alpha/issues/63" });
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("github_issue", { repository: "acme/alpha", title: "Two\nlines", body: "x" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("github_issue", { repository: "https://github.com/acme/alpha", title: "A URL", body: "x" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("github_issue", { repository: "acme/alpha", title: "NUL", body: "a\0b" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("github_issue", { repository: "acme/alpha", title: "Sandbox has no CA certificates", body: "## Summary\n\nHTTPS fails." })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Issue opened."),
    fauxAssistantMessage([fauxToolCall("github_issue", { repository: "acme/alpha", title: "Again", body: "" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Issue tried."),
    fauxAssistantMessage([fauxToolCall("github_issue", { repository: "acme/alpha", title: "Once more", body: "" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Issue tried."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const service = new RunnerService({
    dataDir: directory, sharedSecret: "runner-github-test-secret-not-a-production-secret", controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, unsandboxed: true,
    authorize: async (input: AuthorizationRequest) => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    githubIssue: async request => { issues.push(request); return open(); },
  });
  await service.initialize();
  t.after(() => service.close());
  const id = "github-issue-session";
  const base = binding(id);
  const session = await service.provision({ ...base, agent: { ...base.agent, tools: [...base.agent.tools, "github_issue"] } }, await ticket(id, "create"));

  const admissionId = await sha256("github issue admission");
  await session.submit(await ticket(id, "submit"), { content: "File the bug.", requestId: "file", admissionId }, "write");
  await idle(session);
  const transcript = (await session.view()).entries.map(entry => entry.text).join("\n");
  assert.match(transcript, /title must be one non-empty line/);
  assert.match(transcript, /repository must be a github\.com owner\/name/);
  assert.match(transcript, /must not contain NUL characters/);
  assert.equal(issues.length, 1);
  const { approvalId, ...request } = issues[0]!;
  assert.match(approvalId, /^tool-/);
  assert.deepEqual(request, { sessionId: id, actorId: "test:alice", admissionId, repository: "acme/alpha", title: "Sandbox has no CA certificates", body: "## Summary\n\nHTTPS fails." });
  const [opened] = await records(session);
  assert.deepEqual(Object.keys(opened!.operation), ["kind", "repository", "title", "body"]);
  assert.deepEqual([opened!.status, JSON.parse(opened!.result!)], ["executed", { number: 63, url: "https://github.com/acme/alpha/issues/63" }]);
  assert.ok((await session.view()).entries.some(entry => entry.role === "toolResult" && entry.text.includes("issues/63")), "the agent learns the issue's URL");

  for (const [requestId, failure, status, result] of [
    ["refused", new RunnerError(422, "GitHub did not open an issue in acme/alpha: Issues are disabled for this repo."), "failed", "GitHub did not open an issue in acme/alpha: Issues are disabled for this repo."],
    ["unknown", new RunnerError(502, "GitHub could not confirm the outcome."), "interrupted", "Effect failed or outcome is ambiguous. Inspect external state; automatic retry is prohibited."],
  ] as const) {
    open = async () => { throw failure; };
    await session.submit(await ticket(id, "submit"), { content: "File another.", requestId, admissionId }, "write");
    await idle(session);
    const tried = (await records(session)).at(-1)!;
    assert.deepEqual([tried.status, tried.result], [status, result]);
  }
  assert.equal(issues.length, 3);
});

test("bash and host_bash are gone: an agent that names them gets neither, and nothing runs a command on the host", hostMode, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pikibun-host-command-")));
  const target = binding("host-command-gone");
  target.agent.tools = ["bash", "host_bash", "identity"];
  target.session.connectorId = target.model.connectorId = "host-connector";
  target.session.connectorOwnerId = target.model.connectorOwnerId = "test:alice";
  const service = new RunnerService({
    dataDir: directory, sharedSecret: "host-command-test-secret-not-for-deployment", controlPlaneUrl: "http://127.0.0.1:8787",
    connectorId: "host-connector", allowFaux: true, unsandboxed: true,
    authorize: async input => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
  });
  await service.initialize();
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const session = await service.provision(target, { ...await ticket(target.session.id, "create"), connectorId: "host-connector" });
  const names = (session as unknown as { tools: { name: string }[] }).tools.map(tool => tool.name);
  assert.ok(!names.includes("bash") && !names.includes("host_bash"), names.join(", "));
  await assert.rejects(session.runOperation("test:alice", { kind: "host.bash", command: "printf never", timeoutSeconds: 10 }, "none"), /removed with host_bash/);
  assert.deepEqual(await records(session), []);
});

test("any writer's message posts comments, opens issues and merges at once, with its own admission and as its sender", hostMode, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pikibun-github-auto-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const comments: GitHubCommentRequest[] = []; const issues: GitHubIssueRequest[] = []; const merges: GitHubMergeRequest[] = [];
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("github_comment", { repository: "acme/alpha", issue: 7, body: "Looks good." })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("github_issue", { repository: "acme/alpha", title: "Follow up", body: "Later." })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("github_merge", { repository: "acme/alpha", pull: 7, sha: head, method: "squash" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Done."),
    fauxAssistantMessage([fauxToolCall("github_comment", { repository: "acme/alpha", issue: 7, body: "Again." })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Commented."),
    fauxAssistantMessage([fauxToolCall("github_comment", { repository: "acme/alpha", issue: 7, body: "Never." })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Refused."),
  ]);
  const models = createModels(); models.setProvider(faux.provider);
  const target = binding("github-auto");
  target.agent.tools = ["github_comment", "github_issue", "github_merge"];
  const service = new RunnerService({
    dataDir: directory, sharedSecret: "runner-github-auto-secret-not-a-production-secret", controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, unsandboxed: true,
    authorize: async (input: AuthorizationRequest) => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    githubComment: async request => { comments.push(request); return { id: 5, url: "https://github.com/acme/alpha/issues/7#issuecomment-5" }; },
    githubIssue: async request => { issues.push(request); return { number: 8, url: "https://github.com/acme/alpha/issues/8" }; },
    githubMerge: async request => { merges.push(request); return { sha: "d".repeat(40), url: "https://github.com/acme/alpha/pull/7" }; },
  });
  await service.initialize();
  t.after(() => service.close());
  const session = await service.provision(target, await ticket(target.session.id, "create"));

  const admissionId = await sha256("github admission");
  await session.submit(await ticket(target.session.id, "submit"), { content: "Comment, file and merge.", requestId: "owner", admissionId }, "write");
  await idle(session);
  for (const request of [comments[0], issues[0], merges[0]] as unknown as Record<string, unknown>[]) {
    assert.equal(request.admissionId, admissionId);
    assert.equal(request.capability, undefined);
    assert.equal(request.actorId, "test:alice");
    assert.match(String(request.approvalId), /^tool-/);
  }
  assert.deepEqual((await records(session)).map(record => [record.operation.kind, record.status]), [["github.comment", "executed"], ["github.issue", "executed"], ["github.merge", "executed"]]);

  const bobAdmission = await sha256("bob's admission");
  await session.submit({ ...await ticket(target.session.id, "submit"), actorId: "test:bob" }, { content: "Comment again.", requestId: "bob", admissionId: bobAdmission }, "write");
  await idle(session);
  assert.deepEqual([comments[1]!.actorId, comments[1]!.admissionId], ["test:bob", bobAdmission]);
  assert.equal((await records(session)).at(-1)!.requestedBy, "test:bob");

  await session.submit(await ticket(target.session.id, "submit"), { content: "Only look.", requestId: "read", admissionId, options: { access: "read" } }, "write");
  await idle(session);
  assert.equal(comments.length, 2, "a Read-only message posts nothing");
  assert.deepEqual((await session.view()).approvals, []);
});

test("github_read waits for checks by reading again, and says how the wait ended", async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pikibun-github-wait-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reads: GitHubReadRequest[] = [];
  const pullRequest = (status: string) => ({ draft: false, merged: false, mergeable: true, mergeableState: "clean", head: { ref: "f", sha: "a".repeat(40), repository: "acme/alpha" },
    base: { ref: "main", sha: "b".repeat(40) }, reviews: [], reviewComments: [], checks: [{ name: "verify", status, conclusion: status === "completed" ? "success" : null }] });
  const views: GitHubIssueView[] = ["queued", "in_progress", "completed", "completed"].map(status => ({ repository: "acme/alpha", number: 7, url: "https://github.com/acme/alpha/pull/7",
    title: "Fix", state: "open", author: "alice", createdAt: "2026-01-01T00:00:00Z", body: "", labels: [], comments: [], pullRequest: pullRequest(status) }));
  views.push({ ...views[3]!, comments: [{ id: 9, author: "bot", createdAt: "2026-01-01T01:00:00Z", body: "Approved.", url: "https://github.com/acme/alpha/pull/7#c9" }] });
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("github_read", { repository: "acme/alpha", issue: 7, wait: "checks", timeout_seconds: 60 })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("github_read", { repository: "acme/alpha", issue: 7, wait: "change", timeout_seconds: 30 })], { stopReason: "toolUse" }),
    fauxAssistantMessage("CI passed."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const service = new RunnerService({
    dataDir: directory, sharedSecret: "runner-github-wait-secret-not-a-production-secret", controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, unsandboxed: true,
    authorize: async (input: AuthorizationRequest) => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    githubRead: async request => { reads.push(request); return views[Math.min(reads.length - 1, views.length - 1)]!; },
    githubWaitPollMs: 10,
  });
  await service.initialize();
  t.after(() => service.close());
  const id = "github-wait-session";
  const session = await service.provision(binding(id), await ticket(id, "create"));
  await session.submit(await ticket(id, "submit"), { content: "Wait for CI.", requestId: "wait", admissionId: await sha256("github wait admission") }, "write");
  await idle(session);
  const results = (await session.view()).entries.filter(entry => entry.role === "toolResult").map(entry => entry.text);
  assert.equal(reads.length, 5);
  assert.equal(new Set(reads.slice(0, 3).map(read => read.callId)).size, 1, "one call's reads");
  assert.equal(new Set(reads.slice(3).map(read => read.callId)).size, 1);
  assert.match(results[0]!, /"status":"completed"/);
  assert.match(results[0]!, /"waited":\{"for":"checks","outcome":"checks-completed","seconds":\d+\}/);
  assert.match(results[1]!, /"waited":\{"for":"change","outcome":"changed","seconds":\d+\}/);
  assert.match(results[1]!, /Approved\./);
  assert.equal((await session.view()).approvals.length, 0, "reads ask nobody");
});
