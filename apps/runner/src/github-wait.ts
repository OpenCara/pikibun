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

/** Why a wait ended: what it waited for happened, or it didn't within its time. */
export type GitHubWaitOutcome = "checks-completed" | "no-checks" | "changed" | "closed" | "timeout" | "stopped";

/**
 * What a `change` wait compares between reads: the issue's or pull request's state, its comments, reviews and review
 * comments, its head commit, and its checks' statuses and conclusions. Not its mergeable state, which GitHub works out
 * again by itself, nor anything a list leaves out once it is full.
 */
export function viewFingerprint(view: GitHubIssueView): string {
  const pull = view.pullRequest;
  return JSON.stringify([view.state, view.title, view.body.length, view.comments.length, view.comments.at(-1)?.id ?? null, view.omitted?.comments ?? 0,
    pull ? [pull.merged, pull.draft, pull.head.sha, pull.reviews.length, pull.reviews.at(-1)?.id ?? null, pull.reviewComments.length, pull.reviewComments.at(-1)?.id ?? null,
      pull.checks.map(check => [check.name, check.status, check.conclusion])] : null]);
}

/**
 * Whether a wait for `wait` is over at `view`, `elapsedSeconds` after it began from `first`; the outcome if so.
 * - `checks`: every check of the head commit has completed. A pull request closed or merged meanwhile ends it too, and
 *   one whose head has had no checks for `noChecksSeconds` has none to wait for. An issue has no checks: it ends at once.
 * - `change`: anything `viewFingerprint` compares differs from the first read.
 */
export function waitOutcome(wait: GitHubWait, first: GitHubIssueView, view: GitHubIssueView, elapsedSeconds: number): GitHubWaitOutcome | undefined {
  if (wait === "change") return viewFingerprint(view) !== viewFingerprint(first) ? "changed" : undefined;
  const pull = view.pullRequest;
  if (!pull) return "no-checks";
  if (view.state !== "open") return "closed";
  if (!pull.checks.length) return elapsedSeconds >= githubWaitLimits.noChecksSeconds ? "no-checks" : undefined;
  return pull.checks.every(check => check.status === "completed") ? "checks-completed" : undefined;
}
