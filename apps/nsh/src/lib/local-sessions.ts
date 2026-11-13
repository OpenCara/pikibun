import { untracked } from "nsh";
import type { LocalSessions, SessionRecord } from "../shared";
import { auth } from "./auth";
import { onClearDrafts } from "./drafts";
import { computerHosts, hostsHere, type ThisComputerHost } from "./this-computer";

const records = new Map<string, SessionRecord>();
const RECORDS = 500;
onClearDrafts(() => records.clear());

function servingHere(): { host: ThisComputerHost; connectorId: string } | undefined {
  if (!hostsHere) return undefined;
  const signedIn = untracked(auth);
  if (signedIn.status !== "signedIn" || !signedIn.origin) return undefined;
  return computerHosts().serving(signedIn.origin);
}

function hostHere(): string | undefined {
  return servingHere()?.connectorId;
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
  view: async (sessionId, options) => (await servingHere()?.host.readView(sessionId, options)) ?? null,
  entries: async (sessionId, options) => (await servingHere()?.host.readEntries(sessionId, options)) ?? null,
} : undefined;

export function rememberLocalSessions(sessions: readonly SessionRecord[]): void {
  if (!localSessions) return;
  for (const host of computerHosts().all()) host.running();
  auth();
  if (!hostHere()) return;
  for (const session of sessions) localSessions.runs(session);
}
