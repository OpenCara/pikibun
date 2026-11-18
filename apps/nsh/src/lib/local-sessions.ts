import { untracked } from "nsh";
import type { LocalSessions, SessionRecord } from "../shared";
import { auth } from "./auth";
import { onClearDrafts } from "./drafts";
import { hostsHere, localHosts, type LocalHost } from "./this-computer";

const records = new Map<string, SessionRecord>();
const RECORDS = 500;
onClearDrafts(() => records.clear());

function signedInOrigin(): string | undefined {
  if (!hostsHere) return undefined;
  const signedIn = untracked(auth);
  return signedIn.status === "signedIn" && signedIn.origin ? signedIn.origin : undefined;
}

function runsHere(connectorId: string | undefined): boolean {
  const origin = signedInOrigin();
  return Boolean(origin && connectorId && untracked(() => localHosts().servingIds(origin)).includes(connectorId));
}

function servingHost(connectorId: string | undefined): LocalHost | undefined {
  const origin = signedInOrigin();
  return origin && connectorId ? localHosts().serving(origin, connectorId)?.host : undefined;
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
    if (!runsHere(session.connectorId) || session.viewable === false) {
      records.delete(session.id);
      return false;
    }
    remember(session);
    return true;
  },
  ran(sessionId) {
    const session = records.get(sessionId);
    return session && runsHere(session.connectorId) ? session : undefined;
  },
  view: async (sessionId, options) => (await servingHost(records.get(sessionId)?.connectorId)?.readView(sessionId, options)) ?? null,
  entries: async (sessionId, options) => (await servingHost(records.get(sessionId)?.connectorId)?.readEntries(sessionId, options)) ?? null,
} : undefined;

export function rememberLocalSessions(sessions: readonly SessionRecord[]): void {
  if (!localSessions) return;
  const origin = signedInOrigin();
  auth();
  if (!origin || !localHosts().servingIds(origin).length) return;
  for (const session of sessions) localSessions.runs(session);
}
