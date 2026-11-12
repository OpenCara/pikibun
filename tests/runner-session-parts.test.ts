import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { EgressGrant, EgressRepository } from "../packages/shared/src/network.js";
import type { ApprovalRecord, AuthorizationResult, Operation } from "../packages/shared/src/types.js";
import { RunnerError } from "../apps/runner/src/protocol.js";
import { MIRROR_ROOT } from "../apps/runner/src/sandbox.js";
import { ApprovalWaits, boundedResult } from "../apps/runner/src/session/approval-waits.js";
import { BranchReports } from "../apps/runner/src/session/branch-reports.js";
import { CRASHED_TEXT, endView, refusedView } from "../apps/runner/src/session/entries.js";
import { HOST_COMMANDS_RULE, HostCommandPolicy, type HostCommandPolicyOptions } from "../apps/runner/src/session/host-commands.js";
import { defaultHostConfig } from "../packages/shared/src/host-config.js";
import { MessageInputs } from "../apps/runner/src/session/inputs.js";
import { MIRROR_CONFIRM_MS, refused, SessionMirrors } from "../apps/runner/src/session/mirrors.js";
import { MAX_STAGED_UPLOADS, SessionUploads, STALE_UPLOAD_MS } from "../apps/runner/src/session/uploads.js";
import { agentInstructions, lfsInstructions, type InstructionsInput } from "../apps/runner/src/session/instructions.js";
import { bundledToolDefinitions } from "../packages/shared/src/tool-definitions.js";
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

const card = (status: ApprovalRecord["status"], kind = "bash"): ApprovalRecord =>
  ({ id: "tool-1", sessionId: "s", requestedBy: "alice", createdAt: "2026-01-01T00:00:00Z", status, operation: { kind, command: "true" } } as unknown as ApprovalRecord);

test("a long result: the session keeps an excerpt, and its tool call gets the whole of it once it settles", () => {
  const waits = new ApprovalWaits();
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
  const { policy, asked } = hostPolicy({}, { "github:2": { hostCommands: "approve" }, "github:3": {} });
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
  const tools = ["search", "move_file", "git", "python", "browser", "tunnel", "github_read"];
  const all = instructions({ tools, browser: true, codemode: true });
  for (const line of [/use search/, /use move_file/, /Run Git with the git tool/, /Run Python, pip/, /use the browser tool/, /use the tunnel tool/, /codemode script/]) {
    assert.match(all, line);
  }
  const ask = instructions({ tools, browser: true, codemode: true, mode: "ask" });
  assert.match(ask, /use search/);
  for (const line of [/use move_file/, /git tool/, /python tool/, /browser tool/, /tunnel tool/, /codemode/]) assert.doesNotMatch(ask, line);
  assert.doesNotMatch(instructions({ tools, mode: "read" }), /tunnel tool/, "a read-only message isn't offered the tunnel");
  const off = instructions({ tools, browser: true, off: new Set(["git", "python", "browser", "tunnel"]), browserUnavailable: "missing", tunnelUnavailable: "missing" });
  for (const line of [/git tool/, /Run Python/, /use the browser tool/, /use the tunnel tool/]) assert.doesNotMatch(off, line);
  assert.match(off, /This session has no browser tool/);
  assert.match(off, /This session has no tunnel tool/);
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
