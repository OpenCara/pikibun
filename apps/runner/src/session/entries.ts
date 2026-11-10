import type { EntryRecord } from "@earendil-works/pi-durable";
import { entryImageLimits } from "../../../../packages/shared/src/entry-images.js";
import type { SessionView } from "../../../../packages/shared/src/types.js";
import type { autoApprovedCalls } from "../approval-view.js";
import type { Run } from "../session.js";

/*
 * How a session's transcript shows its entries and its runs' ends (RunnerSession.view): what leaves the host of each,
 * which is never image data, provider error text or Pi's own detail.
 */

/** What the transcript says after a run that the host's crashes ended (see RunnerSession.observeRun). */
export const CRASHED_TEXT = "Stopped: the host crashed repeatedly while working on this message. Send it again to retry.";

export function entryView(entry: EntryRecord, branch: number, actorId?: string, autoApproved?: ReturnType<typeof autoApprovedCalls>): SessionView["entries"][number] {
  const messages = entry.model ?? [];
  // Commands auto-approve ran have no card in the view: their calls say so instead.
  const marks = messages.flatMap(message => message.role !== "assistant" ? [] : message.content.flatMap(block => {
    const mark = block.type === "toolCall" ? autoApproved?.get(block.id) : undefined;
    return mark && block.type === "toolCall" ? [{ tool: block.name, ...mark }] : [];
  }));
  // Which call each result answers, so clients show a call and its result together (`EntryView.toolCalls`).
  const calls = messages.flatMap(message => message.role !== "assistant" ? []
    : message.content.flatMap(block => block.type === "toolCall" ? [{ id: callId(block.id), name: block.name }] : []));
  const result = toolResultOf(messages);
  const text = messages.flatMap(message => {
    if (typeof message.content === "string") return [message.content];
    // Image data stays on the host; the transcript only notes that the model saw one.
    return (message.content ?? []).flatMap(block => block.type === "text" ? [block.text] : block.type === "toolCall" ? [`${block.name}(${JSON.stringify(block.arguments)})`] : block.type === "image" ? [`[image ${block.mimeType}]`] : []);
  }).join("\n");
  // Their types, in that order, so a collaborator's client can ask for each (RunnerSession.entryImage).
  const images = entryImages(entry).slice(0, entryImageLimits.images).map(image => ({ mimeType: image.mimeType }));
  const failed = messages.find(message => message.role === "assistant" && message.stopReason === "error");
  // Provider error text can carry account or endpoint details; only the HTTP status leaves the host.
  const status = failed?.role === "assistant" ? Number(/^(\d{3})\b/.exec(failed.errorMessage ?? "")?.[1]) : NaN;
  const error = failed?.role === "assistant" ? {
    provider: String(failed.provider).slice(0, 128), modelId: String(failed.model).slice(0, 256), ...(status >= 100 && status <= 599 ? { status } : {}),
  } : undefined;
  // Pi measures the model's response for assistant messages and each tool run for tool results.
  const durations = messages.flatMap(message => (message.role === "assistant" || message.role === "toolResult") && message.durationMs !== undefined ? [message.durationMs] : []);
  const durationMs = durations.length ? durations.reduce((total, value) => total + value, 0) : undefined;
  return { id: `${branch}:${entry.id}`, kind: entry.kind, role: messages[0]?.role ?? "system", text, ...(actorId ? { actorId } : {}), conversationId: String(branch),
    ...(error ? { error } : {}), ...(durationMs !== undefined ? { durationMs } : {}), ...(marks.length ? { autoApproved: marks } : {}),
    ...(images.length ? { images } : {}), ...(calls.length ? { toolCalls: calls } : {}), ...(result ? { toolResult: result } : {}) };
}

/** A call's id as the view carries it: the provider's, which is short, kept short whatever it is. */
function callId(id: unknown): string {
  return String(id).slice(0, 256);
}

/** The call a tool result answers, its tool and whether it failed: only those, never its details. */
function toolResultOf(messages: NonNullable<EntryRecord["model"]>): SessionView["entries"][number]["toolResult"] {
  const message = messages.find(item => item.role === "toolResult");
  if (!message) return undefined;
  // Pi's tool result message, read as data: only what has the expected type leaves the host.
  const { toolCallId, toolName, isError } = message as unknown as { toolCallId?: unknown; toolName?: unknown; isError?: unknown };
  return {
    ...(typeof toolCallId === "string" && toolCallId ? { callId: callId(toolCallId) } : {}),
    ...(typeof toolName === "string" && toolName ? { tool: toolName.slice(0, 128) } : {}),
    ...(isError === true ? { error: true as const } : {}),
  };
}

/** The images an entry gave the model, as Pi keeps them (base64), in the order its view lists them. */
export function entryImages(entry: EntryRecord): { mimeType: string; data: string }[] {
  return (entry.model ?? []).flatMap(message => typeof message.content === "string" ? []
    : (message.content ?? []).flatMap(block => block.type === "image" ? [{ mimeType: block.mimeType, data: block.data }] : []));
}

/** What follows a run's entries: its failed model turn, who stopped it, or that its host's crashes ended it. */
export function endView(run: Run, branch: number): SessionView["entries"][number] | undefined {
  if (run.failure) return failureView(run, branch);
  if (run.stopped) return { id: `${branch}:stopped:${run.key}`, kind: "workspace.run-stopped", role: "system", text: "Stopped", actorId: run.stopped.by, conversationId: String(branch) };
  if (run.crashed) return { id: `${branch}:crashed:${run.key}`, kind: "workspace.run-crashed", role: "system", text: CRASHED_TEXT, conversationId: String(branch) };
  return undefined;
}

/** A message an extension's input handler refused (see `screen`): what its sender was told, where they sent it. */
export function refusedView(run: Run, branch: number): SessionView["entries"][number] {
  return { id: `${branch}:refused:${run.key}`, kind: "workspace.run-refused", role: "system", text: run.refused!.notice, actorId: run.initiatedBy, conversationId: String(branch) };
}

/**
 * A run Pi settled without an answer, shown as a failed model turn after its entries: provider and model, and which
 * fixed compaction failure it was, never Pi's detail.
 */
export function failureView(run: Run, branch: number): SessionView["entries"][number] {
  const { provider, modelId, compaction } = run.failure!;
  return { id: `${branch}:failure:${run.key}`, kind: "workspace.run-failure", role: "assistant", text: "", actorId: run.initiatedBy, conversationId: String(branch),
    error: { ...(provider ? { provider } : {}), ...(modelId ? { modelId } : {}), ...(compaction ? { compaction } : {}) } };
}
