import assert from "node:assert/strict";
import test from "node:test";
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { Message } from "@earendil-works/pi-ai";
import { compactionEnabled, compactsAfterFailure, contextTokens, LARGE_CONTEXT_TOKENS, modelFailureCause } from "../apps/runner/src/model-failure.js";
import { entryView, failureView } from "../apps/runner/src/session/entries.js";
import type { Run } from "../apps/runner/src/session.js";
import { entryError, sharedView } from "../apps/server/src/session-links.js";
import type { EntryView, SessionView } from "../packages/shared/src/types.js";

test("only Pi's own fixed texts for a stream that ended early are recognized, never other provider text", () => {
  for (const detail of [
    "Anthropic stream ended without a stop reason",
    "Bedrock stream ended without a stop reason",
    "OpenAI Responses stream ended without a stop reason",
    "Google stream ended without a finish reason",
    "Stream ended without finish_reason",
    "opencode-go stream ended without a terminal event",
  ]) assert.equal(modelFailureCause(detail), "incomplete_stream", detail);
  for (const detail of [
    "Anthropic stream ended without a stop reason ",
    "Error: Anthropic stream ended without a stop reason",
    "529 overloaded_error: Anthropic stream ended without a stop reason",
    "https://gw.example/sk-1 stream ended without a terminal event",
    "An unknown error occurred", "", undefined, null, 5, { message: "Anthropic stream ended without a stop reason" },
  ]) assert.equal(modelFailureCause(detail), undefined, JSON.stringify(detail));
});

const usage = (input: number, cacheRead = 0, output = 0) => ({ input, output, cacheRead, cacheWrite: 0, totalTokens: input + cacheRead + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const assistant = (tokens: ReturnType<typeof usage>, stopReason = "stop", text = "ok") =>
  ({ role: "assistant", content: [{ type: "text", text }], api: "anthropic-messages", provider: "anthropic", model: "m", usage: tokens, stopReason, timestamp: 0 }) as Message;
const user = (text: string) => ({ role: "user", content: text, timestamp: 0 }) as Message;

test("a context counts what the provider counted for its last answer, and about 4 characters a token after it", () => {
  assert.equal(contextTokens([]), 0);
  assert.equal(contextTokens([user("x".repeat(400))]), 100, "no answer yet: characters alone");
  assert.equal(contextTokens([user("hi"), assistant(usage(1000, 149_000, 0)), user("y".repeat(4000))]), 151_000);
  assert.equal(contextTokens([user("hi"), assistant(usage(200_000)), user("again"), assistant(usage(0), "error", "")]), 200_002);
});

test("a dropped stream compacts only a large shared conversation whose host leaves compaction on", () => {
  const large = { cause: "incomplete_stream" as const, mode: "write" as const, tokens: LARGE_CONTEXT_TOKENS, enabled: true };
  assert.equal(compactsAfterFailure(large), true);
  assert.equal(compactsAfterFailure({ ...large, tokens: LARGE_CONTEXT_TOKENS - 1 }), false, "a small context more likely met a passing outage");
  assert.equal(compactsAfterFailure({ ...large, cause: undefined }), false, "any other failure");
  assert.equal(compactsAfterFailure({ ...large, mode: "ask" }), false, "a side question's own conversation");
  assert.equal(compactsAfterFailure({ ...large, enabled: false }), false);
  const model = { provider: "anthropic", modelId: "opus" };
  assert.equal(compactionEnabled(undefined, model), true, "Pi's default");
  assert.equal(compactionEnabled({ enabled: false } as never, model), false);
  assert.equal(compactionEnabled({ enabled: false, modelOverrides: { "anthropic/opus": { enabled: true } } } as never, model), true);
  assert.equal(compactionEnabled({ modelOverrides: { "anthropic/opus": { enabled: false } } } as never, model), false);
});

test("a failed attempt and a failed run say it was a dropped stream, and whether the host started compacting", () => {
  const failed = { ...assistant(usage(0), "error", ""), errorMessage: "Anthropic stream ended without a stop reason" };
  const entry = { id: "7", kind: "pi.assistant", model: [failed] } as unknown as EntryRecord;
  assert.deepEqual(entryView(entry, 3).error, { provider: "anthropic", modelId: "m", cause: "incomplete_stream" });
  const other = { id: "8", kind: "pi.assistant", model: [{ ...failed, errorMessage: "503 upstream sk-secret" }] } as unknown as EntryRecord;
  assert.deepEqual(entryView(other, 3).error, { provider: "anthropic", modelId: "m", status: 503 });
  const run = { key: "k", initiatedBy: "alice", failure: { reason: "model_error", provider: "anthropic", modelId: "m", cause: "incomplete_stream", compacting: true } } as Run;
  assert.deepEqual(failureView(run, 3).error, { provider: "anthropic", modelId: "m", cause: "incomplete_stream", compacting: true });
});

test("share links and other sessions' reads keep a known cause and drop anything else in its place", () => {
  assert.deepEqual(entryError({ provider: "anthropic", cause: "incomplete_stream", compacting: true }), { provider: "anthropic", cause: "incomplete_stream", compacting: true });
  assert.deepEqual(entryError({ provider: "anthropic", cause: "sk-secret", compacting: "yes" } as unknown as NonNullable<EntryView["error"]>), { provider: "anthropic" });
  const base = { sessionId: "s", owner: { id: "o", displayName: "Owner", gitName: "Owner", gitEmail: "o@example.test", githubLogin: null },
    approvals: [], busy: false, conversations: [{ id: "0", mode: "write" }] };
  const entries = [{ id: "0:1", kind: "workspace.run-failure", role: "assistant", text: "", conversationId: "0", error: { provider: "anthropic", cause: "incomplete_stream" } }];
  assert.deepEqual(sharedView({ ...base, entries } as unknown as SessionView).entries[0]?.error, { provider: "anthropic", cause: "incomplete_stream" });
});
