import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { EGRESS_PORT } from "../apps/runner/src/egress.js";
import { GIT_LFS_PATHS, HELPER, MIRROR_ROOT } from "../apps/runner/src/sandbox.js";
import { GIT_SHIM } from "../apps/runner/src/sandbox-python.generated.js";

/*
 * The sandbox's Python programs are .py files (apps/runner/src/sandbox-python), linted and type-checked as Python
 * (`pnpm python:check`), and embedded in the connector by scripts/embed-python.mjs.
 */

const source = (file: string) => readFileSync(new URL(`../apps/runner/src/sandbox-python/${file}`, import.meta.url), "utf8");
const python = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();

test("the embedded Python is the .py files as they are: `pnpm python:embed` after changing one", () => {
  const check = spawnSync(process.execPath, [new URL("../scripts/embed-python.mjs", import.meta.url).pathname, "--check"], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
  assert.equal(HELPER, source("helper.py"));
  assert.equal(GIT_SHIM, source("git_shim.py"));
});

test("the constants the Python programs share with the connector agree", () => {
  assert.match(source("helper.py"), new RegExp(`^MIRROR_ROOT = '${MIRROR_ROOT}'$`, "m"));
  assert.match(source("git_shim.py"), new RegExp(`^EGRESS_PORT = ${EGRESS_PORT}$`, "m"));
  assert.match(source("git_shim.py"), new RegExp(`^GIT_LFS_PATHS = \\(${GIT_LFS_PATHS.map(path => `'${path}'`).join(", ")}\\)$`, "m"));
});

test("both programs compile with this host's Python", { skip: !python && "python3 is not installed" }, () => {
  for (const [name, program] of [["helper", HELPER], ["git shim", GIT_SHIM]] as const) {
    const compiled = spawnSync(python, ["-I", "-c", "import sys; compile(sys.stdin.read(), 'program', 'exec')"], { input: program, encoding: "utf8" });
    assert.equal(compiled.status, 0, `${name}: ${compiled.stderr}`);
  }
});
