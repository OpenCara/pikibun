import test from "node:test";
import assert from "node:assert/strict";
import { gitDirectory, gitLimits, gitRequest, gitShellCommand } from "../apps/runner/src/git-command.js";
import { validateOperation } from "../apps/runner/src/protocol.js";

test("the git tool takes Git's arguments as a list, starting with an allowed subcommand", () => {
  assert.deepEqual(gitRequest({ args: ["status"] }), { directory: ".", args: ["status"] });
  assert.deepEqual(gitRequest({ args: ["commit", "-m", "Fix it"], directory: "./app/" }), { directory: "app", args: ["commit", "-m", "Fix it"] });
  assert.throws(() => gitRequest({ args: [] }), /subcommand/);
  assert.throws(() => gitRequest({ args: "status" }), /as a list/);
  assert.throws(() => gitRequest({ args: [1] }), /string/);
  assert.throws(() => gitRequest({ args: ["status", "a\0b"] }), /NUL/);
  assert.throws(() => gitRequest({ args: Array.from({ length: gitLimits.arguments + 1 }, () => "status") }), /at most/);
  for (const subcommand of ["config", "submodule", "filter-branch", "bisect", "difftool", "credential", "daemon", "upload-pack", "help"]) {
    assert.throws(() => gitRequest({ args: [subcommand] }), /isn't one the git tool runs/, subcommand);
  }
  for (const global of ["-c", "-C", "--git-dir=x", "--exec-path=/tmp", "--config-env=a=B"]) {
    assert.throws(() => gitRequest({ args: [global, "status"] }), /Git's own options/, global);
  }
});

test("the git tool refuses options that run a program, or take settings or hooks that do", () => {
  const refused: string[][] = [
    ["clone", "--upload-pack=touch x", "https://example.test/a"],
    ["clone", "--upload-p", "touch x", "https://example.test/a"],
    ["clone", "--up", "touch x", "https://example.test/a"],
    ["clone", "--co", "core.fsmonitor=touch x", "https://example.test/a"],
    ["clone", "--co=core.fsmonitor=touch x", "https://example.test/a"],
    ["clone", "--te=hooks", "https://example.test/a"],
    ["rebase", "--ex=touch x", "main"],
    ["rebase", "--e", "touch x", "main"],
    ["grep", "--op", "foo"],
    ["push", "--rec=touch x"],
    ["clone", "-u", "touch x", "https://example.test/a"],
    ["clone", "-qu", "touch x", "https://example.test/a"],
    ["clone", "-c", "core.fsmonitor=touch x", "https://example.test/a"],
    ["clone", "--config", "core.fsmonitor=touch x", "https://example.test/a"],
    ["clone", "--template=hooks", "https://example.test/a"],
    ["init", "--template", "hooks"],
    ["fetch", "--upload-pack", "touch x"],
    ["pull", "--upload-pack=touch x"],
    ["ls-remote", "-u", "touch x", "origin"],
    ["push", "--receive-pack=touch x"],
    ["push", "--exec=touch x"],
    ["rebase", "--exec", "touch x", "main"],
    ["rebase", "-x", "touch x", "main"],
    ["rebase", "-ix", "touch x", "main"],
    ["grep", "-O", "foo"],
    ["grep", "--open-files-in-pager=vi", "foo"],
  ];
  for (const args of refused) assert.throws(() => gitRequest({ args }), /runs a program/, args.join(" "));
  const allowed: string[][] = [
    ["clone", "-b", "main", "https://example.test/a"],
    ["clone", "-bcool", "https://example.test/a"],
    ["clone", "--depth=1", "https://example.test/a"],
    ["rebase", "-i", "main"],
    ["rebase", "-Xours", "main"],
    ["commit", "-c", "HEAD"],
    ["add", "-u"],
    ["fetch", "-u", "origin"],
    ["diff", "--text"],
    ["rebase", "--empty=drop", "main"],
    ["grep", "--or", "-e", "a"],
    ["fetch", "--unshallow"],
    ["clone", "--no-tags", "https://example.test/a"],
    ["grep", "-e", "-O", "foo"],
    ["log", "--", "--exec"],
    ["push", "origin", "HEAD:pikibun/session"],
  ];
  for (const args of allowed) assert.doesNotThrow(() => gitRequest({ args }), args.join(" "));
});

test("the git tool runs in a directory of the worktree, never outside it", () => {
  assert.equal(gitDirectory(undefined), ".");
  assert.equal(gitDirectory("."), ".");
  assert.equal(gitDirectory("src\\app"), "src/app");
  for (const outside of ["..", "app/../..", "/etc", "C:\\work", "~/x", "a\0b", 3]) assert.throws(() => gitDirectory(outside), /within the session's worktree/, String(outside));
});

test("the git tool's command quotes every argument and runs Git without a pager, editor or prompt", () => {
  assert.equal(gitShellCommand({ directory: ".", args: ["status"] }),
    "GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true GIT_TERMINAL_PROMPT=0 git --no-pager 'status' </dev/null 2>&1");
  assert.equal(gitShellCommand({ directory: "my app", args: ["commit", "-m", "It's $(done); `really`\nyes"] }),
    "cd -- './my app' && GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true GIT_TERMINAL_PROMPT=0 git --no-pager 'commit' '-m' 'It'\\''s $(done); `really`\nyes' </dev/null 2>&1");
  assert.equal(gitLimits.commandLength, 8192);
  assert.throws(() => gitRequest({ args: ["commit", "-m", "x".repeat(gitLimits.argumentLength + 1)] }), /at most 8192 characters/);
  assert.throws(() => gitShellCommand({ directory: ".", args: ["commit", "-m", "x".repeat(8100)] }), /over 8192 characters/);
  assert.doesNotThrow(() => validateOperation({ kind: "bash", command: gitShellCommand({ directory: "app", args: ["commit", "-m", "x".repeat(8000)] }) }));
});
