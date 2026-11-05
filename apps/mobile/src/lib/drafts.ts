import { useEffect, useState } from "react";

/**
 * The unsent text of each session's chat box, kept until it is sent, so switching to another session and back finds it
 * where it was left. Also how a first message that could not be sent after its session was created (or restarted)
 * reaches that session's chat box, like the web's localStorage draft. Kept in memory only: unsent prompts never touch
 * disk, so they last until the app is closed.
 */
const drafts = new Map<string, string>();

/** Chat boxes open on a session, told when a draft of theirs was sent and forgotten. */
const listeners = new Map<string, Set<(sent: string) => void>>();

/** Remembers the text, or forgets it once the box is empty. */
export function saveDraft(sessionId: string, text: string) {
  if (text) drafts.set(sessionId, text);
  else drafts.delete(sessionId);
}

export function readDraft(sessionId: string): string {
  return drafts.get(sessionId) ?? "";
}

/**
 * Forgets a draft that was just sent, unless it has been edited since, and empties any chat box open on that session
 * that still shows it. Done here, not through the sending box's state: that box may have unmounted (another session
 * opened, maybe this one again) while the message was in flight.
 */
export function forgetSentDraft(sessionId: string, sent: string) {
  if (drafts.get(sessionId) === sent) drafts.delete(sessionId);
  for (const listener of listeners.get(sessionId) ?? []) listener(sent);
}

/** Chat boxes open on a session, handed text that comes back to them (see restoreDraft). */
const restorers = new Map<string, Set<(merge: (current: string) => string) => void>>();

/**
 * Puts text back into a session's chat box, below anything typed there: a message taken back by going back to before
 * it. Open boxes of the session take it at once and remember it as their draft; with none open, the draft keeps it for
 * the next one.
 */
export function restoreDraft(sessionId: string, text: string) {
  const merge = (current: string) => current.trim() ? `${current}\n\n${text}` : text;
  const open = restorers.get(sessionId);
  if (open?.size) for (const restore of open) restore(merge);
  else saveDraft(sessionId, merge(readDraft(sessionId)));
}

/**
 * A session's chat box text: starts from its draft, is remembered as it changes, drops a sent text when told, and takes
 * text handed back to it (see restoreDraft).
 */
export function useDraft(sessionId: string) {
  const [initial] = useState(() => readDraft(sessionId));
  const [content, setContent] = useState(initial);
  // Listening starts before the text is remembered, so a send that finished in between is seen, not written back over.
  useEffect(() => {
    const drop = (sent: string) => setContent(current => current === sent ? "" : current);
    const own = listeners.get(sessionId) ?? new Set();
    own.add(drop);
    listeners.set(sessionId, own);
    const restore = (merge: (current: string) => string) => setContent(merge);
    const restoring = restorers.get(sessionId) ?? new Set();
    restoring.add(restore);
    restorers.set(sessionId, restoring);
    // A send that finished between this box reading its draft and listening: catch up with what is stored now.
    const stored = readDraft(sessionId);
    if (stored !== initial) setContent(current => current === initial ? stored : current);
    return () => {
      own.delete(drop);
      if (!own.size) listeners.delete(sessionId);
      restoring.delete(restore);
      if (!restoring.size) restorers.delete(sessionId);
    };
  }, [sessionId, initial]);
  useEffect(() => { saveDraft(sessionId, content); }, [sessionId, content]);
  return [content, setContent] as const;
}
