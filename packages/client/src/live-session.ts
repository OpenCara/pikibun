import type { EntryView, SessionRecord, SessionView } from "../../shared/src/types";
import { transcriptPage } from "../../shared/src/transcript-display";
import { applyViewPatch, isViewPatch, type SessionViewPatch } from "../../shared/src/view-patch";
import { ApiError, errorMessage, segment } from "./api";
import { carryEarlier, firstHeld, withEarlier, type EarlierEntries } from "./transcript-pages";

export type StreamStatus = "connecting" | "online" | "reconnecting" | "offline";

export const activeStatuses = ["queued", "admitting", "running"];

export const liveTiming = {
  activeReopenMs: 1_000,
  idleReopenMs: 10_000,
  firstBackoffMs: 2_000,
  maxBackoffMs: 60_000,
  accessCheckMs: 30_000,
  localActiveMs: 500,
  localIdleMs: 1_500,
  localRetryMs: 30_000,
} as const;

export interface EventStream {
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
  close(): void;
}

export interface LiveSessionHandlers {
  session(session: SessionRecord | null): void;
  view(view: SessionView | null): void;
  error(message: string): void;
  status(status: StreamStatus): void;
}

export interface CachedView {
  view: SessionView;
  revision?: string;
}

export interface ViewCache {
  get(sessionId: string): CachedView | undefined;
  set(sessionId: string, value: CachedView): void;
  delete(sessionId: string): void;
  clear(): void;
}

export function createViewCache(limit = 8): ViewCache {
  const views = new Map<string, CachedView>();
  return {
    get(sessionId) {
      const value = views.get(sessionId);
      if (value) { views.delete(sessionId); views.set(sessionId, value); }
      return value;
    },
    set(sessionId, value) {
      views.delete(sessionId);
      views.set(sessionId, value);
      for (const oldest of views.keys()) {
        if (views.size <= limit) break;
        views.delete(oldest);
      }
    },
    delete(sessionId) { views.delete(sessionId); },
    clear() { views.clear(); },
  };
}

export type LocalViewReply = { view: SessionView; revision: string } | { patch: SessionViewPatch };

export interface LocalSessions {
  runs(session: SessionRecord): boolean;
  ran(sessionId: string): SessionRecord | undefined;
  view(sessionId: string, options: { since?: string; brief: boolean }): Promise<LocalViewReply | null>;
  entries(sessionId: string, options: { conversation: string; before: string; limit: number; brief: boolean }): Promise<{ entries: EntryView[]; older: number } | null>;
}

export interface LiveSessionDependencies {
  api<T>(path: string, options: { signal: AbortSignal }): Promise<T>;
  openEvents(path: string): EventStream;
  hidden(): boolean;
  onVisibilityChange(listener: () => void): () => void;
  cache?: ViewCache;
  local?: LocalSessions;
}

export interface LiveSession {
  refresh(): void;
  loadOlder(conversationId: string): Promise<void>;
  stop(): void;
}

export function startLiveSession(id: string, handlers: LiveSessionHandlers, dependencies: LiveSessionDependencies): LiveSession {
  const controller = new AbortController();
  const base = `/api/sessions/${segment(id)}`;
  let stream: EventStream | null = null;
  let cancelReopen = () => {};
  let failures = 0;
  let active = false;
  let followUp = false;
  let loading = false;
  let pending: boolean | undefined;
  let revoked = false;
  const cached = dependencies.cache?.get(id);
  let current: SessionView | null = cached?.view ?? null;
  let revision: string | undefined = cached?.revision;
  let shown = false;
  let earlier: EarlierEntries = new Map();
  const reading = new Map<string, Promise<void>>();
  const running = () => !revoked && !controller.signal.aborted;
  const local = dependencies.local;
  let here: SessionRecord | undefined;
  let hereEpoch = 0;
  let readingHere = false;
  let cancelHere = () => {};
  let herePaused = false;
  let cancelPause = () => {};
  let confirmed = false;
  let held: LocalViewReply | null = null;
  const brief = (record: SessionRecord) => record.toolOutput === "brief";

  function showView(view: SessionView, at?: string) {
    earlier = carryEarlier(earlier, current, view);
    current = view;
    revision = typeof at === "string" ? at : undefined;
    shown = true;
    dependencies.cache?.set(id, { view, revision });
    active = view.busy || (view.queue ?? []).some(item => activeStatuses.includes(item.status)) || view.repositories?.status === "preparing";
    handlers.view(withEarlier(view, earlier));
    handlers.error("");
  }

  async function readOlder(conversationId: string): Promise<void> {
    const view = current;
    const conversation = view?.conversations?.find(item => item.id === conversationId);
    const left = (conversation?.olderEntries ?? 0) - (earlier.get(conversationId)?.length ?? 0);
    const before = view && firstHeld(view, earlier, conversationId);
    if (!running() || !view || left <= 0 || !before) return;
    const query = `conversation=${encodeURIComponent(conversationId)}&before=${encodeURIComponent(before)}&limit=${transcriptPage.size}`;
    const record = here;
    try {
      const page = (record && local ? await local.entries(id, { conversation: conversationId, before, limit: transcriptPage.size, brief: brief(record) }).catch(() => null) : null)
        ?? await dependencies.api<{ entries: EntryView[]; older: number }>(`${base}/entries?${query}`, { signal: controller.signal });
      if (!running() || !current || firstHeld(current, earlier, conversationId) !== before || !Array.isArray(page?.entries)) return;
      const held = earlier.get(conversationId) ?? [];
      const next = new Map(earlier);
      next.set(conversationId, [...page.entries, ...held]);
      earlier = next;
      handlers.view(withEarlier(current, earlier));
    } catch (reason) {
      if (running()) handlers.error(errorMessage(reason));
    }
  }

  function closeStream() {
    stream?.close();
    stream = null;
  }

  function forgetView() {
    dependencies.cache?.delete(id);
    current = null;
    revision = undefined;
    earlier = new Map();
    if (!shown) return;
    shown = false;
    handlers.view(null);
  }

  function scheduleHere(delay: number) {
    cancelHere();
    if (!running() || !here || dependencies.hidden()) return;
    const timer = setTimeout(() => void readHere(), delay);
    cancelHere = () => clearTimeout(timer);
  }

  async function readHere(): Promise<void> {
    cancelHere();
    const record = here;
    const epoch = hereEpoch;
    if (!running() || !record || !local || dependencies.hidden() || readingHere) return;
    readingHere = true;
    let reply: LocalViewReply | null;
    try { reply = await local.view(id, { ...(revision ? { since: revision } : {}), brief: brief(record) }); }
    catch { reply = null; }
    finally { readingHere = false; }
    if (!running() || epoch !== hereEpoch) return;
    if (!reply) { leaveHere(true); return; }
    if (!confirmed) { held = reply; return; }
    applyHere(reply);
  }

  function confirmHere() {
    confirmed = true;
    const reply = held;
    held = null;
    if (reply && here) applyHere(reply);
  }

  function applyHere(reply: LocalViewReply) {
    if ("patch" in reply) {
      let view: SessionView | undefined;
      if (current && isViewPatch(reply.patch) && reply.patch.base === revision) {
        try { view = applyViewPatch(current, reply.patch); } catch { view = undefined; }
      }
      if (!view) { revision = undefined; scheduleHere(0); return; }
      showView(view, reply.patch.revision);
    } else showView(reply.view, reply.revision);
    failures = 0;
    handlers.status("online");
    scheduleHere(active ? liveTiming.localActiveMs : liveTiming.localIdleMs);
  }

  function readFromHere(record: SessionRecord): boolean {
    if (!local || herePaused || record.viewable === false) return false;
    const switching = !here;
    here = record;
    if (!switching) return true;
    hereEpoch++;
    closeStream();
    cancelReopen();
    revision = undefined;
    void readHere();
    return true;
  }

  function leaveHere(pause: boolean) {
    if (!here) return;
    here = undefined;
    held = null;
    hereEpoch++;
    cancelHere();
    revision = undefined;
    if (pause) {
      herePaused = true;
      const timer = setTimeout(() => { herePaused = false; }, liveTiming.localRetryMs);
      cancelPause = () => clearTimeout(timer);
    }
    if (running()) openStream();
  }

  function revoke() {
    revoked = true;
    current = null;
    revision = undefined;
    earlier = new Map();
    dependencies.cache?.delete(id);
    here = undefined;
    held = null;
    cancelHere();
    closeStream();
    cancelReopen();
    handlers.session(null);
    handlers.view(null);
    handlers.status("offline");
  }

  async function load(withView: boolean): Promise<void> {
    if (!running()) return;
    if (loading) { pending = pending === true || withView; return; }
    loading = true;
    let checkingAccess = true;
    try {
      const metadata = await dependencies.api<{ session: SessionRecord }>(base, { signal: controller.signal });
      checkingAccess = false;
      if (!running()) return;
      confirmed = true;
      handlers.session(metadata.session);
      const onHost = metadata.session.viewable !== false && local?.runs(metadata.session) === true;
      if (!onHost) leaveHere(false);
      if (metadata.session.viewable === false) forgetView();
      else if (!shown && current && metadata.session.viewable === true) showView(current, revision);
      if (onHost && readFromHere(metadata.session)) { confirmHere(); return; }
      if (!withView) return;
      const snapshot = await dependencies.api<{ view: SessionView; revision?: string }>(`${base}/view`, { signal: controller.signal });
      if (running()) showView(snapshot.view, snapshot.revision);
    } catch (reason) {
      if (!running()) return;
      const denied = reason instanceof ApiError && [401, 403, 404].includes(reason.status);
      const known = denied ? undefined : local?.ran(id);
      if ((here && !denied) || (known && readFromHere(known))) { confirmHere(); return; }
      handlers.error(errorMessage(reason));
      if (denied) {
        if (checkingAccess) revoke();
        else forgetView();
      }
    } finally {
      loading = false;
      if (pending !== undefined && running()) {
        const next = pending;
        pending = undefined;
        void load(next);
      }
    }
  }

  function schedule(delay: number) {
    cancelReopen();
    if (!running() || dependencies.hidden()) return;
    const timer = setTimeout(openStream, delay);
    cancelReopen = () => clearTimeout(timer);
  }

  function openStream() {
    cancelReopen();
    if (!running() || dependencies.hidden() || stream || here) return;
    const opened = dependencies.openEvents(`${base}/events?since=${revision ?? ""}`);
    stream = opened;
    let delivered = false;
    const deliver = (view: SessionView, at: string | undefined) => {
      delivered = true;
      failures = 0;
      handlers.status("online");
      showView(view, at);
    };
    opened.addEventListener("view", event => {
      if (stream !== opened || !running()) return;
      let snapshot: { view?: SessionView; revision?: string } | null;
      try { snapshot = JSON.parse(String(event.data)) as { view?: SessionView; revision?: string } | null; } catch { return; }
      if (!snapshot?.view) return;
      deliver(snapshot.view, snapshot.revision);
    });
    opened.addEventListener("patch", event => {
      if (stream !== opened || !running()) return;
      let patch: unknown;
      try { patch = (JSON.parse(String(event.data)) as { patch?: unknown } | null)?.patch; } catch { return; }
      if (!isViewPatch(patch) || !current || patch.base !== revision) {
        revision = undefined;
        return;
      }
      let view: SessionView;
      try { view = applyViewPatch(current, patch); } catch { revision = undefined; return; }
      deliver(view, patch.revision);
    });
    opened.addEventListener("error", () => {
      if (stream !== opened) return;
      closeStream();
      if (!running()) return;
      const eager = followUp;
      followUp = false;
      if (delivered) return schedule(active || eager ? liveTiming.activeReopenMs : liveTiming.idleReopenMs);
      failures++;
      handlers.status("reconnecting");
      void load(true);
      schedule(Math.min(liveTiming.maxBackoffMs, liveTiming.firstBackoffMs * 2 ** (failures - 1)));
    });
  }

  const stopVisibility = dependencies.onVisibilityChange(() => {
    if (!running()) return;
    if (dependencies.hidden()) {
      cancelReopen();
      closeStream();
      cancelHere();
      return;
    }
    void load(false);
    if (here) void readHere();
    else openStream();
  });
  const accessTimer = setInterval(() => { if (!dependencies.hidden()) void load(false); }, liveTiming.accessCheckMs);
  void load(false);
  const known = local?.ran(id);
  if (!known || !readFromHere(known)) openStream();

  return {
    refresh() {
      void load(false);
      if (here) void readHere();
      else if (stream) followUp = true;
      else openStream();
    },
    loadOlder(conversationId) {
      let pending = reading.get(conversationId);
      if (!pending) {
        pending = readOlder(conversationId).finally(() => reading.delete(conversationId));
        reading.set(conversationId, pending);
      }
      return pending;
    },
    stop() {
      controller.abort();
      closeStream();
      cancelReopen();
      cancelHere();
      cancelPause();
      clearInterval(accessTimer);
      stopVisibility();
    },
  };
}
