import { untracked } from "nsh";
import type { LocalSessions, SessionRecord } from "../shared";
import { auth } from "./auth";
import { onClearDrafts } from "./drafts";
import { hostsHere, thisComputer } from "./this-computer";

// Sessions the server said this computer's host runs, for the account signed in: their views are read from that host
// first, and still while the server can't be reached (docs/design/local-views.md). Forgotten with the account.
const records = new Map<string, SessionRecord>();
const RECORDS = 500;
onClearDrafts(() => records.clear());

const originOf = (value: string) => { try { return new URL(value).origin; } catch { return ""; } };

function hostHere(): string | undefined {
  if (!hostsHere) return undefined;
  const serving = thisComputer().serving();
  const signedIn = untracked(auth);
  if (!serving || signedIn.status !== "signedIn" || !signedIn.origin || originOf(serving.server) !== originOf(signedIn.origin)) return undefined;
  return serving.connectorId;
}

function remember(session: SessionRecord): void {
  records.delete(session.id);
  records.set(session.id, session);
  for (const oldest of records.keys()) {
    if (records.size <= RECORDS) break;
    records.delete(oldest);
  }
}

export const localSessions: LocalSessions | undefined = hostsHere ? {
  runs(session) {
    const host = hostHere();
    if (!host || session.connectorId !== host) {
      records.delete(session.id);
      return false;
    }
    remember(session);
    return true;
  },
  ran(sessionId) {
    const session = records.get(sessionId);
    const host = hostHere();
    return session && host && session.connectorId === host ? session : undefined;
  },
  view: (sessionId, options) => thisComputer().readView(sessionId, options),
  entries: (sessionId, options) => thisComputer().readEntries(sessionId, options),
} : undefined;

/** Remembers, from the server's list, which sessions this computer's host runs, so that they open from it first. */
export function rememberLocalSessions(sessions: readonly SessionRecord[]): void {
  if (!localSessions || !hostHere()) return;
  for (const session of sessions) if (session.viewable !== false) localSessions.runs(session);
}
