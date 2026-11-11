import type { ApprovalRecord } from "../../../packages/shared/src/types.js";

export type StoredApproval = ApprovalRecord & { callId?: string };

export function settled(approval: ApprovalRecord): boolean {
  return approval.status !== "executing";
}
