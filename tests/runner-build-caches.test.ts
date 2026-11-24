import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runBuildCacheJanitor } from "../apps/runner/src/build-cache-janitor.js";
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
  const old = new Date(Date.now() - 3 * 86_400_000);
  for (let depth = 200; depth >= 0; depth -= 1) await utimes(join(shared, ...Array.from({ length: depth }, () => "d")), old, old);
  const kept = await store.prune(86_400_000);
  assert.equal(kept.removed, 0, "a file written lately past the walk's depth keeps its cache");
  assert.equal(existsSync(join(chain, "hidden.o")), true);
  await utimes(join(chain, "hidden.o"), old, old);
  const pruned = await store.prune(86_400_000);
  assert.equal(pruned.removed, 1, "a cache too deep to walk in full still goes once idle");
  assert.equal(existsSync(join(root, "w")), false);
});

async function fill(directory: string, prefix: string, count: number, when: (index: number) => Date): Promise<string[]> {
  const paths: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const path = join(directory, `${prefix}${index}.o`);
    await writeFile(path, Buffer.alloc(4096));
    await utimes(path, when(index), when(index));
    paths.push(path);
  }
  return paths;
}

test("a copy filled with future-dated files loses its own files to eviction, never the other copies' and workspaces'", { skip: pythonMissing }, async t => {
  const store = new BuildCacheStore(join(await scratch(t, "build-cache-hoard-"), "build-caches"));
  const hour = () => new Date(Date.now() - 3_600_000);
  const shared = await fill(await store.prepare("a", { name: "ccache", scope: "shared" }, "test:alice"), "shared", 4, hour);
  const other = await fill(await store.prepare("b", { name: "ccache", scope: "shared" }, "test:bob"), "other", 2, hour);
  const hoard = await store.prepare("a", { name: "ccache", scope: "owner" }, "test:mallory");
  await fill(hoard, "hoard", 20, () => new Date("2099-01-01T00:00:00Z"));

  const evicted = await store.evict(64 * 1024);
  assert.equal(evicted.removed, 14, "only what the hoard holds over its share goes");
  assert.deepEqual([...shared, ...other].filter(path => !existsSync(path)), [], "copies within their share keep every file");
  assert.equal((await readdir(hoard)).length, 6, "the hoard keeps its share of the workspace's share, plus what the others left unused");
  assert.equal((await store.evict(64 * 1024)).removed, 0, "and the next pass has nothing to do");
});

test("eviction takes the oldest files of the copy furthest over its share, whatever the other copies' age", { skip: pythonMissing }, async t => {
  const store = new BuildCacheStore(join(await scratch(t, "build-cache-share-"), "build-caches"));
  const month = Date.now() - 30 * 86_400_000;
  const small = await fill(await store.prepare("small", { name: "ccache", scope: "shared" }, "o"), "small", 3, () => new Date(month));
  const big = await fill(await store.prepare("big", { name: "ccache", scope: "shared" }, "o"), "big", 10, index => new Date(Date.now() - (10 - index) * 60_000));

  const evicted = await store.evict(48 * 1024);
  assert.equal(evicted.removed, 4);
  assert.deepEqual(small.filter(path => !existsSync(path)), [], "an old copy under its share is left alone");
  assert.deepEqual(big.filter(path => !existsSync(path)), big.slice(0, 4), "within the copy over its share, the least recently written go first");
});

test("eviction stops once the root is under its target, though each copy over its share has more to give", { skip: pythonMissing }, async t => {
  const store = new BuildCacheStore(join(await scratch(t, "build-cache-stop-"), "build-caches"));
  const first = join(await store.prepare("a", { name: "ccache", scope: "shared" }, "o"), "only.o");
  const second = join(await store.prepare("b", { name: "ccache", scope: "shared" }, "o"), "only.o");
  await writeFile(first, Buffer.alloc(8192));
  await writeFile(second, Buffer.alloc(8192));
  const evicted = await store.evict(16 * 1024);
  assert.equal(evicted.removed, 1, "one file larger than both copies' excess is enough");
  assert.equal([first, second].filter(path => existsSync(path)).length, 1);
});

test("a file dated ahead of the host's clock counts from when it was really changed", { skip: pythonMissing }, async t => {
  const store = new BuildCacheStore(join(await scratch(t, "build-cache-clock-"), "build-caches"));
  const shared = await store.prepare("w", { name: "ccache", scope: "shared" }, "o");
  const future = new Date("2099-01-01T00:00:00Z");
  await writeFile(join(shared, "future.o"), Buffer.alloc(4096));
  await utimes(join(shared, "future.o"), future, future);
  await delay(100);
  await writeFile(join(shared, "fresh.o"), Buffer.alloc(4096));

  const listed = await store.list();
  assert.ok(listed.caches[0]!.newest <= Date.now() + 1000, "a listing never shows a time ahead of the clock");
  const evicted = await store.evict(8 * 1024);
  assert.equal(evicted.removed, 1);
  assert.equal(existsSync(join(shared, "future.o")), false, "the file changed first goes first, whatever date it carries");
  assert.equal(existsSync(join(shared, "fresh.o")), true);

  await utimes(join(shared, "fresh.o"), future, future);
  await utimes(shared, future, future);
  const kept = await store.prune(86_400_000);
  assert.equal(kept.removed, 0);
  const pruned = await store.prune(86_400_000, Date.now() + 2 * 86_400_000);
  assert.equal(pruned.removed, 1, "a future date doesn't keep an idle cache from pruning");
});

test("a copy with more entries than a walk counts is emptied before any other copy loses a file", { skip: pythonMissing }, async t => {
  const root = join(await scratch(t, "build-cache-count-"), "build-caches");
  const store = new BuildCacheStore(root);
  const hour = () => new Date(Date.now() - 3_600_000);
  const many = await store.prepare("a", { name: "ccache", scope: "owner" }, "test:mallory");
  await mkdir(join(many, "sub"));
  await fill(join(many, "sub"), "many", 12, () => new Date("2099-01-01T00:00:00Z"));
  const other = await fill(await store.prepare("b", { name: "ccache", scope: "shared" }, "o"), "other", 4, hour);

  const listed = await runBuildCacheJanitor({ root, mode: "list", entries: 8 }) as { caches: { workspace: string; files: number }[]; truncated: boolean };
  assert.equal(listed.truncated, true);
  assert.equal(listed.caches.find(item => item.workspace === "b")!.files, 4, "one copy's size doesn't cut short the listing of the next");
  const evicted = await runBuildCacheJanitor({ root, mode: "evict", capacity: 24 * 1024, evictAt: 0.9, evictTo: 0.8, entries: 8 }) as { truncated: boolean };
  assert.equal(evicted.truncated, true, "the walk says it stopped short");
  assert.deepEqual(await readdir(many), [], "the copy that couldn't be counted is emptied, and its directory stays for the sessions that mount it");
  assert.deepEqual(other.filter(path => !existsSync(path)), [], "the copy that could be counted keeps its files");
});

test("on a filesystem of its own, a root under its limit isn't walked, and one the filesystem says is full is trimmed", { skip: pythonMissing }, async t => {
  const root = join(await scratch(t, "build-cache-own-"), "build-caches");
  const store = new BuildCacheStore(root);
  const files = await fill(await store.prepare("w", { name: "ccache", scope: "shared" }, "o"), "file", 3, () => new Date());
  const request = { root, mode: "evict", dedicated: true, evictAt: 0.9, evictTo: 0.8 };
  const idle = await runBuildCacheJanitor({ ...request, capacity: 2 ** 60, entries: 1 }) as { removed: number; truncated: boolean };
  assert.deepEqual([idle.removed, idle.truncated], [0, false], "the filesystem's own usage is enough to know there is nothing to do");
  const full = await runBuildCacheJanitor({ ...request, capacity: 4096 }) as { removed: number };
  assert.equal(full.removed, 3, "usage the walk can't attribute to a copy leaves less room to share");
  assert.deepEqual(files.filter(path => existsSync(path)), []);
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
