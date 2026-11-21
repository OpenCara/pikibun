import assert from "node:assert/strict";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { registerSessionResourceCleanup } from "@earendil-works/pi-ai/session-resources";
import { createRegistry, defineExtension, Harness, MemoryStorage, ProviderDoc, type CompactionHooks, type GenerationHooks } from "@earendil-works/pi-durable";
import { CacheWarmers, rememberRequests, sessionWarming, type WarmingClock } from "../apps/runner/src/session/cache-warming.js";
import { PROVIDER_RELEASE_IDLE_MS, ProviderReleases, sessionReleases, type ReleaseSession } from "../apps/runner/src/session/provider-release.js";
import type { Metadata } from "../apps/runner/src/session/state.js";

const MINUTE = 60_000;

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };

function fakeClock(start = 0): WarmingClock & { advance(ms: number): Promise<void>; pending(): number } {
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
    pending: () => timers.filter(timer => !timer.cancelled).length,
  };
}

function observeReleases(t: { after(run: () => void): void }): string[] {
  const released: string[] = [];
  t.after(registerSessionResourceCleanup(sessionId => { if (sessionId !== undefined) released.push(sessionId); }));
  return released;
}

function fakeSession(state: { busy?: boolean; warming?: boolean } = {}) {
  const reported: unknown[] = [];
  const session: ReleaseSession = {
    busy: async () => state.busy === true,
    warming: () => state.warming === true,
    providerSessionId: async conversation => `provider-${conversation}`,
    report: error => { reported.push(error); },
  };
  return { session, reported };
}

test("an idle conversation's provider resources are released 15 minutes after its last activity, once", async t => {
  const released = observeReleases(t);
  const clock = fakeClock();
  const releases = new ProviderReleases(fakeSession().session, clock);
  assert.equal(PROVIDER_RELEASE_IDLE_MS, 15 * MINUTE);
  releases.touch(1);
  releases.touch(2);
  await clock.advance(15 * MINUTE - 1);
  assert.deepEqual(released, []);
  await clock.advance(1);
  assert.deepEqual(released, ["provider-1", "provider-2"]);
  assert.deepEqual(releases.pending, []);
  await clock.advance(60 * MINUTE);
  assert.deepEqual(released, ["provider-1", "provider-2"], "a released conversation waits for its next activity");
  assert.equal(clock.pending(), 0);
});

test("work starting again puts the release off, and each response starts the idle delay again", async t => {
  const released = observeReleases(t);
  const clock = fakeClock();
  const releases = new ProviderReleases(fakeSession().session, clock);
  const generation = releases.hooks()[0]!.handlers as Partial<GenerationHooks>;
  const compaction = releases.hooks()[1]!.handlers as Partial<CompactionHooks>;
  const api = { conversationId: 3 } as never;
  await generation.afterResponse!({} as never, api, context);
  await clock.advance(10 * MINUTE);
  assert.equal(await generation.beforeRequest!({ messages: [] }, api, context), undefined);
  await clock.advance(10 * MINUTE);
  assert.deepEqual(released, [], "the release due 15 minutes after the first response was cancelled");
  await generation.afterResponse!({} as never, api, context);
  await clock.advance(14 * MINUTE);
  assert.equal(await compaction.beforeCompact!({} as never, api, context), undefined);
  await clock.advance(14 * MINUTE);
  assert.deepEqual(released, []);
  await clock.advance(MINUTE);
  assert.deepEqual(released, ["provider-3"]);
  assert.equal(clock.pending(), 0);
});

test("nothing is released while the conversation works or its cache is being warmed; the release waits until both have ended", async t => {
  const released = observeReleases(t);
  const clock = fakeClock();
  const state = { busy: true, warming: false };
  const releases = new ProviderReleases(fakeSession(state).session, clock);
  releases.touch(1);
  await clock.advance(15 * MINUTE);
  assert.deepEqual(released, [], "a run still works, in a long tool call");
  assert.deepEqual(releases.pending, [1]);
  state.busy = false;
  state.warming = true;
  await clock.advance(15 * MINUTE);
  assert.deepEqual(released, [], "warming still keeps it warm");
  assert.deepEqual(releases.pending, [1]);
  state.warming = false;
  await clock.advance(15 * MINUTE);
  assert.deepEqual(released, ["provider-1"]);
});

test("activity while the release checks the conversation keeps it, and close cancels every pending release", async t => {
  const released = observeReleases(t);
  const clock = fakeClock();
  let checked: () => void = () => {};
  const { session } = fakeSession();
  const releases = new ProviderReleases({ ...session, busy: () => new Promise(resolve => { checked = () => resolve(false); }) }, clock);
  releases.touch(1);
  await clock.advance(15 * MINUTE);
  releases.touch(1);
  checked();
  await settle();
  assert.deepEqual(released, [], "a request went out while the check read the conversation");
  assert.deepEqual(releases.pending, [1]);
  releases.touch(2);
  releases.close();
  assert.deepEqual(releases.pending, []);
  assert.equal(clock.pending(), 0);
  releases.touch(3);
  assert.equal(clock.pending(), 0, "a closed session schedules nothing");
});

test("a failing release is reported and doesn't keep the conversation pending", async t => {
  observeReleases(t);
  const clock = fakeClock();
  const { session, reported } = fakeSession();
  const releases = new ProviderReleases({ ...session, providerSessionId: async () => { throw new Error("storage closed"); } }, clock);
  releases.touch(1);
  await clock.advance(15 * MINUTE);
  assert.match(String(reported[0]), /storage closed/);
  assert.deepEqual(releases.pending, []);
});

test("in a session, each conversation's own provider session is released once it idles past the delay and its warming ended", async t => {
  const released = observeReleases(t);
  const faux = fauxProvider({ models: [{ id: "faux-1", cost: { input: 1_000_000, output: 1, cacheRead: 1, cacheWrite: 1_000_000 } }] });
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
  const report = (error: unknown) => { reported.push(error); };
  let warmers: CacheWarmers | undefined;
  const releases = new ProviderReleases(sessionReleases({ harness: () => harness, warming: id => warmers?.warming.includes(id) ?? false, report }), clock);
  warmers = new CacheWarmers({ ...sessionWarming({ harness: () => harness, metadata: async () => metadata, settings: async () => ({ mode: "idle", child: false }), report }),
    ended: id => releases.touch(id) }, clock);
  t.after(() => { warmers!.close(); releases.close(); });
  const workspace = defineExtension({ name: "workspace-tools", hooks: [warmers.hooks(), ...releases.hooks()] });
  const registry = createRegistry();
  registry.install(workspace);
  harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
  t.after(() => harness!.close(context));
  const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, extensions: [workspace] } });
  metadata = { branches: [{ id: root.id, mode: "write" }] } as unknown as Metadata;
  assert.equal((await (await root.submit({ type: "input", content: "hello" }, context)).wait(context)).status, "done");
  const head = (await root.context(context)).entries.at(-1)!;
  const ask = await root.fork(head.id, { ownership: { kind: "ownerless" } }, context);
  assert.equal((await (await ask.submit({ type: "input", content: "a side question" }, context)).wait(context)).status, "done");
  await settle();
  const rootSession = (await harness.snapshot(ProviderDoc, root.id, context))!.sessionId;
  const askSession = (await harness.snapshot(ProviderDoc, ask.id, context))!.sessionId;
  assert.notEqual(rootSession, askSession);

  await clock.advance(5 * MINUTE);
  assert.deepEqual(warmers.warming, [root.id], "the side ask's warming ended at its first refresh, 4.5 minutes in");
  await clock.advance(10 * MINUTE);
  assert.deepEqual(released, [], "15 minutes after the side ask's response, but only 10.5 after its warming ended");
  await clock.advance(5 * MINUTE);
  assert.deepEqual(released, [askSession]);
  await clock.advance(12 * MINUTE);
  assert.deepEqual(warmers.warming, [], "idle warming of the shared conversation ends 31.5 minutes in");
  await clock.advance(14 * MINUTE);
  assert.deepEqual(released, [askSession], "the shared conversation was kept while it was warmed");
  await clock.advance(MINUTE);
  assert.deepEqual(released, [askSession, rootSession], "15 minutes after its warming ended");
  assert.deepEqual(reported, []);
  assert.deepEqual(releases.pending, []);

  let answer: () => void = () => {};
  const held: FauxResponseFactory = async () => {
    await new Promise<void>(resolve => { answer = resolve; });
    faux.appendResponses([respond]);
    return fauxAssistantMessage("done at last");
  };
  faux.setResponses([held]);
  const working = await root.submit({ type: "input", content: "back again" }, context);
  for (let i = 0; i < 50 && releases.pending.length === 0; i++) await settle();
  assert.deepEqual(releases.pending, [root.id], "the next message uses the provider session again, so its release is due again");
  await clock.advance(20 * MINUTE);
  assert.deepEqual(released, [askSession, rootSession], "nothing is released while a model request is under way");
  assert.deepEqual(releases.pending, [root.id]);
  answer();
  assert.equal((await working.wait(context)).status, "done");
  assert.deepEqual(reported, []);
});
