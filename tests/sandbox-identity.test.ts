import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Sandbox, SANDBOX_USER, sandboxEtc } from "../apps/runner/src/sandbox.js";
import { CALL_TIMEOUT_MAX_SECONDS, callLimits, callTimeout, commandLimits } from "../apps/runner/src/host-config.js";
import { binding, linuxSandboxMissing } from "./helpers/workspaces.js";

const allow = async () => {};

test("the sandbox's /etc names the session's user, its home and localhost, and nothing of the host's", () => {
  const etc = sandboxEtc("/sessions/abc/home", 1001, 1002);
  assert.deepEqual(Object.keys(etc).sort(), ["group", "hosts", "nsswitch.conf", "passwd"]);
  assert.equal(etc.passwd!.split("\n")[0], `${SANDBOX_USER}:x:1001:1002:Pikibun session:/sessions/abc/home:/bin/bash`, "the session's user comes first");
  assert.match(etc.group!, new RegExp(`^${SANDBOX_USER}:x:1002:$`, "m"));
  assert.match(etc.hosts!, /^127\.0\.0\.1\tlocalhost$/m);
  assert.match(etc.hosts!, /^::1\tlocalhost\b/m);
  assert.match(etc["nsswitch.conf"]!, /^hosts: files dns$/m);
  const root = sandboxEtc("/sessions/abc/home", 0, 0);
  assert.equal(root.passwd!.split("\n")[0], "root:x:0:0:root:/sessions/abc/home:/bin/bash", "a runner that is root has no second user of uid 0");
  assert.doesNotMatch(root.group!, new RegExp(`^${SANDBOX_USER}:`, "m"));
});

test("a call's timeout_seconds is whole seconds within the longest host limit, and only ever shortens the host's limits", () => {
  assert.equal(callTimeout(undefined), undefined);
  assert.equal(callTimeout(1), 1);
  assert.equal(callTimeout(CALL_TIMEOUT_MAX_SECONDS), CALL_TIMEOUT_MAX_SECONDS);
  for (const bad of [0, -1, 1.5, CALL_TIMEOUT_MAX_SECONDS + 1, "60", null, Number.NaN]) assert.throws(() => callTimeout(bad), /timeout_seconds/, String(bad));
  const host = commandLimits(3600, 4);
  assert.deepEqual(callLimits(host), host);
  assert.deepEqual(callLimits(host, 60), { ...host, seconds: 60 }, "the rest of the host's limits stay as they are");
  assert.deepEqual(callLimits(host, 3600), host);
  const short = commandLimits(30, 4);
  assert.deepEqual(callLimits(short, 600), short, "never longer than the host's limit");
});

test("in the Linux sandbox, the session's user and localhost resolve", { skip: linuxSandboxMissing() }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pikibun-sandbox-identity-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sandbox = new Sandbox(binding("identity"), join(directory, "session"));
  t.after(() => sandbox.close());
  await sandbox.initialize();
  const shell = (command: string) => sandbox.execute({ kind: "bash", command }, false, allow, { unbounded: true });

  const user = JSON.parse(await shell(`python3 -c "import grp, json, os, pwd; u = pwd.getpwuid(os.getuid()); `
    + `print(json.dumps([u.pw_name, u.pw_dir, grp.getgrgid(os.getgid()).gr_name]))"`));
  assert.deepEqual(user, [SANDBOX_USER, sandbox.home, SANDBOX_USER]);
  assert.equal((await shell("id -un")).trim(), SANDBOX_USER);
  const addresses = JSON.parse(await shell(`python3 -c "import json, socket; `
    + `print(json.dumps(sorted({a[4][0] for a in socket.getaddrinfo('localhost', 80, proto=socket.IPPROTO_TCP)})))"`));
  assert.ok(addresses.includes("127.0.0.1"), JSON.stringify(addresses));
  await assert.rejects(shell("echo x >> /etc/hosts"), /Read-only|Permission denied/, "the files are read-only");
});
