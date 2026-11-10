import type { AppContext } from '../types.js';

export type SessionChangeListener = (c: AppContext, sessionId: string) => void;

const listeners = new Set<SessionChangeListener>();

export function onSessionChange(listener: SessionChangeListener): void {
  listeners.add(listener);
}

export function sessionChanged(c: AppContext, sessionId: string): void {
  for (const listener of listeners) listener(c, sessionId);
}
