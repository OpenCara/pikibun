import type { OperationRecord } from "../../../../packages/shared/src/types.js";
import { settled } from "../operation-record.js";

export function boundedResult(value: string): string {
  if (value.length <= 8000) return value;
  return `${value.slice(0, 2000)}\n… ${value.length - 7500} characters omitted …\n${value.slice(-5500)}`;
}

export class WholeResults {
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

  whole(record: OperationRecord): OperationRecord {
    const result = this.#wholeResults.get(record.id);
    if (result === undefined || !settled(record)) return record;
    this.#wholeResults.delete(record.id);
    return { ...record, result };
  }
}
