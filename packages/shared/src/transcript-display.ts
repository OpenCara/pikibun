import { briefCallLine, resultSummary } from "./tool-summary.js";
import { transcriptLines } from "./transcript.js";
import type { EntryView, SessionView } from "./types.js";

export type ToolOutput = "full" | "brief";
export const toolOutputs: readonly ToolOutput[] = ["full", "brief"];

export interface TranscriptDisplay {
  toolOutput: ToolOutput;
  paging: boolean;
}
export const fullTranscript: TranscriptDisplay = { toolOutput: "full", paging: false };

export const briefChars = 200;
export const transcriptPage = { size: 50, max: 200 } as const;

export function characters(text: string): number {
  let count = text.length;
  for (let index = 0; index < text.length - 1; index++) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { count--; index++; }
    }
  }
  return count;
}

function cut(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const points = Array.from(text.slice(0, limit * 2 + 2));
  return points.length > limit ? `${points.slice(0, limit).join("")}…` : text;
}

export function briefEntry(entry: EntryView): EntryView {
  const text = typeof entry.text === "string" ? entry.text : "";
  if (entry.role === "toolResult") {
    const lines = text.split("\n");
    const summary = resultSummary(text, { error: entry.toolResult?.error === true, tool: entry.toolResult?.tool });
    const shown = cut(summary.text, briefChars);
    const { images, ...rest } = entry;
    const failed = summary.failed && entry.toolResult?.error !== true;
    if (shown === text && !failed) return images === undefined ? entry : rest;
    return { ...rest, ...(failed ? { toolResult: { ...entry.toolResult, error: true as const } } : {}), text: shown,
      ...(shown === text ? {} : { trimmed: { lines: lines.length, chars: characters(text) } }) };
  }
  if (entry.role !== "assistant") return entry;
  let changed = false;
  const shown = transcriptLines(text).map(({ line, tool }) => {
    if (tool === undefined) return line;
    const args = line.slice(tool.length + 1, -1);
    if (characters(args) <= briefChars) return line;
    changed = true;
    return briefCallLine(tool, line, briefChars * 2) ?? `${tool}(${cut(args, briefChars)}})`;
  });
  return changed ? { ...entry, text: shown.join("\n"), trimmed: { lines: shown.length, chars: characters(text) } } : entry;
}

function listed(view: SessionView): Set<string> {
  return new Set((view.conversations ?? []).map(conversation => conversation.id));
}

export function latestEntries(view: SessionView, size: number = transcriptPage.size): SessionView {
  const conversations = listed(view);
  const counts = new Map<string, number>();
  for (const entry of view.entries) {
    const id = entry.conversationId;
    if (id !== undefined && conversations.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  if (![...counts.values()].some(count => count > size)) return view;
  const seen = new Map<string, number>();
  const previous = new Map<string, string>();
  const entries = view.entries.filter(entry => {
    const id = entry.conversationId;
    if (id === undefined || !conversations.has(id)) return true;
    const index = seen.get(id) ?? 0;
    seen.set(id, index + 1);
    if (index >= counts.get(id)! - size) return true;
    previous.set(id, entry.id);
    return false;
  });
  return {
    ...view, entries,
    conversations: view.conversations.map(conversation => {
      const older = (counts.get(conversation.id) ?? 0) - size;
      return older > 0 ? { ...conversation, olderEntries: older, previousEntryId: previous.get(conversation.id)! } : conversation;
    }),
  };
}

export function entriesBefore(view: SessionView, conversationId: string, before: string, limit: number): { entries: EntryView[]; older: number } | null {
  if (!listed(view).has(conversationId)) return null;
  const entries = view.entries.filter(entry => entry.conversationId === conversationId);
  const index = entries.findIndex(entry => entry.id === before);
  if (index < 0) return null;
  const start = Math.max(0, index - limit);
  return { entries: entries.slice(start, index), older: start };
}
