import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Sandbox, SANDBOX_TMP } from "../apps/runner/src/sandbox.js";
import { binding, linuxSandboxMissing } from "./helpers/workspaces.js";

const allow = async () => {};

test("in the Linux sandbox, TMPDIR is a short /tmp that is the session's own ~/.tmp, so programs can bind Unix sockets there", { skip: linuxSandboxMissing() }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pikibun-sandbox-tmp-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // A storage root as long as a host's: the session's own home is far past what a socket path can hold.
  const sandbox = new Sandbox(binding("temporary"), join(directory, "s".repeat(80), "session"));
  t.after(() => sandbox.close());
  await sandbox.initialize();
  assert.ok(`${sandbox.home}/.tmp/x.sock`.length > 107, "the test's home must be too long for a socket path");
  const shell = (command: string) => sandbox.execute({ kind: "bash", command }, false, allow, { unbounded: true });

  assert.equal(await shell("printf %s \"$TMPDIR\""), SANDBOX_TMP);
  await shell("echo kept > /tmp/marker");
  assert.equal(await readFile(join(sandbox.home, ".tmp", "marker"), "utf8"), "kept\n", "/tmp is the session's ~/.tmp");
  const bound = await shell("python3 -c \"import os, socket, tempfile; d = tempfile.mkdtemp(); s = socket.socket(socket.AF_UNIX); "
    + "s.bind(os.path.join(d, 'x' * 40 + '.sock')); print(d.startswith('/tmp/'))\"");
  assert.equal(bound.trim(), "True");
  await assert.rejects(shell("touch /elsewhere"), /Read-only|Permission denied/, "the root stays read-only");
});
