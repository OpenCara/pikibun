import type { ApprovalRecord, AutoApprovedCall } from "../../../packages/shared/src/types.js";

export type StoredApproval = ApprovalRecord & { callId?: string };

export function settled(approval: ApprovalRecord): boolean {
  return approval.operation.kind === "permission" ? approval.status !== "pending" : !["pending", "approved", "executing"].includes(approval.status);
}

export const VIEW_SETTLED_APPROVALS = 50;
export const VIEW_SETTLED_RESULT = 1000;

function inTranscript(approval: ApprovalRecord): boolean {
  return approval.automatic === true && (approval.operation.kind === "bash" || approval.operation.kind === "program" || approval.operation.kind === "host.bash");
}

function excerpt(result: string): string {
  if (result.length <= VIEW_SETTLED_RESULT) return result;
  return `${result.slice(0, 250)}\n… ${result.length - 900} characters omitted …\n${result.slice(-650)}`;
}

export function viewApprovals(stored: readonly StoredApproval[]): { approvals: ApprovalRecord[]; olderApprovals: number } {
  const byId = new Map(stored.map(approval => [approval.id, approval]));
  const permissions = new Map<string, NonNullable<ApprovalRecord["permission"]>>();
  const folded = new Set<string>();
  for (const approval of stored) {
    const call = /^permission-(.+)$/.exec(approval.id)?.[1];
    const operation = call === undefined ? undefined : byId.get(`tool-${call}`);
    if (!operation || inTranscript(operation) || approval.operation.kind !== "permission" || approval.status !== "approved" || !approval.decidedBy) continue;
    permissions.set(operation.id, { decidedBy: approval.decidedBy, ...(approval.scope ? { scope: approval.scope } : {}) });
    folded.add(approval.id);
  }
  let keep = VIEW_SETTLED_APPROVALS;
  let olderApprovals = 0;
  const approvals: ApprovalRecord[] = [];
  for (let index = stored.length - 1; index >= 0; index--) {
    const { callId: _callId, ...approval } = stored[index]!;
    if (inTranscript(approval) || folded.has(approval.id)) continue;
    const done = settled(approval);
    if (done && keep === 0) { olderApprovals++; continue; }
    if (done) keep--;
    const permission = permissions.get(approval.id);
    approvals.push({ ...approval, ...(done && approval.result !== undefined ? { result: excerpt(approval.result) } : {}), ...(permission ? { permission } : {}) });
  }
  return { approvals: approvals.reverse(), olderApprovals };
}

export function autoApprovedCalls(stored: readonly StoredApproval[]): Map<string, Omit<AutoApprovedCall, "tool">> {
  const calls = new Map<string, Omit<AutoApprovedCall, "tool">>();
  for (const approval of stored) {
    if (inTranscript(approval) && approval.callId) calls.set(approval.callId, { status: approval.status, ...(approval.unbounded ? { unbounded: true as const } : {}) });
  }
  return calls;
}
