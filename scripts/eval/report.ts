export type RunOutcome = "pass" | "fail" | "timeout" | "error";

export interface RunResult {
  run: number;
  outcome: RunOutcome;
  detail: string;
  seconds: number;
  sessionId?: string;
  toolCalls?: number;
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  cost?: number;
  contextTokens?: number;
}

export interface TaskResult { id: string; title: string; runs: RunResult[] }

export interface EvalResult {
  version: 1;
  label?: string;
  model: string;
  thinkingLevel?: string;
  commit?: string;
  host: { platform: string; node: string; sandbox: false };
  startedAt: string;
  finishedAt: string;
  runsPerTask: number;
  tasks: TaskResult[];
}

export type TaskStatus = "pass" | "flaky" | "fail" | "error";
export type FlipKind = "regressed" | "improved" | "same" | "new" | "removed" | "unknown";

export interface Flip {
  id: string;
  kind: FlipKind;
  before?: { status: TaskStatus; passes: number; counted: number };
  after?: { status: TaskStatus; passes: number; counted: number };
}

export function tally(task: TaskResult): { status: TaskStatus; passes: number; counted: number; errors: number } {
  const counted = task.runs.filter(run => run.outcome !== "error");
  const passes = counted.filter(run => run.outcome === "pass").length;
  const status: TaskStatus = !counted.length ? "error" : passes === counted.length ? "pass" : passes === 0 ? "fail" : "flaky";
  return { status, passes, counted: counted.length, errors: task.runs.length - counted.length };
}

const rank: Record<TaskStatus, number> = { pass: 2, flaky: 1, fail: 0, error: -1 };

export function compare(previous: EvalResult, current: EvalResult): Flip[] {
  const before = new Map(previous.tasks.map(task => [task.id, tally(task)]));
  const flips: Flip[] = current.tasks.map(task => {
    const after = tally(task);
    const was = before.get(task.id);
    before.delete(task.id);
    if (!was) return { id: task.id, kind: "new", after };
    const kind: FlipKind = was.status === "error" || after.status === "error" ? "unknown"
      : rank[after.status] < rank[was.status] ? "regressed" : rank[after.status] > rank[was.status] ? "improved" : "same";
    return { id: task.id, kind, before: was, after };
  });
  for (const [id, was] of before) flips.push({ id, kind: "removed", before: was });
  return flips;
}

export function regressions(flips: readonly Flip[]): string[] {
  return flips.filter(flip => flip.kind === "regressed").map(flip => flip.id);
}

function median(values: readonly number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function mean(values: readonly number[]): number | undefined {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : undefined;
}

function count(value: number | undefined): string {
  if (value === undefined) return "–";
  return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(2)}M` : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(Math.round(value));
}

function money(value: number | undefined): string {
  return value === undefined ? "–" : `$${value.toFixed(value < 1 ? 3 : 2)}`;
}

function score(value: { status: TaskStatus; passes: number; counted: number }): string {
  return `${value.status} ${value.passes}/${value.counted}`;
}

function change(flip: Flip | undefined): string {
  if (!flip) return "";
  if (flip.kind === "new") return "new task";
  if (flip.kind === "removed") return "not run this time";
  const text = `${score(flip.before!)} → ${score(flip.after!)}`;
  if (flip.kind === "same") return flip.before!.passes === flip.after!.passes && flip.before!.counted === flip.after!.counted ? "same" : `same (${text})`;
  return flip.kind === "unknown" ? `can't tell (${text})` : `**${flip.kind}** (${text})`;
}

export function cost(result: EvalResult): number | undefined {
  const costs = result.tasks.flatMap(task => task.runs.flatMap(run => run.cost === undefined ? [] : [run.cost]));
  return costs.length ? costs.reduce((total, value) => total + value, 0) : undefined;
}

export function renderReport(current: EvalResult, previous?: EvalResult): string {
  const flips = previous ? compare(previous, current) : undefined;
  const byId = new Map(flips?.map(flip => [flip.id, flip]));
  const lines = [
    `Model ${current.model}${current.thinkingLevel ? ` (thinking ${current.thinkingLevel})` : ""}, ${current.runsPerTask} ${current.runsPerTask === 1 ? "run" : "runs"} a task`
      + `${current.commit ? `, at ${current.commit}` : ""}${current.label ? `, "${current.label}"` : ""}.`,
    ...(previous ? [`Against ${previous.model}${previous.commit ? ` at ${previous.commit}` : ""}${previous.label ? `, "${previous.label}"` : ""}, of ${previous.finishedAt}.`] : []),
    "",
    `| Task | Passes | Time | Tokens in / out | Cost |${previous ? " Against the earlier result |" : ""}`,
    `|---|---|---|---|---|${previous ? "---|" : ""}`,
  ];
  for (const task of current.tasks) {
    const { status, passes, counted, errors } = tally(task);
    const seconds = median(task.runs.map(run => run.seconds));
    const usage = task.runs.flatMap(run => run.tokens ? [run.tokens] : []);
    const spent = task.runs.flatMap(run => run.cost === undefined ? [] : [run.cost]);
    const timeouts = task.runs.filter(run => run.outcome === "timeout").length;
    lines.push(`| ${task.id} | ${passes}/${counted} ${status}${timeouts ? `, ${timeouts} timed out` : ""}${errors ? `, ${errors} not counted (error)` : ""} `
      + `| ${seconds === undefined ? "–" : `${Math.round(seconds)}s`} `
      + `| ${count(mean(usage.map(tokens => tokens.input + tokens.cacheRead + tokens.cacheWrite)))} / ${count(mean(usage.map(tokens => tokens.output)))} `
      + `| ${money(spent.length ? spent.reduce((total, value) => total + value, 0) : undefined)} |${previous ? ` ${change(byId.get(task.id))} |` : ""}`);
  }
  const tallies = current.tasks.map(tally);
  lines.push("", `${tallies.filter(item => item.status === "pass").length} of ${tallies.length} tasks passed every run; `
    + `${tallies.reduce((total, item) => total + item.passes, 0)} of ${tallies.reduce((total, item) => total + item.counted, 0)} runs passed; cost ${money(cost(current))}.`);
  const contexts = current.tasks.flatMap(task => task.runs.flatMap(run => run.contextTokens === undefined || run.outcome === "error" ? [] : [{ id: task.id, tokens: run.contextTokens }]));
  const smallest = contexts.sort((a, b) => a.tokens - b.tokens)[0];
  if (smallest) lines.push(`Smallest context at the end of a run: ${count(smallest.tokens)} tokens (${smallest.id}), an upper bound on what the instructions and tool definitions take.`);
  if (flips) {
    const named = (kind: FlipKind) => flips.filter(flip => flip.kind === kind).map(flip => flip.id);
    const parts = [
      ...(named("regressed").length ? [`Regressed: ${named("regressed").join(", ")}.`] : []),
      ...(named("improved").length ? [`Improved: ${named("improved").join(", ")}.`] : []),
      ...(named("unknown").length ? [`Can't tell (errors, not counted): ${named("unknown").join(", ")}.`] : []),
      ...(named("new").length ? [`New: ${named("new").join(", ")}.`] : []),
      ...(named("removed").length ? [`Not run this time: ${named("removed").join(", ")}.`] : []),
    ];
    lines.push(parts.length ? parts.join(" ") : "No task flipped.");
  }
  const failed = current.tasks.flatMap(task => task.runs.filter(run => run.outcome !== "pass").map(run => `- ${task.id}, run ${run.run} (${run.outcome}): ${run.detail}`));
  if (failed.length) lines.push("", "Runs that did not pass:", ...failed);
  return `${lines.join("\n")}\n`;
}

export function parseResult(text: string): EvalResult {
  const value = JSON.parse(text) as EvalResult;
  if (!value || value.version !== 1 || !Array.isArray(value.tasks) || typeof value.model !== "string"
    || value.tasks.some(task => typeof task?.id !== "string" || !Array.isArray(task.runs))) throw new Error("Not an eval result file (version 1)");
  return value;
}
