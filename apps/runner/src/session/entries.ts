import type { EntryRecord } from "@earendil-works/pi-durable";
import { entryImageLimits } from "../../../../packages/shared/src/entry-images.js";
import type { SessionView } from "../../../../packages/shared/src/types.js";
import type { autoApprovedCalls } from "../approval-view.js";
import type { Run } from "../session.js";

export const CRASHED_TEXT = "Stopped: the host crashed repeatedly while working on this message. Send it again to retry.";

export function entryView(entry: EntryRecord, branch: number, actorId?: string, autoApproved?: ReturnType<typeof autoApprovedCalls>): SessionView["entries"][number] {
  const messages = entry.model ?? [];
  const marks = messages.flatMap(message => message.role !== "assistant" ? [] : message.content.flatMap(block => {
    const mark = block.type === "toolCall" ? autoApproved?.get(block.id) : undefined;
    return mark && block.type === "toolCall" ? [{ tool: block.name, ...mark }] : [];
  }));
  const text = messages.flatMap(message => {
    if (typeof message.content === "string") return [message.content];
    return (message.content ?? []).flatMap(block => block.type === "text" ? [block.text] : block.type === "toolCall" ? [`${block.name}(${JSON.stringify(block.arguments)})`] : block.type === "image" ? [`[image ${block.mimeType}]`] : []);
  }).join("\n");
  const images = entryImages(entry).slice(0, entryImageLimits.images).map(image => ({ mimeType: image.mimeType }));
  const failed = messages.find(message => message.role === "assistant" && message.stopReason === "error");
  const status = failed?.role === "assistant" ? Number(/^(\d{3})\b/.exec(failed.errorMessage ?? "")?.[1]) : NaN;
  const error = failed?.role === "assistant" ? {
    provider: String(failed.provider).slice(0, 128), modelId: String(failed.model).slice(0, 256), ...(status >= 100 && status <= 599 ? { status } : {}),
  } : undefined;
  const durations = messages.flatMap(message => (message.role === "assistant" || message.role === "toolResult") && message.durationMs !== undefined ? [message.durationMs] : []);
  const durationMs = durations.length ? durations.reduce((total, value) => total + value, 0) : undefined;
  return { id: `${branch}:${entry.id}`, kind: entry.kind, role: messages[0]?.role ?? "system", text, ...(actorId ? { actorId } : {}), conversationId: String(branch),
    ...(error ? { error } : {}), ...(durationMs !== undefined ? { durationMs } : {}), ...(marks.length ? { autoApproved: marks } : {}),
    ...(images.length ? { images } : {}) };
}

export function entryImages(entry: EntryRecord): { mimeType: string; data: string }[] {
  return (entry.model ?? []).flatMap(message => typeof message.content === "string" ? []
    : (message.content ?? []).flatMap(block => block.type === "image" ? [{ mimeType: block.mimeType, data: block.data }] : []));
}

export function endView(run: Run, branch: number): SessionView["entries"][number] | undefined {
  if (run.failure) return failureView(run, branch);
  if (run.stopped) return { id: `${branch}:stopped:${run.key}`, kind: "workspace.run-stopped", role: "system", text: "Stopped", actorId: run.stopped.by, conversationId: String(branch) };
  if (run.crashed) return { id: `${branch}:crashed:${run.key}`, kind: "workspace.run-crashed", role: "system", text: CRASHED_TEXT, conversationId: String(branch) };
  return undefined;
}

export function refusedView(run: Run, branch: number): SessionView["entries"][number] {
  return { id: `${branch}:refused:${run.key}`, kind: "workspace.run-refused", role: "system", text: run.refused!.notice, actorId: run.initiatedBy, conversationId: String(branch) };
}

export function failureView(run: Run, branch: number): SessionView["entries"][number] {
  const { provider, modelId, compaction } = run.failure!;
  return { id: `${branch}:failure:${run.key}`, kind: "workspace.run-failure", role: "assistant", text: "", actorId: run.initiatedBy, conversationId: String(branch),
    error: { ...(provider ? { provider } : {}), ...(modelId ? { modelId } : {}), ...(compaction ? { compaction } : {}) } };
}
