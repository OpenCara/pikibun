import assert from "node:assert/strict";
import test from "node:test";
import { compactionFailure, compactionThreshold, configuredCompaction, hostCompaction, reasoningReserveTokens } from "../apps/runner/src/compaction.js";
import { contextTokens } from "../apps/runner/src/model-failure.js";
import { sharedView } from "../apps/server/src/session-links.js";
import { compactionFailureText } from "../packages/client/src/compaction.js";
import type { SessionView } from "../packages/shared/src/types.js";

test("only Pi's own fixed compaction failures are recognized, never text that embeds a provider's error", () => {
  assert.equal(compactionFailure("Compaction failed: Summarization hit the token limit; the summary is incomplete"), "token_limit");
  assert.equal(compactionFailure("Compaction failed: Summarization attempted to call a tool"), "tool_call");
  assert.equal(compactionFailure("Compaction failed: Summarization produced no text"), "no_text");
  assert.equal(compactionFailure("Compaction was aborted"), "aborted");
  for (const detail of [
    "Compaction failed: Summarization failed: 401 invalid x-api-key sk-provider-detail",
    "Compaction failed: Summarization failed: aborted",
    "Compaction failed: orphaned",
    "Compaction failed: Summarization hit the token limit; the summary is incomplete ",
    "The request failed", undefined, null, 5, { message: "Compaction was aborted" },
  ]) assert.equal(compactionFailure(detail), undefined, JSON.stringify(detail));
});

test("a compaction failure says what happened and that retrying as before won't help", () => {
  const text = compactionFailureText("token_limit");
  assert.match(text, /token limit/);
  assert.match(text, /lower reasoning level/);
  assert.match(text, /new session/);
  assert.match(text, /reserveTokens/);
  assert.match(text, /Settings → Hosts → the host → Compaction/);
  assert.doesNotMatch(compactionFailureText("token_limit", { advice: false }), /reasoning level/);
});

test("a share link keeps a known compaction failure and drops anything else in its place", () => {
  const base = { sessionId: "s", owner: { id: "o", displayName: "Owner", gitName: "Owner", gitEmail: "o@example.test", githubLogin: null },
    approvals: [], busy: false, conversations: [{ id: "0", mode: "write" }] };
  const entries = [
    { id: "0:1", kind: "workspace.run-failure", role: "assistant", text: "", conversationId: "0", error: { provider: "anthropic", modelId: "m", compaction: "token_limit" } },
    { id: "0:2", kind: "workspace.run-failure", role: "assistant", text: "", conversationId: "0", error: { provider: "anthropic", compaction: "sk-secret" } },
  ];
  assert.deepEqual(sharedView({ ...base, entries } as unknown as SessionView).entries.map(entry => entry.error), [
    { provider: "anthropic", modelId: "m", compaction: "token_limit" },
    { provider: "anthropic" },
  ]);
});

test("a reasoning model keeps a tenth of its window for compaction, between Pi's 16K and 64K", () => {
  assert.equal(reasoningReserveTokens({ reasoning: true, contextWindow: 1_000_000 }), 65_536);
  assert.equal(reasoningReserveTokens({ reasoning: true, contextWindow: 400_000 }), 40_000);
  assert.equal(reasoningReserveTokens({ reasoning: true, contextWindow: 200_000 }), 20_000);
  assert.equal(reasoningReserveTokens({ reasoning: true, contextWindow: 128_000 }), undefined, "Pi's own default is already more");
  assert.equal(reasoningReserveTokens({ reasoning: false, contextWindow: 1_000_000 }), undefined);
  assert.equal(reasoningReserveTokens({ reasoning: true, contextWindow: 0 }), undefined);
});

test("the host's own compaction settings win over the reasoning default", () => {
  const models = [
    { provider: "anthropic", id: "opus", reasoning: true, contextWindow: 1_000_000 },
    { provider: "anthropic", id: "sonnet", reasoning: true, contextWindow: 200_000 },
    { provider: "openai", id: "plain", reasoning: false, contextWindow: 1_000_000 },
  ];
  assert.deepEqual(hostCompaction(undefined, models), { modelOverrides: { "anthropic/opus": { reserveTokens: 65_536 }, "anthropic/sonnet": { reserveTokens: 20_000 } } });
  assert.equal(hostCompaction(undefined, [models[2]!]), undefined, "nothing to change for a host without reasoning models");
  const overall = { reserveTokens: 16_384 };
  assert.equal(hostCompaction(overall, models), overall);
  assert.deepEqual(hostCompaction({ enabled: true, modelOverrides: { "anthropic/opus": { reserveTokens: 16_384 }, "anthropic/sonnet": { keepRecentTokens: 1000 } } }, models), {
    enabled: true,
    modelOverrides: { "anthropic/opus": { reserveTokens: 16_384 }, "anthropic/sonnet": { reserveTokens: 20_000, keepRecentTokens: 1000 } },
  });
});

test("the panel's context compacts where Pi does: the window less the reserve the model keeps", () => {
  const sonnet = { provider: "anthropic", modelId: "sonnet" };
  assert.equal(compactionThreshold(undefined, sonnet, 200_000), 200_000 - 16_384, "Pi's own reserve");
  assert.equal(compactionThreshold({ reserveTokens: 32_768 }, sonnet, 200_000), 200_000 - 32_768);
  // A model's own override wins over the harness-wide reserve, as in Pi; the reasoning default is one.
  const models = [{ provider: "anthropic", id: "sonnet", reasoning: true, contextWindow: 200_000 }];
  assert.equal(compactionThreshold(hostCompaction({ keepRecentTokens: 4000 }, models), sonnet, 200_000), 180_000);
  assert.equal(compactionThreshold({ reserveTokens: 32_768, modelOverrides: { "anthropic/sonnet": { reserveTokens: 50_000 } } }, sonnet, 200_000), 150_000);
  // Off for every model, or for this one, it never compacts on its own; a model's own setting wins either way.
  assert.equal(compactionThreshold({ enabled: false }, sonnet, 200_000), undefined);
  assert.equal(compactionThreshold({ modelOverrides: { "anthropic/sonnet": { enabled: false } } }, sonnet, 200_000), undefined);
  assert.equal(compactionThreshold({ enabled: false, modelOverrides: { "anthropic/sonnet": { enabled: true } } }, sonnet, 200_000), 200_000 - 16_384);
  // Without a window there is nothing to tell, and a reserve larger than the window compacts at once.
  assert.equal(compactionThreshold(undefined, sonnet, undefined), undefined);
  assert.equal(compactionThreshold(undefined, sonnet, 0), undefined);
  assert.equal(compactionThreshold(undefined, sonnet, 8192), 0);
});

test("a context's tokens are the provider's last count, and about 4 characters a token since", () => {
  const usage = (input: number, output: number) => ({ input, output, cacheRead: 1000, cacheWrite: 0, totalTokens: input + output + 1000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
  const messages = [
    { role: "user", content: "x".repeat(400), timestamp: 0 },
    { role: "assistant", content: [{ type: "text", text: "ok" }], usage: usage(5000, 200), stopReason: "stop", timestamp: 0 },
    { role: "user", content: "y".repeat(400), timestamp: 0 },
  ];
  assert.equal(contextTokens(messages as never), 5000 + 1000 + 200 + 100);
  assert.equal(contextTokens([messages[0]] as never), 100, "no answered request: characters alone");
});

test("a share link leaves out the session's context", () => {
  const view = { sessionId: "s", owner: { id: "o", displayName: "Owner", gitName: "Owner", gitEmail: "o@example.test", githubLogin: null },
    approvals: [], busy: false, conversations: [{ id: "0", mode: "write" }], entries: [], context: { tokens: 84_210, window: 200_000, compactsAt: 183_616 } };
  assert.equal("context" in sharedView(view as unknown as SessionView), false);
});

test("token counts set in Pikibun replace the host's Pi settings, count by count and model by model", () => {
  const pi = { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000, modelOverrides: { "anthropic/opus": { reserveTokens: 40_000, keepRecentTokens: 5000 } } };
  assert.equal(configuredCompaction(pi, undefined), pi, "nothing set in Pikibun keeps the host's settings");
  assert.equal(configuredCompaction(pi, {}), pi);
  assert.equal(configuredCompaction(undefined, {}), undefined);
  assert.deepEqual(configuredCompaction(pi, { reserveTokens: 32_768, modelOverrides: { "anthropic/opus": { reserveTokens: 65_536 }, "openai/gpt-5": { keepRecentTokens: 1000 } } }), {
    enabled: true, reserveTokens: 32_768, keepRecentTokens: 20_000,
    modelOverrides: { "anthropic/opus": { reserveTokens: 65_536, keepRecentTokens: 5000 }, "openai/gpt-5": { keepRecentTokens: 1000 } },
  });
  assert.deepEqual(configuredCompaction(undefined, { keepRecentTokens: 0 }), { keepRecentTokens: 0 });
  const models = [{ provider: "anthropic", id: "sonnet", reasoning: true, contextWindow: 200_000 }];
  assert.deepEqual(hostCompaction(configuredCompaction(undefined, { reserveTokens: 16_384 }), models), { reserveTokens: 16_384 });
  assert.deepEqual(hostCompaction(configuredCompaction(undefined, { modelOverrides: { "anthropic/sonnet": { reserveTokens: 50_000 } } }), models),
    { modelOverrides: { "anthropic/sonnet": { reserveTokens: 50_000 } } });
  assert.deepEqual(hostCompaction(configuredCompaction(undefined, { keepRecentTokens: 4000 }), models),
    { keepRecentTokens: 4000, modelOverrides: { "anthropic/sonnet": { reserveTokens: 20_000 } } });
});
