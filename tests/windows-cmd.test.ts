import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cmdArgs, cmdRun, cmdRunOwn, lastLines } from "../apps/nsh/src/lib/windows-cmd.js";

const windows = process.platform === "win32";
const OWN = "cli\\node_modules\\.bin\\pikibun.cmd";

test("cmd lines switch to UTF-8 and exit 9009 for a missing program before running it", () => {
  assert.deepEqual(cmdArgs(cmdRun("pikibun", ["host", "--stdio"])),
    ["/d", "/c", "chcp", "65001", ">nul", "2>nul", "&", "(", "where", "/q", "pikibun", "||", "exit", "9009", ")", "&&", "pikibun", "host", "--stdio"]);
  assert.deepEqual(cmdRunOwn(OWN, "pikibun", ["serve"]),
    ["if", "exist", OWN, "(", OWN, "serve", ")", "else", "(", "(", "where", "/q", "pikibun", "||", "exit", "9009", ")", "&&", "pikibun", "serve", ")"]);
});

test("output that isn't readable text, such as GBK read as UTF-8, isn't shown", () => {
  assert.equal(lastLines(["one", "", "  two ", "three", "four"]), "two three four");
  assert.equal(lastLines(["'pikibun' \uFFFD\uFFFD\uFFFD\uFFFD"]), "");
});

async function folder(scripts: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pikibun-cmd-"));
  for (const [path, body] of Object.entries(scripts)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), `@echo off\r\n${body.split("\n").join("\r\n")}\r\n`);
  }
  return root;
}

function cmd(words: string[], cwd: string, path: string) {
  const system = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  return spawnSync("cmd", cmdArgs(words), { cwd, encoding: "utf8", env: { ...process.env, PATH: path ? `${path};${system}` : system }, timeout: 30_000 });
}

test("a missing program exits 9009, saying nothing, in any language", { skip: !windows }, async () => {
  const root = await folder({});
  try {
    const plain = cmd(cmdRun("pikibun", ["host", "--stdio"]), root, "");
    assert.equal(plain.status, 9009, plain.stderr);
    assert.equal(plain.stdout + plain.stderr, "");
    const own = cmd(cmdRunOwn(OWN, "pikibun", ["host", "--stdio"]), root, "");
    assert.equal(own.status, 9009, own.stderr);
    assert.equal(own.stdout + own.stderr, "");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the program on PATH runs with its arguments, on a UTF-8 console, and its exit code comes back", { skip: !windows }, async () => {
  const root = await folder({ "bin\\pikibun.cmd": "echo path %*\nchcp\nexit /b 3" });
  try {
    const result = cmd(cmdRun("pikibun", ["host", "--stdio"]), root, join(root, "bin"));
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stdout, /^path host --stdio\r?\n/);
    assert.match(result.stdout, /65001/);
    const fallback = cmd(cmdRunOwn(OWN, "pikibun", ["serve", "--stdio"]), root, join(root, "bin"));
    assert.equal(fallback.status, 3, fallback.stderr);
    assert.match(fallback.stdout, /^path serve --stdio\r?\n/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the app's own copy runs before the one on PATH", { skip: !windows }, async () => {
  const root = await folder({ [OWN]: "echo own %*", "bin\\pikibun.cmd": "echo path %*" });
  try {
    const result = cmd(cmdRunOwn(OWN, "pikibun", ["host", "--stdio"]), root, join(root, "bin"));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^own host --stdio\r?\n/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
