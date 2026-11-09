import { cleanup, effect, signal, type Signal } from "nsh";
import { restoredDraft } from "../shared";

/**
 * The unsent text of each session's chat box, kept until it is sent, so switching to another session and back finds it
 * where it was left. Kept in memory only, as in the Expo app: unsent prompts never touch disk.
 */
const drafts = new Map<string, string>();
/** Chat boxes open on a session, told when a draft of theirs was sent and forgotten. */
const listeners = new Map<string, Set<(sent: string) => void>>();
/** Chat boxes open on a session, handed text that comes back to them (see restoreDraft). */
const restorers = new Map<string, Set<(merge: (current: string) => string) => void>>();

/** What else goes with the drafts (a chat box's kept attachments, say), registered by the modules that keep it. */
const clearers = new Set<() => void>();
export function onClearDrafts(clear: () => void) {
  clearers.add(clear);
}

/**
 * Forgets every draft and every chat box's hooks: they belong to the account that typed them, so they go when it signs
 * out, its sign-in ends, or another account signs in (auth.ts), and the next person never sees them.
 */
export function clearDrafts() {
  drafts.clear();
  listeners.clear();
  restorers.clear();
  for (const clear of clearers) clear();
}

/** The draft of the new-session screen in a workspace: its unsent first message, kept as a session's chat box's is. */
export const newSessionDraftId = (workspaceId: string) => `new:${workspaceId}`;

export function saveDraft(sessionId: string, text: string) {
  if (text) drafts.set(sessionId, text);
  else drafts.delete(sessionId);
}

export function readDraft(sessionId: string): string {
  return drafts.get(sessionId) ?? "";
}

/** Forgets a draft that was just sent, unless it has been edited since, and empties any chat box still showing it. */
export function forgetSentDraft(sessionId: string, sent: string) {
  if (drafts.get(sessionId) === sent) drafts.delete(sessionId);
  for (const listener of listeners.get(sessionId) ?? []) listener(sent);
}

/** Puts text back into a session's chat box, below anything typed there (a message taken back by going back). */
export function restoreDraft(sessionId: string, text: string) {
  if (!text.trim()) return;
  const merge = (current: string) => restoredDraft(current, text);
  const open = restorers.get(sessionId);
  if (open?.size) for (const restore of open) restore(merge);
  else saveDraft(sessionId, merge(readDraft(sessionId)));
}

/** A session's chat box text: starts from its draft, is remembered as it changes, drops a sent text when told. */
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
