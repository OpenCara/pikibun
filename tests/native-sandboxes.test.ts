import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { assertConnectorPlatform } from "../apps/runner/src/connect-setup.js";
import { EgressProxy, egressEnvironment, type EgressEndpoint, type RelayRequest } from "../apps/runner/src/egress.js";
import { GitRemote } from "../apps/runner/src/git-remote.js";
import { RepositoryCache } from "../apps/runner/src/repo-cache.js";
import { GIT_SHIM } from "../apps/runner/src/sandbox-python.generated.js";
import { startGitHttpServer } from "./helpers/git-http.js";
import { egressPort, HelperWorkspace, type HelperBackend, type HelperContext, type HelperLaunch, type HelperLayout } from "../apps/runner/src/helper-workspace.js";
import { NODE_HELPER, NODE_HELPER_KINDS } from "../apps/runner/src/node-helper.js";
import { HELPER, type SandboxRequest } from "../apps/runner/src/sandbox.js";
import { bashPath, sandboxNodePath } from "../apps/runner/src/platform.js";
import { GIT_SHIM_MAX_DEPTH, gitShimProgram, hostGitBashScript, hostGitEnvironment, HostGitShim } from "../apps/runner/src/host-git-shim.js";
import { realpathSync } from "node:fs";
import { validWindowsLimits } from "../apps/runner/src/sandbox-backend.js";
import { SeatbeltBackend, seatbeltGitShim, seatbeltProfile } from "../apps/runner/src/seatbelt.js";
import { WINDOWS_RUNNER, WINDOWS_SUPPORT_CHECK, WindowsBackend, windowsSandboxSupport } from "../apps/runner/src/windows-sandbox.js";
import { confinedLaunch, ProcessChannel } from "../apps/runner/src/extensions/process.js";
import { helperDescribe } from "../apps/runner/src/extensions/describe.js";
import type { EgressGrant } from "../packages/shared/src/network.js";
import { seatbeltMissing } from "./helpers/workspaces.js";
import type { RunnerBinding } from "../packages/shared/src/types.js";

const allow = async () => {};
const git = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
const bash = ["/bin/bash", "/usr/bin/bash"].find(path => existsSync(path))!;
const python = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
const posix = process.platform !== "win32" && !!git && !!bash;

function binding(id: string): RunnerBinding {
  return {
    session: { id, workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1", title: "Native", policyVersion: 1, status: "ready", createdAt: "2026-01-01T00:00:00Z", repositories: [] },
    owner: { id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice Owner", gitEmail: "alice@example.test", env: {}, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: "test:alice", workspaceId: "workspace", version: 1, name: "Agent", description: "", instructions: "Use tools.", tools: ["read_file", "write_file", "bash"], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "workspace", name: "Model", provider: "openai", modelId: "local" },
  };
}

class Unconfined implements HelperBackend {
  readonly path = "/usr/bin:/bin";
  readonly launched: { request: SandboxRequest; context: HelperContext }[] = [];
  constructor(readonly name: string, readonly limitedShell: boolean, readonly helper: "python" | "node") {}
  supports(kind: SandboxRequest["kind"]): boolean { return this.helper === "python" || NODE_HELPER_KINDS.has(kind); }
  async prepare(layout: HelperLayout): Promise<void> {
    if (this.helper === "node") await writeFile(join(layout.bin, "helper.mjs"), NODE_HELPER, { mode: 0o400 }).catch(() => undefined);
  }
  async launch(request: SandboxRequest, context: HelperContext, layout: HelperLayout): Promise<HelperLaunch> {
    this.launched.push({ request, context });
    const env = { ...context.environment, SANDBOX_GITDIR: layout.git, SANDBOX_GIT: git, SANDBOX_BASH: bash, SANDBOX_OWNER_CONFIG: layout.ownerConfig };
    return this.helper === "python"
      ? { command: python, args: ["-I", "-c", HELPER], env, cwd: layout.worktree }
      : { command: process.execPath, args: [join(layout.bin, "helper.mjs")], env, cwd: layout.worktree };
  }
}

async function workspace(t: TestContext, backend: HelperBackend): Promise<HelperWorkspace> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "native-")));
  const instance = new HelperWorkspace(binding(`native-${backend.name}`), join(directory, "sandbox"), backend);
  t.after(async () => { await instance.close(); await rm(directory, { recursive: true, force: true }); });
  await instance.initialize();
  return instance;
}

for (const helper of ["python", "node"] as const) {
  const label = helper === "python" ? "the Python helper as macOS runs it" : "the Node helper as Windows runs it";

  test(`${label}: a separate Git directory, file tools confined to the worktree, and .git protected`, { skip: !posix || (helper === "python" && !python) }, async t => {
    const sandbox = await workspace(t, new Unconfined(helper, true, helper));
    const { git: gitDir, worktree } = sandbox.layout;
    assert.equal(await readFile(join(worktree, ".git"), "utf8"), `gitdir: ${gitDir}\n`);
    assert.ok(existsSync(join(gitDir, "HEAD")), "the session's repository is in its own Git directory");
    await sandbox.writeFile("notes/plan.md", "inside", allow);
    assert.equal(await sandbox.readFile("notes/plan.md", allow), "inside");
    assert.deepEqual(await sandbox.listFiles(".", allow), [".git", "notes"]);
    await assert.rejects(sandbox.writeFile(".git/config", "x", allow), /Git metadata is protected/);
    await assert.rejects(sandbox.writeFile("../escape", "x", allow), /path traversal/);
    await assert.rejects(sandbox.readFile("/etc/hostname", allow), /invalid relative path/);
    const listing = await sandbox.browse(".", allow);
    assert.equal(listing.type, "directory");
    const preview = await sandbox.browse("notes/plan.md", allow);
    assert.equal(preview.type === "file" && preview.text, "inside");
  });

  test(`${label}: shell commands, and a clone's head, push preparation and pack`, { skip: !posix || (helper === "python" && !python) }, async t => {
    const sandbox = await workspace(t, new Unconfined(helper, true, helper));
    const output = await sandbox.execute({ kind: "bash", command: "echo hello && git rev-parse --is-inside-work-tree" }, false, allow);
    assert.equal(output, "hello\ntrue\n");
    await sandbox.execute({ kind: "bash", command: "git init -q -b main app && cd app && git commit -q --allow-empty -m first && git remote add origin https://github.com/acme/app" }, false, allow);
    const head = await sandbox.cloneHead("app", allow);
    assert.match(head.commit, /^[0-9a-f]{40}$/);
    assert.equal(head.origin, "https://github.com/acme/app");
    const prepared = await sandbox.clonePushPrepare("app", { commit: head.commit, old: null, tips: [] }, allow);
    assert.equal(prepared.total, 1);
    assert.deepEqual(prepared.commits.map(commit => commit.subject), ["first"]);
    const chunks: Uint8Array[] = [];
    for await (const chunk of await sandbox.clonePushPack("app", { commit: head.commit, exclude: [] }, allow)) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).subarray(0, 4).toString(), "PACK");
    for (const cache of [".npm/_cacache", ".cache/pip", ".local/share/pnpm", ".local/bin"]) {
      await mkdir(join(sandbox.layout.home, cache), { recursive: true });
      await writeFile(join(sandbox.layout.home, cache, "file"), "x");
    }
    const files = await sandbox.snapshot(allow, ["app"]);
    const paths = files.map(file => file.path);
    assert.ok(paths.includes("owner.gitconfig") && paths.includes("git/HEAD"));
    assert.ok(!paths.some(path => path.startsWith("worktree/app/")), "clones are left out of the snapshot");
    assert.ok(paths.includes("home/.local/bin/file"), "the rest of the home is kept");
    assert.ok(!paths.some(path => /^home\/(\.npm|\.cache|\.local\/share\/pnpm)\//.test(path)), "package caches are left out of the snapshot");
    await assert.rejects(sandbox.execute({ kind: "bash", command: "exit 3" }, false, allow), /exit 3/);
  });
}

test("on Windows, the session's git is put first again once Git for Windows' bash has started, after any BASH_ENV of the owner's own", () => {
  assert.deepEqual(hostGitEnvironment("/t/pikibun-git-1/bin", { Path: "C:\\Windows", BASH_ENV: "/u/rc" }, true),
    { Path: "/t/pikibun-git-1/bin;C:\\Windows", BASH_ENV: join("/t/pikibun-git-1", "path.sh"), PIKIBUN_BASH_ENV: "/u/rc" });
  assert.deepEqual(hostGitEnvironment("/t/bin", { PATH: "/usr/bin" }, false), { PATH: `/t/bin${process.platform === "win32" ? ";" : ":"}/usr/bin` });
  assert.deepEqual(hostGitEnvironment("/t/bin", {}, false), { PATH: `/t/bin${process.platform === "win32" ? ";" : ":"}/usr/bin:/bin:/usr/sbin:/sbin` });
});

test("inside another session's git, the session's git keeps the owner's own BASH_ENV, never the other session's script that would run itself", () => {
  const outer = { Path: "/t/pikibun-git-1/bin;C:\\Windows", BASH_ENV: join("/t/pikibun-git-1", "path.sh") };
  assert.deepEqual(hostGitEnvironment("/t/pikibun-git-2/bin", outer, true),
    { Path: "/t/pikibun-git-2/bin;/t/pikibun-git-1/bin;C:\\Windows", BASH_ENV: join("/t/pikibun-git-2", "path.sh") });
  assert.deepEqual(hostGitEnvironment("/t/pikibun-git-2/bin", { ...outer, PIKIBUN_BASH_ENV: "/u/rc" }, true),
    { Path: "/t/pikibun-git-2/bin;/t/pikibun-git-1/bin;C:\\Windows", BASH_ENV: join("/t/pikibun-git-2", "path.sh"), PIKIBUN_BASH_ENV: "/u/rc" });
  assert.deepEqual(hostGitEnvironment("/t/pikibun-git-2/bin", { ...outer, Pikibun_Bash_Env: "/u/rc" }, true),
    { Path: "/t/pikibun-git-2/bin;/t/pikibun-git-1/bin;C:\\Windows", BASH_ENV: join("/t/pikibun-git-2", "path.sh"), Pikibun_Bash_Env: "/u/rc" },
    "Windows names its variables in any case");
  assert.deepEqual(hostGitEnvironment("/t/pikibun-git-2/bin", { ...outer, PIKIBUN_BASH_ENV: join("/t/pikibun-git-0", "path.sh") }, true),
    { Path: "/t/pikibun-git-2/bin;/t/pikibun-git-1/bin;C:\\Windows", BASH_ENV: join("/t/pikibun-git-2", "path.sh"), PIKIBUN_BASH_ENV: "" },
    "one an earlier connector set to a session's path.sh is emptied, not kept to run itself");
});

test("a session's git started inside another's (a session on the host running these tests) clones with the real git, not through the other's",
  { skip: !bashPath() || !spawnSync("git", ["--version"]).stdout }, async t => {
    const directory = await mkdtemp(join(tmpdir(), "nested-git-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const env: Record<string, string | undefined> = { ...process.env, GIT_AUTHOR_NAME: "U", GIT_AUTHOR_EMAIL: "u@e.test", GIT_COMMITTER_NAME: "U", GIT_COMMITTER_EMAIL: "u@e.test" };
    delete env.PIKIBUN_GIT_SHIM_DEPTH;
    const work = join(directory, "work");
    await mkdir(work);
    for (const args of [["init", "-q", "-b", "main"], ["commit", "-q", "--allow-empty", "-m", "initial"]]) {
      const result = spawnSync("git", args, { cwd: work, env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    }
    const asked: string[] = [];
    const outer = new HostGitShim({ mirror: async remote => { asked.push(`outer ${remote}`); return undefined; } });
    const inner = new HostGitShim({ mirror: async remote => { asked.push(`inner ${remote}`); return undefined; } });
    t.after(() => outer.close());
    t.after(() => inner.close());
    const [outerBin, innerBin] = [await outer.start(), await inner.start()];
    const outside = { ...env, ...hostGitEnvironment(outerBin, env) };
    const session = { ...outside, ...hostGitEnvironment(innerBin, outside), SOURCE: work, INNER: innerBin, OUTER: outerBin };
    const adjacent = "p() { if command -v cygpath >/dev/null 2>&1; then cygpath -u \"$1\"; else printf %s \"$1\"; fi; }; "
      + "PATH=\"$(p \"$INNER\"):$(p \"$OUTER\"):$PATH\"; export PATH; ";
    const cloned = await new Promise<{ code: number | null; out: string }>(resolve => {
      const child = spawn(bashPath()!, ["--noprofile", "--norc", "-c", `${adjacent}git clone -q "$SOURCE" app`], { cwd: directory, env: session });
      let out = "";
      child.stdout.on("data", chunk => { out += chunk; });
      child.stderr.on("data", chunk => { out += chunk; });
      const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
      child.on("close", code => { clearTimeout(timer); resolve({ code, out }); });
    });
    assert.equal(cloned.code, 0, cloned.out);
    assert.doesNotMatch(cloned.out, /running inside itself/);
    assert.deepEqual(asked, [`inner ${work}`], "only the innermost git hands the clone over, once");
    assert.equal(existsSync(join(directory, "app", ".git")), true);
  });

test("a git shim that finds itself running inside itself too many times over refuses, rather than starting another", async t => {
  const directory = await mkdtemp(join(tmpdir(), "git-shim-depth-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const program = join(directory, "git-clone.cjs");
  await writeFile(program, gitShimProgram({ proxy: true }));
  const run = (depth: number) => spawnSync(process.execPath, [program, "--version"],
    { env: { ...process.env, PIKIBUN_HOST_GIT: "git", PIKIBUN_GIT_SHIM_DEPTH: String(depth) }, encoding: "utf8" });
  const refused = run(GIT_SHIM_MAX_DEPTH);
  assert.equal(refused.status, 127);
  assert.match(refused.stderr, /pikibun: git's wrapper is running inside itself 8 times over: another git wrapper on PATH leads back to it/);
  if (spawnSync("git", ["--version"]).stdout) assert.match(run(GIT_SHIM_MAX_DEPTH - 1).stdout, /git version/);
});

test("the script BASH_ENV names keeps naming it in nested bashes, and runs the owner's own BASH_ENV in each", { skip: !posix }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "bash-env-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "path.sh"), hostGitBashScript(join(directory, "bin")));
  await writeFile(join(directory, "owner.sh"), `echo owner >> ${JSON.stringify(join(directory, "log"))}\n`);
  const result = spawnSync(bash, ["--noprofile", "--norc", "-c", "bash --noprofile --norc -c 'echo \"$BASH_ENV\"'"], { encoding: "utf8",
    env: { PATH: process.env.PATH, BASH_ENV: join(directory, "path.sh"), PIKIBUN_BASH_ENV: join(directory, "owner.sh") } });
  assert.equal(result.stdout.trim(), join(directory, "path.sh"));
  assert.equal(await readFile(join(directory, "log"), "utf8"), "owner\nowner\n");
});

test("on this platform, the host fills its repository cache, and a session on the host clones with its own git, borrowing it", { skip: !bashPath() || !spawnSync("git", ["--version"]).stdout }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "host-cache-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { ...process.env, GIT_AUTHOR_NAME: "U", GIT_AUTHOR_EMAIL: "u@e.test", GIT_COMMITTER_NAME: "U", GIT_COMMITTER_EMAIL: "u@e.test" };
  const run = (args: string[], cwd: string) => { const result = spawnSync("git", args, { cwd, env, encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  const work = join(directory, "work");
  await mkdir(work);
  run(["init", "-q", "-b", "main"], work);
  await writeFile(join(work, "README.md"), "upstream\n");
  run(["add", "README.md"], work);
  run(["commit", "-q", "-m", "initial"], work);
  await mkdir(join(directory, "projects", "acme"), { recursive: true });
  run(["clone", "-q", "--bare", work, join(directory, "projects", "acme", "app.git")], directory);
  const server = await startGitHttpServer(join(directory, "projects"));
  t.after(() => server.close());
  const repository = { bindingId: "binding-app", provider: "github", host: "github.com", repositoryId: "1701", fullName: "acme/app" } as const;
  const cache = new RepositoryCache({ root: join(directory, "cache") });
  await cache.refresh({ repository, ownerId: "test:alice", sessionId: "host", remote: new GitRemote({ url: server.url("acme/app.git") }) });
  const mirror = cache.mirrorDirectory(repository, "test:alice");
  assert.equal(await cache.filled(repository, "test:alice"), true);
  const asked: string[] = [];
  const shim = new HostGitShim({ mirror: async remote => { asked.push(remote); return mirror; } });
  t.after(() => shim.close());
  const bin = await shim.start();
  const session = { ...env, ...hostGitEnvironment(bin, env) };
  const shell = (command: string) => {
    const result = spawnSync(bashPath()!, ["--noprofile", "--norc", "-c", command], { cwd: directory, env: session, encoding: "utf8" });
    return { code: result.status, out: `${result.stdout}${result.stderr}` };
  };
  assert.match(shell("command -v git").out, /pikibun-git-/, "the session's git comes first, even where bash puts its own directories first");
  const cloned = await new Promise<{ code: number | null; out: string }>(resolve => {
    const child = spawn(bashPath()!, ["--noprofile", "--norc", "-c", `git clone -q ${server.url("acme/app.git")} app`], { cwd: directory, env: session });
    let out = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.stderr.on("data", chunk => { out += chunk; });
    child.on("close", code => resolve({ code, out }));
  });
  assert.equal(cloned.code, 0, cloned.out);
  assert.deepEqual(asked, [server.url("acme/app.git")]);
  const alternates = (await readFile(join(directory, "app", ".git", "objects", "info", "alternates"), "utf8")).trim();
  assert.equal(realpathSync.native(alternates), realpathSync.native(join(mirror, "objects")));
  assert.match(run(["count-objects", "-v"], join(directory, "app")), /^count: 0$/m);
  assert.equal((await readFile(join(directory, "app", "README.md"), "utf8")).replace(/\r\n/g, "\n"), "upstream\n");
  assert.match(shell("git --version").out, /git version/);
  assert.equal(asked.length, 1, "commands other than clone don't ask");
});

class Forge extends Unconfined {
  constructor(name: string, helper: "python" | "node", readonly forge: string) { super(name, true, helper); }
  override async launch(request: SandboxRequest, context: HelperContext, layout: HelperLayout): Promise<HelperLaunch> {
    const launch = await super.launch(request, context, layout);
    Object.assign(launch.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${this.forge}.insteadOf`, GIT_CONFIG_VALUE_0: "https://github.com/",
      GIT_AUTHOR_NAME: "U", GIT_AUTHOR_EMAIL: "u@example.test", GIT_COMMITTER_NAME: "U", GIT_COMMITTER_EMAIL: "u@example.test" });
    return launch;
  }
}

for (const helper of ["python", "node"] as const) {
  const label = helper === "python" ? "the Python helper (macOS)" : "the Node helper (Windows)";
  test(`${label} backs up a session's clones, and puts their local work back after a restore or move`, { skip: !posix || (helper === "python" && !python) }, async t => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "native-clones-")));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const work = join(directory, "work");
    await mkdir(work);
    const run = (args: string[], cwd: string) => assert.equal(spawnSync("git", args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "U", GIT_AUTHOR_EMAIL: "u@e.test",
      GIT_COMMITTER_NAME: "U", GIT_COMMITTER_EMAIL: "u@e.test" } }).status, 0);
    run(["init", "-q", "-b", "main"], work);
    await writeFile(join(work, "README.md"), "upstream\n");
    run(["add", "README.md"], work);
    run(["commit", "-q", "-m", "initial"], work);
    await mkdir(join(directory, "projects", "acme"), { recursive: true });
    run(["clone", "-q", "--bare", work, join(directory, "projects", "acme", "app.git")], directory);
    const server = await startGitHttpServer(join(directory, "projects"));
    t.after(() => server.close());
    const source = await workspace(t, new Forge(`${helper}-source`, helper, server.url("")));
    await source.execute({ kind: "bash", command: "git clone -q https://github.com/acme/app.git app && cd app && git switch -q -c feature && echo one > one.txt"
      + " && git add one.txt && git commit -q -m 'Local commit' && echo draft > draft.txt" }, false, allow);
    const backup = await source.cloneBackup(allow);
    assert.deepEqual(backup.found, ["app"]);
    const [clone] = backup.clones;
    assert.equal(clone!.branch, "feature");
    assert.equal(clone!.origin, "https://github.com/acme/app.git");
    assert.match(Buffer.from(clone!.bundle!, "base64").subarray(0, 20).toString("latin1"), /^# v[23] git bundle/);

    const target = await workspace(t, new Forge(`${helper}-target`, helper, server.url("")));
    await mkdir(join(target.layout.git, "pikibun-clones"));
    await writeFile(join(target.layout.git, "pikibun-clones", "0.bundle"), Buffer.from(clone!.bundle!, "base64"));
    const other = { ...clone, path: "other", origin: "https://example.test/café.git", branch: "café", branches: [["café", clone!.branches[0]![1]]], bundle: null };
    await writeFile(join(target.layout.git, "pikibun-clones", "manifest.json"), JSON.stringify({ version: 1, clones: [{ ...clone, bundle: "0.bundle" }, other] }));
    assert.deepEqual((await target.clonePending(allow)).map(entry => entry.path), ["app", "other"]);
    assert.equal((await target.cloneBackup(allow)).clones[0]!.bundle, clone!.bundle, "a clone still pending is backed up as it was");
    await symlink(join(directory, "nowhere"), join(target.layout.worktree, "app"));
    await assert.rejects(target.cloneRestore("app", "https://github.com/acme/app.git", null, allow), /something else is already at the clone's path/,
      "a link at the clone's path, even one that points nowhere, isn't replaced");
    await rm(join(target.layout.worktree, "app"));
    await target.cloneRestore("app", "https://github.com/acme/app.git", null, allow);
    assert.equal(await target.execute({ kind: "bash", command: "cd app && git rev-parse --abbrev-ref HEAD && git log --format=%s -1 && git status --porcelain" }, false, allow),
      "feature\nLocal commit\n?? draft.txt\n");
    assert.equal(await target.readFile("app/draft.txt", allow), "draft\n");
    assert.deepEqual(await target.clonePending(allow), [{ path: "other", origin: "https://example.test/café.git" }]);
    const kept = JSON.parse(await readFile(join(target.layout.git, "pikibun-clones", "manifest.json"), "utf8")) as { clones: typeof other[] };
    assert.deepEqual(kept.clones, [other], "the clones still pending are kept as they were, names and all");
    await assert.rejects(target.cloneRestore("app", "https://github.com/acme/app.git", null, allow), /no restoration is pending/);
  });
}

test("without hard limits (macOS), shell commands run only where the host's owner allowed them", { skip: !posix || !python }, async t => {
  const sandbox = await workspace(t, new Unconfined("unlimited", false, "python"));
  await assert.rejects(sandbox.execute({ kind: "bash", command: "true" }, false, allow), /no hard per-session resource limits/);
  assert.equal(await sandbox.execute({ kind: "bash", command: "echo ok" }, false, allow, { unbounded: true }), "ok\n");
});

test("each step gets only what it needs: read-only file reads, a writable Git directory only for the workspace's own Git, the network only for commands",
  { skip: !posix || !python }, async t => {
    const backend = new Unconfined("contexts", true, "python");
    const sandbox = await workspace(t, backend);
    await sandbox.readFile(".git", allow).catch(() => undefined);
    await sandbox.writeFile("a.txt", "x", allow);
    await sandbox.execute({ kind: "bash", command: "true" }, false, allow);
    const by = (kind: string) => backend.launched.find(entry => entry.request.kind === kind)!.context;
    assert.deepEqual([by("initialize").readOnly, by("initialize").gitWritable], [false, true]);
    assert.deepEqual([by("read").readOnly, by("read").gitWritable, by("read").egress], [true, false, false]);
    assert.deepEqual([by("write").readOnly, by("write").gitWritable], [false, false]);
    assert.equal(by("bash").egress, false);
  });

function call(port: number, init: { method?: string; path: string; headers?: Record<string, string> }): Promise<{ status: number; headers: IncomingMessage["headers"]; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, method: init.method ?? "GET", path: init.path, headers: init.headers }, response => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("connect", response => { response.resume(); resolve({ status: response.statusCode!, headers: response.headers, body: "" }); request.destroy(); });
    request.on("error", reject);
    request.end();
  });
}

test("a proxy for sandboxes that share the host's network listens on loopback only, and serves only requests carrying the session's token", async t => {
  const directory = await mkdtemp(join(tmpdir(), "egress-tcp-"));
  const grant: EgressGrant = { policy: { mode: "off", domains: [], packageRegistries: true }, repositories: [] };
  const proxy = new EgressProxy({ socketPath: join(directory, "unused.sock"), tcp: { token: "session-token" }, grant: async () => grant,
    relay: async () => new Response("no") });
  await proxy.start();
  t.after(async () => { await proxy.close(); await rm(directory, { recursive: true, force: true }); });
  assert.ok(!existsSync(join(directory, "unused.sock")), "no socket: the sandbox reaches the proxy only on its port");
  const endpoint = proxy.endpoint as EgressEndpoint;
  assert.ok(endpoint && endpoint.port > 0);
  const basic = (token: string) => `Basic ${Buffer.from(`pikibun:${token}`).toString("base64")}`;

  const anonymous = await call(endpoint.port, { path: "/__pikibun/status" });
  assert.equal(anonymous.status, 401);
  assert.match(String(anonymous.headers["www-authenticate"]), /Basic/);
  assert.equal((await call(endpoint.port, { path: "/__pikibun/status", headers: { Authorization: basic("wrong") } })).status, 401);
  const status = await call(endpoint.port, { path: "/__pikibun/status", headers: { Authorization: basic("session-token") } });
  assert.equal(status.status, 200);
  assert.match(JSON.parse(status.body).gitRemotes, new RegExp(`127\\.0\\.0\\.1:${endpoint.port}/git/`));

  assert.equal((await call(endpoint.port, { path: "http://example.com/" })).status, 407);
  assert.equal((await call(endpoint.port, { method: "CONNECT", path: "example.com:443" })).status, 407);
  assert.equal((await call(endpoint.port, { method: "CONNECT", path: "example.com:443", headers: { "Proxy-Authorization": basic("session-token") } })).status, 403);

  const environment = egressEnvironment("pikibun/work-1", endpoint, "/session/ca.crt");
  assert.equal(environment.HTTPS_PROXY, `http://pikibun:session-token@127.0.0.1:${endpoint.port}`);
  assert.equal(environment.GIT_CONFIG_KEY_0, `url.http://pikibun:session-token@127.0.0.1:${endpoint.port}/git/.insteadOf`);
  assert.equal(environment.SSL_CERT_FILE, "/session/ca.crt");
  assert.equal(environment.PIKIBUN_SESSION_BRANCH, "pikibun/work-1");
});

const layout: HelperLayout = { root: "/s", home: "/s/home", worktree: "/s/worktree", git: "/s/git", ownerConfig: "/s/owner.gitconfig", bin: "/s/bin", caBundle: "/s/ca.crt" };

test("the Seatbelt profile denies by default, passes paths as parameters, and opens writes and the network per step", () => {
  const read = seatbeltProfile({ layout, readOnly: true, gitWritable: false, toolRoots: ["/opt/homebrew"] });
  assert.match(read.profile, /^\(version 1\)\n\(deny default\)\n/);
  assert.ok(!read.profile.includes("trustd"), "no trustd lookup");
  assert.ok(!read.profile.includes("/s/"), "no session path is spliced into the profile");
  assert.equal(read.parameters.WORKTREE, "/s/worktree");
  assert.equal(read.parameters.TOOL_0, "/opt/homebrew");
  assert.ok(!/\(allow file-write\* \(subpath \(param "WORKTREE"/.test(read.profile));
  assert.ok(!read.profile.includes("network-outbound (remote ip"));
  assert.ok(read.profile.trimEnd().endsWith('(deny file-write* (subpath (param "GIT_DIR")))'));

  const command = seatbeltProfile({ layout, readOnly: false, gitWritable: false, egressPort: 51234, toolRoots: [] });
  assert.match(command.profile, /\(allow file-write\* \(subpath \(param "HOME_DIR"\)\) \(subpath \(param "WORKTREE"\)\)\)/);
  assert.match(command.profile, /\(allow network-outbound \(remote ip "localhost:51234"\)\)/);
  assert.ok(!command.profile.includes('(allow network-outbound (remote ip "localhost:*"))'));
  const lines = command.profile.trimEnd().split("\n");
  assert.deepEqual(lines.slice(-2), ['(deny file-write* (literal (param "GIT_POINTER")))', '(deny file-write* (subpath (param "GIT_DIR")))']);

  const gitStep = seatbeltProfile({ layout, readOnly: false, gitWritable: true, toolRoots: [] });
  assert.match(gitStep.profile, /\(allow file-write\* \(subpath \(param "GIT_DIR"\)\)\)/);
  assert.ok(!gitStep.profile.includes('(deny file-write* (subpath (param "GIT_DIR")))'));
  assert.throws(() => seatbeltProfile({ layout, readOnly: false, gitWritable: false, egressPort: 70000, toolRoots: [] }), /Invalid egress port/);
});

test("the Seatbelt profile lets a step read only the repository mirrors it was given, by parameter, and the git shim runs on the sandbox's Python", () => {
  const plain = seatbeltProfile({ layout, readOnly: false, gitWritable: false, toolRoots: [] });
  assert.ok(!plain.profile.includes("MIRROR_"));
  const mirror = "/state/repo-cache/github/github.com/1701.git";
  const given = seatbeltProfile({ layout, readOnly: false, gitWritable: false, toolRoots: [], mirrors: [mirror, "/state/repo-cache/owners/ab/github/github.com/1702.git"] });
  assert.equal(given.parameters.MIRROR_0, mirror);
  assert.match(given.profile, /\(allow file-read\* \(subpath \(param "MIRROR_0"\)\) \(subpath \(param "MIRROR_1"\)\)\)/);
  assert.ok(!given.profile.includes("/state/"), "no mirror path is spliced into the profile");
  assert.ok(!/file-write\*[^\n]*MIRROR_/.test(given.profile), "mirrors are only read");
  for (const bad of ["relative/1701.git", "/state/../etc/1701.git", "/state/repo-cache/not-a-mirror", "/state/\"quoted\"/1701.git"]) {
    assert.throws(() => seatbeltProfile({ layout, readOnly: false, gitWritable: false, toolRoots: [], mirrors: [bad] }), /Invalid repository mirror path/);
  }
  const shim = seatbeltGitShim("/Library/Developer/CommandLineTools/usr/bin/python3");
  assert.ok(shim.startsWith("#!/Library/Developer/CommandLineTools/usr/bin/python3 -I\n"));
  assert.equal(shim.slice(shim.indexOf("\n")), GIT_SHIM.slice(GIT_SHIM.indexOf("\n")));
  assert.throws(() => seatbeltGitShim("python3"), /Invalid Python path/);
});

test("with the host's cache, the helper workspace installs its backend's git shim and gives the steps that run Git in a clone the session's mirrors",
  { skip: !posix || !python }, async t => {
    class Cached extends Unconfined {
      installed = 0;
      async installGitShim(): Promise<void> { this.installed++; }
      override async launch(request: SandboxRequest, context: HelperContext, layout: HelperLayout): Promise<HelperLaunch> {
        const launch = await super.launch(request, context, layout);
        if (context.mirrors?.length) launch.env.SANDBOX_MIRRORS = context.mirrors.join("\n");
        return launch;
      }
    }
    const backend = new Cached("cached", true, "python");
    const source = "/state/repo-cache/github/github.com/1701.git";
    let mounts = [{ source, target: "/repository-mirrors/github/github.com/1701.git" }, { source: "../escape.git", target: "/repository-mirrors/x/y/1.git" }];
    const directory = await realpath(await mkdtemp(join(tmpdir(), "native-cached-")));
    const sandbox = new HelperWorkspace(binding("native-cached"), join(directory, "sandbox"), backend, { mirrors: async () => mounts });
    t.after(async () => { await sandbox.close(); await rm(directory, { recursive: true, force: true }); });
    await sandbox.initialize();
    assert.equal(backend.installed, 1);
    await sandbox.readFile(".git", allow).catch(() => undefined);
    await sandbox.execute({ kind: "bash", command: "git init -q -b main app && git -C app commit -q --allow-empty -m first" }, false, allow);
    await sandbox.cloneHead("app", allow);
    const by = (kind: string) => backend.launched.filter(entry => entry.request.kind === kind).map(entry => entry.context);
    assert.deepEqual(by("bash")[0]!.mirrors, [source]);
    assert.equal(by("bash")[0]!.gitShim, undefined, "without a proxy, no shim on PATH");
    assert.deepEqual(by("clone-head")[0]!.mirrors, [source]);
    assert.equal(by("read")[0]!.mirrors, undefined);
    assert.equal(by("initialize")[0]!.mirrors, undefined);
    await assert.rejects(sandbox.cloneRestore("app", "https://github.com/acme/app.git", "/etc/passwd", allow), /Invalid clone restoration/);
    await assert.rejects(sandbox.cloneRestore("app", "https://github.com/acme/app.git", "/elsewhere/github/github.com/1702.git", allow), /invalid clone restoration/,
      "the helper takes only a mirror its step was given");
    await assert.rejects(sandbox.cloneRestore("app", "https://github.com/acme/app.git", source, allow), /no restoration is pending/);
    mounts = [];
    await sandbox.execute({ kind: "bash", command: "true" }, false, allow);
    assert.equal(by("bash").at(-1)!.mirrors, undefined);
    const plain = await workspace(t, new Unconfined("plain", true, "python"));
    await assert.rejects(plain.cloneRestore("app", "https://github.com/acme/app.git", source, allow), /Invalid clone restoration/, "no cache, no reference");
  });

test("in the macOS sandbox, a clone borrows the host's mirror through the git shim, and reads it only in steps that were given it", { skip: seatbeltMissing() }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "seatbelt-cache-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const environment = { ...process.env, GIT_AUTHOR_NAME: "U", GIT_AUTHOR_EMAIL: "u@example.test", GIT_COMMITTER_NAME: "U", GIT_COMMITTER_EMAIL: "u@example.test" };
  const run = (args: string[], cwd: string) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", env: environment });
    assert.equal(result.status, 0, result.stderr);
  };
  const work = join(directory, "work");
  await mkdir(work);
  run(["init", "-q", "-b", "main"], work);
  await writeFile(join(work, "README.md"), "from upstream\n");
  run(["add", "README.md"], work);
  run(["commit", "-q", "-m", "initial"], work);
  await mkdir(join(directory, "projects", "acme"), { recursive: true });
  run(["clone", "-q", "--bare", work, join(directory, "projects", "acme", "app.git")], directory);
  const server = await startGitHttpServer(join(directory, "projects"));
  t.after(() => server.close());
  const repository = { bindingId: "binding-app", provider: "github", host: "github.com", repositoryId: "1701", fullName: "acme/app" } as const;
  const cache = new RepositoryCache({ root: join(directory, "cache") });
  await cache.refresh({ repository, ownerId: "test:alice", sessionId: "earlier", remote: new GitRemote({ url: server.url("acme/app.git") }) });
  const source = cache.mirrorDirectory(repository, "test:alice");
  const relay = async (request: RelayRequest) => fetch(request.service === "info-refs"
    ? `${server.url("acme/app.git")}/info/refs?service=git-upload-pack` : `${server.url("acme/app.git")}/git-upload-pack`, {
    method: request.body ? "POST" : "GET", body: request.body,
    headers: { ...(request.contentType ? { "content-type": request.contentType } : {}), ...(request.gitProtocol ? { "git-protocol": request.gitProtocol } : {}) },
  });
  const grant: EgressGrant = { policy: { mode: "off", domains: [], packageRegistries: true }, repositories: [repository] };
  const proxy = new EgressProxy({ socketPath: join(directory, "unused.sock"), tcp: { token: "session-token" }, grant: async () => grant, relay, mirror: async () => source });
  await proxy.start();
  t.after(() => proxy.close());
  let given = true;
  const sandbox: HelperWorkspace = new HelperWorkspace(binding("seatbelt-cache"), join(directory, "sandbox"), new SeatbeltBackend(), {
    egressEnvironment: () => egressEnvironment(undefined, proxy.endpoint!, sandbox.layout.caBundle),
    mirrors: async () => given ? [{ source, target: "/repository-mirrors/github/github.com/1701.git" }] : [],
  });
  t.after(() => sandbox.close());
  await sandbox.initialize();
  const shell = (command: string) => sandbox.execute({ kind: "bash", command }, false, allow, { unbounded: true });
  assert.doesNotMatch(await shell("git clone -q https://github.com/acme/app.git app"), /pikibun:/);
  assert.equal(await sandbox.readFile("app/README.md", allow), "from upstream\n");
  assert.equal((await sandbox.readFile("app/.git/objects/info/alternates", allow)).trim().replace(/^\/private\//, "/"), join(source, "objects").replace(/^\/private\//, "/"));
  assert.equal((await shell("cd app && git count-objects -v | grep '^count\\|^in-pack'")).trim(), "count: 0\nin-pack: 0");
  assert.match(await shell("cd app && git log --oneline"), /initial/);
  const head = await sandbox.cloneHead("app", allow);
  assert.match(head.commit, /^[0-9a-f]{40}$/);
  given = false;
  await assert.rejects(shell("git clone -q https://github.com/acme/app.git again"),
    (error: { stderr?: string; message?: string }) => /this command started before it could see it; run the clone again/.test(`${error.stderr ?? ""}${error.message ?? ""}`));
  await assert.rejects(shell("cd app && git log --oneline"), "a step not given the mirror can't read what the clone borrows");
});

test("the platform sandboxes refuse to start anywhere but their own platform, never falling back", { skip: process.platform === "darwin" || process.platform === "win32" }, () => {
  assert.throws(() => new SeatbeltBackend({ python: "/x", git: "/x", bash: "/x", roots: [], path: "" }), /only on macOS/);
  assert.throws(() => new WindowsBackend({ runtime: "/nowhere", limits: { memoryBytes: 1 << 30, processes: 64, cpuPercent: 50 } }), /only on Windows/);
  assert.throws(() => assertConnectorPlatform({ experimentalSandbox: true }), /for macOS and native Windows/);
});

test("a workspace opens again over its own read-only files, and a step that should have the network fails without a proxy", { skip: !posix || !python }, async t => {
  const backend = new Unconfined("reopen", true, "python");
  const first = await workspace(t, backend);
  await first.writeFile("kept.txt", "kept", allow);
  await first.close();
  const again = new HelperWorkspace(binding("native-reopen"), first.layout.root, backend);
  t.after(() => again.close());
  await again.initialize();
  assert.equal(await again.readFile("kept.txt", allow), "kept");
  const context = { readOnly: false, gitWritable: false, deadlineMs: 1000 };
  assert.equal(egressPort({ ...context, egress: false, environment: {} }), undefined);
  assert.equal(egressPort({ ...context, egress: true, environment: { HTTPS_PROXY: "http://pikibun:t@127.0.0.1:41234" } }), 41234);
  assert.throws(() => egressPort({ ...context, egress: true, environment: {} }), /egress proxy endpoint is missing/);
  assert.throws(() => egressPort({ ...context, egress: true, environment: { HTTPS_PROXY: "http://127.0.0.1:41234" } }), /egress proxy endpoint is missing/);
});

const FAKE_SDK = (tier: string) => `
import { spawn as start } from "node:child_process";
export function probe() { return { tier: ${JSON.stringify(tier)}, warnings: [], probes: {} }; }
export async function spawn(request) {
  const child = start(process.execPath, ["-e", "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{process.stdout.write('container:'+s);process.exitCode=7})"], { stdio: ["pipe", "pipe", "pipe"] });
  return { standardInput: child.stdin, standardOutput: child.stdout, standardError: child.stderr,
    wait: () => new Promise(resolve => child.on("close", code => resolve({ exitCode: code, timedOut: false }))) };
}
`;

test("the Windows runner reads only its configuration, passes everything after it to the container once, and refuses MXC's fallback tiers", async t => {
  const directory = await mkdtemp(join(tmpdir(), "windows-runner-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "runner.mjs"), WINDOWS_RUNNER);
  const run = async (tier: string, input: string) => {
    await writeFile(join(directory, `sdk-${tier}.mjs`), FAKE_SDK(tier));
    const config = JSON.stringify({ sdk: join(directory, `sdk-${tier}.mjs`), request: {} });
    return spawnSync(process.execPath, [join(directory, "runner.mjs")], { input: `${config}\n${input}`, encoding: "utf8" });
  };
  const request = `${JSON.stringify({ kind: "read", path: "a" })}\n${"x".repeat(200_000)}`;
  const passed = await run("base-container", request);
  assert.equal(passed.status, 7, passed.stderr);
  assert.equal(passed.stdout, `container:${request}`);
  const refused = await run("appcontainer-dacl", request);
  assert.equal(refused.status, 70);
  assert.match(refused.stderr, /never uses MXC's AppContainer fallbacks/);
  assert.equal(refused.stdout, "");
});

test("the Node helper gives commands the session's own proxy URL back, after MXC replaced it with one without the token", { skip: !posix }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "node-helper-proxy-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "helper.mjs"), NODE_HELPER);
  const own = "http://pikibun:session-token@127.0.0.1:41234";
  const run = (extra: Record<string, string>) => spawnSync(process.execPath, [join(directory, "helper.mjs")], {
    input: JSON.stringify({ kind: "bash", command: "echo \"$HTTPS_PROXY $https_proxy $HTTP_PROXY $http_proxy ${SANDBOX_EGRESS_PROXY:-unset} [$NO_PROXY] [$no_proxy] ${SANDBOX_EGRESS_NO_PROXY:-unset}\"" }) + "\n",
    encoding: "utf8", cwd: directory,
    env: { PATH: process.env.PATH, HOME: directory, SANDBOX_WORKTREE: directory, SANDBOX_BASH: bash,
      HTTPS_PROXY: "http://127.0.0.1:41234", https_proxy: "http://127.0.0.1:41234", HTTP_PROXY: "http://127.0.0.1:41234", http_proxy: "http://127.0.0.1:41234",
      NO_PROXY: "", no_proxy: "", ...extra },
  });
  const restored = run({ SANDBOX_EGRESS_PROXY: own, SANDBOX_EGRESS_NO_PROXY: "localhost,127.0.0.1,::1" });
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(restored.stdout, `${own} ${own} ${own} ${own} unset [localhost,127.0.0.1,::1] [localhost,127.0.0.1,::1] unset\n`);
  assert.equal(run({}).stdout, "http://127.0.0.1:41234 http://127.0.0.1:41234 http://127.0.0.1:41234 http://127.0.0.1:41234 unset [] [] unset\n");
});

const FAKE_CHECK_SDK = (tier: string, options: { identityless?: boolean; denied?: boolean } = {}) => `
import { spawn as start } from "node:child_process";
export function probe() { return { tier: ${JSON.stringify(tier)}, warnings: [], probes: { baseContainerSupportsIdentitylessLoopbackProxy: ${options.identityless ?? true} } }; }
export async function spawn(request) {
  const child = ${options.denied
    ? `start(process.execPath, ["-e", "process.stderr.write(\\"Error: EPERM: operation not permitted, realpath 'C:\\\\\\\\work'\\\\n\\");process.exit(1)"], { stdio: ["pipe", "pipe", "pipe"] })`
    : `start(request.command, { shell: true, cwd: request.workingDirectory, stdio: ["pipe", "pipe", "pipe"] })`};
  return { standardInput: child.stdin, standardOutput: child.stdout, standardError: child.stderr,
    wait: () => new Promise(resolve => child.on("close", code => resolve({ exitCode: code, timedOut: false }))) };
}
`;

test("the Windows setup check runs a session's container and resolves a path in it, so builds where Git can't work are refused", async t => {
  const directory = await mkdtemp(join(tmpdir(), "windows-check-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const check = async (name: string, source: string) => {
    await writeFile(join(directory, `${name}.mjs`), source);
    return windowsSandboxSupport(join(directory, `${name}.mjs`), process.execPath);
  };
  assert.deepEqual(await check("works", FAKE_CHECK_SDK("base-container")), { container: true, paths: true });
  const denied = await check("denied", FAKE_CHECK_SDK("base-container", { denied: true }));
  assert.deepEqual([denied.container, denied.paths], [true, false]);
  assert.match(denied.detail!, /EPERM: operation not permitted, realpath/);
  const fallback = await check("fallback", FAKE_CHECK_SDK("appcontainer-dacl"));
  assert.deepEqual([fallback.container, fallback.paths], [false, false]);
  assert.match(fallback.detail!, /MXC chose appcontainer-dacl/);
  assert.match((await check("no-proxy", FAKE_CHECK_SDK("base-container", { identityless: false }))).detail!, /without proxy-only egress/);
  assert.match((await windowsSandboxSupport(join(directory, "missing.mjs"), process.execPath)).detail!, /could not be loaded/);
});

test("the Windows runner and helper are valid modules, and job limits are checked", async t => {
  const directory = await mkdtemp(join(tmpdir(), "windows-scripts-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [name, source] of [["runner.mjs", WINDOWS_RUNNER], ["helper.mjs", NODE_HELPER], ["check.mjs", WINDOWS_SUPPORT_CHECK]] as const) {
    await writeFile(join(directory, name), source);
    const check = spawnSync(process.execPath, ["--check", join(directory, name)], { encoding: "utf8" });
    assert.equal(check.status, 0, `${name}: ${check.stderr}`);
  }
  assert.deepEqual(validWindowsLimits({ memoryBytes: 1 << 30, processes: 64, cpuPercent: 25 }), { memoryBytes: 1 << 30, processes: 64, cpuPercent: 25 });
  assert.throws(() => validWindowsLimits({ memoryBytes: 1024, processes: 64, cpuPercent: 25 }), /memory/);
  assert.throws(() => validWindowsLimits({ memoryBytes: 1 << 30, processes: 1, cpuPercent: 25 }), /process/);
  assert.throws(() => validWindowsLimits({ memoryBytes: 1 << 30, processes: 64, cpuPercent: 0 }), /CPU/);
});

test("the Windows sandbox's steps run on the connector's own Node", () => {
  assert.equal(sandboxNodePath(), process.execPath);
});

test("in the macOS sandbox, an installed extension runs in a process Seatbelt confines: the worktree and its own files, nothing else of the host's, no network", { skip: seatbeltMissing() }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "native-extension-")));
  const sandbox = new HelperWorkspace(binding("native-extension"), join(directory, "sandbox"), new SeatbeltBackend());
  t.after(async () => { await sandbox.close(); await rm(directory, { recursive: true, force: true }); });
  await sandbox.initialize();
  assert.equal(sandbox.runsProcesses, true);
  assert.ok(sandbox.nodeBin, "the host's Node.js is given to the sandbox");
  await sandbox.writeFile("notes.txt", "in the worktree", allow);
  const secret = join(directory, "host-secret.txt");
  await writeFile(secret, "the host's own");
  const extension = join(directory, "extension");
  await mkdir(extension);
  const file = join(extension, "probe.ts");
  await writeFile(file, `import { Type } from "typebox";
    import { readFileSync, writeFileSync } from "node:fs";
    const attempt = work => { try { return String(work()); } catch (error) { return "refused: " + error.code; } };
    export default function (pi) {
      pi.registerTool({ name: "probe", label: "Probe", description: "Probe the sandbox.", parameters: Type.Object({}),
        async execute(_id, _params, _signal, _onUpdate, ctx) {
          let network;
          try { await fetch("https://example.com/", { signal: AbortSignal.timeout(5000) }); network = "reached"; } catch { network = "unreachable"; }
          return { content: [{ type: "text", text: JSON.stringify({
            cwd: ctx.cwd, worktree: attempt(() => readFileSync("notes.txt", "utf8")),
            host: attempt(() => readFileSync(${JSON.stringify(secret)}, "utf8")),
            own: attempt(() => readFileSync(${JSON.stringify(file)}, "utf8").length > 0),
            writeOwn: attempt(() => writeFileSync(${JSON.stringify(join(extension, "written"))}, "x")),
            writeWorktree: attempt(() => { writeFileSync("made.txt", "x"); return "written"; }),
            network }) }], details: undefined };
        } });
    }`);
  const output: string[] = [];
  const channel = new ProcessChannel({ directory: sandbox.worktree, warn: (source, message) => { output.push(`${source}: ${message}`); }, log: line => { output.push(line); },
    mountAllowed: path => sandbox.bindAllowed(path),
    launch: confinedLaunch(sandbox) });
  t.after(() => channel.close());
  assert.throws(() => sandbox.processCommand("node", [], ["/"]), /can't be given/);
  const opened = await channel.call("open", { source: "local:probe", files: [file], models: [], mount: extension }).catch(error => {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${output.join("\n")}`);
  });
  assert.deepEqual(opened.value.errors, [], output.join("\n"));
  const answer = await channel.call("execute", { source: "local:probe", settings: {}, tool: "probe", callId: "c", args: {} });
  const seen = JSON.parse((answer.value.content[0] as { text: string }).text) as Record<string, string>;
  assert.equal(seen.cwd, sandbox.worktree);
  assert.equal(seen.worktree, "in the worktree");
  assert.match(seen.host!, /^refused: (EPERM|EACCES)$/, "a host file outside what it was given can't be read");
  assert.equal(seen.own, "true", "its own files can");
  assert.match(seen.writeOwn!, /^refused: (EPERM|EACCES)$/, "but not written");
  assert.equal(seen.writeWorktree, "written", "the worktree is the session's to change");
  assert.equal(seen.network, "unreachable", "without the session's egress proxy there is no network");
});

test("in the macOS sandbox, an installed extension is described without its load-time code reading the host's files", { skip: seatbeltMissing() }, async t => {
  const state = await realpath(await mkdtemp(join(tmpdir(), "native-describe-")));
  t.after(() => rm(state, { recursive: true, force: true }));
  const secret = join(state, "host-secret.txt");
  await writeFile(secret, "the host's own");
  const extension = join(state, "extension");
  await mkdir(extension);
  const file = join(extension, "peek.ts");
  await writeFile(file, `import { Type } from "typebox";
    import { readFileSync } from "node:fs";
    let seen;
    try { seen = readFileSync(${JSON.stringify(secret)}, "utf8"); } catch (error) { seen = "refused: " + error.code; }
    export default function (pi) {
      pi.registerTool({ name: "peek", label: "Peek", description: seen, parameters: Type.Object({}), async execute() { return { content: [], details: undefined }; } });
    }`);
  const describe = helperDescribe(state, () => new SeatbeltBackend());
  const [module] = await describe({ root: extension, files: [file], mount: extension });
  assert.equal(module!.error, undefined);
  assert.match(module!.tools[0]!.description, /^refused: (EPERM|EACCES)$/);
  const [again] = await describe({ root: extension, files: [file], mount: extension });
  assert.equal(again!.tools[0]!.name, "peek");
});
