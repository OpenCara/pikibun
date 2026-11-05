import test from "node:test";
import assert from "node:assert/strict";
import { ecosystemRequest, ecosystemShellCommand } from "../apps/runner/src/ecosystem-command.js";

test("each toolchain's tool runs one of its programs, with its arguments as a list, in a directory of the worktree", () => {
  assert.deepEqual(ecosystemRequest("rust", { program: "cargo", args: ["test"], directory: "app" }), { tool: "rust", program: "cargo", directory: "app", args: ["test"] });
  assert.deepEqual(ecosystemRequest("make", { program: "make" }), { tool: "make", program: "make", directory: ".", args: [] });
  for (const [tool, program] of [["rust", "go"], ["go", "cargo"], ["dotnet", "nuget"], ["make", "bash"], ["rust", "cargo; id"], ["go", undefined]] as const) {
    assert.throws(() => ecosystemRequest(tool, { program }), /program is one of/, `${tool} ${program}`);
  }
  assert.throws(() => ecosystemRequest("go", { program: "go", args: "test ./..." }), /as a list/);
  assert.throws(() => ecosystemRequest("make", { program: "make", directory: "../x" }), /within the session's worktree/);
});

test("what acts on a registry as an account is refused: cargo publish, login, owner, yank; dotnet nuget push, delete and stored credentials", () => {
  const refused: [Parameters<typeof ecosystemRequest>[0], string, string[]][] = [
    ["rust", "cargo", ["publish"]], ["rust", "cargo", ["+nightly", "publish"]], ["rust", "cargo", ["--manifest-path", "a/Cargo.toml", "publish"]],
    ["rust", "cargo", ["-Z", "unstable-options", "login"]], ["rust", "cargo", ["owner", "--add", "eve"]], ["rust", "cargo", ["yank", "--version", "1.0.0"]],
    ["rust", "cargo", ["logout"]], ["dotnet", "dotnet", ["nuget", "push", "a.nupkg"]], ["dotnet", "dotnet", ["nuget", "delete", "A", "1.0"]],
    ["dotnet", "dotnet", ["nuget", "add", "source", "https://x/index.json", "--username", "me", "--password", "pw"]],
    ["dotnet", "dotnet", ["nuget", "update", "source", "feed", "-p", "pw"]],
  ];
  for (const [tool, program, args] of refused) assert.throws(() => ecosystemRequest(tool, { program, args }), /acts on a registry as an account/, `${program} ${args.join(" ")}`);
  const allowed: [Parameters<typeof ecosystemRequest>[0], string, string[]][] = [
    ["rust", "cargo", ["build", "--release"]], ["rust", "cargo", ["run", "--", "publish"]], ["rust", "cargo", ["add", "login"]], ["rust", "cargo", ["test", "-p", "publish"]],
    ["dotnet", "dotnet", ["nuget", "add", "source", "https://x/index.json"]], ["dotnet", "dotnet", ["test"]], ["go", "go", ["test", "./..."]], ["make", "make", ["-C", "publish", "all"]],
  ];
  for (const [tool, program, args] of allowed) assert.doesNotThrow(() => ecosystemRequest(tool, { program, args }), `${program} ${args.join(" ")}`);
});

test("the command quotes every argument and finds the toolchain where it installs, after the sandbox's PATH", () => {
  assert.equal(ecosystemShellCommand({ tool: "rust", program: "cargo", directory: "app", args: ["test", "it's"] }),
    "cd -- './app' && PATH=\"${PATH:-/usr/bin:/bin}\":\"$HOME/.cargo/bin\":\"/usr/local/bin\" CARGO_TERM_COLOR=never CARGO_TERM_PROGRESS_WHEN=never cargo 'test' 'it'\\''s' </dev/null 2>&1");
  assert.equal(ecosystemShellCommand({ tool: "make", program: "make", directory: ".", args: [] }), "PATH=\"${PATH:-/usr/bin:/bin}\":\"/usr/local/bin\" make </dev/null 2>&1");
});
