import assert from "node:assert/strict";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Api, AssistantMessage, AssistantMessageEventStream, CacheWarmingPhase, Context, Model, Usage } from "@earendil-works/pi-ai";
import { createModels, type Models, type ModelsSimpleStreamOptions } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, Harness, MemoryStorage, UsageDoc, type GenerationHooks } from "@earendil-works/pi-durable";
import { cachedSettings, CacheWarmers, rememberRequests, requestOf, sessionWarming, startsWith, type ModelRequest, type WarmingClock, type WarmingSession } from "../apps/runner/src/session/cache-warming.js";
import type { Metadata } from "../apps/runner/src/session/state.js";
import type { CacheWarmingMode, SessionCacheWarming } from "../packages/shared/src/cache-warming.js";

const MINUTE = 60_000;

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };

function fakeClock(start = 0): WarmingClock & { advance(ms: number): Promise<void>; set(time: number): Promise<void>; pending(): number } {
  let time = start;
  const timers: { at: number; run: () => void; cancelled: boolean }[] = [];
  const advanceTo = async (end: number) => {
    for (;;) {
      const due = timers.filter(timer => !timer.cancelled && timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      time = Math.max(time, due.at);
      due.run();
      await settle();
    }
    time = Math.max(time, end);
  };
  return {
    now: () => time,
    setTimer: (run, ms) => {
      const timer = { at: time + ms, run, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
    advance: ms => advanceTo(time + ms),
    set: end => advanceTo(end),
    pending: () => timers.filter(timer => !timer.cancelled).length,
  };
}

const claude = { id: "claude-test", name: "Claude test", api: "anthropic-messages", provider: "anthropic", baseUrl: "https://example.invalid", reasoning: true,
  input: ["text"], cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, contextWindow: 1_000_000, maxTokens: 64_000,
  promptCache: { short: 300, long: 3600 } } as unknown as Model<Api>;

const usage = (cacheWrite: number): Usage => ({ input: 0, output: 1, cacheRead: 0, cacheWrite, totalTokens: cacheWrite + 1,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

const response = (tokens: number, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage => ({
  role: "assistant", content: [{ type: "text", text: "ok" }], api: claude.api, provider: claude.provider, model: claude.id, usage: usage(tokens), stopReason, timestamp: 0 });

const sent: Context = { messages: [{ role: "user", content: "Fix the flaky test", timestamp: 1 }] };

const request = (options: ModelsSimpleStreamOptions = { cacheRetention: "short" }, model: Model<Api> = claude, sentAt = 0): ModelRequest =>
  ({ model, context: sent, options, sentAt });

type Call = { context: Context; options: ModelsSimpleStreamOptions; at: number };

function fakeModels(clock: WarmingClock, answer: (call: Call) => Promise<AssistantMessage> | AssistantMessage = () => response(1)) {
  const calls: Call[] = [];
  const models = { completeSimple: async (_model: Model<Api>, requestContext: Context, options: ModelsSimpleStreamOptions) => {
    const call = { context: requestContext, options, at: clock.now() };
    calls.push(call);
    return answer(call);
  } } as unknown as Models;
  return { models, calls };
}

function fakeSession(phase: () => CacheWarmingPhase | undefined = () => "streaming", mode: () => CacheWarmingMode = () => "idle") {
  const recorded: AssistantMessage[] = [];
  const reported: unknown[] = [];
  const session: WarmingSession = {
    mode: async () => mode(),
    phase: async () => phase(),
    record: async (_conversation, refresh) => { recorded.push(refresh); },
    report: error => { reported.push(error); },
  };
  return { session, recorded, reported };
}

test("a refresh goes out at 90% of the cache lifetime, counted from when the request, then each refresh, was sent", async () => {
  const clock = fakeClock(5_000);
  const { models, calls } = fakeModels(clock);
  const { session, recorded } = fakeSession();
  const warmers = new CacheWarmers(session, clock);
  warmers.start(1, response(400_000), request(), models);
  assert.deepEqual(warmers.warming, [1]);
  await clock.set(270_000 - 1);
  assert.equal(calls.length, 0);
  await clock.advance(1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.at, 270_000, "90% of the 5-minute lifetime, from the request's start, not its response's end");
  assert.deepEqual(calls[0]!.context.messages, sent.messages);
  const { signal, ...options } = calls[0]!.options;
  assert.ok(signal instanceof AbortSignal);
  assert.deepEqual(options, { cacheRetention: "short", maxTokens: 1, disableContinuation: true, maxRetries: 0 });
  assert.equal(recorded.length, 1, "the refresh's usage is the session's own");
  await clock.set(540_000 - 1);
  assert.equal(calls.length, 1);
  await clock.advance(1);
  assert.equal(calls.length, 2, "the next refresh counts from when the last one was sent");
  warmers.close();
  assert.deepEqual(warmers.warming, []);
  assert.equal(clock.pending(), 0);
});

test("a refresh is sent only when it is expected to save at least $0.05", async () => {
  for (const [tokens, phase, warm] of [[10_000, "streaming", false], [20_000, "streaming", true], [20_000, "idle", false], [400_000, "idle", true]] as const) {
    const clock = fakeClock();
    const { models, calls } = fakeModels(clock);
    const warmers = new CacheWarmers(fakeSession(() => phase).session, clock);
    warmers.start(1, response(tokens), request(), models);
    await clock.advance(270_000);
    assert.equal(calls.length, warm ? 1 : 0, `${tokens} prompt tokens, ${phase}`);
    assert.deepEqual(warmers.warming, warm ? [1] : [], "warming ends with the first refresh that doesn't pay");
  }
});

test("only replayable requests to models with a cache lifetime start warming", () => {
  const clock = fakeClock();
  const { models } = fakeModels(clock);
  const warmers = new CacheWarmers(fakeSession().session, clock);
  const { promptCache: _, ...uncached } = claude as Model<Api> & { promptCache?: unknown };
  warmers.start(1, response(400_000), request({}, uncached as Model<Api>), models);
  warmers.start(2, response(400_000), request({ cacheRetention: "short", reasoning: "high" }), models);
  warmers.start(3, response(400_000, "error"), request(), models);
  warmers.start(4, response(400_000, "aborted"), request(), models);
  warmers.start(5, response(400_000), request({ cacheRetention: "none" }), models);
  assert.deepEqual(warmers.warming, [], "no lifetime, Anthropic budget thinking, a failed or aborted response, caching off");
  const adaptive = { ...claude, compat: { forceAdaptiveThinking: true } } as unknown as Model<Api>;
  warmers.start(6, response(400_000), request({ cacheRetention: "short", reasoning: "high" }, adaptive), models);
  assert.deepEqual(warmers.warming, [6], "adaptive thinking replays the same request");
  warmers.close();
});

test("idle warming ends 30 minutes after the request, warming while a run works 60 minutes after it", async () => {
  for (const [phase, last] of [["idle", 6 * 270_000], ["streaming", 13 * 270_000]] as const) {
    const clock = fakeClock();
    const { models, calls } = fakeModels(clock);
    const warmers = new CacheWarmers(fakeSession(() => phase).session, clock);
    warmers.start(1, response(400_000), request(), models);
    await clock.advance(120 * MINUTE);
    assert.equal(calls.at(-1)!.at, last, phase);
    assert.ok(calls.every(call => call.at <= (phase === "idle" ? 30 : 60) * MINUTE));
    assert.deepEqual(warmers.warming, []);
    assert.equal(clock.pending(), 0);
  }
});

test("a request with the long retention is refreshed once in its hour, then left to expire", async () => {
  const clock = fakeClock();
  const { models, calls } = fakeModels(clock);
  const warmers = new CacheWarmers(fakeSession().session, clock);
  warmers.start(1, response(400_000), request({ cacheRetention: "long" }), models);
  await clock.advance(180 * MINUTE);
  assert.deepEqual(calls.map(call => call.at), [3_240_000]);
  assert.deepEqual(warmers.warming, []);
});

test("warming stops once the next request would differ, the workspace turns it off, or idle warming isn't wanted", async () => {
  const cases: { phase: CacheWarmingPhase | undefined; mode: CacheWarmingMode; warm: boolean }[] = [
    { phase: undefined, mode: "idle", warm: false },
    { phase: "streaming", mode: "off", warm: false },
    { phase: "idle", mode: "streaming", warm: false },
    { phase: "streaming", mode: "streaming", warm: true },
    { phase: "idle", mode: "idle", warm: true },
  ];
  for (const { phase, mode, warm } of cases) {
    const clock = fakeClock();
    const { models, calls } = fakeModels(clock);
    const warmers = new CacheWarmers(fakeSession(() => phase, () => mode).session, clock);
    warmers.start(1, response(400_000), request(), models);
    await clock.advance(270_000);
    assert.equal(calls.length, warm ? 1 : 0, `${phase ?? "differs"}, ${mode}`);
    assert.deepEqual(warmers.warming, warm ? [1] : []);
    warmers.close();
  }
});

test("a refresh that is late, fails or throws ends warming; a thrown one is reported", async () => {
  const clock = fakeClock();
  const late = fakeModels(clock);
  let slow: () => void = () => {};
  const warmers = new CacheWarmers({ ...fakeSession().session, mode: () => new Promise(resolve => { slow = () => resolve("idle"); }) }, clock);
  warmers.start(1, response(400_000), request(), late.models);
  await clock.advance(270_000);
  await clock.advance(20_000);
  slow();
  await settle();
  assert.equal(late.calls.length, 0, "past the refresh's deadline, nothing is sent");
  assert.deepEqual(warmers.warming, []);

  const failing = fakeModels(clock, () => response(1, "error"));
  const failed = fakeSession();
  const second = new CacheWarmers(failed.session, clock);
  second.start(1, response(400_000), request({ cacheRetention: "short" }, claude, clock.now()), failing.models);
  await clock.advance(270_000);
  assert.equal(failing.calls.length, 1);
  assert.deepEqual(second.warming, [], "a failed refresh left the cache as it was");
  assert.equal(failed.recorded.length, 0);

  const throwing = fakeModels(clock, () => { throw new Error("provider down"); });
  const thrown = fakeSession();
  const third = new CacheWarmers(thrown.session, clock);
  third.start(1, response(400_000), request({ cacheRetention: "short" }, claude, clock.now()), throwing.models);
  await clock.advance(270_000);
  assert.deepEqual(third.warming, []);
  assert.match(String(thrown.reported[0]), /provider down/);
});

function fakeStreams(answer: AssistantMessage) {
  const seen: ModelsSimpleStreamOptions[] = [];
  const inner = {
    streamSimple: (_model: Model<Api>, _context: Context, options?: ModelsSimpleStreamOptions) => {
      seen.push(options ?? {});
      return { result: async () => answer } as unknown as AssistantMessageEventStream;
    },
    completeSimple: async () => answer,
    getModels: () => [claude],
  } as unknown as Models;
  return { inner, seen };
}

test("the model requests a session sends are remembered by their response, without their signal or callbacks", async () => {
  const answer = response(400_000);
  const { inner } = fakeStreams(answer);
  let time = 42;
  const models = rememberRequests(inner, () => time);
  assert.deepEqual(models.getModels(), [claude], "everything else reaches the wrapped models");
  const controller = new AbortController();
  const stream = models.streamSimple(claude, sent, { cacheRetention: "short", signal: controller.signal, onPayload: () => undefined, sessionId: "s" });
  time = 99;
  const result = await stream.result();
  await settle();
  assert.deepEqual(requestOf(result), { model: claude, context: sent, options: { cacheRetention: "short", sessionId: "s" }, sentAt: 42 });
  assert.equal(requestOf(result), undefined, "each request is taken once");
});

test("a generation's request stops warming and aborts a refresh in flight, so they never overlap; its response starts warming again", async () => {
  const clock = fakeClock();
  let aborted: AbortSignal | undefined;
  const { models, calls } = fakeModels(clock, call => new Promise((_resolve, reject) => {
    aborted = call.options.signal;
    call.options.signal!.addEventListener("abort", () => reject(new Error("aborted")));
  }));
  const { session, recorded, reported } = fakeSession();
  const warmers = new CacheWarmers(session, clock);
  const hooks = warmers.hooks().handlers as Partial<GenerationHooks>;
  const answer = response(400_000);
  const { inner } = fakeStreams(answer);
  const remembered = rememberRequests(inner, clock.now);
  await remembered.streamSimple(claude, sent, { cacheRetention: "short" }).result();
  await settle();
  const api = { conversationId: 7, models } as never;
  await hooks.afterResponse!(answer, api, context);
  assert.deepEqual(warmers.warming, [7]);
  await clock.advance(270_000);
  assert.equal(calls.length, 1);
  assert.equal(aborted?.aborted, false);
  await hooks.beforeRequest!({ messages: sent.messages }, api, context);
  await settle();
  assert.equal(aborted?.aborted, true, "the refresh in flight is aborted as the generation's request goes out");
  assert.deepEqual(warmers.warming, []);
  assert.equal(recorded.length, 0);
  assert.deepEqual(reported, [], "an aborted refresh isn't a failure");
  assert.equal(clock.pending(), 0);
  await hooks.afterResponse!(response(400_000), api, context);
  assert.deepEqual(warmers.warming, [], "a response whose request wasn't remembered starts nothing");
  warmers.close();
});

test("a session asks its Pikibun server for its workspace's choice at most every 30 seconds, keeps the last answer 5 minutes, and warms nothing it can't learn", async () => {
  let time = 0;
  let answer: SessionCacheWarming | Error = { mode: "streaming", child: true };
  let asked = 0;
  const settings = cachedSettings(async () => { asked++; if (answer instanceof Error) throw answer; return answer; }, () => time);
  assert.deepEqual(await settings(), { mode: "streaming", child: true });
  answer = { mode: "idle", child: false };
  time = 29_999;
  assert.deepEqual(await settings(), { mode: "streaming", child: true });
  assert.equal(asked, 1);
  time = 30_000;
  assert.deepEqual(await settings(), { mode: "idle", child: false });
  answer = new Error("offline");
  time = 60_000;
  assert.deepEqual(await settings(), { mode: "idle", child: false }, "the last answer, while it is recent");
  time = 30_000 + 5 * MINUTE;
  assert.deepEqual(await settings(), { mode: "off", child: false });
  const never = cachedSettings(async () => { throw new Error("an older Pikibun server"); });
  assert.deepEqual(await never(), { mode: "off", child: false });
});

test("the context still starts with the sent messages only when every sent message is there, in order", () => {
  const [first] = sent.messages;
  const second = { role: "user" as const, content: "And the other one", timestamp: 2 };
  assert.equal(startsWith([first!, second], [first!]), true);
  assert.equal(startsWith([structuredClone(first!), second], [first!]), true);
  assert.equal(startsWith([second], [first!]), false);
  assert.equal(startsWith([first!], [first!, second]), false);
});

test("in a session, the shared conversation is warmed between messages with its own requests, its usage added to the session's, until its model changes", async t => {
  const faux = fauxProvider({ models: [{ id: "faux-1", cost: { input: 1_000_000, output: 1, cacheRead: 1, cacheWrite: 1_000_000 } }, { id: "faux-2" }] });
  const respond: FauxResponseFactory = async () => { faux.appendResponses([respond]); return fauxAssistantMessage("done"); };
  faux.setResponses([respond]);
  const base = createModels();
  base.setProvider(faux.provider);
  const cached = new Proxy(base, { get: (target, key) => {
    if (key === "getModel") return (provider: string, id: string) => { const model = target.getModel(provider, id); return model && { ...model, promptCache: { short: 300 } }; };
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const clock = fakeClock(Date.now());
  const models = rememberRequests(cached, clock.now);
  let harness: Harness | undefined;
  let metadata = { branches: [] } as unknown as Metadata;
  const reported: unknown[] = [];
  let settings: SessionCacheWarming = { mode: "idle", child: false };
  const source = { harness: () => harness, metadata: async () => metadata, settings: async () => settings, report: (error: unknown) => { reported.push(error); } };
  const warmers = new CacheWarmers(sessionWarming(source), clock);
  t.after(() => warmers.close());
  const workspace = defineExtension({ name: "workspace-tools", hooks: [warmers.hooks()] });
  const registry = createRegistry();
  registry.install(workspace);
  harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
  t.after(() => harness!.close(context));
  const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, extensions: [workspace] } });
  metadata = { branches: [{ id: root.id, mode: "write" }] } as unknown as Metadata;
  assert.equal((await (await root.submit({ type: "input", content: "hello" }, context)).wait(context)).status, "done");
  await settle();
  assert.deepEqual(warmers.warming, [root.id]);
  const before = structuredClone((await harness.snapshot(UsageDoc, root.id, context))!.models["faux/faux-1"]!);
  await clock.advance(270_000);
  assert.deepEqual(reported, []);
  const after = (await harness.snapshot(UsageDoc, root.id, context))!.models["faux/faux-1"]!;
  assert.ok(after.cacheRead > before.cacheRead, "the refresh read the cache, and its usage is the conversation's");
  assert.equal(after.output, before.output + 1);
  assert.deepEqual(warmers.warming, [root.id]);

  metadata = { branches: [{ id: root.id, mode: "write", superseded: true }] } as unknown as Metadata;
  await clock.advance(270_000);
  assert.deepEqual(warmers.warming, [], "a superseded conversation is no longer warmed once settled");

  metadata = { branches: [{ id: root.id, mode: "write" }] } as unknown as Metadata;
  settings = { mode: "idle", child: true };
  assert.equal((await (await root.submit({ type: "input", content: "once more" }, context)).wait(context)).status, "done");
  await settle();
  assert.deepEqual(warmers.warming, [root.id]);
  await clock.advance(270_000);
  assert.deepEqual(warmers.warming, [], "a sub-task session is no longer warmed once settled");

  settings = { mode: "idle", child: false };
  assert.equal((await (await root.submit({ type: "input", content: "again" }, context)).wait(context)).status, "done");
  await settle();
  assert.deepEqual(warmers.warming, [root.id], "each response starts warming with its own request");
  await root.configure({ model: { provider: "faux", modelId: "faux-2" } }, context);
  const usageBefore = structuredClone((await harness.snapshot(UsageDoc, root.id, context))!.models);
  await clock.advance(270_000);
  assert.deepEqual(warmers.warming, [], "the next request goes to another model, so this cache entry won't be read");
  assert.deepEqual((await harness.snapshot(UsageDoc, root.id, context))!.models, usageBefore);
});
