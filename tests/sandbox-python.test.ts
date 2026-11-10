import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { EGRESS_PORT } from "../apps/runner/src/egress.js";
import { GIT_LFS_PATHS, HELPER, MIRROR_ROOT } from "../apps/runner/src/sandbox.js";
import { BROWSER_DRIVER, GIT_SHIM, SERVICE_DRIVER } from "../apps/runner/src/sandbox-python.generated.js";
import { SERVICE_MARK } from "../apps/runner/src/session-service.js";
import { BROWSER_KEPT, BROWSER_OUTPUT } from "../packages/shared/src/browser.js";
import { NODE_ENVIRONMENT, nodePrograms } from "../apps/runner/src/node-command.js";
import { PYTHON_ENVIRONMENT, pythonPrograms } from "../apps/runner/src/python-command.js";

const source = (file: string) => readFileSync(new URL(`../apps/runner/src/sandbox-python/${file}`, import.meta.url), "utf8");
const python = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout?.trim() ?? "";

test("the embedded Python is the .py files as they are: `pnpm python:embed` after changing one", () => {
  const check = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/embed-python.mjs", import.meta.url)), "--check"], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
  assert.equal(HELPER, source("helper.py"));
  assert.equal(GIT_SHIM, source("git_shim.py"));
  assert.equal(BROWSER_DRIVER, source("browser.py"));
  assert.equal(SERVICE_DRIVER, source("service.py"));
});

test("the constants the Python programs share with the connector agree", () => {
  assert.match(source("helper.py"), new RegExp(`^MIRROR_ROOT = '${MIRROR_ROOT}'$`, "m"));
  assert.match(source("git_shim.py"), new RegExp(`^EGRESS_PORT = ${EGRESS_PORT}$`, "m"));
  assert.match(source("browser.py"), new RegExp(`^OUTPUT = '${BROWSER_OUTPUT}'$`, "m"));
  assert.match(source("browser.py"), new RegExp(`^KEPT = ${BROWSER_KEPT}$`, "m"));
  const tuple = (items: readonly string[]) => `\\(${items.map(item => `'${item}'`).join(", ")}\\)`;
  assert.match(source("browser.py"), new RegExp(`^NODE_PROGRAMS = ${tuple(nodePrograms)}$`, "m"));
  assert.match(source("browser.py"), new RegExp(`^PYTHON_PROGRAMS = ${tuple(pythonPrograms)}$`, "m"));
  assert.ok(source("browser.py").includes(`\nNODE_ENVIRONMENT = '${NODE_ENVIRONMENT}'\n`));
  assert.ok(source("browser.py").includes(`\nPYTHON_ENVIRONMENT = '${PYTHON_ENVIRONMENT}'\n`));
  assert.match(source("service.py"), new RegExp(`^NODE_PROGRAMS = ${tuple(nodePrograms)}$`, "m"));
  assert.match(source("service.py"), new RegExp(`^PYTHON_PROGRAMS = ${tuple(pythonPrograms)}$`, "m"));
  assert.ok(source("service.py").includes(`\nNODE_ENVIRONMENT = '${NODE_ENVIRONMENT}'\n`));
  assert.ok(source("service.py").includes(`\nPYTHON_ENVIRONMENT = '${PYTHON_ENVIRONMENT}'\n`));
  assert.ok(source("service.py").includes(`\nMARK = '${SERVICE_MARK.replace("\x1e", "\\x1e")}'\n`));
  assert.match(source("git_shim.py"), new RegExp(`^GIT_LFS_PATHS = \\(${GIT_LFS_PATHS.map(path => `'${path}'`).join(", ")}\\)$`, "m"));
});

test("every program compiles with this host's Python", { skip: !python && "python3 is not installed" }, () => {
  for (const [name, program] of [["helper", HELPER], ["git shim", GIT_SHIM], ["browser driver", BROWSER_DRIVER], ["service driver", SERVICE_DRIVER]] as const) {
    const compiled = spawnSync(python, ["-I", "-c", "import sys; compile(sys.stdin.read(), 'program', 'exec')"], { input: program, encoding: "utf8" });
    assert.equal(compiled.status, 0, `${name}: ${compiled.stderr}`);
  }
});
