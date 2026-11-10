import test from "node:test";
import assert from "node:assert/strict";
import type { ConnectorInfo } from "../packages/shared/src/connector.js";
import type { SessionView } from "../packages/shared/src/types.js";
import {
  accessLabels, accessUnavailable, chatAccessModes, chatOptionsBody, chatPreference, initialSelection, modelUnavailable, parseChatPreference, preferredSelection, type ChatSelection,
} from "../packages/client/src/chat-options.js";

const host = { capabilities: { chatOptions: true }, models: [] } as unknown as ConnectorInfo;
const auto: ChatSelection = { access: "auto" };

test("a message acts or, with Read only, only reads: Read only goes with it, or the message waits until it can", () => {
  assert.deepEqual(chatOptionsBody(host, auto, "submit"), {}, "a message that acts names no access");
  assert.deepEqual(chatOptionsBody(host, { access: "read" }, "submit"), { access: "read" });
  assert.deepEqual(chatOptionsBody(host, { access: "read" }, "ask"), {}, "a side ask is read-only anyway");
  assert.equal(chatOptionsBody(undefined, auto, "submit"), undefined);
  assert.equal(accessUnavailable(host, auto, "submit"), undefined);
  assert.equal(accessUnavailable(undefined, auto, "submit"), undefined, "a message that acts goes before its host loads");
  assert.match(accessUnavailable(undefined, { access: "read" }, "submit") ?? "", /Read only/);
  assert.equal(accessUnavailable(undefined, { access: "read" }, "ask"), undefined);
  assert.deepEqual(chatAccessModes, ["read", "auto"], "nobody approves anything: there is no third choice");
  assert.equal(accessLabels.approval.label, accessLabels.auto.label, "the access of before approvals were removed acts too");
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

test("the chat box starts on a message that acts, for everyone, whatever the session's last message was", () => {
  const view = (access?: SessionView["access"]) => ({ entries: [{ id: "1", kind: "message", role: "user", text: "Hi" }], ...(access ? { access } : {}) }) as SessionView;
  for (const access of [undefined, "approval", "auto", "read"] as const) assert.equal(initialSelection(view(access)).access, "auto", String(access));
});

