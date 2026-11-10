import test from "node:test";
import assert from "node:assert/strict";
import { SYSTEM_RUSTUP_HOME, ecosystemPath, ecosystemPrograms, ecosystemRequest, ecosystemShellCommand, ecosystemTools, registryAccountCommand } from "../apps/runner/src/ecosystem-command.js";
import { SEATBELT_LOCAL_ROOTS } from "../apps/runner/src/seatbelt.js";
import { programShellCommand } from "../apps/runner/src/program-command.js";
import { existsSync } from "node:fs";

test("rust, go and dotnet take their own programs, arguments as a list and a worktree directory", () => {
  assert.deepEqual(ecosystemPrograms.rust, ["cargo", "rustc", "rustup", "rustfmt"]);
  assert.deepEqual(ecosystemRequest("rust", { program: "cargo", args: ["test", "--quiet"], directory: "app/" }), { tool: "rust", program: "cargo", directory: "app", args: ["test", "--quiet"] });
  assert.deepEqual(ecosystemRequest("go", { program: "gofmt", args: ["-l", "."] }), { tool: "go", program: "gofmt", directory: ".", args: ["-l", "."] });
  assert.throws(() => ecosystemRequest("go", { program: "cargo", args: [] }), /program is one of go, gofmt/);
  assert.throws(() => ecosystemRequest("dotnet", { program: "dotnet", args: "build" }), /args is the arguments as a list/);
  assert.throws(() => ecosystemRequest("rust", { program: "cargo", args: [], directory: "../elsewhere" }), /directory is a path within/);
  assert.throws(() => ecosystemRequest("rust", { program: "cargo", args: [], directory: "/etc" }), /directory is a path within/);
});

test("each runs one quoted program with its toolchain directories after PATH and no colours, telemetry or input", () => {
  assert.equal(ecosystemShellCommand(ecosystemRequest("rust", { program: "cargo", args: ["build", "--message-format=short"] }), { rustupHome: false }),
    "PATH=\"${PATH:-/usr/bin:/bin}\":'/usr/local/cargo/bin':'/usr/local/bin' NO_COLOR=1 CARGO_TERM_COLOR=never CARGO_TERM_PROGRESS_WHEN=never cargo 'build' '--message-format=short' </dev/null 2>&1");
  assert.equal(ecosystemShellCommand(ecosystemRequest("dotnet", { program: "dotnet", args: ["test", "$(rm -rf ~)"], directory: "src/App" })),
    "cd -- './src/App' && PATH=\"${PATH:-/usr/bin:/bin}\":'/usr/share/dotnet':'/usr/lib/dotnet':'/usr/local/share/dotnet':'/usr/local/bin' "
    + "NO_COLOR=1 DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 DOTNET_CLI_UI_LANGUAGE=en dotnet 'test' '$(rm -rf ~)' </dev/null 2>&1");
});

test("commands that act on a package registry as an account are refused, through cargo's toolchain and rustup run", () => {
  for (const [program, args, refused] of [
    ["cargo", ["publish"], "cargo publish"],
    ["cargo", ["login"], "cargo login"],
    ["cargo", ["logout"], "cargo logout"],
    ["cargo", ["owner", "--add", "someone"], "cargo owner"],
    ["cargo", ["yank", "--version", "1.0.0"], "cargo yank"],
    ["cargo", ["+nightly", "publish"], "cargo publish"],
    ["cargo", ["--color", "never", "publish", "--dry-run"], "cargo publish"],
    ["cargo", ["-Z", "unstable-options", "publish"], "cargo publish"],
    ["rustup", ["run", "stable", "cargo", "publish"], "cargo publish"],
    ["rustup", ["run", "--install", "stable", "cargo", "publish"], "cargo publish"],
    ["rustup", ["run", "stable", "--install", "cargo", "+nightly", "login"], "cargo login"],
    ["rustup", ["run", "stable", "--", "cargo", "publish"], "cargo publish"],
    ["rustup", ["run", "--", "stable", "cargo", "publish"], "cargo publish"],
    ["rustup", ["+nightly", "run", "stable", "cargo", "publish"], "cargo publish"],
    ["cargo", ["--manifest-path", "Cargo.toml", "publish"], "cargo publish"],
    ["dotnet", ["nuget", "add", "source", "https://example.test/v3/index.json", "-p:secret"], "dotnet nuget add source with a password"],
    ["dotnet", ["nuget", "add", "source", "https://example.test/v3/index.json", "--password:secret"], "dotnet nuget add source with a password"],
    ["dotnet", ["nuget", "update", "source", "feed", "-p=secret"], "dotnet nuget update source with a password"],
    ["dotnet", ["nuget", "push", "app.nupkg", "--api-key", "x"], "dotnet nuget push"],
    ["dotnet", ["nuget", "delete", "App", "1.0.0"], "dotnet nuget delete"],
    ["dotnet", ["nuget", "add", "source", "https://example.test/v3/index.json", "-u", "me", "-p", "secret"], "dotnet nuget add source with a password"],
    ["dotnet", ["nuget", "update", "source", "feed", "--password=secret"], "dotnet nuget update source with a password"],
  ] as const) {
    assert.equal(registryAccountCommand(program, args), refused, `${program} ${args.join(" ")}`);
  }
  for (const [program, args] of [
    ["cargo", ["build"]], ["cargo", ["test", "--", "publish"]], ["cargo", ["package"]], ["cargo", ["--config", "publish", "build"]],
    ["rustup", ["run", "stable", "cargo", "build"]], ["rustup", ["run", "stable", "--", "cargo", "build"]], ["rustup", ["run", "stable", "cargo", "test", "--", "publish"]],
    ["rustup", ["+nightly", "show"]], ["rustup", ["show"]], ["dotnet", ["nuget", "add", "source", "feed", "--protocol-version", "3"]], ["go", ["test", "./..."]], ["gofmt", ["-l", "."]],
    ["dotnet", ["build"]], ["dotnet", ["nuget", "add", "source", "https://example.test/v3/index.json"]], ["dotnet", ["nuget", "list", "source"]], ["dotnet", ["pack"]],
  ] as const) {
    assert.equal(registryAccountCommand(program, args), undefined, `${program} ${args.join(" ")}`);
  }
  assert.throws(() => ecosystemRequest("rust", { program: "cargo", args: ["publish"] }), /cargo publish acts on a package registry as an account, which sessions don't have: the rust tool doesn't run it/);
});

test("a toolchain directory list never puts an empty entry on PATH, which the shell would take for the command's directory", () => {
  assert.equal(programShellCommand({ directory: ".", program: "go", args: ["version"], path: ["", "/usr/local/go/bin", ""] }),
    "PATH=\"${PATH:-/usr/bin:/bin}\":'/usr/local/go/bin' go 'version' </dev/null 2>&1");
  assert.equal(programShellCommand({ directory: ".", program: "go", args: [], path: "" }), "go </dev/null 2>&1");
  assert.equal(programShellCommand({ directory: ".", program: "go", args: [], path: [""] }), "go </dev/null 2>&1");
});

test("with a system-wide rustup, rust calls use its toolchains unless the session names another RUSTUP_HOME; go and dotnet are untouched", () => {
  const cargo = ecosystemRequest("rust", { program: "cargo", args: ["test"] });
  assert.equal(ecosystemShellCommand(cargo, { rustupHome: true }),
    "PATH=\"${PATH:-/usr/bin:/bin}\":'/usr/local/cargo/bin':'/usr/local/bin' NO_COLOR=1 CARGO_TERM_COLOR=never CARGO_TERM_PROGRESS_WHEN=never "
    + "RUSTUP_HOME=\"${RUSTUP_HOME:-/usr/local/rustup}\" cargo 'test' </dev/null 2>&1");
  assert.doesNotMatch(ecosystemShellCommand(cargo, { rustupHome: false }), /RUSTUP_HOME/);
  assert.doesNotMatch(ecosystemShellCommand(ecosystemRequest("go", { program: "go", args: ["test"] }), { rustupHome: true }), /RUSTUP_HOME/);
  assert.doesNotMatch(ecosystemShellCommand(cargo, { rustupHome: true }), /CARGO_HOME/, "the session keeps its own cargo home");
  assert.equal(/RUSTUP_HOME/.test(ecosystemShellCommand(cargo, {})), existsSync("/usr/local/rustup"));
  assert.equal(ecosystemShellCommand(cargo), ecosystemShellCommand(cargo, {}));
});

test("a rustup proxy finds the system toolchain through RUSTUP_HOME, and the session's own setting wins", { skip: process.platform === "win32" }, async () => {
  const { mkdtemp, mkdir, writeFile, chmod, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const root = await mkdtemp(join(tmpdir(), "pikibun-rustup-"));
  try {
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "cargo"), "#!/bin/sh\necho \"rustup-home=${RUSTUP_HOME:-$HOME/.rustup}\"\n");
    await chmod(join(bin, "cargo"), 0o755);
    const command = ecosystemShellCommand(ecosystemRequest("rust", { program: "cargo", args: ["--version"] }), { rustupHome: true });
    const run = (env: Record<string, string>) => execFileSync("/bin/sh", ["-c", command], { cwd: root, env: { PATH: bin, HOME: join(root, "home"), ...env }, encoding: "utf8" });
    assert.equal(run({}), "rustup-home=/usr/local/rustup\n");
    assert.equal(run({ RUSTUP_HOME: "/opt/rustup" }), "rustup-home=/opt/rustup\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the macOS sandbox may read and run every toolchain directory below /usr/local the ecosystem tools look in", () => {
  const local = [...ecosystemTools.flatMap(tool => ecosystemPath(tool)), SYSTEM_RUSTUP_HOME, "/usr/local/go", "/usr/local/share/dotnet"].filter(path => path.startsWith("/usr/local/"));
  for (const path of local) {
    assert.ok(SEATBELT_LOCAL_ROOTS.some(root => path === root || path.startsWith(`${root}/`)), `${path} is under a root the sandbox reads`);
  }
  assert.ok(SEATBELT_LOCAL_ROOTS.includes("/usr/local/go"));
});

test("make runs make, its arguments quoted, refusing nothing as an account: a Makefile's recipes are what its card stands for", () => {
  assert.deepEqual(ecosystemPrograms.make, ["make"]);
  assert.deepEqual(ecosystemRequest("make", { program: "make", args: ["-C", "publish", "test"], directory: "app" }), { tool: "make", program: "make", directory: "app", args: ["-C", "publish", "test"] });
  assert.throws(() => ecosystemRequest("make", { program: "cargo", args: [] }), /program is one of make/);
  assert.equal(registryAccountCommand("make", ["publish"]), undefined, "a target named publish is the project's own");
  assert.equal(ecosystemShellCommand(ecosystemRequest("make", { program: "make", args: ["-j4", "all", "$(rm -rf ~)"] })),
    "PATH=\"${PATH:-/usr/bin:/bin}\":'/usr/local/bin' make '-j4' 'all' '$(rm -rf ~)' </dev/null 2>&1");
  assert.ok(ecosystemTools.includes("make"));
});
