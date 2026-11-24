import { stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { transcriptLines } from "../../packages/shared/src/transcript.js";
import type { SessionView, ThinkingLevel } from "../../packages/shared/src/types.js";
import { cloneInto, type Fixture, type Forge, type ForgeCall, type ForgePull, type ForgeScenario, makeRemote, type Remote } from "./fixtures.js";
import type { EvalResult, RunResult, TaskResult } from "./report.js";
import type { EvalExtension, EvalStack } from "./stack.js";

export interface ToolCall { name: string; args: Record<string, unknown>; error: boolean; result: string }

export interface TaskContext {
  worktree: string;
  remotes: Readonly<Record<string, Remote>>;
  view: SessionView;
  calls: readonly ToolCall[];
  reply: string;
  forge: readonly ForgeCall[];
  pulls(name: string): Promise<ForgePull[]>;
}

export interface EvalTask {
  id: string;
  title: string;
  fixtures: readonly Fixture[];
  cloned?: boolean;
  extensions?: readonly EvalExtension[];
  forge?: Readonly<Record<string, ForgeScenario>>;
  message: string;
  access?: "read";
  timeoutSeconds: number;
  check(context: TaskContext): Promise<string[]>;
}

export function toolCalls(view: SessionView): ToolCall[] {
  const calls: ToolCall[] = [];
  const byId = new Map<string, ToolCall>();
  for (const entry of view.entries) {
    if (entry.toolCalls?.length) {
      const lines = transcriptLines(entry.text).filter(line => line.tool !== undefined);
      entry.toolCalls.forEach((ref, index) => {
        const line = lines[index]?.tool === ref.name ? lines[index] : lines.find(item => item.tool === ref.name);
        let args: Record<string, unknown> = {};
        try { args = line ? JSON.parse(line.line.slice(ref.name.length + 1, -1)) as Record<string, unknown> : {}; } catch { args = {}; }
        const call = { name: ref.name, args, error: false, result: "" };
        calls.push(call);
        byId.set(ref.id, call);
      });
    }
    const call = entry.toolResult?.callId ? byId.get(entry.toolResult.callId) : undefined;
    if (call) { call.result = entry.text; call.error = entry.toolResult?.error === true; }
  }
  return calls;
}

export function callsOf(calls: readonly ToolCall[], tools: readonly string[], pattern?: RegExp): number[] {
  return calls.flatMap((call, index) => {
    if (tools.includes(call.name)) return !pattern || pattern.test(JSON.stringify(call.args)) ? [index] : [];
    const code = call.name === "codemode" && typeof call.args.code === "string" ? call.args.code : "";
    return tools.some(tool => new RegExp(`\\btools\\.${tool}\\b`).test(code)) && (!pattern || pattern.test(code)) ? [index] : [];
  });
}

export function finalReply(view: SessionView): string {
  const last = view.entries.findLast(entry => entry.role === "assistant" && !entry.toolCalls?.length && entry.text.trim());
  return last?.text ?? "";
}

function modelFailure(view: SessionView): string | undefined {
  const last = view.entries.at(-1);
  if (!last) return "the session has no entries";
  if (last.kind === "workspace.run-failure" || last.error) {
    return `the model's turn failed${last.error?.status ? ` (${last.error.status})` : ""}${last.error?.cause ? ` (${last.error.cause})` : ""}`;
  }
  if (last.kind === "workspace.run-crashed" || last.kind === "workspace.run-refused") return last.text || "the run did not start";
  return undefined;
}

export interface RunOptions {
  stack: EvalStack;
  forge: Forge;
  directory: string;
  thinkingLevel?: ThinkingLevel;
  timeoutScale?: number;
  log?: (line: string) => void;
}

export async function runTask(task: EvalTask, run: number, options: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const seconds = () => Math.round((Date.now() - started) / 100) / 10;
  let sessionId: string | undefined;
  try {
    const directory = join(options.directory, "runs", `${task.id}-${run}-${started.toString(36)}`);
    const remotes: Record<string, Remote> = {};
    for (const fixture of task.fixtures) remotes[fixture.name] = await makeRemote(join(directory, "remotes"), fixture);
    await options.forge.reset(Object.values(remotes), task.forge ?? {});
    const workspaceId = await options.stack.workspace(task.extensions ?? []);
    const session = await options.stack.session(workspaceId, `${task.id} ${run}`);
    sessionId = session.id;
    if (task.cloned) {
      for (const deadline = Date.now() + 30_000; !(await stat(session.worktree).catch(() => undefined))?.isDirectory();) {
        if (Date.now() > deadline) throw new Error("The session's worktree was not made");
        await delay(200);
      }
      for (const remote of Object.values(remotes)) await cloneInto(session.worktree, remote);
    }
    const message = task.message.replace(/\{remote:([a-z0-9-]+)\}/g, (_match, name: string) => remotes[name]?.url ?? `{remote:${name}}`);
    await options.stack.submit(session.id, message, { ...(task.access ? { access: task.access } : {}), ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}) });
    const { view, timedOut } = await options.stack.settle(session.id, task.timeoutSeconds * 1000 * (options.timeoutScale ?? 1));
    const usage = view.usage?.total;
    const measured = {
      sessionId, toolCalls: toolCalls(view).length,
      ...(usage ? { tokens: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite }, cost: usage.cost } : {}),
      ...(view.context ? { contextTokens: view.context.tokens } : {}),
    };
    if (timedOut) {
      await options.stack.stopSession(session.id);
      await options.stack.settle(session.id, 30_000).catch(() => undefined);
      return { run, outcome: "timeout", detail: `not settled after ${Math.round(task.timeoutSeconds * (options.timeoutScale ?? 1))} seconds; stopped`, seconds: seconds(), ...measured };
    }
    const failure = modelFailure(view);
    if (failure) return { run, outcome: "error", detail: failure, seconds: seconds(), ...measured };
    const taken = seconds();
    const problems = await task.check({
      worktree: session.worktree, remotes, view, calls: toolCalls(view), reply: finalReply(view),
      forge: await options.forge.calls(), pulls: name => options.forge.pulls(name),
    }).catch((error: unknown) => [`the check itself failed: ${error instanceof Error ? error.message : String(error)}`]);
    return { run, outcome: problems.length ? "fail" : "pass", detail: problems.join("; ") || "ok", seconds: taken, ...measured };
  } catch (error) {
    return { run, outcome: "error", detail: `the harness failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 600), seconds: seconds(), ...(sessionId ? { sessionId } : {}) };
  }
}

export interface EvalOptions extends RunOptions {
  tasks: readonly EvalTask[];
  runs: number;
  label?: string;
  commit?: string;
}

export async function runEval(options: EvalOptions): Promise<EvalResult> {
  const startedAt = new Date().toISOString();
  const results: TaskResult[] = [];
  for (const task of options.tasks) {
    const runs: RunResult[] = [];
    for (let run = 1; run <= options.runs; run++) {
      const result = await runTask(task, run, options);
      options.log?.(`${task.id} run ${run}/${options.runs}: ${result.outcome} in ${result.seconds}s${result.outcome === "pass" ? "" : ` (${result.detail})`}`);
      runs.push(result);
    }
    results.push({ id: task.id, title: task.title, runs });
  }
  const model = options.stack.model;
  return {
    version: 1, ...(options.label ? { label: options.label } : {}), model: `${model.provider}/${model.modelId}`,
    ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}), ...(options.commit ? { commit: options.commit } : {}),
    host: { platform: process.platform, node: process.versions.node, sandbox: false }, startedAt, finishedAt: new Date().toISOString(),
    runsPerTask: options.runs, tasks: results,
  };
}
