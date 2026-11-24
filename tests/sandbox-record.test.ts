import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256, signToken } from "../packages/shared/src/crypto.js";
import type { AuthorizationRequest, RunnerBinding, RunnerTicket } from "../packages/shared/src/types.js";
import { appUnsandboxedWarning, unsandboxedWarning } from "../apps/runner/src/connect-setup.js";
import { connectMain } from "../apps/runner/src/connect-cli.js";
import { RunnerError } from "../apps/runner/src/protocol.js";
import { assertSandboxKept, lastRan, LEFT_SANDBOX, RAN_FILE, recordRan, runsSandboxed } from "../apps/runner/src/sandbox-record.js";
import { createRunnerApp, RunnerService } from "../apps/runner/src/server.js";
import type { RunnerConfig } from "../apps/runner/src/session.js";
import { linuxSandboxMissing } from "./helpers/workspaces.js";

const SECRET = "sandbox-record-test-secret-not-a-production-secret";
const git = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
const hostMode = { skip: !["linux", "darwin"].includes(process.platform) || !git };

function binding(id: string): RunnerBinding {
  return {
    session: { id, workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1", title: "Sandbox", policyVersion: 1, status: "ready", createdAt: "2026-01-01T00:00:00Z", repositories: [] },
    owner: { id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice Owner", gitEmail: "alice@example.test", env: {}, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: "test:alice", workspaceId: "workspace", version: 1, name: "Agent", description: "", instructions: "Use tools.", tools: ["read_file"], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "workspace", name: "Explicit faux test provider", provider: "faux", modelId: "faux-1" },
  };
}

async function directory(t: TestContext, prefix: string): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function ticket(id: string, action: RunnerTicket["action"]): Promise<RunnerTicket> {
  const now = Math.floor(Date.now() / 1000);
  return { aud: "runner", sessionId: id, actorId: "test:alice", ownerId: "test:alice", action, policyVersion: 1, iat: now, exp: now + 60, jti: randomUUID(), bodyHash: await sha256("") };
}

async function service(t: TestContext, base: string, lines: string[], extra: Partial<RunnerConfig>): Promise<RunnerService> {
  const authorize = async (input: AuthorizationRequest) => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 });
  const runner = new RunnerService({ dataDir: base, sharedSecret: SECRET, controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, authorize, ...extra },
    line => { lines.push(line); });
  await runner.initialize();
  t.after(() => runner.close());
  return runner;
}

test("how a session runs follows its binding and its host, and is kept beside the binding only when it changes", async t => {
  assert.equal(runsSandboxed({ session: {} }, {}), true);
  assert.equal(runsSandboxed({ session: { hostEnvironment: true } }, {}), false, "a session its owner started on the host");
  assert.equal(runsSandboxed({ session: {} }, { unsandboxed: true }), false, "any session on a host without a sandbox");
  const base = await directory(t, "sandbox-record-");
  assert.equal(await lastRan(base), undefined, "a session from before the record has none");
  const first = await recordRan(base, true, undefined, new Date("2026-11-24T10:00:00Z"));
  assert.deepEqual(first, { record: { sandboxed: true, since: "2026-11-24T10:00:00.000Z" }, leftSandbox: false });
  const written = await readFile(join(base, RAN_FILE), "utf8");
  assert.deepEqual(await recordRan(base, true, undefined, new Date("2026-11-24T11:00:00Z")), first, "nothing is written while it runs the same way");
  assert.equal(await readFile(join(base, RAN_FILE), "utf8"), written);
  const left = await recordRan(base, false, undefined, new Date("2026-11-24T12:00:00Z"));
  assert.deepEqual(left, { record: { sandboxed: false, since: "2026-11-24T12:00:00.000Z", leftSandboxAt: "2026-11-24T12:00:00.000Z" }, leftSandbox: true });
  assert.deepEqual(await lastRan(base), left.record);
  assert.deepEqual((await recordRan(base, true, undefined, new Date("2026-11-24T13:00:00Z"))).record, { sandboxed: true, since: "2026-11-24T13:00:00.000Z" });
  for (const broken of ["{\"sandboxed\":\"yes\"}", "not json", " ".repeat(2000)]) {
    await writeFile(join(base, RAN_FILE), broken);
    const unreadable = await lastRan(base);
    assert.deepEqual(unreadable, { sandboxed: true, since: "", unreadable: true }, "a record that is there but can't be read counts as sandboxed");
    assert.throws(() => assertSandboxKept(unreadable, false, false), RunnerError);
  }
  assert.deepEqual((await recordRan(base, true, undefined, new Date("2026-11-24T14:00:00Z"))).record, { sandboxed: true, since: "2026-11-24T14:00:00.000Z" },
    "and is written again by the next open");

  assert.doesNotThrow(() => assertSandboxKept(undefined, false, false));
  assert.doesNotThrow(() => assertSandboxKept({ sandboxed: false, since: "x" }, false, false));
  assert.doesNotThrow(() => assertSandboxKept({ sandboxed: true, since: "x" }, true, false));
  assert.doesNotThrow(() => assertSandboxKept({ sandboxed: false, since: "x" }, true, false), "into the sandbox needs nobody's word");
  assert.doesNotThrow(() => assertSandboxKept({ sandboxed: true, since: "x" }, false, true));
  assert.throws(() => assertSandboxKept({ sandboxed: true, since: "x" }, false, false), (error: unknown) => error instanceof RunnerError && error.status === 422 && error.message === LEFT_SANDBOX);
  assert.match(LEFT_SANDBOX, /^[\w .,:'()-]{1,300}$/, "the Pikibun server passes the reason on only in these characters");
  assert.match(LEFT_SANDBOX, /--sessions-leave-sandbox/);
});

test("a session that last ran in the sandbox isn't opened by a host without one, until the host is started to allow it", hostMode, async t => {
  const base = await directory(t, "sandbox-left-");
  const lines: string[] = [];
  const first = await service(t, base, lines, { unsandboxed: true });
  const session = await first.provision(binding("kept"), await ticket("kept", "create"));
  assert.deepEqual({ ...await lastRan(session.directory), since: "" }, { sandboxed: false, since: "" }, "how it ran is recorded when it opens");
  await first.close();
  await recordRan(session.directory, true);

  const second = await service(t, base, lines, { unsandboxed: true });
  await assert.rejects(second.get("kept"), (error: unknown) => error instanceof RunnerError && error.status === 422 && error.message === LEFT_SANDBOX);
  const app = createRunnerApp(second);
  const refused = await app.request("/v1/sessions/kept/view", { headers: { authorization: `Bearer ${await signToken(await ticket("kept", "view"), SECRET)}` } });
  assert.equal(refused.status, 422);
  assert.deepEqual(await refused.json(), { error: LEFT_SANDBOX });
  assert.deepEqual(lines, [`Session kept wasn't opened: ${LEFT_SANDBOX}`], "the host says so, once");
  assert.equal((await lastRan(session.directory))?.sandboxed, true, "a refusal leaves the record as it was");
  await second.close();

  const third = await service(t, base, lines, { unsandboxed: true, sessionsLeaveSandbox: true });
  const opened = await third.get("kept");
  assert.equal(opened.binding.session.id, "kept");
  const record = await lastRan(session.directory);
  assert.equal(record?.sandboxed, false);
  assert.equal(record?.leftSandboxAt, record?.since, "when it left the sandbox is kept");
  assert.equal(lines.length, 2);
  assert.match(lines[1]!, /^Session kept: it last ran in the sandbox and now runs directly on this computer/);
  await third.close();

  const fourth = await service(t, base, lines, { unsandboxed: true });
  assert.equal((await fourth.get("kept")).binding.session.id, "kept", "once it ran without the sandbox, it opens there again");
  assert.equal(lines.length, 2);
  await fourth.close();

  await rm(join(session.directory, RAN_FILE));
  await mkdir(join(session.directory, RAN_FILE));
  const fifth = await service(t, base, [], { unsandboxed: true });
  await assert.rejects(fifth.get("kept"), (error: unknown) => error instanceof RunnerError && error.status === 422, "a record that can't be read doesn't open it without the sandbox");
  await fifth.close();
  const sixth = await service(t, base, [], { unsandboxed: true, sessionsLeaveSandbox: true });
  await assert.rejects(sixth.get("kept"), (error: unknown) => !(error instanceof RunnerError), "and a session whose record can't be written isn't opened");
});

test("a session provisioned in the Linux sandbox is recorded as sandboxed, and a host without one refuses it", { skip: linuxSandboxMissing() }, async t => {
  const base = await directory(t, "sandbox-real-");
  const lines: string[] = [];
  const sandboxed = await service(t, base, lines, {});
  const session = await sandboxed.provision(binding("boxed"), await ticket("boxed", "create"));
  assert.equal((await lastRan(session.directory))?.sandboxed, true);
  await sandboxed.close();
  const bare = await service(t, base, lines, { unsandboxed: true });
  await assert.rejects(bare.get("boxed"), (error: unknown) => error instanceof RunnerError && error.status === 422);
  await bare.close();
  const again = await service(t, base, lines, {});
  assert.equal((await again.get("boxed")).binding.session.id, "boxed", "the sandbox still opens it");
});

test("the app's consent names the sessions that leave the sandbox, and the command line takes its flag only with --unsafe-no-sandbox", async () => {
  assert.ok(appUnsandboxedWarning().startsWith(unsandboxedWarning().trimEnd()));
  assert.match(appUnsandboxedWarning(), /Sessions on this machine that last ran in a sandbox are opened too, and run this way from then on\.\n\n$/);
  await assert.rejects(connectMain(["--sessions-leave-sandbox"]), /--sessions-leave-sandbox goes with --unsafe-no-sandbox/);
});
