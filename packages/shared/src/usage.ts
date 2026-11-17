import type { PromptTokens } from "./types.js";

export function cacheHitRate(tokens: PromptTokens | undefined): number | undefined {
  if (!tokens) return undefined;
  const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  return Number.isFinite(prompt) && prompt > 0 && Number.isFinite(tokens.cacheRead) ? tokens.cacheRead / prompt : undefined;
}
