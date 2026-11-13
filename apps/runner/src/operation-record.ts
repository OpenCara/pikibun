import type { OperationRecord } from "../../../packages/shared/src/types.js";

export type StoredOperation = OperationRecord & { callId?: string };

export function settled(record: OperationRecord): boolean {
  return record.status !== "executing";
}
