import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { networkInterfaces, tmpdir, type NetworkInterfaceInfo } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { listenChoice } from "../apps/server/src/local/cli.js";
import { startLocalServer } from "../apps/server/src/local/launch.js";
import { describeListen, interfaceChoices, listenError, listenUrl, parseListen, resolveListen } from "../apps/server/src/local/listen.js";
import { loadLocalState, LocalStateError, peekLocalState } from "../apps/server/src/local/state.js";

const info = (address: string, extra: Partial<NetworkInterfaceInfo> = {}) => ({
  address, family: address.includes(":") ? "IPv6" : "IPv4", internal: false, netmask: "", mac: "00:00:00:00:00:00", cidr: null, ...extra,
}) as NetworkInterfaceInfo;

const interfaces = {
  lo: [info("127.0.0.1", { internal: true }), info("::1", { internal: true })],
  eth0: [info("192.168.1.20"), info("fe80::1", { scopeid: 2 } as Partial<NetworkInterfaceInfo>)],
  tailscale0: [info("100.64.1.2"), info("fd7a:115c:a1e0::2")],
  down0: [info("fe80::9", { scopeid: 4 } as Partial<NetworkInterfaceInfo>)],
};

async function directory(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pikibun-listen-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("where a local server listens is all, loopback, or network interfaces and addresses, each once", () => {
  for (const good of [["all"], ["loopback"], ["eth0"], ["tailscale0", "192.168.1.20", "fd7a::2"]]) assert.equal(listenError(good), undefined, good.join());
  for (const [bad, message] of [
    [[], /Choose where/], ["all", /Choose where/], [Array.from({ length: 17 }, (_, index) => `eth${index}`), /up to 16/],
    [["eth0 ; rm"], /network interface such as eth0/], [[""], /network interface such as eth0/], [[7], /network interface such as eth0/],
    [["eth0", "eth0"], /twice/], [["all", "eth0"], /stand alone/], [["loopback", "eth0"], /stand alone/],
  ] as const) assert.match(listenError(bad) ?? "", message, JSON.stringify(bad));
  assert.deepEqual(parseListen(["tailscale0, 192.168.1.20", "", " eth0 "]), ["tailscale0", "192.168.1.20", "eth0"]);
  assert.deepEqual(listenChoice(["tailscale0,eth0"]), ["tailscale0", "eth0"]);
  assert.throws(() => listenChoice(["all,eth0"]), /--listen: all and loopback stand alone/);
  assert.equal(describeListen(["all"]), "every network interface");
  assert.equal(describeListen(["loopback"]), "this computer only");
  assert.equal(describeListen(["tailscale0", "eth0"]), "this computer and tailscale0, eth0");
});

test("a local server's listen choice resolves to the addresses it binds, always with this computer's loopback", () => {
  assert.deepEqual(resolveListen(["all"], interfaces), { ok: true, addresses: ["0.0.0.0"] });
  assert.deepEqual(resolveListen(["loopback"], interfaces), { ok: true, addresses: ["127.0.0.1"] });
  assert.deepEqual(resolveListen(["eth0"], interfaces), { ok: true, addresses: ["127.0.0.1", "192.168.1.20"] }, "link-local IPv6 needs a scope, so it is left out");
  assert.deepEqual(resolveListen(["tailscale0", "192.168.1.20", "127.0.0.1"], interfaces),
    { ok: true, addresses: ["127.0.0.1", "100.64.1.2", "fd7a:115c:a1e0::2", "192.168.1.20"] });
  assert.deepEqual(resolveListen(["wlan0"], interfaces), { ok: false, error: "This computer has no network interface named wlan0 (it has down0, eth0, lo, tailscale0)." });
  assert.deepEqual(resolveListen(["down0"], interfaces), { ok: false, error: "The network interface down0 has no address to listen on: is it up?" });
  assert.equal(resolveListen(["all", "eth0"], interfaces).ok, false);
  assert.equal(listenUrl("fd7a:115c:a1e0::2", 7878), "http://[fd7a:115c:a1e0::2]:7878");
  assert.equal(listenUrl("0.0.0.0", 7878), "http://0.0.0.0:7878");
  assert.deepEqual(interfaceChoices(interfaces), [
    { name: "eth0", addresses: ["192.168.1.20"] },
    { name: "tailscale0", addresses: ["100.64.1.2", "fd7a:115c:a1e0::2"] },
  ], "the app is offered the interfaces that reach beyond this computer");
});

test("a local server remembers where it listens, and takes a shared Pikibun's old loopback-only setting as its own", async t => {
  const stateDir = join(await directory(t), "server");
  const first = await loadLocalState(stateDir);
  assert.equal(first.listen, undefined, "nothing chosen: every interface");
  const chosen = await loadLocalState(stateDir, { listen: ["tailscale0", "192.168.1.20"] });
  assert.deepEqual(chosen.listen, ["tailscale0", "192.168.1.20"]);
  assert.deepEqual((await loadLocalState(stateDir)).listen, ["tailscale0", "192.168.1.20"], "later runs keep it");
  await assert.rejects(loadLocalState(stateDir, { listen: ["all", "eth0"] }), LocalStateError);

  const shared = { origin: "https://pikibun.example.test", trustProxy: false, signup: "invite", passwordAuth: true, admins: ["password:admin"] };
  for (const [listen, expected] of [["loopback", ["loopback"]], ["all", undefined]] as const) {
    await writeFile(join(stateDir, "server.json"), JSON.stringify({ ...first, shared: { ...shared, listen } }), { mode: 0o600 });
    const migrated = await loadLocalState(stateDir);
    assert.deepEqual(migrated.listen, expected, listen);
    assert.deepEqual(migrated.shared, shared);
    assert.doesNotMatch(await readFile(join(stateDir, "server.json"), "utf8"), /"listen": "/, "the old setting is written in its new place");
  }
  await writeFile(join(stateDir, "server.json"), JSON.stringify({ ...first, listen: ["eth0", "eth0"] }), { mode: 0o600 });
  await assert.rejects(peekLocalState(stateDir), /damaged/);
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise(resolve => server.close(resolve));
  return port;
}

test("a local server listens on each address of the interfaces it was given besides its loopback, and says where", async t => {
  const loopback = Object.entries(networkInterfaces()).find(([, infos]) => infos?.some(entry => entry.address === "127.0.0.1"))?.[0];
  assert.ok(loopback, "this computer has a loopback interface");
  const stateDir = join(await directory(t), "server");
  const port = await freePort();
  const web = await directory(t);
  await writeFile(join(web, "index.html"), "<!doctype html><title>Pikibun</title>");
  await writeFile(join(web, "nsh.0123456789.wasm"), new Uint8Array([0, 97, 115, 109]));
  const state = await loadLocalState(stateDir, { port, listen: [loopback] });
  const resolved = resolveListen([loopback]);
  assert.ok(resolved.ok);
  const server = await startLocalServer({ stateDir, state, staticDir: web });
  t.after(() => server.close());
  assert.equal(server.origin, `http://127.0.0.1:${port}`);
  assert.deepEqual(server.listening, resolved.addresses.map(address => listenUrl(address, port)));
  for (const url of server.listening) assert.equal((await fetch(`${url}/api/health`)).status, 200, url);
  await server.close();
  for (const url of server.listening) await assert.rejects(fetch(`${url}/api/health`), `closing stops listening on ${url}`);

  const nowhere = await loadLocalState(stateDir, { listen: ["192.0.2.123"] });
  await assert.rejects(startLocalServer({ stateDir, state: nowhere, staticDir: web }), /can't listen on 192\.0\.2\.123: this computer has no such address/);
  const missing = await loadLocalState(stateDir, { listen: ["nosuchif9"] });
  await assert.rejects(startLocalServer({ stateDir, state: missing, staticDir: web }), /no network interface named nosuchif9/);
});
