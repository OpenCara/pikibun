import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { cleanupSessionResources } from "@earendil-works/pi-ai/session-resources";
import { CompactionTask, GenerationTask, hook, LiveDoc, ProviderDoc, type ConversationId, type Harness, type HookRegistration } from "@earendil-works/pi-durable";
import { systemClock, type WarmingClock } from "./cache-warming.js";

export const PROVIDER_RELEASE_IDLE_MS = 15 * 60_000;

export interface ReleaseSession {
  busy(conversation: number): Promise<boolean>;
  warming(conversation: number): boolean;
  providerSessionId(conversation: number): Promise<string | undefined>;
  report(error: unknown): void;
}

type Pending = { cancel: () => void };

export class ProviderReleases {
  readonly #pending = new Map<number, Pending>();
  #closed = false;
  readonly #session: ReleaseSession;
  readonly #clock: WarmingClock;
  readonly #delayMs: number;

  constructor(session: ReleaseSession, clock: WarmingClock = systemClock, delayMs: number = PROVIDER_RELEASE_IDLE_MS) {
    this.#session = session;
    this.#clock = clock;
    this.#delayMs = delayMs;
  }

  get pending(): number[] { return [...this.#pending.keys()]; }

  touch(conversation: number): void {
    if (this.#closed) return;
    this.#pending.get(conversation)?.cancel();
    const pending: Pending = { cancel: () => {} };
    this.#pending.set(conversation, pending);
    pending.cancel = this.#clock.setTimer(() => void this.#release(conversation, pending), this.#delayMs);
  }

  close(): void {
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.cancel();
    this.#pending.clear();
  }

  hooks(): HookRegistration[] {
    return [
      hook(GenerationTask, {
        beforeRequest: (_generation, api) => {
          this.touch(api.conversationId);
          return undefined;
        },
        afterResponse: (_message, api) => { this.touch(api.conversationId); },
      }),
      hook(CompactionTask, {
        beforeCompact: (_compaction, api) => {
          this.touch(api.conversationId);
          return undefined;
        },
      }),
    ];
  }

  async #release(conversation: number, pending: Pending): Promise<void> {
    const current = () => !this.#closed && this.#pending.get(conversation) === pending;
    try {
      if (!current()) return;
      const busy = this.#session.warming(conversation) || await this.#session.busy(conversation);
      const sessionId = busy ? undefined : await this.#session.providerSessionId(conversation);
      if (!current()) return;
      if (busy || this.#session.warming(conversation)) return this.touch(conversation);
      if (sessionId !== undefined) cleanupSessionResources(sessionId);
      this.#pending.delete(conversation);
    } catch (error) {
      if (!current()) return;
      this.#pending.delete(conversation);
      this.#session.report(error);
    }
  }
}

export interface ReleaseSource {
  harness(): Harness | undefined;
  warming(conversation: number): boolean;
  report(error: unknown): void;
}

export function sessionReleases(source: ReleaseSource): ReleaseSession {
  return {
    busy: async id => {
      const live = await source.harness()?.snapshot(LiveDoc, id as ConversationId, context);
      return live?.run !== undefined || live?.generation !== undefined || (live?.compactions?.length ?? 0) > 0;
    },
    warming: id => source.warming(id),
    providerSessionId: async id => (await source.harness()?.snapshot(ProviderDoc, id as ConversationId, context))?.sessionId,
    report: error => source.report(error),
  };
}
