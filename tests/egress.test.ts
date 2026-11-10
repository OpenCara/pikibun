import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { createServer as createTcpServer, connect as tcpConnect, type AddressInfo, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { EgressProxy, egressEnvironment, parseEgressGrant, publicAddress, repositoryForRemote, type RelayRequest } from "../apps/runner/src/egress.js";
import { performClonePush, PushError, pushSummary } from "../apps/runner/src/push.js";
import { Sandbox } from "../apps/runner/src/sandbox.js";
import type { EgressGrant } from "../packages/shared/src/network.js";
import { parsePushCommands, pushRejection, readPushCommands, sessionBranch, sessionBranchName, sessionBranchRefusal, validSessionBranch } from "../packages/shared/src/git-push.js";
import { hostAllowed, hostNamed, parseNetworkPolicy } from "../packages/shared/src/network.js";
import type { RunnerBinding } from "../packages/shared/src/types.js";
import { startGitHttpServer } from "./helpers/git-http.js";
import { CA_BUNDLE, CA_BUNDLE_VARIABLES, trustedCertificates } from "../apps/runner/src/trust-store.js";

const repository = { bindingId: "binding-app", provider: "github", host: "github.com", repositoryId: "1701", fullName: "acme/app" } as const;

function grant(policy: Partial<EgressGrant["policy"]> = {}): EgressGrant {
  return { policy: { mode: "off", domains: [], packageRegistries: true, ...policy }, repositories: [repository] };
}

async function proxy(t: TestContext, options: { grant?: () => Promise<EgressGrant>; relay?: (request: RelayRequest) => Promise<Response>;
  lookup?: (host: string) => Promise<{ address: string; family: number }[]>; connectTo?: number; sessionBranch?: string } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "egress-"));
  const relayed: RelayRequest[] = [];
  const instance = new EgressProxy({
    socketPath: join(directory, "proxy.sock"),
    grant: options.grant ?? (async () => grant()),
    relay: async request => {
      relayed.push(request);
      if (options.relay) return options.relay(request);
      return new Response("advertisement", { headers: { "content-type": "application/x-git-upload-pack-advertisement" } });
    },
    lookup: options.lookup ?? (async () => [{ address: "93.184.216.34", family: 4 }]),
    ...(options.sessionBranch ? { sessionBranch: options.sessionBranch } : {}),
    ...(options.connectTo !== undefined ? { connect: (port: number) => { assert.equal(port, 443); return tcpConnect({ port: options.connectTo!, host: "127.0.0.1" }); } } : {}),
  });
  await instance.start();
  t.after(async () => { await instance.close(); await rm(directory, { recursive: true, force: true }); });
  return { instance, relayed };
}

function get(socketPath: string, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: IncomingMessage["headers"]; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ socketPath, path, method: init.method ?? "GET", headers: init.headers }, response => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end(init.body);
  });
}

function tunnel(socketPath: string, target: string): Promise<{ status: number; socket?: import("node:net").Socket; body?: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ socketPath, method: "CONNECT", path: target });
    request.on("connect", (response, socket, head: Buffer) => {
      if (response.statusCode === 200) return resolve({ status: 200, socket });
      const chunks: Buffer[] = [head];
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      socket.on("end", () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end();
  });
}

test("session branches are named for the session's work, with a short id", () => {
  const id = "1A2B3C4D-5e6f-4000-8000-000000000000";
  assert.equal(sessionBranchName("Add dark mode toggle to settings", id), "pikibun/add-dark-mode-toggle-to-settings-1a2b3c4d5e6f");
  assert.equal(sessionBranchName("  Fix: crash on `pikibun connect` (#42)!  ", id), "pikibun/fix-crash-on-pikibun-connect-42-1a2b3c4d5e6f");
  assert.equal(sessionBranchName("Résumé café naïve", id), "pikibun/resume-cafe-naive-1a2b3c4d5e6f");
  for (const title of ["", "修复登录", "!!!", "Untitled session"]) assert.equal(sessionBranchName(title, id), "pikibun/session-1a2b3c4d5e6f");
  const long = sessionBranchName("Refactor the egress proxy so that pushes of the session branch stream without buffering", id);
  assert.equal(long, "pikibun/refactor-the-egress-proxy-so-that-pushes-of-the-1a2b3c4d5e6f");
  assert.equal(sessionBranchName("x".repeat(100), id), `pikibun/${"x".repeat(48)}-1a2b3c4d5e6f`);
  for (const title of ["Add dark mode", "", "x".repeat(100), long, "a -- b"]) assert.ok(validSessionBranch(sessionBranchName(title, id), id), title);
  assert.ok(!validSessionBranch("pikibun/add-dark-mode-1a2b3c4d5e6f", "ffffffff-0000-4000-8000-000000000000"));
  assert.equal(sessionBranch({ id: "s1" }), "pikibun/s1");
  assert.equal(sessionBranch({ id: "s1", branch: null }), "pikibun/s1");
  assert.equal(sessionBranch({ id: "s1", branch: "pikibun/add-dark-mode-1a2b3c4d5e6f" }), "pikibun/add-dark-mode-1a2b3c4d5e6f");
});

test("public addresses exclude the host, its networks and metadata services", () => {
  for (const address of ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946", "8.8.8.8"]) assert.equal(publicAddress(address), true, address);
  for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "224.0.0.1", "not-an-ip"]) {
    assert.equal(publicAddress(address), false, address);
  }
});

test("network policies parse strictly and match hosts by mode", () => {
  assert.throws(() => parseNetworkPolicy({ mode: "everything", domains: [], packageRegistries: true }), /mode/);
  assert.throws(() => parseNetworkPolicy({ mode: "allowlist", domains: ["10.0.0.1"], packageRegistries: true }), /Invalid domain/);
  assert.throws(() => parseNetworkPolicy({ mode: "allowlist", domains: ["example.com:8443"], packageRegistries: true }), /Invalid domain/);
  assert.throws(() => parseNetworkPolicy({ mode: "allowlist", domains: [], packageRegistries: true, extra: 1 }));
  const policy = parseNetworkPolicy({ mode: "allowlist", domains: ["docs.example.com", "*.cdn.example.net", "docs.example.com"], packageRegistries: true });
  assert.deepEqual(policy.domains, ["docs.example.com", "*.cdn.example.net"]);
  assert.equal(hostAllowed(policy, "docs.example.com"), true);
  assert.equal(hostAllowed(policy, "a.cdn.example.net"), true);
  assert.equal(hostAllowed(policy, "cdn.example.net"), false);
  assert.equal(hostAllowed(policy, "registry.npmjs.org"), true);
  assert.equal(hostAllowed({ ...policy, packageRegistries: false }, "registry.npmjs.org"), false);
  assert.equal(hostAllowed({ ...policy, mode: "off" }, "docs.example.com"), false);
  assert.equal(hostAllowed({ ...policy, mode: "open" }, "anything.example.org"), true);
  assert.equal(hostNamed(policy, "docs.example.com"), true);
  assert.equal(hostNamed(policy, "a.cdn.example.net"), false);
  assert.equal(hostNamed(policy, "registry.npmjs.org"), true);
  assert.equal(hostNamed({ ...policy, packageRegistries: false }, "registry.npmjs.org"), false);
  assert.equal(hostNamed({ ...policy, mode: "open" }, "anything.example.org"), false);
  assert.equal(hostNamed({ ...policy, mode: "open", packageRegistries: false }, "registry.npmjs.org"), true);
  assert.equal(hostNamed({ ...policy, mode: "off" }, "registry.npmjs.org"), false);
  assert.throws(() => parseEgressGrant({ policy, repositories: [{ ...repository, host: "127.0.0.1" }] }), /Invalid repositories/);
  assert.deepEqual(parseEgressGrant({ policy, repositories: [repository] }), { policy, repositories: [repository] });
});

test("sandboxed commands get the proxy and Git rewrites, without credentials", () => {
  const env = egressEnvironment();
  assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:41080");
  const rewrites = Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, index) => [env[`GIT_CONFIG_KEY_${index}`], env[`GIT_CONFIG_VALUE_${index}`]]);
  assert.deepEqual(rewrites[0], ["url.http://127.0.0.1:41080/git/.insteadOf", "https://"]);
  assert.ok(rewrites.some(([key, value]) => key === "url.http://127.0.0.1:41080/git/github.com/.insteadOf" && value === "git@github.com:"));
  assert.ok(!Object.values(env).some(value => /token|password|authorization/i.test(value)));
  for (const name of ["SSL_CERT_FILE", "CURL_CA_BUNDLE", "GIT_SSL_CAINFO", "REQUESTS_CA_BUNDLE", "NODE_EXTRA_CA_CERTS"]) assert.equal(env[name], CA_BUNDLE);
  assert.equal(CA_BUNDLE_VARIABLES.length, 5);
});

test("the sandbox's certificates are the host's system store, else Node's bundled one, plus NODE_EXTRA_CA_CERTS", () => {
  const pem = (name: string) => `-----BEGIN CERTIFICATE-----\n${name}\n-----END CERTIFICATE-----`;
  const store = (stores: Partial<Record<"system" | "bundled" | "extra", string[]>>) => (type: "system" | "bundled" | "extra") => stores[type] ?? [];
  assert.equal(trustedCertificates(store({ system: [pem("system")], bundled: [pem("bundled")], extra: [pem("company")] }), "linux"),
    `${pem("system")}\n${pem("company")}\n`);
  assert.equal(trustedCertificates(store({ system: [], bundled: [pem("bundled"), `${pem("bundled")}\n`], extra: ["not a certificate"] }), "linux"), `${pem("bundled")}\n`);
  assert.equal(trustedCertificates(store({ system: [pem("keychain")], bundled: [pem("bundled")], extra: [pem("company")] }), "darwin"),
    `${pem("bundled")}\n${pem("keychain")}\n${pem("company")}\n`);
  const certificates = trustedCertificates(() => { throw new Error("unreadable"); });
  assert.ok(certificates.split("-----BEGIN CERTIFICATE-----").length > 50);
  assert.ok(trustedCertificates().includes("-----BEGIN CERTIFICATE-----"));
});

test("Git reads of workspace repositories go to the relay; pushes and other repositories are refused", async t => {
  const { instance, relayed } = await proxy(t);
  const refs = await get(instance.socketPath, "/git/github.com/acme/app.git/info/refs?service=git-upload-pack",
    { headers: { "user-agent": "git/2.43.0", "git-protocol": "version=2" } });
  assert.equal(refs.status, 200);
  assert.equal(refs.body, "advertisement");
  assert.equal(refs.headers["content-type"], "application/x-git-upload-pack-advertisement");
  assert.deepEqual(relayed[0], { bindingId: "binding-app", service: "info-refs", userAgent: "git/2.43.0", gitProtocol: "version=2", contentType: undefined, contentEncoding: undefined });
  const fetched = await get(instance.socketPath, "/git/github.com/ACME/App/git-upload-pack",
    { method: "POST", headers: { "content-type": "application/x-git-upload-pack-request" }, body: "0000" });
  assert.equal(fetched.status, 200);
  assert.equal(relayed[1]!.service, "upload-pack");
  assert.equal(Buffer.from(relayed[1]!.body as Uint8Array).toString(), "0000");

  const push = await get(instance.socketPath, "/git/github.com/acme/app.git/info/refs?service=git-receive-pack");
  assert.equal(push.status, 403);
  assert.match(push.body, /git_push/);
  const other = await get(instance.socketPath, "/git/github.com/acme/other.git/info/refs?service=git-upload-pack");
  assert.equal(other.status, 403);
  assert.match(other.body, /not one of this workspace's repositories/);
  assert.equal(relayed.length, 2);
  const status = JSON.parse((await get(instance.socketPath, "/__pikibun/status")).body) as { network: unknown; repositories: string[]; recent: { outcome: string }[] };
  assert.deepEqual(status.repositories, ["https://github.com/acme/app.git"]);
  assert.deepEqual(status.recent.map(entry => entry.outcome), ["allowed", "allowed", "refused", "refused"]);
});

function pkt(text: string): string { return (Buffer.byteLength(text, "latin1") + 4).toString(16).padStart(4, "0") + text; }
const zero = "0".repeat(40), tip = "c".repeat(40);

test("push requests are parsed up to their first flush, and only the session branch passes", async () => {
  const commands = pkt(`shallow ${tip}\n`) + pkt(`${zero} ${tip} refs/heads/pikibun/s1\0report-status side-band-64k\n`) + "0000";
  const parsed = parsePushCommands(new TextEncoder().encode(commands + "PACK"))!;
  assert.deepEqual(parsed.commands, [{ old: zero, new: tip, ref: "refs/heads/pikibun/s1" }]);
  assert.deepEqual(parsed.capabilities, ["report-status", "side-band-64k"]);
  assert.equal(parsed.end, commands.length);
  assert.equal(parsePushCommands(new TextEncoder().encode(commands.slice(0, 30))), undefined);
  assert.throws(() => parsePushCommands(new TextEncoder().encode(pkt("push-cert\0\n"))), /Signed pushes/);
  assert.throws(() => parsePushCommands(new TextEncoder().encode(pkt("not a command\n"))), /Invalid Git push request/);
  const bytes = new TextEncoder().encode(commands + "PACK-DATA");
  const chunked = new ReadableStream<Uint8Array>({ start(controller) { for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.subarray(i, i + 7)); controller.close(); } });
  const read = await readPushCommands(chunked);
  assert.equal(read.commands.length, 1);
  assert.equal(await new Response(read.body).text(), commands + "PACK-DATA");

  assert.equal(sessionBranchRefusal(parsed.commands, "pikibun/s1"), undefined);
  assert.match(sessionBranchRefusal([{ old: zero, new: tip, ref: "refs/heads/main" }], "pikibun/s1")!, /not main; use the git_push tool/);
  assert.match(sessionBranchRefusal([{ old: zero, new: tip, ref: "refs/tags/v1.0.0" }], "pikibun/s1")!, /^Tags can't be pushed without approval, not v1\.0\.0; use the git_push tool with a tag/);
  assert.match(sessionBranchRefusal([...parsed.commands, { old: zero, new: tip, ref: "refs/tags/v1.0.0" }], "pikibun/s1")!, /^Tags can't be pushed/);
  assert.match(sessionBranchRefusal([{ old: tip, new: zero, ref: "refs/heads/pikibun/s1" }], "pikibun/s1")!, /can't be deleted/);
  assert.match(sessionBranchRefusal([...parsed.commands, ...parsed.commands], "pikibun/s1")!, /once per push/);

  const plain = new TextDecoder().decode(pushRejection([{ old: zero, new: tip, ref: "refs/heads/main" }], ["report-status"], "Not this branch"));
  assert.equal(plain, `${pkt("unpack ok\n")}${pkt("ng refs/heads/main Not this branch\n")}0000`);
  const banded = new TextDecoder().decode(pushRejection([{ old: zero, new: tip, ref: "refs/heads/main" }], ["report-status", "side-band-64k"], "Not this branch"));
  assert.equal(banded, `${pkt(`\x01${plain}`)}0000`);
  assert.equal(pushRejection([], ["side-band-64k"], "x"), undefined);
});

test("a clone session's proxy relays pushes of its own branch, streaming the pack, and rejects others like a forge", async t => {
  const packs: string[] = [];
  const { instance, relayed } = await proxy(t, { sessionBranch: "pikibun/s1", relay: async request => {
    if (request.service === "receive-refs") return new Response("refs", { headers: { "content-type": "application/x-git-receive-pack-advertisement" } });
    assert.ok(request.body instanceof ReadableStream);
    packs.push(await new Response(request.body).text());
    return new Response("report", { headers: { "content-type": "application/x-git-receive-pack-result" } });
  } });
  const refs = await get(instance.socketPath, "/git/github.com/acme/app.git/info/refs?service=git-receive-pack");
  assert.equal(refs.status, 200);
  assert.equal(refs.headers["content-type"], "application/x-git-receive-pack-advertisement");
  const headers = { "content-type": "application/x-git-receive-pack-request" };
  const branch = pkt(`${zero} ${tip} refs/heads/pikibun/s1\0report-status side-band-64k\n`) + "0000";
  const pushed = await get(instance.socketPath, "/git/github.com/acme/app.git/git-receive-pack", { method: "POST", headers, body: branch + "PACK-DATA" });
  assert.equal(pushed.status, 200);
  assert.equal(pushed.body, "report");
  assert.deepEqual(packs, [branch + "PACK-DATA"]);
  assert.deepEqual(relayed.map(request => request.service), ["receive-refs", "receive-pack"]);

  const main = pkt(`${zero} ${tip} refs/heads/main\0report-status side-band-64k\n`) + "0000";
  const rejected = await get(instance.socketPath, "/git/github.com/acme/app.git/git-receive-pack", { method: "POST", headers, body: main + "PACK-DATA" });
  assert.equal(rejected.status, 200);
  assert.match(rejected.body, /ng refs\/heads\/main Only this session's branch pikibun\/s1 can be pushed without approval, not main/);
  const probe = await get(instance.socketPath, "/git/github.com/acme/app.git/git-receive-pack", { method: "POST", headers, body: "0000" });
  assert.equal(probe.status, 200);
  assert.equal(probe.body, "");
  const bare = pkt(`${zero} ${tip} refs/heads/main\0side-band-64k\n`) + "0000";
  const plain = await get(instance.socketPath, "/git/github.com/acme/app.git/git-receive-pack", { method: "POST", headers, body: bare + "P".repeat(200_000) });
  assert.equal(plain.status, 403);
  assert.match(plain.body, /Only this session's branch pikibun\/s1/);
  assert.equal(relayed.length, 2);
  const status = JSON.parse((await get(instance.socketPath, "/__pikibun/status")).body) as { sessionBranch: string; gitRemotes: string };
  assert.equal(status.sessionBranch, "pikibun/s1");
  assert.match(status.gitRemotes, /pikibun\/s1 is pushed/);
  const other = await get(instance.socketPath, "/git/github.com/acme/other.git/info/refs?service=git-receive-pack");
  assert.equal(other.status, 403);
  assert.match(other.body, /pushes go only to them/);
  const gzip = await get(instance.socketPath, "/git/github.com/acme/app.git/git-receive-pack", { method: "POST", headers: { ...headers, "content-encoding": "gzip" }, body: branch });
  assert.equal(gzip.status, 415);
});

test("the relay's refusal reaches Git as text, and other repositories on allowed hosts are fetched directly", async t => {
  const { RunnerError } = await import("../apps/runner/src/protocol.js");
  const { instance } = await proxy(t, {
    grant: async () => grant({ mode: "allowlist", domains: ["github.com"] }),
    relay: async () => { throw new RunnerError(403, "GitHub did not let the session owner's account read acme/app."); },
  });
  const refused = await get(instance.socketPath, "/git/github.com/acme/app.git/info/refs?service=git-upload-pack");
  assert.equal(refused.status, 403);
  assert.equal(refused.headers["content-type"], "text/plain; charset=utf-8");
  assert.match(refused.body, /did not let the session owner's account read/);
  const other = await get(instance.socketPath, "/git/github.com/public/tool.git/info/refs?service=git-upload-pack");
  assert.equal(other.status, 302);
  assert.equal(other.headers.location, "https://github.com/public/tool.git/info/refs?service=git-upload-pack");
});

test("tunnels follow the network policy and never reach private addresses", async t => {
  const echo: Server = createTcpServer(socket => socket.pipe(socket));
  await new Promise<void>(resolve => echo.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { echo.close(() => resolve()); }));
  let policy: EgressGrant["policy"] = { mode: "off", domains: [], packageRegistries: true };
  const lookups: Record<string, string> = { "docs.example.com": "93.184.216.34", "registry.npmjs.org": "104.16.0.1", "internal.example.com": "10.0.0.8" };
  const { instance } = await proxy(t, {
    grant: async () => ({ policy, repositories: [] }),
    lookup: async host => [{ address: lookups[host] ?? "93.184.216.35", family: 4 }],
    connectTo: (echo.address() as AddressInfo).port,
  });
  const off = await tunnel(instance.socketPath, "docs.example.com:443");
  assert.equal(off.status, 403);
  assert.match(off.body!, /network access is off/);

  policy = { mode: "allowlist", domains: ["docs.example.com", "internal.example.com"], packageRegistries: false };
  const { instance: allowlist } = await proxy(t, {
    grant: async () => ({ policy, repositories: [] }),
    lookup: async host => [{ address: lookups[host] ?? "93.184.216.35", family: 4 }],
    connectTo: (echo.address() as AddressInfo).port,
  });
  const open = await tunnel(allowlist.socketPath, "docs.example.com:443");
  assert.equal(open.status, 200);
  const reply = await new Promise<string>(resolve => { open.socket!.once("data", (chunk: Buffer) => resolve(chunk.toString())); open.socket!.write("ping"); });
  assert.equal(reply, "ping");
  open.socket!.destroy();
  assert.equal((await tunnel(allowlist.socketPath, "registry.npmjs.org:443")).status, 403);
  const internal = await tunnel(allowlist.socketPath, "internal.example.com:443");
  assert.equal(internal.status, 403);
  assert.match(internal.body!, /public address/);
  assert.match((await tunnel(allowlist.socketPath, "docs.example.com:22")).body!, /port 443/);
  assert.equal((await tunnel(allowlist.socketPath, "10.0.0.1:443")).status, 403);
  const plain = await get(allowlist.socketPath, "http://docs.example.com/");
  assert.equal(plain.status, 403);
  assert.match(plain.body, /Plain HTTP/);
});

test("tunnels take a local proxy's fake-IP answers for hosts the policy names, never for any host (#248)", async t => {
  const echo: Server = createTcpServer(socket => socket.pipe(socket));
  await new Promise<void>(resolve => echo.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { echo.close(() => resolve()); }));
  const lookups: Record<string, string[]> = {
    "registry.npmjs.org": ["198.18.0.206"], "pypi.org": ["198.18.3.32"], "docs.example.com": ["198.18.0.7", "93.184.216.34"],
    "anything.example.org": ["198.18.0.9"], "mixed.example.com": ["198.18.0.10", "10.0.0.8"], "x.cdn.example.net": ["198.18.0.11"],
    "y.cdn.example.net": ["93.184.216.36"],
  };
  const connected: string[] = [];
  const open = async (policy: EgressGrant["policy"]) => {
    const directory = await mkdtemp(join(tmpdir(), "egress-"));
    const instance = new EgressProxy({
      socketPath: join(directory, "proxy.sock"),
      grant: async () => ({ policy, repositories: [] }),
      relay: async () => new Response("", { status: 404 }),
      lookup: async host => (lookups[host] ?? ["93.184.216.35"]).map(address => ({ address, family: 4 })),
      connect: (port, address) => { connected.push(address); return tcpConnect({ port: (echo.address() as AddressInfo).port, host: "127.0.0.1" }); },
    });
    await instance.start();
    t.after(async () => { await instance.close(); await rm(directory, { recursive: true, force: true }); });
    return instance;
  };
  const through = async (instance: EgressProxy, target: string) => {
    const result = await tunnel(instance.socketPath, target);
    result.socket?.destroy();
    return result;
  };

  const allowlist = await open({ mode: "allowlist", domains: ["docs.example.com", "mixed.example.com", "*.cdn.example.net"], packageRegistries: true });
  assert.equal((await through(allowlist, "registry.npmjs.org:443")).status, 200);
  assert.equal((await through(allowlist, "pypi.org:443")).status, 200);
  assert.equal((await through(allowlist, "docs.example.com:443")).status, 200);
  assert.deepEqual(connected, ["198.18.0.206", "198.18.3.32", "198.18.0.7"]);
  const mixed = await through(allowlist, "mixed.example.com:443");
  assert.equal(mixed.status, 403);
  assert.match(mixed.body!, /does not resolve to a public address/);
  assert.equal((await through(allowlist, "198.18.0.206:443")).status, 403);
  const wildcard = await through(allowlist, "x.cdn.example.net:443");
  assert.equal(wildcard.status, 403);
  assert.match(wildcard.body!, /x\.cdn\.example\.net resolves to 198\.18\.0\.11, a fake-IP address/);
  assert.equal((await through(allowlist, "y.cdn.example.net:443")).status, 200);
  assert.deepEqual(connected, ["198.18.0.206", "198.18.3.32", "198.18.0.7", "93.184.216.36"]);

  connected.length = 0;
  const anything = await open({ mode: "open", domains: [], packageRegistries: false });
  assert.equal((await through(anything, "registry.npmjs.org:443")).status, 200);
  const refused = await through(anything, "anything.example.org:443");
  assert.equal(refused.status, 403);
  assert.match(refused.body!, /anything\.example\.org resolves to 198\.18\.0\.9, a fake-IP address of a proxy on this host/);
  assert.equal((await through(anything, "public.example.org:443")).status, 200);
  assert.deepEqual(connected, ["198.18.0.206", "93.184.216.35"]);
});

function binding(id: string): RunnerBinding {
  return {
    session: { id, workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1", title: "Egress test", policyVersion: 1,
      status: "ready", createdAt: "2026-01-01T00:00:00Z", repositories: [] },
    owner: { id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice Owner",
      gitEmail: "alice@example.test", env: {}, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: "test:template-author", workspaceId: "workspace", version: 1, name: "Egress agent",
      description: "Test", instructions: "Use tools.", tools: ["bash"], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "workspace", name: "Explicit faux test provider", provider: "faux", modelId: "egress-faux" },
  };
}

const sandboxed = process.platform === "linux" && spawnSync("bwrap", ["--version"]).status === 0;

test("a sandboxed git clone of a workspace repository goes through the proxy and the relay", { skip: !sandboxed }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "egress-sandbox-"));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const projects = join(directory, "projects");
  await mkdir(join(projects, "acme"), { recursive: true });
  const work = join(directory, "upstream");
  const git = (args: string[], cwd: string) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "U", GIT_AUTHOR_EMAIL: "u@example.test", GIT_COMMITTER_NAME: "U", GIT_COMMITTER_EMAIL: "u@example.test" } });
    assert.equal(result.status, 0, result.stderr);
  };
  await mkdir(work);
  git(["init", "-q", "-b", "main"], work);
  await writeFile(join(work, "README.md"), "from upstream\n");
  git(["add", "README.md"], work);
  git(["commit", "-q", "-m", "initial"], work);
  git(["clone", "-q", "--bare", work, join(projects, "acme", "app.git")], directory);
  const server = await startGitHttpServer(projects);
  t.after(() => server.close());

  const { instance, relayed } = await proxy(t, {
    relay: async request => fetch(request.service === "info-refs"
      ? `${server.url("acme/app.git")}/info/refs?service=git-upload-pack` : `${server.url("acme/app.git")}/git-upload-pack`, {
      method: request.body ? "POST" : "GET", body: request.body,
      headers: { ...(request.contentType ? { "content-type": request.contentType } : {}), ...(request.gitProtocol ? { "git-protocol": request.gitProtocol } : {}) },
    }),
  });
  const sandbox = new Sandbox(binding("egress"), join(directory, "session"), undefined, { egressSocket: instance.socketPath });
  t.after(() => sandbox.close());
  await sandbox.initialize();
  const shell = (command: string) => sandbox.execute({ kind: "bash", command }, false, async () => {}, { allowTestShell: true });

  await shell(`test "$(ls -A /etc)" = ssl && test "$(ls -A /etc/ssl/certs)" = ca-certificates.crt && test "$SSL_CERT_FILE" = ${CA_BUNDLE}`);
  await shell("python3 -c \"import ssl, sys; sys.exit(0 if ssl.create_default_context().cert_store_stats()['x509_ca'] > 0 else 1)\"");
  await assert.rejects(shell("echo changed > /etc/ssl/certs/ca-certificates.crt"), /Read-only|Permission denied/);

  await shell("git clone -q https://github.com/acme/app.git clones/app");
  assert.equal(await sandbox.readFile("clones/app/README.md", async () => {}), "from upstream\n");
  assert.deepEqual([...new Set(relayed.map(request => request.service))].sort(), ["info-refs", "upload-pack"]);
  await shell("git ls-remote git@github.com:acme/app.git > ssh-refs.txt");
  assert.match(await sandbox.readFile("ssh-refs.txt", async () => {}), /refs\/heads\/main/);
  await assert.rejects(shell("git ls-remote https://github.com/acme/secret.git"), /not one of this workspace's repositories/);
  await assert.rejects(shell("python3 -c \"import urllib.request; urllib.request.urlopen('https://example.com', timeout=5)\""), /403|Forbidden|Tunnel/);
  assert.ok(instance.entries().some(entry => entry.kind === "connect" && entry.target.startsWith("example.com") && entry.outcome === "refused"));
});

test("a clone's commit is pushed as it is, fast-forward only", { skip: !sandboxed }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "egress-push-"));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const projects = join(directory, "projects");
  await mkdir(join(projects, "acme"), { recursive: true });
  const work = join(directory, "upstream");
  const environment = { ...process.env, GIT_AUTHOR_NAME: "U", GIT_AUTHOR_EMAIL: "u@example.test", GIT_COMMITTER_NAME: "U", GIT_COMMITTER_EMAIL: "u@example.test" };
  const git = (args: string[], cwd: string) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", env: environment });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const bare = join(projects, "acme", "app.git");
  await mkdir(work);
  git(["init", "-q", "-b", "main"], work);
  await writeFile(join(work, "README.md"), "from upstream\n");
  git(["add", "README.md"], work);
  git(["commit", "-q", "-m", "initial"], work);
  git(["clone", "-q", "--bare", work, bare], directory);
  const server = await startGitHttpServer(projects);
  t.after(() => server.close());
  const { instance } = await proxy(t, {
    relay: async request => fetch(request.service === "info-refs"
      ? `${server.url("acme/app.git")}/info/refs?service=git-upload-pack` : `${server.url("acme/app.git")}/git-upload-pack`, {
      method: request.body ? "POST" : "GET", body: request.body,
      headers: { ...(request.contentType ? { "content-type": request.contentType } : {}), ...(request.gitProtocol ? { "git-protocol": request.gitProtocol } : {}) },
    }),
  });
  const sandbox = new Sandbox(binding("clone-push"), join(directory, "session"), undefined, { egressSocket: instance.socketPath });
  t.after(() => sandbox.close());
  await sandbox.initialize();
  const authorize = async () => {};
  const shell = (command: string) => sandbox.execute({ kind: "bash", command }, false, authorize, { allowTestShell: true });
  await shell("git clone -q https://github.com/acme/app.git app && cd app && git switch -q -c feature && echo change > change.txt && git add change.txt && git commit -q -m 'Add a change'");

  const head = await sandbox.cloneHead("app", authorize);
  assert.equal(head.origin, "https://github.com/acme/app.git");
  assert.equal(repositoryForRemote([repository], head.origin!)?.bindingId, "binding-app");
  assert.equal(repositoryForRemote([repository], "git@github.com:acme/app.git")?.bindingId, "binding-app");
  assert.equal(repositoryForRemote([repository], "https://github.com/acme/other.git"), undefined);
  const operation = { kind: "git.push" as const, repository: "acme/app", directory: "app", branch: "feature", commit: head.commit };
  const credential = { remote: server.url("acme/app.git"), authorization: "Basic dXNlcjpzZWNyZXQ=" };
  const pushed = await performClonePush({ workspace: sandbox, operation, credential, authorize });
  assert.equal(pushed.outcome, "pushed");
  assert.deepEqual(pushed.commits.map(commit => commit.subject), ["Add a change"]);
  assert.equal(pushed.total, 1);
  assert.equal(git(["rev-parse", "refs/heads/feature"], bare), head.commit);
  assert.equal(git(["show", `${head.commit}:change.txt`], bare), "change");
  assert.match(pushSummary(pushed), /^Pushed 1 commit to feature \(new branch at [0-9a-f]{12}\)\.$/m);
  assert.equal((await performClonePush({ workspace: sandbox, operation, credential, authorize })).outcome, "up-to-date");

  git(["fetch", "-q", bare, "feature:feature"], work);
  git(["switch", "-q", "feature"], work);
  await writeFile(join(work, "other.txt"), "other\n");
  git(["add", "other.txt"], work);
  git(["commit", "-q", "-m", "Elsewhere"], work);
  git(["push", "-q", bare, "feature"], work);
  await shell("cd app && echo more >> change.txt && git commit -q -am 'More'");
  const next = await sandbox.cloneHead("app", authorize);
  await assert.rejects(performClonePush({ workspace: sandbox, operation: { ...operation, commit: next.commit }, credential, authorize }),
    (error: Error) => error instanceof PushError && /fetch and merge or rebase/.test(error.message));

  const mainTip = git(["rev-parse", "refs/heads/main"], bare);
  const featureTip = git(["rev-parse", "refs/heads/feature"], bare);
  await shell("cd app && git switch -q main");
  const tagged = (await sandbox.cloneHead("app", authorize)).commit;
  assert.equal(tagged, mainTip);
  const tag = { kind: "git.push" as const, repository: "acme/app", directory: "app", branch: "main", tag: "cli-v1.0.0", commit: tagged };
  const created = await performClonePush({ workspace: sandbox, operation: tag, credential, authorize });
  assert.equal(created.outcome, "pushed");
  assert.equal(git(["rev-parse", "refs/tags/cli-v1.0.0"], bare), mainTip);
  assert.equal(git(["rev-parse", "refs/heads/main"], bare), mainTip);
  assert.equal(git(["rev-parse", "refs/heads/feature"], bare), featureTip);
  assert.match(pushSummary(created), /^Created tag cli-v1\.0\.0 at [0-9a-f]{12}, on main \(at [0-9a-f]{12}\)\.$/);
  assert.equal((await performClonePush({ workspace: sandbox, operation: tag, credential, authorize })).outcome, "up-to-date");
  await assert.rejects(performClonePush({ workspace: sandbox, operation: { ...tag, tag: "cli-v1.0.1", commit: next.commit }, credential, authorize }),
    (error: Error) => error instanceof PushError && /is not on main/.test(error.message));
  await assert.rejects(performClonePush({ workspace: sandbox, operation: { ...tag, commit: next.commit }, credential, authorize }),
    (error: Error) => error instanceof PushError && /already exists .*never moved/.test(error.message));
  await assert.rejects(performClonePush({ workspace: sandbox, operation: { ...tag, branch: "missing", tag: "cli-v1.0.1" }, credential, authorize }),
    (error: Error) => error instanceof PushError && /Remote branch missing does not exist/.test(error.message));
  git(["switch", "-q", "main"], work);
  await writeFile(join(work, "later.txt"), "later\n");
  git(["add", "later.txt"], work);
  git(["commit", "-q", "-m", "Later"], work);
  git(["push", "-q", bare, "main"], work);
  await assert.rejects(performClonePush({ workspace: sandbox, operation: { ...tag, tag: "cli-v1.0.1" }, credential, authorize }),
    (error: Error) => error instanceof PushError && /fetch it first/.test(error.message));
  assert.equal(spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/tags/cli-v1.0.1"], { cwd: bare }).status, 1);
  await assert.rejects(sandbox.cloneHead("missing", authorize));
  await assert.rejects(sandbox.cloneHead("../escape", authorize), /Invalid clone directory/);
});

test("closing the proxy lets a push under way finish before its connection goes", async t => {
  let release!: () => void;
  const answered = new Promise<void>(resolve => { release = resolve; });
  const { instance } = await proxy(t, { sessionBranch: "pikibun/s1", relay: async request => {
    if (request.service === "receive-pack") { await new Response(request.body as ReadableStream).arrayBuffer(); await answered; }
    return new Response("report", { headers: { "content-type": "application/x-git-receive-pack-result" } });
  } });
  const body = pkt(`${zero} ${tip} refs/heads/pikibun/s1\0report-status\n`) + "0000PACK";
  const pushed = get(instance.socketPath, "/git/github.com/acme/app.git/git-receive-pack", { method: "POST", headers: { "content-type": "application/x-git-receive-pack-request" }, body });
  await new Promise(resolve => setTimeout(resolve, 50));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const closing = instance.close();
  t.mock.timers.tick(10 * 60_000);
  t.mock.timers.reset();
  setTimeout(release, 50);
  assert.deepEqual({ ...(await pushed), headers: undefined }, { status: 200, headers: undefined, body: "report" });
  await closing;
});

test("a sandboxed git push of the session branch goes through the proxy; other branches are rejected", { skip: !sandboxed }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "egress-branch-"));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const projects = join(directory, "projects");
  await mkdir(join(projects, "acme"), { recursive: true });
  const work = join(directory, "upstream");
  const environment = { ...process.env, GIT_AUTHOR_NAME: "U", GIT_AUTHOR_EMAIL: "u@example.test", GIT_COMMITTER_NAME: "U", GIT_COMMITTER_EMAIL: "u@example.test" };
  const git = (args: string[], cwd: string) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", env: environment });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const bare = join(projects, "acme", "app.git");
  await mkdir(work);
  git(["init", "-q", "-b", "main"], work);
  await writeFile(join(work, "README.md"), "from upstream\n");
  git(["add", "README.md"], work);
  git(["commit", "-q", "-m", "initial"], work);
  git(["clone", "-q", "--bare", work, bare], directory);
  const server = await startGitHttpServer(projects);
  t.after(() => server.close());
  const paths: Record<string, string> = { "info-refs": "info/refs?service=git-upload-pack", "upload-pack": "git-upload-pack",
    "receive-refs": "info/refs?service=git-receive-pack", "receive-pack": "git-receive-pack" };
  const { instance, relayed } = await proxy(t, { sessionBranch: "pikibun/branch-push", relay: async request => fetch(`${server.url("acme/app.git")}/${paths[request.service]}`, {
    method: request.service.endsWith("refs") ? "GET" : "POST", body: request.service.endsWith("refs") ? undefined : request.body,
    headers: { ...(request.contentType ? { "content-type": request.contentType } : {}), ...(request.gitProtocol ? { "git-protocol": request.gitProtocol } : {}) },
    ...(request.body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit) });
  const sandbox = new Sandbox(binding("branch-push"), join(directory, "session"), undefined, { egressSocket: instance.socketPath, sessionBranch: "pikibun/branch-push" });
  t.after(() => sandbox.close());
  await sandbox.initialize();
  const shell = (command: string) => sandbox.execute({ kind: "bash", command }, false, async () => {}, { allowTestShell: true });
  await shell("git clone -q https://github.com/acme/app.git app && cd app && echo change > change.txt && git add change.txt && git commit -q -m 'Add a change'"
    + ' && git push -q origin "HEAD:$PIKIBUN_SESSION_BRANCH"');
  assert.equal(git(["show", "refs/heads/pikibun/branch-push:change.txt"], bare), "change");
  assert.ok(relayed.some(request => request.service === "receive-pack"));
  await shell("cd app && echo more >> change.txt && git commit -q -am 'More' && git push -q origin HEAD:pikibun/branch-push");
  assert.equal(git(["show", "refs/heads/pikibun/branch-push:change.txt"], bare), "change\nmore");
  await shell("cd app && head -c 3000000 /dev/urandom > large.bin && git add large.bin && git commit -q -m 'Large' && git push -q origin HEAD:pikibun/branch-push");
  assert.equal(git(["cat-file", "-s", "refs/heads/pikibun/branch-push:large.bin"], bare), "3000000");
  await assert.rejects(shell("cd app && git push origin HEAD:main"), /remote rejected.*Only this session's branch pikibun\/branch-push can be pushed without approval/);
  assert.equal(git(["rev-parse", "refs/heads/main"], bare), git(["rev-parse", "main"], work));
});

test("a backup keeps a clone's local work as a bundle, and a restore clones it again and puts the work back", { skip: !sandboxed }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "egress-clone-backup-"));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const projects = join(directory, "projects");
  await mkdir(join(projects, "acme"), { recursive: true });
  const work = join(directory, "upstream");
  const environment = { ...process.env, GIT_AUTHOR_NAME: "U", GIT_AUTHOR_EMAIL: "u@example.test", GIT_COMMITTER_NAME: "U", GIT_COMMITTER_EMAIL: "u@example.test" };
  const git = (args: string[], cwd: string) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", env: environment });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  await mkdir(work);
  git(["init", "-q", "-b", "main"], work);
  await writeFile(join(work, "README.md"), "from upstream\n");
  await writeFile(join(work, ".gitignore"), "*.log\n");
  git(["add", "README.md", ".gitignore"], work);
  git(["commit", "-q", "-m", "initial"], work);
  git(["switch", "-q", "-c", "topic"], work);
  await writeFile(join(work, "topic.txt"), "topic\n");
  git(["add", "topic.txt"], work);
  git(["commit", "-q", "-m", "Topic"], work);
  git(["switch", "-q", "main"], work);
  const bare = join(projects, "acme", "app.git");
  git(["clone", "-q", "--bare", work, bare], directory);
  git(["config", "uploadpack.allowAnySHA1InWant", "true"], bare);
  const server = await startGitHttpServer(projects);
  t.after(() => server.close());
  const { instance } = await proxy(t, {
    relay: async request => fetch(request.service === "info-refs"
      ? `${server.url("acme/app.git")}/info/refs?service=git-upload-pack` : `${server.url("acme/app.git")}/git-upload-pack`, {
      method: request.body ? "POST" : "GET", body: request.body as BodyInit | undefined,
      headers: { ...(request.contentType ? { "content-type": request.contentType } : {}), ...(request.gitProtocol ? { "git-protocol": request.gitProtocol } : {}) },
    }),
  });
  const authorize = async () => {};
  const source = new Sandbox(binding("backup-source"), join(directory, "source"), undefined, { egressSocket: instance.socketPath });
  t.after(() => source.close());
  await source.initialize();
  const shell = (sandbox: Sandbox, command: string) => sandbox.execute({ kind: "bash", command }, false, authorize, { allowTestShell: true });
  await shell(source, "git clone -q https://github.com/acme/app.git app && cd app && git switch -q -c feature && echo one > one.txt && git add one.txt"
    + " && git commit -q -m 'Local commit' && git branch -q 'fix+retry' origin/topic && echo changed >> README.md && echo new > untracked.txt"
    + " && echo noise > build.log && git clone -q https://github.com/acme/app.git vendor/app && echo inner > vendor/app/inner.txt"
    + " && cd .. && mkdir -p libs && git clone -q git@github.com:acme/app.git libs/app && echo notes > notes.txt");
  const local = await source.cloneHead("app", authorize);
  const { clones, found } = await source.cloneBackup(authorize);
  assert.deepEqual(found, ["app", "app/vendor/app", "libs/app"]);
  assert.deepEqual(clones.map(clone => [clone.path, clone.origin, clone.branch, clone.bundle !== null]), [
    ["app", "https://github.com/acme/app.git", "feature", true],
    ["app/vendor/app", "https://github.com/acme/app.git", "main", true],
    ["libs/app", "git@github.com:acme/app.git", "main", false],
  ]);
  assert.equal(clones[0]!.head, local.commit);
  assert.deepEqual(clones[0]!.branches.map(([name]) => name).sort(), ["feature", "fix+retry", "main"]);
  assert.equal(clones[2]!.worktree, clones[2]!.head);
  const files = await source.snapshot(authorize, found);
  assert.ok(files.some(file => file.path === "worktree/notes.txt"));
  assert.ok(!files.some(file => file.path.startsWith("worktree/app/") || file.path.startsWith("worktree/libs/app/")));
  await shell(source, "cd app && git status --porcelain > ../status.txt && git for-each-ref --format='%(refname)' refs/pikibun > ../refs.txt");
  assert.equal(await source.readFile("status.txt", authorize), " M README.md\n?? untracked.txt\n?? vendor/\n");
  assert.equal(await source.readFile("refs.txt", authorize), "");
  git(["branch", "-q", "-D", "topic"], bare);

  const target = new Sandbox(binding("backup-target"), join(directory, "target"), undefined, { egressSocket: instance.socketPath });
  t.after(() => target.close());
  await target.initialize();
  const state = join(directory, "target", "git", "pikibun-clones");
  await mkdir(state, { recursive: true, mode: 0o700 });
  const pending = clones.map((clone, index) => {
    const { bundle, ...rest } = clone;
    return { ...rest, bundle: bundle === null ? null : `${index}.bundle` };
  });
  for (const [index, clone] of clones.entries()) if (clone.bundle) await writeFile(join(state, `${index}.bundle`), Buffer.from(clone.bundle, "base64"));
  await writeFile(join(state, "manifest.json"), JSON.stringify({ version: 1, clones: pending }));
  assert.deepEqual(await target.clonePending(authorize), clones.map(clone => ({ path: clone.path, origin: clone.origin })));
  const url = "https://github.com/acme/app.git";
  await target.cloneRestore("app", url, null, authorize);
  await target.cloneRestore("app/vendor/app", url, null, authorize);
  assert.deepEqual(await target.clonePending(authorize), [{ path: "libs/app", origin: "git@github.com:acme/app.git" }]);
  await shell(target, "cd app && git status --porcelain > ../status.txt && git rev-parse --abbrev-ref HEAD > ../branch.txt && git log --format=%s -1 > ../log.txt"
    + " && git for-each-ref --format='%(refname)' refs/heads refs/pikibun > ../refs.txt && git log --format=%s -1 fix+retry > ../topic.txt");
  assert.equal(await target.readFile("status.txt", authorize), " M README.md\n?? untracked.txt\n?? vendor/\n");
  assert.equal(await target.readFile("branch.txt", authorize), "feature\n");
  assert.equal(await target.readFile("log.txt", authorize), "Local commit\n");
  assert.equal(await target.readFile("refs.txt", authorize), "refs/heads/feature\nrefs/heads/fix+retry\nrefs/heads/main\n");
  assert.equal(await target.readFile("topic.txt", authorize), "Topic\n");
  assert.equal(await target.readFile("app/untracked.txt", authorize), "new\n");
  assert.equal(await target.readFile("app/vendor/app/inner.txt", authorize), "inner\n");
  await assert.rejects(target.readFile("app/build.log", authorize));
  await shell(target, "mkdir -p libs && echo mine > libs/app");
  await assert.rejects(target.cloneRestore("libs/app", url, null, authorize));
  assert.equal((await target.clonePending(authorize)).length, 1);
  assert.equal(await target.readFile("libs/app", authorize), "mine\n");
  const again = await target.cloneBackup(authorize);
  assert.deepEqual(again.found, ["app", "app/vendor/app"]);
  assert.deepEqual(again.clones.map(clone => [clone.path, clone.branch, clone.origin]),
    [["app", "feature", url], ["app/vendor/app", "main", url], ["libs/app", "main", "git@github.com:acme/app.git"]]);
  assert.equal(again.clones[2]!.bundle, null);
  assert.ok((await target.snapshot(authorize, again.found)).some(file => file.path === "worktree/libs/app"));
  await shell(target, "rm libs/app && mkdir -p libs/.app.pikibun-restore/.git && echo stale > libs/.app.pikibun-restore/stale");
  await target.cloneRestore("libs/app", url, null, authorize);
  assert.deepEqual(await target.clonePending(authorize), []);
  assert.match(await shell(target, "cd libs/app && git config --get remote.origin.url && git status --porcelain && ls -a .. | grep -c pikibun-restore || true"),
    /^git@github\.com:acme\/app\.git\n0\n$/);
  await writeFile(join(state, "manifest.json"), JSON.stringify({ version: 1, clones: [pending[2]] }));
  await writeFile(join(directory, "target", "worktree", "libs", "app", ".git", "pikibun-restored"), `${clones[2]!.worktree}\n`);
  await target.cloneRestore("libs/app", url, null, authorize);
  assert.deepEqual(await target.clonePending(authorize), []);
  await assert.rejects(lstat(join(directory, "target", "worktree", "libs", "app", ".git", "pikibun-restored")), { code: "ENOENT" });
});

test("a backup keeps local changes to LFS-tracked files as their content, not as pointers to objects it doesn't carry", { skip: !sandboxed }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "egress-lfs-backup-"));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const projects = join(directory, "projects");
  await mkdir(join(projects, "acme"), { recursive: true });
  const work = join(directory, "upstream");
  const environment = { ...process.env, GIT_AUTHOR_NAME: "U", GIT_AUTHOR_EMAIL: "u@example.test", GIT_COMMITTER_NAME: "U", GIT_COMMITTER_EMAIL: "u@example.test" };
  const git = (args: string[], cwd: string) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", env: environment });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  await mkdir(work);
  git(["init", "-q", "-b", "main"], work);
  await writeFile(join(work, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
  await writeFile(join(work, "model.bin"), "upstream\n");
  git(["add", ".gitattributes", "model.bin"], work);
  git(["commit", "-q", "-m", "initial"], work);
  git(["clone", "-q", "--bare", work, join(projects, "acme", "app.git")], directory);
  const server = await startGitHttpServer(projects);
  t.after(() => server.close());
  const { instance } = await proxy(t, {
    relay: async request => fetch(request.service === "info-refs"
      ? `${server.url("acme/app.git")}/info/refs?service=git-upload-pack` : `${server.url("acme/app.git")}/git-upload-pack`, {
      method: request.body ? "POST" : "GET", body: request.body as BodyInit | undefined,
      headers: { ...(request.contentType ? { "content-type": request.contentType } : {}), ...(request.gitProtocol ? { "git-protocol": request.gitProtocol } : {}) },
    }),
  });
  const authorize = async () => {};
  const shell = (sandbox: Sandbox, command: string) => sandbox.execute({ kind: "bash", command }, false, authorize, { allowTestShell: true });
  const source = new Sandbox(binding("lfs-backup-source"), join(directory, "source"), undefined, { egressSocket: instance.socketPath });
  t.after(() => source.close());
  await source.initialize();
  await shell(source, "git clone -q https://github.com/acme/app.git app && cd app"
    + " && git config filter.lfs.clean \"sh -c 'cat >/dev/null; echo pointer'\" && git config filter.lfs.required true"
    + " && echo local > model.bin");
  const { clones } = await source.cloneBackup(authorize);
  assert.equal(clones.length, 1);
  assert.notEqual(clones[0]!.bundle, null);

  const target = new Sandbox(binding("lfs-backup-target"), join(directory, "target"), undefined, { egressSocket: instance.socketPath });
  t.after(() => target.close());
  await target.initialize();
  const state = join(directory, "target", "git", "pikibun-clones");
  await mkdir(state, { recursive: true, mode: 0o700 });
  await writeFile(join(state, "0.bundle"), Buffer.from(clones[0]!.bundle!, "base64"));
  await writeFile(join(state, "manifest.json"), JSON.stringify({ version: 1, clones: [{ ...clones[0]!, bundle: "0.bundle" }] }));
  await target.cloneRestore("app", "https://github.com/acme/app.git", null, authorize);
  assert.equal(await target.readFile("app/model.bin", authorize), "local\n");
  assert.match(await shell(target, "cd app && git status --porcelain"), /^ M model\.bin\n$/);
});

test("https://user@host remotes are the same repository, and a refused grant ends access at once", async t => {
  const { RunnerError } = await import("../apps/runner/src/protocol.js");
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  let refuse = false;
  const { instance, relayed } = await proxy(t, {
    grant: async () => { if (refuse) throw new RunnerError(403, "Archived sessions have no network access."); return grant({ mode: "open" }); },
  });
  assert.equal((await get(instance.socketPath, "/git/someone@github.com/acme/app.git/info/refs?service=git-upload-pack")).status, 200);
  assert.equal(relayed[0]!.bindingId, "binding-app");
  refuse = true;
  assert.equal((await get(instance.socketPath, "/git/github.com/acme/app.git/info/refs?service=git-upload-pack")).status, 200);
  t.mock.timers.tick(61_000);
  const refused = await get(instance.socketPath, "/git/github.com/acme/app.git/info/refs?service=git-upload-pack");
  assert.equal(refused.status, 403);
  assert.match(refused.body, /Archived sessions/);
  assert.equal(relayed.length, 2);
});

test("a tunnel tries the host's next address when one can't be reached", async t => {
  const echo: Server = createTcpServer(socket => socket.pipe(socket));
  await new Promise<void>(resolve => echo.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { echo.close(() => resolve()); }));
  const tried: string[] = [];
  const directory = await mkdtemp(join(tmpdir(), "egress-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const instance = new EgressProxy({
    socketPath: join(directory, "proxy.sock"),
    grant: async () => ({ policy: { mode: "open", domains: [], packageRegistries: true }, repositories: [] }),
    relay: async () => { throw new Error("unused"); },
    lookup: async () => [{ address: "2606:4700::6810:1", family: 6 }, { address: "104.16.0.1", family: 4 }],
    connect: (_port, address) => { tried.push(address); return tcpConnect({ port: address.includes(":") ? 1 : (echo.address() as AddressInfo).port, host: "127.0.0.1" }); },
  });
  await instance.start();
  t.after(() => instance.close());
  const open = await tunnel(instance.socketPath, "registry.npmjs.org:443");
  assert.equal(open.status, 200);
  assert.deepEqual(tried, ["2606:4700::6810:1", "104.16.0.1"]);
  open.socket!.destroy();
});

test("a client that drops while its tunnel is being set up doesn't take the proxy down", async t => {
  const pending = Promise.withResolvers<EgressGrant>();
  const { instance } = await proxy(t, { grant: () => pending.promise });
  const request = httpRequest({ socketPath: instance.socketPath, method: "CONNECT", path: "docs.example.com:443" });
  request.on("error", () => {});
  request.end();
  await new Promise(resolve => setTimeout(resolve, 50));
  request.destroy();
  await new Promise(resolve => setTimeout(resolve, 50));
  pending.resolve(grant());
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await get(instance.socketPath, "/__pikibun/status")).status, 200);
});
