import type { EntryView, SessionRecord, SessionView } from "../../shared/src/types";
import { transcriptPage } from "../../shared/src/transcript-display";
import { applyViewPatch, isViewPatch } from "../../shared/src/view-patch";
import { ApiError, errorMessage, segment } from "./api";
import { carryEarlier, firstHeld, withEarlier, type EarlierEntries } from "./transcript-pages";

export type StreamStatus = "connecting" | "online" | "reconnecting" | "offline";

export const activeStatuses = ["queued", "admitting", "running"];

/**
 * The server ends every /events stream after a few view snapshots, and every stream and fetch costs a request (a
 * client retrying a session whose host was offline used to send thousands an hour). Streams therefore reopen
 * quickly only while a run is active, slowly while the session is idle, with doubling backoff after streams that end
 * without a snapshot, and never while the app or page is hidden.
 */
export const liveTiming = {
  activeReopenMs: 1_000,
  idleReopenMs: 10_000,
  firstBackoffMs: 2_000,
  maxBackoffMs: 60_000,
  accessCheckMs: 30_000,
} as const;

/** The parts of EventSource a live session uses. Browsers pass an EventSource; native apps a fetch-based stream (see sse.ts). */
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

/** A session's view as this client last showed it, and its revision. */
export interface CachedView {
  view: SessionView;
  revision?: string;
}

/**
 * Views of sessions this client showed, so reopening one shows it again at once (see startLiveSession). It must belong
 * to one signed-in account: clear it whenever another account signs in or the account signs out.
 */
export interface ViewCache {
  get(sessionId: string): CachedView | undefined;
  set(sessionId: string, value: CachedView): void;
  delete(sessionId: string): void;
  clear(): void;
}

/** A view cache holding the `limit` sessions shown most recently. */
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

export interface LiveSessionDependencies {
  api<T>(path: string, options: { signal: AbortSignal }): Promise<T>;
  /** Opens the session's /events stream; `path` starts with /api/. */
  openEvents(path: string): EventStream;
  /** The page is hidden or the app is in the background: no streams then. */
  hidden(): boolean;
  onVisibilityChange(listener: () => void): () => void;
  /** The signed-in account's views of the sessions it opened before; none are kept without one. */
  cache?: ViewCache;
}

export interface LiveSession {
  /** Reloads now and looks for new work right away, e.g. after the user sends a message. */
  refresh(): void;
  /**
   * Reads a page of a conversation's earlier entries, for a view that says it has some (`olderEntries`, in a workspace
   * that loads transcripts latest first), and shows the view with them. Resolves once shown, or once there is nothing
   * to read; a failure is reported through `error`.
   */
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
  /** Set by refresh() while a stream is open: that stream may predate the change, so look again right after it. */
  let followUp = false;
  let loading = false;
  let pending: boolean | undefined;
  let revoked = false;
  /**
   * The view held and its revision: streams send only what changed since it. A cached view is held from the start, so
   * the first stream asks only for what changed since, but it is shown only once the session's metadata says the view
   * is the viewer's to read now (`viewable`), or a stream brings it up to date (which the server checks as it does).
   */
  const cached = dependencies.cache?.get(id);
  let current: SessionView | null = cached?.view ?? null;
  let revision: string | undefined = cached?.revision;
  /** Whether a view was shown: the cached one waits for the metadata, which rechecks access to it. */
  let shown = false;
  /** Earlier entries read for a paged view, which streams never send again. */
  let earlier: EarlierEntries = new Map();
  const reading = new Map<string, Promise<void>>();
  const running = () => !revoked && !controller.signal.aborted;

  function showView(view: SessionView, at?: string) {
    earlier = carryEarlier(earlier, current, view);
    current = view;
    revision = typeof at === "string" ? at : undefined;
    shown = true;
    dependencies.cache?.set(id, { view, revision });
    // A cache host preparing repositories reports progress worth showing every second, even before any message.
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
    try {
      const page = await dependencies.api<{ entries: EntryView[]; older: number }>(`${base}/entries?${query}`, { signal: controller.signal });
      // A newer view may have moved the window while the page loaded: the page joins only the entry it was read before.
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

  /**
   * The server refuses the view although the session is still the viewer's to read (its host's owner stopped sharing
   * the host, say): the transcript goes, here and from the cache, and the session stays to say why.
   */
  function forgetView() {
    dependencies.cache?.delete(id);
    current = null;
    revision = undefined;
    earlier = new Map();
    if (!shown) return;
    shown = false;
    handlers.view(null);
  }

  function revoke() {
    // Do not keep a previously authorized transcript visible after access is revoked.
    revoked = true;
    current = null;
    revision = undefined;
    earlier = new Map();
    dependencies.cache?.delete(id);
    closeStream();
    cancelReopen();
    handlers.session(null);
    handlers.view(null);
    handlers.status("offline");
  }

  /** Session metadata (which rechecks access) and, when asked, the committed view; overlapping calls coalesce. */
  async function load(withView: boolean): Promise<void> {
    if (!running()) return;
    if (loading) { pending = pending === true || withView; return; }
    loading = true;
    let checkingAccess = true;
    try {
      const metadata = await dependencies.api<{ session: SessionRecord }>(base, { signal: controller.signal });
      checkingAccess = false;
      if (!running()) return;
      handlers.session(metadata.session);
      // The server says whether it would serve the view now. A refused view goes; a kept one goes up at once once the
      // server says it may, and the stream brings it up to date. A server that doesn't say leaves it to the stream.
      if (metadata.session.viewable === false) forgetView();
      else if (!shown && current && metadata.session.viewable === true) showView(current, revision);
      if (!withView) return;
      const snapshot = await dependencies.api<{ view: SessionView; revision?: string }>(`${base}/view`, { signal: controller.signal });
      if (running()) showView(snapshot.view, snapshot.revision);
    } catch (reason) {
      if (!running()) return;
      handlers.error(errorMessage(reason));
      if (reason instanceof ApiError && [401, 403, 404].includes(reason.status)) {
        if (checkingAccess) revoke();
        // The view itself was refused (403 connector_unavailable, say), not the session: only the transcript goes. A
        // failure that may pass (an offline host) keeps it, and the cache.
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
    if (!running() || dependencies.hidden() || stream) return;
    const opened = dependencies.openEvents(`${base}/events?since=${revision ?? ""}`);
    stream = opened;
    let delivered = false;
    const deliver = (view: SessionView, at: string | undefined) => {
      delivered = true;
      failures = 0;
      handlers.status("online");
      showView(view, at);
    };
    // Snapshots carry the same checked view as GET /view, so they render without a refetch.
    opened.addEventListener("view", event => {
      if (stream !== opened || !running()) return;
      let snapshot: { view?: SessionView; revision?: string } | null;
      try { snapshot = JSON.parse(String(event.data)) as { view?: SessionView; revision?: string } | null; } catch { return; }
      if (!snapshot?.view) return;
      deliver(snapshot.view, snapshot.revision);
    });
    // What changed since the revision this client holds; nothing at all while the session is quiet.
    opened.addEventListener("patch", event => {
      if (stream !== opened || !running()) return;
      let patch: unknown;
      try { patch = (JSON.parse(String(event.data)) as { patch?: unknown } | null)?.patch; } catch { return; }
      if (!isViewPatch(patch) || !current || patch.base !== revision) {
        // Not ours to apply: the next stream starts again from a whole view.
        revision = undefined;
        return;
      }
      let view: SessionView;
      try { view = applyViewPatch(current, patch); } catch { revision = undefined; return; }
      deliver(view, patch.revision);
    });
    // EventSource reports the end of every stream as an error, including the Worker's normal close.
    opened.addEventListener("error", () => {
      if (stream !== opened) return;
      closeStream();
      if (!running()) return;
      const eager = followUp;
      followUp = false;
      if (delivered) return schedule(active || eager ? liveTiming.activeReopenMs : liveTiming.idleReopenMs);
      failures++;
      handlers.status("reconnecting");
      // Explain the failure (an offline host, lost access) once per failed stream.
      void load(true);
      schedule(Math.min(liveTiming.maxBackoffMs, liveTiming.firstBackoffMs * 2 ** (failures - 1)));
    });
  }

  const stopVisibility = dependencies.onVisibilityChange(() => {
    if (!running()) return;
    if (dependencies.hidden()) {
      cancelReopen();
      closeStream();
      return;
    }
    void load(false);
    openStream();
  });
  // Revalidate access even when a quiet session produces no snapshots.
  const accessTimer = setInterval(() => { if (!dependencies.hidden()) void load(false); }, liveTiming.accessCheckMs);
  // The metadata (which checks access) and the stream at once: the stream's first snapshot is the whole view (or what
  // changed since a cached one), so no GET /view waits between them. A stream that fails reads /view to say why.
  void load(false);
  openStream();

  return {
    refresh() {
      // The view comes from the stream: a /view fetch racing it could land last and show an older state.
      void load(false);
      if (stream) followUp = true;
      else openStream();
    },
    loadOlder(conversationId) {
      // One read per conversation at a time: scrolling asks again and again while one is on its way.
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
      clearInterval(accessTimer);
      stopVisibility();
    },
  };
}
