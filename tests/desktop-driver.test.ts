import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DESKTOP_DRIVER, SERVICE_DRIVER } from "../apps/runner/src/sandbox-python.generated.js";

const python = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout?.trim() ?? "";
const skip = !python && "python3 is not installed";

const FAKE_XVNC = `#!${python || "/usr/bin/python3"} -I
import os, socket, sys, threading
args = sys.argv[1:]
port = int(args[args.index('-rfbport') + 1])
with open(os.environ['FAKE_XVNC_LOG'], 'w') as log:
    log.write(' '.join(args))
listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind(('127.0.0.1', port))
listener.listen(8)
def serve(client):
    client.sendall(b'RFB 003.008\\n')
    while True:
        data = client.recv(65536)
        if not data:
            break
        client.sendall(b'echo:' + data)
    client.close()
while True:
    client, _ = listener.accept()
    threading.Thread(target=serve, args=(client,), daemon=True).start()
`;

async function freePort(): Promise<number> {
  return new Promise(resolve => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => resolve(port)); });
  });
}

async function until<T>(read: () => T | undefined, what: string, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

async function setUp(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pikibun-desktop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const web = join(root, "novnc");
  await mkdir(bin);
  await mkdir(join(web, "core"), { recursive: true });
  await writeFile(join(bin, "Xvnc"), FAKE_XVNC, { mode: 0o755 });
  await writeFile(join(web, "vnc.html"), "<!doctype html><title>noVNC</title>");
  await writeFile(join(web, "core", "rfb.js"), "export default class RFB {}");
  await writeFile(join(root, "secret.txt"), "not for the viewer");
  const driver = join(root, "pikibun-desktop");
  await writeFile(driver, DESKTOP_DRIVER, { mode: 0o755 });
  return { root, bin, web, driver, log: join(root, "xvnc.log") };
}

function run(driver: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(python, ["-I", driver, ...args], { stdio: ["ignore", "pipe", "pipe"], env, detached: true });
  let output = "";
  child.stdout!.on("data", chunk => { output += chunk; });
  child.stderr!.on("data", chunk => { output += chunk; });
  const closed = new Promise<number | null>(resolve => child.once("close", resolve));
  return { child, output: () => output, closed };
}

function kill(child: ChildProcess): void {
  try { process.kill(-child.pid!, "SIGKILL"); } catch { }
}

function answers(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}

test("a desktop: Xvnc on a display of its own, the program on it, and noVNC with a WebSocket bridge to the display on the port", { skip }, async t => {
  const { root, bin, web, driver, log } = await setUp(t);
  const port = await freePort();
  const program = "import os, time; print('app on ' + os.environ['DISPLAY'] + ' ' + os.environ['GDK_BACKEND'], flush=True); time.sleep(60)";
  const desktop = run(driver, ["--port", String(port), "--size", "800x600", "--web", web, "--", python, "-c", program],
    { PATH: `${bin}:/usr/bin:/bin`, FAKE_XVNC_LOG: log, TMPDIR: root, HOME: root });
  t.after(() => kill(desktop.child));
  await until(() => desktop.output().includes(`is on port ${port}`) ? true : undefined, "the desktop to be ready");
  const display = /display :(\d+) \(800x600\) is on port/.exec(desktop.output())?.[1];
  assert.ok(display, desktop.output());
  await until(() => desktop.output().includes(`app on :${display} x11`) ? true : undefined, "the program on the display");
  const xvnc = await readFile(log, "utf8");
  assert.match(xvnc, new RegExp(`^:${display} -geometry 800x600 -depth 24 -rfbport \\d+ -localhost -SecurityTypes None -AlwaysShared -nolisten tcp`));

  const home = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" });
  assert.equal(home.status, 302);
  assert.equal(home.headers.get("location"), "vnc.html?autoconnect=true&resize=scale&reconnect=true&reconnect_delay=1000&path=websockify");
  const page = await fetch(`http://127.0.0.1:${port}/vnc.html`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
  const module = await fetch(`http://127.0.0.1:${port}/core/rfb.js`);
  assert.equal(module.headers.get("content-type"), "text/javascript; charset=utf-8", "noVNC's modules load as JavaScript");
  assert.equal(await module.text(), "export default class RFB {}");
  for (const path of ["/core/..%2f..%2fsecret.txt", "/%2e%2e/secret.txt", "/core", "/missing.js"]) {
    assert.equal((await fetch(`http://127.0.0.1:${port}${path}`)).status, 404, `${path}: nothing outside noVNC's files, and no listings`);
  }

  const socket = new WebSocket(`ws://127.0.0.1:${port}/websockify`, ["binary"]);
  socket.binaryType = "arraybuffer";
  const received: string[] = [];
  socket.addEventListener("message", event => { received.push(Buffer.from(event.data as ArrayBuffer).toString("latin1")); });
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve); socket.addEventListener("error", reject); });
  assert.equal(socket.protocol, "binary");
  await until(() => received.join("").includes("RFB 003.008\n") ? true : undefined, "the display's greeting");
  const big = Buffer.alloc(70_000, 7);
  socket.send(Buffer.from("key-event"));
  socket.send(big);
  await until(() => received.join("").includes("echo:key-event") ? true : undefined, "the display's answer");
  await until(() => received.join("").length >= "RFB 003.008\n".length + "echo:key-event".length + big.length ? true : undefined, "a frame past 64 KiB");
  socket.close();

  const handshake = (headers: string) => new Promise<string>(resolve => {
    const raw = connect(port, "127.0.0.1");
    let answer = "";
    raw.on("data", chunk => { answer += chunk.toString("latin1"); if (answer.includes("\r\n\r\n")) { raw.destroy(); resolve(answer); } });
    raw.write(`GET /websockify HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n${headers}\r\n`);
  });
  const accepted = await handshake("Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n");
  assert.match(accepted, /^HTTP\/1\.1 101 /);
  assert.match(accepted, /\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=\r\n/, "RFC 6455's own example");
  assert.doesNotMatch(accepted, /Sec-WebSocket-Protocol/, "no protocol asked, none answered");
  assert.match(await handshake("Sec-WebSocket-Key: x\r\nSec-WebSocket-Version: 8\r\n"), /^HTTP\/1\.1 400 /, "only WebSocket version 13");
  assert.match(await handshake("Sec-WebSocket-Key: x\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: base64\r\n"), /^HTTP\/1\.1 400 /, "binary frames only");

  process.kill(desktop.child.pid!, "SIGTERM");
  assert.equal(await desktop.closed, 0, desktop.output());
  const rfb = Number(/-rfbport (\d+)/.exec(xvnc)?.[1]);
  assert.equal(await answers(rfb), false, "Xvnc ends with the desktop");
  assert.equal(await answers(port), false, "and so does the viewer's port");
});

test("a desktop ends with its program, with the program's exit code, and says what the host lacks before anything starts", { skip }, async t => {
  const { root, bin, web, driver, log } = await setUp(t);
  const port = await freePort();
  const env = { PATH: `${bin}:/usr/bin:/bin`, FAKE_XVNC_LOG: log, TMPDIR: root, HOME: root };
  const exits = run(driver, ["--port", String(port), "--web", web, "--", python, "-c", "import sys; sys.exit(3)"], env);
  t.after(() => kill(exits.child));
  assert.equal(await exits.closed, 3, exits.output());
  assert.match(exits.output(), /exited \(3\): the desktop closes/);
  assert.match(await readFile(log, "utf8"), /-geometry 1280x800 /, "1280x800 by default");

  const noXvnc = run(driver, ["--port", String(port), "--web", web, "--", python, "-c", "pass"], { PATH: "/nonexistent", TMPDIR: root });
  assert.equal(await noXvnc.closed, 2);
  assert.match(noXvnc.output(), /a desktop needs TigerVNC's Xvnc: tigervnc-standalone-server on Debian and Ubuntu, .*which the host lacks/);

  const noViewer = run(driver, ["--port", String(port), "--web", join(root, "none"), "--", python, "-c", "pass"], env);
  assert.equal(await noViewer.closed, 2);
  assert.match(noViewer.output(), /a desktop needs noVNC's files: the novnc package/);

  for (const args of [["--port", "0", "--", "x"], ["--port", "6080", "--size", "100x100", "--", "x"], ["--port", "6080", "--size", "big", "--", "x"], ["--port", "6080"]]) {
    const refused = run(driver, args, env);
    assert.equal(await refused.closed, 2, args.join(" "));
  }
});

test("the service's driver and the browser's start a desktop's program through the desktop helper, or say the sandbox has none", { skip }, async t => {
  const root = await mkdtemp(join(tmpdir(), "pikibun-desktop-service-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const driver = join(root, "pikibun-service");
  await writeFile(driver, SERVICE_DRIVER, { mode: 0o755 });
  const child = spawn(python, ["-I", driver, "--socket", join(root, "s.sock"),
    JSON.stringify({ program: "python3", args: ["gui.py"], directory: root, port: 6080, desktop: { width: 1280, height: 800 } })], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  const code = await new Promise<number | null>(resolve => child.once("close", resolve));
  assert.equal(code, 2);
  assert.match(output, /this sandbox has no desktop helper/, "outside a sandbox that mounts it, at /opt/pikibun/desktop/pikibun-desktop");
});
