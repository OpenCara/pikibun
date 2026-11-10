import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("..", import.meta.url));
const sources = join(root, "apps", "runner", "src", "sandbox-python");

const ruffSettings = { "line-length": 160, "target-version": "py39", lint: { select: ["E", "F", "W", "B", "PLE"], ignore: ["B905"] } };

let failed = false;
const { Workspace, PositionEncoding } = require("@astral-sh/ruff-wasm-nodejs");
const ruff = new Workspace(ruffSettings, PositionEncoding.Utf8);
for (const file of readdirSync(sources).filter(name => name.endsWith(".py")).sort()) {
  const path = join(sources, file);
  for (const diagnostic of ruff.check(readFileSync(path, "utf8"))) {
    failed = true;
    console.error(`${relative(root, path)}:${diagnostic.start_location.row}:${diagnostic.start_location.column}: ${diagnostic.code ?? "error"} ${diagnostic.message}`);
  }
}
if (!failed) console.log(`Ruff ${Workspace.version()}: no problems.`);

const pyright = spawnSync(process.execPath, [require.resolve("pyright/index.js"), "-p", sources], { stdio: "inherit" });
if (pyright.status !== 0) failed = true;
process.exit(failed ? 1 : 0);
