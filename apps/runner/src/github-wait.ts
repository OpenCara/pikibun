import { createHash } from "node:crypto";
import type { GitHubIssueView } from "../../../packages/shared/src/types.js";

/*
 * github_read's wait (#163): sessions waited for CI and reviews with `sleep` in bash, then read the pull request again
 * (9% of their shell commands, followed by github_read 25 times of 26). github_read with `wait` reads again every
 * `githubWaitLimits.pollSeconds` until what it waits for happens, within `timeout_seconds`, and answers the last read.
 */

export const githubWaits = Object.freeze(["checks", "change"] as const);
export type GitHubWait = (typeof githubWaits)[number];

export const githubWaitLimits = Object.freeze({
  /** Between reads: each reads several GitHub API pages as the session owner, against their hourly quota. */
  pollSeconds: 30,
  defaultSeconds: 600,
  minSeconds: 30,
  /** Within the hour a message's admission lets its tool calls read GitHub. */
  maxSeconds: 1800,
  /** A pull request whose head has no checks this long after the wait began has none to wait for. */
  noChecksSeconds: 120,
});

/**
 * What the agent's instructions say about GitHub, by the tools it has: `github` for github_read and the brokered writes
 * (piki:github), `gh` for the gh tool (piki:gh). Every github_read read goes against the session owner's own hourly
 * quota (a wait reads again every `pollSeconds`), which sessions that read and wait with it can run out, while gh reads
 * with the workspace's GitHub App token. So with gh the agent reads and waits for checks with gh, and keeps github_read for
 * waiting for anything else to change, which gh has no command for, and github_comment, github_issue and github_merge for
 * the writes gh refuses: on a host that isn't the session owner's own, with gh read-only, or in a call no person decided.
 */
export function githubInstructions(tools: { github: boolean; gh: boolean }): string {
  if (!tools.github) return "";
  if (!tools.gh) return "To wait for a pull request's CI or reviews, "
    + "call github_read with wait: \"checks\" (until its checks complete) or \"change\" (until anything on it changes).";
  return "For GitHub, use the gh tool rather than github_read, which spends the session owner's own GitHub rate limit: "
    + "read issues and pull requests with it (gh issue view, gh pr view --comments, gh pr checks, gh run view <id> --log-failed, gh api), "
    + "and wait for a pull request's CI with gh pr checks <n> --watch or gh run watch <id>, with a timeout_seconds long enough, rather than sleeping. "
    + "Use github_read only to wait for anything else on a pull request (a comment, review or push), with wait: \"change\", "
    + "and github_comment, github_issue and github_merge only where gh refuses to write: on a host that isn't the session owner's own, "
    + "where the workspace set gh read-only, or in a call no person decided.";
}

/** Why a wait ended: what it waited for happened, or it didn't within its time. */
export type GitHubWaitOutcome = "checks-completed" | "no-checks" | "changed" | "closed" | "timeout" | "stopped";

/**
 * What a `change` wait compares between reads, as a digest: the issue's or pull request's state, title and description,
 * its comments, reviews (with their states) and review comments, their contents included, so an edit or a dismissed
 * review shows, and how many of each a full list left out, so a new item still shows; its head commit, and its checks'
 * statuses and conclusions. Not its mergeable state, which GitHub works out again by itself.
 */
export function viewFingerprint(view: GitHubIssueView): string {
  const pull = view.pullRequest;
  return createHash("sha256").update(JSON.stringify([view.state, view.title, view.body, view.labels, view.omitted ?? {},
    view.comments.map(comment => [comment.id, comment.body]),
    pull ? [pull.merged, pull.draft, pull.head.sha, pull.reviews.map(review => [review.id, review.state, review.body]),
      pull.reviewComments.map(comment => [comment.id, comment.body]), pull.checks.map(check => [check.name, check.status, check.conclusion])] : null])).digest("hex");
}

/** Whether a check passed, as the control plane's check list orders them (github-broker.ts). */
const passed = (check: { status: string; conclusion: string | null }) => check.status === "completed" && ["success", "neutral", "skipped"].includes(check.conclusion ?? "");

/**
 * A wait for `wait` that began at `first`, read at `startedSeconds`: given each later read and when it was made (in
 * seconds), whether the wait is over, and its outcome if so.
 * - `checks`: every check of the head commit has completed, those its list left out included as far as the list shows
 *   (see below). A pull request closed or merged meanwhile ends it too, and
 *   a head that has had no checks for `noChecksSeconds` since it was first read has none to wait for: a push during the
 *   wait starts that time again. An issue has no checks: it ends at once.
 * - `change`: anything `viewFingerprint` compares differs from the first read.
 */
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
    // The control plane lists failing and pending checks before passing ones and leaves out the end of the list: with
    // a passing one listed, none left out is pending; with none, a left-out one may be.
    return (view.omitted?.checks ?? 0) > 0 && !pull.checks.some(passed) ? undefined : "checks-completed";
  };
}

export interface GitHubWaitResult {
  view: GitHubIssueView;
  waited: { for: GitHubWait; outcome: GitHubWaitOutcome; seconds: number; reason?: string };
}

/**
 * Waits for `wait` from the first read `first`, reading again with `read` every `pollMs` until it is over or `timeoutMs`
 * has passed. The last sleep is cut to end at the deadline and a read follows it, so even the shortest wait reads
 * again. A read that fails ends the wait with the last view and its reason. `now` and `sleep` are the clock's.
 */
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
