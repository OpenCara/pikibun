import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { writeConnectorState } from "../apps/runner/src/connector.js";
import { unsandboxedWarning } from "../apps/runner/src/connect-setup.js";
import { STDIO_FRAME, type HostEvent } from "../apps/runner/src/app-host-protocol.js";
import { acquireRunnerLease } from "../apps/runner/src/lease.js";

const repository = fileURLToPath(new URL("../", import.meta.url));
const cli = join(repository, "packages/cli/src/cli.ts");
const pairing = { id: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed", code: "Z3AQnmLC6x9-xm2HZqXObhdMmKQhqLOKk3ST1ZuBYIw" };

async function launch(stateDir: string, home: string) {
  const child = spawn(process.execPath, ["--import", "tsx", cli, "host", "--stdio", "--state-dir", stateDir], {
    cwd: repository, stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) },
  });
  child.stderr.resume();
  const events: HostEvent[] = [];
  const waiters: { match: (event: HostEvent) => boolean; resolve: (event: HostEvent) => void; reject: (error: Error) => void }[] = [];
  let exited: Error | undefined;
  const exit = new Promise<number | null>(resolve => child.once("exit", code => {
    exited = new Error(`The host exited (code ${code})`);
    for (const waiter of waiters.splice(0)) waiter.reject(exited);
    resolve(code);
  }));
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", line => {
    if (!line.startsWith(STDIO_FRAME)) return;
    const event = JSON.parse(line.slice(STDIO_FRAME.length)) as HostEvent;
    events.push(event);
    for (const waiter of waiters.splice(0)) { if (waiter.match(event)) waiter.resolve(event); else waiters.push(waiter); }
  });
  const next = (match: (event: HostEvent) => boolean): Promise<HostEvent> => {
    const found = events.find(match);
    if (found) return Promise.resolve(found);
    if (exited) return Promise.reject(exited);
    const waiting = Promise.withResolvers<HostEvent>();
    waiters.push({ match, resolve: waiting.resolve, reject: waiting.reject });
    return waiting.promise;
  };
  await next(event => event.type === "ready");
  const write = (line: string) => child.stdin.write(`${line}\n`);
  const send = (value: unknown) => write(JSON.stringify(value));
  let id = 1000;
  const request = async (message: Record<string, unknown>) => {
    const requestId = id++;
    send({ ...message, id: requestId });
    return next(event => event.type === "result" && event.id === requestId);
  };
  const close = async () => {
    child.stdin.end();
    return exit;
  };
  return { events, next, request, close, send, write };
}

test("pikibun host --stdio speaks the host's protocol over stdin and stdout, and ends with its stdin", async t => {
  if (process.platform === "win32") { t.skip("runs a POSIX state directory"); return; }
  const home = await realpath(await mkdtemp(join(tmpdir(), "pikibun-host-cli-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const host = await launch("~/state", home);
  let closed = false;
  t.after(async () => { if (!closed) await host.close(); });
  const inspected = await host.request({ type: "inspect", allowFaux: true });
  assert.ok(inspected.type === "result" && inspected.ok && inspected.inspection);
  assert.equal(inspected.inspection.stateDir, join(home, "state"));
  assert.deepEqual(inspected.inspection.models.map(model => model.provider), ["faux"]);
  assert.equal(inspected.inspection.pairedServer, undefined);
  const start = await host.request({ type: "start", server: "https://pikibun.example", allowFaux: true, unsandboxedConsent: true });
  assert.equal(start.type === "result" && !start.ok ? start.error.code : undefined, "not-paired");
  closed = true;
  assert.equal(await host.close(), 0);
});

test("the host refuses malformed requests and reports what this machine would run", async t => {
  const stateDir = await realpath(await mkdtemp(join(tmpdir(), "pikibun-app-host-")));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const host = await launch(stateDir, stateDir);
  try {
    for (const malformed of [
      { type: "inspect", id: 1, extra: true },
      { type: "launch", id: 2 },
      { type: "start", id: 3 },
      { type: "start", id: 4, server: "https://pikibun.example", pairing: { id: "not-a-pairing-id", code: pairing.code } },
      { type: "start", id: 5, server: "https://pikibun.example", pairing: { ...pairing, code: "short" } },
      { type: "stop", id: -1 },
    ]) {
      host.send(malformed);
      if (malformed.id >= 0) assert.deepEqual(await host.next(event => event.type === "result" && event.id === malformed.id),
        { type: "result", id: malformed.id, ok: false, error: { code: "invalid-request", message: "The host refused a malformed request." } });
    }
    const isError = (event: HostEvent) => event.type === "log" && event.level === "error";
    await host.next(isError);
    for (const line of [JSON.stringify("not an object"), "not JSON"]) {
      const earlier = new Set(host.events);
      host.write(line);
      await host.next(event => isError(event) && !earlier.has(event));
    }

    const inspected = await host.request({ type: "inspect", allowFaux: true });
    assert.ok(inspected.type === "result" && inspected.ok && inspected.inspection);
    const inspection = inspected.inspection;
    assert.equal(inspection.stateDir, stateDir);
    assert.equal(inspection.pairedServer, undefined);
    assert.deepEqual(inspection.models.map(model => `${model.provider}/${model.modelId}`), ["faux/fixture"]);
    if (process.platform === "darwin") assert.equal(inspection.mode, "unsandboxed");
    assert.equal(inspection.unsandboxedWarning, inspection.mode === "unsandboxed" ? unsandboxedWarning() : undefined);
  } finally {
    await host.close();
  }
});

test("starting needs consent where unsandboxed, a pairing, and the paired server; the CLI's lease is reported as such", async t => {
  if (process.platform !== "darwin" && process.platform !== "linux") { t.skip("the connector runs on macOS and Linux"); return; }
  const stateDir = await realpath(await mkdtemp(join(tmpdir(), "pikibun-app-host-")));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const host = await launch(stateDir, stateDir);
  const start = (fields: Record<string, unknown>) => host.request({ type: "start", server: "http://127.0.0.1:9", allowFaux: true, allowInsecureLoopback: true, unsandboxedConsent: true, ...fields });
  const code = async (fields: Record<string, unknown>) => {
    const result = await start(fields);
    return result.type === "result" && !result.ok ? result.error.code : "ok";
  };
  try {
    const inspected = await host.request({ type: "inspect", allowFaux: true });
    if (inspected.type === "result" && inspected.ok && inspected.inspection?.mode === "unsandboxed") {
      assert.equal(await code({ unsandboxedConsent: false }), "consent-required");
    }
    assert.equal(await code({}), "not-paired");
    await writeConnectorState(stateDir, { connectorId: "app-host-test", token: "t".repeat(43), controlPlaneUrl: "http://127.0.0.1:9" }, true);
    assert.equal(await code({ pairing }), "already-paired");
    assert.equal(await code({ server: "http://127.0.0.1:10" }), "server-mismatch");

    const release = await acquireRunnerLease(stateDir, () => {});
    try {
      assert.equal(await code({}), "ok");
      const failed = await host.next(event => event.type === "failed");
      assert.ok(failed.type === "failed");
      assert.equal(failed.error.code, "lease-busy");
      assert.match(failed.error.message, /pikibun connect/);
      await host.next(event => event.type === "status" && event.state === "stopped");
    } finally { await release(); }
    assert.ok(!JSON.stringify(host.events).includes(pairing.code));
  } finally {
    await host.close();
  }
});

test("the host lists Pi's providers to sign in to, and answers only the sign-in under way", async t => {
  const stateDir = await realpath(await mkdtemp(join(tmpdir(), "pikibun-app-host-login-")));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const host = await launch(stateDir, stateDir);
  try {
    for (const malformed of [
      { type: "providers", id: 11, extra: true },
      { type: "login", id: 12, provider: "../anthropic", method: "oauth" },
      { type: "login", id: 13, provider: "anthropic", method: "password" },
      { type: "login-answer", id: 14, login: 1, prompt: 1 },
      { type: "login-cancel", id: 15 },
    ]) {
      host.send(malformed);
      assert.deepEqual(await host.next(event => event.type === "result" && event.id === malformed.id),
        { type: "result", id: malformed.id, ok: false, error: { code: "invalid-request", message: "The host refused a malformed request." } });
    }
    const listed = await host.request({ type: "providers" });
    assert.ok(listed.type === "result" && listed.ok && listed.providers, JSON.stringify(listed));
    assert.ok(listed.providers.length > 0);
    assert.ok(listed.providers.every(provider => !provider.signedIn && provider.methods.length > 0 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(provider.id)));
    for (const message of [{ type: "login-answer", login: 1, prompt: 1, value: "x" }, { type: "login-cancel", login: 1 }]) {
      const result = await host.request(message);
      assert.ok(result.type === "result" && !result.ok && result.error.code === "not-running", JSON.stringify(result));
    }
    const unknown = await host.request({ type: "login", provider: "no-such-provider", method: "oauth" });
    assert.deepEqual(unknown.type === "result" && !unknown.ok && unknown.error, { code: "failed", message: "This provider can't sign in that way here." });
  } finally {
    await host.close();
  }
});

test("pikibun host is only for the app: without --stdio it says to run pikibun connect, and --help explains it", () => {
  const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", cli, ...args], { cwd: repository, encoding: "utf8" });
  const bare = run("host");
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /run by the Pikibun app, over --stdio\. To connect this computer from a terminal, run "pikibun connect"/);
  const help = run("host", "--help");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage: pikibun host --stdio/);
  const unknown = run("host", "--stdio", "--bogus");
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown option/);
  assert.match(run("--help").stdout, /host {8}This computer's host for the Pikibun app/);
});
