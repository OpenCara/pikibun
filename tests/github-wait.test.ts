import test from "node:test";
import assert from "node:assert/strict";
import { githubInstructions, githubWaiter, githubWaitLimits, viewFingerprint, waitForGitHub, type GitHubWait } from "../apps/runner/src/github-wait.js";
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
/** Whether a fresh wait from `first` is over at `view`, read `seconds` after it began. */
const waitOutcome = (wait: GitHubWait, first: GitHubIssueView, view: GitHubIssueView, seconds: number) => githubWaiter(wait, first, 0)(view, seconds);

test("waiting for checks: until every check of the head commit completes, the pull request closes, or its head has none", () => {
  const first = view({}, pull({ checks: [check("in_progress")] }));
  assert.equal(waitOutcome("checks", first, first, 0), undefined);
  assert.equal(waitOutcome("checks", first, view({}, pull({ checks: [check("completed", "success"), check("queued")] })), 60), undefined);
  assert.equal(waitOutcome("checks", first, view({}, pull({ checks: [check("completed", "failure")] })), 60), "checks-completed");
  assert.equal(waitOutcome("checks", first, view({ state: "closed" }, pull({ merged: true, checks: [check("in_progress")] })), 60), "closed");
  // A long list leaves out its end: failing and pending checks come first, so left-out ones after a passing one passed too,
  // while a list of only failures may have left out one still pending.
  const failures = Array.from({ length: 100 }, (_, index) => ({ name: `lint-${index}`, status: "completed", conclusion: "failure" }));
  assert.equal(waitOutcome("checks", first, view({ omitted: { checks: 1 } }, pull({ checks: failures })), 60), undefined);
  assert.equal(waitOutcome("checks", first, view({ omitted: { checks: 5 } }, pull({ checks: [...failures.slice(1), check("completed", "success")] })), 60), "checks-completed");
  assert.equal(waitOutcome("checks", first, view({}, pull({ checks: failures })), 60), "checks-completed", "nothing left out");
  // Right after a push the head has no checks yet: they are waited for, but not for ever.
  const pushed = view({}, pull());
  assert.equal(waitOutcome("checks", pushed, pushed, githubWaitLimits.noChecksSeconds - 1), undefined);
  assert.equal(waitOutcome("checks", pushed, pushed, githubWaitLimits.noChecksSeconds), "no-checks");
  // A push during the wait starts the head's time without checks again.
  const waiting = githubWaiter("checks", first, 0);
  assert.equal(waiting(view({}, pull({ checks: [check("in_progress")] })), 200), undefined);
  const pushedLate = view({}, pull({ head: { ref: "feature", sha: "c".repeat(40), repository: "acme/app" } }));
  assert.equal(waiting(pushedLate, 300), undefined, "a new head's checks haven't registered yet");
  assert.equal(waiting(pushedLate, 300 + githubWaitLimits.noChecksSeconds - 1), undefined);
  assert.equal(waiting(pushedLate, 300 + githubWaitLimits.noChecksSeconds), "no-checks");
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
  // Edits to what is already there: a comment, the description (to the same length), a review dismissed.
  const withReview = view({ comments: [comment] }, pull({ reviews: [review] }));
  for (const edited of [
    view({ comments: [{ ...comment, body: "LGTM!" }] }, pull({ reviews: [review] })),
    view({ comments: [comment], body: "Bodx" }, pull({ reviews: [review] })),
    view({ comments: [comment] }, pull({ reviews: [{ ...review, state: "DISMISSED" }] })),
    view({ comments: [comment], omitted: { reviews: 1 } }, pull({ reviews: [review] })),
  ]) assert.equal(waitOutcome("change", withReview, edited, 60), "changed");
  assert.equal(waitOutcome("change", withReview, view({ comments: [comment] }, pull({ reviews: [review] })), 60), undefined);
  // A full list keeps its newest items: a new comment still shows as a new last one.
  const full = view({ comments: [comment], omitted: { comments: 50 } });
  assert.notEqual(viewFingerprint(full), viewFingerprint(view({ comments: [{ ...comment, id: 3 }], omitted: { comments: 51 } })));
});

test("a wait reads again until it is over, its last sleep cut to end at the deadline, with a read after it", async () => {
  /** A fake clock: sleeping moves it on; each read answers the next view, the last one again once they run out. */
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
  // The shortest wait still reads again, at its deadline.
  const shortest = await run("checks", [running, done], githubWaitLimits.minSeconds);
  assert.deepEqual([shortest.slept, shortest.reads, shortest.waited], [[30_000], 1, { for: "checks", outcome: "checks-completed", seconds: 30 }]);
  // A wait whose time isn't a multiple of the interval: its last sleep is cut, and a read follows it.
  const timedOut = await run("checks", [running], 75);
  assert.deepEqual([timedOut.slept, timedOut.reads, timedOut.waited.outcome, timedOut.waited.seconds], [[30_000, 30_000, 15_000], 3, "timeout", 75]);
  // Done before the deadline: no more reads.
  const early = await run("checks", [running, running, done], 600);
  assert.deepEqual([early.reads, early.waited.outcome, early.waited.seconds], [2, "checks-completed", 60]);
  // Done at the first read: no wait at all.
  const already = await run("checks", [done], 600);
  assert.deepEqual([already.reads, already.slept, already.waited.outcome], [0, [], "checks-completed"]);
  // A read that fails ends it with the last view and the reason.
  const failed = await run("change", [running], 600, 2);
  assert.equal(failed.view, running);
  assert.deepEqual(failed.waited, { for: "change", outcome: "stopped", seconds: 60, reason: "GitHub reads need a write message from the requester sent within the last hour." });
});

test("with the gh tool, the instructions read and wait for checks with gh, keeping github_* for a change and the writes gh refuses", () => {
  // Without piki:github's tools, nothing to say.
  assert.equal(githubInstructions({ github: false, gh: true }), "");
  assert.equal(githubInstructions({ github: false, gh: false }), "");
  // github_read alone waits for both, as before.
  const alone = githubInstructions({ github: true, gh: false });
  assert.match(alone, /github_read with wait: "checks".*"change"/);
  assert.doesNotMatch(alone, /gh tool/);
  // With gh, gh first: it spares the session owner's rate limit, which github_read spends.
  const both = githubInstructions({ github: true, gh: true });
  assert.match(both, /^For GitHub, use the gh tool rather than github_read, which spends the session owner's own GitHub rate limit/);
  assert.match(both, /gh pr checks <n> --watch/);
  assert.match(both, /github_read only to wait for anything else .* wait: "change"/);
  assert.doesNotMatch(both, /wait: "checks"/);
  assert.match(both, /github_comment, github_issue and github_merge only where gh refuses to write: on a host that isn't the session owner's own, where the workspace set gh read-only/);
});
