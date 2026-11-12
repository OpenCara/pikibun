import { cleanup, effect, lifecycle, signal, untracked, type Accessor } from "nsh";
import { createViewCache, openFetchEventStream, startLiveSession, type SessionRecord, type SessionView, type StreamStatus } from "../shared";
import { session as signedIn } from "./auth";
import { onClearDrafts } from "./drafts";
import { inBackground } from "./resource";

const viewCache = createViewCache(8);
onClearDrafts(() => viewCache.clear());

export interface LiveSessionState {
  session: Accessor<SessionRecord | null>;
  view: Accessor<SessionView | null>;
  error: Accessor<string>;
  status: Accessor<StreamStatus>;
  refresh: () => void;
  loadOlder: (conversationId: string) => Promise<void>;
  reconnect: () => void;
}

export function createLiveSession(id: string): LiveSessionState {
  const session = signal<SessionRecord | null>(null);
  const view = signal<SessionView | null>(null);
  const error = signal("");
  const status = signal<StreamStatus>("connecting");
  const revision = signal(0);
  let refreshNow = () => {};
  let loadOlderNow = async (_conversationId: string) => {};
  const visibility = new Set<() => void>();
  effect(() => {
    lifecycle();
    for (const listener of [...visibility]) listener();
  });
  effect(() => {
    revision();
    const { api, origin, token } = untracked(signedIn);
    status.set("connecting");
    const live = startLiveSession(id, { session: value => session.set(value), view: value => view.set(value), error: value => error.set(value), status: value => status.set(value) }, {
      api,
      openEvents: path => openFetchEventStream({
        fetch: (url, init) => fetch(url, token ? init : { ...init, credentials: "same-origin" }),
        url: `${origin && token ? origin : ""}${path}`,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      }),
      hidden: inBackground,
      cache: viewCache,
      onVisibilityChange(listener) {
        visibility.add(listener);
        return () => visibility.delete(listener);
      },
    });
    refreshNow = live.refresh;
    loadOlderNow = live.loadOlder;
    cleanup(() => { live.stop(); refreshNow = () => {}; loadOlderNow = async () => {}; });
  });
  return {
    session, view, error, status,
    refresh: () => refreshNow(),
    loadOlder: conversationId => loadOlderNow(conversationId),
    reconnect: () => revision.update(value => value + 1),
  };
}
