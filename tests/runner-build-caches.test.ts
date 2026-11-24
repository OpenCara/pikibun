import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { BuildCacheStore, BUILD_CACHE_FRESH_MS, BUILD_CACHE_STALE_MS, ownerDirectoryName, sandboxBuildCacheTarget, SessionBuildCacheMounts, type BuildCacheMount } from "../apps/runner/src/build-caches.js";
import { HelperWorkspace } from "../apps/runner/src/helper-workspace.js";
import { probeBuildCacheStorage } from "../apps/runner/src/resources.js";
import { Sandbox } from "../apps/runner/src/sandbox.js";
import { seatbeltProfile } from "../apps/runner/src/seatbelt.js";
import { serviceLimits, serviceSocketDirectory } from "../apps/runner/src/session-service.js";
import type { SessionBuildCaches } from "../packages/shared/src/build-caches.js";
import { binding, linuxSandboxMissing, python, Unconfined } from "./helpers/workspaces.js";

const pythonMissing = existsSync("/usr/bin/python3") ? undefined : "/usr/bin/python3 is not installed";

async function scratch(t: TestContext, prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("a host keeps each workspace's shared copy of a build cache apart from each owner's, in private directories it makes itself", async t => {
  const root = join(await scratch(t, "build-caches-"), "build-caches");
  const store = new BuildCacheStore(root);
  const shared = await store.prepare("workspace-1", { name: "ccache", scope: "shared" }, "test:alice");
  const alice = await store.prepare("workspace-1", { name: "ccache", scope: "owner" }, "test:alice");
  const bob = await store.prepare("workspace-1", { name: "ccache", scope: "owner" }, "test:bob");
  const other = await store.prepare("workspace-2", { name: "ccache", scope: "shared" }, "test:alice");
  assert.equal(shared, join(root, "workspace-1", "ccache", "shared"));
  assert.equal(alice, join(root, "workspace-1", "ccache", "owners", ownerDirectoryName("test:alice")));
  assert.notEqual(alice, bob);
  assert.notEqual(shared, other, "workspaces never share");
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(shared)).mode & 0o777, 0o700);
  assert.match(store.directory("work/../space", { name: "x", scope: "shared" }, "o"), /\/h-[0-9a-f]{32}\/x\/shared$/, "an id that can't name a directory is hashed");
  assert.throws(() => store.directory("w", { name: "../x", scope: "shared" }, "o"), /Invalid build cache name/);
  assert.equal(sandboxBuildCacheTarget("ccache"), "/build-caches/ccache");

  await rm(join(root, "workspace-3"), { recursive: true, force: true });
  await mkdir(join(root, "workspace-3"), { mode: 0o700 });
  await symlink(tmpdir(), join(root, "workspace-3", "ccache"));
  await assert.rejects(store.prepare("workspace-3", { name: "ccache", scope: "shared" }, "o"), /replaced by something else/, "a link in the host's own levels is refused");
});

test("pruning and eviction never follow a link a session left in its cache", { skip: pythonMissing }, async t => {
  const base = await scratch(t, "build-cache-janitor-");
  const root = join(base, "build-caches");
  const outside = join(base, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "keep.txt"), "host file");
  const store = new BuildCacheStore(root);
  const shared = await store.prepare("w", { name: "ccache", scope: "shared" }, "o");
  const mine = await store.prepare("w", { name: "ccache", scope: "owner" }, "o");
  await writeFile(join(shared, "old.o"), Buffer.alloc(4096));
  await writeFile(join(shared, "new.o"), Buffer.alloc(4096));
  await mkdir(join(shared, "sub"));
  await writeFile(join(shared, "sub", "deep.o"), Buffer.alloc(4096));
  await symlink(outside, join(shared, "escape"));
  await symlink(join(outside, "keep.txt"), join(shared, "file-link"));
  const old = new Date(Date.now() - 3 * 86_400_000);
  await utimes(join(shared, "old.o"), old, old);
  await utimes(join(shared, "sub", "deep.o"), old, old);
  await writeFile(join(mine, "mine.o"), Buffer.alloc(1024));

  const listed = await store.list();
  const sharedUsage = listed.caches.find(item => item.scope === "shared")!;
  assert.equal(sharedUsage.bytes, 3 * 4096, "links count as entries, never as what they point to");
  assert.deepEqual(listed.caches.map(item => [item.workspace, item.name, item.scope]), [["w", "ccache", "shared"], ["w", "ccache", "owner"]]);

  const nothing = await store.evict(1024 * 1024);
  assert.equal(nothing.removed, 0, "under the limit, nothing goes");
  const evicted = await store.evict(10 * 1024);
  assert.ok(evicted.removed >= 1);
  assert.equal(existsSync(join(shared, "old.o")), false, "the least recently written goes first");
  assert.equal(existsSync(join(shared, "new.o")), true);
  assert.equal(await readFile(join(outside, "keep.txt"), "utf8"), "host file", "a link is removed as a link, never followed");

  const kept = await store.prune(86_400_000);
  assert.equal(kept.removed, 0, "caches written to lately stay");
  const pruned = await store.prune(0, Date.now() + 1000);
  assert.equal(pruned.removed, 2);
  assert.equal(existsSync(join(root, "w")), false, "empty levels go too");
  assert.equal(await readFile(join(outside, "keep.txt"), "utf8"), "host file");
  assert.equal(existsSync(outside), true);
});

test("eviction and pruning reclaim a tree nested deeper than a walk goes", { skip: pythonMissing }, async t => {
  const root = join(await scratch(t, "build-cache-deep-"), "build-caches");
  const store = new BuildCacheStore(root);
  const shared = await store.prepare("w", { name: "ccache", scope: "shared" }, "o");
  const chain = join(shared, ...Array.from({ length: 200 }, () => "d"));
  await mkdir(chain, { recursive: true });
  await writeFile(join(chain, "hidden.o"), Buffer.alloc(4096));
  await writeFile(join(shared, "seen.o"), Buffer.alloc(16 * 1024));
  const evicted = await store.evict(8 * 1024);
  assert.ok(evicted.truncated, "the walk says it stopped short");
  assert.equal(existsSync(join(shared, ...Array.from({ length: 64 }, () => "d"))), false, "what lies past the walk's depth is removed whole");
  assert.equal(existsSync(join(shared, "seen.o")), false);

  await mkdir(chain, { recursive: true });
  await writeFile(join(chain, "hidden.o"), "x");
  const later = new Date(Date.now() + 3 * 86_400_000);
  await utimes(join(chain, "hidden.o"), later, later);
  const kept = await store.prune(86_400_000, Date.now() + 2 * 86_400_000);
  assert.equal(kept.removed, 0, "a file written lately past the walk's depth keeps its cache");
  assert.equal(existsSync(join(chain, "hidden.o")), true);
  const pruned = await store.prune(0, Date.now() + 4 * 86_400_000);
  assert.equal(pruned.removed, 1, "a cache too deep to walk in full still goes once idle");
  assert.equal(existsSync(join(root, "w")), false);
});

test("with resource limits, build caches need a filesystem of their own, never an ordinary directory", { skip: process.platform !== "linux" || pythonMissing ? "the resource supervisor runs on Linux with /usr/bin/python3" : undefined }, async t => {
  const directory = await scratch(t, "build-cache-volume-");
  const result = await probeBuildCacheStorage({ cgroupRoot: "/operator/delegated/sessions", controlRoot: "/operator/private-resource-control",
    cpuQuotaMicros: 25_000, cpuPeriodMicros: 100_000, memoryMaxBytes: 128 * 1024 * 1024, pidsMax: 24, writableMaxBytes: 16 * 1024 * 1024, writableMaxInodes: 4096 }, directory);
  assert.equal(result.available, false);
  assert.match(result.reason!, /resource boundary unavailable/, "the supervisor ran and refused, rather than failing to start");
});

test("a session asks which caches it gets at most every 30 seconds, and keeps a failed answer's predecessor for 5 minutes only", async t => {
  const store = new BuildCacheStore(join(await scratch(t, "build-cache-session-"), "build-caches"));
  let now = 1_000_000;
  let answer: SessionBuildCaches | Error = { caches: [{ name: "ccache", env: "CCACHE_DIR", scope: "shared", access: "write" }] };
  let asked = 0;
  const mounts = new SessionBuildCacheMounts({
    fetch: async () => { asked += 1; if (answer instanceof Error) throw answer; return answer; },
    store, workspaceId: "w", ownerId: "test:alice", target: name => sandboxBuildCacheTarget(name), now: () => now,
  });
  const first = await mounts.mounts("test:alice");
  assert.deepEqual(first.map(mount => [mount.name, mount.env, mount.scope, mount.target, mount.readOnly]), [["ccache", "CCACHE_DIR", "shared", "/build-caches/ccache", false]]);
  assert.equal(first[0]!.source, store.directory("w", { name: "ccache", scope: "shared" }, "test:alice"));
  await mounts.mounts("test:alice");
  assert.equal(asked, 1);
  now += BUILD_CACHE_FRESH_MS;
  answer = { caches: [{ name: "ccache", env: "CCACHE_DIR", scope: "owner", access: "write" }] };
  assert.equal((await mounts.mounts("test:alice"))[0]!.scope, "owner", "a role change reaches the next command within half a minute");
  now += BUILD_CACHE_FRESH_MS;
  answer = new Error("offline");
  assert.equal((await mounts.mounts("test:alice"))[0]!.scope, "owner", "a brief outage keeps the last answer");
  now += BUILD_CACHE_STALE_MS;
  assert.deepEqual(await mounts.mounts("test:alice"), [], "a stale grant is not kept");
});

test("a session asks for each sender, so an answer kept for an admin's message never mounts the shared copy writable for a member's", async t => {
  const store = new BuildCacheStore(join(await scratch(t, "build-cache-senders-"), "build-caches"));
  let now = 1_000_000;
  const asked: (string | null)[] = [];
  let offline = false;
  let memberWrites = false;
  const mounts = new SessionBuildCacheMounts({
    fetch: async sender => {
      asked.push(sender);
      if (offline) throw new Error("offline");
      return { caches: [{ name: "ccache", env: "CCACHE_DIR", scope: "shared", access: sender === "test:admin" || (memberWrites && sender === "test:member") ? "write" : "read" }] };
    },
    store, workspaceId: "w", ownerId: "test:admin", target: name => sandboxBuildCacheTarget(name), now: () => now,
  });
  const access = async (sender: string | null) => (await mounts.mounts(sender)).map(mount => [mount.scope, mount.readOnly]);
  assert.deepEqual(await access("test:admin"), [["shared", false]]);
  assert.deepEqual(await access("test:member"), [["shared", true]], "within the admin's 30 seconds, the member's message has its own answer");
  assert.deepEqual(await access("test:admin"), [["shared", false]]);
  assert.deepEqual(asked, ["test:admin", "test:member"], "each sender's answer is kept on its own");
  assert.deepEqual(await access(null), [["shared", true]], "a service, which outlives the message that started it, only reads");
  assert.deepEqual(asked.at(-1), null);

  memberWrites = true;
  assert.deepEqual(await access("test:member"), [["shared", true]]);
  now += BUILD_CACHE_FRESH_MS;
  assert.deepEqual(await access("test:member"), [["shared", false]], "a role change reaches that sender's next command once their answer is 30 seconds old");
  memberWrites = false;
  now += BUILD_CACHE_FRESH_MS;
  assert.deepEqual(await access("test:member"), [["shared", true]], "and so does losing it");

  now += BUILD_CACHE_FRESH_MS;
  offline = true;
  assert.deepEqual(await access("test:admin"), [["shared", false]], "an outage keeps each sender's own last answer");
  assert.deepEqual(await access("test:member"), [["shared", true]], "never another sender's");
  assert.deepEqual(await access("test:stranger"), [], "and a sender never asked about gets nothing");
  now += BUILD_CACHE_STALE_MS;
  assert.deepEqual(await access("test:admin"), [], "a stale answer is not kept");
  assert.deepEqual(await access("test:member"), []);

  offline = false;
  const writable = new SessionBuildCacheMounts({ fetch: async () => ({ caches: [{ name: "ccache", env: "CCACHE_DIR", scope: "shared", access: "write" }] }),
    store, workspaceId: "w", ownerId: "test:admin", target: name => sandboxBuildCacheTarget(name), now: () => now });
  assert.equal((await writable.mounts(null))[0]!.readOnly, true, "whatever the answer says, what no message started only reads");
  for (let index = 0; index < 100; index += 1) await writable.mounts(`test:sender-${index}`);
  assert.equal((await writable.mounts("test:sender-99"))[0]!.readOnly, false);
});

test("macOS sessions get read and write grants for their caches, and only read grants in a Read-only step", () => {
  const layout = { root: "/r", home: "/r/home", worktree: "/r/worktree", git: "/r/git", ownerConfig: "/r/owner.gitconfig", bin: "/r/bin", caBundle: "/r/ca.crt" };
  const writable = seatbeltProfile({ layout, readOnly: false, gitWritable: false, toolRoots: [], caches: ["/state/build-caches/w/ccache/shared"] });
  assert.equal(writable.parameters.CACHE_0, "/state/build-caches/w/ccache/shared");
  assert.match(writable.profile, /\(allow file-read\* \(subpath \(param "CACHE_0"\)\)\)/);
  assert.match(writable.profile, /\(allow file-write\* \(subpath \(param "CACHE_0"\)\)\)/);
  const reading = seatbeltProfile({ layout, readOnly: true, gitWritable: false, toolRoots: [], caches: ["/state/build-caches/w/ccache/shared"] });
  assert.doesNotMatch(reading.profile, /file-write\* \(subpath \(param "CACHE_0"\)\)/);
  const mixed = seatbeltProfile({ layout, readOnly: false, gitWritable: false, toolRoots: [], caches: ["/state/build-caches/w/ccache/shared", "/state/build-caches/w/assets/owners/a"],
    readOnlyCaches: ["/state/build-caches/w/ccache/shared"] });
  assert.match(mixed.profile, /\(allow file-read\* \(subpath \(param "CACHE_0"\)\) \(subpath \(param "CACHE_1"\)\)\)/);
  assert.match(mixed.profile, /\(allow file-write\* \(subpath \(param "CACHE_1"\)\)\)/, "a copy the sender doesn't write gets its read grant alone");
  assert.doesNotMatch(mixed.profile, /file-write\*[^\n]*CACHE_0/);
  const none = seatbeltProfile({ layout, readOnly: false, gitWritable: false, toolRoots: [], caches: ["/state/build-caches/w/ccache/shared"], readOnlyCaches: ["/state/build-caches/w/ccache/shared"] });
  assert.doesNotMatch(none.profile, /file-write\*[^\n]*CACHE_/);
  assert.throws(() => seatbeltProfile({ layout, readOnly: false, gitWritable: false, toolRoots: [], caches: ["/a/../etc"] }), /Invalid build cache path/);
  assert.throws(() => seatbeltProfile({ layout, readOnly: false, gitWritable: false, toolRoots: [], caches: ["/a\"b"] }), /Invalid build cache path/);
});

test("the helper sandboxes give a command its caches, and nothing else their caches", { skip: !python ? "python3 is not installed" : undefined }, async t => {
  const root = await scratch(t, "build-cache-helper-");
  const backend = new Unconfined("python", true, "python");
  const cache = join(root, "cache");
  await mkdir(cache);
  const mount: BuildCacheMount = { name: "ccache", env: "CCACHE_DIR", scope: "owner", source: cache, target: cache, readOnly: false };
  const faux = binding("build-cache-helper");
  const senders: (string | null)[] = [];
  const workspace = new HelperWorkspace({ ...faux, model: { ...faux.model, provider: "faux" } }, join(root, "sandbox"), backend,
    { buildCaches: async sender => { senders.push(sender); return [{ ...mount, readOnly: sender !== "test:alice" }]; } });
  t.after(() => workspace.close());
  await workspace.initialize();
  await workspace.listFiles(".", async () => {});
  await workspace.execute({ kind: "bash", command: "true" }, false, async () => {}, { allowTestShell: true, sender: "test:alice" });
  await workspace.execute({ kind: "bash", command: "true" }, false, async () => {}, { allowTestShell: true, sender: "test:member" });
  await workspace.execute({ kind: "bash", command: "true" }, false, async () => {}, { allowTestShell: true });
  const given = backend.launched.map(item => [item.request.kind, item.context.caches ?? []]);
  assert.deepEqual(given.filter(([kind]) => kind === "bash"), [["bash", [{ path: cache, env: "CCACHE_DIR", readOnly: false }]],
    ["bash", [{ path: cache, env: "CCACHE_DIR", readOnly: true }]], ["bash", []]], "a command gets the copy as its message's sender may use it, and none without a sender");
  assert.deepEqual(senders, ["test:alice", "test:member"]);
  assert.ok(given.filter(([kind]) => kind !== "bash").every(([, caches]) => (caches as unknown[]).length === 0));
});

test("in the Linux sandbox, a command writes its cache at /build-caches/<name>, which another session's command reads, and a Read-only step can't write it", { skip: linuxSandboxMissing() }, async t => {
  const root = await scratch(t, "build-cache-linux-");
  const store = new BuildCacheStore(join(root, "build-caches"));
  const open = async (id: string, owner: string) => {
    const faux = binding(id);
    const mounts = new SessionBuildCacheMounts({ fetch: async () => ({ caches: [{ name: "ccache", env: "CCACHE_DIR", scope: "shared", access: "write" }] }), store,
      workspaceId: "workspace", ownerId: owner, target: name => sandboxBuildCacheTarget(name) });
    const sandbox = new Sandbox({ ...faux, model: { ...faux.model, provider: "faux" } }, join(root, id), undefined, { buildCaches: sender => mounts.mounts(sender) });
    t.after(() => sandbox.close());
    await sandbox.initialize();
    return (command: string, readOnly = false) => sandbox.execute({ kind: "bash", command }, readOnly, async () => {}, { allowTestShell: true, sender: owner });
  };
  const first = await open("build-cache-first", "test:alice");
  assert.equal((await first("echo \"$CCACHE_DIR\"; echo built > \"$CCACHE_DIR/object.o\"")).trim(), "/build-caches/ccache");
  assert.equal(await readFile(join(store.directory("workspace", { name: "ccache", scope: "shared" }, "test:alice"), "object.o"), "utf8"), "built\n");
  const second = await open("build-cache-second", "test:carol");
  assert.equal((await second("cat /build-caches/ccache/object.o")).trim(), "built", "another session sharing the copy reads it");
  assert.equal((await second("touch /build-caches/ccache/other 2>/dev/null || echo read-only", true)).trim(), "read-only");
  assert.equal((await second("test -e /build-caches || echo none; ls /build-caches")).trim(), "ccache");
});

test("in the Linux sandbox, an admin's session mounts the shared copy read-only for a member's message and for a service, and not at all without a sender", { skip: linuxSandboxMissing() }, async t => {
  const root = await scratch(t, "build-cache-sender-");
  const store = new BuildCacheStore(join(root, "build-caches"));
  const faux = binding("build-cache-sender");
  const mounts = new SessionBuildCacheMounts({ fetch: async sender => ({ caches: [{ name: "ccache", env: "CCACHE_DIR", scope: "shared", access: sender === "test:admin" ? "write" : "read" }] }),
    store, workspaceId: "workspace", ownerId: "test:admin", target: name => sandboxBuildCacheTarget(name) });
  const sandbox = new Sandbox({ ...faux, model: { ...faux.model, provider: "faux" } }, join(root, "sandbox"), undefined, { buildCaches: sender => mounts.mounts(sender) });
  t.after(() => sandbox.close());
  await sandbox.initialize();
  const run = (command: string, sender?: string) => sandbox.execute({ kind: "bash", command }, false, async () => {}, { allowTestShell: true, ...(sender ? { sender } : {}) });
  const probe = "cat \"$CCACHE_DIR/object.o\"; touch \"$CCACHE_DIR/planted\" 2>/dev/null && echo wrote || echo read-only";
  assert.equal((await run("echo built > \"$CCACHE_DIR/object.o\"; echo ok", "test:admin")).trim(), "ok");
  assert.equal((await run(probe, "test:member")).trim(), "built\nread-only", "the member's message reads what the admin's built and can't write it");
  const shared = store.directory("workspace", { name: "ccache", scope: "shared" }, "test:admin");
  assert.equal(existsSync(join(shared, "planted")), false);
  assert.equal((await run("test -e /build-caches || echo none; echo \"[${CCACHE_DIR:-}]\"")).trim(), "none\n[]", "a command no message's sender started gets no cache");
  assert.equal((await run(probe, "test:admin")).trim(), "built\nwrote", "and the admin's next message writes again");
  await rm(join(shared, "planted"));

  const output: Buffer[] = [];
  const service = await sandbox.startService(probe, async () => {}, { limits: serviceLimits(60, 1), unbounded: true,
    socketDirectory: serviceSocketDirectory("build-cache-sender", root), onOutput: chunk => { output.push(chunk); } });
  await service.exited;
  assert.match(Buffer.concat(output).toString(), /built(\s|\\n)+read-only/, "a service outlives its message, so it reads the cache and never writes it");
  assert.equal(existsSync(join(shared, "planted")), false);
});
