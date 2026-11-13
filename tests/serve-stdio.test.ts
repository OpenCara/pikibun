import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { STDIO_FRAME } from "../packages/shared/src/app-host-protocol.js";
import type { ServerEvent } from "../packages/shared/src/app-server-protocol.js";
import { loadLocalState } from "../apps/server/src/local/state.js";

const repository = fileURLToPath(new URL("../", import.meta.url));
const cli = join(repository, "packages/cli/src/cli.ts");

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function launch(home: string, stateDir: string, staticDir: string) {
  const child = spawn(process.execPath, ["--import", "tsx", cli, "serve", "--stdio", "--state-dir", stateDir, "--static-dir", staticDir], {
    cwd: repository, stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) },
  });
  const output: string[] = [];
  createInterface({ input: child.stderr, crlfDelay: Infinity }).on("line", line => output.push(line));
  const events: ServerEvent[] = [];
  const waiters: { match: (event: ServerEvent) => boolean; resolve: (event: ServerEvent) => void; reject: (error: Error) => void }[] = [];
  let exited: Error | undefined;
  const exit = new Promise<number | null>(resolve => child.once("exit", code => {
    exited = new Error(`pikibun serve --stdio exited (code ${code}): ${output.join("\n")}`);
    for (const waiter of waiters.splice(0)) waiter.reject(exited);
    resolve(code);
  }));
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", line => {
    output.push(line);
    if (!line.startsWith(STDIO_FRAME)) return;
    const event = JSON.parse(line.slice(STDIO_FRAME.length)) as ServerEvent;
    events.push(event);
    for (const waiter of waiters.splice(0)) { if (waiter.match(event)) waiter.resolve(event); else waiters.push(waiter); }
  });
  const next = (match: (event: ServerEvent) => boolean, after = 0): Promise<ServerEvent> => {
    const found = events.slice(after).find(match);
    if (found) return Promise.resolve(found);
    if (exited) return Promise.reject(exited);
    const waiting = Promise.withResolvers<ServerEvent>();
    waiters.push({ match, resolve: waiting.resolve, reject: waiting.reject });
    return waiting.promise;
  };
  await next(event => event.type === "ready");
  let id = 1;
  const request = (message: Record<string, unknown>) => {
    const requestId = id++;
    child.stdin.write(`${JSON.stringify({ ...message, id: requestId })}\n`);
    return next(event => event.type === "result" && event.id === requestId);
  };
  const close = () => { if (!child.stdin.writableEnded) child.stdin.end(); if (child.exitCode === null && child.signalCode === null) setTimeout(() => child.kill("SIGKILL"), 20_000).unref(); return exit; };
  return { events, output, next, request, close, write: (line: string) => child.stdin.write(`${line}\n`) };
}

async function prepare(t: TestContext) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "pikibun-serve-stdio-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const stateDir = join(home, "server");
  const web = join(home, "web");
  await mkdir(web);
  await writeFile(join(web, "index.html"), "<!doctype html><title>Pikibun</title>");
  await writeFile(join(web, "nsh.0123456789.wasm"), new Uint8Array([0, 97, 115, 109]));
  const port = await freePort();
  const { claimSecret } = await loadLocalState(stateDir, { port });
  return { home, stateDir, web, port, claimSecret };
}

test("pikibun serve --stdio runs the local server for the app: no GitHub app, its sign-in token in its status, and stops with its stdin", { timeout: 60_000 }, async t => {
  if (process.platform === "win32") { t.skip("runs a POSIX state directory"); return; }
  const { home, stateDir, web, port, claimSecret } = await prepare(t);

  const server = await launch(home, stateDir, web);
  let closed = false;
  t.after(async () => { if (!closed) await server.close(); });

  const inspected = await server.request({ type: "inspect" });
  assert.ok(inspected.type === "result" && inspected.ok && inspected.inspection);
  assert.equal(inspected.inspection.stateDir, stateDir);
  assert.equal(inspected.inspection.port, port);
  assert.ok(!("githubClientId" in inspected.inspection));

  const malformed = await server.request({ type: "start", github: { clientId: "Ov23liAbCdEf", clientSecret: "0123456789abcdef0123456789abcdef01234567" } });
  assert.ok(malformed.type === "result" && !malformed.ok);
  assert.equal(malformed.error.message, "Refused a malformed request.");

  const before = server.events.length;
  const started = await server.request({ type: "start" });
  assert.ok(started.type === "result" && started.ok, JSON.stringify(started));
  const origin = `http://127.0.0.1:${port}`;
  const running = await server.next(event => event.type === "status" && event.state === "running", before);
  assert.ok(running.type === "status");
  assert.equal(running.origin, origin);
  assert.match(running.signInToken ?? "", /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(running.signInToken, claimSecret, "the token is made at this start, not kept in the state file");
  assert.ok(!server.output.some(line => !line.startsWith(STDIO_FRAME) && line.includes(running.signInToken!)), "the sign-in token goes only to the app, in its status");

  const health = async () => await (await fetch(`${origin}/api/health`)).json() as { githubConfigured?: boolean; localServer?: { claimed: boolean } };
  assert.deepEqual([(await health()).githubConfigured, (await health()).localServer], [false, { claimed: false }]);
  assert.equal((await fetch(`${origin}/api/auth/github`, { redirect: "manual" })).status, 503);

  assert.ok(server.output.some(line => line.includes("This computer can't run sessions yet")), "this sandbox has no Pi models, so the server runs without its host");
  const signedIn = await fetch(`${origin}/api/auth/native/local`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: running.signInToken, deviceName: "Pikibun NSH (macos)" }) });
  assert.equal(signedIn.status, 200);
  const { token, user } = await signedIn.json() as { token: string; user: { id: string } };
  assert.match(user.id, /^password:[a-z0-9][a-z0-9_-]{2,38}$/);
  assert.equal((await fetch(`${origin}/api/me`, { headers: { Authorization: `Bearer ${token}` } })).status, 200);
  assert.deepEqual((await health()).localServer, { claimed: true });
  const database = new DatabaseSync(join(stateDir, "pikibun.sqlite"));
  assert.deepEqual(database.prepare("SELECT id FROM users").all().map(row => row.id), [user.id]);
  database.close();

  const again = await server.request({ type: "start" });
  assert.ok(again.type === "result" && !again.ok);
  assert.match(again.error.message, /already running/);

  const stopping = server.events.length;
  const stopped = await server.request({ type: "stop" });
  assert.ok(stopped.type === "result" && stopped.ok);
  await server.next(event => event.type === "status" && event.state === "stopped", stopping);
  await assert.rejects(fetch(`${origin}/api/health`));

  const restarted = await server.request({ type: "start" });
  assert.ok(restarted.type === "result" && restarted.ok, "it starts again");
  closed = true;
  assert.equal(await server.close(), 0);
  await assert.rejects(fetch(`${origin}/api/health`));
});

test("a stop, or the end of stdin, while Pikibun is starting waits for the start, then stops it and releases its state", { timeout: 60_000 }, async t => {
  if (process.platform === "win32") { t.skip("runs a POSIX state directory"); return; }
  const { home, stateDir, web, port } = await prepare(t);
  const origin = `http://127.0.0.1:${port}`;

  const first = await launch(home, stateDir, web);
  t.after(() => first.close());
  const [started, stopped] = await Promise.all([first.request({ type: "start" }), first.request({ type: "stop" })]);
  assert.ok(started.type === "result" && started.ok, JSON.stringify(started));
  assert.ok(stopped.type === "result" && stopped.ok, JSON.stringify(stopped));
  assert.equal(first.events.filter(event => event.type === "status").at(-1)?.type === "status" && (first.events.filter(event => event.type === "status").at(-1) as { state: string }).state, "stopped");
  await assert.rejects(fetch(`${origin}/api/health`));

  first.write(JSON.stringify({ type: "start", id: 99 }));
  assert.equal(await first.close(), 0);
  await assert.rejects(fetch(`${origin}/api/health`));

  const second = await launch(home, stateDir, web);
  t.after(() => second.close());
  const again = await second.request({ type: "start" });
  assert.ok(again.type === "result" && again.ok, `the state's lease was released: ${JSON.stringify(again)}`);
  assert.equal((await fetch(`${origin}/api/health`)).status, 200);
});
