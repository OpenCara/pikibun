import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentSocketImport } from "../apps/nsh/src/lib/agent-socket.js";

const unix = { skip: process.platform === "win32" };
const shells = ["sh", "bash", "zsh"].filter(shell => spawnSync(shell, ["-c", "true"]).status === 0);

async function standIns(t: test.TestContext, launchctl: string, systemctl: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pikibun-agent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [name, output] of [["launchctl", launchctl], ["systemctl", systemctl]]) {
    await writeFile(join(directory, name), `#!/bin/sh\nprintf '%s' '${output}'\n`);
    await chmod(join(directory, name), 0o755);
  }
  return directory;
}

function exported(shell: string, os: string, bin: string, socket?: string, extra: NodeJS.ProcessEnv = {}, path = `${bin}:/usr/bin:/bin`): string {
  const env: NodeJS.ProcessEnv = { PATH: path, ...extra, ...(socket === undefined ? {} : { SSH_AUTH_SOCK: socket }) };
  const run = spawnSync(shell, ["-c", `${agentSocketImport(os)}exec sh -c 'printf "%s|%s" "\${SSH_AUTH_SOCK-unset}" "\${SSH_AGENT_PID-unset}"'`], { env, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const [value, pid] = run.stdout.split("|");
  if (value === "unset") assert.equal(pid, "unset", "an agent's pid never stays without its socket");
  return value!;
}

async function onlyShellAndSed(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pikibun-agent-path-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, "bin");
  await mkdir(bin);
  for (const program of ["sh", "sed"]) {
    const found = spawnSync("sh", ["-c", `command -v ${program}`], { encoding: "utf8" }).stdout.trim();
    await symlink(found, join(bin, program));
  }
  return bin;
}

test("the desktop app's host takes the GUI session's ssh agent socket when neither NSH nor the shell profile set one", unix, async t => {
  assert.ok(shells.includes("sh") && shells.includes("bash"), `shells found: ${shells.join(", ")}`);
  const bin = await standIns(t, "/private/tmp/com.apple.launchd.x/Listeners\n", "LANG=C.UTF-8\nSSH_AUTH_SOCK=/run/user/1000/keyring/ssh\nXDG_SESSION_TYPE=wayland\n");
  for (const shell of shells) {
    assert.equal(exported(shell, "macos", bin), "/private/tmp/com.apple.launchd.x/Listeners", `${shell}: launchd's socket on macOS`);
    assert.equal(exported(shell, "linux", bin), "/run/user/1000/keyring/ssh", `${shell}: the systemd user session's socket on Linux`);
    assert.equal(exported(shell, "macos", bin, "/Users/ada/.1password/agent.sock"), "/Users/ada/.1password/agent.sock", `${shell}: one already set wins`);
  }
});

test("without a usable socket the host gets none, never an empty or relative one", unix, async t => {
  const empty = await standIns(t, "", "LANG=C.UTF-8\n");
  const odd = await standIns(t, "relative/agent", "SSH_AUTH_SOCK=run/user/agent\n");
  for (const shell of shells) {
    assert.equal(exported(shell, "macos", empty), "unset", `${shell}: launchd has none`);
    assert.equal(exported(shell, "linux", empty), "unset", `${shell}: the session has none`);
    assert.equal(exported(shell, "macos", odd), "unset", `${shell}: a relative path`);
    assert.equal(exported(shell, "linux", odd), "unset", `${shell}: a relative path from the session`);
  }
});

test("where there is no systemctl at all, the host gets no socket and starts as before", unix, async t => {
  const bin = await onlyShellAndSed(t);
  assert.notEqual(spawnSync("sh", ["-c", "command -v systemctl"], { env: { PATH: bin }, encoding: "utf8" }).status, 0, "systemctl is out of reach");
  for (const shell of shells) {
    const found = spawnSync("sh", ["-c", `command -v ${shell}`], { encoding: "utf8" }).stdout.trim();
    assert.equal(exported(found, "linux", bin, undefined, { SSH_AGENT_PID: "4242" }, bin), "unset", `${shell}: no systemctl, and the stray pid goes too`);
  }
});

test("Windows and other platforms start the host as before", () => {
  assert.equal(agentSocketImport("windows"), "");
  assert.equal(agentSocketImport("ios"), "");
});
