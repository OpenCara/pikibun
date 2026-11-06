import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseHostTunnelConfig, parseHostTunnelStatus, parseSessionTunnelReport, quickTunnelUrl, serviceOutputLimits, tunnelUnavailableReason,
  tunnelUnavailableText, validTunnelUrl, type SessionTunnelReport } from "../packages/shared/src/tunnel.js";
import { tunnelRequest } from "../apps/runner/src/tunnel-command.js";
import { SERVICE_MARK, SessionService, serviceLimits, serviceShellCommand, type ServiceExit, type ServiceProcess } from "../apps/runner/src/session-service.js";
import { SessionTunnel } from "../apps/runner/src/session/tunnel.js";
import { HostTunnels, HostTunnelSource, NO_ADDRESS, type QuickTunnel } from "../apps/runner/src/tunnel-host.js";
import { cloudflaredAsset, downloadedCloudflareds, latestCloudflared } from "../apps/runner/src/cloudflared.js";
import { SERVICE_DRIVER } from "../apps/runner/src/sandbox-python.generated.js";
import { fakeCloudflared } from "./helpers/fake-cloudflared.js";
import { python } from "./helpers/workspaces.js";
import { decidedAsHostCommand, requesterAutoApproves } from "../packages/shared/src/host-operations.js";
import { extensionToolNotice } from "../packages/client/src/host-commands.js";

async function directory(t: { after: (fn: () => Promise<void>) => void }, name: string): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), `pikibun-${name}-`)));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

/** A Unix socket path short enough for the 107-byte limit wherever the test's temporary directory is: relative to here. */
function shortSocket(path: string): string {
  const short = relative(process.cwd(), path);
  return short.length < path.length ? short : path;
}

async function until<T>(read: () => T | undefined, what: string, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await delay(20);
  }
}

test("a quick tunnel's address is read from cloudflared's own lines, never api.trycloudflare.com", () => {
  assert.equal(quickTunnelUrl("2026-01-01T00:00:00Z INF |  https://bright-river-fox.trycloudflare.com                    |"), "https://bright-river-fox.trycloudflare.com");
  assert.equal(quickTunnelUrl('ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": EOF'), undefined);
  assert.equal(quickTunnelUrl('Post "https://api.trycloudflare.com/tunnel" then https://two-words.trycloudflare.com'), "https://two-words.trycloudflare.com");
  for (const line of ["https://evil.trycloudflare.com.example.com", "http://plain.trycloudflare.com", "https://a_b.trycloudflare.com", "INF Registered tunnel connection", ""]) {
    assert.equal(quickTunnelUrl(line), undefined, line);
  }
  assert.ok(validTunnelUrl("https://bright-river-fox.trycloudflare.com"));
  for (const url of ["https://api.trycloudflare.com", "https://x.trycloudflare.com/path", "https://example.com", "http://x.trycloudflare.com", 5]) assert.ok(!validTunnelUrl(url), String(url));
});

test("a host's tunnel setting and status are checked as the browser's are; a session's reason to have none is a fixed one", () => {
  for (const config of [{ source: "auto" }, { source: "download" }, { source: "off" }, { source: "path", path: "/usr/local/bin/cloudflared" }]) assert.deepEqual(parseHostTunnelConfig(config), config);
  for (const invalid of [null, "auto", { source: "elsewhere" }, { source: "path" }, { source: "path", path: "cloudflared" }, { source: "auto", path: "/x" },
    { source: "path", path: "/x\n--token" }, { source: "auto", token: "secret" }]) {
    assert.throws(() => parseHostTunnelConfig(invalid), /tunnel setting|cloudflared/, JSON.stringify(invalid));
  }
  const status = { source: "auto", state: "ready", executable: "/usr/local/bin/cloudflared", version: "2026.1.0", downloadable: true };
  assert.deepEqual(parseHostTunnelStatus(status), status);
  for (const invalid of [{ ...status, state: "online" }, { ...status, extra: 1 }, { ...status, error: "x".repeat(1025) }, { ...status, downloadable: "yes" }]) {
    assert.throws(() => parseHostTunnelStatus(invalid), /Invalid tunnel status/);
  }
  assert.equal(tunnelUnavailableReason("ready"), undefined);
  assert.equal(tunnelUnavailableReason("unsupported"), "sandbox");
  assert.equal(tunnelUnavailableReason("missing"), "missing");
  assert.match(tunnelUnavailableText("off"), /refuses tunnels/);
  assert.match(tunnelUnavailableText("nonsense"), /can't put a server online/);
});

test("a session's tunnel report names a quick tunnel's address and why it stopped, or is refused", () => {
  assert.deepEqual(parseSessionTunnelReport({ sessionId: "s1", event: "started", url: "https://a-b.trycloudflare.com", actorId: "test:alice", expiresAt: "2026-01-01T04:00:00Z" }),
    { sessionId: "s1", event: "started", url: "https://a-b.trycloudflare.com", actorId: "test:alice", expiresAt: "2026-01-01T04:00:00.000Z" });
  assert.deepEqual(parseSessionTunnelReport({ sessionId: "s1", event: "stopped", url: "https://a-b.trycloudflare.com", reason: "lifetime" }),
    { sessionId: "s1", event: "stopped", url: "https://a-b.trycloudflare.com", reason: "lifetime" });
  const started = { sessionId: "s1", event: "started", url: "https://a-b.trycloudflare.com", expiresAt: "2026-01-01T04:00:00Z" };
  for (const invalid of [{ ...started, url: "https://example.com" }, { ...started, url: "https://api.trycloudflare.com" }, { ...started, expiresAt: undefined },
    { ...started, reason: "stop" }, { ...started, event: "paused" }, { ...started, sessionId: "../x" }, { ...started, token: "secret" },
    { sessionId: "s1", event: "stopped", url: started.url, reason: "because" }, { sessionId: "s1", event: "stopped", url: started.url }]) {
    assert.throws(() => parseSessionTunnelReport(invalid), /Invalid tunnel report/, JSON.stringify(invalid));
  }
});

test("the tunnel tool takes start with serve, checked as the browser's serve is, or status or stop with nothing else, before any card", () => {
  assert.deepEqual(tunnelRequest({ action: "status" }), { action: "status" });
  assert.deepEqual(tunnelRequest({ action: "stop" }), { action: "stop" });
  assert.deepEqual(tunnelRequest({ action: "start", serve: { program: "pnpm", args: ["preview", "--port", "4173"], directory: "app", port: 4173 } }),
    { action: "start", serve: { program: "pnpm", args: ["preview", "--port", "4173"], directory: "app", port: 4173 } });
  assert.deepEqual(tunnelRequest({ action: "start", serve: { program: "python3", args: ["-m", "http.server", "8000"], venv: ".venv", port: 8000, timeout_seconds: 120 } }),
    { action: "start", serve: { program: "python3", args: ["-m", "http.server", "8000"], venv: ".venv", port: 8000, timeout_seconds: 120 } });
  const refusals: [unknown, RegExp][] = [
    [undefined, /takes \{action/], [{}, /action is one of start, status, stop/], [{ action: "open" }, /action is one of/],
    [{ action: "start" }, /start needs serve/], [{ action: "status", serve: { program: "node", port: 1 } }, /status takes nothing else/],
    [{ action: "stop", url: "https://x" }, /takes action and serve, not url/],
    [{ action: "start", serve: { program: "bash", args: ["-c", "nc -l 80"], port: 80 } }, /serve.program is one of the node and python tools' programs/],
    [{ action: "start", serve: { program: "node", port: 0 } }, /serve.port is a whole number from 1 to 65535/],
    [{ action: "start", serve: { program: "node", port: 70_000 } }, /serve.port/],
    [{ action: "start", serve: { program: "npm", args: ["publish"], port: 3000 } }, /serve: .*publish/],
    [{ action: "start", serve: { program: "node", args: ["server.js"], directory: "../elsewhere", port: 3000 } }, /serve: directory is a path within the session's worktree/],
    [{ action: "start", serve: { program: "node", venv: ".venv", port: 3000 } }, /serve.venv is a virtual environment, for Python's programs/],
    [{ action: "start", serve: { program: "node", port: 3000, url: "http://x" } }, /serve is \{program/],
  ];
  for (const [input, refusal] of refusals) assert.throws(() => tunnelRequest(input), refusal, JSON.stringify(input));
});

test("a tunnel start's card is decided as a host command everywhere, and never auto-approved for a member; it says what it publishes", () => {
  const start = { kind: "extension.tool", source: "piki:tunnel", tool: "tunnel", arguments: '{"action":"start"}', digest: "0".repeat(64) };
  for (const session of [{ ownerId: "alice", connectorOwnerId: "alice" }, { ownerId: "bob", connectorOwnerId: "alice" }]) {
    assert.equal(decidedAsHostCommand(start, session), true, JSON.stringify(session));
    assert.equal(requesterAutoApproves(start, session), false, JSON.stringify(session));
  }
  assert.match(extensionToolNotice(start), /server runs in the session's sandbox, and cloudflared, on the session's host, publishes it/);
  assert.match(extensionToolNotice(start), /Only the host's owner, or a member granted host commands, can approve it/);
});

test("a service runs as one quoted command: the driver, the socket it listens on, the connector's Node.js for Node's programs, and the program as JSON", () => {
  const serve = { program: "pnpm", args: ["preview", "--port", "4173", "it's"], port: 4173 };
  assert.equal(serviceShellCommand(serve, { nodeBin: "/opt/pikibun/node/bin" }),
    `'/opt/pikibun/service/pikibun-service' '--socket' '/run/pikibun-service/http.sock' '--node-bin' '/opt/pikibun/node/bin' '${JSON.stringify(serve).replaceAll("'", `'\\''`)}' </dev/null 2>&1`);
  assert.ok(!serviceShellCommand({ program: "python3", port: 8000 }, { nodeBin: "/opt/pikibun/node/bin" }).includes("--node-bin"));
  // Its limits are a long command's, for the whole lifetime, within a day.
  assert.deepEqual(serviceLimits(3600, 4), { seconds: 3600, cpuSeconds: 14_400, fileBytes: 16 * 1024 ** 3, openFiles: 8192 });
  assert.equal(serviceLimits(10, 1).seconds, 300);
  assert.equal(serviceLimits(1e9, 1).seconds, 86_400);
});

/** A service process that a test drives: its output, and its exit. */
function fakeProcess() {
  const exit = Promise.withResolvers<ServiceExit>();
  let output: (chunk: Buffer) => void = () => {};
  let killed = 0;
  const process: ServiceProcess = { exited: exit.promise, kill: () => { killed++; exit.resolve({ code: null, signal: "SIGKILL" }); } };
  return {
    process, killed: () => killed,
    start: async (onOutput: (chunk: Buffer) => void) => { output = onOutput; return process; },
    print: (text: string) => output(Buffer.from(text)),
    exit: (code: number) => exit.resolve({ code, signal: null }),
  };
}

test("a session service keeps its last lines, says when its port answers, and stops once, for its first reason: stop, its lifetime or its exit", async () => {
  // Stopped by its tool: the first reason stands.
  const one = fakeProcess();
  const service = await SessionService.start({ start: one.start, lifetimeMs: 60_000 });
  one.print("listening on 4173\nhalf a li");
  one.print(`ne\n${SERVICE_MARK}{"kind":"ready","port":4173}\n`);
  await service.ready;
  assert.deepEqual(service.lines(), ["listening on 4173", "half a line"], "the driver's notices aren't the program's output");
  assert.equal(service.running, true);
  const [first, second] = await Promise.all([service.stop("stop"), service.stop("lifetime")]);
  assert.deepEqual([first.reason, second.reason], ["stop", "stop"]);
  assert.equal(service.running, false);
  assert.ok(one.killed() >= 1);
  // Its lifetime ends it, whatever else.
  const two = fakeProcess();
  const timed = await SessionService.start({ start: two.start, lifetimeMs: 30 });
  assert.equal((await timed.stopped).reason, "lifetime");
  assert.ok(timed.expiresAt - timed.startedAt === 30);
  // Its program exiting ends it, and says why it never answered.
  const three = fakeProcess();
  const exited = await SessionService.start({ start: three.start, lifetimeMs: 60_000 });
  three.print(`Error: listen EADDRINUSE\n${SERVICE_MARK}{"kind":"error","message":"node exited (1) before port 4173 answered"}\n`);
  three.exit(1);
  await assert.rejects(exited.ready, /node exited \(1\) before port 4173 answered/);
  assert.deepEqual(await exited.stopped, { reason: "exited", exit: { code: 1, signal: null } });
  assert.deepEqual(exited.lines(), ["Error: listen EADDRINUSE"]);
  // Only the last lines, each within bounds.
  const four = fakeProcess();
  const chatty = await SessionService.start({ start: four.start, lifetimeMs: 60_000 });
  for (let index = 0; index < 100; index++) four.print(`line ${index}\n`);
  four.print(`${"x".repeat(2000)}\n`);
  assert.equal(chatty.lines().length, serviceOutputLimits.lines);
  assert.equal(chatty.lines().at(-1)!.length, serviceOutputLimits.lineLength);
  assert.equal(chatty.lines()[0], `line ${100 - serviceOutputLimits.lines + 1}`);
  await chatty.stop("closed");
  // One that fails to start is no service.
  await assert.rejects(SessionService.start({ start: async () => { throw new Error("Sandbox is closed"); }, lifetimeMs: 60_000 }), /Sandbox is closed/);
});

/** A quick tunnel a test drives. */
function fakeTunnel(url = "https://test-tunnel.trycloudflare.com") {
  const closed = Promise.withResolvers<void>();
  let closes = 0;
  const tunnel: QuickTunnel = { url, connected: () => true, closed: closed.promise, close: async () => { closes++; closed.resolve(); } };
  return { tunnel, closes: () => closes, fail: () => closed.resolve() };
}

test("a session's tunnel starts its server and tunnel together, and whatever stops one stops the other, reported once with why", async () => {
  const reports: Omit<SessionTunnelReport, "sessionId">[] = [];
  const services: ReturnType<typeof fakeProcess>[] = [];
  const tunnels: ReturnType<typeof fakeTunnel>[] = [];
  let allowed = true;
  const sessionTunnel = new SessionTunnel({
    startService: async (_serve, onOutput) => {
      const service = fakeProcess();
      services.push(service);
      const process = await service.start(onOutput);
      setTimeout(() => service.print(`serving\n${SERVICE_MARK}{"kind":"ready","port":4173}\n`), 5);
      return process;
    },
    openTunnel: async () => { const tunnel = fakeTunnel(`https://tunnel-${tunnels.length}.trycloudflare.com`); tunnels.push(tunnel); return tunnel.tunnel; },
    lifetimeMs: async () => 60_000,
    report: async report => { reports.push(report); },
    recheck: async () => { if (!allowed) throw new Error("Authorization denied"); },
    recheckMs: 20,
  });
  const serve = { program: "node", args: ["server.js"], port: 4173 };
  const started = await sessionTunnel.start(serve, "test:alice");
  assert.equal(started.url, "https://tunnel-0.trycloudflare.com");
  assert.equal(started.online, true);
  assert.deepEqual(sessionTunnel.view() && { url: sessionTunnel.view()!.url, command: sessionTunnel.view()!.command, port: sessionTunnel.view()!.port },
    { url: "https://tunnel-0.trycloudflare.com", command: "node server.js", port: 4173 });
  assert.deepEqual(reports.map(report => [report.event, report.url, report.actorId]), [["started", "https://tunnel-0.trycloudflare.com", "test:alice"]]);
  assert.ok(reports[0]!.expiresAt);
  assert.deepEqual(sessionTunnel.status().output, ["serving"]);

  // A new start replaces it.
  await sessionTunnel.start(serve, "test:bob");
  assert.deepEqual(reports.slice(1).map(report => [report.event, report.url, report.reason ?? report.actorId]),
    [["stopped", "https://tunnel-0.trycloudflare.com", "replaced"], ["started", "https://tunnel-1.trycloudflare.com", "test:bob"]]);
  assert.equal(tunnels[0]!.closes(), 1);
  assert.ok(services[0]!.killed() >= 1);

  // Its tool's stop, by someone.
  assert.deepEqual(await sessionTunnel.stop("stop", "test:carol"), { stopped: true, url: "https://tunnel-1.trycloudflare.com" });
  assert.deepEqual(reports.at(-1), { event: "stopped", url: "https://tunnel-1.trycloudflare.com", reason: "stop", actorId: "test:carol" });
  assert.equal(sessionTunnel.view(), undefined);
  assert.deepEqual(sessionTunnel.status().stopped?.reason, "stop");
  assert.deepEqual(await sessionTunnel.stop("stop"), { stopped: false }, "nothing online to stop");

  // The server exiting takes the tunnel offline.
  await sessionTunnel.start(serve, "test:alice");
  services.at(-1)!.exit(0);
  await until(() => reports.at(-1)?.event === "stopped" ? reports.at(-1) : undefined, "the exit's report");
  assert.equal(reports.at(-1)!.reason, "exited");
  assert.equal(tunnels.at(-1)!.closes(), 1);

  // cloudflared exiting takes the server down.
  await sessionTunnel.start(serve, "test:alice");
  tunnels.at(-1)!.fail();
  await until(() => reports.at(-1)?.event === "stopped" ? reports.at(-1) : undefined, "the tunnel's report");
  assert.equal(reports.at(-1)!.reason, "failed");
  assert.ok(services.at(-1)!.killed() >= 1);

  // Its starter losing the session (it was archived, say) takes it offline within a recheck.
  await sessionTunnel.start(serve, "test:alice");
  allowed = false;
  await until(() => reports.at(-1)?.event === "stopped" ? reports.at(-1) : undefined, "the recheck's report");
  assert.equal(reports.at(-1)!.reason, "revoked");
  allowed = true;

  // Stopping the session's work, then the session closing.
  await sessionTunnel.start(serve, "test:alice");
  await sessionTunnel.stop("session-stop", "test:alice");
  assert.equal(reports.at(-1)!.reason, "session-stop");
  await sessionTunnel.start(serve, "test:alice");
  await sessionTunnel.close();
  assert.equal(reports.at(-1)!.reason, "closed");
  await assert.rejects(sessionTunnel.start(serve, "test:alice"), /closing/);
  // Each stop was reported once.
  const stops = reports.filter(report => report.event === "stopped").map(report => report.url);
  assert.equal(new Set(stops).size, stops.length);
  assert.equal(reports.filter(report => report.event === "started").length, stops.length);
});

test("a server that never answers, or a tunnel that never opens, leaves nothing online and says why", async () => {
  const reports: Omit<SessionTunnelReport, "sessionId">[] = [];
  let process: ReturnType<typeof fakeProcess> | undefined;
  let tunnelFails = false;
  const sessionTunnel = new SessionTunnel({
    startService: async (_serve, onOutput) => {
      process = fakeProcess();
      const started = await process.start(onOutput);
      setTimeout(() => {
        if (tunnelFails) process!.print(`${SERVICE_MARK}{"kind":"ready","port":3000}\n`);
        else { process!.print(`Cannot find module 'server.js'\n${SERVICE_MARK}{"kind":"error","message":"node exited (1) before port 3000 answered"}\n`); process!.exit(1); }
      }, 5);
      return started;
    },
    openTunnel: async () => { throw new Error(NO_ADDRESS); },
    lifetimeMs: async () => 60_000,
    report: async report => { reports.push(report); },
    recheck: async () => {},
  });
  await assert.rejects(sessionTunnel.start({ program: "node", args: ["server.js"], port: 3000 }, "test:alice"),
    /node exited \(1\) before port 3000 answered\. Nothing is online\.\nThe server's last output:\nCannot find module 'server.js'/);
  tunnelFails = true;
  await assert.rejects(sessionTunnel.start({ program: "node", args: ["server.js"], port: 3000 }, "test:alice"), /couldn't get an address from Cloudflare.*Nothing is online; the server was stopped/s);
  assert.ok(process!.killed() >= 1);
  assert.deepEqual(reports, [], "nothing went online, so nothing is reported");
  assert.equal(sessionTunnel.view(), undefined);
});

test("the service's driver relays its Unix socket to the declared port only, prints the program's output, and ends with it", { skip: !python && "python3 is not installed" }, async t => {
  const root = await directory(t, "service-driver");
  const driver = join(root, "pikibun-service");
  await writeFile(driver, SERVICE_DRIVER, { mode: 0o755 });
  // The served program, as a session would write it: answers on its port, and logs.
  await writeFile(join(root, "server.js"), `require("node:http").createServer((q, s) => { console.log("GET " + q.url); s.end("hello from " + q.headers.host); })
    .listen(Number(process.argv[2]), "127.0.0.1", () => console.log("listening"));`);
  const port = await new Promise<number>(resolve => { const probe = createServer(); probe.listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => resolve(port)); }); });
  const socket = shortSocket(join(root, "s.sock"));
  const child = spawn(python, ["-I", driver, "--socket", socket, "--node-bin", join(process.execPath, ".."),
    JSON.stringify({ program: "node", args: ["server.js", String(port)], directory: root, port, timeout_seconds: 20 })], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { child.kill("SIGKILL"); });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  await until(() => output.includes(`${SERVICE_MARK}{"port": ${port}, "kind": "ready"}`) ? true : undefined, "the driver to be ready");
  assert.ok(existsSync(socket));
  // A request through the socket reaches the server on its port.
  const answer = await new Promise<string>((resolve, reject) => {
    const request = httpRequest({ socketPath: socket, path: "/hello", headers: { host: "x.trycloudflare.com" } }, response => {
      let body = "";
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve(body));
    });
    request.on("error", reject);
    request.end();
  });
  assert.equal(answer, "hello from x.trycloudflare.com");
  await until(() => output.includes("GET /hello") ? true : undefined, "the program's output");
  assert.match(output, /^listening$/m);
  // Ended by the runner (SIGTERM): it stops the program's process group and exits.
  child.kill("SIGTERM");
  const code = await new Promise<number | null>(resolve => child.once("close", resolve));
  assert.equal(code, 0);
  assert.match(output, /"kind": "exited"/);
});

test("the service's driver says when the port never answers, and leaves nothing running", { skip: !python && "python3 is not installed" }, async t => {
  const root = await directory(t, "service-silent");
  const driver = join(root, "pikibun-service");
  await writeFile(driver, SERVICE_DRIVER, { mode: 0o755 });
  const run = (serve: unknown) => new Promise<{ code: number | null; output: string }>(resolve => {
    const child = spawn(python, ["-I", driver, "--socket", shortSocket(join(root, "s.sock")), JSON.stringify(serve)], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    child.once("close", code => resolve({ code, output }));
  });
  const silent = await run({ program: "python3", args: ["-c", "import time; print('busy', flush=True); time.sleep(30)"], directory: root, port: 9, timeout_seconds: 1 });
  assert.equal(silent.code, 1);
  assert.match(silent.output, /port 9 did not answer within 1 seconds of python3 starting/);
  assert.match(silent.output, /^busy$/m);
  const refused = await run({ program: "bash", args: ["-c", "true"], port: 9 });
  assert.equal(refused.code, 2);
  assert.match(refused.output, /serve runs one of node, npm/);
  const exited = await run({ program: "python3", args: ["-c", "print('bye')"], directory: root, port: 9 });
  assert.equal(exited.code, 1);
  assert.match(exited.output, /python3 exited \(0\) before port 9 answered/);
});

test("the connector's quick tunnel runs cloudflared on the host, pointed at a loopback port it forwards to the service's socket, with nothing of its environment", async t => {
  const root = await directory(t, "quick-tunnel");
  const executable = await fakeCloudflared(root);
  // The session's service, as its socket appears to the connector.
  const socket = shortSocket(join(root, "http.sock"));
  const service: Server = createServer((request, response) => response.end(`served ${request.url}`));
  await new Promise<void>(resolve => service.listen(socket, resolve));
  t.after(() => new Promise<void>(resolve => service.close(() => resolve())));
  process.env.PIKIBUN_TUNNEL_TEST_SECRET = "never-for-cloudflared";
  t.after(() => { delete process.env.PIKIBUN_TUNNEL_TEST_SECRET; });
  const lines: string[] = [];
  const tunnels = new HostTunnels({ cloudflared: () => ({ executable }), directory: join(root, "state"), log: line => lines.push(line), connectMs: 5000 });
  const tunnel = await tunnels.open(socket);
  assert.equal(tunnel.url, "https://fake-quick-tunnel.trycloudflare.com", "the address, never api.trycloudflare.com from its errors");
  await until(() => tunnel.connected() || undefined, "the edge connection");
  const edge = Number(await until(() => lines.map(line => /^FAKE_EDGE=(\d+)$/.exec(line)?.[1]).find(Boolean), "the fake edge"));
  // A request to the public address reaches the service through the forwarding.
  const response = await fetch(`http://127.0.0.1:${edge}/page?x=1`);
  assert.equal(await response.text(), "served /page?x=1");
  const call = JSON.parse((await readFile(join(root, "calls.jsonl"), "utf8")).trim().split("\n").at(-1)!) as { args: string[]; env: Record<string, string>; cwd: string };
  const url = call.args[call.args.indexOf("--url") + 1]!;
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.deepEqual(call.args.slice(0, 4), ["tunnel", "--no-autoupdate", "--config", join(root, "state", "config.yml")]);
  assert.equal(await readFile(join(root, "state", "config.yml"), "utf8"), "{}\n", "no host configuration applies");
  assert.equal(call.env.PIKIBUN_TUNNEL_TEST_SECRET, undefined, "nothing of the connector's environment");
  assert.equal(call.env.HOME, join(root, "state", "home"));
  // The loopback port goes to the service's socket only.
  assert.equal(await (await fetch(`${url}/other`)).text(), "served /other");
  await tunnel.close();
  await tunnel.closed;
  assert.equal(tunnel.connected(), false);
  await assert.rejects(fetch(`http://127.0.0.1:${edge}/`), "cloudflared ended");
  await assert.rejects(fetch(`${url}/`), "and so did the forwarding");
});

test("a cloudflared that gives no address is ended, and the call says what the host needs, not the host's errors", async t => {
  const root = await directory(t, "quick-tunnel-fails");
  const exits = await fakeCloudflared(join(root), "exit");
  const lines: string[] = [];
  const tunnels = new HostTunnels({ cloudflared: () => ({ executable: exits }), directory: join(root, "state"), log: line => lines.push(line), addressMs: 5000 });
  await assert.rejects(tunnels.open(shortSocket(join(root, "none.sock"))), error => error instanceof Error && error.message === NO_ADDRESS);
  assert.ok(lines.some(line => line.includes("api.trycloudflare.com")), "its errors go to the connector's log");
  const silentRoot = join(root, "silent");
  await mkdir(silentRoot);
  const silent = await fakeCloudflared(silentRoot, "silent");
  const slow = new HostTunnels({ cloudflared: () => ({ executable: silent }), directory: join(root, "state2"), addressMs: 300 });
  await assert.rejects(slow.open(shortSocket(join(root, "none.sock"))), error => error instanceof Error && error.message === NO_ADDRESS);
  // It was ended: no process of it is left recorded.
  assert.deepEqual(await (await import("node:fs/promises")).readdir(join(root, "state2", "processes")), []);
  const none = new HostTunnels({ cloudflared: () => undefined, directory: join(root, "state3") });
  assert.equal(none.available, false);
  await assert.rejects(none.open("x.sock"), /no cloudflared/);
});

test("a host's cloudflared stands as its owner chose: found, at a path, downloaded and checked against its release's SHA-256, or off", async t => {
  const root = await directory(t, "cloudflared-source");
  const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from("not really a program")]);
  const installed = join(root, "bin", "cloudflared");
  await mkdir(join(root, "bin"));
  await writeFile(installed, elf, { mode: 0o755 });
  const script = join(root, "bin", "wrapper");
  await writeFile(script, "#!/bin/sh\nexec cloudflared \"$@\"\n", { mode: 0o755 });
  const base = { root: join(root, "downloads"), supported: true, platform: "linux" as const, arch: "x64" };
  // Found, or a path the owner gave, or none.
  const found = new HostTunnelSource({ ...base, detect: () => ({ executable: installed }) });
  assert.deepEqual(await found.apply({ source: "auto" }), { source: "auto", state: "ready", executable: installed, downloadable: true });
  assert.equal(found.current()?.executable, installed);
  assert.equal((await found.apply({ source: "path", path: script })).state, "missing");
  assert.match(found.status().error!, /isn't a program but a script/);
  assert.equal(found.current(), undefined);
  assert.equal((await found.apply({ source: "path", path: installed })).state, "ready");
  assert.deepEqual(await found.apply({ source: "off" }), { source: "off", state: "off", downloadable: true });
  assert.equal(found.current(), undefined, "off refuses tunnels on the host");
  const missing = new HostTunnelSource({ ...base, detect: () => undefined });
  assert.match((await missing.apply({ source: "auto" })).error!, /No cloudflared found on this host/);
  const elsewhere = new HostTunnelSource({ ...base, supported: false, detect: () => ({ executable: installed }) });
  assert.equal((await elsewhere.apply({ source: "auto" })).state, "unsupported");
  assert.equal(elsewhere.current(), undefined);
  assert.equal(cloudflaredAsset("linux", "x64"), "cloudflared-linux-amd64");
  assert.equal(cloudflaredAsset("darwin", "arm64"), undefined);
  assert.equal(new HostTunnelSource({ ...base, arch: "riscv64" }).downloadable, false);

  // Downloaded: the latest release's asset, checked against the SHA-256 its notes list.
  const asset = "cloudflared-linux-amd64";
  let body = elf;
  let sha = createHash("sha256").update(elf).digest("hex");
  const fetched: string[] = [];
  const fakeFetch = (async (url: string) => {
    fetched.push(String(url));
    if (String(url).startsWith("https://api.github.com/")) {
      return Response.json({ tag_name: "2026.1.0", body: `## SHA256 Checksums:\n\`\`\`\ncloudflared-darwin-amd64.tgz: ${"0".repeat(64)}\n${asset}: ${sha}\n\`\`\``,
        assets: [{ name: asset, browser_download_url: `https://github.com/cloudflare/cloudflared/releases/download/2026.1.0/${asset}` }] });
    }
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  assert.deepEqual(await latestCloudflared(asset, { fetch: fakeFetch }), { version: "2026.1.0", asset, url: `https://github.com/cloudflare/cloudflared/releases/download/2026.1.0/${asset}`, sha256: sha });
  let now = 0;
  const download = new HostTunnelSource({ ...base, fetch: fakeFetch, now: () => now, detect: () => undefined });
  assert.equal((await download.apply({ source: "download" })).state, "downloading");
  await download.settled();
  assert.deepEqual(download.status(), { source: "download", state: "ready", executable: join(base.root, "2026.1.0", "cloudflared"), version: "2026.1.0", downloadable: true });
  assert.deepEqual((await downloadedCloudflareds(base.root)).map(item => item.version), ["2026.1.0"]);
  // A download that doesn't match is refused, and tried again later.
  await rm(base.root, { recursive: true, force: true });
  body = Buffer.concat([elf, Buffer.from("tampered")]);
  const tampered = new HostTunnelSource({ ...base, fetch: fakeFetch, now: () => now, detect: () => undefined });
  await tampered.apply({ source: "download" });
  await tampered.settled();
  assert.equal(tampered.status().state, "failed");
  assert.match(tampered.status().error!, /doesn't match its release's SHA-256/);
  assert.equal(tampered.current(), undefined);
  // A release that lists no checksum for it is refused before anything is downloaded.
  sha = "";
  await assert.rejects(latestCloudflared(asset, { fetch: fakeFetch }), /lists no SHA-256/);
  now += 11 * 60_000;
  assert.ok(fetched.every(url => url.startsWith("https://api.github.com/repos/cloudflare/cloudflared/") || url.startsWith("https://github.com/cloudflare/cloudflared/releases/download/")));
});

test("a connector that stopped without ending its cloudflareds ends those it recorded as it starts again", { skip: process.platform !== "linux" && "reaping reads /proc" }, async t => {
  const root = await directory(t, "tunnel-reap");
  const executable = await fakeCloudflared(root, "silent");
  // A cloudflared left running, recorded as the connector records its own.
  const left = spawn(executable, ["tunnel", "--url", "http://127.0.0.1:1"], { stdio: "ignore" });
  t.after(() => { left.kill("SIGKILL"); });
  await until(() => existsSync(join(root, "calls.jsonl")) || undefined, "the stray cloudflared");
  await mkdir(join(root, "state", "processes"), { recursive: true });
  // /proc/<pid>/exe is the interpreter for a script: record what it shows, as the connector would for a real binary.
  const { readlinkSync } = await import("node:fs");
  await writeFile(join(root, "state", "processes", String(left.pid)), readlinkSync(`/proc/${left.pid}/exe`));
  await writeFile(join(root, "state", "processes", "999999"), "/nowhere/cloudflared");
  await chmod(join(root, "state", "processes"), 0o700);
  const exited = new Promise(resolve => left.once("exit", resolve));
  new HostTunnels({ cloudflared: () => ({ executable }), directory: join(root, "state") });
  await exited;
  assert.deepEqual(await (await import("node:fs/promises")).readdir(join(root, "state", "processes")), []);
});
