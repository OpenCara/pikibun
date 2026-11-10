import type { ApprovalRecord } from "../../../../packages/shared/src/types.js";
import { settled } from "../approval-view.js";

export function boundedResult(value: string): string {
  if (value.length <= 8000) return value;
  return `${value.slice(0, 2000)}\n… ${value.length - 7500} characters omitted …\n${value.slice(-5500)}`;
}

/** The whole results of operations whose kept record is cut short, until their tool call takes them. */
export class ApprovalWaits {
  readonly #wholeResults = new Map<string, string>();

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
