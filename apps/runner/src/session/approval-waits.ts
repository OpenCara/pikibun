import type { ApprovalRecord } from "../../../../packages/shared/src/types.js";
import { settled } from "../approval-view.js";

export function answered(approval: ApprovalRecord): boolean {
  return settled(approval) || (approval.operation.kind === "extension.tool" && approval.status === "approved");
}

export function boundedResult(value: string): string {
  if (value.length <= 8000) return value;
  return `${value.slice(0, 2000)}\n… ${value.length - 7500} characters omitted …\n${value.slice(-5500)}`;
}

export class ApprovalWaits {
  readonly #waiters = new Map<string, PromiseWithResolvers<ApprovalRecord>>();
  readonly #wholeResults = new Map<string, string>();

  waiter(id: string): PromiseWithResolvers<ApprovalRecord> {
    let waiter = this.#waiters.get(id);
    if (!waiter) this.#waiters.set(id, waiter = Promise.withResolvers<ApprovalRecord>());
    return waiter;
  }

  waiting(id: string): boolean {
    return this.#waiters.has(id);
  }

  forget(id: string): void {
    this.#waiters.delete(id);
  }

  settle(approvals: Readonly<Record<string, ApprovalRecord>>): void {
    if (!this.#waiters.size) return;
    for (const [id, waiter] of this.#waiters) {
      const approval = approvals[id];
      if (!approval || !answered(approval)) continue;
      this.#waiters.delete(id);
      waiter.resolve(approval);
    }
  }

  dropWaiters(): void {
    this.#waiters.clear();
  }

  dropResults(): void {
    this.#wholeResults.clear();
  }

  kept(id: string, result: string): string {
    const bounded = boundedResult(result);
    if (bounded === result) this.#wholeResults.delete(id);
    else this.#wholeResults.set(id, result);
    return bounded;
  }

  whole(approval: ApprovalRecord): ApprovalRecord {
    const result = this.#wholeResults.get(approval.id);
    if (result === undefined || !settled(approval)) return approval;
    this.#wholeResults.delete(approval.id);
    return { ...approval, result };
  }
}
