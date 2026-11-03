import test from "node:test";
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeConnectorState } from "../apps/runner/src/connector.js";
import { unsandboxedWarning } from "../apps/runner/src/connect-setup.js";
import type { HostEvent } from "../apps/runner/src/desktop-protocol.js";
import { acquireRunnerLease } from "../apps/runner/src/lease.js";

const repository = fileURLToPath(new URL("../", import.meta.url));
const pairing = { id: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed", code: "Z3AQnmLC6x9-xm2HZqXObhdMmKQhqLOKk3ST1ZuBYIw" };

/** The desktop host over Node's fork channel, the same protocol Electron's utilityProcess carries. */
async function launch(stateDir: string) {
  const child: ChildProcess = fork(join(repository, "apps/runner/src/desktop-host.ts"), ["--state-dir", stateDir], {
    cwd: repository, execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"],
    // Never the developer's Pi configuration: fixture mode reads none, and nothing else may leak in.
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: stateDir },
  });
  const events: HostEvent[] = [];
  const waiters: { match: (event: HostEvent) => boolean; resolve: (event: HostEvent) => void; reject: (error: Error) => void }[] = [];
  // A host that dies fails whatever the test waits for, instead of leaving it waiting forever.
  let exited: Error | undefined;
  child.once("exit", code => {
    exited = new Error(`The host exited (code ${code})`);
    for (const waiter of waiters.splice(0)) waiter.reject(exited);
  });
  child.on("message", value => {
    const event = value as HostEvent;
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
  // Clear of the ids the tests send by hand.
  let id = 1000;
  const request = async (message: Record<string, unknown>) => {
    const requestId = id++;
    child.send({ ...message, id: requestId });
    return next(event => event.type === "result" && event.id === requestId);
  };
  const close = async () => {
    const exited = Promise.withResolvers<void>();
    child.once("exit", () => exited.resolve());
    child.disconnect();
    await exited.promise;
  };
  return { child, events, next, request, close, send: (value: unknown) => child.send(value as never) };
}

test("the desktop host refuses malformed requests and reports what this machine would run", async () => {
  // The connector insists on a canonical, symlink-free state path (macOS's tmpdir is behind /var -> /private/var).
  const stateDir = await realpath(await mkdtemp(join(tmpdir(), "pikibun-desktop-host-")));
  const host = await launch(stateDir);
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
    // Requests without a usable id, and payloads that aren't requests at all, are logged rather than answered.
    const isError = (event: HostEvent) => event.type === "log" && event.level === "error";
    await host.next(isError);
    const earlier = new Set(host.events);
    host.send("not an object");
    await host.next(event => isError(event) && !earlier.has(event));

    const inspected = await host.request({ type: "inspect", allowFaux: true });
    assert.ok(inspected.type === "result" && inspected.ok && inspected.inspection);
    const inspection = inspected.inspection;
    assert.equal(inspection.stateDir, stateDir);
    assert.equal(inspection.pairedServer, undefined);
    assert.deepEqual(inspection.models.map(model => `${model.provider}/${model.modelId}`), ["faux/fixture"]);
    if (process.platform === "darwin") assert.equal(inspection.mode, "unsandboxed");
    // The consent dialog shows the CLI's own words, exactly.
    assert.equal(inspection.unsandboxedWarning, inspection.mode === "unsandboxed" ? unsandboxedWarning() : undefined);
  } finally {
    await host.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("starting needs consent where unsandboxed, a pairing, and the paired server; the CLI's lease is reported as such", async t => {
  if (process.platform !== "darwin" && process.platform !== "linux") { t.skip("the connector runs on macOS and Linux"); return; }
  const stateDir = await realpath(await mkdtemp(join(tmpdir(), "pikibun-desktop-host-")));
  const host = await launch(stateDir);
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
    await writeConnectorState(stateDir, { connectorId: "desktop-test", token: "t".repeat(43), controlPlaneUrl: "http://127.0.0.1:9" }, true);
    assert.equal(await code({ pairing }), "already-paired");
    assert.equal(await code({ server: "http://127.0.0.1:10" }), "server-mismatch");

    // Another connector (here: this test, as `pikibun connect` would) holds the state directory's lease.
    const release = await acquireRunnerLease(stateDir, () => {});
    try {
      assert.equal(await code({}), "ok");
      const failed = await host.next(event => event.type === "failed");
      assert.ok(failed.type === "failed");
      assert.equal(failed.error.code, "lease-busy");
      assert.match(failed.error.message, /pikibun connect/);
      await host.next(event => event.type === "status" && event.state === "stopped");
    } finally { await release(); }
    // Nothing in the protocol stream ever carried the pairing code back.
    assert.ok(!JSON.stringify(host.events).includes(pairing.code));
  } finally {
    await host.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("the desktop host lists Pi's providers to sign in to, and answers only the sign-in under way", async () => {
  const stateDir = await realpath(await mkdtemp(join(tmpdir(), "pikibun-desktop-host-login-")));
  const host = await launch(stateDir);
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
    // A fresh Pi configuration (HOME is the state directory): providers to sign in to, none signed in yet.
    const listed = await host.request({ type: "providers" });
    assert.ok(listed.type === "result" && listed.ok && listed.providers, JSON.stringify(listed));
    assert.ok(listed.providers.length > 0);
    assert.ok(listed.providers.every(provider => !provider.signedIn && provider.methods.length > 0 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(provider.id)));
    // Nothing to answer or cancel while nothing signs in; a provider without that sign-in is refused before it starts.
    for (const message of [{ type: "login-answer", login: 1, prompt: 1, value: "x" }, { type: "login-cancel", login: 1 }]) {
      const result = await host.request(message);
      assert.ok(result.type === "result" && !result.ok && result.error.code === "not-running", JSON.stringify(result));
    }
    const unknown = await host.request({ type: "login", provider: "no-such-provider", method: "oauth" });
    assert.deepEqual(unknown.type === "result" && !unknown.ok && unknown.error, { code: "failed", message: "This provider can't sign in that way here." });
  } finally {
    await host.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
