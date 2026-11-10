import test from "node:test";
import assert from "node:assert/strict";
import { validateOperation } from "../apps/runner/src/protocol.js";
import { parseOperation } from "../apps/server/src/authority/operations.js";
import { runsOnHost } from "../packages/shared/src/host-operations.js";
import { redactOperation } from "../packages/shared/src/redaction.js";

const git = { kind: "program", tool: "git", command: "GIT_EDITOR=true git --no-pager 'status' </dev/null 2>&1" } as const;

test("a program tool's call is its own operation, checked the same way by the runner and the control plane", () => {
  assert.deepEqual(validateOperation({ command: git.command, tool: "git", kind: "program" }), git, "in canonical key order");
  assert.deepEqual(parseOperation(git), git);
  for (const bad of [{ ...git, tool: "bash" }, { ...git, tool: "rm" }, { ...git, extra: 1 }, { kind: "program", tool: "git" }, { ...git, command: "" }, { ...git, command: "x".repeat(8193) }]) {
    assert.throws(() => validateOperation(bad), /Invalid operation/, JSON.stringify(bad).slice(0, 80));
    assert.throws(() => parseOperation(bad), JSON.stringify(bad).slice(0, 80));
  }
});

test("a program tool's call runs where a shell command would: on the host for a session there, or without limits on a grant", () => {
  const sandboxed = { ownerId: "alice", connectorOwnerId: "alice" };
  assert.equal(runsOnHost(git, sandboxed), false);
  assert.equal(runsOnHost(git, { ...sandboxed, hostEnvironment: true }), true, "a session on its host runs it there");
  assert.equal(runsOnHost(git, { ownerId: "bob", connectorOwnerId: "alice" }, true), true, "without the host's limits on a grant");
  assert.match((redactOperation({ ...git, command: "git clone https://user:ghp_0123456789abcdefghijABCDEFGHIJ012345@github.com/a/b" }) as { command: string }).command, /\[redacted\]|REDACTED|•/);
});
