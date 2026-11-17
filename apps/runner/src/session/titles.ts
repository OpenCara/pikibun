import type { Context, Models, Usage } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai/models";
import type { UsageState } from "@earendil-works/pi-durable";
import { sessionTitleLimits, type SessionTitleRequest } from "../../../../packages/shared/src/session-titles.js";

export type TitleModels = Pick<Models, "getModel" | "completeSimple">;
export const titleTimeoutMs = 25_000;

export interface TitleReply { text: string; usage?: { key: string; usage: Usage } }

export function titleRequestInput(value: unknown): SessionTitleRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== "system" && key !== "message")) return undefined;
  const { system, message } = input;
  if (typeof system !== "string" || !system.trim() || system.length > sessionTitleLimits.system
    || typeof message !== "string" || !message.trim() || message.length > sessionTitleLimits.message) return undefined;
  return { system, message };
}

export async function writeTitle(models: TitleModels, model: { provider: string; modelId: string }, request: SessionTitleRequest,
  signal: AbortSignal): Promise<TitleReply> {
  const found = models.getModel(model.provider, model.modelId);
  if (!found) return { text: "" };
  const level = clampThinkingLevel(found, "off");
  const context: Context = { systemPrompt: request.system, messages: [{ role: "user", content: request.message, timestamp: Date.now() }] };
  const reply = await models.completeSimple(found, context, { signal, timeoutMs: titleTimeoutMs, maxRetries: 0, cacheRetention: "none",
    disableContinuation: true, ...(level === "off" ? {} : { reasoning: level }) });
  const answered = reply.stopReason === "stop" || reply.stopReason === "length";
  const text = answered ? reply.content.flatMap(block => block.type === "text" ? [block.text] : []).join("").slice(0, sessionTitleLimits.reply) : "";
  return { text, ...(reply.usage ? { usage: { key: `${reply.provider}/${reply.model}`, usage: reply.usage } } : {}) };
}

export function addTitleUsage(totals: UsageState["models"], key: string, usage: Usage): void {
  const total = Object.hasOwn(totals, key) ? totals[key] as Usage : undefined;
  if (!total) {
    totals[key] = JSON.parse(JSON.stringify(usage)) as UsageState["models"][string];
    return;
  }
  for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) total[field] += usage[field];
  for (const field of ["cacheWrite1h", "reasoning"] as const) if (usage[field] !== undefined) total[field] = (total[field] ?? 0) + usage[field];
  for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) total.cost[field] += usage.cost[field];
}
