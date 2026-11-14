import test from "node:test";
import assert from "node:assert/strict";
import type { ConnectorInfo } from "../packages/shared/src/connector.js";
import type { SessionView } from "../packages/shared/src/types.js";
import {
  autoChatOptionsBody, chatOptionsBody, chatPreference, initialSelection, modelUnavailable, parseChatPreference, preferredSelection, type ChatSelection,
} from "../packages/client/src/chat-options.js";

const host = { capabilities: { chatOptions: true }, models: [] } as unknown as ConnectorInfo;
const auto: ChatSelection = { access: "auto" };

test("a message acts or, with Read only, only reads: Read only goes with it", () => {
  assert.deepEqual(chatOptionsBody(host, auto, "submit"), {}, "a message that acts names no access");
  assert.deepEqual(chatOptionsBody(host, { access: "read" }, "submit"), { access: "read" });
  assert.deepEqual(chatOptionsBody(host, { access: "read" }, "ask"), {}, "a side ask is read-only anyway");
  assert.equal(chatOptionsBody(undefined, auto, "submit"), undefined);
});

test("a message sent with Auto names neither model nor reasoning, only Read only where it was chosen", () => {
  const picked: ChatSelection = { model: { provider: "p", modelId: "fast" }, thinkingLevel: "high", access: "read" };
  assert.deepEqual(autoChatOptionsBody(host, picked, "submit"), { auto: true, access: "read" });
  assert.deepEqual(autoChatOptionsBody(host, picked, "ask"), { auto: true });
  assert.equal(autoChatOptionsBody({ ...host, capabilities: {} } as ConnectorInfo, picked, "submit"), undefined);
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

