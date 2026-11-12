import { defineDoc } from "@earendil-works/pi-durable";
import type { ChatOptions, CompactionFailure, ModelFailureCause, RunnerBinding } from "../../../../packages/shared/src/types.js";
import type { StoredApproval } from "../approval-view.js";

export type Run = {
  key: string; initiatedBy: string; ownerId: string; mode: "write" | "ask";
  conversationId: number; content: string; contentHash: string; submissionId?: number;
  status: "queued" | "admitting" | "running" | "settled" | "interrupted"; startEntry: number;
  sequence?: number;
  started?: boolean;
  admissionId?: string;
  submittedAt?: number;
  options?: ChatOptions;
  images?: { count: number; bytes: number };
  inputsLost?: true;
  failure?: { reason: "model_error" | "no_model" | "compaction_failed"; provider?: string; modelId?: string; compaction?: CompactionFailure;
    cause?: ModelFailureCause; compacting?: true };
  stopped?: { by: string; pending?: true };
  crashed?: true;
  screening?: true;
  refused?: { by: string; notice: string };
  reverted?: true;
  withdrawn?: true;
  steered?: string;
};
export type Branch = { id: number; mode: "write" | "ask"; actorId?: string; superseded?: true };
export type Metadata = { binding: RunnerBinding; branches: Branch[]; runs: Record<string, Run>; approvals: Record<string, StoredApproval>; toolActors: Record<string, { initiatedBy: string; ownerId: string; runKey: string; callId?: string }>; usedTickets?: Record<string, number>; nextSequence?: number;
  grants?: unknown;
  conversationOnlyRestore?: true;
  forkedFrom?: { sessionId: string; entryId: string } };
export const RunnerState = defineDoc<{ json: string }>({ kind: "workspace.runner", version: 1, scope: "session", initial: () => ({ json: "" }), checkpointWhen: () => true });

export function tellsActivity(run: Run): boolean {
  return !run.reverted && !run.withdrawn;
}

export function holdsQueue(run: Run): boolean {
  return ["queued", "running", "admitting"].includes(run.status) || run.stopped?.pending === true;
}
