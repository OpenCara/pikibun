import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { NSH_TUI_HOSTS } from "../scripts/nsh.mjs";
import { exitCode, findHost, hostArguments, hostBinary, hostKey, hostPackage, logFile, TUI_HOSTS } from "../packages/tui/src/launcher.js";
import { findOnPath, TUI_COMMAND, tuiLaunch } from "../packages/cli/src/tui.js";

const repository = fileURLToPath(new URL("../", import.meta.url));

test("the launcher knows a host package for each platform Native Shell publishes a terminal host for, and no other", () => {
  assert.deepEqual([...TUI_HOSTS].sort(), Object.keys(NSH_TUI_HOSTS).sort());
  assert.equal(hostKey("linux", "x64"), "linux-x64");
  assert.equal(hostKey("darwin", "arm64"), "darwin-arm64");
  assert.equal(hostKey("freebsd", "x64"), null);
  assert.equal(hostKey("linux", "ia32"), null);
  assert.equal(hostPackage("win32-arm64"), "@pikibun/tui-win32-arm64");
  assert.equal(hostBinary("win32"), "nsh-tui-host.exe");
  assert.equal(hostBinary("linux"), "nsh-tui-host");
});

test("the launcher finds this computer's host in its package, or says what is missing and how to get it", () => {
  const asked: string[] = [];
  const resolve = (id: string) => { asked.push(id); return `/lib/node_modules/${id}`; };
  assert.deepEqual(findHost({ env: {}, platform: "darwin", arch: "arm64", resolve }), { path: "/lib/node_modules/@pikibun/tui-darwin-arm64/bin/nsh-tui-host" });
  assert.deepEqual(asked, ["@pikibun/tui-darwin-arm64/bin/nsh-tui-host"]);
  assert.deepEqual(findHost({ env: { PIKIBUN_TUI_HOST: "/opt/nsh-tui-host" }, platform: "linux", arch: "x64", resolve }), { path: "/opt/nsh-tui-host" },
    "a host of one's own, such as a Native Shell checkout's, wins");
  const missing = findHost({ env: {}, platform: "win32", arch: "x64", resolve: () => { throw new Error("Cannot find module"); } });
  assert.ok("error" in missing && missing.error.includes("@pikibun/tui-win32-x64") && missing.error.includes("--omit=optional"), JSON.stringify(missing));
  const unsupported = findHost({ env: {}, platform: "freebsd", arch: "x64", resolve });
  assert.ok("error" in unsupported && unsupported.error.includes("freebsd-x64"), JSON.stringify(unsupported));
});

test("the host runs the bundled app, with its log where each system keeps logs unless the options name a file", () => {
  assert.deepEqual(hostArguments(["--no-mouse"], "/pkg/app/bundle.js", "/logs/tui.log"), ["--bundle", "/pkg/app/bundle.js", "--log-file", "/logs/tui.log", "--no-mouse"]);
  assert.deepEqual(hostArguments(["--log-file", "/tmp/mine.log"], "/b.js", "/logs/tui.log"), ["--bundle", "/b.js", "--log-file", "/tmp/mine.log"]);
  assert.deepEqual(hostArguments(["--log-file=/tmp/mine.log"], "/b.js", "/logs/tui.log"), ["--bundle", "/b.js", "--log-file=/tmp/mine.log"]);
  assert.equal(logFile({}, "linux", "/home/ada"), "/home/ada/.local/state/pikibun/tui.log");
  assert.equal(logFile({ XDG_STATE_HOME: "/state" }, "linux", "/home/ada"), "/state/pikibun/tui.log");
  assert.equal(logFile({}, "darwin", "/Users/ada"), "/Users/ada/Library/Logs/Pikibun/tui.log");
  assert.equal(logFile({ LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" }, "win32", "C:\\Users\\Ada"), "C:\\Users\\Ada\\AppData\\Local\\Pikibun\\Logs\\tui.log");
  assert.equal(exitCode(3, null), 3);
  assert.equal(exitCode(null, "SIGTERM"), 143);
  assert.equal(exitCode(null, null), 1);
});

test("pikibun tui starts the pikibun-tui on the PATH, as Windows names it too, or runs @pikibun/tui from npm", () => {
  const files = new Set(["/usr/local/bin/pikibun-tui", "C:\\npm\\pikibun-tui.cmd"]);
  const exists = (file: string) => files.has(file);
  assert.equal(findOnPath(TUI_COMMAND, { PATH: "/usr/bin:/usr/local/bin" }, "linux", exists), "/usr/local/bin/pikibun-tui");
  assert.equal(findOnPath(TUI_COMMAND, { PATH: "/usr/bin" }, "linux", exists), null);
  assert.equal(findOnPath(TUI_COMMAND, { Path: "C:\\Windows;C:\\npm", PATHEXT: ".COM;.EXE;.BAT;.CMD" }, "win32", exists), "C:\\npm\\pikibun-tui.cmd");
  assert.deepEqual(tuiLaunch(["--no-mouse"], "/usr/local/bin/pikibun-tui", "linux"),
    { command: "/usr/local/bin/pikibun-tui", args: ["--no-mouse"], shell: false, fromNpm: false });
  assert.deepEqual(tuiLaunch([], "C:\\npm\\pikibun-tui.cmd", "win32"), { command: "C:\\npm\\pikibun-tui.cmd", args: [], shell: true, fromNpm: false });
  assert.deepEqual(tuiLaunch(["--fps"], null, "darwin"), { command: "npx", args: ["--yes", "@pikibun/tui@latest", "--fps"], shell: false, fromNpm: true });
  assert.equal(tuiLaunch([], null, "win32").command, "npx.cmd");
});

test("pikibun's help lists tui, and pikibun tui --help explains it without @pikibun/tui installed", () => {
  const cli = path.join(repository, "packages/cli/src/cli.ts");
  const help = spawnSync(process.execPath, ["--import", "tsx", cli, "--help"], { cwd: repository, encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /\n {2}tui {9}Pikibun in this terminal/);
  const tui = spawnSync(process.execPath, ["--import", "tsx", cli, "tui", "--help"], { cwd: repository, encoding: "utf8", env: { ...process.env, PATH: path.dirname(process.execPath) } });
  assert.equal(tui.status, 0, tui.stderr);
  assert.match(tui.stdout, /^Usage: pikibun tui/);
  assert.match(tui.stdout, /npm install -g @pikibun\/tui/);
});

test("the build puts the launcher, the app's bundle under its own id and every host as an optional dependency in @pikibun/tui", t => {
  const work = mkdtempSync(path.join(tmpdir(), "pikibun-tui-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const app = path.join(work, "app");
  spawnSync(process.execPath, ["-e", `require("fs").mkdirSync(${JSON.stringify(path.join(app, "assets"))}, { recursive: true })`]);
  writeFileSync(path.join(app, "bundle.js"), "export {};\n");
  writeFileSync(path.join(app, "bundle.js.map"), "{}\n");
  writeFileSync(path.join(app, "bundle.nshc"), "bytecode");
  writeFileSync(path.join(app, "capabilities.json"), "{}\n");
  writeFileSync(path.join(app, "assets", "logo.png"), "png");
  const out = path.join(work, "dist");
  const built = spawnSync(process.execPath, [path.join(repository, "packages/tui/scripts/build.mjs"), "--app", app, "--hosts", "", "--version", "0.20.0-beta.1", "--out", out], { encoding: "utf8" });
  assert.equal(built.status, 0, built.stderr);
  const manifest = JSON.parse(readFileSync(path.join(out, "tui", "package.json"), "utf8")) as Record<string, unknown>;
  assert.equal(manifest.name, "@pikibun/tui");
  assert.equal(manifest.version, "0.20.0-beta.1");
  assert.equal(manifest.scripts, undefined);
  assert.deepEqual(manifest.bin, { "pikibun-tui": "bin/pikibun-tui.js" });
  assert.deepEqual(manifest.optionalDependencies, Object.fromEntries(TUI_HOSTS.map(host => [`@pikibun/tui-${host}`, "0.20.0-beta.1"])));
  assert.deepEqual(JSON.parse(readFileSync(path.join(out, "tui", "app", "app.json"), "utf8")), { id: "com.pikibun.tui", name: "Pikibun" });
  for (const file of ["bundle.js", "bundle.js.map", "capabilities.json", "assets/logo.png"]) assert.ok(existsSync(path.join(out, "tui", "app", file)), file);
  assert.equal(existsSync(path.join(out, "tui", "app", "bundle.nshc")), false, "a bundle the host loads as source only: it refuses bytecode from a file");
  const launcher = path.join(out, "tui", "bin", "pikibun-tui.js");
  assert.ok(readFileSync(launcher, "utf8").startsWith("#!/usr/bin/env node\n"));
  if (process.platform !== "win32") assert.ok(statSync(launcher).mode & 0o111, "the launcher is executable");
  const version = spawnSync(process.execPath, [launcher, "--version"], { encoding: "utf8" });
  assert.equal(version.stdout, "0.20.0-beta.1\n");
  const outsideTerminal = spawnSync(process.execPath, [launcher], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  assert.equal(outsideTerminal.status, 1);
  assert.match(outsideTerminal.stderr, /draws in a terminal/);
});
