import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EgressProxy, endpointUrl, LFS_AUTHORIZATION_MS, parseEgressGrant, type RelayRequest } from "../apps/runner/src/egress.js";
import { hostGitLfs } from "../apps/runner/src/sandbox.js";
import { LfsObjectCache } from "../apps/runner/src/lfs-cache.js";
import { RunnerError } from "../apps/runner/src/protocol.js";
import { RepositoryCache } from "../apps/runner/src/repo-cache.js";
import type { EgressGrant, EgressRepository } from "../packages/shared/src/network.js";

const repository = { bindingId: "binding-app", provider: "github", host: "github.com", repositoryId: "1701", fullName: "acme/app" } as const;
const lfsRepository = { ...repository, lfs: true } as const;
const oid = "a".repeat(64), missing = "b".repeat(64);
const batchPath = "/git/github.com/acme/app.git/info/lfs/objects/batch";

function grant(repositories: EgressRepository[]): EgressGrant {
  return { policy: { mode: "off", domains: [], packageRegistries: true }, repositories };
}

async function proxy(t: TestContext, options: { grant: () => Promise<EgressGrant>; relay?: (request: RelayRequest) => Promise<Response>; lfsCache?: LfsObjectCache; tcp?: boolean }) {
  const directory = await mkdtemp(join(tmpdir(), "egress-lfs-"));
  const relayed: RelayRequest[] = [];
  const instance = new EgressProxy({
    socketPath: join(directory, "proxy.sock"),
    ...(options.lfsCache ? { lfsCache: options.lfsCache } : {}),
    ...(options.tcp ? { tcp: { token: "session-token" } } : {}),
    grant: options.grant,
    relay: async request => {
      relayed.push(request);
      if (options.relay) return options.relay(request);
      return new Response("advertisement", { headers: { "content-type": "application/x-git-upload-pack-advertisement" } });
    },
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
  });
  await instance.start();
  t.after(async () => { await instance.close(); await rm(directory, { recursive: true, force: true }); });
  return { instance, relayed };
}

function send(socketPath: string, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: IncomingMessage["headers"]; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ socketPath, path, method: init.method ?? "GET", headers: init.headers }, response => {
      const chunks: Buffer[] = [];
      response.on("error", reject);
      response.on("aborted", () => reject(new Error("aborted")));
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end(init.body);
  });
}

function batch(socketPath: string, path: string, body: unknown) {
  return send(socketPath, path, { method: "POST", headers: { "content-type": "application/vnd.git-lfs+json; charset=utf-8", accept: "application/vnd.git-lfs+json" }, body: JSON.stringify(body) });
}
function message(response: { body: string }): string {
  return (JSON.parse(response.body) as { message: string }).message;
}
function lfsQuery(socketPath: string, remote: string) {
  return send(socketPath, `/__pikibun/lfs?remote=${encodeURIComponent(remote)}`).then(response => JSON.parse(response.body) as { lfs: boolean });
}
function relayedBody(request: RelayRequest): unknown {
  return JSON.parse(Buffer.from(request.body as Uint8Array).toString("utf8"));
}

test("grants carry each repository's Git LFS setting, as a boolean only", () => {
  const policy = { mode: "off", domains: [], packageRegistries: true } as const;
  assert.deepEqual(parseEgressGrant({ policy, repositories: [lfsRepository] }).repositories[0], lfsRepository);
  assert.equal(parseEgressGrant({ policy, repositories: [{ ...repository, lfs: false }] }).repositories[0]!.lfs, undefined);
  assert.equal(parseEgressGrant({ policy, repositories: [repository] }).repositories[0]!.lfs, undefined);
  assert.throws(() => parseEgressGrant({ policy, repositories: [{ ...repository, lfs: "yes" }] }), /Invalid repositories/);
});

test("Git LFS requests of a repository with LFS off are refused in git-lfs's own format, without reaching the relay", async t => {
  const { instance, relayed } = await proxy(t, { grant: async () => grant([repository]) });
  const refused = await batch(instance.socketPath, batchPath, { operation: "download", transfers: ["basic"], objects: [{ oid, size: 3 }] });
  assert.equal(refused.status, 403);
  assert.equal(refused.headers["content-type"], "application/vnd.git-lfs+json");
  assert.match(message(refused), /Git LFS is off for acme\/app/);
  assert.equal((await send(instance.socketPath, `/git/github.com/acme/app.git/info/lfs/objects/${oid}?size=3`)).status, 403);
  assert.deepEqual(await lfsQuery(instance.socketPath, "https://github.com/acme/app.git"), { lfs: false });
  assert.equal(relayed.length, 0);
});

test("Git LFS downloads go through the relay, and git-lfs is pointed back at the proxy, never at the provider", async t => {
  const { instance, relayed } = await proxy(t, {
    grant: async () => grant([lfsRepository]),
    relay: async request => request.service === "lfs-batch"
      ? Response.json({ objects: [{ oid, size: 3, download: true }, { oid: missing, size: 5, download: false, error: { code: 404, message: "Object does not exist on the server" } }] })
      : new Response("big", { headers: { "content-type": "application/octet-stream" } }),
  });
  for (const remote of ["https://github.com/acme/app.git", "git@github.com:acme/app.git", "http://127.0.0.1:41080/git/github.com/ACME/app"]) {
    assert.deepEqual(await lfsQuery(instance.socketPath, remote), { lfs: true }, remote);
  }
  assert.deepEqual(await lfsQuery(instance.socketPath, "https://github.com/acme/other.git"), { lfs: false });

  const answer = await batch(instance.socketPath, batchPath, {
    operation: "download", transfers: ["lfs-standalone-file", "basic", "ssh"], ref: { name: "refs/heads/main" }, hash_algo: "sha256",
    objects: [{ oid, size: 3 }, { oid: missing, size: 5 }],
  });
  assert.equal(answer.status, 200);
  assert.equal(answer.headers["content-type"], "application/vnd.git-lfs+json");
  assert.deepEqual(JSON.parse(answer.body), {
    transfer: "basic", hash_algo: "sha256",
    objects: [
      { oid, size: 3, authenticated: true, actions: { download: { href: `http://127.0.0.1:41080/git/github.com/acme/app.git/info/lfs/objects/${oid}?size=3` } } },
      { oid: missing, size: 5, error: { code: 404, message: "Object does not exist on the server" } },
    ],
  });
  assert.deepEqual([relayed[0]!.bindingId, relayed[0]!.service, relayed[0]!.contentType], ["binding-app", "lfs-batch", "application/json"]);
  assert.deepEqual(relayedBody(relayed[0]!), { objects: [{ oid, size: 3 }, { oid: missing, size: 5 }], ref: "refs/heads/main" });

  const object = await send(instance.socketPath, `/git/github.com/acme/app.git/info/lfs/objects/${oid}?size=3`);
  assert.equal(object.status, 200);
  assert.equal(object.body, "big");
  assert.equal(object.headers["content-type"], "application/octet-stream");
  assert.deepEqual([relayed[1]!.service, relayedBody(relayed[1]!)], ["lfs-object", { oid, size: 3 }]);
  assert.equal(relayed.length, 2);
  const status = JSON.parse((await send(instance.socketPath, "/__pikibun/status")).body) as { lfs: string[] };
  assert.deepEqual(status.lfs, ["https://github.com/acme/app.git"]);
});

test("Git LFS uploads, locks, other repositories and malformed requests are refused before the relay", async t => {
  const { instance, relayed } = await proxy(t, { grant: async () => grant([lfsRepository]) });
  const upload = await batch(instance.socketPath, batchPath, { operation: "upload", objects: [{ oid, size: 3 }] });
  assert.equal(upload.status, 403);
  assert.match(message(upload), /uploads are not supported/);
  const locks = await batch(instance.socketPath, "/git/github.com/acme/app.git/info/lfs/locks/verify", { ref: { name: "refs/heads/main" } });
  assert.equal(locks.status, 403);
  assert.match(message(locks), /uploads and locks are not supported/);
  const other = await batch(instance.socketPath, "/git/github.com/acme/other.git/info/lfs/objects/batch", { operation: "download", objects: [{ oid, size: 3 }] });
  assert.equal(other.status, 403);
  assert.match(message(other), /not one of this workspace's repositories/);
  assert.equal((await batch(instance.socketPath, batchPath, { operation: "download", transfers: ["ssh"], objects: [{ oid, size: 3 }] })).status, 422);
  assert.equal((await batch(instance.socketPath, batchPath, { operation: "download", hash_algo: "sha1", objects: [{ oid, size: 3 }] })).status, 422);
  assert.equal((await batch(instance.socketPath, batchPath, { operation: "download", objects: [{ oid: "not-a-sha256", size: 3 }] })).status, 422);
  assert.equal((await batch(instance.socketPath, batchPath, { operation: "download", objects: Array.from({ length: 101 }, () => ({ oid, size: 3 })) })).status, 413);
  assert.equal((await send(instance.socketPath, batchPath, { method: "POST", body: "{" })).status, 400);
  assert.equal((await send(instance.socketPath, batchPath)).status, 405);
  assert.equal((await send(instance.socketPath, `/git/github.com/acme/app.git/info/lfs/objects/${oid}?size=-1`)).status, 400);
  assert.equal((await send(instance.socketPath, `/git/github.com/acme/app.git/info/lfs/objects/${oid}`)).status, 400);
  assert.equal(relayed.length, 0);
});

test("a repository whose path looks like an LFS endpoint is still fetched with Git", async t => {
  const named = { bindingId: "binding-info", provider: "github", host: "github.com", repositoryId: "1702", fullName: "info/lfs" } as const;
  const { instance, relayed } = await proxy(t, { grant: async () => grant([named]) });
  assert.equal((await send(instance.socketPath, "/git/github.com/info/lfs/info/refs?service=git-upload-pack")).status, 200);
  assert.deepEqual(relayed.map(request => [request.bindingId, request.service]), [["binding-info", "info-refs"]]);
});

test("the relay's refusal of an LFS request reaches git-lfs as its message", async t => {
  const { instance } = await proxy(t, {
    grant: async () => grant([lfsRepository]),
    relay: async () => { throw new RunnerError(403, "Git LFS is off for acme/app in this workspace"); },
  });
  const refused = await batch(instance.socketPath, batchPath, { operation: "download", objects: [{ oid, size: 3 }] });
  assert.equal(refused.status, 403);
  assert.equal(refused.headers["content-type"], "application/vnd.git-lfs+json");
  assert.match(message(refused), /Git LFS is off/);
});

const content = "big", contentOid = sha256(content);
const objectPath = `/git/github.com/acme/app.git/info/lfs/objects/${contentOid}?size=3`;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function lfsStore(t: TestContext): Promise<LfsObjectCache> {
  const root = await mkdtemp(join(tmpdir(), "egress-lfs-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return new LfsObjectCache(join(root, "lfs"));
}

function lfsRelay(body = content, download = true) {
  return async (request: RelayRequest) => request.service === "lfs-batch"
    ? Response.json({ objects: (relayedBody(request) as { objects: { oid: string; size: number }[] }).objects.map(object => ({ ...object, download })) })
    : new Response(body, { headers: { "content-type": "application/octet-stream" } });
}

function download(socketPath: string) {
  return batch(socketPath, batchPath, { operation: "download", transfers: ["basic"], objects: [{ oid: contentOid, size: 3 }] });
}

async function put(store: LfsObjectCache, body: string, object = { oid: sha256(body), size: Buffer.byteLength(body) }): Promise<boolean> {
  const writer = await store.writer(object);
  await writer.write(Buffer.from(body));
  return writer.commit();
}

test("a Git LFS file one session downloaded is served to the next from the host cache, once that session's own batch allowed it", async t => {
  const cache = await lfsStore(t);
  const first = await proxy(t, { grant: async () => grant([lfsRepository]), relay: lfsRelay(), lfsCache: cache });
  assert.equal((await download(first.instance.socketPath)).status, 200);
  assert.equal((await send(first.instance.socketPath, objectPath)).body, content);
  assert.deepEqual(first.relayed.map(request => request.service), ["lfs-batch", "lfs-object"]);
  assert.equal(await readFile(cache.path(contentOid), "utf8"), content, "the relayed download is kept, under its oid");
  assert.deepEqual(await readdir(join(cache.root, "tmp")), []);

  const second = await proxy(t, { grant: async () => grant([lfsRepository]), relay: lfsRelay(), lfsCache: cache });
  assert.equal((await send(second.instance.socketPath, objectPath)).body, content);
  assert.deepEqual(second.relayed.map(request => request.service), ["lfs-object"], "without a batch of its own, the session's download is relayed");
  assert.equal((await download(second.instance.socketPath)).status, 200);
  const cached = await send(second.instance.socketPath, objectPath);
  assert.equal(cached.status, 200);
  assert.equal(cached.body, content);
  assert.equal(cached.headers["content-length"], "3");
  assert.deepEqual(second.relayed.map(request => request.service), ["lfs-object", "lfs-batch"], "the cached copy needs no download");
  assert.ok(second.instance.entries().some(entry => entry.reason === `lfs object ${contentOid.slice(0, 12)} (host cache)`));

  const off = await proxy(t, { grant: async () => grant([repository]), relay: lfsRelay(), lfsCache: cache });
  assert.equal((await send(off.instance.socketPath, objectPath)).status, 403, "LFS off for the repository: nothing from the cache either");
  const other = { ...lfsRepository, bindingId: "binding-other", repositoryId: "1702", fullName: "acme/other" };
  const elsewhere = await proxy(t, { grant: async () => grant([lfsRepository, other]), relay: lfsRelay(), lfsCache: cache });
  assert.equal((await batch(elsewhere.instance.socketPath, "/git/github.com/acme/other.git/info/lfs/objects/batch",
    { operation: "download", objects: [{ oid: contentOid, size: 3 }] })).status, 200);
  assert.equal((await send(elsewhere.instance.socketPath, objectPath)).body, content);
  assert.deepEqual(elsewhere.relayed.map(request => request.service), ["lfs-batch", "lfs-object"], "a batch of another repository allows nothing of this one");
});

test("the host cache keeps only a download that matches its oid and size, and drops a damaged copy", async t => {
  const cache = await lfsStore(t);
  const wrong = await proxy(t, { grant: async () => grant([lfsRepository]), relay: lfsRelay("bad"), lfsCache: cache });
  await download(wrong.instance.socketPath);
  assert.equal((await send(wrong.instance.socketPath, objectPath)).body, "bad");
  await assert.rejects(stat(cache.path(contentOid)), { code: "ENOENT" });
  const short = await proxy(t, { grant: async () => grant([lfsRepository]), relay: lfsRelay("bi"), lfsCache: cache });
  await download(short.instance.socketPath);
  await send(short.instance.socketPath, objectPath).catch(() => undefined);
  await assert.rejects(stat(cache.path(contentOid)), { code: "ENOENT" });
  assert.deepEqual(await readdir(join(cache.root, "tmp")), []);

  assert.equal(await put(cache, content), true);
  await writeFile(cache.path(contentOid), "bag");
  const damaged = await proxy(t, { grant: async () => grant([lfsRepository]), relay: lfsRelay(), lfsCache: cache });
  await download(damaged.instance.socketPath);
  await assert.rejects(send(damaged.instance.socketPath, objectPath), "a damaged copy ends the download, so git-lfs tries again");
  await assert.rejects(stat(cache.path(contentOid)), { code: "ENOENT" });
  assert.equal((await send(damaged.instance.socketPath, objectPath)).body, content);
  assert.deepEqual(damaged.relayed.map(request => request.service), ["lfs-batch", "lfs-object"]);
  assert.equal(await readFile(cache.path(contentOid), "utf8"), content);
});

test("a batch allows cached downloads only of the objects the provider said can be downloaded, and only for a while", async t => {
  const cache = await lfsStore(t);
  assert.equal(await put(cache, content), true);
  const refused = await proxy(t, { grant: async () => grant([lfsRepository]), relay: lfsRelay(content, false), lfsCache: cache });
  await download(refused.instance.socketPath);
  await send(refused.instance.socketPath, objectPath);
  assert.deepEqual(refused.relayed.map(request => request.service), ["lfs-batch", "lfs-object"]);
  await send(refused.instance.socketPath, objectPath.replace("size=3", "size=4")).catch(() => undefined);
  assert.equal(refused.relayed.at(-1)!.service, "lfs-object", "another size is another object");

  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const later = await proxy(t, { grant: async () => grant([lfsRepository]), relay: lfsRelay(), lfsCache: cache });
  await download(later.instance.socketPath);
  await send(later.instance.socketPath, objectPath);
  assert.deepEqual(later.relayed.map(request => request.service), ["lfs-batch"]);
  t.mock.timers.setTime(Date.now() + LFS_AUTHORIZATION_MS + 1);
  await send(later.instance.socketPath, objectPath);
  assert.deepEqual(later.relayed.map(request => request.service), ["lfs-batch", "lfs-object"], "an old batch allows nothing any more");
});

test("the host's Git LFS store follows the cache's scope, keeps only verified files and prunes those unused for longer", async t => {
  const root = await mkdtemp(join(tmpdir(), "lfs-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const shared = new RepositoryCache({ root: join(root, "cache") });
  const store = shared.lfsObjects("test:alice");
  assert.equal(store.root, join(root, "cache", "lfs"));
  assert.equal(shared.lfsObjects("test:bob").root, store.root);
  const owned = new RepositoryCache({ root: join(root, "cache"), scope: "owner" });
  assert.notEqual(owned.lfsObjects("test:alice").root, owned.lfsObjects("test:bob").root);
  assert.match(owned.lfsObjects("test:alice").root, /[/\\]owners[/\\][0-9a-f]{32}[/\\]lfs$/);
  assert.throws(() => store.path("../../etc/passwd"), /Invalid Git LFS object id/);

  assert.equal(await put(store, "bad", { oid: contentOid, size: 3 }), false);
  assert.equal(await put(store, "bigger", { oid: contentOid, size: 3 }), false);
  assert.equal(await put(store, "bi", { oid: contentOid, size: 3 }), false);
  assert.deepEqual(await readdir(join(store.root, "tmp")), []);
  assert.equal(await store.open({ oid: contentOid, size: 3 }), undefined);
  assert.equal(await put(store, content), true);
  assert.equal(await put(owned.lfsObjects("test:alice"), "other"), true);
  assert.equal((await stat(store.root)).mode & 0o077, 0);

  assert.equal(await store.open({ oid: contentOid, size: 4 }), undefined, "another size is another object");
  assert.equal(await readFile(store.path(contentOid), "utf8"), content, "and leaves the file alone");
  assert.deepEqual(await shared.list(), [], "the LFS store is not a mirror");
  assert.deepEqual(await shared.lfsUsage(), { objects: 2, bytes: 8 });

  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  await utimes(store.path(contentOid), old, old);
  const handle = await store.open({ oid: contentOid, size: 3 });
  assert.ok(handle, "a cached file opens");
  await handle.close();
  assert.ok(Date.now() - (await stat(store.path(contentOid))).mtimeMs < 60_000, "and counts as used");
  await utimes(store.path(contentOid), old, old);
  assert.deepEqual(await shared.pruneLfs(24 * 60 * 60 * 1000), { objects: 1, bytes: 3 });
  assert.deepEqual(await shared.lfsUsage(), { objects: 1, bytes: 5 });
  assert.deepEqual(await shared.pruneLfs(0), { objects: 1, bytes: 5 });
  await assert.rejects(shared.pruneLfs(-1), /Invalid prune age/);

  const writing = await store.writer({ oid: contentOid, size: 3 });
  await writing.write(Buffer.from("b"));
  const [partial] = await readdir(join(store.root, "tmp"));
  await shared.pruneLfs(0);
  assert.deepEqual(await readdir(join(store.root, "tmp")), [partial], "a download under way survives a prune");
  const idle = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await utimes(join(store.root, "tmp", partial!), idle, idle);
  await shared.pruneLfs(0);
  assert.deepEqual(await readdir(join(store.root, "tmp")), [], "one idle for over an hour doesn't");
  await writing.abort();

  assert.equal(await put(store, content), true);
  const stale = (await store.open({ oid: contentOid, size: 3 }))!;
  assert.equal(await put(store, content), true, "another session's download replaces the file");
  await store.discard(contentOid, stale);
  await stale.close();
  assert.equal(await readFile(store.path(contentOid), "utf8"), content, "discarding the copy one read leaves a newer one alone");
  const current = (await store.open({ oid: contentOid, size: 3 }))!;
  await store.discard(contentOid, current);
  await current.close();
  await assert.rejects(stat(store.path(contentOid)), { code: "ENOENT" });

  assert.equal(await put(store, content), true);
  await chmod(store.root, 0o755);
  assert.equal(await store.open({ oid: contentOid, size: 3 }), undefined, "a store others can open serves nothing");
  await assert.rejects(store.writer({ oid: contentOid, size: 3 }), /private directory/);
  await chmod(store.root, 0o700);
});

test("over TCP, git-lfs is sent back to the session's own port, with its credentials", async t => {
  const { instance } = await proxy(t, { tcp: true, grant: async () => grant([lfsRepository]), relay: lfsRelay() });
  const { port, token } = instance.endpoint!;
  const authorization = `Basic ${Buffer.from(`pikibun:${token}`).toString("base64")}`;
  const answer = await fetch(`http://127.0.0.1:${port}${batchPath}`, { method: "POST", headers: { authorization, "content-type": "application/vnd.git-lfs+json" },
    body: JSON.stringify({ operation: "download", objects: [{ oid: contentOid, size: 3 }] }) });
  const action = (await answer.json() as { objects: { actions: { download: { href: string; header: Record<string, string> } } }[] }).objects[0]!.actions.download;
  assert.deepEqual(action, { href: `http://127.0.0.1:${port}/git/github.com/acme/app.git/info/lfs/objects/${contentOid}?size=3`, header: { Authorization: authorization } });
  assert.equal(await (await fetch(action.href, { headers: action.header })).text(), content);
  assert.equal((await fetch(action.href)).status, 401);
});

test("a session's git-lfs downloads through its own proxy endpoint, and the next session's git-lfs takes the file from the host cache", { skip: !hostGitLfs() && "needs git-lfs" }, async t => {
  const cache = await lfsStore(t);
  const work = await mkdtemp(join(tmpdir(), "egress-lfs-git-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const body = "large file ".repeat(20_000), object = { oid: sha256(body), size: Buffer.byteLength(body) };
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: work, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", LANG: "C" };
  const git = (cwd: string, ...args: string[]) => promisify(execFile)("git", args, { cwd, env, timeout: 60_000 });
  const source = join(work, "source");
  await git(work, "init", "--quiet", "-b", "main", source);
  await writeFile(join(source, ".gitattributes"), "asset.bin filter=lfs diff=lfs merge=lfs -text\n");
  await writeFile(join(source, "asset.bin"), `version https://git-lfs.github.com/spec/v1\noid sha256:${object.oid}\nsize ${object.size}\n`);
  await git(source, "add", ".");
  await git(source, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "Add an LFS file");

  const sessions: RelayRequest[][] = [];
  for (const name of ["first", "second"]) {
    const { instance, relayed } = await proxy(t, { tcp: true, grant: async () => grant([lfsRepository]), relay: lfsRelay(body), lfsCache: cache });
    const clone = join(work, name);
    await git(work, "clone", "--quiet", source, clone);
    await git(clone, "config", "lfs.url", `${endpointUrl(instance.endpoint!)}/git/github.com/acme/app.git/info/lfs`);
    await git(clone, "lfs", "install", "--local");
    await git(clone, "lfs", "pull");
    assert.equal(sha256(await readFile(join(clone, "asset.bin"), "utf8")), object.oid, name);
    sessions.push(relayed);
  }
  assert.deepEqual(sessions.map(relayed => relayed.map(request => request.service)), [["lfs-batch", "lfs-object"], ["lfs-batch"]]);
});

test("an invalid answer from the control plane is refused rather than passed to git-lfs", async t => {
  const { instance } = await proxy(t, {
    grant: async () => grant([lfsRepository]),
    relay: async () => Response.json({ objects: [{ oid, size: 3, download: true }, { oid: missing, size: 5, download: true }] }),
  });
  const refused = await batch(instance.socketPath, batchPath, { operation: "download", objects: [{ oid, size: 3 }] });
  assert.equal(refused.status, 502);
  assert.match(message(refused), /invalid Git LFS answer/);
});
