import { cleanup, effect, signal, untracked, type Accessor } from "nsh";
import { lifecycle } from "./lifecycle";
import { openFetchEventStream, startLiveSession, type SessionRecord, type SessionView, type StreamStatus } from "../shared";
import { session as signedIn } from "./auth";
import { inBackground } from "./resource";

export interface LiveSessionState {
  session: Accessor<SessionRecord | null>;
  view: Accessor<SessionView | null>;
  error: Accessor<string>;
  status: Accessor<StreamStatus>;
  refresh: () => void;
  loadOlder: (conversationId: string) => Promise<void>;
  reconnect: () => void;
}

/**
 * The session's metadata and live view over its /events stream, read with NSH's streaming fetch (its runtime has no
 * EventSource). Native platforms send the bearer token; the web sends the page's own cookies.
 */
export function createLiveSession(id: string): LiveSessionState {
  const session = signal<SessionRecord | null>(null);
  const view = signal<SessionView | null>(null);
  const error = signal("");
  const status = signal<StreamStatus>("connecting");
  const revision = signal(0);
  let refreshNow = () => {};
  let loadOlderNow = async (_conversationId: string) => {};
  // Visibility listeners, told when the app goes to or comes back from the background.
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
