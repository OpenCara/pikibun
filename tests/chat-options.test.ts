import test from "node:test";
import assert from "node:assert/strict";
import type { ConnectorInfo } from "../packages/shared/src/connector.js";
import type { SessionView } from "../packages/shared/src/types.js";
import {
  accessHint, accessLabels, accessUnavailable, autoApproveMerges, autoApproveWarning, chatOptionsBody, chatPreference, initialSelection, memberAutoApproveHint,
  memberAutoApproveWarning, modelUnavailable, mustConfirmAutoApprove, offersMemberAutoApprove, parseChatPreference, preferredSelection, type ChatSelection,
} from "../packages/client/src/chat-options.js";

const host = { capabilities: { chatOptions: true }, models: [] } as unknown as ConnectorInfo;
const auto: ChatSelection = { access: "auto" };

test("a chosen access goes with every shared message, or the message waits until it can", () => {
  assert.deepEqual(chatOptionsBody(host, auto, "submit"), { access: "auto" });
  assert.equal(accessUnavailable(host, auto, "submit"), undefined);
  assert.equal(chatOptionsBody(undefined, auto, "submit"), undefined);
  assert.match(accessUnavailable(undefined, auto, "submit") ?? "", /Auto-approve/);
  assert.match(accessUnavailable(undefined, { access: "read" }, "submit") ?? "", /Read only/);
  assert.equal(accessUnavailable(undefined, { access: "approval" }, "submit"), undefined);
  assert.equal(accessUnavailable(undefined, auto, "ask"), undefined);
});

test("a message waits for a model its host offers, once the conversation's own one is disabled there", () => {
  const offering = { name: "Bob's Pi", capabilities: { chatOptions: true }, models: [{ provider: "p", modelId: "fast", name: "Fast" }] } as unknown as ConnectorInfo;
  const fast = { provider: "p", modelId: "fast" };
  assert.equal(modelUnavailable(offering, { model: fast, access: "approval" }), undefined);
  assert.match(modelUnavailable(offering, { model: { provider: "p", modelId: "deep" }, access: "approval" }) ?? "", /Bob's Pi no longer offers deep\. Choose another model/);
  assert.equal(modelUnavailable(offering, { access: "approval" }), undefined);
  assert.equal(modelUnavailable({ ...offering, models: [] }, { model: fast, access: "approval" }), "Bob's Pi offers no models right now.");
  assert.equal(modelUnavailable({ ...offering, models: [] }, { access: "approval" }), "Bob's Pi offers no models right now.");
  assert.equal(modelUnavailable({ ...offering, capabilities: {} } as unknown as ConnectorInfo, { model: { provider: "p", modelId: "deep" }, access: "approval" }), undefined);
  assert.equal(modelUnavailable(undefined, { model: fast, access: "approval" }), undefined);
});

test("the last chatted model and reasoning start the next new chat where the host offers them", () => {
  const levels = ["off", "low", "medium", "high"] as const;
  const remembering = {
    id: "host-a", capabilities: { chatOptions: true },
    models: [
      { provider: "p", modelId: "fast", name: "Fast", thinkingLevels: [...levels], thinkingLevel: "low" },
      { provider: "p", modelId: "deep", name: "Deep", thinkingLevels: [...levels], thinkingLevel: "medium" },
      { provider: "p", modelId: "plain", name: "Plain", thinkingLevels: ["off"], thinkingLevel: "off" },
    ],
  } as unknown as ConnectorInfo;
  const fast = { provider: "p", modelId: "fast" };

  const preference = chatPreference(remembering, { model: { provider: "p", modelId: "deep" }, thinkingLevel: "high", access: "auto" });
  assert.deepEqual(preference, { connectorId: "host-a", provider: "p", modelId: "deep", thinkingLevel: "high" });
  assert.deepEqual(parseChatPreference(JSON.stringify(preference)), preference);
  assert.equal(chatPreference(remembering, { model: { provider: "p", modelId: "gone" }, access: "approval" }), undefined);
  assert.equal(chatPreference({ ...remembering, capabilities: {} } as unknown as ConnectorInfo, { model: fast, access: "approval" }), undefined);

  assert.deepEqual(preferredSelection(remembering, preference, fast), { model: { provider: "p", modelId: "deep" }, thinkingLevel: "high", access: "auto" });
  const elsewhere = { ...preference!, modelId: "gone" };
  assert.deepEqual(preferredSelection(remembering, elsewhere, fast), { model: fast, thinkingLevel: "high", access: "auto" });
  assert.deepEqual(preferredSelection(remembering, preference, fast, model => model.modelId !== "deep"), { model: fast, thinkingLevel: "high", access: "auto" });
  assert.deepEqual(preferredSelection(remembering, { ...preference!, thinkingLevel: "max" }, fast, () => false), { model: fast, thinkingLevel: "low", access: "auto" });
  assert.deepEqual(preferredSelection(remembering, undefined, fast), { model: fast, thinkingLevel: "low", access: "auto" });
  assert.deepEqual(preferredSelection(undefined, preference, fast), { access: "auto" });

  assert.equal(parseChatPreference(null), undefined);
  assert.equal(parseChatPreference("{"), undefined);
  assert.equal(parseChatPreference(JSON.stringify({ provider: "p" })), undefined);
  assert.deepEqual(parseChatPreference(JSON.stringify({ ...preference, thinkingLevel: "huge" })), { connectorId: "host-a", provider: "p", modelId: "deep" });
});

test("a message sent without picking a model remembers the conversation's current model and reasoning", () => {
  const host = {
    id: "host-a", capabilities: { chatOptions: true },
    models: [{ provider: "p", modelId: "deep", name: "Deep", thinkingLevels: ["off", "low", "high"], thinkingLevel: "low" }],
  } as unknown as ConnectorInfo;
  const current = { provider: "p", modelId: "deep", thinkingLevel: "high" as const };
  assert.deepEqual(chatPreference(host, { access: "approval" }, current), { connectorId: "host-a", provider: "p", modelId: "deep", thinkingLevel: "high" });
  assert.deepEqual(chatPreference(host, { thinkingLevel: "off", access: "approval" }, current), { connectorId: "host-a", provider: "p", modelId: "deep", thinkingLevel: "off" });
  assert.equal(chatPreference(host, { access: "approval" }), undefined);
});

test("the owner's chat box starts on Auto-approve before the first shared message, then keeps that message's access", () => {
  const view = (access?: SessionView["access"], entries: SessionView["entries"] = []) => ({ entries, ...(access ? { access } : {}) }) as SessionView;
  assert.equal(initialSelection(view(), true).access, "auto");
  assert.equal(initialSelection(view(undefined, [{ id: "1", kind: "message", role: "user", text: "Hi" }]), true).access, "approval");
  assert.equal(initialSelection(view(), false).access, "approval");
  assert.equal(initialSelection(view("approval"), true).access, "approval");
  assert.equal(initialSelection(view("read"), true).access, "read");
  assert.equal(initialSelection(view("auto"), false).access, "approval", "only the owner can auto-approve");
});

test("Auto-approve merges too, on hosts that run GitHub effects automatically, once its owner confirmed that on the device", () => {
  const automatic = { capabilities: { chatOptions: true, automaticGitHub: true }, models: [] } as unknown as ConnectorInfo;
  const merging = chatOptionsBody(automatic, auto, "submit");
  assert.deepEqual(merging, { access: "auto", autoMerge: true });
  assert.deepEqual(chatOptionsBody(host, auto, "submit"), { access: "auto" }, "an older connector is never sent it");
  assert.deepEqual(chatOptionsBody(automatic, { access: "approval" }, "submit"), { access: "approval" });
  assert.deepEqual(chatOptionsBody(automatic, auto, "ask"), {});
  assert.deepEqual([autoApproveMerges(automatic), autoApproveMerges(host), autoApproveMerges(undefined)], [true, false, false]);
  assert.equal(mustConfirmAutoApprove(merging, false), true);
  assert.equal(mustConfirmAutoApprove(merging, true), false, "confirmed on this device");
  assert.equal(mustConfirmAutoApprove(chatOptionsBody(host, auto, "submit"), false), false, "nothing merges without asking there");
  assert.equal(mustConfirmAutoApprove(chatOptionsBody(automatic, { access: "approval" }, "submit"), false), false);
  assert.equal(mustConfirmAutoApprove(undefined, false), false);
});

test("the Auto-approve warning says what runs without asking on this host", () => {
  const base = { name: "Bob's Pi", capabilities: { chatOptions: true, hostCommands: true, hostGrants: true, automaticGitHub: true } } as unknown as ConnectorInfo;
  assert.match(autoApproveWarning(base, false), /GitHub comments and new issues are posted, and pull requests merged, as you without asking/);
  assert.match(autoApproveWarning(base, true), /pull requests merged, as you without asking.*Branch protection and required checks on GitHub still apply/);
  assert.doesNotMatch(autoApproveWarning(base, false), /Auto-merge/);
  assert.match(autoApproveWarning({ ...base, capabilities: { ...base.capabilities, automaticGitHub: undefined } }, false), /GitHub comments and merges still need approval/);
  assert.match(autoApproveWarning({ ...base, hostCommandAccess: "auto" }, false), /granted you automatic host commands, so host commands, such as its extensions' tools, also run OUTSIDE the sandbox on Bob's Pi/);
  assert.match(autoApproveWarning({ ...base, hostCommandAccess: "owner" }, false), /On someone else's host they still need their approval/);
  assert.match(autoApproveWarning(base, false), /or one whose owner granted you automatic host commands/);
});

test("a workspace owner, admin or collaborator may choose Auto-approve in someone else's session, for their sandboxed commands only", () => {
  const automatic = { name: "Bob's Pi", capabilities: { chatOptions: true, automaticGitHub: true, memberAutoApprove: true }, models: [] } as unknown as ConnectorInfo;
  const older = { name: "Bob's Pi", capabilities: { chatOptions: true, automaticGitHub: true }, models: [] } as unknown as ConnectorInfo;
  const session = { ownerId: "owner" };
  assert.equal(offersMemberAutoApprove(session, automatic, "teammate", "collaborator", true, false), true);
  assert.equal(offersMemberAutoApprove(session, automatic, "teammate", "admin", true, false), true);
  assert.equal(offersMemberAutoApprove(session, automatic, "teammate", "owner", true, false), true);
  assert.equal(offersMemberAutoApprove(session, automatic, "teammate", "member", true, false), false, "a plain member asks");
  assert.equal(offersMemberAutoApprove(session, automatic, "teammate", "viewer", true, false), false);
  assert.equal(offersMemberAutoApprove(session, automatic, "teammate", undefined, true, false), false, "until the role is known");
  assert.equal(offersMemberAutoApprove(session, automatic, "teammate", "collaborator", false, false), false, "only someone who writes to it");
  assert.equal(offersMemberAutoApprove(session, automatic, "teammate", "collaborator", true, true), false, "never on an unsandboxed host");
  assert.equal(offersMemberAutoApprove(session, older, "teammate", "collaborator", true, false), false, "an older connector takes it from the owner only");
  assert.equal(offersMemberAutoApprove(session, undefined, "teammate", "collaborator", true, false), false);
  assert.equal(offersMemberAutoApprove(session, automatic, "owner", "collaborator", true, false), false, "the owner has their own Auto-approve");
  // Their messages never ask to merge without asking, so they never wait on the owner's merge confirmation either.
  assert.deepEqual(chatOptionsBody(automatic, auto, "submit", false), { access: "auto" });
  assert.deepEqual(chatOptionsBody(automatic, auto, "submit", true), { access: "auto", autoMerge: true });
  assert.equal(mustConfirmAutoApprove(chatOptionsBody(automatic, auto, "submit", false), false), false);
  // The menu and the confirmation say what it does there.
  assert.equal(accessHint("auto", false), memberAutoApproveHint);
  assert.equal(accessHint("auto", true), accessLabels.auto.hint);
  assert.equal(accessHint("approval", false), accessLabels.approval.hint);
  assert.match(memberAutoApproveWarning(automatic), /in the sandbox .* will run immediately on Bob's Pi, as the session's owner/);
  assert.match(memberAutoApproveWarning(automatic), /Pushes, GitHub comments, issues and merges, host commands, commands without resource limits, and tools the session doesn't allow yet still need approval/);
});
