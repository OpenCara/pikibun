import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { ISOLATION_ARGS, ISOLATION_CANARY, ISOLATION_CHECK, ISOLATION_NAMESPACES, isolationMessage, verifySandboxIsolation, type IsolationRun } from "../apps/runner/src/connect-setup.js";

const namespace = (name: string) => `${name}:[4026531${ISOLATION_NAMESPACES.indexOf(name as never)}]`;

test("the sandbox self-test passes only when the step inside bubblewrap says ok", async () => {
  const calls: { args: readonly string[]; env: Record<string, string>; sentinel: boolean }[] = [];
  const run: IsolationRun = async (args, env) => {
    calls.push({ args, env, sentinel: existsSync(args[ISOLATION_ARGS.length]!) });
    return { status: 0, stdout: "ok\n", stderr: "" };
  };
  assert.deepEqual(await verifySandboxIsolation({ run, platform: "linux", namespace }), { ok: true, detail: "ok" });
  const [call] = calls;
  assert.deepEqual(call!.args.slice(0, ISOLATION_ARGS.length), [...ISOLATION_ARGS]);
  assert.ok(call!.sentinel, "the sentinel exists on the host while the step runs");
  assert.ok(!existsSync(call!.args[ISOLATION_ARGS.length]!), "the sentinel is removed afterwards");
  assert.equal(call!.args[ISOLATION_ARGS.length + 1], homedir());
  assert.deepEqual(call!.args.slice(ISOLATION_ARGS.length + 2), ISOLATION_NAMESPACES.map(name => `${name}=${namespace(name)}`));
  assert.equal(call!.env[ISOLATION_CANARY], "1");
  for (const flag of ["--unshare-all", "--unshare-user", "--disable-userns", "--cap-drop", "--clearenv"]) assert.ok(ISOLATION_ARGS.includes(flag as never), flag);
});

test("the sandbox self-test fails with what the step found, or why it didn't run", async () => {
  const found: IsolationRun = async () => ({ status: 1, stdout: "it shares the host net namespace; it sees the host home directory\n", stderr: "" });
  assert.deepEqual(await verifySandboxIsolation({ run: found, platform: "linux", namespace }),
    { ok: false, detail: "it shares the host net namespace; it sees the host home directory" });
  const refused: IsolationRun = async () => ({ status: 1, stdout: "", stderr: "bwrap: setting up uid map: Permission denied\n" });
  assert.deepEqual(await verifySandboxIsolation({ run: refused, platform: "linux", namespace }), { ok: false, detail: "bwrap: setting up uid map: Permission denied" });
  const hung: IsolationRun = async () => ({ status: null, stdout: "", stderr: "" });
  assert.deepEqual(await verifySandboxIsolation({ run: hung, platform: "linux", namespace }), { ok: false, detail: "it didn't finish" });
  const lying: IsolationRun = async () => ({ status: 1, stdout: "ok", stderr: "" });
  assert.equal((await verifySandboxIsolation({ run: lying, platform: "linux", namespace })).ok, false);
  const thrown: IsolationRun = async () => { throw new Error("spawn /usr/bin/bwrap ENOENT"); };
  assert.deepEqual(await verifySandboxIsolation({ run: thrown, platform: "linux", namespace }), { ok: false, detail: "spawn /usr/bin/bwrap ENOENT" });
});

test("the sandbox self-test runs nothing off Linux or where the host's namespaces can't be read", async () => {
  let ran = false;
  const run: IsolationRun = async () => { ran = true; return { status: 0, stdout: "ok", stderr: "" }; };
  assert.equal((await verifySandboxIsolation({ run, platform: "darwin", namespace })).ok, false);
  const missing = await verifySandboxIsolation({ run, platform: "linux", namespace: name => name === "net" || name === "pid" ? undefined : namespace(name) });
  assert.deepEqual(missing, { ok: false, detail: "this machine's pid, net namespaces could not be read" });
  assert.equal(ran, false);
});

test("the isolation check finds every leak of a step that isn't isolated", { skip: process.platform !== "linux" || !existsSync("/usr/bin/python3") }, async () => {
  const result = await verifySandboxIsolation({
    run: async (args, env) => {
      const probe = spawnSync("/usr/bin/python3", ["-I", "-c", ISOLATION_CHECK, ...args.slice(ISOLATION_ARGS.length)], { encoding: "utf8", env });
      return { status: probe.status, stdout: probe.stdout, stderr: probe.stderr };
    },
  });
  assert.equal(result.ok, false);
  for (const name of ISOLATION_NAMESPACES) assert.match(result.detail, new RegExp(`shares the host ${name} namespace`));
  assert.match(result.detail, /sees the host temporary files/);
});

test("the isolation check passes a step that sees none of the host", { skip: process.platform !== "linux" || !existsSync("/usr/bin/python3") }, () => {
  const probe = spawnSync("/usr/bin/python3", ["-I", "-c", ISOLATION_CHECK, "/nonexistent/sentinel", "/nonexistent/home",
    ...ISOLATION_NAMESPACES.map(name => `${name}=${name}:[1]`)], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
  const found = probe.stdout.trim().split("; ").filter(item => !/network interfaces|capabilities|root is writable|user namespaces/.test(item) && item !== "ok");
  assert.deepEqual(found, []);
});

test("the connector says whether the sandbox was verified", () => {
  assert.match(isolationMessage(undefined), /^Sandbox capability is verified per session/);
  assert.match(isolationMessage({ ok: true, detail: "ok" }), /^Sandbox verified/);
  assert.match(isolationMessage({ ok: false, detail: "it shares the host net namespace" }), /^Sandbox not verified \(it shares the host net namespace\): Pikibun shows this host as "Sandbox unverified"/);
});
