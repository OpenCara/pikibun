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
  const root = join(directory, "session");
  const sandbox = new Sandbox(binding("temporary"), root);
  t.after(() => sandbox.close());
  await sandbox.initialize();
  const shell = (command: string) => sandbox.execute({ kind: "bash", command }, false, allow, { unbounded: true });

  assert.equal(await shell("printf %s \"$TMPDIR\""), SANDBOX_TMP);
  await shell("echo kept > /tmp/marker");
  assert.equal(await readFile(join(root, "home", ".tmp", "marker"), "utf8"), "kept\n", "/tmp is the session's ~/.tmp");
  // The same socket, made where a test suite makes one: in a fresh directory under the temporary directory.
  const bind = (base: string) => shell(`python3 -c "import os, socket, tempfile; d = tempfile.mkdtemp(dir='${base}'); `
    + `s = socket.socket(socket.AF_UNIX); s.bind(os.path.join(d, 'proxy-' + 'x' * 24 + '.sock')); print('bound')"`);
  await assert.rejects(bind(`${sandbox.home}/.tmp`), /path too long/, "the session's own ~/.tmp leaves too little of a socket path");
  assert.equal((await bind(SANDBOX_TMP)).trim(), "bound");
  await assert.rejects(shell("touch /elsewhere"), /Read-only|Permission denied/, "the root stays read-only");
});
