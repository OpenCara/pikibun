import test from "node:test";
import assert from "node:assert/strict";
import { githubWaitLimits, viewFingerprint, waitOutcome } from "../apps/runner/src/github-wait.js";
import type { GitHubIssueView, GitHubPullRequestView } from "../packages/shared/src/types.js";

const pull = (change: Partial<GitHubPullRequestView> = {}): GitHubPullRequestView => ({
  draft: false, merged: false, mergeable: true, mergeableState: "clean", head: { ref: "feature", sha: "a".repeat(40), repository: "acme/app" },
  base: { ref: "main", sha: "b".repeat(40) }, reviews: [], reviewComments: [], checks: [], ...change,
});
const view = (change: Partial<GitHubIssueView> = {}, pr: GitHubPullRequestView | null = pull()): GitHubIssueView => ({
  repository: "acme/app", number: 7, url: "https://github.com/acme/app/pull/7", title: "Fix", state: "open", author: "alice",
  createdAt: "2026-11-04T00:00:00Z", body: "Body", labels: [], comments: [], ...(pr ? { pullRequest: pr } : {}), ...change,
});
const check = (status: string, conclusion: string | null = null) => ({ name: "verify", status, conclusion });

test("waiting for checks: until every check of the head commit completes, the pull request closes, or its head has none", () => {
  const first = view({}, pull({ checks: [check("in_progress")] }));
  assert.equal(waitOutcome("checks", first, first, 0), undefined);
  assert.equal(waitOutcome("checks", first, view({}, pull({ checks: [check("completed", "success"), check("queued")] })), 60), undefined);
  assert.equal(waitOutcome("checks", first, view({}, pull({ checks: [check("completed", "failure")] })), 60), "checks-completed");
  assert.equal(waitOutcome("checks", first, view({ state: "closed" }, pull({ merged: true, checks: [check("in_progress")] })), 60), "closed");
  // Right after a push the head has no checks yet: they are waited for, but not for ever.
  const pushed = view({}, pull());
  assert.equal(waitOutcome("checks", pushed, pushed, githubWaitLimits.noChecksSeconds - 1), undefined);
  assert.equal(waitOutcome("checks", pushed, pushed, githubWaitLimits.noChecksSeconds), "no-checks");
  const issue = view({}, null);
  assert.equal(waitOutcome("checks", issue, issue, 0), "no-checks", "an issue has no checks");
});

test("waiting for a change: a comment, review, review comment, push, check or state; not GitHub's own mergeable state", () => {
  const first = view({}, pull({ checks: [check("in_progress")] }));
  assert.equal(waitOutcome("change", first, view({}, pull({ checks: [check("in_progress")], mergeable: null, mergeableState: "unknown" })), 60), undefined);
  const comment = { id: 1, author: "bob", createdAt: "2026-11-04T01:00:00Z", body: "LGTM", url: "u" };
  const review = { id: 2, author: "bot", state: "APPROVED", submittedAt: null, commit: null, body: "", url: "u" };
  for (const changed of [
    view({ comments: [comment] }, pull({ checks: [check("in_progress")] })),
    view({}, pull({ checks: [check("in_progress")], reviews: [review] })),
    view({}, pull({ checks: [check("completed", "success")] })),
    view({}, pull({ checks: [check("in_progress")], head: { ref: "feature", sha: "c".repeat(40), repository: "acme/app" } })),
    view({ state: "closed" }, pull({ checks: [check("in_progress")] })),
  ]) assert.equal(waitOutcome("change", first, changed, 60), "changed");
  // A full list keeps its newest items: a new comment still shows as a new last one.
  const full = view({ comments: [comment], omitted: { comments: 50 } });
  assert.notEqual(viewFingerprint(full), viewFingerprint(view({ comments: [{ ...comment, id: 3 }], omitted: { comments: 51 } })));
});
