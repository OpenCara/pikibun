import type { CompactionSettings } from "@earendil-works/pi-durable";
import type { Message } from "@earendil-works/pi-ai";
import type { ModelFailureCause } from "../../../packages/shared/src/types.js";

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
const PI_MESSAGES_INCOMPLETE = /^[A-Za-z0-9._-]{1,128} stream ended without a terminal event$/;

export function modelFailureCause(detail: unknown): ModelFailureCause | undefined {
  if (typeof detail !== "string") return undefined;
  return incompleteStreams.has(detail) || PI_MESSAGES_INCOMPLETE.test(detail) ? "incomplete_stream" : undefined;
}

export const LARGE_CONTEXT_TOKENS = 128_000;

const CHARS_PER_TOKEN = 4;

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

export function compactionEnabled(settings: CompactionSettings | undefined, model: { provider: string; modelId: string } | undefined): boolean {
  const override = model ? settings?.modelOverrides?.[`${model.provider}/${model.modelId}`]?.enabled : undefined;
  return (override ?? settings?.enabled) !== false;
}

export function compactsAfterFailure(input: { cause: ModelFailureCause | undefined; mode: "write" | "ask"; tokens: number; enabled: boolean }): boolean {
  return input.cause === "incomplete_stream" && input.mode === "write" && input.enabled && input.tokens >= LARGE_CONTEXT_TOKENS;
}
