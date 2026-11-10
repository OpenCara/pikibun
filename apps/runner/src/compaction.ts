import type { CompactionSettings } from "@earendil-works/pi-durable";
import type { CompactionFailure } from "../../../packages/shared/src/types.js";
import type { HostCompaction } from "../../../packages/shared/src/host-config.js";

const compactionFailures: ReadonlyMap<string, CompactionFailure> = new Map([
  ["Compaction failed: Summarization hit the token limit; the summary is incomplete", "token_limit"],
  ["Compaction failed: Summarization attempted to call a tool", "tool_call"],
  ["Compaction failed: Summarization produced no text", "no_text"],
  ["Compaction was aborted", "aborted"],
]);

export function compactionFailure(detail: unknown): CompactionFailure | undefined {
  return typeof detail === "string" ? compactionFailures.get(detail) : undefined;
}

export const PI_RESERVE_TOKENS = 16_384;
export const REASONING_RESERVE_TOKENS = 65_536;

export function reasoningReserveTokens(model: { reasoning?: boolean; contextWindow?: number }): number | undefined {
  if (!model.reasoning || !Number.isSafeInteger(model.contextWindow) || model.contextWindow! <= 0) return undefined;
  const reserve = Math.min(REASONING_RESERVE_TOKENS, Math.floor(model.contextWindow! / 10));
  return reserve > PI_RESERVE_TOKENS ? reserve : undefined;
}

export function hostCompaction(host: CompactionSettings | undefined, models: Iterable<{ provider: string; id: string; reasoning?: boolean; contextWindow?: number }>): CompactionSettings | undefined {
  if (host?.reserveTokens !== undefined) return host;
  const overrides: Record<string, Partial<Omit<CompactionSettings, "modelOverrides">>> = {};
  for (const model of models) {
    const key = `${model.provider}/${model.id}`;
    const reserveTokens = reasoningReserveTokens(model);
    if (reserveTokens !== undefined && host?.modelOverrides?.[key]?.reserveTokens === undefined) overrides[key] = { reserveTokens };
  }
  if (!Object.keys(overrides).length) return host;
  const modelOverrides: Record<string, Partial<Omit<CompactionSettings, "modelOverrides">>> = { ...overrides };
  for (const [key, override] of Object.entries(host?.modelOverrides ?? {})) modelOverrides[key] = { ...overrides[key], ...override };
  return { ...host, modelOverrides };
}

export function configuredCompaction(pi: CompactionSettings | undefined, configured: HostCompaction | undefined): CompactionSettings | undefined {
  if (!configured || (configured.reserveTokens === undefined && configured.keepRecentTokens === undefined && !configured.modelOverrides)) return pi;
  const { modelOverrides: overrides, ...overall } = configured;
  const merged: Record<string, Partial<Omit<CompactionSettings, "modelOverrides">>> = { ...pi?.modelOverrides };
  for (const [model, tokens] of Object.entries(overrides ?? {})) merged[model] = { ...merged[model], ...tokens };
  return { ...pi, ...overall, ...(Object.keys(merged).length ? { modelOverrides: merged } : {}) };
}
