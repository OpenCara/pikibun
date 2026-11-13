export type LogLine = (line: string) => void;

export const stderrLine: LogLine = line => { process.stderr.write(`${line}\n`); };

const plain = (text: string, limit: number) => text.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, limit);

function shown(value: unknown): string {
  try { return String(value); } catch { return typeof value; }
}

function described(error: unknown): string {
  if (!(error instanceof Error)) return plain(shown(error), 500);
  const header = error.message ? `${error.name}: ${error.message}` : error.name;
  const rest = typeof error.stack === "string" && error.stack.startsWith(header) ? error.stack.slice(header.length) : "";
  const frames = rest.split("\n").map(line => plain(line, 300).trim()).filter(Boolean).slice(0, 20);
  return [plain(header, 500), ...frames.map(frame => `    ${frame}`)].join("\n");
}

export function describeFailure(error: unknown): string {
  const text = described(error);
  const cause = error instanceof Error ? error.cause : undefined;
  return cause === undefined ? text : `${text}\nCaused by: ${described(cause)}`;
}

export class FailureLog {
  readonly #last = new Map<string, number>();

  constructor(private readonly write: LogLine = stderrLine, private readonly quietMs = 60_000, private readonly now: () => number = () => performance.now()) {}

  report(context: string, error: unknown): void {
    const text = `${plain(context, 300)}: ${describeFailure(error)}`;
    const at = this.now();
    const last = this.#last.get(text);
    if (last !== undefined && at - last < this.quietMs) return;
    this.#last.delete(text);
    while (this.#last.size >= 1000) this.#last.delete(this.#last.keys().next().value!);
    this.#last.set(text, at);
    this.write(text);
  }
}
