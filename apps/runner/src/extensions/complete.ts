import type { Api, Model, TextContent, Usage } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { CompleteAnswer, CompleteRequest } from "./protocol.js";

export const completeLimits = Object.freeze({ timeoutMs: 60_000, maxTokens: 4096, atOnce: 4, perHour: 120, messages: 32, parts: 32, text: 256 * 1024, systemPrompt: 64 * 1024, answerText: 256 * 1024,
  requestBytes: 20 * 1024 * 1024 });

export const modelCallSources: ReadonlySet<string> = new Set(["piki:prompt-audit"]);

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const word = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256;

export function completeRequestOf(value: unknown): CompleteRequest | undefined {
  if (!isObject(value) || typeof value.source !== "string" || value.source.length > 1024 || !Array.isArray(value.messages)) return undefined;
  if (!value.messages.length || value.messages.length > completeLimits.messages) return undefined;
  if (value.systemPrompt !== undefined && (typeof value.systemPrompt !== "string" || value.systemPrompt.length > completeLimits.systemPrompt)) return undefined;
  if (value.maxTokens !== undefined && (!Number.isSafeInteger(value.maxTokens) || (value.maxTokens as number) < 1)) return undefined;
  let model: CompleteRequest["model"];
  if (value.model !== undefined) {
    if (!isObject(value.model) || !word(value.model.provider) || !word(value.model.id)) return undefined;
    model = { provider: value.model.provider, id: value.model.id };
  }
  const messages: CompleteRequest["messages"] = [];
  let size = typeof value.systemPrompt === "string" ? value.systemPrompt.length : 0;
  for (const message of value.messages) {
    if (!isObject(message) || message.role !== "user" || !Array.isArray(message.content) || message.content.length > completeLimits.parts) return undefined;
    const content: CompleteRequest["messages"][number]["content"] = [];
    for (const part of message.content) {
      if (isObject(part) && part.type === "text" && typeof part.text === "string" && part.text.length <= completeLimits.text) {
        content.push({ type: "text", text: part.text });
        size += part.text.length;
      } else if (isObject(part) && part.type === "image" && typeof part.data === "string" && part.data.length <= 16 * 1024 * 1024
        && typeof part.mimeType === "string" && /^image\/[a-z0-9.+-]{1,64}$/.test(part.mimeType)) {
        content.push({ type: "image", data: part.data, mimeType: part.mimeType });
        size += part.data.length;
      } else return undefined;
      if (size > completeLimits.requestBytes) return undefined;
    }
    messages.push({ role: "user", content, ...(typeof message.timestamp === "number" && Number.isFinite(message.timestamp) ? { timestamp: message.timestamp } : {}) });
  }
  return { source: value.source, ...(model ? { model } : {}), ...(value.systemPrompt !== undefined ? { systemPrompt: value.systemPrompt as string } : {}), messages,
    ...(value.maxTokens !== undefined ? { maxTokens: value.maxTokens as number } : {}) };
}

export function completeAnswerOf(value: unknown): CompleteAnswer | undefined {
  if (!isObject(value) || typeof value.stopReason !== "string" || !Array.isArray(value.content)) return undefined;
  if (value.errorMessage !== undefined && typeof value.errorMessage !== "string") return undefined;
  const content = value.content.filter((part): part is TextContent => isObject(part) && part.type === "text" && typeof part.text === "string")
    .map(part => ({ type: "text" as const, text: part.text }));
  return { content, stopReason: value.stopReason, ...(value.errorMessage !== undefined ? { errorMessage: value.errorMessage as string } : {}) };
}

export interface CompletionSource {
  modelRegistry?: ModelRegistry;
  model(): Model<string> | undefined;
}

export interface ModelCallRecord { model: string; stopReason: string; usage?: Usage }

const HOUR_MS = 60 * 60 * 1000;

export class ModelCallBudget {
  readonly #calls = new Map<string, number[]>();

  constructor(private readonly perHour: number = completeLimits.perHour, private readonly now: () => number = Date.now) {}

  take(source: string): boolean {
    const since = this.now() - HOUR_MS;
    const calls = (this.#calls.get(source) ?? []).filter(at => at > since);
    const taken = calls.length < this.perHour;
    if (taken) calls.push(this.now());
    this.#calls.set(source, calls);
    return taken;
  }

  count(source: string): number {
    const since = this.now() - HOUR_MS;
    return (this.#calls.get(source) ?? []).filter(at => at > since).length;
  }
}

export async function completeWith(host: CompletionSource, request: CompleteRequest, signal: AbortSignal, record?: (call: ModelCallRecord) => void | Promise<void>): Promise<CompleteAnswer> {
  const registry = host.modelRegistry;
  if (!registry) throw new Error("This host has no models an extension may call");
  const model = (request.model ? registry.find(request.model.provider, request.model.id) : host.model()) as Model<Api> | undefined;
  if (!model) throw new Error(request.model ? `This host has no model ${request.model.provider}/${request.model.id}` : "The session has no model to call");
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(completeLimits.timeoutMs)]);
  const reply = await registry.streamSimple(model, {
    ...(request.systemPrompt !== undefined ? { systemPrompt: request.systemPrompt } : {}),
    messages: request.messages.map(message => ({ role: "user" as const, content: message.content, timestamp: message.timestamp ?? Date.now() })),
  }, { signal: deadline, maxTokens: Math.min(request.maxTokens ?? completeLimits.maxTokens, completeLimits.maxTokens) }).result();
  await record?.({ model: `${reply.provider ?? model.provider}/${reply.model ?? model.id}`, stopReason: reply.stopReason, ...(reply.usage ? { usage: reply.usage } : {}) });
  let left = completeLimits.answerText;
  const content = reply.content.flatMap(part => {
    if (part.type !== "text" || left <= 0) return [];
    const text = part.text.slice(0, left);
    left -= text.length;
    return [{ type: "text" as const, text }];
  });
  return { content, stopReason: reply.stopReason, ...(reply.errorMessage ? { errorMessage: reply.errorMessage.slice(0, 2000) } : {}) };
}
