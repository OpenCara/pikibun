import type { CallOutcome, EntryView } from "../../shared/src/types";
import { splitToolCalls } from "../../shared/src/transcript";
import { callArguments, callTarget, readable, resultBody, resultSummary, type ResultSummary } from "../../shared/src/tool-summary";

export interface PairedTranscript {
  entries: EntryView[];
  results: ReadonlyMap<string, readonly (EntryView | undefined)[]>;
}

export function pairToolResults(entries: readonly EntryView[]): PairedTranscript {
  const shown: EntryView[] = [];
  const results = new Map<string, (EntryView | undefined)[]>();
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    shown.push(entry);
    if (entry.role !== "assistant" || typeof entry.text !== "string") continue;
    const calls = splitToolCalls(entry.text).calls;
    if (!calls.length) continue;
    const ids = callIds(entry, calls.length);
    const answered: (EntryView | undefined)[] = calls.map(() => undefined);
    let next = index + 1;
    for (; next < entries.length; next++) {
      const result = entries[next]!;
      if (result.role !== "toolResult" || result.conversationId !== entry.conversationId) break;
      const callId = result.toolResult?.callId;
      const slot = ids && callId !== undefined ? ids.indexOf(callId) : answered.indexOf(undefined);
      if (slot >= 0 && answered[slot] === undefined) answered[slot] = result;
      else shown.push(result);
    }
    index = next - 1;
    results.set(entry.id, answered);
  }
  return { entries: shown, results };
}

export interface ToolCallRow {
  key: string;
  name: string;
  target: string;
  args: string;
  result?: EntryView;
  outcome?: ResultSummary;
  autoApproved?: CallOutcome;
}

function callMarks(names: readonly string[], ids: readonly string[] | undefined, marks: EntryView["autoApproved"]): (CallOutcome | undefined)[] {
  const shown: (CallOutcome | undefined)[] = names.map(() => undefined);
  if (!Array.isArray(marks)) return shown;
  if (ids && marks.every(mark => typeof mark.callId === "string")) {
    for (const mark of marks) {
      const index = ids.indexOf(mark.callId!);
      if (index >= 0 && shown[index] === undefined) shown[index] = mark;
    }
    return shown;
  }
  let next = 0;
  names.forEach((name, index) => {
    if (marks[next]?.tool === name) shown[index] = marks[next++];
  });
  return shown;
}

function callIds(entry: EntryView, count: number): string[] | undefined {
  return Array.isArray(entry.toolCalls) && entry.toolCalls.length === count ? entry.toolCalls.map(call => call.id) : undefined;
}

export function toolCallRows(entry: EntryView, results: readonly (EntryView | undefined)[] = []): ToolCallRow[] {
  const calls = splitToolCalls(entry.text).calls;
  const marks = callMarks(calls.map(call => call.name), callIds(entry, calls.length), entry.autoApproved);
  return calls.map((call, index) => {
    const args = callArguments(call.line);
    const result = results[index];
    const mark = marks[index];
    return {
      key: `${entry.id}#${index}`, name: call.name, target: callTarget(call.name, args), args: args ? readable(args) : call.line,
      ...(result ? { result, outcome: resultOutcome(result) } : {}), ...(mark ? { autoApproved: mark } : {}),
    };
  });
}

export function resultOutcome(result: EntryView): ResultSummary {
  const error = result.toolResult?.error === true;
  if (result.trimmed) return { text: result.text, failed: error };
  return resultSummary(result.text, { error, tool: result.toolResult?.tool });
}

export function resultOutput(result: EntryView, text = result.text): string {
  return result.trimmed ? text : resultBody(text, { tool: result.toolResult?.tool });
}

export function callHeadline(name: string, target: string): string {
  if (!target) return name;
  return target === name || target.startsWith(`${name} `) ? target : `${name} · ${target}`;
}
