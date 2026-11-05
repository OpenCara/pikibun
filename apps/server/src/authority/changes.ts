import type { AppContext } from '../types.js';

/*
 * How the authority tells the rest of the server that it changed what a session shows. The relay's view feeds
 * (view-feed.ts) listen, so nobody is served a view fetched before the change; the authority itself never reaches into
 * them.
 */

export type SessionChangeListener = (c: AppContext, sessionId: string) => void;

const listeners = new Set<SessionChangeListener>();

/** Calls `listener` each time the authority changes something a session's view shows. Adding it again changes nothing. */
export function onSessionChange(listener: SessionChangeListener): void {
  listeners.add(listener);
}

/** Tells every listener that the session changed. */
export function sessionChanged(c: AppContext, sessionId: string): void {
  for (const listener of listeners) listener(c, sessionId);
}
