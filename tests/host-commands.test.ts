import assert from "node:assert/strict";
import test from "node:test";
import { decidedAsHostCommand, decidesHostCommand, decidesHostCommands, hostCommandWaiting, isHostCommand, offersAlwaysApprove, requesterAutoApproves } from "../packages/client/src/host-commands.js";
import type { ConnectorInfo } from "../packages/shared/src/connector.js";
import type { Operation } from "../packages/shared/src/types.js";
import { decidedAsHostCommand as sharedRule, grantedShell, memberAutoApproves, type HostCommandSession } from "../packages/shared/src/host-operations.js";
import { mayAutoApprove } from "../packages/shared/src/policy.js";
import { hostCommandSession } from "../apps/server/src/authority/host-access.js";

test("a host command is host_bash, or any command of a session that runs on its host", () => {
  const sandboxed = {};
  const onHost = { hostEnvironment: true as const };
  assert.equal(isHostCommand({ kind: "host.bash" }, sandboxed), true);
  assert.equal(isHostCommand({ kind: "host.bash" }, onHost), true);
  assert.equal(isHostCommand({ kind: "bash" }, onHost), true);
  assert.equal(isHostCommand({ kind: "bash" }, sandboxed), false);
  for (const kind of ["git.push", "github.comment", "permission"] as const) assert.equal(isHostCommand({ kind }, onHost), false, kind);
});

test("a command without the host's missing limits in a member's session is decided as a host command, though it runs in the sandbox", () => {
  type Session = { ownerId: string; connectorOwnerId?: string; hostEnvironment?: true };
  const member: Session = { ownerId: "github:2", connectorOwnerId: "github:1" };
  const own: Session = { ownerId: "github:1", connectorOwnerId: "github:1" };
  const bash = { kind: "bash" } as const;
  assert.equal(decidedAsHostCommand(bash, member, true), true);
  assert.equal(isHostCommand(bash, member), false, "it still runs in the sandbox, as the session's owner");
  assert.equal(decidedAsHostCommand(bash, member, false), false);
  assert.equal(decidedAsHostCommand(bash, member), false);
  assert.equal(decidedAsHostCommand(bash, own, true), false);
  assert.equal(decidedAsHostCommand(bash, { ownerId: "github:2" }, true), true);
  assert.equal(decidesHostCommand(bash, { connectorOwnerId: undefined }, undefined, "github:2", true), false);
  assert.equal(decidedAsHostCommand({ kind: "host.bash" }, own), true);
  assert.equal(decidedAsHostCommand(bash, { ...own, hostEnvironment: true }), true);
  for (const kind of ["git.push", "github.comment", "permission"] as const) assert.equal(decidedAsHostCommand({ kind }, member, true), false, kind);
});

test("the control plane, the host and the apps decide by one rule which operations take host command authority", () => {
  assert.equal(decidedAsHostCommand, sharedRule);
  const owner = "github:1"; const member = "github:2";
  const own: HostCommandSession = { ownerId: owner, connectorOwnerId: owner };
  const members: HostCommandSession = { ownerId: member, connectorOwnerId: owner };
  const cases: [kind: string, session: HostCommandSession, unbounded: boolean, decided: boolean][] = [
    ["host.bash", own, false, true],
    ["host.bash", members, false, true],
    ["bash", { ...own, hostEnvironment: true }, false, true],
    ["bash", { ...members, hostEnvironment: true }, false, true],
    ["bash", own, true, false],
    ["bash", members, true, true],
    ["bash", own, false, false],
    ["bash", members, false, false],
    ["git.push", { ...members, hostEnvironment: true }, true, false],
    ["permission", members, true, false],
  ];
  for (const [kind, session, unbounded, decided] of cases) {
    const label = JSON.stringify({ kind, session, unbounded });
    assert.equal(sharedRule({ kind }, session, unbounded), decided, label);
    const row = { owner_id: session.ownerId!, connector_owner_id: session.connectorOwnerId ?? null, host_environment: session.hostEnvironment ? 1 : 0 };
    assert.equal(sharedRule({ kind }, hostCommandSession(row), unbounded), decided, `row ${label}`);
  }
  assert.equal(grantedShell(own), false);
  assert.equal(grantedShell(members), true);
});

test("the host's owner and members granted host commands decide them, as the control plane checks; approve access alone doesn't", () => {
  const session = { connectorOwnerId: "github:1" };
  assert.equal(decidesHostCommands(session, { hostCommandAccess: "owner" }, "github:1"), true);
  assert.equal(decidesHostCommands(session, undefined, "github:1"), true);
  assert.equal(decidesHostCommands(session, undefined, "github:2"), false);
  for (const level of ["approve", "auto"] as const) assert.equal(decidesHostCommands(session, { hostCommandAccess: level }, "github:2"), true, level);
  assert.equal(decidesHostCommands(session, {}, "github:2"), false);
  assert.equal(decidesHostCommands({}, {}, "github:2"), false);
});

test("the host's owner decides host_bash without approve permission once the host lets them; anything else, and anyone else, still needs it", () => {
  const session = { connectorOwnerId: "github:1" };
  const hostBash = { kind: "host.bash" } as const;
  const hostSessionBash = { kind: "bash" } as const;
  const current = { hostCommandAccess: "owner" as const, capabilities: { hostOwnerDecides: true } };
  const older = { hostCommandAccess: "owner" as const, capabilities: {} };
  assert.equal(decidesHostCommand(hostBash, session, current, "github:1", false), true);
  assert.equal(decidesHostCommand(hostSessionBash, session, current, "github:1", false), false);
  assert.equal(decidesHostCommand(hostSessionBash, session, current, "github:1", true), true);
  assert.equal(decidesHostCommand(hostBash, session, older, "github:1", false), false);
  assert.equal(decidesHostCommand(hostBash, session, undefined, "github:1", false), false);
  assert.equal(decidesHostCommand(hostBash, session, older, "github:1", true), true);
  for (const level of ["approve", "auto"] as const) {
    const host = { hostCommandAccess: level, capabilities: { hostOwnerDecides: true } };
    assert.equal(decidesHostCommand(hostBash, session, host, "github:2", false), false, level);
    assert.equal(decidesHostCommand(hostBash, session, host, "github:2", true), true, level);
  }
  assert.equal(decidesHostCommand(hostBash, session, { capabilities: { hostOwnerDecides: true } }, "github:2", true), false);
});

test("a host command's card says whether approve access is needed of the host's owner too", () => {
  const current = { capabilities: { hostOwnerDecides: true } };
  assert.equal(hostCommandWaiting({ kind: "host.bash" }, current), "Waiting for the host's owner, or a member granted host commands with approve access to this session");
  for (const [operation, host] of [[{ kind: "host.bash" }, { capabilities: {} }], [{ kind: "host.bash" }, undefined], [{ kind: "bash" }, current]] as const) {
    assert.equal(hostCommandWaiting(operation, host), "Waiting for the host's owner or a member granted host commands, either with approve access to this session");
  }
});

test("another member's requests run without asking only for sandboxed commands, pushes, comments and issues, offered to the owner alone", () => {
  const sandboxed = { ownerId: "alice", connectorOwnerId: "bob" };
  const push = { kind: "git.push" as const, directory: "app", branch: "feature" };
  assert.equal(requesterAutoApproves({ kind: "bash" }, sandboxed), true);
  assert.equal(requesterAutoApproves(push, sandboxed), true);
  assert.equal(requesterAutoApproves({ kind: "github.comment" }, sandboxed), true);
  assert.equal(requesterAutoApproves({ kind: "github.issue" }, sandboxed), true);
  assert.equal(requesterAutoApproves({ kind: "github.merge" }, sandboxed), false);
  assert.equal(requesterAutoApproves({ kind: "host.bash" }, sandboxed), false);
  assert.equal(requesterAutoApproves({ kind: "bash" }, { ...sandboxed, hostEnvironment: true }), false);
  assert.equal(requesterAutoApproves({ kind: "bash" }, sandboxed, true), false);
  assert.equal(requesterAutoApproves({ kind: "permission" }, sandboxed), false);

  const session = { ...sandboxed, requesterAutoApprove: true as const };
  const card = { operation: { kind: "bash", command: "npm test" } as Operation, requestedBy: "carol" };
  const host = { capabilities: { requesterAutoApprove: true } } as unknown as ConnectorInfo;
  assert.equal(offersAlwaysApprove(card, session, host, "alice"), true);
  assert.equal(offersAlwaysApprove(card, session, host, "carol"), false);
  assert.equal(offersAlwaysApprove({ ...card, requestedBy: "alice" }, session, host, "alice"), false);
  assert.equal(offersAlwaysApprove(card, sandboxed, host, "alice"), false);
  assert.equal(offersAlwaysApprove(card, session, { capabilities: {} } as unknown as ConnectorInfo, "alice"), false);
  assert.equal(offersAlwaysApprove(card, session, undefined, "alice"), true);
});

test("a workspace owner's, admin's or collaborator's own Auto-approve runs only their commands that stay in the sandbox", () => {
  assert.equal(mayAutoApprove("alice", "alice", "member"), true);
  for (const role of ["owner", "admin", "collaborator"] as const) assert.equal(mayAutoApprove("carol", "alice", role), true, role);
  for (const role of ["member", "viewer", undefined] as const) assert.equal(mayAutoApprove("carol", "alice", role), false, String(role));
  const sandboxed = { ownerId: "alice", connectorOwnerId: "bob" };
  assert.equal(memberAutoApproves({ kind: "bash" }, sandboxed), true);
  assert.equal(memberAutoApproves({ kind: "program" }, sandboxed), true);
  for (const kind of ["git.push", "github.comment", "github.issue", "github.merge", "host.bash", "extension.tool", "permission", "git.commit"]) {
    assert.equal(memberAutoApproves({ kind }, sandboxed), false, kind);
  }
  assert.equal(memberAutoApproves({ kind: "bash" }, { ...sandboxed, hostEnvironment: true }), false, "a session on its host");
  assert.equal(memberAutoApproves({ kind: "program" }, sandboxed, true), false, "without the host's limits");
});

test("an extension's tool call is decided as a host command, by the host's owner without approve permission, and never auto-approved for another member", () => {
  const call = { kind: "extension.tool" } as const;
  const session = { ownerId: "github:2", connectorOwnerId: "github:1" };
  assert.equal(isHostCommand(call, {}), true);
  assert.equal(decidedAsHostCommand(call, session), true);
  assert.equal(sharedRule(call, session), true);
  assert.equal(requesterAutoApproves(call, session), false);
  assert.equal(decidesHostCommand(call, session, undefined, "github:1", false), true, "the host's owner, without approve permission");
  assert.equal(decidesHostCommand(call, session, undefined, "github:2", true), false, "the session's owner, without host command authority");
});

test("an extension tool card takes exactly its keys, in any order", async () => {
  const { validExtensionToolOperation } = await import("../packages/shared/src/host-operations.js");
  const card = { kind: "extension.tool", source: "npm:a@1.0.0", tool: "shout", arguments: "{}", digest: "a".repeat(64) };
  assert.equal(validExtensionToolOperation(card), true);
  assert.equal(validExtensionToolOperation({ digest: card.digest, arguments: "{}", tool: "shout", source: card.source, kind: card.kind }), true);
  assert.equal(validExtensionToolOperation({ ...card, extra: 1 }), false);
  assert.equal(validExtensionToolOperation({ ...card, digest: "short" }), false);
});
