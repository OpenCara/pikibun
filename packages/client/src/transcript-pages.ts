import type { EntryView, SessionView } from "../../shared/src/types";

export type EarlierEntries = ReadonlyMap<string, readonly EntryView[]>;

function entriesOf(view: SessionView | null, conversationId: string): EntryView[] {
  return (view?.entries ?? []).filter(entry => entry.conversationId === conversationId);
}

export function carryEarlier(earlier: EarlierEntries, previous: SessionView | null, next: SessionView): EarlierEntries {
  const kept = new Map<string, readonly EntryView[]>();
  for (const conversation of next.conversations ?? []) {
    const older = conversation.olderEntries ?? 0;
    if (older <= 0 || !conversation.previousEntryId) continue;
    const window = entriesOf(previous, conversation.id);
    const first = entriesOf(next, conversation.id)[0]?.id;
    const at = window.findIndex(entry => entry.id === first);
    const slid = at < 0 ? window : window.slice(0, at);
    const candidate = [...(earlier.get(conversation.id) ?? []), ...slid];
    if (!candidate.length || candidate.length > older || candidate.at(-1)!.id !== conversation.previousEntryId) continue;
    kept.set(conversation.id, candidate);
  }
  return kept;
}

export function withEarlier(view: SessionView, earlier: EarlierEntries): SessionView {
  if (!earlier.size) return view;
  const entries: EntryView[] = [];
  const placed = new Set<string>();
  for (const entry of view.entries) {
    const id = entry.conversationId;
    const held = id === undefined ? undefined : earlier.get(id);
    if (id !== undefined && held && !placed.has(id)) {
      entries.push(...held);
      placed.add(id);
    }
    entries.push(entry);
  }
  return {
    ...view, entries,
    conversations: view.conversations.map(conversation => {
      const held = earlier.get(conversation.id);
      if (!held) return conversation;
      const { olderEntries: _older, previousEntryId: _previous, ...rest } = conversation;
      const left = (conversation.olderEntries ?? 0) - held.length;
      return left > 0 ? { ...rest, olderEntries: left } : rest;
    }),
  };
}

export function firstHeld(view: SessionView, earlier: EarlierEntries, conversationId: string): string | undefined {
  return earlier.get(conversationId)?.[0]?.id ?? entriesOf(view, conversationId)[0]?.id;
}
