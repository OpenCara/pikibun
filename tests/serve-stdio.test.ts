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
import { STDIO_FRAME } from "../apps/runner/src/app-host-protocol.js";
import type { ServerEvent } from "../packages/shared/src/app-server-protocol.js";
import { loadLocalState, peekLocalState } from "../apps/server/src/local/state.js";

const repository = fileURLToPath(new URL("../", import.meta.url));
const cli = join(repository, "packages/cli/src/cli.ts");
const github = { clientId: "Ov23liAbCdEf", clientSecret: "0123456789abcdef0123456789abcdef01234567" };

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

async function prepare(t: TestContext, saved?: typeof github) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "pikibun-serve-stdio-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const stateDir = join(home, "server");
  const web = join(home, "web");
  await mkdir(web);
  await writeFile(join(web, "index.html"), "<!doctype html><title>Pikibun</title>");
  await writeFile(join(web, "nsh.0123456789.wasm"), new Uint8Array([0, 97, 115, 109]));
  const port = await freePort();
  const { claimSecret } = await loadLocalState(stateDir, { port, ...(saved ? { github: saved } : {}) });
  return { home, stateDir, web, port, claimSecret };
}

test("pikibun serve --stdio runs the local server for the app: its GitHub app over stdin, its claim in its status, and stops with its stdin", { timeout: 60_000 }, async t => {
  if (process.platform === "win32") { t.skip("runs a POSIX state directory"); return; }
  const { home, stateDir, web, port, claimSecret } = await prepare(t);

  const server = await launch(home, stateDir, web);
  let closed = false;
  t.after(async () => { if (!closed) await server.close(); });

  const inspected = await server.request({ type: "inspect" });
  assert.ok(inspected.type === "result" && inspected.ok && inspected.inspection);
  assert.equal(inspected.inspection.stateDir, stateDir);
  assert.equal(inspected.inspection.port, port);
  assert.equal(inspected.inspection.githubClientId, undefined);

  const refused = await server.request({ type: "start" });
  assert.ok(refused.type === "result" && !refused.ok);
  assert.match(refused.error.message, /Add your GitHub OAuth app first/);
  const malformed = await server.request({ type: "start", github: { clientId: github.clientId } });
  assert.ok(malformed.type === "result" && !malformed.ok);
  assert.equal(malformed.error.message, "Refused a malformed request.");

  const before = server.events.length;
  const started = await server.request({ type: "start", github });
  assert.ok(started.type === "result" && started.ok, JSON.stringify(started));
  const origin = `http://127.0.0.1:${port}`;
  const running = await server.next(event => event.type === "status" && event.state === "running", before);
  assert.ok(running.type === "status");
  assert.equal(running.origin, origin);
  assert.equal(running.claim, claimSecret);
  assert.equal((await peekLocalState(stateDir))?.github?.clientSecret, github.clientSecret);
  assert.ok(!server.output.some(line => line.includes(github.clientSecret)), "the GitHub app's secret is never written out");

  const health = await (await fetch(`${origin}/api/health`)).json() as { localServer?: { claimed: boolean } };
  assert.deepEqual(health.localServer, { claimed: false });
  const native = await fetch(`${origin}/api/auth/native/start?challenge=${"c".repeat(43)}&state=app-state-0123456789&callback=page&claim=${claimSecret}`, { redirect: "manual" });
  assert.equal(native.status, 302);
  assert.equal(new URL(native.headers.get("location")!).origin, "https://github.com");
  assert.ok(native.headers.getSetCookie().some(cookie => cookie.startsWith(`local-claim=${claimSecret}`)));

  assert.ok(server.output.some(line => line.includes("This computer can't run sessions yet")), "this sandbox has no Pi models, so the server runs without its host");
  const claiming = server.events.length;
  const database = new DatabaseSync(join(stateDir, "pikibun.sqlite"));
  database.prepare(`INSERT INTO users (id, github_id, github_login, display_name, git_name, git_email, env_json, auth_kind, created_at)
    VALUES ('github:4242', '4242', 'octo', 'Octo', 'Octo', 'octo@example.test', '{}', 'github', ?)`).run(new Date().toISOString());
  database.close();
  const claimed = await server.next(event => event.type === "status" && event.state === "running", claiming);
  assert.ok(claimed.type === "status" && claimed.claim === undefined, "once someone owns it, its status carries no claim");

  const again = await server.request({ type: "start" });
  assert.ok(again.type === "result" && !again.ok);
  assert.match(again.error.message, /already running/);
  const saved = await server.request({ type: "inspect" });
  assert.ok(saved.type === "result" && saved.ok);
  assert.equal(saved.inspection?.githubClientId, github.clientId);

  const stopping = server.events.length;
  const stopped = await server.request({ type: "stop" });
  assert.ok(stopped.type === "result" && stopped.ok);
  await server.next(event => event.type === "status" && event.state === "stopped", stopping);
  await assert.rejects(fetch(`${origin}/api/health`));

  const restarted = await server.request({ type: "start" });
  assert.ok(restarted.type === "result" && restarted.ok, "a later start uses the saved GitHub app");
  closed = true;
  assert.equal(await server.close(), 0);
  await assert.rejects(fetch(`${origin}/api/health`));
});

test("a stop, or the end of stdin, while Pikibun is starting waits for the start, then stops it and releases its state", { timeout: 60_000 }, async t => {
  if (process.platform === "win32") { t.skip("runs a POSIX state directory"); return; }
  const { home, stateDir, web, port } = await prepare(t, github);
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
