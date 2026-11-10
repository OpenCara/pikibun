import type { ApprovalRecord } from "../../../packages/shared/src/types.js";

/** A tool call's operation, as the session keeps it: what ran, as whom, and its outcome, which the tool call returns. */
export type StoredApproval = ApprovalRecord & { callId?: string };

export function settled(approval: ApprovalRecord): boolean {
  return approval.status !== "executing";
}
