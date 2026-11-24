export class ReportDigest {
  #report = "";
  #digest: string | undefined;
  #sent = 0;

  constructor(private readonly everyMs = 60_000) {}

  due(report: string, at = Date.now()): boolean {
    return report !== this.#report || at - this.#sent > this.everyMs;
  }

  async send(report: string, post: (body: { sessions: unknown[] } | { digest: string }) => Promise<unknown>, at = Date.now()): Promise<void> {
    const known = report === this.#report ? this.#digest : undefined;
    this.#digest = undefined;
    let answer = known ? await post({ digest: known }).catch(() => ({ resend: true })) : undefined;
    if (!known || resend(answer)) answer = await post({ sessions: JSON.parse(report) as unknown[] });
    this.#report = report;
    this.#digest = digestOf(answer);
    this.#sent = at;
  }
}

function resend(answer: unknown): boolean {
  return !!answer && typeof answer === "object" && (answer as { resend?: unknown }).resend === true;
}

function digestOf(answer: unknown): string | undefined {
  const digest = answer && typeof answer === "object" ? (answer as { digest?: unknown }).digest : undefined;
  return typeof digest === "string" && digest.length > 0 && digest.length <= 128 ? digest : undefined;
}
