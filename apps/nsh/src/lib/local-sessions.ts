import { untracked } from "nsh";
import type { LocalSessions, SessionRecord } from "../shared";
import { auth } from "./auth";
import { onClearDrafts } from "./drafts";
import { hostsHere, thisComputer } from "./this-computer";

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
    if (!host || session.connectorId !== host || session.viewable === false) {
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

export function rememberLocalSessions(sessions: readonly SessionRecord[]): void {
  if (!localSessions) return;
  thisComputer().running();
  auth();
  if (!hostHere()) return;
  for (const session of sessions) localSessions.runs(session);
}
