import { cleanup, effect, signal, type Signal } from "nsh";
import { restoredDraft } from "../shared";

const drafts = new Map<string, string>();
const listeners = new Map<string, Set<(sent: string) => void>>();
const restorers = new Map<string, Set<(merge: (current: string) => string) => void>>();

const clearers = new Set<() => void>();
export function onClearDrafts(clear: () => void) {
  clearers.add(clear);
}

export function clearDrafts() {
  drafts.clear();
  listeners.clear();
  restorers.clear();
  for (const clear of clearers) clear();
}

export const newSessionDraftId = (workspaceId: string) => `new:${workspaceId}`;

export function saveDraft(sessionId: string, text: string) {
  if (text) drafts.set(sessionId, text);
  else drafts.delete(sessionId);
}

export function readDraft(sessionId: string): string {
  return drafts.get(sessionId) ?? "";
}

export function forgetSentDraft(sessionId: string, sent: string) {
  if (drafts.get(sessionId) === sent) drafts.delete(sessionId);
  for (const listener of listeners.get(sessionId) ?? []) listener(sent);
}

export function restoreDraft(sessionId: string, text: string) {
  if (!text.trim()) return;
  const merge = (current: string) => restoredDraft(current, text);
  const open = restorers.get(sessionId);
  if (open?.size) for (const restore of open) restore(merge);
  else saveDraft(sessionId, merge(readDraft(sessionId)));
}

export function createDraft(sessionId: string): Signal<string> {
  const content = signal(readDraft(sessionId));
  const drop = (sent: string) => content.update(current => (current === sent ? "" : current));
  const restore = (merge: (current: string) => string) => content.update(merge);
  const own = listeners.get(sessionId) ?? new Set();
  own.add(drop);
  listeners.set(sessionId, own);
  const restoring = restorers.get(sessionId) ?? new Set();
  restoring.add(restore);
  restorers.set(sessionId, restoring);
  cleanup(() => {
    own.delete(drop);
    if (!own.size) listeners.delete(sessionId);
    restoring.delete(restore);
    if (!restoring.size) restorers.delete(sessionId);
  });
  effect(() => saveDraft(sessionId, content()));
  return content;
}
