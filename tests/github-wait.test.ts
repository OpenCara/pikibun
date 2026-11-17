import test from "node:test";
import assert from "node:assert/strict";
import { githubInstructions, githubWaiter, githubWaitLimits, ownChanges, viewFingerprint, waitForGitHub, type GitHubWait } from "../apps/runner/src/github-wait.js";
import type { GitHubIssueView, GitHubPullRequestView, Operation, OperationRecord } from "../packages/shared/src/types.js";

const pull = (change: Partial<GitHubPullRequestView> = {}): GitHubPullRequestView => ({
  draft: false, merged: false, mergeable: true, mergeableState: "clean", head: { ref: "feature", sha: "a".repeat(40), repository: "acme/app" },
  base: { ref: "main", sha: "b".repeat(40) }, reviews: [], reviewComments: [], checks: [], ...change,
});
const view = (change: Partial<GitHubIssueView> = {}, pr: GitHubPullRequestView | null = pull()): GitHubIssueView => ({
  repository: "acme/app", number: 7, url: "https://github.com/acme/app/pull/7", title: "Fix", state: "open", author: "alice",
  createdAt: "2026-11-04T00:00:00Z", body: "Body", labels: [], comments: [], ...(pr ? { pullRequest: pr } : {}), ...change,
});
const check = (status: string, conclusion: string | null = null) => ({ name: "verify", status, conclusion });
const waitOutcome = (wait: GitHubWait, first: GitHubIssueView, view: GitHubIssueView, seconds: number) => githubWaiter(wait, first, 0)(view, seconds);

test("waiting for checks: until every check of the head commit completes, the pull request closes, or its head has none", () => {
  const first = view({}, pull({ checks: [check("in_progress")] }));
  assert.equal(waitOutcome("checks", first, first, 0), undefined);
  assert.equal(waitOutcome("checks", first, view({}, pull({ checks: [check("completed", "success"), check("queued")] })), 60), undefined);
  assert.equal(waitOutcome("checks", first, view({}, pull({ checks: [check("completed", "failure")] })), 60), "checks-completed");
  assert.equal(waitOutcome("checks", first, view({ state: "closed" }, pull({ merged: true, checks: [check("in_progress")] })), 60), "closed");
  const failures = Array.from({ length: 100 }, (_, index) => ({ name: `lint-${index}`, status: "completed", conclusion: "failure" }));
  assert.equal(waitOutcome("checks", first, view({ omitted: { checks: 1 } }, pull({ checks: failures })), 60), undefined);
  assert.equal(waitOutcome("checks", first, view({ omitted: { checks: 5 } }, pull({ checks: [...failures.slice(1), check("completed", "success")] })), 60), "checks-completed");
  assert.equal(waitOutcome("checks", first, view({}, pull({ checks: failures })), 60), "checks-completed", "nothing left out");
  const pushed = view({}, pull());
  assert.equal(waitOutcome("checks", pushed, pushed, githubWaitLimits.noChecksSeconds - 1), undefined);
  assert.equal(waitOutcome("checks", pushed, pushed, githubWaitLimits.noChecksSeconds), "no-checks");
  const waiting = githubWaiter("checks", first, 0);
  assert.equal(waiting(view({}, pull({ checks: [check("in_progress")] })), 200), undefined);
  const pushedLate = view({}, pull({ head: { ref: "feature", sha: "c".repeat(40), repository: "acme/app" } }));
  assert.equal(waiting(pushedLate, 300), undefined, "a new head's checks haven't registered yet");
  assert.equal(waiting(pushedLate, 300 + githubWaitLimits.noChecksSeconds - 1), undefined);
  assert.equal(waiting(pushedLate, 300 + githubWaitLimits.noChecksSeconds), "no-checks");
  const issue = view({}, null);
  assert.equal(waitOutcome("checks", issue, issue, 0), "no-checks", "an issue has no checks");
});

test("the session's own comments and pushes are found in its operations: github_comment, gh pr comment, git_push and git push", () => {
  const record = (id: string, operation: Operation, result: string, status: OperationRecord["status"] = "executed"): OperationRecord =>
    ({ id, sessionId: "s", requestedBy: "u", operation, createdAt: "2026-11-04T00:00:00Z", status, result });
  const own = ownChanges({
    a: record("a", { kind: "github.comment", repository: "acme/app", issue: 7, body: "Fixed." }, JSON.stringify({ id: 501, url: "https://github.com/acme/app/pull/7#issuecomment-501" })),
    b: record("b", { kind: "extension.tool", source: "piki:gh", tool: "gh", arguments: JSON.stringify({ args: ["pr", "comment", "7", "--body", "Done."] }), digest: "x" },
      "https://github.com/acme/app/pull/7#issuecomment-502\n"),
    c: record("c", { kind: "extension.tool", source: "piki:gh", tool: "gh", arguments: JSON.stringify({ args: ["api", "repos/acme/app/issues/7/comments"] }), digest: "x" },
      "[{\"html_url\": \"https://github.com/acme/app/pull/7#issuecomment-900\"}]"),
    d: record("d", { kind: "git.push", repository: "acme/app", directory: "app", branch: "feature" } as Operation,
      "Pushed 1 commit to feature (aaaaaaaaaaaa..cccccccccccc), based on bbbbbbbbbbbb.\n- cccccccccccc Fix"),
    e: record("e", { kind: "program", tool: "git", command: "cd -- './app' && GIT_EDITOR=true git --no-pager 'push' 'origin' 'HEAD:feature' </dev/null 2>&1" },
      "To http://127.0.0.1/git/github.com/acme/app.git\n   cccccccc..dddddddd  HEAD -> feature\n"),
    f: record("f", { kind: "github.comment", repository: "acme/app", issue: 7, body: "Never." }, "Effect failed or outcome is ambiguous.", "interrupted"),
    g: record("g", { kind: "program", tool: "git", command: "git --no-pager 'log' '--oneline' </dev/null 2>&1" }, "1111111..2222222 x\n"),
  });
  assert.deepEqual([...own.comments].sort(), [501, 502], "comments it posted, not those another command printed");
  assert.deepEqual(own.heads, ["cccccccccccc", "dddddddd"]);
});

test("waiting for a change ignores the session's own comments, its pushes and the checks on a commit it pushed, and nobody else's", () => {
  const mine = "d".repeat(40);
  const own = { comments: new Set([501]), heads: ["dddddddd"] };
  const first = view({}, pull({ checks: [check("completed", "success")] }));
  const at = (sha: string, change: Partial<GitHubPullRequestView> = {}) => pull({ head: { ref: "feature", sha, repository: "acme/app" }, ...change });
  const outcome = (next: GitHubIssueView) => githubWaiter("change", first, 0, () => own)(next, 60);
  assert.equal(outcome(view({}, at(mine))), undefined, "its own push");
  assert.equal(outcome(view({}, at(mine, { checks: [check("in_progress")] }))), undefined, "checks starting on its own push");
  assert.equal(outcome(view({}, at(mine, { checks: [check("completed", "failure")] }))), undefined, "checks ending on its own push: wait for checks to see them");
  const comment = { id: 501, author: "alice", createdAt: "2026-11-04T01:00:00Z", body: "Fixed in dddddddd.", url: "https://github.com/acme/app/pull/7#issuecomment-501" };
  assert.equal(outcome(view({ comments: [comment] }, at(mine))), undefined, "its own comment");
  assert.equal(outcome(view({ comments: [comment, { ...comment, id: 502, author: "bob", body: "Thanks!" }] }, at(mine))), "changed", "someone else's comment");
  assert.equal(outcome(view({}, at(mine, { reviews: [{ id: 1, author: "bob", state: "APPROVED", submittedAt: null, commit: mine, body: "", url: "" }] }))), "changed", "a review");
  assert.equal(outcome(view({}, at("e".repeat(40)))), "changed", "someone else's push");
  assert.equal(githubWaiter("change", first, 0)(view({}, at(mine)), 60), "changed", "without the session's operations, a push is a change");
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
  const withReview = view({ comments: [comment] }, pull({ reviews: [review] }));
  for (const edited of [
    view({ comments: [{ ...comment, body: "LGTM!" }] }, pull({ reviews: [review] })),
    view({ comments: [comment], body: "Bodx" }, pull({ reviews: [review] })),
    view({ comments: [comment] }, pull({ reviews: [{ ...review, state: "DISMISSED" }] })),
    view({ comments: [comment], omitted: { reviews: 1 } }, pull({ reviews: [review] })),
  ]) assert.equal(waitOutcome("change", withReview, edited, 60), "changed");
  assert.equal(waitOutcome("change", withReview, view({ comments: [comment] }, pull({ reviews: [review] })), 60), undefined);
  const full = view({ comments: [comment], omitted: { comments: 50 } });
  assert.notEqual(viewFingerprint(full), viewFingerprint(view({ comments: [{ ...comment, id: 3 }], omitted: { comments: 51 } })));
});

test("a wait reads again until it is over, its last sleep cut to end at the deadline, with a read after it", async () => {
  const run = async (wait: GitHubWait, views: GitHubIssueView[], timeoutSeconds: number, failAt?: number) => {
    let now = 1_000_000;
    const slept: number[] = [];
    let reads = 0;
    const result = await waitForGitHub({ wait, first: views[0]!, timeoutMs: timeoutSeconds * 1000, pollMs: githubWaitLimits.pollSeconds * 1000, now: () => now,
      sleep: async ms => { slept.push(ms); now += ms; },
      read: async () => {
        reads++;
        if (reads === failAt) throw new Error("GitHub reads need a write message from the requester sent within the last hour.");
        return views[Math.min(reads, views.length - 1)]!;
      } });
    return { ...result, slept, reads };
  };
  const running = view({}, pull({ checks: [check("in_progress")] }));
  const done = view({}, pull({ checks: [check("completed", "success")] }));
  const shortest = await run("checks", [running, done], githubWaitLimits.minSeconds);
  assert.deepEqual([shortest.slept, shortest.reads, shortest.waited], [[30_000], 1, { for: "checks", outcome: "checks-completed", seconds: 30 }]);
  const timedOut = await run("checks", [running], 75);
  assert.deepEqual([timedOut.slept, timedOut.reads, timedOut.waited.outcome, timedOut.waited.seconds], [[30_000, 30_000, 15_000], 3, "timeout", 75]);
  const early = await run("checks", [running, running, done], 600);
  assert.deepEqual([early.reads, early.waited.outcome, early.waited.seconds], [2, "checks-completed", 60]);
  const already = await run("checks", [done], 600);
  assert.deepEqual([already.reads, already.slept, already.waited.outcome], [0, [], "checks-completed"]);
  const failed = await run("change", [running], 600, 2);
  assert.equal(failed.view, running);
  assert.deepEqual(failed.waited, { for: "change", outcome: "stopped", seconds: 60, reason: "GitHub reads need a write message from the requester sent within the last hour." });
});

test("with the gh tool, the instructions read and wait for checks with gh, keeping github_* for a change and the writes gh refuses", () => {
  assert.equal(githubInstructions({ github: false, gh: true }), "");
  assert.equal(githubInstructions({ github: false, gh: false }), "");
  const alone = githubInstructions({ github: true, gh: false });
  assert.match(alone, /github_read with wait: "checks".*"change"/);
  assert.doesNotMatch(alone, /gh tool/);
  const both = githubInstructions({ github: true, gh: true });
  assert.match(both, /^For GitHub, use the gh tool rather than github_read, which spends the session owner's own GitHub rate limit/);
  assert.match(both, /gh pr checks <n> --watch/);
  assert.match(both, /github_read only to wait for anything else .* wait: "change"/);
  assert.doesNotMatch(both, /wait: "checks"/);
  assert.match(both, /github_comment, github_issue and github_merge only where gh refuses to write: on a host that isn't the session owner's own, where the workspace set gh read-only/);
});
