import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { HelperWorkspace, type HelperBackend, type HelperContext, type HelperLaunch, type HelperLayout } from "../apps/runner/src/helper-workspace.js";
import { ownerPackageCache, packageCacheDirectory, packageCacheEnvironment, packageCacheRoot, SANDBOX_PACKAGE_CACHE } from "../apps/runner/src/package-cache.js";
import { HELPER, Sandbox, type SandboxRequest } from "../apps/runner/src/sandbox.js";
import { SeatbeltBackend, seatbeltProfile } from "../apps/runner/src/seatbelt.js";
import { binding, linuxSandboxMissing, seatbeltMissing } from "./helpers/workspaces.js";

const allow = async () => {};
const posix = process.platform !== "win32";
const git = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout?.trim() ?? "";
const bash = ["/bin/bash", "/usr/bin/bash"].find(path => existsSync(path)) ?? "";
const python = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout?.trim() ?? "";

async function temporary(t: TestContext, prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function owned(id: string, owner: string) {
  const value = binding(id);
  return { ...value, session: { ...value.session, ownerId: owner }, owner: { ...value.owner, id: owner } };
}

test("each session owner has a package cache of their own on the host, made private, with pip's, npm's and uv's", { skip: !posix }, async t => {
  const directory = await temporary(t, "pikibun-package-cache-");
  const root = packageCacheRoot(directory);
  assert.equal(root, join(directory, "package-cache"));
  const alice = ownerPackageCache(root, "test:alice");
  assert.equal(ownerPackageCache(root, "test:alice"), alice);
  assert.notEqual(ownerPackageCache(root, "test:bob"), alice, "another owner's sessions use another cache");
  assert.match(alice.slice(root.length + 1), /^[0-9a-f]{32}$/, "the owner's id never names a path");
  assert.equal(packageCacheDirectory(alice), alice);
  for (const name of ["pip", "npm", "uv"]) assert.ok((await stat(join(alice, name))).isDirectory());
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(alice)).mode & 0o777, 0o700);
  await chmod(alice, 0o750);
  assert.equal(packageCacheDirectory(alice), undefined, "a cache others may read is refused");
  await chmod(alice, 0o700);
  for (const path of ["relative", "/", undefined, `${alice}\n`]) assert.equal(packageCacheDirectory(path), undefined);
  assert.deepEqual(packageCacheEnvironment("/opt/pikibun/cache", false),
    { PIP_CACHE_DIR: "/opt/pikibun/cache/pip", npm_config_cache: "/opt/pikibun/cache/npm", UV_CACHE_DIR: "/opt/pikibun/cache/uv" });
  assert.deepEqual(packageCacheEnvironment("C:\\state\\cache", true),
    { PIP_CACHE_DIR: "C:\\state\\cache\\pip", npm_config_cache: "C:\\state\\cache\\npm", UV_CACHE_DIR: "C:\\state\\cache\\uv" });
});

test("the Seatbelt profile lets a step that may write write its package cache, by parameter, and no read-only step", () => {
  const layout: HelperLayout = { root: "/s", home: "/s/home", worktree: "/s/worktree", git: "/s/git", ownerConfig: "/s/owner.gitconfig", bin: "/s/bin", caBundle: "/s/ca.crt" };
  const command = seatbeltProfile({ layout, readOnly: false, gitWritable: false, toolRoots: [], writableRoots: ["/state/package-cache/ab"] });
  assert.equal(command.parameters.WRITE_0, "/state/package-cache/ab");
  assert.match(command.profile, /\(allow file-read\* file-write\* \(subpath \(param "WRITE_0"\)\)\)/);
  assert.ok(!command.profile.includes("/state/"), "no path is spliced into the profile");
  const read = seatbeltProfile({ layout, readOnly: true, gitWritable: false, toolRoots: [], writableRoots: ["/state/package-cache/ab"] });
  assert.ok(!read.profile.includes("WRITE_"));
  assert.throws(() => seatbeltProfile({ layout, readOnly: false, gitWritable: false, toolRoots: [], writableRoots: ["relative"] }), /Invalid writable root/);
});

class Recording implements HelperBackend {
  readonly name = "recording";
  readonly limitedShell = true;
  readonly path = "/usr/bin:/bin";
  readonly launched: { request: SandboxRequest; context: HelperContext }[] = [];
  supports(): boolean { return true; }
  async prepare(): Promise<void> {}
  async launch(request: SandboxRequest, context: HelperContext, layout: HelperLayout): Promise<HelperLaunch> {
    this.launched.push({ request, context });
    return { command: python, args: ["-I", "-c", HELPER], cwd: layout.worktree,
      env: { ...context.environment, SANDBOX_GITDIR: layout.git, SANDBOX_GIT: git, SANDBOX_BASH: bash, SANDBOX_OWNER_CONFIG: layout.ownerConfig } };
  }
}

test("the helper workspace gives the package cache only to commands that may write and run without the host's limits", { skip: !posix || !python || !git || !bash }, async t => {
  const directory = await temporary(t, "pikibun-helper-cache-");
  const cache = ownerPackageCache(packageCacheRoot(directory), "test:alice");
  const backend = new Recording();
  const sandbox = new HelperWorkspace(binding("helper-cache"), join(directory, "sandbox"), backend, { packageCache: cache });
  t.after(() => sandbox.close());
  await sandbox.initialize();
  await sandbox.execute({ kind: "bash", command: "echo kept > \"$PIP_CACHE_DIR/marker\"" }, false, allow, { unbounded: true });
  assert.equal(await readFile(join(cache, "pip", "marker"), "utf8"), "kept\n");
  await sandbox.execute({ kind: "bash", command: "true" }, false, allow);
  await sandbox.execute({ kind: "bash", command: "true" }, true, allow, { unbounded: true });
  await sandbox.readFile(".git", allow).catch(() => undefined);
  const commands = backend.launched.filter(entry => entry.request.kind === "bash").map(entry => entry.context);
  assert.equal(commands[0]!.packageCache, cache);
  assert.equal(commands[0]!.environment.UV_CACHE_DIR, join(cache, "uv"));
  for (const context of [...commands.slice(1), ...backend.launched.filter(entry => entry.request.kind !== "bash").map(entry => entry.context)]) {
    assert.equal(context.packageCache, undefined);
    assert.equal(context.environment.PIP_CACHE_DIR, undefined);
  }
});

test("in the Linux sandbox, an owner's sessions share their package cache at /opt/pikibun/cache, and no other owner's", { skip: linuxSandboxMissing() }, async t => {
  const directory = await temporary(t, "pikibun-linux-cache-");
  const root = packageCacheRoot(directory);
  const open = async (id: string, owner: string) => {
    const sandbox = new Sandbox(owned(id, owner), join(directory, id), undefined, { packageCache: ownerPackageCache(root, owner), browser: null });
    t.after(() => sandbox.close());
    await sandbox.initialize();
    return (command: string, readOnly = false) => sandbox.execute({ kind: "bash", command }, readOnly, allow, { unbounded: true });
  };
  const first = await open("first", "test:alice");
  assert.equal(await first("printf %s \"$npm_config_cache\""), `${SANDBOX_PACKAGE_CACHE}/npm`);
  await first("echo kept > \"$npm_config_cache/marker\"");
  assert.equal(await (await open("second", "test:alice"))("cat \"$npm_config_cache/marker\""), "kept\n");
  assert.equal(await (await open("other", "test:bob"))(`test -e ${SANDBOX_PACKAGE_CACHE}/npm/marker || echo absent`), "absent\n");
  assert.equal(await first(`test -e ${SANDBOX_PACKAGE_CACHE} || echo absent`, true), "absent\n", "a read-only command gets none");
});

test("in the macOS sandbox, an owner's sessions share their package cache in place, and can't read another owner's", { skip: seatbeltMissing() }, async t => {
  const directory = await temporary(t, "pikibun-seatbelt-cache-");
  const root = packageCacheRoot(directory);
  const open = async (id: string, owner: string) => {
    const sandbox = new HelperWorkspace(owned(id, owner), join(directory, id), new SeatbeltBackend(), { packageCache: ownerPackageCache(root, owner) });
    t.after(() => sandbox.close());
    await sandbox.initialize();
    return (command: string) => sandbox.execute({ kind: "bash", command }, false, allow, { unbounded: true });
  };
  await (await open("first", "test:alice"))("echo kept > \"$UV_CACHE_DIR/marker\"");
  assert.equal(await (await open("second", "test:alice"))("cat \"$UV_CACHE_DIR/marker\""), "kept\n");
  await assert.rejects((await open("other", "test:bob"))(`cat '${join(ownerPackageCache(root, "test:alice"), "uv", "marker")}'`),
    /Operation not permitted|Permission denied/);
});
