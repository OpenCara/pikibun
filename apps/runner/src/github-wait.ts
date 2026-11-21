import { createHash } from "node:crypto";
import type { GitHubIssueView, OperationRecord } from "../../../packages/shared/src/types.js";

export const githubWaits = Object.freeze(["checks", "change"] as const);
export type GitHubWait = (typeof githubWaits)[number];

export const githubWaitLimits = Object.freeze({
  pollSeconds: 30,
  defaultSeconds: 600,
  minSeconds: 30,
  maxSeconds: 1800,
  noChecksSeconds: 120,
});

export function githubInstructions(tools: { github: boolean; gh: boolean }): string {
  if (!tools.github) return "";
  if (!tools.gh) return "To wait for a pull request's CI or reviews, "
    + "call github_read with wait: \"checks\" (until its checks complete) or \"change\" (until anything on it changes).";
  return "For GitHub, use the gh tool rather than github_read, which spends the session owner's own GitHub rate limit: "
    + "read issues and pull requests with it (gh issue view, gh pr view --comments, gh pr checks, gh run view <id> --log-failed, gh api), "
    + "and wait for a pull request's CI with gh pr checks <n> --watch or gh run watch <id>, with a timeout_seconds long enough, rather than sleeping or reading again in a loop: "
    + "every read counts against GitHub rate limits that all of the owner's sessions share. "
    + "Use github_read only to wait for anything else on a pull request (a comment, review or push), with wait: \"change\", "
    + "and github_comment, github_issue and github_merge only where gh refuses to write: on a host that isn't the session owner's own, "
    + "where the workspace set gh read-only, or in a call no person decided.";
}

export type GitHubWaitOutcome = "checks-completed" | "no-checks" | "changed" | "closed" | "timeout" | "stopped";

export interface OwnChanges { comments: ReadonlySet<number>; heads: readonly string[] }

export const noOwnChanges: OwnChanges = Object.freeze({ comments: new Set<number>(), heads: [] });

function gitPushTips(text: string): string[] {
  return [...text.matchAll(/\b[0-9a-f]{7,40}\.{2,3}([0-9a-f]{7,40})\s/g)].map(match => match[1]!);
}

function ghComment(argumentsJson: string): boolean {
  try {
    const args = (JSON.parse(argumentsJson) as { args?: unknown }).args;
    if (!Array.isArray(args)) return false;
    const words = args.filter((arg): arg is string => typeof arg === "string" && !arg.startsWith("-"));
    return (words[0] === "pr" || words[0] === "issue") && words[1] === "comment";
  } catch { return false; }
}

export function ownChanges(approvals: Readonly<Record<string, OperationRecord>>): OwnChanges {
  const comments = new Set<number>();
  const heads: string[] = [];
  for (const record of Object.values(approvals)) {
    if (record.status !== "executed" || typeof record.result !== "string") continue;
    const operation = record.operation;
    if (operation.kind === "github.comment") {
      try { const id = (JSON.parse(record.result) as { id?: unknown }).id; if (Number.isSafeInteger(id)) comments.add(id as number); } catch { }
    } else if (operation.kind === "extension.tool" && operation.tool === "gh" && ghComment(operation.arguments)) {
      for (const match of record.result.matchAll(/#issuecomment-(\d{1,19})\b/g)) comments.add(Number(match[1]));
    } else if (operation.kind === "git.push") {
      for (const match of record.result.matchAll(/(?:\.\.|new branch at )([0-9a-f]{12})\)/g)) heads.push(match[1]!);
    } else if (operation.kind === "program" && operation.tool === "git" && /^(?:.* )?git --no-pager 'push'/.test(operation.command)) {
      heads.push(...gitPushTips(record.result));
    }
  }
  return { comments, heads };
}

export function ownHead(view: GitHubIssueView, own: OwnChanges): boolean {
  const sha = view.pullRequest?.head.sha;
  return !!sha && own.heads.some(prefix => sha.startsWith(prefix));
}

const textDigest = (text: string) => createHash("sha256").update(text).digest("base64url");

export interface GitHubViewDigest {
  state: string;
  title: string;
  body: string;
  labels: string[];
  omitted: { comments?: number; reviews?: number; reviewComments?: number; checks?: number };
  comments: [number, string][];
  pull: {
    merged: boolean; draft: boolean; head: string; reviews: [number, string, string][]; reviewComments: [number, string][];
    checks: [string, string, string | null][];
  } | null;
}

export function viewDigest(view: GitHubIssueView): GitHubViewDigest {
  const pull = view.pullRequest;
  return { state: view.state, title: view.title, body: textDigest(view.body), labels: [...view.labels], omitted: { ...view.omitted },
    comments: view.comments.map(comment => [comment.id, textDigest(comment.body)]),
    pull: pull ? { merged: pull.merged, draft: pull.draft, head: pull.head.sha, reviews: pull.reviews.map(review => [review.id, review.state, textDigest(review.body)]),
      reviewComments: pull.reviewComments.map(comment => [comment.id, textDigest(comment.body)]),
      checks: pull.checks.map(check => [check.name, check.status, check.conclusion]) } : null };
}

function digestFingerprint(digest: GitHubViewDigest, own: OwnChanges, sameHead: boolean): string {
  const pull = digest.pull;
  const others = <T extends [number, ...unknown[]]>(items: readonly T[]) => items.filter(item => !own.comments.has(item[0]));
  return createHash("sha256").update(JSON.stringify([digest.state, digest.title, digest.body, digest.labels, digest.omitted, others(digest.comments),
    pull ? [pull.merged, pull.draft, sameHead ? null : pull.head, pull.reviews, others(pull.reviewComments), sameHead ? null : pull.checks] : null])).digest("hex");
}

export function viewFingerprint(view: GitHubIssueView, own: OwnChanges = noOwnChanges, sameHead = false): string {
  return digestFingerprint(viewDigest(view), own, sameHead);
}

const passed = (check: { status: string; conclusion: string | null }) => check.status === "completed" && ["success", "neutral", "skipped"].includes(check.conclusion ?? "");

export interface GitHubWaitState {
  for: GitHubWait;
  startedAt: number;
  deadline: number;
  first: GitHubViewDigest;
  head: string | null;
  headSince: number;
}

export function startGitHubWait(wait: GitHubWait, first: GitHubIssueView, now: number, timeoutMs: number): GitHubWaitState {
  return { for: wait, startedAt: now, deadline: now + timeoutMs, first: viewDigest(first), head: first.pullRequest?.head.sha ?? null, headSince: now };
}

export function isGitHubWaitState(value: unknown): value is GitHubWaitState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return githubWaits.includes(state.for as GitHubWait) && [state.startedAt, state.deadline, state.headSince].every(Number.isFinite)
    && (state.head === null || typeof state.head === "string") && !!state.first && typeof state.first === "object";
}

function githubWaitOutcome(state: GitHubWaitState, view: GitHubIssueView, now: number, own: OwnChanges): { outcome: GitHubWaitOutcome | undefined; state: GitHubWaitState } {
  if (state.for === "change") {
    const sameHead = ownHead(view, own);
    return { outcome: viewFingerprint(view, own, sameHead) !== digestFingerprint(state.first, own, sameHead) ? "changed" : undefined, state };
  }
  const pull = view.pullRequest;
  if (!pull) return { outcome: "no-checks", state };
  if (view.state !== "open") return { outcome: "closed", state };
  const next = pull.head.sha === state.head ? state : { ...state, head: pull.head.sha, headSince: now };
  if (!pull.checks.length) return { outcome: now - next.headSince >= githubWaitLimits.noChecksSeconds * 1000 ? "no-checks" : undefined, state: next };
  if (!pull.checks.every(check => check.status === "completed")) return { outcome: undefined, state: next };
  return { outcome: (view.omitted?.checks ?? 0) > 0 && !pull.checks.some(passed) ? undefined : "checks-completed", state: next };
}

export function githubWaiter(wait: GitHubWait, first: GitHubIssueView, startedSeconds: number,
  own: () => OwnChanges = () => noOwnChanges): (view: GitHubIssueView, nowSeconds: number) => GitHubWaitOutcome | undefined {
  let state = startGitHubWait(wait, first, startedSeconds * 1000, 0);
  return (view, nowSeconds) => {
    const step = githubWaitOutcome(state, view, nowSeconds * 1000, own());
    state = step.state;
    return step.outcome;
  };
}

export type GitHubWaited = { for: GitHubWait; outcome: GitHubWaitOutcome; seconds: number; reason?: string };

export type GitHubWaitTurn = { kind: "done"; waited: GitHubWaited } | { kind: "poll"; state: GitHubWaitState; at: number };

export function githubWaitTurn(state: GitHubWaitState, view: GitHubIssueView, now: number, own: OwnChanges, pollMs: number): GitHubWaitTurn {
  const step = githubWaitOutcome(state, view, now, own);
  const seconds = Math.round((now - state.startedAt) / 1000);
  if (step.outcome) return { kind: "done", waited: { for: state.for, outcome: step.outcome, seconds } };
  if (now >= state.deadline) return { kind: "done", waited: { for: state.for, outcome: "timeout", seconds } };
  return { kind: "poll", state: step.state, at: Math.min(now + pollMs, state.deadline) };
}

export function githubWaitStopped(state: GitHubWaitState, now: number, error: unknown): GitHubWaited {
  return { for: state.for, outcome: "stopped", seconds: Math.round((now - state.startedAt) / 1000),
    reason: error instanceof Error ? error.message.slice(0, 500) : "the read failed" };
}

export interface GitHubWaitResult {
  view: GitHubIssueView;
  waited: GitHubWaited;
}

export async function waitForGitHub(options: { wait: GitHubWait; first: GitHubIssueView; read: () => Promise<GitHubIssueView>; timeoutMs: number;
  pollMs: number; now: () => number; sleep: (ms: number) => Promise<void>; own?: () => OwnChanges | Promise<OwnChanges> }): Promise<GitHubWaitResult> {
  let state = startGitHubWait(options.wait, options.first, options.now(), options.timeoutMs);
  let view = options.first;
  let turn = githubWaitTurn(state, view, options.now(), noOwnChanges, options.pollMs);
  while (turn.kind === "poll") {
    state = turn.state;
    await options.sleep(Math.max(0, turn.at - options.now()));
    let own: OwnChanges;
    try { view = await options.read(); own = options.own ? await options.own() : noOwnChanges; }
    catch (error) { return { view, waited: githubWaitStopped(state, options.now(), error) }; }
    turn = githubWaitTurn(state, view, options.now(), own, options.pollMs);
  }
  return { view, waited: turn.waited };
}
