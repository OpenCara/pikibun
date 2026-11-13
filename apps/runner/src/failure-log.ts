export type LogLine = (line: string) => void;

export const stderrLine: LogLine = line => { process.stderr.write(`${line}\n`); };

const plain = (text: string, limit: number) => text.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, " ").slice(0, limit);

function described(error: unknown): string {
  if (!(error instanceof Error)) return plain(String(error), 500);
  const stack = typeof error.stack === "string" && error.stack.includes(error.message) ? error.stack : `${error.name}: ${error.message}`;
  return plain(stack, 4000);
}

export function describeFailure(error: unknown): string {
  const text = described(error);
  const cause = error instanceof Error ? error.cause : undefined;
  return cause === undefined ? text : `${text}\nCaused by: ${described(cause)}`;
}

export class FailureLog {
  readonly #last = new Map<string, number>();

  constructor(private readonly write: LogLine = stderrLine, private readonly quietMs = 60_000, private readonly now: () => number = Date.now) {}

  report(context: string, error: unknown): void {
    const text = `${plain(context, 300)}: ${describeFailure(error)}`;
    const key = text.split("\n", 1)[0]!;
    const at = this.now();
    const last = this.#last.get(key);
    if (last !== undefined && at - last < this.quietMs) return;
    if (this.#last.size >= 1000) this.#last.clear();
    this.#last.set(key, at);
    this.write(text);
  }
}
