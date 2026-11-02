import assert from "node:assert/strict";
import test from "node:test";
import { decidedAsHostCommand, decidesHostCommand, decidesHostCommands, hostCommandWaiting, isHostCommand, offersAlwaysApprove, requesterAutoApproves } from "../packages/client/src/host-commands.js";
import type { ConnectorInfo } from "../packages/shared/src/connector.js";
import type { Operation } from "../packages/shared/src/types.js";
import { decidedAsHostCommand as sharedRule, grantedShell, type HostCommandSession } from "../packages/shared/src/host-operations.js";
import { hostCommandSession } from "../apps/server/src/host-access.js";

test("a host command is host_bash, or any command of a session that runs on its host", () => {
  const sandboxed = {};
  const onHost = { hostEnvironment: true as const };
  assert.equal(isHostCommand({ kind: "host.bash" }, sandboxed), true);
  assert.equal(isHostCommand({ kind: "host.bash" }, onHost), true);
  assert.equal(isHostCommand({ kind: "bash" }, onHost), true);
  assert.equal(isHostCommand({ kind: "bash" }, sandboxed), false);
  // Only commands: a session on its host still pushes, comments and asks for permissions as any other does.
  for (const kind of ["git.push", "github.comment", "permission"] as const) assert.equal(isHostCommand({ kind }, onHost), false, kind);
});

test("a command without the host's missing limits in a member's session is decided as a host command, though it runs in the sandbox", () => {
  type Session = { ownerId: string; connectorOwnerId?: string; hostEnvironment?: true };
  const member: Session = { ownerId: "github:2", connectorOwnerId: "github:1" };
  const own: Session = { ownerId: "github:1", connectorOwnerId: "github:1" };
  const bash = { kind: "bash" } as const;
  assert.equal(decidedAsHostCommand(bash, member, true), true);
  assert.equal(isHostCommand(bash, member), false, "it still runs in the sandbox, as the session's owner");
  // Within the host's limits, or in the host owner's own session, approve permission decides it as before.
  assert.equal(decidedAsHostCommand(bash, member, false), false);
  assert.equal(decidedAsHostCommand(bash, member), false);
  assert.equal(decidedAsHostCommand(bash, own, true), false);
  // A session with no host recorded: nobody holds host command authority there, so nobody decides it.
  assert.equal(decidedAsHostCommand(bash, { ownerId: "github:2" }, true), true);
  assert.equal(decidesHostCommand(bash, { connectorOwnerId: undefined }, undefined, "github:2", true), false);
  // Every host command is decided as one.
  assert.equal(decidedAsHostCommand({ kind: "host.bash" }, own), true);
  assert.equal(decidedAsHostCommand(bash, { ...own, hostEnvironment: true }), true);
  for (const kind of ["git.push", "github.comment", "permission"] as const) assert.equal(decidedAsHostCommand({ kind }, member, true), false, kind);
});

test("the control plane, the host and the apps decide by one rule which operations take host command authority", () => {
  // The apps use the shared rule itself, as the host (RunnerSession.requireHostDecider) and the control plane do.
  assert.equal(decidedAsHostCommand, sharedRule);
  const owner = "github:1"; const member = "github:2";
  const own: HostCommandSession = { ownerId: owner, connectorOwnerId: owner };
  const members: HostCommandSession = { ownerId: member, connectorOwnerId: owner };
  const cases: [kind: string, session: HostCommandSession, unbounded: boolean, decided: boolean][] = [
    ["host.bash", own, false, true],
    ["host.bash", members, false, true],
    // Every command of a session that runs directly on its host.
    ["bash", { ...own, hostEnvironment: true }, false, true],
    ["bash", { ...members, hostEnvironment: true }, false, true],
    // A command without the host's missing limits: the host's owner allowed their own; a member's runs on their grant.
    ["bash", own, true, false],
    ["bash", members, true, true],
    // Within limits, approve permission decides as before.
    ["bash", own, false, false],
    ["bash", members, false, false],
    // Nothing but commands.
    ["git.push", { ...members, hostEnvironment: true }, true, false],
    ["permission", members, true, false],
  ];
  for (const [kind, session, unbounded, decided] of cases) {
    const label = JSON.stringify({ kind, session, unbounded });
    assert.equal(sharedRule({ kind }, session, unbounded), decided, label);
    // The control plane reads the same session from its row.
    const row = { owner_id: session.ownerId!, connector_owner_id: session.connectorOwnerId ?? null, host_environment: session.hostEnvironment ? 1 : 0 };
    assert.equal(sharedRule({ kind }, hostCommandSession(row), unbounded), decided, `row ${label}`);
  }
  // Only a member's commands run on a grant: the host's owner lets their own run without limits with a permission request.
  assert.equal(grantedShell(own), false);
  assert.equal(grantedShell(members), true);
});

test("the host's owner and members granted host commands decide them, as the control plane checks; approve access alone doesn't", () => {
  const session = { connectorOwnerId: "github:1" };
  assert.equal(decidesHostCommands(session, { hostCommandAccess: "owner" }, "github:1"), true);
  // The owner is known before the host listing loads; a grant only from it.
  assert.equal(decidesHostCommands(session, undefined, "github:1"), true);
  assert.equal(decidesHostCommands(session, undefined, "github:2"), false);
  for (const level of ["approve", "auto"] as const) assert.equal(decidesHostCommands(session, { hostCommandAccess: level }, "github:2"), true, level);
  assert.equal(decidesHostCommands(session, {}, "github:2"), false);
  // A session with no host recorded has no owner to match.
  assert.equal(decidesHostCommands({}, {}, "github:2"), false);
});

test("the host's owner decides host_bash without approve permission once the host lets them; anything else, and anyone else, still needs it", () => {
  const session = { connectorOwnerId: "github:1" };
  const hostBash = { kind: "host.bash" } as const;
  // A command of a session that runs on its host is a host command too, but the host's owner decides it with the approve
  // permission they hold on their own session, as the control plane and the host check it.
  const hostSessionBash = { kind: "bash" } as const;
  const current = { hostCommandAccess: "owner" as const, capabilities: { hostOwnerDecides: true } };
  const older = { hostCommandAccess: "owner" as const, capabilities: {} };
  assert.equal(decidesHostCommand(hostBash, session, current, "github:1", false), true);
  assert.equal(decidesHostCommand(hostSessionBash, session, current, "github:1", false), false);
  assert.equal(decidesHostCommand(hostSessionBash, session, current, "github:1", true), true);
  // An older connector checks approve permission on every decision, its owner's too; before the listing loads, so does the app.
  assert.equal(decidesHostCommand(hostBash, session, older, "github:1", false), false);
  assert.equal(decidesHostCommand(hostBash, session, undefined, "github:1", false), false);
  assert.equal(decidesHostCommand(hostBash, session, older, "github:1", true), true);
  // A member granted host commands decides them only with approve permission on the session, wherever the host stands.
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
  // Merges, host commands, commands of a session on its host and commands without the host's limits always ask.
  assert.equal(requesterAutoApproves({ kind: "github.merge" }, sandboxed), false);
  assert.equal(requesterAutoApproves({ kind: "host.bash" }, sandboxed), false);
  assert.equal(requesterAutoApproves({ kind: "bash" }, { ...sandboxed, hostEnvironment: true }), false);
  assert.equal(requesterAutoApproves({ kind: "bash" }, sandboxed, true), false);
  assert.equal(requesterAutoApproves({ kind: "permission" }, sandboxed), false);

  const session = { ...sandboxed, requesterAutoApprove: true as const };
  const card = { operation: { kind: "bash", command: "npm test" } as Operation, requestedBy: "carol" };
  const host = { capabilities: { requesterAutoApprove: true } } as unknown as ConnectorInfo;
  assert.equal(offersAlwaysApprove(card, session, host, "alice"), true);
  // Only the owner, on someone else's card, while the workspace allows it and the host would honor it.
  assert.equal(offersAlwaysApprove(card, session, host, "carol"), false);
  assert.equal(offersAlwaysApprove({ ...card, requestedBy: "alice" }, session, host, "alice"), false);
  assert.equal(offersAlwaysApprove(card, sandboxed, host, "alice"), false);
  assert.equal(offersAlwaysApprove(card, session, { capabilities: {} } as unknown as ConnectorInfo, "alice"), false);
  // A host missing from the viewer's listing can't say; the control plane decides.
  assert.equal(offersAlwaysApprove(card, session, undefined, "alice"), true);
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
