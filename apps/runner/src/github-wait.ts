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

export function viewFingerprint(view: GitHubIssueView, own: OwnChanges = noOwnChanges, sameHead = false): string {
  const pull = view.pullRequest;
  const others = <T extends { id: number }>(items: readonly T[]) => items.filter(item => !own.comments.has(item.id));
  return createHash("sha256").update(JSON.stringify([view.state, view.title, view.body, view.labels, view.omitted ?? {},
    others(view.comments).map(comment => [comment.id, comment.body]),
    pull ? [pull.merged, pull.draft, sameHead ? null : pull.head.sha, pull.reviews.map(review => [review.id, review.state, review.body]),
      others(pull.reviewComments).map(comment => [comment.id, comment.body]),
      sameHead ? null : pull.checks.map(check => [check.name, check.status, check.conclusion])] : null])).digest("hex");
}

const passed = (check: { status: string; conclusion: string | null }) => check.status === "completed" && ["success", "neutral", "skipped"].includes(check.conclusion ?? "");

export function githubWaiter(wait: GitHubWait, first: GitHubIssueView, startedSeconds: number,
  own: () => OwnChanges = () => noOwnChanges): (view: GitHubIssueView, nowSeconds: number) => GitHubWaitOutcome | undefined {
  let head = first.pullRequest?.head.sha;
  let headSince = startedSeconds;
  return (view, nowSeconds) => {
    if (wait === "change") {
      const ours = own();
      const sameHead = ownHead(view, ours);
      return viewFingerprint(view, ours, sameHead) !== viewFingerprint(first, ours, sameHead) ? "changed" : undefined;
    }
    const pull = view.pullRequest;
    if (!pull) return "no-checks";
    if (view.state !== "open") return "closed";
    if (pull.head.sha !== head) { head = pull.head.sha; headSince = nowSeconds; }
    if (!pull.checks.length) return nowSeconds - headSince >= githubWaitLimits.noChecksSeconds ? "no-checks" : undefined;
    if (!pull.checks.every(check => check.status === "completed")) return undefined;
    return (view.omitted?.checks ?? 0) > 0 && !pull.checks.some(passed) ? undefined : "checks-completed";
  };
}

export interface GitHubWaitResult {
  view: GitHubIssueView;
  waited: { for: GitHubWait; outcome: GitHubWaitOutcome; seconds: number; reason?: string };
}

export async function waitForGitHub(options: { wait: GitHubWait; first: GitHubIssueView; read: () => Promise<GitHubIssueView>; timeoutMs: number;
  pollMs: number; now: () => number; sleep: (ms: number) => Promise<void>; own?: () => OwnChanges | Promise<OwnChanges> }): Promise<GitHubWaitResult> {
  const started = options.now();
  const deadline = started + options.timeoutMs;
  const seconds = () => (options.now() - started) / 1000;
  let own = noOwnChanges;
  const over = githubWaiter(options.wait, options.first, 0, () => own);
  let view = options.first;
  let outcome = over(view, 0);
  let reason: string | undefined;
  while (!outcome) {
    const left = deadline - options.now();
    if (left <= 0) { outcome = "timeout"; break; }
    await options.sleep(Math.min(options.pollMs, left));
    try { view = await options.read(); own = options.own ? await options.own() : noOwnChanges; }
    catch (error) {
      outcome = "stopped";
      reason = error instanceof Error ? error.message.slice(0, 500) : "the read failed";
      break;
    }
    outcome = over(view, seconds());
  }
  return { view, waited: { for: options.wait, outcome, seconds: Math.round(seconds()), ...(reason ? { reason } : {}) } };
}
