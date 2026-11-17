import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { callEnvironment, clones, defaultedTimeout, directoryHint, LONG_RUN_DEFAULT_SECONDS, longRun, timedOutHint } from "../apps/runner/src/program-defaults.js";
import { pythonRequest, pythonShellCommand } from "../apps/runner/src/python-command.js";

test("a call's environment becomes quoted assignments, refusing what the tool sets itself and what isn't a variable", () => {
  assert.equal(callEnvironment(undefined), "");
  assert.equal(callEnvironment({}), "");
  assert.equal(callEnvironment({ TMPDIR: "/tmp", GREETING: "it's $HOME" }), "TMPDIR='/tmp' GREETING='it'\\''s $HOME'");
  for (const [env, refusal] of [
    [{ PATH: "/x" }, /can't set PATH/], [{ LD_PRELOAD: "/x.so" }, /can't set LD_PRELOAD/], [{ DYLD_INSERT_LIBRARIES: "x" }, /can't set DYLD_/],
    [{ "A B": "x" }, /letters, digits and _/], [{ "1A": "x" }, /letters, digits and _/], [{ A: 1 }, /is a string/], [{ A: "a\0b" }, /without NUL/],
    [{ A: "x".repeat(4097) }, /at most 4096 characters/], [Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`V${index}`, "x"])), /at most 16 variables/],
    [["A=1"], /is an object/], ["A=1", /is an object/],
  ] as const) assert.throws(() => callEnvironment(env), refusal, JSON.stringify(env));
});

test("the python tool puts the call's environment after its own", () => {
  assert.equal(pythonShellCommand(pythonRequest({ program: "pytest", args: ["-q"] }), "linux", "TMPDIR='/tmp'"),
    "PATH=\"${PATH:-/usr/bin:/bin}\":'/usr/local/bin' NO_COLOR=1 PIP_NO_INPUT=1 PIP_DISABLE_PIP_VERSION_CHECK=1 POETRY_NO_INTERACTION=1 UV_NO_PROGRESS=1 TMPDIR='/tmp' pytest '-q' </dev/null 2>&1");
});

test("test suites and servers get a default time limit when the call gives none; other runs keep the host's", () => {
  const long: [string, string[]][] = [
    ["node", ["--import", "tsx", "--test", "tests/a.test.ts"]], ["node", ["--watch", "server.js"]],
    ["npm", ["test"]], ["npm", ["run", "dev"]], ["pnpm", ["test:client"]], ["pnpm", ["--filter", "pikibun", "test"]], ["pnpm", ["exec", "vitest"]], ["yarn", ["start"]],
    ["npx", ["-y", "vite@5"]], ["npx", ["playwright", "test"]],
    ["python3", ["-m", "pytest", "-q"]], ["python3", ["-m", "http.server", "8000"]], ["pytest", []], ["uv", ["run", "pytest"]], ["python3", ["manage.py", "runserver"]],
    ["cargo", ["test", "--quiet"]], ["cargo", ["+nightly", "run"]], ["go", ["test", "./..."]], ["dotnet", ["test"]], ["make", ["test"]], ["make", ["-C", "build", "check", "serve"]],
  ];
  const short: [string, string[]][] = [
    ["node", ["-e", "console.log(1)"]], ["node", ["--check", "a.js"]], ["node", ["app.js", "--test"]], ["node", ["--import", "tsx", "scripts/x.ts", "--watch"]], ["npm", ["install"]], ["pnpm", ["install", "--frozen-lockfile"]], ["pnpm", ["run", "build"]],
    ["pnpm", ["--filter", "test", "build"]], ["npx", ["tsc", "--noEmit"]], ["python3", ["-m", "venv", ".venv"]], ["pip", ["install", "pytest"]],
    ["cargo", ["build"]], ["go", ["vet", "./..."]], ["make", []], ["make", ["all"]], ["rustfmt", ["src/main.rs"]],
  ];
  for (const [program, args] of long) assert.equal(longRun(program, args), true, `${program} ${args.join(" ")}`);
  for (const [program, args] of short) assert.equal(longRun(program, args), false, `${program} ${args.join(" ")}`);
  assert.deepEqual(defaultedTimeout("npm", ["test"], undefined), { seconds: LONG_RUN_DEFAULT_SECONDS, defaulted: true });
  assert.deepEqual(defaultedTimeout("npm", ["test"], 3600), { seconds: 3600, defaulted: false }, "a call's own timeout comes first, longer or not");
  assert.deepEqual(defaultedTimeout("npm", ["install"], undefined), { defaulted: false });
  assert.match(timedOutHint("Sandbox exceeded 1200000ms time limit\nRunning 300 tests")!, /at most 1200 seconds\. Give timeout_seconds/);
  assert.match(timedOutHint("Host command exceeded its time limit")!, /at most 1200 seconds/);
  assert.equal(timedOutHint("Command failed with exit code 1"), undefined);
});

test("a run at the worktree's top that failed for want of a manifest names the clones that have one", async t => {
  const worktree = await mkdtemp(join(tmpdir(), "pikibun-hint-"));
  t.after(() => rm(worktree, { recursive: true, force: true }));
  for (const clone of ["web", "api", "notes"]) await mkdir(join(worktree, clone, ".git"), { recursive: true });
  await mkdir(join(worktree, "plain"));
  await writeFile(join(worktree, "plain", "package.json"), "{}");
  await writeFile(join(worktree, "web", "package.json"), "{}");
  await writeFile(join(worktree, "api", "package.json"), "{}");
  await writeFile(join(worktree, "api", "Cargo.toml"), "");
  assert.deepEqual(clones(worktree), ["api", "notes", "web"]);
  const npm = `npm error code ENOENT\nnpm error path ${worktree}/package.json\nnpm error enoent Could not read package.json: Error: ENOENT: no such file or directory, open '${worktree}/package.json'`;
  assert.equal(directoryHint({ worktree, directory: ".", status: "failed", result: npm }),
    "It ran at the worktree's top, which has no package.json: run it again with directory, the clone to run in, such as directory: \"api\" (clones with one: api, web).");
  assert.match(directoryHint({ worktree, directory: ".", status: "failed", result: "error: could not find `Cargo.toml` in `/w` or any parent directory" })!, /no Cargo\.toml: .*directory: "api"\.$/);
  assert.equal(directoryHint({ worktree, directory: "web", status: "failed", result: npm }), undefined, "it named a directory");
  assert.equal(directoryHint({ worktree, directory: ".", status: "executed", result: npm }), undefined);
  assert.equal(directoryHint({ worktree, directory: ".", status: "failed", result: "go: go.mod file not found in current directory" }), undefined, "no clone has a go.mod");
  assert.equal(directoryHint({ worktree, directory: ".", status: "failed", result: "Error: Cannot find module 'x'" }), undefined);
  await writeFile(join(worktree, "package.json"), "{}");
  assert.equal(directoryHint({ worktree, directory: ".", status: "failed", result: npm }), undefined, "the top has its own package.json");
});
