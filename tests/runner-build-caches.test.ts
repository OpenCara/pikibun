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
  let answer: SessionBuildCaches | Error = { caches: [{ name: "ccache", env: "CCACHE_DIR", scope: "shared" }] };
  let asked = 0;
  const mounts = new SessionBuildCacheMounts({
    fetch: async () => { asked += 1; if (answer instanceof Error) throw answer; return answer; },
    store, workspaceId: "w", ownerId: "test:alice", target: name => sandboxBuildCacheTarget(name), now: () => now,
  });
  const first = await mounts.mounts();
  assert.deepEqual(first.map(mount => [mount.name, mount.env, mount.scope, mount.target]), [["ccache", "CCACHE_DIR", "shared", "/build-caches/ccache"]]);
  assert.equal(first[0]!.source, store.directory("w", { name: "ccache", scope: "shared" }, "test:alice"));
  await mounts.mounts();
  assert.equal(asked, 1);
  now += BUILD_CACHE_FRESH_MS;
  answer = { caches: [{ name: "ccache", env: "CCACHE_DIR", scope: "owner" }] };
  assert.equal((await mounts.mounts())[0]!.scope, "owner", "a role change reaches the next command within half a minute");
  now += BUILD_CACHE_FRESH_MS;
  answer = new Error("offline");
  assert.equal((await mounts.mounts())[0]!.scope, "owner", "a brief outage keeps the last answer");
  now += BUILD_CACHE_STALE_MS;
  assert.deepEqual(await mounts.mounts(), [], "a stale grant is not kept");
});

test("macOS sessions get read and write grants for their caches, and only read grants in a Read-only step", () => {
  const layout = { root: "/r", home: "/r/home", worktree: "/r/worktree", git: "/r/git", ownerConfig: "/r/owner.gitconfig", bin: "/r/bin", caBundle: "/r/ca.crt" };
  const writable = seatbeltProfile({ layout, readOnly: false, gitWritable: false, toolRoots: [], caches: ["/state/build-caches/w/ccache/shared"] });
  assert.equal(writable.parameters.CACHE_0, "/state/build-caches/w/ccache/shared");
  assert.match(writable.profile, /\(allow file-read\* \(subpath \(param "CACHE_0"\)\)\)/);
  assert.match(writable.profile, /\(allow file-write\* \(subpath \(param "CACHE_0"\)\)\)/);
  const reading = seatbeltProfile({ layout, readOnly: true, gitWritable: false, toolRoots: [], caches: ["/state/build-caches/w/ccache/shared"] });
  assert.doesNotMatch(reading.profile, /file-write\* \(subpath \(param "CACHE_0"\)\)/);
  assert.throws(() => seatbeltProfile({ layout, readOnly: false, gitWritable: false, toolRoots: [], caches: ["/a/../etc"] }), /Invalid build cache path/);
  assert.throws(() => seatbeltProfile({ layout, readOnly: false, gitWritable: false, toolRoots: [], caches: ["/a\"b"] }), /Invalid build cache path/);
});

test("the helper sandboxes give a command its caches, and nothing else their caches", { skip: !python ? "python3 is not installed" : undefined }, async t => {
  const root = await scratch(t, "build-cache-helper-");
  const backend = new Unconfined("python", true, "python");
  const cache = join(root, "cache");
  await mkdir(cache);
  const mount: BuildCacheMount = { name: "ccache", env: "CCACHE_DIR", scope: "owner", source: cache, target: cache };
  const faux = binding("build-cache-helper");
  const workspace = new HelperWorkspace({ ...faux, model: { ...faux.model, provider: "faux" } }, join(root, "sandbox"), backend, { buildCaches: async () => [mount] });
  t.after(() => workspace.close());
  await workspace.initialize();
  await workspace.listFiles(".", async () => {});
  await workspace.execute({ kind: "bash", command: "true" }, false, async () => {}, { allowTestShell: true });
  const given = backend.launched.map(item => [item.request.kind, item.context.caches ?? []]);
  assert.deepEqual(given.filter(([kind]) => kind === "bash"), [["bash", [{ path: cache, env: "CCACHE_DIR" }]]]);
  assert.ok(given.filter(([kind]) => kind !== "bash").every(([, caches]) => (caches as unknown[]).length === 0));
});

test("in the Linux sandbox, a command writes its cache at /build-caches/<name>, which another session's command reads, and a Read-only step can't write it", { skip: linuxSandboxMissing() }, async t => {
  const root = await scratch(t, "build-cache-linux-");
  const store = new BuildCacheStore(join(root, "build-caches"));
  const open = async (id: string, owner: string) => {
    const faux = binding(id);
    const mounts = new SessionBuildCacheMounts({ fetch: async () => ({ caches: [{ name: "ccache", env: "CCACHE_DIR", scope: "shared" }] }), store,
      workspaceId: "workspace", ownerId: owner, target: name => sandboxBuildCacheTarget(name) });
    const sandbox = new Sandbox({ ...faux, model: { ...faux.model, provider: "faux" } }, join(root, id), undefined, { buildCaches: () => mounts.mounts() });
    t.after(() => sandbox.close());
    await sandbox.initialize();
    return (command: string, readOnly = false) => sandbox.execute({ kind: "bash", command }, readOnly, async () => {}, { allowTestShell: true });
  };
  const first = await open("build-cache-first", "test:alice");
  assert.equal((await first("echo \"$CCACHE_DIR\"; echo built > \"$CCACHE_DIR/object.o\"")).trim(), "/build-caches/ccache");
  assert.equal(await readFile(join(store.directory("workspace", { name: "ccache", scope: "shared" }, "test:alice"), "object.o"), "utf8"), "built\n");
  const second = await open("build-cache-second", "test:carol");
  assert.equal((await second("cat /build-caches/ccache/object.o")).trim(), "built", "another session sharing the copy reads it");
  assert.equal((await second("touch /build-caches/ccache/other 2>/dev/null || echo read-only", true)).trim(), "read-only");
  assert.equal((await second("test -e /build-caches || echo none; ls /build-caches")).trim(), "ccache");
});
