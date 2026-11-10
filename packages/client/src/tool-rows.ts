import type { AutoApprovedCall, EntryView } from "../../shared/src/types";
import { splitToolCalls } from "../../shared/src/transcript";
import { callArguments, callTarget, readable, resultBody, resultSummary, type ResultSummary } from "../../shared/src/tool-summary";

/*
 * The transcript's tool calls, each with the result that answered it: one row per call, which says what the call worked
 * on and what came of it. Hosts write a call into its assistant entry and its result as the next entries; newer hosts
 * name the call each result answers (`EntryView.toolCalls`, `toolResult`), and older ones' results follow their calls
 * in the same order.
 */

/** The listed entries, without the results their calls show, and each call's result by its entry. */
export interface PairedTranscript {
  /** Every entry but the results shown with their calls. */
  entries: EntryView[];
  /** A listed assistant entry's results, by its id, in call order: undefined for a call no result answered (yet). */
  results: ReadonlyMap<string, readonly (EntryView | undefined)[]>;
}

/**
 * Pairs each assistant entry's tool calls with the results that follow it in its conversation: by the call's id where
 * both name it, in order otherwise. A result no call of the entry before it claims stays an entry of its own (one whose
 * call is on an earlier page, say).
 */
export function pairToolResults(entries: readonly EntryView[]): PairedTranscript {
  const shown: EntryView[] = [];
  const results = new Map<string, (EntryView | undefined)[]>();
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    shown.push(entry);
    if (entry.role !== "assistant" || typeof entry.text !== "string") continue;
    const calls = splitToolCalls(entry.text).calls;
    if (!calls.length) continue;
    const ids = Array.isArray(entry.toolCalls) && entry.toolCalls.length === calls.length ? entry.toolCalls.map(call => call.id) : undefined;
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

/** One tool call as its row shows it. */
export interface ToolCallRow {
  /** Unique in the transcript: its entry's id and its place there. */
  key: string;
  name: string;
  /** What it works on, on one line: its command line, file or search; "" where its arguments say nothing more. */
  target: string;
  /** Its arguments as people read them; its call line where they don't parse. */
  args: string;
  /** The result that answered it, where one did. */
  result?: EntryView;
  /** What came of it, on one line, and whether it failed; undefined while no result answered it. */
  outcome?: ResultSummary;
  /** Its run under auto-approve, where it had one. */
  autoApproved?: AutoApprovedCall;
}

/**
 * Which of `names`' calls each auto-approve mark is: the marks follow the calls' order and name their tools, so each
 * goes to the next call of its tool.
 */
function callMarks(names: readonly string[], marks: EntryView["autoApproved"]): (AutoApprovedCall | undefined)[] {
  const shown: (AutoApprovedCall | undefined)[] = names.map(() => undefined);
  if (!Array.isArray(marks)) return shown;
  let next = 0;
  names.forEach((name, index) => {
    if (marks[next]?.tool === name) shown[index] = marks[next++];
  });
  return shown;
}

/** An assistant entry's tool calls, each with the result `results` pairs it with. */
export function toolCallRows(entry: EntryView, results: readonly (EntryView | undefined)[] = []): ToolCallRow[] {
  const calls = splitToolCalls(entry.text).calls;
  const marks = callMarks(calls.map(call => call.name), entry.autoApproved);
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

/** What came of a tool call, from its result: in brief tool output, the result's text is already that line. */
export function resultOutcome(result: EntryView): ResultSummary {
  const error = result.toolResult?.error === true;
  if (result.trimmed) return { text: result.text, failed: error };
  return resultSummary(result.text, { error });
}

/** A tool result as people read it, opened (`resultBody`): in brief tool output, the line it is. */
export function resultOutput(result: EntryView, text = result.text): string {
  return result.trimmed ? text : resultBody(text);
}

/** The line a call's row shows: its tool and what it works on, the tool's name once where its command line starts with it. */
export function callHeadline(name: string, target: string): string {
  if (!target) return name;
  return target === name || target.startsWith(`${name} `) ? target : `${name} · ${target}`;
}
