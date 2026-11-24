import { setTimeout as delay } from "node:timers/promises";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { LocalModels } from "../../apps/runner/src/local-pi.js";

export interface Turn { prompt: string; results: string[]; system: string; tools: string[] }
export type Step = { tool: string; args: Record<string, unknown> } | { text: string; holdMs?: number };
export type Script = (turn: Turn) => Step;

const textOf = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.flatMap(part => part && typeof part === "object" && (part as { type?: unknown }).type === "text" ? [String((part as { text?: unknown }).text ?? "")] : []).join("\n") : "";

export function scriptedModels(script: Script, modelId = "scripted"): LocalModels & { turns: Turn[] } {
  const faux = fauxProvider({ models: [{ id: modelId, name: "Scripted test provider (not an LLM)" }] });
  const turns: Turn[] = [];
  const respond: FauxResponseFactory = async context => {
    faux.appendResponses([respond]);
    const messages = context.messages as unknown as { role: string; content?: unknown; sections?: Record<string, string>; toolsAdded?: { name: string }[]; toolsRemoved?: { name: string }[] }[];
    const last = messages.findLastIndex(message => message.role === "user");
    const tools = new Set<string>();
    for (const message of messages) {
      if (message.role !== "system") continue;
      for (const removed of message.toolsRemoved ?? []) tools.delete(removed.name);
      for (const added of message.toolsAdded ?? []) tools.add(added.name);
    }
    const turn: Turn = {
      prompt: last < 0 ? "" : textOf(messages[last]!.content),
      results: messages.slice(last + 1).filter(message => message.role === "toolResult").map(message => textOf(message.content)),
      system: messages.filter(message => message.role === "system").map(message => [textOf(message.content), ...Object.values(message.sections ?? {})].join("\n")).join("\n"),
      tools: [...tools],
    };
    turns.push(turn);
    const step = script(turn);
    if ("tool" in step) return fauxAssistantMessage(fauxToolCall(step.tool, step.args as Parameters<typeof fauxToolCall>[1]), { stopReason: "toolUse" });
    if (step.holdMs) await delay(step.holdMs);
    return fauxAssistantMessage(step.text);
  };
  faux.setResponses([respond]);
  const models = createModels();
  models.setProvider(faux.provider);
  return {
    turns,
    async manifest() { return [{ provider: "faux", modelId, name: "Scripted test provider (not an LLM)", thinkingLevels: ["off"] }]; },
    async resolve(model) {
      if (model.provider !== "faux" || model.modelId !== modelId) throw new Error("Requested scripted model is unavailable");
      return { models, provider: "faux", modelId };
    },
  };
}
