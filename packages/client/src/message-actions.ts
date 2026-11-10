import type { EntryView, SessionView } from "../../shared/src/types";
import { splitToolCalls } from "../../shared/src/transcript";
import { withoutImageLines } from "../../shared/src/entry-images";

export type MessageCut = { entryId: string; before: boolean };

const HOST_ENTRY = /^\d{1,15}:\d{1,15}$/;

export function messageCut(entry: EntryView): MessageCut | undefined {
  if (!HOST_ENTRY.test(entry.id)) return undefined;
  if (entry.role === "user") return { entryId: entry.id, before: true };
  if (entry.role !== "assistant" || splitToolCalls(entry.text).calls.length > 0) return undefined;
  return { entryId: entry.id, before: false };
}

export function rewindable(view: Pick<SessionView, "rewindable">): boolean {
  return view.rewindable === true;
}

export function resendText(entry: EntryView): string {
  return withoutImageLines(entry.text).trim();
}

export function restoredDraft(draft: string, text: string): string {
  if (!text.trim()) return draft;
  return draft.trim() ? `${draft}\n\n${text}` : text;
}

export function copyText(entry: EntryView): string {
  return entry.role === "assistant" ? splitToolCalls(entry.text).prose.trim() : entry.text;
}
