import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { SessionRecord, SessionView } from "../packages/shared/src/types.js";
import { ApiError } from "../packages/client/src/api.js";
import {
  createViewCache, liveTiming, startLiveSession, type EventStream, type LocalSessions, type LocalViewReply, type StreamStatus, type ViewCache,
} from "../packages/client/src/live-session.js";

const record = { id: "s1" } as SessionRecord;
const viewable = { ...record, viewable: true } as SessionRecord;
const idleView = { sessionId: "s1", busy: false, queue: [] } as unknown as SessionView;
const activeView = { sessionId: "s1", busy: false, queue: [{ submissionId: "q1", actorId: "u1", mode: "write", status: "running" }] } as unknown as SessionView;
const offline = new ApiError(503, "connector_offline", "The connector is offline or has reconnected.");

type Listener = (event: { data?: unknown }) => void;

class FakeStream implements EventStream {
  readonly listeners = new Map<string, Listener[]>();
  addEventListener(type: string, listener: Listener) { this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]); }
  close() {}
  emit(type: string, data?: unknown) { for (const listener of this.listeners.get(type) ?? []) listener({ data }); }
}

interface Backend {
  session: SessionRecord | Error;
  view: SessionView | ApiError;
  stream: SessionView[] | "hold";
  entries?: (path: string) => unknown;
  metadataGate?: Promise<void>;
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

async function liveSession(t: TestContext, backend: Backend, cache?: ViewCache, local?: LocalSessions) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let now = 0;
  let hidden = false;
  const requests: { at: number; path: string }[] = [];
  const streams: FakeStream[] = [];
  const visibility = new Set<() => void>();
  const state: { session?: SessionRecord | null; view?: SessionView | null; error: string; status?: StreamStatus } = { error: "" };
  const live = startLiveSession("s1", {
    session: value => { state.session = value; },
    view: value => { state.view = value; },
    error: value => { state.error = value; },
    status: value => { state.status = value; },
  }, {
    async api<T>(path: string) {
      requests.push({ at: now, path });
      if (path.includes("/entries?")) {
        const page = backend.entries?.(path);
        if (page instanceof ApiError) throw page;
        return page as T;
      }
      if (!path.endsWith("/view")) await backend.metadataGate;
      const answer = path.endsWith("/view") ? backend.view : backend.session;
      if (answer instanceof Error) throw answer;
      return (path.endsWith("/view") ? { view: answer } : { session: answer }) as T;
    },
    openEvents(url) {
      requests.push({ at: now, path: url });
      const stream = new FakeStream();
      streams.push(stream);
      const snapshots = backend.stream;
      if (snapshots !== "hold") queueMicrotask(() => {
        for (const view of snapshots) stream.emit("view", JSON.stringify({ view }));
        stream.emit("error");
      });
      return stream;
    },
    hidden: () => hidden,
    onVisibilityChange(listener) { visibility.add(listener); return () => visibility.delete(listener); },
    cache,
    ...(local ? { local } : {}),
  });
  t.after(() => live.stop());
  await flush();
  return {
    live, requests, streams, state,
    async advance(ms: number) {
      for (let elapsed = 0; elapsed < ms; elapsed += 250) { now += 250; t.mock.timers.tick(250); await flush(); }
    },
    async setHidden(value: boolean) { hidden = value; for (const listener of visibility) listener(); await flush(); },
    opens: () => requests.filter(request => request.path.includes("/events")).map(request => request.at),
    since: (at: number) => requests.filter(request => request.at >= at).length,
  };
}

test("a session whose host stays offline backs off to one stream a minute instead of hammering the Worker", async t => {
  const live = await liveSession(t, { session: record, view: offline, stream: [] });
  await live.advance(60 * 60_000);
  const opens = live.opens();
  const gaps = opens.slice(1).map((at, index) => at - opens[index]!);
  assert.equal(gaps[0], liveTiming.firstBackoffMs);
  assert.ok(gaps.every((gap, index) => index === 0 || gap >= gaps[index - 1]!), `gaps never shrink while every stream fails: ${gaps.join(",")}`);
  assert.equal(gaps.at(-1), liveTiming.maxBackoffMs);
  assert.ok(live.requests.length < 400, `${live.requests.length} requests in an hour`);
  assert.equal(live.state.status, "reconnecting");
  assert.equal(live.state.error, offline.message);
});

test("a hidden page makes no requests until it is visible again", async t => {
  const live = await liveSession(t, { session: record, view: idleView, stream: [idleView] });
  await live.setHidden(true);
  const hiddenAt = live.requests.length;
  await live.advance(30 * 60_000);
  assert.equal(live.requests.length, hiddenAt);
  await live.setHidden(false);
  const resumed = live.requests.slice(hiddenAt).map(request => request.path);
  assert.deepEqual(resumed, ["/api/sessions/s1", "/api/sessions/s1/events?since="]);
});

test("opening a session asks for its metadata and its stream at once, and the stream's snapshot is the view", async t => {
  const live = await liveSession(t, { session: record, view: idleView, stream: [idleView] });
  assert.deepEqual(live.requests.map(request => `${request.at} ${request.path}`), ["0 /api/sessions/s1", "0 /api/sessions/s1/events?since="]);
  assert.deepEqual(live.state.session, record);
  assert.deepEqual(live.state.view, idleView);
  assert.equal(live.state.status, "online");
});

test("idle sessions reopen slowly, running ones quickly, and snapshots render without fetching the view", async t => {
  const backend: Backend = { session: record, view: idleView, stream: [idleView] };
  const live = await liveSession(t, backend);
  assert.equal(live.state.status, "online");
  await live.advance(liveTiming.idleReopenMs - 250);
  assert.equal(live.opens().length, 1);
  await live.advance(250);
  assert.equal(live.opens().length, 2);

  backend.stream = [activeView];
  const before = live.opens().length;
  live.live.refresh();
  await flush();
  assert.equal(live.opens().length, before + 1);
  assert.deepEqual(live.state.view, activeView);
  const lastOpen = live.opens().at(-1)!;
  await live.advance(liveTiming.activeReopenMs);
  assert.equal(live.opens().at(-1), lastOpen + liveTiming.activeReopenMs);

  assert.equal(live.requests.filter(request => request.path.endsWith("/view")).length, 0);
});

test("a refresh while a stream is open looks again as soon as that stream ends", async t => {
  const backend: Backend = { session: record, view: idleView, stream: "hold" };
  const live = await liveSession(t, backend);
  const open = live.streams.at(-1)!;
  open.emit("view", JSON.stringify({ view: idleView }));
  live.live.refresh();
  await flush();
  assert.equal(live.opens().length, 1);
  open.emit("error");
  await live.advance(liveTiming.activeReopenMs);
  assert.deepEqual(live.opens(), [0, liveTiming.activeReopenMs]);
});

test("losing access clears the session and stops every request", async t => {
  const backend: Backend = { session: record, view: idleView, stream: [idleView] };
  const live = await liveSession(t, backend);
  backend.session = new ApiError(403, "forbidden", "You no longer have access to this session.");
  backend.stream = [];
  await live.advance(liveTiming.idleReopenMs);
  assert.equal(live.state.status, "offline");
  assert.equal(live.state.session, null);
  assert.equal(live.state.view, null);
  const revokedAt = live.requests.at(-1)!.at;
  await live.advance(60 * 60_000);
  assert.equal(live.since(revokedAt + 1), 0);
});

test("a host preparing repositories reopens the stream quickly before any message, then slows down once ready", async t => {
  const preparing = { ...idleView, repositories: { status: "preparing", items: [] } } as unknown as SessionView;
  const backend: Backend = { session: record, view: preparing, stream: [preparing] };
  const live = await liveSession(t, backend);
  await live.advance(liveTiming.activeReopenMs);
  assert.deepEqual(live.opens(), [0, liveTiming.activeReopenMs]);
  assert.equal(live.state.view?.repositories?.status, "preparing");
  backend.stream = [idleView];
  await live.advance(liveTiming.activeReopenMs);
  assert.deepEqual(live.opens(), [0, liveTiming.activeReopenMs, 2 * liveTiming.activeReopenMs]);
  await live.advance(liveTiming.idleReopenMs - 250);
  assert.equal(live.opens().length, 3);
  await live.advance(250);
  assert.equal(live.opens().length, 4);
});

test("streams ask for what changed since the held revision and apply patches to the view shown", async t => {
  const first = "a".repeat(32);
  const second = "b".repeat(32);
  const entry = { id: "0:1", kind: "message", role: "user", text: "hello" };
  const reply = { id: "0:2", kind: "message", role: "assistant", text: "hi" };
  const base = { ...idleView, entries: [entry], approvals: [], conversations: [] } as unknown as SessionView;
  const backend: Backend = { session: record, view: base, stream: "hold" };
  const live = await liveSession(t, backend);
  const open = live.streams.at(-1)!;
  open.emit("view", JSON.stringify({ view: base, revision: first }));
  const held = live.state.view!.entries[0];
  open.emit("patch", JSON.stringify({ patch: { base: first, revision: second, view: { sessionId: "s1", busy: true },
    lists: { entries: [1, reply], approvals: [], conversations: [], queue: [] } } }));
  assert.equal(live.state.view?.busy, true);
  assert.deepEqual(live.state.view?.entries, [entry, reply]);
  assert.equal(live.state.view?.entries[0], held);
  const shown = live.state.view;
  open.emit("patch", JSON.stringify({ patch: { base: second, revision: second } }));
  assert.equal(live.state.view, shown, "No change shows the same view");
  open.emit("error");
  await live.advance(liveTiming.activeReopenMs);
  assert.equal(live.requests.at(-1)!.path, `/api/sessions/s1/events?since=${second}`);

  const next = live.streams.at(-1)!;
  next.emit("patch", JSON.stringify({ patch: { base: first, revision: "c".repeat(32), view: { sessionId: "s1", busy: false },
    lists: { entries: [], approvals: [], conversations: [] } } }));
  assert.equal(live.state.view, shown);
  next.emit("error");
  await live.advance(liveTiming.firstBackoffMs);
  assert.equal(live.requests.filter(request => request.path.includes("/events")).at(-1)!.path, "/api/sessions/s1/events?since=");
});

test("a paged view reads earlier entries a page at a time, once per conversation, and keeps them as the window moves", async t => {
  const entry = (n: number) => ({ id: `0:${n}`, kind: "message", role: "assistant", text: `entry ${n}`, conversationId: "0" });
  const paged = (from: number, to: number, older: number, conversations: unknown[] = []) => ({
    ...idleView, approvals: [], entries: Array.from({ length: to - from + 1 }, (_, index) => entry(from + index)),
    conversations: [{ id: "0", mode: "write", olderEntries: older, previousEntryId: `0:${from - 1}` }, ...conversations],
  }) as unknown as SessionView;
  const pages: Record<string, { entries: unknown[]; older: number }> = {
    "0:5": { entries: [entry(3), entry(4)], older: 2 },
    "0:3": { entries: [entry(1), entry(2)], older: 0 },
  };
  const backend: Backend = { session: record, view: paged(5, 7, 4), stream: "hold",
    entries: path => pages[decodeURIComponent(/before=([^&]+)/.exec(path)![1]!)] ?? new ApiError(409, "entries_changed", "The transcript changed.") };
  const live = await liveSession(t, backend);
  live.streams.at(-1)!.emit("view", JSON.stringify({ view: paged(5, 7, 4) }));
  const ids = () => live.state.view!.entries.map(item => item.id);
  const reads = () => live.requests.filter(request => request.path.includes("/entries?")).map(request => request.path);
  assert.deepEqual(ids(), ["0:5", "0:6", "0:7"]);

  await Promise.all([live.live.loadOlder("0"), live.live.loadOlder("0")]);
  assert.deepEqual(reads(), ["/api/sessions/s1/entries?conversation=0&before=0%3A5&limit=50"]);
  assert.deepEqual(ids(), ["0:3", "0:4", "0:5", "0:6", "0:7"]);
  assert.equal(live.state.view!.conversations[0]!.olderEntries, 2);
  await live.live.loadOlder("0");
  assert.deepEqual(ids(), ["0:1", "0:2", "0:3", "0:4", "0:5", "0:6", "0:7"]);
  assert.equal(live.state.view!.conversations[0]!.olderEntries, undefined, "Nothing left to read");
  await live.live.loadOlder("0");
  await live.live.loadOlder("unknown");
  assert.equal(reads().length, 2, "Nothing more to read, so nothing is asked");

  const stream = live.streams.at(-1)!;
  stream.emit("view", JSON.stringify({ view: paged(6, 8, 5) }));
  assert.deepEqual(ids(), ["0:1", "0:2", "0:3", "0:4", "0:5", "0:6", "0:7", "0:8"]);
  stream.emit("view", JSON.stringify({ view: paged(20, 21, 9) }));
  assert.deepEqual(ids(), ["0:20", "0:21"]);
  assert.equal(live.state.view!.conversations[0]!.olderEntries, 9);
  await live.live.loadOlder("0");
  assert.equal(live.state.error, "The transcript changed.");
  assert.deepEqual(ids(), ["0:20", "0:21"]);
});

test("a session opened again shows its cached view once its metadata says it is viewable, and its stream asks only for changes", async t => {
  const first = "a".repeat(32);
  const second = "b".repeat(32);
  const cached = { ...idleView, entries: [{ id: "0:1", kind: "message", role: "user", text: "hello" }], approvals: [], conversations: [] } as unknown as SessionView;
  const cache = createViewCache();
  cache.set("s1", { view: cached, revision: first });
  const gate = Promise.withResolvers<void>();
  const live = await liveSession(t, { session: viewable, view: idleView, stream: "hold", metadataGate: gate.promise }, cache);
  assert.equal(live.requests.at(-1)!.path, `/api/sessions/s1/events?since=${first}`);
  assert.equal(live.state.view, undefined);
  gate.resolve();
  await flush();
  assert.deepEqual(live.state.view, cached);
  assert.equal(live.state.status, undefined, "Still connecting: the stream hasn't answered");
  const reply = { id: "0:2", kind: "message", role: "assistant", text: "hi" };
  live.streams.at(-1)!.emit("patch", JSON.stringify({ patch: { base: first, revision: second, view: { sessionId: "s1", busy: false },
    lists: { entries: [1, reply], approvals: [], conversations: [], queue: [] } } }));
  const updated = live.state.view as SessionView | null | undefined;
  assert.deepEqual(updated?.entries.map(entry => entry.id), ["0:1", "0:2"]);
  assert.equal(live.state.status as StreamStatus | undefined, "online");
  assert.deepEqual(cache.get("s1")?.revision, second, "The cache keeps the latest view");
});

test("a cached view never shows on metadata alone: the server must say the view is viewable", async t => {
  const cache = createViewCache();
  cache.set("s1", { view: activeView, revision: "a".repeat(32) });
  const live = await liveSession(t, { session: record, view: idleView, stream: "hold" }, cache);
  assert.deepEqual(live.state.session, record);
  assert.equal(live.state.view, undefined);
  live.streams.at(-1)!.emit("view", JSON.stringify({ view: idleView, revision: "b".repeat(32) }));
  assert.deepEqual(live.state.view, idleView);
});

test("a view refused though its session is readable (its host no longer shared) never shows from the cache, and is forgotten", async t => {
  const unshared = new ApiError(403, "connector_unavailable", "The connector or its workspace sharing is no longer authorized.");
  const cache = createViewCache();
  cache.set("s1", { view: idleView, revision: "a".repeat(32) });
  const live = await liveSession(t, { session: { ...record, viewable: false }, view: unshared, stream: [] }, cache);
  await live.advance(liveTiming.firstBackoffMs);
  assert.equal(live.state.view, undefined, "The cached view never showed");
  assert.equal(cache.get("s1"), undefined);
  assert.deepEqual(live.state.session, { ...record, viewable: false });
  assert.equal(live.state.error, unshared.message);
});

test("a /view refusal after the metadata passed drops the shown view and the cache; an offline host keeps them", async t => {
  const cache = createViewCache();
  const backend: Backend = { session: record, view: idleView, stream: [idleView] };
  const live = await liveSession(t, backend, cache);
  assert.deepEqual(live.state.view, idleView);
  backend.stream = [];
  backend.view = offline;
  await live.advance(liveTiming.idleReopenMs);
  assert.equal(live.state.error, offline.message);
  assert.deepEqual(live.state.view, idleView);
  assert.ok(cache.get("s1"));
  backend.view = new ApiError(403, "connector_unavailable", "The connector or its workspace sharing is no longer authorized.");
  await live.advance(liveTiming.maxBackoffMs);
  assert.equal(live.state.view, null);
  assert.equal(cache.get("s1"), undefined);
  assert.deepEqual(live.state.session, record);
});

test("the access check every 30 s drops a shown view the server says is no longer viewable", async t => {
  const cache = createViewCache();
  const backend: Backend = { session: viewable, view: idleView, stream: "hold" };
  const live = await liveSession(t, backend, cache);
  live.streams.at(-1)!.emit("view", JSON.stringify({ view: idleView }));
  assert.deepEqual(live.state.view, idleView);
  backend.session = { ...record, viewable: false };
  await live.advance(liveTiming.accessCheckMs);
  assert.equal(live.state.view, null);
  assert.equal(cache.get("s1"), undefined);
});

test("a cached view never shows once access is gone, and is forgotten", async t => {
  const cache = createViewCache();
  cache.set("s1", { view: idleView, revision: "a".repeat(32) });
  const live = await liveSession(t, { session: new ApiError(403, "forbidden", "You no longer have access to this session."), view: idleView, stream: [] }, cache);
  await live.advance(liveTiming.firstBackoffMs);
  assert.equal(live.state.view, null);
  assert.equal(live.state.status, "offline");
  assert.equal(cache.get("s1"), undefined);
});

test("the view cache keeps the sessions shown most recently", () => {
  const cache = createViewCache(2);
  for (const id of ["s1", "s2"]) cache.set(id, { view: idleView });
  cache.get("s1");
  cache.set("s3", { view: idleView });
  assert.equal(cache.get("s2"), undefined, "The least recently used goes");
  assert.ok(cache.get("s1") && cache.get("s3"));
  cache.clear();
  assert.equal(cache.get("s1"), undefined);
});

const hosted = { ...record, connectorId: "this-mac" } as SessionRecord;

class FakeHost implements LocalSessions {
  hosting = true;
  readonly records = new Map<string, SessionRecord>();
  readonly reads: { since?: string; brief: boolean }[] = [];
  readonly pages: { conversation: string; before: string; limit: number; brief: boolean }[] = [];
  answer: (options: { since?: string; brief: boolean }) => LocalViewReply | null = () => ({ view: idleView, revision: "1".repeat(32) });
  page: () => { entries: SessionView["entries"]; older: number } | null = () => null;
  runs(session: SessionRecord) {
    if (!this.hosting || session.connectorId !== "this-mac") { this.records.delete(session.id); return false; }
    this.records.set(session.id, session);
    return true;
  }
  ran(sessionId: string) { return this.hosting ? this.records.get(sessionId) : undefined; }
  async view(_sessionId: string, options: { since?: string; brief: boolean }) { this.reads.push(options); return this.answer(options); }
  async entries(_sessionId: string, options: { conversation: string; before: string; limit: number; brief: boolean }) { this.pages.push(options); return this.page(); }
}

test("a session this computer's host runs is read from it, and the server is asked only who may read it", async t => {
  const host = new FakeHost();
  const first = "1".repeat(32);
  const second = "2".repeat(32);
  host.answer = options => options.since === undefined ? { view: idleView, revision: first }
    : { patch: { base: first, revision: second, view: { sessionId: "s1", busy: true }, lists: { entries: [], approvals: [], conversations: [], queue: [] } } } as unknown as LocalViewReply;
  const live = await liveSession(t, { session: { ...hosted, toolOutput: "brief" }, view: idleView, stream: "hold" }, undefined, host);
  assert.deepEqual(live.state.view, idleView);
  assert.equal(live.state.status, "online");
  assert.deepEqual(host.reads, [{ brief: true }]);
  await live.advance(liveTiming.localIdleMs);
  assert.deepEqual(host.reads.at(-1), { since: first, brief: true });
  assert.equal(live.state.view?.busy, true);
  live.streams[0]!.emit("view", JSON.stringify({ view: activeView }));
  assert.equal(live.state.view?.busy, true, "The server's stream, opened before the metadata said where the session runs, is closed");
  await live.advance(liveTiming.accessCheckMs);
  const paths = live.requests.map(request => request.path);
  assert.deepEqual(paths, ["/api/sessions/s1", "/api/sessions/s1/events?since=", "/api/sessions/s1"], "No view from the server, and no stream after the first");
  assert.ok(host.reads.length > 10);
});

test("a session the host is known to run opens from it at once, and shows once the server says its account may read it", async t => {
  const host = new FakeHost();
  host.records.set("s1", hosted);
  const gate = Promise.withResolvers<void>();
  const live = await liveSession(t, { session: hosted, view: idleView, stream: "hold", metadataGate: gate.promise }, undefined, host);
  assert.equal(host.reads.length, 1);
  assert.equal(live.state.view, undefined, "Not before the server answered");
  assert.deepEqual(live.opens(), []);
  gate.resolve();
  await flush();
  assert.deepEqual(live.state.view, idleView);
  assert.deepEqual(live.opens(), [], "The server's stream never opened");
});

test("while the server can't be reached, a session on this computer's host carries on from it, without an error", async t => {
  const host = new FakeHost();
  host.records.set("s1", hosted);
  const backend: Backend = { session: new TypeError("fetch failed"), view: idleView, stream: [] };
  const live = await liveSession(t, backend, undefined, host);
  assert.deepEqual(live.state.view, idleView, "Opened while the server can't be reached");
  assert.equal(live.state.error, "");
  host.answer = () => ({ view: activeView, revision: "3".repeat(32) });
  await live.advance(liveTiming.accessCheckMs);
  assert.deepEqual(live.state.view, activeView);
  assert.equal(live.state.error, "");
  assert.equal(live.state.status, "online");
  assert.deepEqual(live.opens(), []);
});

test("a host that can't read the session hands it to the server's stream, and is asked again only after a while", async t => {
  const host = new FakeHost();
  host.answer = () => null;
  const backend: Backend = { session: hosted, view: idleView, stream: [idleView] };
  const live = await liveSession(t, backend, undefined, host);
  assert.equal(host.reads.length, 1);
  assert.deepEqual(live.state.view, idleView);
  assert.equal(live.opens().length, 2, "The stream opened before the metadata, then again once the host couldn't read it");
  await live.advance(liveTiming.localRetryMs - 250);
  assert.equal(host.reads.length, 1, "Not again while it is paused");
  host.answer = () => ({ view: activeView, revision: "4".repeat(32) });
  await live.advance(liveTiming.accessCheckMs + 250);
  assert.ok(host.reads.length > 1, "Again from the next access check");
  assert.deepEqual(live.state.view, activeView);
});

test("a session read from the host goes back to the server's stream once it runs elsewhere", async t => {
  const host = new FakeHost();
  const backend: Backend = { session: hosted, view: idleView, stream: "hold" };
  const live = await liveSession(t, backend, undefined, host);
  host.hosting = false;
  await live.advance(liveTiming.accessCheckMs);
  assert.equal(live.opens().length, 2, "Moved off this computer: the server's stream again");
  const reads = host.reads.length;
  await live.advance(liveTiming.accessCheckMs);
  assert.equal(host.reads.length, reads);
});

test("a session read from the host stops once its account's access is gone", async t => {
  const host = new FakeHost();
  const backend: Backend = { session: hosted, view: idleView, stream: "hold" };
  const live = await liveSession(t, backend, undefined, host);
  assert.deepEqual(live.state.view, idleView);
  backend.session = new ApiError(403, "forbidden", "You no longer have access to this session.");
  await live.advance(liveTiming.accessCheckMs);
  assert.equal(live.state.view, null);
  assert.equal(live.state.status, "offline");
  const after = host.reads.length;
  await live.advance(10 * liveTiming.localIdleMs);
  assert.equal(host.reads.length, after);
});

test("earlier entries of a session read from the host come from the host, and from the server where it can't read them", async t => {
  const entry = (n: number) => ({ id: `0:${n}`, kind: "message", role: "assistant", text: `entry ${n}`, conversationId: "0" });
  const paged = { ...idleView, approvals: [], entries: [entry(5), entry(6)], conversations: [{ id: "0", mode: "write", olderEntries: 4, previousEntryId: "0:4" }] } as unknown as SessionView;
  const host = new FakeHost();
  host.answer = () => ({ view: paged, revision: "5".repeat(32) });
  host.page = () => ({ entries: [entry(3), entry(4)] as unknown as SessionView["entries"], older: 2 });
  const backend: Backend = { session: hosted, view: idleView, stream: "hold", entries: () => ({ entries: [entry(1), entry(2)], older: 0 }) };
  const live = await liveSession(t, backend, undefined, host);
  await live.live.loadOlder("0");
  assert.deepEqual(host.pages, [{ conversation: "0", before: "0:5", limit: 50, brief: false }]);
  assert.deepEqual(live.state.view!.entries.map(item => item.id), ["0:3", "0:4", "0:5", "0:6"]);
  host.page = () => null;
  await live.live.loadOlder("0");
  assert.deepEqual(live.state.view!.entries.map(item => item.id), ["0:1", "0:2", "0:3", "0:4", "0:5", "0:6"]);
  assert.equal(live.requests.filter(request => request.path.includes("/entries?")).length, 1);
});
