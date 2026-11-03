import type { ApprovalRecord } from "../../../../packages/shared/src/types.js";
import { settled } from "../approval-view.js";

/**
 * Whether the tool call waiting on `approval` goes on: once it settled, or, for an extension's tool call, which runs it
 * itself, once it is approved.
 */
export function answered(approval: ApprovalRecord): boolean {
  return settled(approval) || (approval.operation.kind === "extension.tool" && approval.status === "approved");
}

/**
 * The control plane rejects approval results above 8192 characters, so the approval record keeps the start and the
 * (usually decisive) end of a longer one. The tool call waiting on it still returns the whole output to the agent
 * (see ApprovalWaits.whole).
 */
export function boundedResult(value: string): string {
  if (value.length <= 8000) return value;
  return `${value.slice(0, 2000)}\n… ${value.length - 7500} characters omitted …\n${value.slice(-5500)}`;
}

/*
 * What a session's tool calls wait on while their cards are decided and run, held in memory only: a call that outlives
 * its runner process is interrupted anyway.
 * - Waiters, by approval id: a tool call waits on its card until it is answered; the session hands each committed state
 *   of its ledger to `settle`, which wakes the calls whose cards it answers.
 * - Whole results: an operation's record keeps only an excerpt of a long result (boundedResult), which backups, views and
 *   the control plane get; the whole of it waits here until the tool call returns it to the agent.
 */
export class ApprovalWaits {
  readonly #waiters = new Map<string, PromiseWithResolvers<ApprovalRecord>>();
  readonly #wholeResults = new Map<string, string>();

  /** The waiter of card `id`, made if it has none yet: registered before the card is, so a decision never misses its call. */
  waiter(id: string): PromiseWithResolvers<ApprovalRecord> {
    let waiter = this.#waiters.get(id);
    if (!waiter) this.#waiters.set(id, waiter = Promise.withResolvers<ApprovalRecord>());
    return waiter;
  }

  /** Whether a tool call waits on card `id`. */
  waiting(id: string): boolean {
    return this.#waiters.has(id);
  }

  /** Card `id`'s call no longer waits (it was answered already, or the call stopped). */
  forget(id: string): void {
    this.#waiters.delete(id);
  }

  /** Wakes the calls whose cards `approvals` (a committed state) answers. */
  settle(approvals: Readonly<Record<string, ApprovalRecord>>): void {
    if (!this.#waiters.size) return;
    for (const [id, waiter] of this.#waiters) {
      const approval = approvals[id];
      if (!approval || !answered(approval)) continue;
      this.#waiters.delete(id);
      waiter.resolve(approval);
    }
  }

  /** As the session closes: its calls end with its harness, and their cards are marked interrupted on reopen. */
  dropWaiters(): void {
    this.#waiters.clear();
  }

  /** As the session closes: no call is left to return a whole result to. */
  dropResults(): void {
    this.#wholeResults.clear();
  }

  /** `result` as the approval record keeps it; the whole of a longer one waits for the tool call (see `whole`). */
  kept(id: string, result: string): string {
    const bounded = boundedResult(result);
    if (bounded === result) this.#wholeResults.delete(id);
    else this.#wholeResults.set(id, result);
    return bounded;
  }

  /** `approval` with its whole result, for the tool call returning it to the agent; the result is then let go. */
  whole(approval: ApprovalRecord): ApprovalRecord {
    const result = this.#wholeResults.get(approval.id);
    if (result === undefined || !settled(approval)) return approval;
    this.#wholeResults.delete(approval.id);
    return { ...approval, result };
  }
}
