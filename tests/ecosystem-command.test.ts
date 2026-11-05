import test from "node:test";
import assert from "node:assert/strict";
import { ecosystemPrograms, ecosystemRequest, ecosystemShellCommand, registryAccountCommand } from "../apps/runner/src/ecosystem-command.js";
import { programShellCommand } from "../apps/runner/src/program-command.js";

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
  assert.equal(ecosystemShellCommand(ecosystemRequest("rust", { program: "cargo", args: ["build", "--message-format=short"] })),
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
    // --install takes no value: the toolchain still comes before the program (review of #194).
    ["rustup", ["run", "--install", "stable", "cargo", "publish"], "cargo publish"],
    ["rustup", ["run", "stable", "--install", "cargo", "+nightly", "login"], "cargo login"],
    // A -- before the toolchain or the program, and rustup's own +toolchain (review of #194).
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
