import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalViews } from "../apps/runner/src/local-view.js";
import { RunnerError } from "../apps/runner/src/protocol.js";
import { RunnerService } from "../apps/runner/src/server.js";
import { sha256 } from "../packages/shared/src/crypto.js";
import type { RunnerBinding, RunnerTicket } from "../packages/shared/src/types.js";
import { REDACTED } from "../packages/shared/src/redaction.js";
import { transcriptPage } from "../packages/shared/src/transcript-display.js";
import type { SessionView } from "../packages/shared/src/types.js";
import { applyViewPatch } from "../packages/shared/src/view-patch.js";

const token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
const entry = (n: number, text = `entry ${n}`) => ({ id: `0:${n}`, kind: "message", role: "assistant", text, conversationId: "0" });
const sessionView = (count: number, last = `token ${token}`) => ({
  sessionId: "s1", busy: false, queue: [], conversations: [{ id: "0", mode: "write" }],
  approvals: [{ id: "a1", status: "pending", operation: { kind: "program", command: "ls" } }], olderApprovals: 2,
  entries: Array.from({ length: count }, (_, index) => entry(index + 1, index + 1 === count ? last : undefined)),
}) as unknown as SessionView;

test("a view read for the app shows what the server would: secrets redacted, no approvals, each conversation's latest page", () => {
  const views = new LocalViews();
  const raw = sessionView(60);
  const reply = views.view({}, raw, {});
  assert.ok("view" in reply);
  const { view } = reply;
  assert.equal(view.entries.length, transcriptPage.size);
  assert.equal(view.entries[0]!.id, "0:11");
  assert.deepEqual(view.conversations[0], { id: "0", mode: "write", olderEntries: 10, previousEntryId: "0:10" });
  assert.deepEqual(view.approvals, []);
  assert.equal("olderApprovals" in view, false);
  assert.equal(view.entries.at(-1)!.text, `token ${REDACTED}`);
  assert.equal(raw.entries.at(-1)!.text, `token ${token}`, "The session's own view is left as it is");
});

test("a read since the view the app holds is a patch: empty where nothing changed, the change where something did", () => {
  const views = new LocalViews();
  const session = {};
  const first = views.view(session, sessionView(60), {});
  assert.ok("view" in first);
  const same = views.view(session, sessionView(60), { since: first.revision });
  assert.deepEqual(same, { patch: { base: first.revision, revision: first.revision } });
  const next = views.view(session, sessionView(61, "new"), { since: first.revision });
  assert.ok("patch" in next);
  const patched = applyViewPatch(first.view, next.patch);
  const whole = new LocalViews().view({}, sessionView(61, "new"), {});
  assert.ok("view" in whole);
  assert.deepEqual(patched, whole.view);
  assert.equal(patched.entries[0], first.view.entries[1], "Unchanged entries are the ones the app holds");
  assert.ok("view" in views.view(session, sessionView(61), { since: "f".repeat(32) }), "An unknown revision reads the whole view");
  assert.ok("view" in views.view({}, sessionView(61), { since: first.revision }), "Revisions are each session's own");
});

test("tool output is brief where the session keeps it brief, with revisions of its own", () => {
  const views = new LocalViews();
  const session = {};
  const output = Array.from({ length: 40 }, (_, index) => `line ${index} ${"x".repeat(40)}`).join("\n");
  const raw = { ...sessionView(2), entries: [entry(1), { id: "0:2", kind: "message", role: "toolResult", text: output, conversationId: "0" }] } as unknown as SessionView;
  const full = views.view(session, raw, {});
  assert.ok("view" in full);
  assert.equal(full.view.entries[1]!.text, output);
  const brief = views.view(session, raw, { since: full.revision, brief: true });
  assert.ok("view" in brief, "Switching to brief output reads the whole view again");
  assert.ok(brief.view.entries[1]!.text.length < output.length);
  assert.ok(brief.view.entries[1]!.trimmed);
});

test("earlier entries are read from the whole view, redacted, as the server's /entries reads them", () => {
  const views = new LocalViews();
  const raw = { ...sessionView(60), entries: sessionView(60).entries.map((item, index) => (index === 4 ? { ...item, text: token } : item)) } as unknown as SessionView;
  const page = views.entries(raw, { conversation: "0", before: "0:11", limit: 6 });
  assert.deepEqual(page?.entries.map(item => item.id), ["0:5", "0:6", "0:7", "0:8", "0:9", "0:10"]);
  assert.equal(page?.older, 4);
  assert.equal(page?.entries[0]!.text, REDACTED);
  assert.equal(views.entries(raw, { conversation: "0", before: "0:999", limit: 6 }), null);
  assert.equal(views.entries(raw, { conversation: "9", before: "0:11", limit: 6 }), null);
});

const git = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();

test("the runner reads a session on this host for the app without asking the server, and only a session it has", { skip: !["linux", "darwin"].includes(process.platform) || !git }, async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "local-view-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  let asked = 0;
  const service = new RunnerService({
    dataDir: base, sharedSecret: "local-view-test-secret-not-a-production-secret", controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, unsandboxed: true,
    authorize: async input => { asked++; return { allowed: true, ownerId: input.ownerId, policyVersion: 1 }; },
  });
  await service.initialize();
  t.after(() => service.close());
  const binding: RunnerBinding = {
    session: { id: "hosted", workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1", title: "Hosted", policyVersion: 1, status: "ready", createdAt: "2026-01-01T00:00:00Z", repositories: [] },
    owner: { id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice Owner", gitEmail: "alice@example.test", env: {}, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: "test:alice", workspaceId: "workspace", version: 1, name: "Agent", description: "", instructions: "Use tools.", tools: ["read_file"], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "workspace", name: "Explicit faux test provider", provider: "faux", modelId: "faux-1" },
  };
  const now = Math.floor(Date.now() / 1000);
  const ticket: RunnerTicket = { aud: "runner", sessionId: "hosted", actorId: "test:alice", ownerId: "test:alice", action: "create", policyVersion: 1, iat: now, exp: now + 60, jti: randomUUID(), bodyHash: await sha256("") };
  await service.provision(binding, ticket);
  asked = 0;
  const first = await service.localView("hosted", {});
  assert.ok("view" in first);
  assert.equal(first.view.sessionId, "hosted");
  assert.deepEqual(first.view.approvals, []);
  assert.deepEqual(await service.localView("hosted", { since: first.revision }), { patch: { base: first.revision, revision: first.revision } });
  assert.equal(await service.localEntries("hosted", { conversation: "none", before: "0:1", limit: 5 }), null);
  assert.equal(asked, 0, "The app that started this host may read every session on it: the server isn't asked");
  await assert.rejects(service.localView("elsewhere", {}), (error: unknown) => error instanceof RunnerError && error.status === 404);
});
