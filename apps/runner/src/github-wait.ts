import { createHash } from "node:crypto";
import type { GitHubIssueView } from "../../../packages/shared/src/types.js";

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

export function viewFingerprint(view: GitHubIssueView): string {
  const pull = view.pullRequest;
  return createHash("sha256").update(JSON.stringify([view.state, view.title, view.body, view.labels, view.omitted ?? {},
    view.comments.map(comment => [comment.id, comment.body]),
    pull ? [pull.merged, pull.draft, pull.head.sha, pull.reviews.map(review => [review.id, review.state, review.body]),
      pull.reviewComments.map(comment => [comment.id, comment.body]), pull.checks.map(check => [check.name, check.status, check.conclusion])] : null])).digest("hex");
}

const passed = (check: { status: string; conclusion: string | null }) => check.status === "completed" && ["success", "neutral", "skipped"].includes(check.conclusion ?? "");

export function githubWaiter(wait: GitHubWait, first: GitHubIssueView, startedSeconds: number): (view: GitHubIssueView, nowSeconds: number) => GitHubWaitOutcome | undefined {
  const fingerprint = viewFingerprint(first);
  let head = first.pullRequest?.head.sha;
  let headSince = startedSeconds;
  return (view, nowSeconds) => {
    if (wait === "change") return viewFingerprint(view) !== fingerprint ? "changed" : undefined;
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
  pollMs: number; now: () => number; sleep: (ms: number) => Promise<void> }): Promise<GitHubWaitResult> {
  const started = options.now();
  const deadline = started + options.timeoutMs;
  const seconds = () => (options.now() - started) / 1000;
  const over = githubWaiter(options.wait, options.first, 0);
  let view = options.first;
  let outcome = over(view, 0);
  let reason: string | undefined;
  while (!outcome) {
    const left = deadline - options.now();
    if (left <= 0) { outcome = "timeout"; break; }
    await options.sleep(Math.min(options.pollMs, left));
    try { view = await options.read(); }
    catch (error) {
      outcome = "stopped";
      reason = error instanceof Error ? error.message.slice(0, 500) : "the read failed";
      break;
    }
    outcome = over(view, seconds());
  }
  return { view, waited: { for: options.wait, outcome, seconds: Math.round(seconds()), ...(reason ? { reason } : {}) } };
}
