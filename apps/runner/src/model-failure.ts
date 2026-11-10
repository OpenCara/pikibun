import type { CompactionSettings } from "@earendil-works/pi-durable";
import type { Message } from "@earendil-works/pi-ai";
import type { ModelFailureCause } from "../../../packages/shared/src/types.js";

/**
 * Pi's own fixed text (pi-ai's provider streams) for a response stream that closed before it said why it ended: no stop
 * or finish reason, no error event. A gateway or proxy between the host and the provider that drops the stream, a large
 * request's most of all, ends a request this way, and Pi has retried it by the time a run fails with it. Only these exact
 * texts are recognized, as with compaction failures (compaction.ts): any other model error's text stays on the host.
 */
const incompleteStreams: ReadonlySet<string> = new Set([
  "Anthropic stream ended without a stop reason",
  "Azure OpenAI Responses stream ended without a stop reason",
  "Bedrock stream ended without a stop reason",
  "Codex stream ended without a stop reason",
  "OpenAI Responses stream ended without a stop reason",
  "Google stream ended without a finish reason",
  "Google Vertex stream ended without a finish reason",
  "Mistral stream ended without a finish reason",
  "Stream ended without finish_reason",
]);
/** pi-ai's Pi Messages API names the provider: `${model.provider} stream ended without a terminal event`. */
const PI_MESSAGES_INCOMPLETE = /^[A-Za-z0-9._-]{1,128} stream ended without a terminal event$/;

/** Which fixed cause a failed model request's text reports, if it is exactly one of Pi's own. */
export function modelFailureCause(detail: unknown): ModelFailureCause | undefined {
  if (typeof detail !== "string") return undefined;
  return incompleteStreams.has(detail) || PI_MESSAGES_INCOMPLETE.test(detail) ? "incomplete_stream" : undefined;
}

/**
 * How large a conversation's context is when a dropped stream should compact it (see compactsAfterFailure). Under this,
 * a run whose every attempt the stream dropped more likely met a passing gateway or network failure, which a smaller
 * context wouldn't help and a summary would cost the conversation's detail for nothing.
 */
export const LARGE_CONTEXT_TOKENS = 128_000;

/** Pi's rough count for text it has no usage for: about 4 characters a token. */
const CHARS_PER_TOKEN = 4;

/**
 * About how many tokens a conversation's model context holds: what the provider counted for the last request it answered
 * (its input, cached or not, and its answer), and about 4 characters a token for everything after it. A context with no
 * answered request is counted by characters alone.
 */
export function contextTokens(messages: readonly Message[]): number {
  let tokens = 0;
  let from = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") continue;
    const usage = message.usage;
    const counted = usage ? usage.input + usage.cacheRead + usage.cacheWrite + usage.output : 0;
    if (Number.isFinite(counted) && counted > 0) { tokens = counted; from = index + 1; break; }
  }
  let chars = 0;
  for (const message of messages.slice(from)) chars += messageChars(message);
  return tokens + Math.ceil(chars / CHARS_PER_TOKEN);
}

function messageChars(message: Message): number {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content as { type?: string; text?: string; thinking?: string; arguments?: unknown }[]) {
    if (block.type === "text" && typeof block.text === "string") chars += block.text.length;
    else if (block.type === "thinking" && typeof block.thinking === "string") chars += block.thinking.length;
    else if (block.type === "toolCall") chars += JSON.stringify(block.arguments ?? {}).length;
  }
  return chars;
}

/** Whether the host's compaction settings leave compaction on for this model (Pi's default: on). */
export function compactionEnabled(settings: CompactionSettings | undefined, model: { provider: string; modelId: string } | undefined): boolean {
  const override = model ? settings?.modelOverrides?.[`${model.provider}/${model.modelId}`]?.enabled : undefined;
  return (override ?? settings?.enabled) !== false;
}

/**
 * Whether a failed run should start compacting its conversation, so the next message sends less. Pi compacts on its own
 * only at its threshold, near the model's context window, or when the provider says the context is too long; a stream a
 * gateway drops on a large request is neither, so every later message would send the same request and fail the same way.
 * So the run's shared conversation compacts when its last attempt's stream dropped (`incomplete_stream`, after Pi's own
 * retries), its context is large, and the host leaves compaction on.
 */
export function compactsAfterFailure(input: { cause: ModelFailureCause | undefined; mode: "write" | "ask"; tokens: number; enabled: boolean }): boolean {
  return input.cause === "incomplete_stream" && input.mode === "write" && input.enabled && input.tokens >= LARGE_CONTEXT_TOKENS;
}
