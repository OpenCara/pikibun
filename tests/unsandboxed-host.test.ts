import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONNECTOR_ENVIRONMENT, HostWorkspace, hostOwnersSession } from "../apps/runner/src/host-workspace.js";
import { stringVars } from "../apps/server/src/config.js";
import { runHostShell } from "../apps/runner/src/host-shell.js";
import { Sandbox, type SandboxAuthorize } from "../apps/runner/src/sandbox.js";
import { isolatedWorkspace } from "../apps/runner/src/workspace.js";
import type { SessionRepository } from "../packages/shared/src/repositories.js";
import type { RunnerBinding } from "../packages/shared/src/types.js";

const hostMode = { skip: !["linux", "darwin", "win32"].includes(process.platform) || spawnSync("git", ["--version"]).status !== 0 };
const printWorkingDirectory = process.platform === "win32" ? 'cygpath -w "$PWD"' : "pwd";
const authorize: SandboxAuthorize = async () => {};

function binding(id: string, repositories: SessionRepository[] = []): RunnerBinding {
  return {
    session: { id, workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1", title: "Host mode", policyVersion: 1, status: "ready", createdAt: "2026-01-01T00:00:00Z", repositories },
    owner: { id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice Owner", gitEmail: "alice@example.test", env: { APP_TEAM: "core" }, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: "test:alice", workspaceId: "workspace", version: 1, name: "Agent", description: "", instructions: "Use tools.", tools: ["read_file", "write_file", "bash"], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "workspace", name: "Model", provider: "openai", modelId: "local" },
  };
}

async function hostWorkspace(t: TestContext, repositories: SessionRepository[] = []): Promise<{ workspace: HostWorkspace; outside: string }> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pikibun-host-")));
  const workspace = new HostWorkspace(binding("host-session", repositories), join(directory, "session"));
  t.after(async () => { await workspace.close(); await rm(directory, { recursive: true, force: true }); });
  await workspace.initialize();
  return { workspace, outside: directory };
}

test("the Linux sandbox never falls back to host execution on other platforms", { skip: process.platform === "linux" }, () => {
  assert.throws(() => new Sandbox(binding("implicit"), join(tmpdir(), "pikibun-implicit")), /requires Linux/);
});

test("a host workspace is not isolated, so the sandbox's clone steps are refused rather than run on the host", hostMode, async t => {
  const { workspace } = await hostWorkspace(t);
  assert.equal(workspace.isolated, false);
  assert.throws(() => isolatedWorkspace(workspace), /needs the sandbox/);
});

test("unsandboxed file tools stay inside the session worktree", hostMode, async t => {
  const { workspace, outside } = await hostWorkspace(t);
  await workspace.writeFile("notes/plan.md", "inside", authorize);
  assert.equal(await workspace.readFile("notes/plan.md", authorize), "inside");
  assert.equal(await readFile(join(workspace.worktree, "notes/plan.md"), "utf8"), "inside");
  assert.deepEqual(await workspace.listFiles(".", authorize), [".git", "notes"]);
  await writeFile(join(outside, "secret.txt"), "host secret");
  await symlink(outside, join(workspace.worktree, "escape"));
  for (const path of ["../secret.txt", "../../secret.txt", "/etc/hosts", ".git/config", "escape/secret.txt", "notes/../../secret.txt"]) {
    await assert.rejects(workspace.writeFile(path, "overwritten", authorize), `write ${path}`);
  }
  await assert.rejects(workspace.readFile("escape/secret.txt", authorize), /escapes the worktree/);
  assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "host secret");
});

test("approved unsandboxed commands run in the worktree without the connector environment", hostMode, async t => {
  const { workspace } = await hostWorkspace(t);
  process.env.PIKIBUN_CONNECTOR_SECRET = "must-not-leak";
  t.after(() => { delete process.env.PIKIBUN_CONNECTOR_SECRET; });
  const output = await workspace.execute({ kind: "bash", command: `${printWorkingDirectory}; echo "\${PIKIBUN_CONNECTOR_SECRET:-unset} $APP_TEAM"` }, false, authorize);
  assert.equal(output, `${workspace.worktree}\nunset core\n`);
  await assert.rejects(workspace.execute({ kind: "bash", command: "true" }, true, authorize), /read-only/);
  await assert.rejects(workspace.execute({ kind: "bash", command: "exit 3" }, false, authorize), /exit 3/);
  await workspace.writeFile("README.md", "hello", authorize);
  await workspace.execute({ kind: "bash", command: "git add -A && git commit -q -m 'Owner commit'" }, false, authorize);
  const log = await workspace.execute({ kind: "bash", command: "git log -1 --format='%an <%ae>|%cn <%ce>|%s'" }, false, authorize);
  assert.equal(log.trim(), "Alice Owner <alice@example.test>|Alice Owner <alice@example.test>|Owner commit");
  const snapshot = await workspace.snapshot(authorize);
  assert.ok(snapshot.some(file => file.path === "worktree/README.md" && Buffer.from(file.data, "base64").toString() === "hello"));
  assert.ok(snapshot.some(file => file.path === "owner.gitconfig"));
});

test("the host owner's own session runs in the owner's own environment, without Pikibun's or the server's configuration", hostMode, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pikibun-host-owner-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = join(directory, "owner home");
  await mkdir(home);
  await writeFile(join(home, ".gitconfig"), "[alias]\n\twho = config --get pikibun.marker\n[pikibun]\n\tmarker = from-the-owner\n");
  const saved = { HOME: process.env.HOME, SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
  delete process.env.GIT_CONFIG_GLOBAL;
  delete process.env.GIT_CONFIG_NOSYSTEM;
  Object.assign(process.env, { HOME: home, SSH_AUTH_SOCK: join(directory, "agent.sock"), PIKIBUN_CONNECTOR_SECRET: "must-not-leak",
    SESSION_SECRET: "server-secret", GITHUB_CLIENT_SECRET: "oauth-secret", RUNNER_SHARED_SECRET: "runner-secret" });
  t.after(() => {
    for (const name of ["PIKIBUN_CONNECTOR_SECRET", "SESSION_SECRET", "GITHUB_CLIENT_SECRET", "RUNNER_SHARED_SECRET"]) delete process.env[name];
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  });
  const own = binding("host-owner");
  own.session.connectorId = "host";
  own.session.connectorOwnerId = own.owner.id;
  const workspace = new HostWorkspace(own, join(directory, "session"), { ownerEnvironment: true });
  t.after(() => workspace.close());
  await workspace.initialize();
  const show = 'echo "$HOME|$SSH_AUTH_SOCK|${PIKIBUN_CONNECTOR_SECRET:-unset}|${SESSION_SECRET:-unset}|${GITHUB_CLIENT_SECRET:-unset}|${RUNNER_SHARED_SECRET:-unset}|$APP_TEAM"; git who';
  assert.equal(await workspace.execute({ kind: "bash", command: show }, false, authorize),
    `${home}|${join(directory, "agent.sock")}|unset|unset|unset|unset|core\nfrom-the-owner\n`);
  assert.equal((await workspace.identity(authorize)).home, home, "identity names the HOME its commands run with");
  await workspace.writeFile("README.md", "hello", authorize);
  await workspace.execute({ kind: "bash", command: "git add -A && git commit -q -m 'Owner commit'" }, false, authorize);
  assert.equal((await workspace.execute({ kind: "bash", command: "git log -1 --format='%an <%ae>'" }, false, authorize)).trim(), "Alice Owner <alice@example.test>");
  assert.ok((await workspace.snapshot(authorize)).every(file => !file.path.includes("owner home")), "a backup holds the session's files, never the owner's home");

  const member = new HostWorkspace(binding("host-member"), join(directory, "member"));
  t.after(() => member.close());
  await member.initialize();
  const theirs = await member.execute({ kind: "bash", command: 'echo "$HOME|${SSH_AUTH_SOCK:-unset}"; git who 2>/dev/null || echo no-alias' }, false, authorize);
  assert.equal(theirs, `${member.home}|unset\nno-alias\n`);
});

test("only the host owner's own sessions run in the owner's environment", () => {
  const session = (connectorOwnerId?: string) => {
    const value = binding("whose");
    if (connectorOwnerId) Object.assign(value.session, { connectorId: "host", connectorOwnerId });
    return value;
  };
  assert.equal(hostOwnersSession(session("test:alice")), true);
  assert.equal(hostOwnersSession(session("test:bob")), false, "a member's session on someone else's host");
  assert.equal(hostOwnersSession(session()), false, "a session on the server's own runner");
});

test("the host strips every variable of the server's configuration from the owner's environment", () => {
  for (const name of [...stringVars, "DATABASE_URL", "STORAGE_URL", "S3_SECRET_ACCESS_KEY", "CONTROL_PLANE_URL", "PIKIBUN_GITHUB_CLIENT_SECRET"]) {
    assert.ok(CONNECTOR_ENVIRONMENT.test(name), `${name} reaches the owner's commands`);
  }
  for (const name of ["HOME", "SSH_AUTH_SOCK", "PATH", "LANG", "XDG_CONFIG_HOME", "GH_TOKEN", "AWS_PROFILE", "DISPLAY"]) {
    assert.ok(!CONNECTOR_ENVIRONMENT.test(name), `${name} is kept from the owner`);
  }
});

test("an unsandboxed clone session's Git uses the host user's own credential helpers, and no other session's does", hostMode, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pikibun-host-credentials-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = join(directory, "host user's home");
  await mkdir(home);
  await writeFile(join(home, ".gitconfig"), "[credential]\n\thelper = \"!f() { test \\\"$1\\\" = get && echo username=host-user && echo password=host-secret; }; f\"\n");
  const previous = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = previous; });
  const fill = "printf 'protocol=https\\nhost=forge.example\\n\\n' | git credential fill 2>&1 || true";
  const clone = binding("host-clone");
  clone.session.repositoryMode = "clone";
  const cloned = new HostWorkspace(clone, join(directory, "clone"));
  t.after(() => cloned.close());
  await cloned.initialize();
  assert.match(await cloned.execute({ kind: "bash", command: fill }, false, authorize), /username=host-user\npassword=host-secret/);
  const plain = new HostWorkspace(binding("host-plain"), join(directory, "plain"));
  t.after(() => plain.close());
  await plain.initialize();
  assert.doesNotMatch(await plain.execute({ kind: "bash", command: fill }, false, authorize), /host-secret/);
  assert.ok((await cloned.snapshot(authorize)).length > 0);
  await cloned.execute({ kind: "bash", command: "git init -q app" }, false, authorize);
  await assert.rejects(cloned.snapshot(authorize), /need a host with the sandbox/);
});

test("a host clone session reads the branches its clones have checked out, as Git leaves them", hostMode, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pikibun-host-branches-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clone = binding("host-branches");
  clone.session.repositoryMode = "clone";
  const workspace = new HostWorkspace(clone, join(directory, "session"));
  t.after(() => workspace.close());
  await workspace.initialize();
  const upstream = join(directory, "upstream");
  await mkdir(upstream);
  const run = (command: string) => workspace.execute({ kind: "bash", command }, false, authorize);
  await run(`git init -q -b main '${upstream}' && git -C '${upstream}' commit -q --allow-empty -m initial`);
  await run(`git clone -q '${upstream}' app && git clone -q '${upstream}' other && git -C app switch -q -c fix/parser`);
  assert.deepEqual(await workspace.cloneBranches(authorize), [{ directory: "app", origin: upstream, branch: "fix/parser" }],
    "a clone on its origin's default branch has no pull request of its own");
});

async function stillBeating(file: string): Promise<boolean> {
  const before = await readFile(file, "utf8").catch(() => "");
  await new Promise(resolve => setTimeout(resolve, 1500));
  return (await readFile(file, "utf8").catch(() => "")) !== before;
}

const beat = "sh -c 'while :; do echo . >> beat.txt; sleep 0.2; done' & sleep 600 & wait";

test("a time limit ends what an unsandboxed command started in the background, not only bash", hostMode, async t => {
  const { workspace } = await hostWorkspace(t);
  const started = Date.now();
  await assert.rejects(workspace.execute({ kind: "bash", command: beat }, false, authorize,
    { limits: { seconds: 2, cpuSeconds: 25, fileBytes: 64 * 1024 ** 2, openFiles: 256 } }), /time limit/);
  assert.ok(Date.now() - started < 20_000, `the time limit took ${Date.now() - started} ms to end the command`);
  assert.equal(await stillBeating(join(workspace.worktree, "beat.txt")), false, "the background loop outlived the time limit");
});

test("a cancelled or timed-out host command ends what it started in the background", hostMode, async t => {
  const { workspace } = await hostWorkspace(t);
  const options = { worktree: workspace.worktree, git: join(workspace.worktree, ".git"), gitConfig: join(workspace.worktree, "..", "owner.gitconfig"),
    gitName: "Alice Owner", gitEmail: "alice@example.test" };
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 1500);
  let started = Date.now();
  await assert.rejects(runHostShell({ kind: "host.bash", command: beat, timeoutSeconds: 600 }, { ...options, signal: controller.signal }), /cancelled/);
  assert.ok(Date.now() - started < 20_000, `cancelling took ${Date.now() - started} ms`);
  assert.equal(await stillBeating(join(workspace.worktree, "beat.txt")), false, "the background loop outlived the cancel");
  started = Date.now();
  await assert.rejects(runHostShell({ kind: "host.bash", command: beat.replace("beat.txt", "beat2.txt"), timeoutSeconds: 2 }, { ...options, signal: new AbortController().signal }), /time limit/);
  assert.ok(Date.now() - started < 20_000, `the time limit took ${Date.now() - started} ms to end the command`);
  assert.equal(await stillBeating(join(workspace.worktree, "beat2.txt")), false, "the background loop outlived the time limit");
});

test("an unsandboxed command runs as written: quoting, lines, an empty stdin and its exit status", hostMode, async t => {
  const { workspace } = await hostWorkspace(t);
  const command = "x='a  \"b\" \\c'\nprintf '%s|' \"$x\" \"${__pikibun_command-unset}\"\nif read -r line; then echo \"stdin: $line\"; else echo 'stdin: empty'; fi";
  assert.equal(await workspace.execute({ kind: "bash", command }, false, authorize), "a  \"b\" \\c|unset|stdin: empty\n");
  await assert.rejects(workspace.execute({ kind: "bash", command: "echo partial; exit 7" }, false, authorize), /exit 7/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runHostShell({ kind: "host.bash", command: "echo should-not-run > ran.txt", timeoutSeconds: 10 },
    { worktree: workspace.worktree, git: join(workspace.worktree, ".git"), gitConfig: join(workspace.worktree, "..", "owner.gitconfig"),
      gitName: "Alice Owner", gitEmail: "alice@example.test", signal: controller.signal }));
  await new Promise(resolve => setTimeout(resolve, 500));
  await assert.rejects(readFile(join(workspace.worktree, "ran.txt")), "a command cancelled before it started never ran");
});
