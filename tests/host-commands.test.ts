import assert from "node:assert/strict";
import test from "node:test";
import { grantedShell, runsOnHost, type HostCommandSession } from "../packages/shared/src/host-operations.js";
import { hostCommandSession } from "../apps/server/src/authority/host-access.js";

test("what runs on the host's own machine: host commands and extension tools, a session on its host, and a member's commands without the host's limits", () => {
  const owner = "github:1"; const member = "github:2";
  const own: HostCommandSession = { ownerId: owner, connectorOwnerId: owner };
  const members: HostCommandSession = { ownerId: member, connectorOwnerId: owner };
  const cases: [kind: string, session: HostCommandSession, unbounded: boolean, onHost: boolean][] = [
    ["host.bash", own, false, true],
    ["host.bash", members, false, true],
    ["extension.tool", members, false, true],
    ["bash", { ...own, hostEnvironment: true }, false, true],
    ["program", { ...members, hostEnvironment: true }, false, true],
    ["bash", own, true, false],
    ["bash", members, true, true],
    ["program", members, true, true],
    ["bash", own, false, false],
    ["bash", members, false, false],
    ["git.push", { ...members, hostEnvironment: true }, true, false],
    ["github.comment", { ...members, hostEnvironment: true }, false, false],
  ];
  for (const [kind, session, unbounded, onHost] of cases) {
    const label = JSON.stringify({ kind, session, unbounded });
    assert.equal(runsOnHost({ kind }, session, unbounded), onHost, label);
    const row = { owner_id: session.ownerId!, connector_owner_id: session.connectorOwnerId ?? null, host_environment: session.hostEnvironment ? 1 : 0 };
    assert.equal(runsOnHost({ kind }, hostCommandSession(row), unbounded), onHost, `row ${label}`);
  }
  assert.equal(grantedShell(own), false);
  assert.equal(grantedShell(members), true);
});

test("an extension tool card takes exactly its keys, in any order", async () => {
  const { validExtensionToolOperation } = await import("../packages/shared/src/host-operations.js");
  const card = { kind: "extension.tool", source: "npm:a@1.0.0", tool: "shout", arguments: "{}", digest: "a".repeat(64) };
  assert.equal(validExtensionToolOperation(card), true);
  assert.equal(validExtensionToolOperation({ digest: card.digest, arguments: "{}", tool: "shout", source: card.source, kind: card.kind }), true);
  assert.equal(validExtensionToolOperation({ ...card, extra: 1 }), false);
  assert.equal(validExtensionToolOperation({ ...card, digest: "short" }), false);
});
