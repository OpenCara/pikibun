import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { EgressGrant, EgressRepository } from "../packages/shared/src/network.js";
import type { OperationRecord, AuthorizationResult, Operation } from "../packages/shared/src/types.js";
import { RunnerError } from "../apps/runner/src/protocol.js";
import { MIRROR_ROOT } from "../apps/runner/src/sandbox.js";
import { WholeResults, boundedResult } from "../apps/runner/src/session/whole-results.js";
import { BranchReports } from "../apps/runner/src/session/branch-reports.js";
import { CRASHED_TEXT, endView, refusedView } from "../apps/runner/src/session/entries.js";
import { HOST_COMMANDS_RULE, HostCommandPolicy, type HostCommandPolicyOptions } from "../apps/runner/src/session/host-commands.js";
import { defaultHostConfig } from "../packages/shared/src/host-config.js";
import { MessageInputs } from "../apps/runner/src/session/inputs.js";
import { MIRROR_CONFIRM_MS, refused, SessionMirrors } from "../apps/runner/src/session/mirrors.js";
import { MAX_STAGED_UPLOADS, SessionUploads, STALE_UPLOAD_MS } from "../apps/runner/src/session/uploads.js";
import { agentInstructions, lfsInstructions, type InstructionsInput } from "../apps/runner/src/session/instructions.js";
import { bundledToolDefinitions } from "../packages/shared/src/tool-definitions.js";
import { preparationFailure, SessionRepositories, type SessionRepositoriesOptions } from "../apps/runner/src/session/repositories.js";
import type { IsolatedWorkspace, SessionWorkspace } from "../apps/runner/src/workspace.js";
import { githubRepository, SessionOperations, type SessionOperationsOptions } from "../apps/runner/src/session/operations.js";
import type { Metadata } from "../apps/runner/src/session/state.js";
import { SandboxProcessError } from "../apps/runner/src/sandbox.js";
import type { RunnerBinding } from "../packages/shared/src/types.js";
import { ToolCalls } from "../apps/runner/src/session/tools/calls.js";
import type { ToolContext } from "../apps/runner/src/session/tools/context.js";
import { buildTools } from "../apps/runner/src/session/tools/index.js";
import type { Registry, ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { SessionDefinitions, type SessionDefinitionsOptions } from "../apps/runner/src/session/definitions.js";
import type { ProgramToolDefinition, ToolDefinition } from "../packages/shared/src/tool-definitions.js";
import { SessionPiki, type SessionPikiOptions } from "../apps/runner/src/session/piki.js";
import type { PikiSandboxRun } from "../apps/runner/src/extensions/piki/command.js";
import { contextView, extensionView, sessionView, type ExtensionViewSource, type ViewSource } from "../apps/runner/src/session/view.js";
import { INPUT_EMPTY, RunQueue, steersInto, submissionRequestId, type RunQueueOptions } from "../apps/runner/src/session/run-queue.js";
import { ConversationIdle, type ConversationId } from "@earendil-works/pi-durable";
import { ToolAvailability, type ToolAvailabilityOptions } from "../apps/runner/src/session/availability.js";
import type { WorkspaceExtensionsAnswer } from "../packages/shared/src/host-extensions.js";
import type { Run } from "../apps/runner/src/session.js";

async function directory(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "session-parts-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

const allow = async () => {};
const chunk = (uploadId: string, data: string, offset: number, size: number, name = "notes.txt") =>
  ({ uploadId, name, size, offset, data: Buffer.from(data).toString("base64") });

test("uploads: chunks in order make the file, imported once whole; out of order, missing or too many are refused", async t => {
  const root = await directory(t);
  const imported: { directory: string; name: string; data: string }[] = [];
  const uploads = new SessionUploads(join(root, "uploads"), {
    importFile: async (target, name, data) => { imported.push({ directory: target, name, data: data.toString() }); return `${target}/${name}`; },
  });
  assert.deepEqual(await uploads.receive("alice", chunk("u1", "hello ", 0, 11), allow), { received: 6 });
  assert.deepEqual(imported, [], "nothing goes into the worktree before the last chunk");
  assert.deepEqual(await uploads.receive("alice", chunk("u1", "world", 6, 11), allow), { received: 11, path: "attachments/notes.txt" });
  assert.deepEqual(imported, [{ directory: "attachments", name: "notes.txt", data: "hello world" }]);
  assert.deepEqual(await readdir(join(root, "uploads")), [], "the staged file is gone once imported");

  await uploads.receive("alice", chunk("u2", "abc", 0, 6), allow);
  await assert.rejects(uploads.receive("bob", chunk("u2", "def", 3, 6), allow), /no longer on the host/);
  await assert.rejects(uploads.receive("alice", chunk("u2", "def", 4, 6), allow), /out of order/);

  const order: string[] = [];
  const slow = new SessionUploads(join(root, "slow"), { importFile: async (_directory, name) => { order.push(name); return name; } });
  await Promise.all([slow.receive("alice", chunk("a", "x", 0, 1, "a.txt"), allow), slow.receive("alice", chunk("b", "y", 0, 1, "b.txt"), allow)]);
  assert.deepEqual(order, ["a.txt", "b.txt"]);

  const limited = new SessionUploads(join(root, "limited"), { importFile: async () => "x" });
  for (let index = 0; index < MAX_STAGED_UPLOADS; index++) await limited.receive("alice", chunk(`p${index}`, "a", 0, 2), allow);
  await assert.rejects(limited.receive("alice", chunk("one-more", "a", 0, 2), allow), (error: unknown) => error instanceof RunnerError && error.status === 429);
  const [oldest] = (await readdir(join(root, "limited"))).sort();
  const old = (Date.now() - STALE_UPLOAD_MS - 60_000) / 1000;
  await utimes(join(root, "limited", oldest!), old, old);
  await writeFile(join(root, "limited", "not-an-upload"), "x");
  assert.deepEqual(await limited.receive("alice", chunk("one-more", "a", 0, 2), allow), { received: 1 });
  assert.ok(!(await readdir(join(root, "limited"))).includes("not-an-upload"));
});

test("uploads: why a whole file couldn't go into the worktree is told in fixed words, never the sandbox's", async t => {
  const root = await directory(t);
  const failing = (message: string) => new SessionUploads(join(root, message.replace(/\W+/g, "-")), {
    importFile: async () => { throw Object.assign(new Error(`sandbox: ${message} at /home/owner/secret`), { stderr: "" }); },
  });
  const finished = (uploads: SessionUploads) => uploads.receive("alice", chunk("u", "x", 0, 1), allow);
  await assert.rejects(finished(failing("too many files with this name")), /too many files of that name/);
  await assert.rejects(finished(failing("path component is not a real directory")), /isn't a directory the file can go into/);
  await assert.rejects(finished(failing("No space left on device")), /no room for that file/);
  await assert.rejects(finished(failing("something else")), (error: unknown) => error instanceof RunnerError && error.status === 422
    && error.message === "The file could not be written into the worktree");
});

test("message inputs: a run's images are kept whole, read back, discarded, and swept once its run no longer waits", async t => {
  const root = await directory(t);
  const inputs = new MessageInputs(join(root, "inputs"));
  const images = [{ mimeType: "image/png", data: "iVBORw0KGgo=" }];
  assert.equal(await inputs.read("missing"), undefined);
  await inputs.write("run-a", images);
  await inputs.write("run-b", images);
  assert.deepEqual(await inputs.read("run-a"), images);
  await writeFile(join(root, "inputs", "broken.json"), "{");
  assert.equal(await inputs.read("broken"), undefined, "unreadable images are as good as gone");
  await writeFile(join(root, "inputs", ".run-c.0000.tmp"), "half");
  await inputs.sweep(key => key === "run-b");
  assert.deepEqual(await readdir(join(root, "inputs")), ["run-b.json"], "only the images of runs still waiting stay");
  await inputs.discard(["run-b", "never-there"]);
  assert.deepEqual(await readdir(join(root, "inputs")), []);
});

const card = (status: OperationRecord["status"], kind = "bash"): OperationRecord =>
  ({ id: "tool-1", sessionId: "s", requestedBy: "alice", createdAt: "2026-01-01T00:00:00Z", status, operation: { kind, command: "true" } } as unknown as OperationRecord);

test("a long result: the session keeps an excerpt, and its tool call gets the whole of it once it settles", () => {
  const waits = new WholeResults();
  const long = "x".repeat(9000);
  const kept = waits.kept("tool-1", long);
  assert.equal(kept, boundedResult(long));
  assert.ok(kept.length < 8192 && kept.includes("characters omitted"));
  const running = { ...card("executing"), result: kept };
  assert.equal(waits.whole(running).result, kept, "not before it settles");
  const done = { ...card("executed"), result: kept };
  assert.equal(waits.whole(done).result, long);
  assert.equal(waits.whole(done).result, kept, "the whole result is let go once returned");
  assert.equal(waits.kept("tool-2", "short"), "short");
});

test("transcript entries: how a run's end shows", () => {
  const run = { key: "k", initiatedBy: "alice" } as Run;
  assert.equal(endView(run, 0), undefined);
  assert.deepEqual(endView({ ...run, crashed: true } as Run, 2), { id: "2:crashed:k", kind: "workspace.run-crashed", role: "system", text: CRASHED_TEXT, conversationId: "2" });
  assert.equal(endView({ ...run, stopped: { by: "bob" } } as Run, 0)?.actorId, "bob");
  assert.equal(endView({ ...run, failure: { provider: "openai", modelId: "m" } } as Run, 0)?.kind, "workspace.run-failure");
  assert.equal(refusedView({ ...run, refused: { notice: "No." } } as Run, 1).text, "No.");
});

test("mirrors: borrowed only while the grant names the repository and the relay lets its owner read it", async () => {
  const repository: EgressRepository = { bindingId: "b1", provider: "github", host: "github.com", repositoryId: "101", fullName: "acme/app" };
  const prepared: string[] = [];
  let grant: () => Promise<EgressGrant> = async () => ({ policy: { mode: "off", domains: [], packageRegistries: false }, repositories: [repository] });
  let relayed = 0;
  let answer: () => Promise<Response> = async () => { throw new RunnerError(403, "refused"); };
  const mirrors = new SessionMirrors({
    cache: {
      mirrorDirectory: () => "/cache/acme-app.git",
      prepare: async value => { prepared.push(value.fullName); return "/cache/acme-app.git"; },
      ready: async () => ({ directory: "/cache/acme-app.git", fresh: true }),
      touch: async () => {},
    },
    ownerId: "alice", sessionId: "s", relay: async () => { relayed++; return answer(); }, grant: () => grant(),
  });
  await mirrors.restore([repository, { ...repository, bindingId: "b2", repositoryId: undefined }]);
  assert.deepEqual(prepared, ["acme/app"], "a repository the control plane names no id for has no mirror");
  assert.deepEqual(await mirrors.mounts(), []);
  assert.equal(relayed, 1);
  assert.deepEqual(await mirrors.mounts(), []);
  assert.equal(relayed, 1, "a refused repository isn't asked about again");

  await mirrors.restore([repository]);
  answer = async () => { throw new RunnerError(503, "busy"); };
  assert.deepEqual(await mirrors.mounts(), []);
  assert.deepEqual(await mirrors.mounts(), []);
  assert.equal(relayed, 3);
  grant = async () => ({ policy: { mode: "off", domains: [], packageRegistries: false }, repositories: [] });
  assert.deepEqual(await mirrors.mounts(), []);
  assert.equal(relayed, 3);
  await mirrors.restore([repository]);
  grant = async () => { throw new RunnerError(403, "archived"); };
  assert.deepEqual(await mirrors.mounts(), []);
  assert.equal(relayed, 3);
  await mirrors.restore([repository]);
  mirrors.forget("b1");
  grant = async () => ({ policy: { mode: "off", domains: [], packageRegistries: false }, repositories: [repository] });
  assert.deepEqual(await mirrors.mounts(), []);
  assert.equal(relayed, 3);
  assert.ok(MIRROR_CONFIRM_MS > 0 && MIRROR_ROOT.startsWith("/"));
  assert.ok(refused(new RunnerError(404, "gone")) && !refused(new RunnerError(429, "slow")) && !refused(new RunnerError(408, "late")));
});

test("branch reports send each change once, fold reports asked for meanwhile into one more, and stop when the session closes", async () => {
  const repository = { bindingId: "b1", provider: "github", host: "github.com", owner: "acme", name: "app", repositoryId: "1", fullName: "acme/app" } as unknown as EgressRepository;
  const sent: string[][] = [];
  let branch = "feature";
  let grants = 0;
  let closing = false;
  const gate: { open?: () => void } = {};
  const warnings: string[] = [];
  const reports = new BranchReports({
    sessionId: "s1", closing: () => closing, warn: message => warnings.push(message),
    send: async (_session, branches) => { sent.push(branches.map(item => item.branch)); if (gate.open === undefined) return; await new Promise<void>(resolve => { gate.open = resolve; }); },
    repositories: async () => { grants++; return [repository]; },
    clones: async () => [{ directory: "app", origin: "https://github.com/acme/app.git", branch }],
  });
  reports.request();
  await reports.settled();
  assert.deepEqual(sent, [["feature"]]);
  assert.equal(grants, 1, "the repositories are asked for once");
  reports.request();
  await reports.settled();
  assert.equal(sent.length, 1, "an unchanged report isn't sent again");
  branch = "second";
  gate.open = () => {};
  reports.request();
  reports.request();
  reports.request();
  branch = "third";
  await new Promise(resolve => setTimeout(resolve, 10));
  gate.open?.();
  gate.open = undefined;
  await reports.settled();
  await reports.settled();
  assert.deepEqual(sent.map(list => list[0]), ["feature", "second", "third"], "reports asked for while one was sent become one more, with the latest branches");
  closing = true;
  branch = "after";
  reports.request();
  await reports.settled();
  assert.equal(sent.length, 3, "nothing after the session closes");
  const failing = new BranchReports({ sessionId: "s2", closing: () => false, warn: message => warnings.push(message),
    send: async () => { throw new Error("offline"); }, repositories: async () => [repository], clones: async () => [{ directory: "app", origin: "https://github.com/acme/app.git", branch: "x" }] });
  failing.request();
  await failing.settled();
  assert.match(warnings.at(-1) ?? "", /Session s2: could not report its clones' branches: offline/);
});

function hostPolicy(options: Partial<HostCommandPolicyOptions> = {}, grants: Record<string, Partial<AuthorizationResult>> = {}) {
  const asked: string[] = [];
  const policy = new HostCommandPolicy({
    ownerId: "github:2", connectorOwnerId: "github:1", hostSession: false, onHost: false, limitedSandbox: false, windowsSandbox: false, testShell: false,
    authorize: async (actorId, _permission, host, hostSessions) => {
      asked.push(`${actorId}${host ? " host" : ""}${hostSessions ? " sessions" : ""}`);
      return { allowed: true, policyVersion: 1, ownerId: "github:2", ...grants[actorId] };
    },
    hostConfig: async () => ({ ...defaultHostConfig, hostSessions: true }),
    ...options,
  });
  return { policy, asked };
}

const bash: Operation = { kind: "bash", command: "true" } as Operation;

test("host commands need both the session's owner and the actor granted, and the host's owner always is", async () => {
  const { policy, asked } = hostPolicy({}, { "github:2": { hostCommands: "auto" }, "github:3": {} });
  assert.equal(await policy.allowed("github:2"), true);
  assert.equal(await policy.allowed("github:3"), false);
  await assert.rejects(policy.require("github:3", "Putting a server online"), (error: unknown) =>
    error instanceof RunnerError && error.status === 403 && error.message === `Putting a server online ${HOST_COMMANDS_RULE}`);
  assert.deepEqual(asked, ["github:2 host", "github:2 host", "github:3 host", "github:2 host", "github:3 host"]);
  const own = hostPolicy({ ownerId: "github:1" });
  assert.equal(await own.policy.allowed("github:1"), true);
  assert.deepEqual(own.asked, []);
});

test("a command runs on the host in a host session, or unbounded in a session a grant lets use the host's shell", () => {
  assert.equal(hostPolicy().policy.runsOnHost(bash, false), false);
  assert.equal(hostPolicy().policy.runsOnHost(bash, true), true);
  assert.equal(hostPolicy({ ownerId: "github:1" }).policy.runsOnHost(bash, true), false);
  assert.equal(hostPolicy({ hostSession: true, onHost: true }).policy.runsOnHost(bash, false), true);
  assert.match(hostPolicy({ hostSession: true }).policy.onHostMachine(), /directly on its host/);
  assert.match(hostPolicy().policy.onHostMachine(), /no resource limits/);
});

test("the shell needs a limited sandbox, the host, a Windows sandbox or a test session, unless the command is unbounded", () => {
  assert.throws(() => hostPolicy().policy.requireShell(bash), /quota-backed runner/);
  hostPolicy().policy.requireShell(bash, true);
  hostPolicy().policy.requireShell({ kind: "git.push" } as Operation);
  for (const options of [{ limitedSandbox: true }, { onHost: true }, { windowsSandbox: true }, { testShell: true }]) {
    assert.equal(hostPolicy(options).policy.shellAllowed(), true);
  }
  assert.equal(hostPolicy({ onHost: true, windowsSandbox: true }).policy.shellAllowed(), true);
});

test("a member's host session runs while the host allows host sessions and their grant lasts", async () => {
  await hostPolicy().policy.requireHostEnvironment();
  await hostPolicy({ hostSession: true, ownerId: "github:1" }).policy.requireHostEnvironment();
  const granted = hostPolicy({ hostSession: true }, { "github:2": { hostSessions: true } });
  await granted.policy.requireHostEnvironment();
  assert.deepEqual(granted.asked, ["github:2 host sessions"]);
  await assert.rejects(hostPolicy({ hostSession: true }).policy.requireHostEnvironment(), /grant that let them has ended/);
  await assert.rejects(hostPolicy({ hostSession: true, hostConfig: async () => ({ ...defaultHostConfig, hostSessions: false }) }).policy.requireHostEnvironment(),
    /owner turned that off/);
});

function repositoriesFixture(options: Partial<SessionRepositoriesOptions> & { restore?: (path: string, url: string, reference: string | null) => Promise<void> } = {}) {
  const events: string[] = [];
  let exclusive: Promise<void> = Promise.resolve();
  const state = { opened: true, closing: false, resumed: false };
  const grant = { policy: { mode: "off" as const, domains: [], packageRegistries: true },
    repositories: [{ bindingId: "repo-1", provider: "github" as const, host: "github.com", repositoryId: "1", fullName: "acme/app" }] } as EgressGrant;
  const workspace = { cloneRestore: async (path: string, url: string, reference: string | null, authorize: () => Promise<void>) => {
    await authorize();
    events.push(`restore ${path} ${url} ${reference}`);
    await options.restore?.(path, url, reference);
  } } as unknown as IsolatedWorkspace;
  const repositories = new SessionRepositories({
    grant: async () => grant, cached: true,
    mirror: async (repository, onProgress) => { onProgress({ phase: "receiving", percent: 50, done: 1, total: 2, bytes: 10 } as never); return `/mirrors/${repository.fullName}`; },
    workspace: () => workspace, authorize: async () => { events.push("authorize"); }, changed: () => { events.push("changed"); },
    exclusive: operation => { exclusive = exclusive.then(operation); return exclusive; },
    opened: () => state.opened, closing: () => state.closing, resumed: () => state.resumed, resume: async () => { events.push("resume"); },
    ...options,
  });
  const settled = async () => {
    const preparation = repositories.preparation;
    if (preparation.status === "preparing") await preparation.done.catch(() => {});
    await new Promise(resolve => setImmediate(resolve));
    await exclusive.catch(() => {});
    await new Promise(resolve => setImmediate(resolve));
  };
  return { repositories, events, state, settled };
}

test("repositories: clones come back from the cache in order, failures are kept for the instructions, and work resumes once", async () => {
  const { repositories, events, settled } = repositoriesFixture({
    restore: async path => { if (path === "broken") throw new Error("sandbox: the clone failed"); },
  });
  assert.equal(repositories.view(), undefined);
  repositories.prepareClones([{ path: "app", origin: "https://github.com/acme/app.git" }, { path: "other", origin: "https://github.com/acme/other.git" },
    { path: "broken", origin: "https://github.com/acme/app.git" }]);
  assert.equal(repositories.status, "preparing");
  assert.throws(() => repositories.requireReady(), (error: unknown) => error instanceof RunnerError && error.status === 409);
  assert.deepEqual(repositories.view()!.items.map(item => item.path), ["app", "other", "broken"]);
  await settled();
  assert.equal(repositories.status, "ready");
  assert.equal(repositories.view(), undefined);
  repositories.requireReady();
  assert.deepEqual(repositories.cloneFailures, [{ path: "other", reason: "its origin is not one of this workspace's repositories" }, { path: "broken", reason: "the clone failed" }]);
  assert.deepEqual(events, ["authorize", "restore app https://github.com/acme/app.git /mirrors/acme/app", "authorize",
    "restore broken https://github.com/acme/app.git /mirrors/acme/app", "changed", "resume"]);
  repositories.clearFailures();
  assert.deepEqual(repositories.cloneFailures, []);
});

test("repositories: work doesn't resume in a session that closed, already resumed, or reset meanwhile", async () => {
  for (const change of ["opened", "closing", "resumed"] as const) {
    const { repositories, events, state, settled } = repositoriesFixture();
    repositories.prepareClones([{ path: "app", origin: "https://github.com/acme/app.git" }]);
    if (change === "opened") state.opened = false; else state[change] = true;
    await settled();
    assert.ok(!events.includes("resume"), change);
  }
  let release!: () => void;
  const { repositories, events, settled } = repositoriesFixture({ restore: () => new Promise<void>(resolve => { release = resolve; }) });
  repositories.prepareClones([{ path: "app", origin: "https://github.com/acme/app.git" }]);
  const preparation = repositories.preparation;
  await new Promise(resolve => setTimeout(resolve, 10));
  repositories.reset();
  assert.equal(preparation.status === "preparing" && preparation.controller.signal.aborted, true);
  assert.equal(repositories.status, "ready");
  release();
  await settled();
  assert.ok(!events.includes("resume") && !events.includes("changed"));
});

test("repositories: a resume that fails leaves the preparation failed, with a reason that says to restart", async () => {
  const { repositories, settled } = repositoriesFixture({ resume: async () => { throw new Error("no"); } });
  repositories.prepareClones([{ path: "app", origin: "https://github.com/acme/app.git" }]);
  await settled();
  assert.equal(repositories.status, "failed");
  assert.equal(repositories.view()!.error, "This session could not resume its work after preparing its repositories");
  assert.throws(() => repositories.requireReady(), (error: unknown) => error instanceof RunnerError && error.status === 502
    && error.message === preparationFailure("This session could not resume its work after preparing its repositories"));
  assert.equal(preparationFailure("It broke."), "It broke. Restart the session to try again.");
  repositories.reset();
  assert.equal(repositories.status, "ready");
});

function operationsFixture(options: Partial<SessionOperationsOptions> = {}, run: Partial<Metadata["runs"][string]> = {}) {
  const events: string[] = [];
  const binding = { session: { id: "s1", connectorOwnerId: "github:1" }, owner: { id: "github:1" } } as unknown as RunnerBinding;
  const state: Metadata = { binding, branches: [], approvals: {}, toolActors: { task: { initiatedBy: "github:1", ownerId: "github:1", runKey: "r1", callId: "call-1" } },
    runs: { r1: { key: "r1", initiatedBy: "github:1", ownerId: "github:1", mode: "write", conversationId: 1, content: "", contentHash: "", status: "running", startEntry: 0,
      admissionId: "admission", ...run } } };
  const sandbox = { isolated: true, execute: async (operation: { command: string }, _readOnly: boolean, authorize: () => Promise<void>) => {
    await authorize();
    events.push(`execute ${operation.command}`);
    if (operation.command.includes("fail")) throw new SandboxProcessError("exit 1", 1, null, "out", "");
    return "ran";
  } } as unknown as SessionWorkspace;
  const operations = new SessionOperations({
    binding, config: { connectorId: "connector", controlPlaneUrl: "https://control.invalid", sharedSecret: "secret" }, clone: true, sandboxed: true, sandbox,
    hostCommands: hostPolicy({ ownerId: "github:1", connectorOwnerId: "github:1", testShell: true }).policy, wholeResults: new WholeResults(),
    requireUnfrozen: () => { events.push("unfrozen"); }, authorize: async actorId => { events.push(`authorize ${actorId}`); },
    metadata: async () => structuredClone(state), mutate: async change => { change(state); },
    commandOptions: async () => ({ limits: { seconds: 60 } as never, gpu: false }), testShell: () => true,
    controlPlane: async () => { throw new RunnerError(500, "no control plane"); },
    ...options,
  });
  return { operations, events, state };
}

test("operations: removed and misplaced kinds are refused before anything is authorized or recorded", async () => {
  const refusals: [Record<string, unknown>, RegExp, Partial<SessionOperationsOptions>?][] = [
    [{ kind: "git.commit", message: "x" }, /Commit and switch branches with the git tool/],
    [{ kind: "git.push", repository: "acme/app", branch: "b", commit: "a".repeat(40) }, /a push names a clone's directory/],
    [{ kind: "git.push", repository: "acme/app", directory: "app", branch: "b", commit: "a".repeat(40) }, /Only clone sessions/, { clone: false }],
    [{ kind: "git.push", repository: "acme/app", directory: "app", branch: "b", commit: "a".repeat(40) }, /push with the git tool/, { sandboxed: false }],
  ];
  for (const [operation, message, options] of refusals) {
    const { operations, events, state } = operationsFixture(options);
    await assert.rejects(operations.run("github:1", operation as Operation, "task"), message);
    assert.deepEqual(events, ["unfrozen"]);
    assert.deepEqual(state.approvals, {});
  }
  const frozen = operationsFixture({ requireUnfrozen: () => { throw new RunnerError(409, "read-only"); } });
  await assert.rejects(frozen.operations.run("github:1", bash, "task"), /read-only/);
  assert.deepEqual(frozen.events, []);
  assert.throws(() => githubRepository("not a repository"), /owner\/name/);
  assert.equal(githubRepository("acme/app"), "acme/app");
});

test("operations: a command runs once for its tool call, rechecking its actor, and its record says how it ended", async () => {
  const { operations, events, state } = operationsFixture();
  const ran = await operations.run("github:1", { kind: "bash", command: "echo hi" } as Operation, "task");
  assert.equal(ran.status, "executed");
  assert.equal(ran.result, "ran");
  assert.equal(ran.callId, "call-1");
  assert.equal(ran.admissionId, "admission");
  assert.deepEqual(events, ["unfrozen", "authorize github:1", "authorize github:1", "execute echo hi"]);
  const again = await operations.run("github:1", { kind: "bash", command: "echo other" } as Operation, "task");
  assert.equal(again.result, "ran", "the same tool call gets its first record");
  assert.equal(events.filter(event => event.startsWith("execute")).length, 1);
  state.toolActors.second = { initiatedBy: "github:1", ownerId: "github:1", runKey: "r1" };
  const failed = await operations.run("github:1", { kind: "bash", command: "fail" } as Operation, "second");
  assert.equal(failed.status, "failed");
  assert.match(failed.result!, /out/);
  await assert.rejects(operations.run("github:2", bash, "task"), /no active originating write/);
  const unadmitted = operationsFixture({}, { admissionId: undefined });
  await assert.rejects(unadmitted.operations.run("github:1", bash, "task"), /lacks Worker write admission/);
});

test("operations: GitHub effects go through the broker with the message's admission; a refused merge fails, anything else is ambiguous", async () => {
  const requests: unknown[] = [];
  const { operations, state } = operationsFixture({ config: { connectorId: "connector", controlPlaneUrl: "https://control.invalid", sharedSecret: "secret",
    githubComment: async request => { requests.push(request); return { id: 7, url: "https://github.com/acme/app/issues/1#c7" }; },
    githubMerge: async () => { throw new RunnerError(422, "Head moved"); },
    githubIssue: async () => { throw new Error("network"); } } });
  const comment = await operations.run("github:1", { kind: "github.comment", repository: "acme/app", issue: 1, body: "hi" } as Operation, "task");
  assert.deepEqual(JSON.parse(comment.result!), { id: 7, url: "https://github.com/acme/app/issues/1#c7" });
  assert.deepEqual(requests, [{ sessionId: "s1", actorId: "github:1", approvalId: "tool-task", admissionId: "admission", repository: "acme/app", issue: 1, body: "hi" }]);
  state.toolActors.merge = { initiatedBy: "github:1", ownerId: "github:1", runKey: "r1" };
  const merge = await operations.run("github:1", { kind: "github.merge", repository: "acme/app", pull: 1, sha: "a".repeat(40), method: "squash" } as Operation, "merge");
  assert.deepEqual([merge.status, merge.result], ["failed", "Head moved"]);
  state.toolActors.issue = { initiatedBy: "github:1", ownerId: "github:1", runKey: "r1" };
  const issue = await operations.run("github:1", { kind: "github.issue", repository: "acme/app", title: "t", body: "b" } as Operation, "issue");
  assert.equal(issue.status, "interrupted");
  state.toolActors.extension = { initiatedBy: "github:1", ownerId: "github:1", runKey: "r1" };
  const extension = await operations.run("github:1", { kind: "extension.tool", source: "piki:x", tool: "x", arguments: "{}", digest: "0".repeat(64) } as Operation, "extension");
  assert.equal(extension.status, "executing", "an extension's tool runs where the caller runs it");
});

test("operations: closing aborts a push in progress, waits for it, and reports an unknown outcome", async () => {
  const completed: unknown[] = [];
  let started!: () => void;
  const reached = new Promise<void>(resolve => { started = resolve; });
  const { operations } = operationsFixture({ config: { connectorId: "connector", controlPlaneUrl: "https://control.invalid", sharedSecret: "secret",
    pushCredential: async () => ({ credentialId: "c1", remote: "https://github.com/acme/app.git", hostCredentials: true }) as never,
    pushComplete: async request => { completed.push(request); return {} as never; },
    hostGitCredential: (_remote, signal) => new Promise<string>((_resolve, reject) => { started(); signal!.addEventListener("abort", () => reject(new Error("aborted"))); }) } });
  const push = operations.run("github:1", { kind: "git.push", repository: "acme/app", directory: "app", branch: "b", commit: "a".repeat(40) } as Operation, "task");
  await reached;
  await operations.abortPushes();
  const record = await push;
  assert.equal(record.status, "interrupted");
  assert.match(record.result!, /Push was interrupted/);
  assert.deepEqual(completed, [{ sessionId: "s1", approvalId: "tool-task", credentialId: "c1", outcome: "unknown" }]);
  await operations.abortPushes();
});

function toolState(run: Partial<Metadata["runs"][string]> = {}): Metadata {
  return { binding: {} as RunnerBinding, branches: [], approvals: {}, toolActors: {},
    runs: { r1: { key: "r1", initiatedBy: "github:2", ownerId: "github:1", mode: "write", conversationId: 1, content: "", contentHash: "", status: "running", startEntry: 0,
      admissionId: "admission", ...run } } };
}

function toolApi(state: Metadata, taskId = 1): ToolExecutionApi {
  return { taskId, callId: `call-${taskId}`, conversationId: 1,
    snapshot: async () => ({ json: JSON.stringify(state) }),
    commit: async (change: (tx: { doc(): Promise<{ json: string }> }) => Promise<void>) => {
      const doc = { json: JSON.stringify(state) };
      await change({ doc: async () => doc });
      Object.assign(state, JSON.parse(doc.json));
    } } as unknown as ToolExecutionApi;
}

function toolsFixture(state: Metadata, sandbox: Partial<SessionWorkspace> = {}, overrides: Partial<ToolContext> = {}, ownerOff: readonly string[] = []) {
  const events: string[] = [];
  const hostCommands = hostPolicy({ ownerId: "github:1", connectorOwnerId: "github:1", testShell: true }).policy;
  const workspace = { isolated: true, writeFile: async (path: string, _content: string, authorize: () => Promise<void>) => { await authorize(); events.push(`write ${path}`); },
    ...sandbox } as unknown as SessionWorkspace;
  const authorize = async (actorId: string, permission: string) => { events.push(`authorize ${actorId} ${permission}`); };
  const calls = new ToolCalls({ ownerId: "github:1", sandbox: workspace, hostCommands, authorize, metadata: async () => structuredClone(state),
    hostConfig: async () => ({ ...defaultHostConfig, commandTimeoutSeconds: 600 }),
    requireOwnerTool: async tool => { events.push(`owner ${tool}`); if (ownerOff.includes(tool)) throw new RunnerError(403, `${tool} isn't among the owner's tools`); },
    requireSenderTool: async (tool, senderId) => { events.push(`sender ${senderId} ${tool}`); } });
  const context: ToolContext = {
    binding: { session: { id: "s1" }, owner: { id: "github:1" } } as unknown as RunnerBinding, config: {}, sandbox: workspace, onHost: false, calls, hostCommands,
    wholeResults: new WholeResults(), operations: { run: async () => { events.push("run"); return {} as never; }, internalGitHub: async () => ({}), internalBroker: async () => ({}) },
    requireSessionTool: async tool => { events.push(`tool ${tool}`); }, requireSenderTool: async () => {}, metadata: async () => structuredClone(state), mutate: async change => { change(state); },
    authorize, hostConfig: async () => defaultHostConfig, programMissing: () => undefined, browserUnavailable: () => undefined, tunnelUnavailable: () => undefined,
    tunnel: () => undefined, startTunnel: () => { throw new Error("no tunnel"); }, grant: async () => ({ repositories: [] }) as never,
    ...overrides,
  };
  const tool = (name: string) => buildTools(context, true).find(item => item.name === name) as unknown as { execute(args: unknown, api: ToolExecutionApi, call: unknown): Promise<{ output: { text: string }[] }> };
  return { calls, context, events, tool };
}

test("tool calls: a call acts for the sender of the running message, rechecked and kept for the call; others are refused", async () => {
  const state = toolState();
  const { calls, events } = toolsFixture(state);
  const api = toolApi(state);
  assert.deepEqual(await calls.actor(api, true), { initiatedBy: "github:2", actingAs: "github:1", mode: "write" });
  assert.deepEqual(state.toolActors["1"], { initiatedBy: "github:2", ownerId: "github:1", runKey: "r1", callId: "call-1" });
  await calls.recheck({ initiatedBy: "github:2", mode: "ask" });
  assert.deepEqual(events, ["authorize github:2 write", "authorize github:2 ask"]);
  const asked = toolState({ mode: "ask" });
  await assert.rejects(toolsFixture(asked).calls.actor(toolApi(asked), true), /no authorized writable submission/);
  assert.equal((await toolsFixture(asked).calls.actor(toolApi(asked), false)).mode, "ask");
  const foreign = toolState({ ownerId: "github:9" });
  await assert.rejects(toolsFixture(foreign).calls.actor(toolApi(foreign), false), /no authorized writable submission/);
  const settled = toolState({ status: "settled" });
  await assert.rejects(toolsFixture(settled).calls.actor(toolApi(settled), false), /no authorized writable submission/);
});

test("tool calls: a Read-only message's change is refused, and a shell call is unbounded only where the host's shell isn't allowed", async () => {
  const state = toolState({ options: { access: "read" } });
  state.toolActors["1"] = { initiatedBy: "github:2", ownerId: "github:1", runKey: "r1" };
  const { calls } = toolsFixture(state);
  await assert.rejects(calls.check(toolApi(state), "write", { write: true }), (error: unknown) => error instanceof RunnerError && error.status === 403
    && error.message === "write changes things, which a Read-only message doesn't do: ask in a message that may act. Nothing ran.");
  assert.deepEqual(await calls.check(toolApi(state), "read"), { unbounded: false });
  assert.deepEqual(await calls.check(toolApi(state), "git", { shell: true }), { unbounded: false });
  await assert.rejects(calls.check(toolApi(state, 2), "read"), /no authorized writable submission/);
  assert.equal((await calls.outputFiles(toolApi(state))), undefined, "a Read-only message writes no output files");
  assert.equal((await calls.commandOptions(30)).limits.seconds, 30);
  assert.equal((await calls.commandOptions()).limits.seconds, 600);
});

test("tools: the families keep their order, git_push comes last and only for a clone in the sandbox", () => {
  const { context } = toolsFixture(toolState());
  const names = buildTools(context, false).map(tool => tool.name);
  const python = process.platform === "win32" ? [] : ["python"];
  assert.deepEqual(names, ["identity", "read", "ls", "grep", "find", "write", "edit", "move_file", "copy_file", "delete_file", "git", ...python, "browser",
    "tunnel", "github_read", "github_comment", "github_merge", "github_issue", "schedule", "sessions"]);
  assert.deepEqual(buildTools(context, true).map(tool => tool.name), [...names, "git_push"]);
});

test("tools: a tool checks that it is on first, then who acts, then the call, and only then touches the worktree", async () => {
  const state = toolState();
  const { events, tool } = toolsFixture(state);
  const written = await tool("write").execute({ path: "a.txt", content: "x" }, toolApi(state), {});
  assert.equal(written.output[0]!.text, "Successfully wrote to a.txt");
  assert.deepEqual((written as { details?: unknown }).details, { pikibun: { initiatedBy: "github:2", actingAs: "github:1", mode: "write" } }, "who the call acts for is in its details");
  assert.deepEqual(events, ["authorize github:2 write", "owner write", "sender github:2 write", "authorize github:2 write", "write a.txt"]);
  events.length = 0;
  await assert.rejects(tool("github_merge").execute({ repository: "acme/app", pull: 1, sha: "short", method: "squash" }, toolApi(state), {}), /40-character head commit/);
  assert.deepEqual(events, ["tool github_merge", "authorize github:2 write"]);
  const off = toolsFixture(state, {}, { requireSessionTool: async tool => { throw new RunnerError(403, `${tool} is turned off`); } });
  await assert.rejects(off.tool("git").execute({ args: ["status"] }, toolApi(state), {}), /git is turned off/);
  assert.deepEqual(off.events, [], "a tool that is off checks nothing else and runs nothing");
  const sender = toolState();
  const senderOff = toolsFixture(sender, {}, { requireSenderTool: async tool => { throw new RunnerError(403, `${tool} isn't among the sender's tools`); } });
  await assert.rejects(senderOff.tool("tunnel").execute({ action: "start", serve: { program: "node", port: 8080 } }, toolApi(sender), {}), /tunnel isn't among the sender's tools/);
  assert.ok(!senderOff.events.includes("run"), "a tunnel the sender may not start never reaches its operation");
  const notOwner = toolState();
  await assert.rejects(toolsFixture(notOwner).tool("schedule").execute({ action: "list" }, toolApi(notOwner), {}), /Only the session owner's messages schedule prompts/);
  const readOnly = toolState({ options: { access: "read" } });
  const refused = toolsFixture(readOnly);
  await assert.rejects(refused.tool("git").execute({ args: ["status"] }, toolApi(readOnly), {}), /Read-only message/);
  assert.ok(!refused.events.includes("run"));
});

test("tool calls: every call is checked against the owner's group, the file tools and the owner's own messages too", async () => {
  const own = toolState({ initiatedBy: "github:1" });
  const { events, tool } = toolsFixture(own, {}, {}, ["write", "read"]);
  await assert.rejects(tool("write").execute({ path: "a.txt", content: "x" }, toolApi(own), {}), /write isn't among the owner's tools/);
  assert.ok(!events.includes("write a.txt"), "a file tool the owner's group leaves out writes nothing");
  await assert.rejects(tool("read").execute({ path: "a.txt" }, toolApi(own, 2), {}), /read isn't among the owner's tools/);
  const asked = toolState({ mode: "ask" });
  asked.toolActors["1"] = { initiatedBy: "github:2", ownerId: "github:1", runKey: "r1" };
  const ask = toolsFixture(asked, {}, {}, ["grep"]);
  await assert.rejects(ask.calls.check(toolApi(asked), "grep"), /grep isn't among the owner's tools/);
  assert.deepEqual(ask.events, ["owner grep"], "an ask checks the owner's group, and no sender's");
});

function definitionsFixture(options: Partial<SessionDefinitionsOptions> = {}) {
  const tools: string[] = ["read"];
  const installed: string[] = [];
  const reserved: string[][] = [];
  const definitions = new SessionDefinitions({
    sessionId: "s1", windows: false, config: {},
    tool: definition => ({ name: definition.name, description: definition.description, parameters: {}, execute: async () => ({ output: [] }) }) as unknown as ToolRegistration,
    registry: () => ({ install: (extension: { name: string }) => { installed.push(extension.name); } }) as unknown as Registry,
    toolNames: () => tools, added: (added, names) => { tools.push(...added.map(tool => tool.name)); reserved.push(names); },
    ...options,
  });
  return { definitions, tools, installed, reserved };
}

test("defined tools: a session loads the bundled definitions not taken by its own tools, and the Windows sandbox only those that run there", async () => {
  const { definitions } = definitionsFixture();
  const node = bundledToolDefinitions.find((item): item is ProgramToolDefinition => item.name === "node" && item.kind === "program")!;
  const loaded = await definitions.load(["node"]);
  assert.ok(!loaded.some(tool => tool.name === "node"), "a session's own tool of that name wins");
  assert.deepEqual(loaded.map(tool => tool.name), definitions.definitions.map(item => item.name));
  assert.ok(definitions.definitions.length > 1);
  assert.deepEqual(definitions.extensions, []);
  const windows = definitionsFixture({ windows: true }).definitions;
  assert.deepEqual(windows.usable([node, { ...node, name: "other", windowsSandbox: true } as ToolDefinition], []).map(item => item.name), node.windowsSandbox ? ["node", "other"] : ["other"]);
  assert.deepEqual(definitions.usable([node, node], []).map(item => item.name), ["node"], "the first of a name wins");
});

test("defined tools: a refresh adds what Pikibun defines now as one more extension, keeps what changed as it was, and tells each change once", async t => {
  const node = bundledToolDefinitions.find(item => item.name === "node")!;
  const make = bundledToolDefinitions.find(item => item.name === "make")!;
  let served: ToolDefinition[] = [node];
  const { definitions, tools, installed, reserved } = definitionsFixture({ config: { toolDefinitions: async () => served } });
  tools.push(...(await definitions.load(["read"])).map(tool => tool.name));
  assert.deepEqual(definitions.definitions.map(item => item.name), ["node"]);
  const notes: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: string) => { notes.push(chunk); return true; });
  served = [{ ...node, description: "changed" }, make];
  await definitions.refresh(["make"]);
  assert.deepEqual(installed, [], "an extension's own tool of that name keeps it");
  await definitions.refresh([]);
  await definitions.refresh([]);
  assert.deepEqual(installed, ["defined-tools-1"]);
  assert.deepEqual(reserved, [["make"]]);
  assert.deepEqual(tools, ["read", "node", "make"]);
  assert.deepEqual(definitions.definitions.map(item => item.name), ["node", "make"]);
  assert.equal(definitions.definitions[0]!.description, node.description, "a changed definition is used as it was until the session opens again");
  assert.deepEqual(notes, ["Session s1: the tool definition node changed; the session uses it as it was until it next opens.\n",
    "Session s1: the tool definition make is offered by one of the workspace's extensions, which keeps it.\n"]);
  const without = definitionsFixture();
  await without.definitions.refresh([]);
  const unopened = definitionsFixture({ config: { toolDefinitions: async () => served }, registry: () => undefined });
  await unopened.definitions.refresh([]);
  assert.deepEqual([without.installed, unopened.installed], [[], []]);
});

function pikiFixture(state: Metadata, options: Partial<SessionPikiOptions> = {}, grants: Record<string, Partial<AuthorizationResult>> = { "github:2": { hostCommands: "auto" } }) {
  const events: string[] = [];
  const sandbox = { hostWorktree: "/worktree", execute: async (operation: { command: string }, readOnly: boolean, authorize: () => Promise<void>) => {
    await authorize();
    events.push(`execute ${readOnly ? "read-only " : ""}${operation.command}`);
    return "done";
  }, writeFile: async (path: string) => { events.push(`write ${path}`); }, listFiles: async () => [] } as unknown as SessionWorkspace;
  const authorize = async (actorId: string, permission: string) => { events.push(`authorize ${actorId} ${permission}`); };
  const calls = new ToolCalls({ ownerId: "github:1", sandbox, hostCommands: hostPolicy().policy, authorize, metadata: async () => structuredClone(state),
    hostConfig: async () => defaultHostConfig, requireOwnerTool: async () => {}, requireSenderTool: async () => {} });
  const piki = new SessionPiki({
    binding: { session: { id: "s1", connectorOwnerId: "github:1" }, owner: { id: "github:1" } } as unknown as RunnerBinding, config: {}, sandbox, onHost: false,
    sandboxed: true, calls, hostCommands: hostPolicy({ ownerId: "github:1" }, grants).policy, wholeResults: new WholeResults(),
    operations: { run: async (_actorId, operation) => { events.push(`run ${(operation as { tool: string }).tool}`); return { id: "tool-1", status: "executing" } as never; } },
    apiLease: () => { events.push("lease"); return { token: "lease-token", release: () => { events.push("release"); } }; },
    forgeWrites: async senderId => { events.push(`forge writes ${senderId}`); return true; },
    model: () => undefined, thinkingLevel: () => undefined,
    extensionChoice: async () => ({ chosen: [{ source: "npm:ext", dev: false }], automaticTools: false }),
    metadata: async () => structuredClone(state), mutate: async change => { change(state); }, hostConfig: async () => defaultHostConfig,
    ...options,
  });
  return { piki, host: piki.host(), events };
}

const pikiRun = (callId: string, readOnly = false): PikiSandboxRun => ({ callId, command: "gh", args: ["pr", "view"], env: {}, tokenEnv: ["GH_TOKEN"], readOnly,
  signal: new AbortController().signal, timeoutSeconds: 30 });

test("piki: an extension's tool runs for a message that may act, while its extension applies, for someone with host commands, and its record says how it ended", async () => {
  const state = toolState();
  state.approvals["tool-1"] = { id: "tool-1", status: "executing" } as never;
  const { host, events } = pikiFixture(state);
  const call = (source = "npm:ext") => ({ source, tool: "ext_tool", arguments: { a: 1 }, api: toolApi(state), signal: new AbortController().signal, context: {} as never });
  const result = await host.runTool(call(), async () => {
    events.push("tool ran");
    return { output: [{ type: "text", text: "hello" }] };
  });
  assert.deepEqual(result.output, [{ type: "text", text: "hello" }]);
  assert.deepEqual(events, ["authorize github:2 write", "run ext_tool", "authorize github:2 write", "forge writes github:2", "tool ran"]);
  assert.deepEqual([state.approvals["tool-1"]!.status, state.approvals["tool-1"]!.result], ["executed", "hello"]);
  await assert.rejects(host.runTool(call(), async () => { throw new Error("broke"); }), /broke/);
  assert.deepEqual([state.approvals["tool-1"]!.status, state.approvals["tool-1"]!.result], ["failed", "broke"]);
  await assert.rejects(host.runTool(call("npm:other"), async () => ({ output: [] })), /no longer applies to this session/);
  const readOnly = toolState({ options: { access: "read" } });
  await assert.rejects(pikiFixture(readOnly).host.runTool({ ...call(), api: toolApi(readOnly) }, async () => ({ output: [] })), /a Read-only message doesn't run it/);
  const ungranted = toolState();
  const refused = pikiFixture(ungranted, {}, { "github:2": {} });
  await assert.rejects(refused.host.runTool({ ...call(), api: toolApi(ungranted) }, async () => ({ output: [] })), (error: unknown) =>
    error instanceof RunnerError && error.message === `ext_tool comes from an extension, which ${HOST_COMMANDS_RULE}`);
  assert.ok(!refused.events.some(event => event.startsWith("run")));
});

test("piki: a CLI runs in the sandbox only inside a call the session admitted, with the API lease only for a call that may write", async () => {
  const state = toolState();
  state.approvals["tool-1"] = { id: "tool-1", status: "executing" } as never;
  const { host, events } = pikiFixture(state);
  const piki = host.piki!;
  assert.equal(piki.hostSignIn, false);
  await assert.rejects(piki.sandbox!(pikiRun("call-1")), /runs only in a call of its tool this session admitted/);
  await assert.rejects(piki.saveOutput!("call-1", "gh", "x"), /its call no longer runs/);
  assert.equal(piki.fromScript!("call-1"), false);
  events.length = 0;
  await host.runTool({ source: "npm:ext", tool: "gh", arguments: {}, api: toolApi(state), signal: new AbortController().signal, context: {} as never }, async () => {
    const written = await piki.sandbox!(pikiRun("call-1"));
    const read = await piki.sandbox!(pikiRun("call-1", true));
    assert.deepEqual([written.output, read.output], ["done", "done"]);
    assert.match(await piki.saveOutput!("call-1", "gh", "long"), /gh/);
    return { output: [] };
  });
  assert.deepEqual(events.slice(4), ["lease", "authorize github:2 write",
    `execute PATH="$PATH:/usr/local/bin" && export PATH && exec env 'GH_TOKEN=lease-token' 'gh' 'pr' 'view' </dev/null 2>&1`, "release",
    "authorize github:2 write", `execute read-only PATH="$PATH:/usr/local/bin" && export PATH && exec env 'gh' 'pr' 'view' </dev/null 2>&1`,
    "write tool-output/gh-call-1-d39038e4.txt"], "a read-only command gets no lease");
  const onHost = pikiFixture(state, { onHost: true }).host.piki!;
  assert.equal(onHost.sandbox, undefined);
  assert.equal(onHost.hostSignIn, true);
  assert.equal(onHost.forgeWrites!("call-1"), false, "outside a call of its tool, nothing writes");

  const limited = pikiFixture(state, { forgeWrites: async () => false });
  const limitedPiki = limited.host.piki!;
  limited.events.length = 0;
  await limited.host.runTool({ source: "npm:ext", tool: "gh", arguments: {}, api: toolApi(state), signal: new AbortController().signal, context: {} as never }, async () => {
    assert.equal(limitedPiki.forgeWrites!("call-1"), false);
    await limitedPiki.sandbox!(pikiRun("call-1"));
    return { output: [] };
  });
  assert.ok(!limited.events.includes("lease"), "a sender or owner whose group lacks the GitHub writing tools gets no write lease");
  assert.ok(limited.events.some(event => event.startsWith("execute PATH") && !event.includes("lease-token")));
});

test("view: context usage counts the conversation's tokens against its model's window, and says where it compacts", () => {
  const messages = [{ role: "user", content: "hello there", timestamp: 0 }] as never;
  const models = { getModel: (provider: string, modelId: string) => provider === "p" && modelId === "m" ? { contextWindow: 1000 } : undefined } as never;
  const usage = contextView(messages, { provider: "p", modelId: "m" }, { fallback: undefined, models, compaction: () => ({ enabled: true, reserveTokens: 100, keepRecentTokens: 10 }) as never })!;
  assert.ok(usage.tokens > 0);
  assert.equal(usage.window, 1000);
  assert.equal(typeof usage.compactsAt, "number");
  const fallback = contextView(messages, undefined, { fallback: { provider: "p", modelId: "m" }, models, compaction: () => undefined })!;
  assert.equal(fallback.window, 1000, "without the conversation's model, the session's is used");
  const broken = contextView(messages, { provider: "p", modelId: "m" }, { fallback: undefined, models: { getModel: () => { throw new Error("x"); } } as never, compaction: () => undefined })!;
  assert.equal(broken.window, undefined);
});

test("view: the queue, who is busy, the access of the latest write, the preparation, and the tunnel come from what the session gives it", async () => {
  const state = toolState({ status: "queued", sequence: 1, options: { access: "read" } });
  state.runs.r0 = { ...state.runs.r1!, key: "r0", sequence: 0, status: "interrupted", stopped: { by: "github:1" } };
  state.branches = [{ id: 1, mode: "write" }, { id: 2, mode: "ask", superseded: true }];
  const asked: number[] = [];
  const source: ViewSource = {
    binding: { session: { id: "s1" }, owner: { id: "github:1", displayName: "Ada", gitName: "Ada", gitEmail: "ada@example.test", githubLogin: "ada", env: {} } } as unknown as RunnerBinding,
    tunnel: () => ({ url: "https://x.trycloudflare.com" }) as never, metadata: async () => structuredClone(state),
    conversation: async id => { asked.push(id); return { context: async () => ({ entries: [], messages: [] }) } as never; },
    agent: async () => ({ model: { provider: "p", modelId: "m" }, thinkingLevel: "low" }) as never,
    context: () => ({ tokens: 5 }), repositories: () => undefined, extensions: async () => ({ extensions: { running: [], missing: ["npm:x"] } }),
  };
  const view = await sessionView(source);
  assert.deepEqual(asked, [1], "superseded branches aren't read");
  assert.deepEqual(view.owner, { id: "github:1", displayName: "Ada", gitName: "Ada", gitEmail: "ada@example.test", githubLogin: "ada" });
  assert.deepEqual(view.queue!.map(item => [item.submissionId, item.status]), [["r0", "stopped"], ["r1", "queued"]]);
  assert.deepEqual([view.busy, view.access, view.context, view.agent], [true, "read", { tokens: 5 }, { provider: "p", modelId: "m", thinkingLevel: "low" }]);
  assert.deepEqual(view.conversations, [{ id: "1", mode: "write" }]);
  assert.deepEqual(view.extensions, { running: [], missing: ["npm:x"] });
  assert.deepEqual(view.tunnel, { url: "https://x.trycloudflare.com" });
  const preparing = await sessionView({ ...source, repositories: () => ({ status: "preparing", items: [] }) });
  assert.deepEqual([preparing.activity, preparing.busy], ["working", true]);
  assert.equal((await sessionView({ ...source, repositories: () => ({ status: "failed", items: [], error: "x" }) })).activity, "failed");
});

test("view: extensions show what runs, what is missing, the built-ins, and tools the host can't offer", async () => {
  const base: ExtensionViewSource = {
    binding: { session: { workspaceId: "w", connectorOwnerId: "github:1" }, owner: { id: "github:1" } } as unknown as RunnerBinding,
    config: undefined, builtins: () => undefined, hostConfig: async () => defaultHostConfig, requiredExtensions: async () => [], toolNames: () => ["read"],
    definedToolsOff: off => off, browserUnavailable: () => "missing", tunnelUnavailable: () => undefined, missingPrograms: () => [{ tool: "node", source: "piki:node", programs: ["yarn"] }],
  };
  assert.deepEqual(await extensionView(base), {}, "a host without extensions or built-ins shows none");
  const builtins = { select: (enabled: string[]) => enabled.map(name => ({ name })) } as never;
  assert.deepEqual(await extensionView({ ...base, builtins: () => builtins, hostConfig: async () => ({ ...defaultHostConfig, builtinExtensions: ["pi:codemode"] }) }),
    { extensions: { running: [], missing: [], builtin: ["pi:codemode"] } });
  const config = { workspace: async () => ({ extensions: [{ source: "npm:absent@1.0.0", enabled: true, tools: "approval", settings: {} }], automaticTools: false }), installed: () => [] } as never;
  assert.deepEqual(await extensionView({ ...base, config }), { extensions: { running: [], missing: ["npm:absent@1.0.0"], unavailable: [
    { source: "piki:browser", tools: ["browser"], reason: "missing" }, { source: "piki:node", tools: ["node"], reason: "programs", programs: ["yarn"] }] } });
  assert.deepEqual(await extensionView({ ...base, config: { workspace: async () => { throw new Error("offline"); }, installed: () => [] } }), {});
});

async function queueFixture(t: TestContext, runs: Partial<Metadata["runs"][string]>[], options: Partial<RunQueueOptions> = {}) {
  const events: string[] = [];
  const state = toolState();
  state.runs = Object.fromEntries(runs.map((run, index) => [`r${index}`, { ...state.runs.r1!, key: `r${index}`, status: "queued", sequence: index, ...run }]));
  const inputs = new MessageInputs(join(await directory(t), "inputs"));
  const flags = { generation: 0, closing: false, preparation: "ready" as const };
  const settle: ((value: { status: string; reason?: string }) => void)[] = [];
  const harness = {
    conversation: async () => ({
      context: async () => ({ entries: [{ id: 4 }], messages: [] }),
      submit: async (input: { content: unknown; requestId: string }) => { events.push(`submit ${input.requestId} ${JSON.stringify(input.content)}`); return { id: 7 }; },
      waitForIdle: async () => {}, agent: async () => ({}),
    }),
    submission: async () => ({ wait: () => new Promise(resolve => settle.push(resolve)) }),
  };
  let lock: Promise<unknown> = Promise.resolve();
  let queue!: RunQueue;
  queue = new RunQueue({
    sessionId: "s1", connectorOwnerId: "github:1", inputs, config: {}, configuredCompaction: () => undefined,
    generation: () => flags.generation, closing: () => flags.closing, preparation: () => flags.preparation, harness: () => harness as never,
    hostExtensions: () => undefined, exclusive: operation => { const next = lock.then(operation, operation); lock = next.catch(() => undefined); return next; },
    metadata: async () => structuredClone(state), mutate: async change => { change(state); },
    authorize: async actorId => { if (actorId === "github:9") throw new RunnerError(403, "revoked"); },
    requiredRefusal: async () => undefined, extensionChoice: async () => ({ chosen: [] }),
    applyOptions: async (_conversation, run) => { events.push(`options ${run.key}`); }, drain: () => { events.push("drain"); queue.drain(); },
    ...options,
  });
  const idle = async () => { for (let index = 0; index < 5; index++) { await lock; await new Promise(resolve => setImmediate(resolve)); } };
  return { queue, state, inputs, flags, events, settle, idle };
}

test("run queue: the next queued message runs once nothing else does, as its sender may still, and a drain asked meanwhile runs again", async t => {
  const { queue, state, events, settle, idle } = await queueFixture(t, [{ initiatedBy: "github:9" }, { content: "go" }, { content: "later", initiatedBy: "github:3" }]);
  queue.drain();
  queue.drain();
  await idle();
  assert.equal(state.runs.r0!.status, "interrupted", "a sender who may no longer write is skipped");
  assert.deepEqual([state.runs.r1!.status, state.runs.r1!.submissionId, state.runs.r1!.started, state.runs.r1!.startEntry], ["running", 7, true, 4]);
  assert.equal(state.runs.r2!.status, "queued", "one message runs at a time");
  assert.deepEqual(events, ["options r1", "submit r1 \"go\"", "drain"], "the drain asked while draining runs once more, through the session");
  settle[0]!({ status: "done" });
  await idle();
  assert.equal(state.runs.r1!.status, "settled");
  assert.equal(state.runs.r2!.status, "running", "a settled run lets the next one start");
});

test("run queue: nothing starts while the session closes or its repositories prepare; a refusal or lost images end the message", async t => {
  const closing = await queueFixture(t, [{}]);
  closing.flags.closing = true;
  closing.queue.drain();
  await closing.idle();
  assert.equal(closing.state.runs.r0!.status, "queued");
  const preparing = await queueFixture(t, [{}]);
  (preparing.flags as { preparation: string }).preparation = "preparing";
  preparing.queue.drain();
  await preparing.idle();
  assert.equal(preparing.state.runs.r0!.status, "queued");
  const refused = await queueFixture(t, [{}], { requiredRefusal: async () => "required extension missing" });
  refused.queue.drain();
  await refused.idle();
  assert.deepEqual([refused.state.runs.r0!.status, refused.state.runs.r0!.refused], ["interrupted", { by: "", notice: "required extension missing" }]);
  const lost = await queueFixture(t, [{ images: { count: 1, bytes: 4 } }]);
  assert.equal(await lost.queue.runInput(lost.state.runs.r0!), undefined);
  lost.queue.drain();
  await lost.idle();
  assert.deepEqual([lost.state.runs.r0!.status, lost.state.runs.r0!.inputsLost], ["interrupted", true]);
});

test("run queue: a run that settles after the session reopened is left alone; screening refuses an emptied message and lets the queue go on", async t => {
  const { queue, state, flags, events, settle, idle } = await queueFixture(t, [{ content: "go" }]);
  queue.drain();
  await idle();
  flags.generation++;
  settle[0]!({ status: "done" });
  await idle();
  assert.equal(state.runs.r0!.status, "running", "another generation's settlement changes nothing");
  const host = { input: async () => ({ action: "continue", text: " ", images: [] }) };
  const screening = await queueFixture(t, [{ screening: true, content: "hi" }], { hostExtensions: () => host as never });
  await screening.queue.screen("r0");
  assert.deepEqual([screening.state.runs.r0!.status, screening.state.runs.r0!.refused?.notice, screening.state.runs.r0!.screening], ["interrupted", INPUT_EMPTY, undefined]);
  assert.deepEqual(screening.events, ["drain"]);
  const images = await queueFixture(t, [{ images: { count: 1, bytes: 4 } }]);
  await images.inputs.write("r0", [{ mimeType: "image/png", data: "iVBORw0KGgo=" }]);
  assert.deepEqual(await images.queue.runInput(images.state.runs.r0!), [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }], "no text part for an empty text");
  images.state.runs.r0!.content = "look";
  assert.deepEqual((await images.queue.runInput(images.state.runs.r0!))![0], { type: "text", text: "look" });
  images.state.runs.r0!.status = "settled";
  await images.queue.sweepInputs();
  assert.equal(await images.inputs.read("r0"), undefined, "a run that no longer waits loses its images");
  assert.deepEqual(events, ["options r0", "submit r0 \"go\""]);
});

test("run queue: only the running sender's next shared message, with the same options and no images, steers; anything else waits", () => {
  const runs = (...queued: Partial<Run>[]) => {
    const state = toolState({ submissionId: 7, sequence: 0, options: { access: "auto" } });
    queued.forEach((run, index) => { state.runs[`q${index}`] = { ...state.runs.r1!, key: `q${index}`, status: "queued", sequence: index + 1, submissionId: undefined, ...run }; });
    return state.runs;
  };
  const steers = (run: Partial<Run>, others: Partial<Run>[] = []) => { const all = runs(run, ...others); return steersInto(all, all.q0!); };
  assert.equal(steers({}), "r1");
  assert.equal(steers({ initiatedBy: "github:3" }), undefined, "someone else's message waits");
  assert.equal(steers({ mode: "ask" }), undefined, "a side ask waits");
  assert.equal(steers({ options: { access: "read" } }), undefined, "other options wait");
  assert.equal(steers({ options: undefined }), undefined);
  assert.equal(steers({ conversationId: 2 }), undefined, "another conversation waits");
  assert.equal(steers({ images: { count: 1, bytes: 4 } }), undefined, "a message with images waits");
  assert.equal(steers({ screening: true }), undefined, "a message still screened waits");
  const auto = runs({ options: { auto: { candidates: [{ provider: "p", modelId: "m", name: "M" }] } } });
  auto.r1!.options = { auto: true };
  assert.equal(steersInto(auto, auto.q0!), undefined, "an Auto message waits to be judged on its own turn, not steering a run whose choice is made");
  const stopping = runs({});
  stopping.r1!.stopped = { by: "github:2", pending: true };
  assert.equal(steersInto(stopping, stopping.q0!), undefined, "nothing steers a stopping run");
  const admitting = runs({}, { status: "admitting" });
  assert.equal(steersInto(admitting, admitting.q0!), undefined);
  const asking = runs({});
  asking.a = { ...asking.r1!, key: "a", mode: "ask", conversationId: 2, sequence: 0.5, submissionId: 9 };
  assert.equal(steersInto(asking, asking.q0!), "r1", "a side ask running beside it changes nothing");
  asking.a.status = "admitting";
  assert.equal(steersInto(asking, asking.q0!), "r1");
  const chain = runs({});
  chain.s = { ...chain.r1!, key: "s", sequence: 0.5, steered: "r1" };
  chain.r1!.status = "settled";
  assert.equal(steersInto(chain, chain.q0!), "r1", "a message steers into the first message of the run, after it answered too");
  assert.equal(submissionRequestId({ key: "k" }), "k");
  assert.equal(submissionRequestId({ key: "k", steered: "r1" }), "k:steer");
});

test("run queue: a side ask starts at once beside the shared work, up to the limit, and shared messages keep their own order", async t => {
  const steer = steerHarness();
  const ends: boolean[] = [];
  const host = { agentEnd: async (_messages: unknown, failed: boolean) => { ends.push(failed); } };
  const ask = (content: string, run: Partial<Run> = {}) => ({ mode: "ask" as const, content, conversationId: 2, ...run });
  const { queue, state, idle } = await queueFixture(t, [{ content: "go" }, { content: "later", initiatedBy: "github:3" }, ask("screened", { screening: true }),
    ask("a1"), ask("a2"), ask("a3"), ask("a4"), ask("a5")], { ...steer.options, hostExtensions: () => host as never });
  state.approvals.x = { status: "executing" } as never;
  queue.drain();
  await idle();
  assert.deepEqual(Object.values(state.runs).map(run => run.status), ["queued", "queued", "queued", "running", "running", "running", "running", "queued"],
    "while a tool's operation goes on, shared messages wait and side asks go, four at a time; one still screened waits for its screening");
  delete state.approvals.x;
  queue.drain();
  await idle();
  assert.deepEqual([state.runs.r0!.status, state.runs.r1!.status], ["running", "queued"], "the shared message starts beside the side asks, the next one waits for it");
  const id = (key: string) => state.runs[key]!.submissionId as number;
  steer.submissions.get(id("r3"))!.settle({ status: "done", answer: 1 });
  await idle();
  assert.deepEqual([state.runs.r3!.status, state.runs.r7!.status], ["settled", "running"], "a side ask that ends makes room for the next");
  assert.deepEqual(ends, [], "a side ask doesn't end the agent's work for host extensions");
  delete state.runs.r2!.screening;
  queue.drain();
  await idle();
  assert.equal(state.runs.r2!.status, "queued", "still four at a time");
  steer.submissions.get(id("r0"))!.settle({ status: "done", answer: 2 });
  await idle();
  assert.deepEqual([state.runs.r0!.status, state.runs.r1!.status], ["settled", "running"]);
  assert.deepEqual(ends, [false], "the shared message's end does");
  const stopping = await queueFixture(t, [{ content: "go", status: "interrupted", stopped: { by: "github:2", pending: true } }, ask("later")], steerHarness().options);
  stopping.queue.drain();
  await stopping.idle();
  assert.equal(stopping.state.runs.r1!.status, "queued", "nothing starts while a stop is under way");
});

function steerHarness() {
  const events: string[] = [];
  const submissions = new Map<number, { record: Record<string, unknown>; settle: (value: Record<string, unknown>) => void; settled: Promise<Record<string, unknown>> }>();
  let next = 7;
  const flags = { idle: false };
  const track = (status = "queued") => {
    const id = next++;
    let settle!: (value: Record<string, unknown>) => void;
    const settled = new Promise<Record<string, unknown>>(resolve => { settle = resolve; });
    const entry = { record: { status } as Record<string, unknown>, settle: (value: Record<string, unknown>) => { entry.record = value; settle(value); }, settled };
    submissions.set(id, entry);
    return id;
  };
  const harness = {
    conversation: async () => ({
      context: async () => ({ entries: [{ id: 4 }], messages: [] }),
      submit: async (input: { content: unknown; requestId: string; whenBusy?: string; whenIdle?: string }) => {
        events.push(`submit ${input.requestId}${input.whenBusy ? ` ${input.whenBusy}` : ""}${input.whenIdle ? ` ${input.whenIdle}` : ""}`);
        if (input.whenIdle === "reject" && flags.idle) throw new ConversationIdle(1 as ConversationId);
        return { id: track(input.whenBusy === "steer" ? "queued" : "placed") };
      },
      waitForIdle: async () => {}, agent: async () => ({}),
    }),
    submission: async (id: number) => {
      const entry = submissions.get(id);
      return entry && {
        wait: () => entry.settled,
        status: async () => entry.record,
        abort: async () => { if (entry.record.status !== "queued") return "already_placed"; events.push(`abort ${id}`); entry.settle({ status: "unanswered", reason: "aborted" }); return "aborted"; },
      };
    },
  };
  const options = { harness: () => harness as never, applyOptions: async (_conversation: unknown, run: Run) => { events.push(`options ${run.key}`); } };
  return { harness, options, events, submissions, flags, track };
}

test("run queue: the sender's next message steers the run at work, the queue behind it keeps its order, and both settle with it", async t => {
  const steer = steerHarness();
  const ends: boolean[] = [];
  const host = { agentEnd: async (_messages: unknown, failed: boolean) => { ends.push(failed); } };
  const { queue, state, idle } = await queueFixture(t, [{ content: "go" }, { content: "also this" }, { content: "other", initiatedBy: "github:3" }, { content: "after" }],
    { ...steer.options, hostExtensions: () => host as never });
  queue.drain();
  await idle();
  assert.deepEqual([state.runs.r0!.status, state.runs.r0!.submissionId], ["running", 7]);
  queue.drain();
  await idle();
  assert.deepEqual([state.runs.r1!.status, state.runs.r1!.steered, state.runs.r1!.submissionId, state.runs.r1!.started], ["running", "r0", 8, true]);
  assert.deepEqual([state.runs.r2!.status, state.runs.r3!.status], ["queued", "queued"], "someone else's message, and everything behind it, wait");
  assert.deepEqual(steer.events, ["options r0", "submit r0", "submit r1:steer steer reject"], "a steer keeps the run's options");
  steer.submissions.get(8)!.record = { status: "placed" };
  steer.submissions.get(7)!.settle({ status: "done", answer: 20 });
  steer.submissions.get(8)!.settle({ status: "done", answer: 20 });
  await idle();
  assert.deepEqual([state.runs.r0!.status, state.runs.r1!.status], ["settled", "settled"]);
  assert.deepEqual(ends, [false], "the run ended once, so extensions hear of it once");
  assert.equal(state.runs.r2!.status, "running", "then the queue goes on");
});

test("run queue: a steer that finds the run ended waits in the queue; one a failed run left unplaced runs on its own next", async t => {
  const idleSteer = steerHarness();
  const late = await queueFixture(t, [{ status: "running", submissionId: 7 }, { content: "late" }], idleSteer.options);
  idleSteer.track();
  idleSteer.flags.idle = true;
  late.queue.drain();
  await late.idle();
  assert.deepEqual([late.state.runs.r1!.status, late.state.runs.r1!.steered, late.state.runs.r1!.started], ["queued", undefined, undefined]);
  const steer = steerHarness();
  const { queue, state, idle } = await queueFixture(t, [{ content: "go" }, { content: "also" }], steer.options);
  queue.drain();
  await idle();
  queue.drain();
  await idle();
  assert.equal(state.runs.r1!.steered, "r0");
  steer.submissions.get(7)!.settle({ status: "unanswered", reason: "model_error", detail: "500" });
  await idle();
  assert.equal(state.runs.r0!.status, "settled");
  assert.deepEqual([state.runs.r1!.steered, state.runs.r1!.status, state.runs.r1!.submissionId], [undefined, "running", 9], "taken back from pi, then run as a message of its own");
  assert.deepEqual(steer.events, ["options r0", "submit r0", "submit r1:steer steer reject", "abort 8", "options r1", "submit r1"]);
});

test("view: a message that steered a run continues it, so the run's end shows once, after both", async () => {
  const state = toolState({ status: "interrupted", stopped: { by: "github:2" }, started: true, submissionId: 8, steered: "r0", startEntry: 2, sequence: 1 });
  state.runs.r0 = { ...state.runs.r1!, key: "r0", submissionId: 7, startEntry: 0, sequence: 0 };
  delete state.runs.r0.steered;
  state.branches = [{ id: 1, mode: "write" }];
  const entry = (id: number, role: string, text: string) => ({ id, conversationId: 1, kind: `pi.${role}`, model: [{ role, content: [{ type: "text", text }] }] });
  const source: ViewSource = {
    binding: { session: { id: "s1" }, owner: { id: "github:1", displayName: "Ada" } } as unknown as RunnerBinding,
    tunnel: () => undefined, metadata: async () => structuredClone(state),
    conversation: async () => ({ context: async () => ({ entries: [entry(1, "user", "go"), entry(2, "assistant", "working"), entry(3, "user", "also"), entry(4, "assistant", "done")], messages: [] }) }) as never,
    agent: async () => ({}) as never, context: () => undefined, repositories: () => undefined, extensions: async () => ({}),
  };
  const view = await sessionView(source);
  assert.deepEqual(view.entries.map(item => item.text), ["go", "working", "also", "done", "Stopped"]);
});

function availability(options: Partial<ToolAvailabilityOptions> = {}, answer?: Partial<WorkspaceExtensionsAnswer>, last?: Partial<WorkspaceExtensionsAnswer>) {
  const workspace: WorkspaceExtensionsAnswer = { extensions: [{ source: "piki:tunnel", enabled: true, tools: "approval", settings: {} }], automaticTools: false, ...answer } as WorkspaceExtensionsAnswer;
  return new ToolAvailability({
    binding: { session: { workspaceId: "w" }, owner: { id: "github:1" } } as unknown as RunnerBinding,
    config: { extensions: { workspace: async () => workspace, ...(last ? { lastKnown: () => ({ ...workspace, ...last }) } : {}) } },
    sandbox: { browser: undefined } as unknown as SessionWorkspace, onHost: false, definitions: () => [], toolNames: () => [],
    ...options,
  });
}

test("availability: why the browser or a tunnel isn't offered, from where the session runs and what the host has", () => {
  assert.equal(availability({ sandbox: { browser: {} } as never }).browserUnavailable(), undefined);
  assert.equal(availability({ onHost: true }).browserUnavailable(), "on-host");
  assert.equal(availability({ config: { sandboxBackend: { kind: "seatbelt" } as never } }).browserUnavailable(), "sandbox");
  assert.equal(availability().browserUnavailable(), undefined, "a host that doesn't say has no reason");
  assert.equal(availability({ config: { browserStatus: () => ({ state: "missing" }) as never } }).browserUnavailable(), "missing");
  assert.equal(availability().tunnelUnavailable(), undefined, "a host without tunnels has no reason to give");
  const tunnels = { status: () => undefined };
  assert.equal(availability({ config: { tunnels }, onHost: true }).tunnelUnavailable(), "on-host");
  assert.equal(availability({ config: { tunnels } }).tunnelUnavailable(), "sandbox", "only the Linux sandbox runs tunnels");
  assert.equal(availability({ config: { tunnels } }).tunnelOffered(), false);
  assert.equal(availability().linuxSandbox(), undefined);
  assert.deepEqual(availability().missingPrograms(new Set()), [], "outside the Linux sandbox nothing is missing");
  assert.equal(availability().programMissing({ programs: ["node"], path: "/usr/local/bin" }, "node"), undefined);
});

test("availability: a message runs the tools both its sender and the session's owner have, while the workspace keeps them on", async () => {
  const groups = { "github:1": { name: "Owners", off: ["github_merge"] }, "github:2": { name: "Guests", off: ["tunnel"] } };
  const tools = availability({}, { toolGroups: groups });
  assert.deepEqual([...await tools.sessionToolsOff()].sort(), ["github_merge"]);
  assert.deepEqual([...await tools.sessionToolsOff("github:2")].sort(), ["github_merge", "tunnel"]);
  assert.deepEqual([...await tools.sessionToolsOff("github:1")].sort(), ["github_merge"]);
  await tools.requireSenderTool("tunnel", "github:1");
  await tools.requireSenderTool("git", "github:2");
  await assert.rejects(tools.requireSenderTool("tunnel", "github:2"), (error: unknown) => error instanceof RunnerError && error.status === 403
    && /tunnel isn't among the tools of the person who sent this message \(Guests\)/.test(error.message));
  await assert.rejects(tools.requireSessionTool("github_merge"), /github_merge isn't among the tools of this session's owner \(Owners\)/);
  await tools.requireSessionTool("git");
  await assert.rejects(tools.requireOwnerTool("github_merge"), (error: unknown) => error instanceof RunnerError && error.status === 403
    && /github_merge isn't among the tools of this session's owner \(Owners\)/.test(error.message));
  await tools.requireOwnerTool("tunnel");
  const unheard = availability({ config: { extensions: { workspace: async () => ({ extensions: [], automaticTools: false }), lastKnown: () => undefined } } });
  await assert.rejects(unheard.requireOwnerTool("write"), /write isn't among the tools of this session's owner/, "a host that never heard the owner's group only reads");
  await unheard.requireOwnerTool("read");
  assert.equal(await tools.forgeWrites("github:1"), false, "an owner whose group leaves out github_merge gives no write credential to gh");
  const writers = availability({}, { toolGroups: { "github:2": { name: "Members", off: ["git_push", "github_comment"] } } });
  assert.equal(await writers.forgeWrites("github:1"), true);
  assert.equal(await writers.forgeWrites("github:2"), false, "nor does a sender whose group leaves out a GitHub writing tool");
  assert.equal(await writers.forgeWrites("github:3"), true);
  assert.equal(await unheard.forgeWrites("github:1"), false, "nor a host that never heard the groups");
  const off = availability({}, { extensions: [{ source: "piki:tunnel", enabled: false, tools: "approval", settings: {} }] as never });
  await assert.rejects(off.requireSessionTool("tunnel"), /tunnel is turned off in this workspace \(piki:tunnel\)/);
  const unknown = availability({ config: { extensions: { workspace: async () => ({ extensions: [], automaticTools: false }), lastKnown: () => undefined } } });
  assert.ok((await unknown.sessionToolsOff()).has("git"), "a connector that never heard its owner's group gives only the read tools");
  const heard = availability({}, { toolGroups: groups }, { toolGroups: groups });
  assert.deepEqual([...await heard.sessionToolsOff("github:2")].sort(), ["github_merge", "tunnel"], "once heard, the last answer's groups hold");
  assert.deepEqual([...await availability({ config: {} }).documentKindsOff()], []);
});

function instructions(input: Partial<InstructionsInput> = {}): string {
  return agentInstructions({ base: "Base.", agentTools: [], mode: "write", off: new Set(), browserUnavailable: undefined, tunnelUnavailable: undefined,
    kindsOff: new Set(), extensionTools: new Set(), clone: false, sandboxed: true, branch: "pikibun/work-1", cloneRepositories: [], lfsRepositories: [],
    cloneFailures: [], definitions: [], sources: [], conversationOnlyRestore: false, tools: [], missing: [], linuxSandbox: false, nodeBin: false, codemode: false,
    browser: false, ...input });
}

test("instructions: a plain session gets its agent's own and the mode's last words", () => {
  assert.equal(instructions(), "Base.");
  assert.match(instructions({ mode: "ask" }), /^Base\.\n\nThis is a read-only ask\./);
  assert.match(instructions({ mode: "read" }), /^Base\.\n\nThis request is read-only\./);
  assert.match(instructions({ conversationOnlyRestore: true }), /kept only its conversation/);
});

test("instructions: a clone session names its branch, repositories, LFS and the clones that couldn't come back", () => {
  const sandboxed = instructions({ clone: true, agentTools: ["git_push"], cloneRepositories: ["https://github.com/acme/app.git"],
    cloneFailures: [{ path: "app", reason: "gone" }], lfsRepositories: ["https://github.com/acme/app.git"] });
  assert.match(sandboxed, /isolated session worktree/);
  assert.match(sandboxed, /git push origin HEAD:pikibun\/work-1/);
  assert.match(sandboxed, /This workspace's repositories: https:\/\/github\.com\/acme\/app\.git\./);
  assert.ok(sandboxed.includes(lfsInstructions(["https://github.com/acme/app.git"])));
  assert.match(sandboxed, /could not be cloned again: app \(gone\)/);
  assert.match(sandboxed, /git_push \{directory, branch\}/);
  assert.doesNotMatch(instructions({ clone: true, agentTools: ["git_push"], off: new Set(["git_push"]) }), /git_push \{directory/);
  assert.doesNotMatch(instructions({ clone: true }), /git_push \{directory/);
  const host = instructions({ clone: true, sandboxed: false, agentTools: ["git_push"], cloneRepositories: ["https://github.com/acme/app.git"] });
  assert.match(host, /This host runs without a sandbox/);
  assert.doesNotMatch(host, /git_push|PIKIBUN_SESSION_BRANCH/);
  assert.equal(lfsInstructions([]), "");
});

test("instructions: tools add their lines only while on, and only outside an ask", () => {
  const tools = ["grep", "move_file", "git", "python", "browser", "tunnel", "github_read"];
  const all = instructions({ tools, browser: true, codemode: true });
  for (const line of [/use grep/, /use move_file/, /Run Git with the git tool/, /Run Python, pip/, /use the browser tool/, /use the tunnel tool/, /codemode script/]) {
    assert.match(all, line);
  }
  const ask = instructions({ tools, browser: true, codemode: true, mode: "ask" });
  assert.match(ask, /use grep/);
  for (const line of [/use move_file/, /git tool/, /python tool/, /browser tool/, /tunnel tool/, /codemode/]) assert.doesNotMatch(ask, line);
  assert.doesNotMatch(instructions({ tools, mode: "read" }), /tunnel tool/, "a read-only message isn't offered the tunnel");
  const off = instructions({ tools, browser: true, off: new Set(["git", "python", "browser", "tunnel"]), browserUnavailable: "missing", tunnelUnavailable: "missing" });
  for (const line of [/git tool/, /Run Python/, /use the browser tool/, /use the tunnel tool/]) assert.doesNotMatch(off, line);
  assert.match(off, /This session has no browser tool/);
  assert.match(off, /This session has no tunnel tool/);
});

test("instructions: a session whose sandbox has the host's Chromium is told where it is, and not to download another", () => {
  const said = /\$CHROME_BIN.*--no-sandbox.*Don't run playwright install/s;
  assert.match(instructions({ browser: true }), said, "whether or not the browser tool is on");
  assert.match(instructions({ browser: true, mode: "read" }), said);
  assert.doesNotMatch(instructions({ browser: true, mode: "ask" }), /CHROME_BIN/, "an ask runs nothing");
  assert.doesNotMatch(instructions({ browser: false, browserUnavailable: "missing" }), /CHROME_BIN/, "no browser, no word of one");
});

test("instructions: defined tools add theirs, sources fill a brokered tool's, and missing programs are told", () => {
  const node = bundledToolDefinitions.find(item => item.name === "node")!;
  const source = bundledToolDefinitions.find(item => item.name === "source_read")!;
  const sources = [{ id: "s1", title: "Docs", kind: "notion" as const, type: "page" }];
  const withSources = instructions({ definitions: [node, source], agentTools: ["source_read"], sources: sources as never, nodeBin: true, linuxSandbox: true,
    missing: [{ tool: "node", programs: ["yarn"] }] });
  assert.match(withSources, /"Docs" \(Notion page, source s1\)/);
  assert.match(withSources, new RegExp(`It runs Node\\.js ${process.versions.node.replaceAll(".", "\\.")}`));
  assert.doesNotMatch(withSources, /yarn and corepack, ahead/);
  assert.match(withSources, /Calls to them are refused before they run/);
  const withoutSources = instructions({ definitions: [source], agentTools: ["source_read"], sources: sources as never, kindsOff: new Set(["notion"]) });
  assert.doesNotMatch(withoutSources, /source s1/);
  assert.doesNotMatch(instructions({ definitions: [node], nodeBin: true, mode: "ask" }), /It runs Node/);
});
