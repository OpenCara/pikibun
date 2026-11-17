import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { copyJson } from "@earendil-works/chord/json";
import {
  CACHE_WARMING_MAX_AGE_MS, CACHE_WARMING_MAX_IDLE_AGE_MS, evaluateCacheWarming, getCacheWarmingDelayMs, getCacheWarmingRequestOptions,
  getPromptCacheTtlMs, isCacheWarmingReplayable, type Api, type AssistantMessage, type CacheWarmingPhase, type Context, type Message, type Model, type Usage,
} from "@earendil-works/pi-ai";
import type { Models, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai/models";
import { GenerationTask, hook, LiveDoc, UsageDoc, type ConversationId, type Harness, type HookRegistration } from "@earendil-works/pi-durable";
import type { CacheWarmingMode } from "../../../../packages/shared/src/cache-warming.js";
import type { Metadata } from "./state.js";

export type ModelRequest = {
  readonly model: Model<Api>;
  readonly context: Context;
  readonly options: ModelsSimpleStreamOptions;
  readonly sentAt: number;
};

export interface WarmingClock {
  now(): number;
  setTimer(run: () => void, ms: number): () => void;
}

export const systemClock: WarmingClock = {
  now: () => Date.now(),
  setTimer: (run, ms) => {
    const timer = setTimeout(run, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};

const requestsByResponse = new WeakMap<AssistantMessage, ModelRequest>();

export function rememberRequests(models: Models, now: () => number = Date.now): Models {
  const streamSimple: Models["streamSimple"] = (model, request, options) => {
    const sentAt = now();
    const stream = models.streamSimple(model, request, options);
    void stream.result().then(response => {
      const { signal: _signal, telemetry: _telemetry, onPayload: _onPayload, ...replayOptions } = options ?? {};
      requestsByResponse.set(response, { model, context: { ...request, messages: [...request.messages] }, options: replayOptions, sentAt });
    }, () => {});
    return stream;
  };
  return new Proxy(models, {
    get: (target, key) => {
      if (key === "streamSimple") return streamSimple;
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function requestOf(response: AssistantMessage): ModelRequest | undefined {
  const request = requestsByResponse.get(response);
  requestsByResponse.delete(response);
  return request;
}

export interface WarmingSession {
  mode(): Promise<CacheWarmingMode>;
  phase(conversation: number, request: ModelRequest): Promise<CacheWarmingPhase | undefined>;
  record(conversation: number, refresh: AssistantMessage): Promise<void>;
  report(error: unknown): void;
}

type Warmer = {
  readonly conversation: number;
  readonly request: ModelRequest;
  readonly models: Models;
  readonly promptTokens: number;
  readonly ttlMs: number;
  readonly delayMs: number;
  readonly controller: AbortController;
  cancel?: () => void;
  cacheStartedAt: number;
  refreshDueAt: number;
};

const failed = (message: AssistantMessage) => message.stopReason === "error" || message.stopReason === "aborted";
const promptTokens = (usage: Usage) => usage.input + usage.cacheRead + usage.cacheWrite;

export class CacheWarmers {
  readonly #warmers = new Map<number, Warmer>();
  #closed = false;
  readonly #session: WarmingSession;
  readonly #clock: WarmingClock;

  constructor(session: WarmingSession, clock: WarmingClock = systemClock) {
    this.#session = session;
    this.#clock = clock;
  }

  get warming(): number[] { return [...this.#warmers.keys()]; }

  start(conversation: number, response: AssistantMessage, request: ModelRequest, models: Models): void {
    this.stop(conversation);
    if (this.#closed || failed(response) || !isCacheWarmingReplayable(request.model, request.options)) return;
    const ttlMs = getPromptCacheTtlMs(request.model, request.options);
    const delayMs = ttlMs === undefined ? undefined : getCacheWarmingDelayMs(ttlMs);
    if (ttlMs === undefined || delayMs === undefined) return;
    const warmer: Warmer = { conversation, request, models, promptTokens: promptTokens(response.usage), ttlMs, delayMs,
      controller: new AbortController(), cacheStartedAt: request.sentAt, refreshDueAt: 0 };
    this.#warmers.set(conversation, warmer);
    this.#schedule(warmer);
  }

  stop(conversation: number): void {
    const warmer = this.#warmers.get(conversation);
    if (!warmer) return;
    this.#warmers.delete(conversation);
    warmer.cancel?.();
    warmer.controller.abort();
  }

  close(): void {
    this.#closed = true;
    for (const conversation of [...this.#warmers.keys()]) this.stop(conversation);
  }

  hooks(): HookRegistration {
    return hook(GenerationTask, {
      beforeRequest: (_generation, api) => {
        this.stop(api.conversationId);
        return undefined;
      },
      afterResponse: (message, api) => {
        const request = requestOf(message);
        if (request) this.start(api.conversationId, message, request, api.models);
        else this.stop(api.conversationId);
      },
    });
  }

  #deadline(warmer: Warmer): number {
    return warmer.refreshDueAt + Math.floor((warmer.ttlMs - warmer.delayMs) / 2);
  }

  #schedule(warmer: Warmer): void {
    warmer.refreshDueAt = warmer.cacheStartedAt + warmer.delayMs;
    const now = this.#clock.now();
    if (warmer.refreshDueAt > warmer.request.sentAt + CACHE_WARMING_MAX_AGE_MS || now > this.#deadline(warmer)) {
      this.stop(warmer.conversation);
      return;
    }
    warmer.cancel = this.#clock.setTimer(() => void this.#refresh(warmer), Math.max(0, warmer.refreshDueAt - now));
  }

  async #refresh(warmer: Warmer): Promise<void> {
    warmer.cancel = undefined;
    const current = () => this.#warmers.get(warmer.conversation) === warmer;
    const stop = () => { if (current()) this.stop(warmer.conversation); };
    const deadline = this.#deadline(warmer);
    const late = () => this.#clock.now() > deadline;
    try {
      if (late()) return stop();
      const mode = await this.#session.mode();
      if (!current()) return;
      if (mode === "off") return stop();
      const phase = await this.#session.phase(warmer.conversation, warmer.request);
      if (!current()) return;
      const idleTooLong = this.#clock.now() > warmer.request.sentAt + CACHE_WARMING_MAX_IDLE_AGE_MS;
      if (!phase || (phase === "idle" && (mode === "streaming" || idleTooLong))
        || evaluateCacheWarming(warmer.request.model, warmer.promptTokens, phase).action !== "warm" || late()) return stop();
      const sentAt = this.#clock.now();
      const refresh = await warmer.models.completeSimple(warmer.request.model, { ...warmer.request.context, messages: [...warmer.request.context.messages] },
        getCacheWarmingRequestOptions(warmer.request.options, warmer.controller.signal));
      if (failed(refresh)) return stop();
      warmer.cacheStartedAt = sentAt;
      await this.#session.record(warmer.conversation, refresh);
    } catch (error) {
      if (!warmer.controller.signal.aborted) this.#session.report(error);
      return stop();
    }
    if (current()) this.#schedule(warmer);
  }
}

const sameMessage = (a: Message, b: Message | undefined) => a === b || JSON.stringify(a) === JSON.stringify(b);

export function startsWith(messages: readonly Message[], sent: readonly Message[]): boolean {
  return sent.length <= messages.length && sent.every((message, index) => sameMessage(message, messages[index]));
}

export function addUsage(totals: Record<string, Usage>, key: string, usage: Usage): void {
  const total = Object.hasOwn(totals, key) ? totals[key] : undefined;
  if (!total) {
    totals[key] = copyJson(usage, { omitUndefinedProperties: true }) as unknown as Usage;
    return;
  }
  for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) total[field] += usage[field];
  for (const field of ["cacheWrite1h", "reasoning"] as const) if (usage[field] !== undefined) total[field] = (total[field] ?? 0) + usage[field];
  for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) total.cost[field] += usage.cost[field];
}

export interface SessionWarmingSource {
  harness(): Harness | undefined;
  metadata(): Promise<Metadata>;
  mode(): Promise<CacheWarmingMode>;
  child: boolean;
  report(error: unknown): void;
}

export function sessionWarming(source: SessionWarmingSource): WarmingSession {
  return {
    mode: () => source.mode(),
    phase: async (id, request) => {
      const harness = source.harness();
      if (!harness) return undefined;
      const conversationId = id as ConversationId;
      const live = await harness.snapshot(LiveDoc, conversationId, context);
      if (live?.generation) return undefined;
      const conversation = await harness.conversation(conversationId, context);
      if (!conversation) return undefined;
      const agent = await conversation.agent(context);
      const level = agent.thinkingLevel === "off" ? undefined : agent.thinkingLevel;
      if (agent.model?.provider !== request.model.provider || agent.model.modelId !== request.model.id || level !== request.options.reasoning) return undefined;
      if (!startsWith((await conversation.context(context)).messages, request.context.messages)) return undefined;
      if (live?.run) return "streaming";
      if (source.child) return undefined;
      const branch = (await source.metadata()).branches.find(item => item.id === id);
      return branch?.mode === "write" && !branch.superseded ? "idle" : undefined;
    },
    record: async (id, refresh) => {
      const conversation = await source.harness()?.conversation(id as ConversationId, context);
      await conversation?.commit(async tx => {
        addUsage((await tx.doc(UsageDoc, conversation.id)).models as Record<string, Usage>, `${refresh.provider}/${refresh.model}`, refresh.usage);
      }, context);
    },
    report: error => source.report(error),
  };
}
