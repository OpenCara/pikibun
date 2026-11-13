import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256, signToken } from "../packages/shared/src/crypto.js";
import type { RunnerAction, RunnerTicket } from "../packages/shared/src/types.js";
import { describeFailure, FailureLog } from "../apps/runner/src/failure-log.js";
import { createRunnerApp, RunnerService } from "../apps/runner/src/server.js";
import { bubblewrapFix, bubblewrapPrerequisite, assertPrerequisites } from "../apps/runner/src/connect-setup.js";
import { failedRequests } from "../apps/server/src/log.js";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv, Env } from "../apps/server/src/types.js";

const SECRET = "failure-logs-test-secret-not-a-production-secret";

async function directory(t: TestContext, prefix: string): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function ticket(id: string, action: RunnerAction, body = ""): Promise<RunnerTicket> {
  const now = Math.floor(Date.now() / 1000);
  return { aud: "runner", sessionId: id, actorId: "test:alice", ownerId: "test:alice", action, policyVersion: 1, iat: now, exp: now + 60, jti: randomUUID(), bodyHash: await sha256(body) };
}

test("the failure log writes an error with its stack and cause, and the same line at most once a minute", () => {
  const lines: string[] = [];
  let now = 0;
  const log = new FailureLog(line => { lines.push(line); }, 60_000, () => now);
  const error = new Error("disk\nfull", { cause: new Error("EIO") });
  log.report("Session s1 couldn't open", error);
  log.report("Session s1 couldn't open", error);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^Session s1 couldn't open: Error: disk full\n {4}at /);
  assert.match(lines[0]!, /\nCaused by: Error: EIO/);
  log.report("Session s2 couldn't open", error);
  now = 60_000;
  log.report("Session s1 couldn't open", error);
  assert.equal(lines.length, 3);
  assert.equal(describeFailure("plain\u0000text"), "plain text");
});

test("the runner logs a session that fails to open on its host, once, and answers the server without the details", async t => {
  const base = await directory(t, "failure-logs-");
  const lines: string[] = [];
  const service = new RunnerService({ dataDir: base, sharedSecret: SECRET, controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, unsandboxed: true,
    authorize: async input => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }) }, line => { lines.push(line); });
  await service.initialize();
  t.after(() => service.close());
  await mkdir(join(base, "sessions", "broken", "binding.json"), { recursive: true });
  const app = createRunnerApp(service);
  const view = async () => app.request("/v1/sessions/broken/view", { headers: { authorization: `Bearer ${await signToken(await ticket("broken", "view"), SECRET)}` } });
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await view();
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "Runner operation failed" });
  }
  assert.equal(lines.length, 1, lines.join("\n---\n"));
  assert.match(lines[0]!, /^Session broken couldn't open: Error: EISDIR/);
  const missing = await app.request("/v1/sessions/missing/view", { headers: { authorization: `Bearer ${await signToken(await ticket("missing", "view"), SECRET)}` } });
  assert.equal(missing.status, 404);
  assert.equal(lines.length, 1, "a session that isn't there is no failure");
});

test("the server logs each 5xx answer with its route, code, time and session, and an unexpected error's stack", async () => {
  const lines: string[] = [];
  const app = new Hono<AppEnv>();
  app.use("*", failedRequests);
  app.onError((error, c) => error instanceof HTTPException ? error.getResponse() : c.json({ error: "The request could not be completed.", code: "internal_error" }, 500));
  app.get("/api/sessions/:id/view", () => { throw new HTTPException(500, { res: Response.json({ error: "The connector could not complete the operation.", code: "runner_error" }, { status: 500 }) }); });
  app.get("/api/sessions/:id/files", () => { throw new TypeError("boom"); });
  app.get("/api/sessions/:id/busy", () => { throw new HTTPException(409, { res: Response.json({ error: "Busy", code: "session_busy" }, { status: 409 }) }); });
  const env = { LOG: (line: string) => { lines.push(line); } } as Env;
  assert.equal((await app.request("/api/sessions/abc/view", {}, env)).status, 500);
  assert.match(lines[0]!, /^GET \/api\/sessions\/:id\/view 500 runner_error \d+ms session=abc: The connector could not complete the operation\.$/);
  assert.equal((await app.request("/api/sessions/abc/files", {}, env)).status, 500);
  assert.match(lines[1]!, /^GET \/api\/sessions\/:id\/files 500 internal_error \d+ms session=abc: The request could not be completed\.$/);
  assert.match(lines[2]!, /^GET \/api\/sessions\/:id\/files failed unexpectedly: TypeError: boom\n/);
  assert.equal((await app.request("/api/sessions/abc/busy", {}, env)).status, 409);
  assert.equal(lines.length, 3, "only 5xx answers");
});

test("the connector refuses to start where bubblewrap is installed but can't make the sandbox, and says how to fix it", () => {
  const works = bubblewrapPrerequisite({ run: () => ({ status: 0, stderr: "" }), sysctl: () => undefined });
  assert.deepEqual(works, { name: "bubblewrap can make the sandbox", ok: true });
  const apparmor = bubblewrapPrerequisite({ run: () => ({ status: 1, stderr: "bwrap: setting up uid map: Permission denied\n" }),
    sysctl: name => (name === "kernel.apparmor_restrict_unprivileged_userns" ? "1" : undefined) });
  assert.equal(apparmor.ok, false);
  assert.equal(apparmor.name, "bubblewrap can make the sandbox (it can't here: bwrap: setting up uid map: Permission denied)");
  assert.equal(apparmor.fix?.command, "sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0");
  assert.equal(bubblewrapFix(name => (name === "kernel.unprivileged_userns_clone" ? "0" : undefined)).command, "sudo sysctl -w kernel.unprivileged_userns_clone=1");
  assert.equal(bubblewrapFix(name => (name === "user.max_user_namespaces" ? "0" : undefined)).command, "sudo sysctl -w user.max_user_namespaces=15000");
  assert.equal(bubblewrapFix(() => undefined).command, undefined);
  const old = bubblewrapPrerequisite({ run: () => ({ status: 1, stderr: "bwrap: Unknown option --disable-userns" }), sysctl: () => "1" });
  assert.match(old.fix!.text, /0\.8 or newer/);
  assert.throws(() => assertPrerequisites([{ name: "bubblewrap (/usr/bin/bwrap)", ok: true }, apparmor], false, " Without bubblewrap you can run --unsafe-no-sandbox instead."),
    (error: Error) => error.message.startsWith("Missing prerequisites: bubblewrap can make the sandbox (it can't here: bwrap: setting up uid map: Permission denied). AppArmor stops bubblewrap")
      && error.message.includes("(sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0)") && error.message.endsWith("--unsafe-no-sandbox instead."));
});
