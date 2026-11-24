import test from "node:test";
import assert from "node:assert/strict";
import { lineOperations, maxPatchLines, unifiedPatch } from "../apps/server/src/authority/line-diff.js";
import { findAzureBranchPullRequest, readAzurePullRequestReview, readAzurePullRequestState, type AzureRepositoryApi } from "../apps/server/src/authority/azure-pull-requests.js";
import { azurePullRequest, azurePullRequestUrl } from "../packages/shared/src/pull-requests.js";
import { pullRequestCommitUrl, pullRequestFilesUrl, reviewForge } from "../packages/shared/src/pull-request-review.js";

function apply(before: string[], after: string[]): string[] {
  const operations = lineOperations(before, after);
  const result: string[] = [];
  let a = 0;
  let b = 0;
  for (const operation of operations) {
    if (operation === "=") { assert.equal(before[a], after[b]); result.push(after[b]!); a++; b++; }
    else if (operation === "-") a++;
    else result.push(after[b++]!);
  }
  assert.equal(a, before.length);
  return result;
}

test("line operations turn one text into the other with the fewest edits", () => {
  const cases: [string[], string[]][] = [
    [[], []], [["a"], []], [[], ["a"]], [["a", "b", "c"], ["a", "c"]], [["a", "b", "c", "a", "b", "b", "a"], ["c", "b", "a", "b", "a", "c"]],
    [Array.from({ length: 500 }, (_, i) => `line ${i}`), Array.from({ length: 500 }, (_, i) => (i % 7 ? `line ${i}` : `changed ${i}`))],
  ];
  for (const [before, after] of cases) assert.deepEqual(apply(before, after), after);
  assert.equal(lineOperations(["a", "b", "c", "a", "b", "b", "a"], ["c", "b", "a", "b", "a", "c"]).filter(op => op !== "=").length, 5);
  const big = Array.from({ length: 3000 }, (_, i) => `x${i}`);
  const other = Array.from({ length: 3000 }, (_, i) => `y${i}`);
  assert.deepEqual(apply(big, other), other, "past the edit limit it replaces the changed middle");
});

test("a unified patch has hunks with three lines of context, as Git writes them", () => {
  const before = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"].join("\n") + "\n";
  const after = ["one", "two", "THREE", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen"].join("\n") + "\n";
  assert.deepEqual(unifiedPatch(before, after), {
    patch: "@@ -1,6 +1,6 @@\n one\n two\n-three\n+THREE\n four\n five\n six\n@@ -10,3 +10,4 @@\n ten\n eleven\n twelve\n+thirteen",
    additions: 2, deletions: 1,
  });
  assert.deepEqual(unifiedPatch("", "a\nb\n"), { patch: "@@ -0,0 +1,2 @@\n+a\n+b", additions: 2, deletions: 0 });
  assert.deepEqual(unifiedPatch("a\n", ""), { patch: "@@ -1 +0,0 @@\n-a", additions: 0, deletions: 1 });
  assert.deepEqual(unifiedPatch("a\nb", "a\nb\n"), { patch: "@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b", additions: 1, deletions: 1 });
  assert.deepEqual(unifiedPatch("same\n", "same\n"), { patch: "", additions: 0, deletions: 0 });
});

test("a full rewrite of a very large file is diffed without overflowing the stack, and a patch past its line limit is cut", () => {
  for (const count of [100_000, 125_000]) {
    const started = performance.now();
    const whole = unifiedPatch("a\n".repeat(count), "b\n".repeat(count), Infinity);
    assert.deepEqual([whole.additions, whole.deletions, whole.truncated], [count, count, undefined]);
    assert.ok(whole.patch.startsWith(`@@ -1,${count} +1,${count} @@\n-a\n`) && whole.patch.endsWith("\n+b"));
    assert.equal(whole.patch.length, 6 * count + `@@ -1,${count} +1,${count} @@`.length);
    assert.deepEqual(unifiedPatch("a\n".repeat(count), "b\n".repeat(count)), { patch: "", additions: count, deletions: count, truncated: true });
    assert.ok(performance.now() - started < 10_000, `${count} lines took ${Math.round(performance.now() - started)} ms`);
  }
  assert.equal(unifiedPatch("a\nb\n", "c\nd\n", 5).patch, "@@ -1,2 +1,2 @@\n-a\n-b\n+c\n+d");
  assert.deepEqual(unifiedPatch("a\nb\n", "c\nd\n", 4), { patch: "", additions: 2, deletions: 2, truncated: true });
  assert.deepEqual(unifiedPatch("a\nb", "a\nc", 5), { patch: "", additions: 1, deletions: 1, truncated: true }, "the lines that say a file ends without a newline count");
  const half = Math.floor(maxPatchLines / 2);
  const fits = unifiedPatch("a\n".repeat(half - 1), "b\n".repeat(half));
  assert.deepEqual([fits.patch.split("\n").length, fits.truncated], [maxPatchLines, undefined]);
  assert.deepEqual(unifiedPatch("a\n".repeat(half), "b\n".repeat(half)), { patch: "", additions: half, deletions: half, truncated: true });
  const scattered = Array.from({ length: 4000 }, (_, index) => `line ${index}`);
  const edited = scattered.map((line, index) => index % 40 ? line : `changed ${index}`);
  assert.equal(unifiedPatch(scattered.join("\n"), edited.join("\n"), 897).patch.split("\n").length, 897);
  assert.deepEqual(unifiedPatch(scattered.join("\n"), edited.join("\n"), 896), { patch: "", additions: 100, deletions: 100, truncated: true },
    "context and hunk headers count towards the limit");
});

test("an Azure DevOps pull request URL names its repository and number, and the Review tab links back to it", () => {
  const url = "https://dev.azure.com/contoso/My%20Project/_git/app/pullrequest/42";
  assert.deepEqual(azurePullRequest(url), { fullName: "contoso/My Project/app", number: 42 });
  assert.equal(azurePullRequestUrl("contoso/My Project/app", 42), url);
  for (const other of ["https://dev.azure.com/contoso/Project/_git/app/pullrequests", "https://dev.azure.com/contoso/_git/app/pullrequest/4",
    "http://dev.azure.com/contoso/Project/_git/app/pullrequest/4", "https://evil.test/contoso/Project/_git/app/pullrequest/4",
    "https://dev.azure.com/contoso/Project/_git/app/pullrequest/4?x=1", "https://dev.azure.com/../Project/_git/app/pullrequest/4", "not a url"]) {
    assert.equal(azurePullRequest(other), undefined, other);
  }
  assert.equal(reviewForge(url), "azure-devops");
  assert.equal(reviewForge("https://github.com/owner/repo/pull/5"), "github");
  assert.equal(reviewForge("https://gitlab.com/group/project/-/merge_requests/7"), null);
  assert.equal(pullRequestFilesUrl(url), `${url}?_a=files`);
  assert.equal(pullRequestFilesUrl("https://github.com/owner/repo/pull/5"), "https://github.com/owner/repo/pull/5/files");
  assert.equal(pullRequestCommitUrl(url, "a".repeat(40)), `https://dev.azure.com/contoso/My%20Project/_git/app/commit/${"a".repeat(40)}`);
  assert.equal(pullRequestCommitUrl("https://github.com/owner/repo/pull/5", "b"), "https://github.com/owner/repo/pull/5/commits/b");
});

const repositoryId = "0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e";
const projectId = "11111111-2222-4333-8444-555555555555";
const api: AzureRepositoryApi = { credential: { id: "a", provider: "azure-devops", host: "dev.azure.com", organization: "contoso", username: null, token: "pat" },
  fullName: "contoso/My Project/app", repositoryId };
const base = `https://dev.azure.com/contoso/My%20Project/_apis/git/repositories/${repositoryId}`;
const oldBlob = "1".repeat(40);
const newBlob = "2".repeat(40);
const addedBlob = "3".repeat(40);
const binaryBlob = "4".repeat(40);
const lockedBlob = "5".repeat(40);
const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ";

function pullRequest(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { pullRequestId: 7, status: "active", isDraft: false, title: "Fix it", description: `Body ${secret}`, createdBy: { displayName: "Ann" },
    creationDate: "2026-11-01T00:00:00Z", sourceRefName: "refs/heads/feature", targetRefName: "refs/heads/main", mergeStatus: "succeeded",
    lastMergeSourceCommit: { commitId: "c".repeat(40) }, lastMergeTargetCommit: { commitId: "d".repeat(40) },
    repository: { id: repositoryId, project: { id: projectId } }, reviewers: [{ displayName: "Bob", vote: 10 }, { displayName: "Cy", vote: 0 }], ...extra };
}

function mock(t: test.TestContext, routes: Record<string, () => Response>): string[] {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    assert.equal(init?.redirect, "manual");
    assert.equal(new Headers(init?.headers).get("authorization"), `Basic ${Buffer.from(":pat").toString("base64")}`);
    const route = routes[url];
    assert.ok(route, `unexpected Azure DevOps call ${url}`);
    return route();
  });
  return calls;
}

test("an Azure DevOps pull request's state: merged, closed, draft, changes requested, failed checks, otherwise open", async t => {
  let pull = pullRequest();
  let statuses: unknown[] = [];
  let evaluations: unknown[] = [];
  mock(t, {
    [`${base}/pullrequests/7?api-version=7.1`]: () => Response.json(pull),
    [`${base}/pullRequests/7/statuses?api-version=7.1`]: () => Response.json({ value: statuses }),
    [`https://dev.azure.com/contoso/My%20Project/_apis/policy/evaluations?artifactId=${encodeURIComponent(`vstfs:///CodeReview/CodeReviewId/${projectId}/7`)}&api-version=7.1-preview.1`]:
      () => Response.json({ value: evaluations }),
  });
  assert.equal(await readAzurePullRequestState(api, 7), "open");
  evaluations = [{ status: "rejected", configuration: { type: { id: "fa4e907d-c16b-4a4c-9dfa-4906e5d171dd" } } }];
  assert.equal(await readAzurePullRequestState(api, 7), "open", "a reviewer policy is not a check");
  evaluations = [{ status: "rejected", configuration: { type: { id: "0609b952-1397-4640-95ec-e00a01b2c241" }, settings: { displayName: "CI" } } }];
  assert.equal(await readAzurePullRequestState(api, 7), "failing");
  evaluations = [];
  statuses = [{ id: 1, state: "failed", context: { genre: "ci", name: "lint" } }, { id: 2, state: "succeeded", context: { genre: "ci", name: "lint" } }];
  assert.equal(await readAzurePullRequestState(api, 7), "open", "the latest status of a context counts");
  statuses.push({ id: 3, state: "error", context: { genre: "ci", name: "test" } });
  assert.equal(await readAzurePullRequestState(api, 7), "failing");
  pull = pullRequest({ reviewers: [{ vote: -5 }] });
  assert.equal(await readAzurePullRequestState(api, 7), "changes_requested");
  pull = pullRequest({ isDraft: true });
  assert.equal(await readAzurePullRequestState(api, 7), "draft");
  pull = pullRequest({ status: "abandoned" });
  assert.equal(await readAzurePullRequestState(api, 7), "closed");
  pull = pullRequest({ status: "completed" });
  assert.equal(await readAzurePullRequestState(api, 7), "merged");
  pull = pullRequest({ repository: { id: "another" } });
  await assert.rejects(readAzurePullRequestState(api, 7), "a pull request of another repository is refused");
  await assert.rejects(readAzurePullRequestState({ ...api, fullName: "fabrikam/My Project/app" }, 7), "only with the organization's account");
});

test("an Azure DevOps branch's pull request is the newest one from the branch since the session started, in the repository itself", async t => {
  const query = `${base}/pullrequests?searchCriteria.sourceRefName=${encodeURIComponent("refs/heads/pikibun/fix")}&searchCriteria.status=all&$top=10&api-version=7.1`;
  let value: unknown[] = [];
  mock(t, { [query]: () => Response.json({ value }) });
  assert.equal(await findAzureBranchPullRequest(api, "pikibun/fix", "2026-11-01T00:00:00Z"), undefined);
  const item = (id: number, creationDate: string, extra: Record<string, unknown> = {}) =>
    ({ pullRequestId: id, creationDate, sourceRefName: "refs/heads/pikibun/fix", repository: { id: repositoryId }, ...extra });
  value = [item(9, "2026-11-02T00:00:00Z", { forkSource: { repository: {} } }), item(8, "2026-11-01T12:00:00Z", { repository: { id: "other" } }),
    item(5, "2026-11-01T06:00:00Z"), item(4, "2026-11-01T03:00:00Z"), item(2, "2026-10-01T00:00:00Z")];
  assert.deepEqual(await findAzureBranchPullRequest(api, "pikibun/fix", "2026-11-01T00:00:00Z"),
    { url: "https://dev.azure.com/contoso/My%20Project/_git/app/pullrequest/5", number: 5 });
});

test("the Review tab reads an Azure DevOps pull request: files with diffs Pikibun works out, commits, reviews, threads and checks", async t => {
  const blob = (id: string) => `${base}/blobs/${id}?$format=octetstream&api-version=7.1`;
  const calls = mock(t, {
    [`${base}/pullrequests/7?api-version=7.1`]: () => Response.json(pullRequest()),
    [`${base}/pullRequests/7/statuses?api-version=7.1`]: () => Response.json({ value: [{ id: 1, state: "pending", context: { genre: "ci", name: "build" } }] }),
    [`https://dev.azure.com/contoso/My%20Project/_apis/policy/evaluations?artifactId=${encodeURIComponent(`vstfs:///CodeReview/CodeReviewId/${projectId}/7`)}&api-version=7.1-preview.1`]:
      () => Response.json({ message: "no" }, { status: 403 }),
    [`${base}/pullRequests/7/commits?$top=100&api-version=7.1`]: () => Response.json({ value: [
      { commitId: "f".repeat(40), comment: "Second", author: { name: "Ann", date: "2026-11-02T00:00:00Z" } },
      { commitId: "e".repeat(40), comment: "First", author: { name: "Ann", date: "2026-11-01T00:00:00Z" } },
      { commitId: "short", comment: "Dropped" },
    ] }),
    [`${base}/pullRequests/7/iterations?api-version=7.1`]: () => Response.json({ value: [{ id: 1 }, { id: 2 }] }),
    [`${base}/pullRequests/7/threads?api-version=7.1`]: () => Response.json({ value: [
      { id: 3, comments: [{ id: 1, author: { displayName: "Bob" }, content: "Looks good", publishedDate: "2026-11-02T00:00:00Z", commentType: "text" },
        { id: 2, content: "Ann voted 10", commentType: "system" }] },
      { id: 4, threadContext: { filePath: "/src/a.ts", rightFileStart: { line: 2 } },
        comments: [{ id: 1, author: { displayName: "Bob" }, content: "Why?", publishedDate: "2026-11-02T01:00:00Z", commentType: "text" },
          { id: 2, parentCommentId: 1, author: { displayName: "Ann" }, content: "Because", publishedDate: "2026-11-02T02:00:00Z", commentType: "text" }] },
      { id: 5, isDeleted: true, comments: [{ id: 1, content: "gone", commentType: "text" }] },
    ] }),
    [`${base}/pullRequests/7/iterations/2/changes?$top=1000&api-version=7.1`]: () => Response.json({ changeEntries: [
      { changeType: "edit", item: { path: "/src/a.ts", objectId: newBlob, originalObjectId: oldBlob } },
      { changeType: "add", item: { path: "/.env", objectId: addedBlob } },
      { changeType: "delete", item: { path: "/logo.png", originalObjectId: binaryBlob } },
      { changeType: "rename", originalPath: "/src/old.ts", item: { path: "/src/new.ts", objectId: oldBlob, originalObjectId: oldBlob } },
      { changeType: "add", item: { path: "/locked.txt", objectId: lockedBlob } },
      { changeType: "add", item: { path: "/src", isFolder: true } },
    ] }),
    [blob(oldBlob)]: () => new Response("const a = 1;\nconst b = 2;\n"),
    [blob(newBlob)]: () => new Response("const a = 1;\nconst b = 3;\n"),
    [blob(addedBlob)]: () => new Response(`API_KEY=${secret}\n`),
    [blob(binaryBlob)]: () => new Response(new Uint8Array([137, 80, 78, 71, 0, 1])),
    [blob(lockedBlob)]: () => Response.json({ message: "denied" }, { status: 403 }),
  });
  const review = await readAzurePullRequestReview(api, 7);
  assert.ok(!calls.some(url => url.includes(`/blobs/${oldBlob}`) && calls.filter(other => other === url).length > 1), "each side is read once");
  assert.ok(!JSON.stringify(review).includes(secret), "secrets are hidden");
  assert.deepEqual([review.pull.repository, review.pull.number, review.pull.url, review.pull.title, review.pull.author, review.pull.state],
    ["contoso/My Project/app", 7, "https://dev.azure.com/contoso/My%20Project/_git/app/pullrequest/7", "Fix it", "Ann", "open"]);
  assert.deepEqual([review.pull.pullRequest?.head, review.pull.pullRequest?.base], [
    { ref: "feature", sha: "c".repeat(40), repository: "contoso/My Project/app" }, { ref: "main", sha: "d".repeat(40) }]);
  assert.deepEqual(review.pull.pullRequest?.reviews.map(item => [item.author, item.state]), [["Bob", "APPROVED"]]);
  assert.deepEqual(review.pull.pullRequest?.checks, [{ name: "ci/build", status: "pending", conclusion: null }]);
  assert.deepEqual(review.pull.comments.map(item => [item.author, item.body]), [["Bob", "Looks good"]]);
  assert.deepEqual(review.pull.pullRequest?.reviewComments.map(item => [item.path, item.line, item.body, item.inReplyTo]),
    [["src/a.ts", 2, "Why?", null], ["src/a.ts", 2, "Because", 2]]);
  assert.deepEqual(review.pull.comments.map(item => item.id), [1]);
  assert.deepEqual(review.pull.pullRequest?.reviewComments.map(item => item.id), [2, 3], "each comment has its own id, whatever Azure DevOps numbers it");
  assert.deepEqual(review.commits.map(item => [item.sha, item.message]), [["e".repeat(40), "First"], ["f".repeat(40), "Second"]]);
  assert.deepEqual(review.files.map(file => [file.path, file.status, file.previousPath, file.additions, file.deletions, Boolean(file.patch)]), [
    ["src/a.ts", "modified", undefined, 1, 1, true], [".env", "added", undefined, 1, 0, true], ["logo.png", "removed", undefined, 0, 0, false],
    ["src/new.ts", "renamed", "src/old.ts", 0, 0, false], ["locked.txt", "added", undefined, 0, 0, false]]);
  assert.equal(review.files[4]!.truncated, true, "a file Azure DevOps won't give is left to it, and the rest still shows");
  assert.equal(review.files[0]!.patch, "@@ -1,2 +1,2 @@\n const a = 1;\n-const b = 2;\n+const b = 3;");
  assert.equal(review.files[1]!.redacted, true);
  assert.deepEqual([review.additions, review.deletions, review.changedFiles, review.omitted], [2, 1, 5, undefined]);
});

test("the Review tab still loads an Azure DevOps pull request when one file's diff is too long or fails", async t => {
  const blob = (id: string) => `${base}/blobs/${id}?$format=octetstream&api-version=7.1`;
  const [hugeOld, hugeNew, brokenNew] = ["6".repeat(40), "7".repeat(40), "8".repeat(40)];
  mock(t, {
    [`${base}/pullrequests/7?api-version=7.1`]: () => Response.json(pullRequest()),
    [`${base}/pullRequests/7/statuses?api-version=7.1`]: () => Response.json({ value: [] }),
    [`https://dev.azure.com/contoso/My%20Project/_apis/policy/evaluations?artifactId=${encodeURIComponent(`vstfs:///CodeReview/CodeReviewId/${projectId}/7`)}&api-version=7.1-preview.1`]:
      () => Response.json({ value: [] }),
    [`${base}/pullRequests/7/commits?$top=100&api-version=7.1`]: () => Response.json({ value: [] }),
    [`${base}/pullRequests/7/iterations?api-version=7.1`]: () => Response.json({ value: [{ id: 1 }] }),
    [`${base}/pullRequests/7/threads?api-version=7.1`]: () => Response.json({ value: [] }),
    [`${base}/pullRequests/7/iterations/1/changes?$top=1000&api-version=7.1`]: () => Response.json({ changeEntries: [
      { changeType: "edit", item: { path: "/generated.txt", objectId: hugeNew, originalObjectId: hugeOld } },
      { changeType: "add", item: { path: "/broken.txt", objectId: brokenNew } },
      { changeType: "edit", item: { path: "/src/a.ts", objectId: newBlob, originalObjectId: oldBlob } },
    ] }),
    [blob(hugeOld)]: () => new Response("a\n".repeat(100_000)),
    [blob(hugeNew)]: () => new Response("b\n".repeat(100_000)),
    [blob(brokenNew)]: () => new Response("broken\n"),
    [blob(oldBlob)]: () => new Response("const a = 1;\nconst b = 2;\n"),
    [blob(newBlob)]: () => new Response("const a = 1;\nconst b = 3;\n"),
  });
  const started = performance.now();
  const review = await readAzurePullRequestReview(api, 7, (before, after) => {
    if (after === "broken\n") throw new RangeError("Maximum call stack size exceeded");
    return unifiedPatch(before, after);
  });
  assert.ok(performance.now() - started < 10_000);
  assert.deepEqual(review.files, [
    { path: "generated.txt", status: "modified", additions: 100_000, deletions: 100_000, truncated: true },
    { path: "broken.txt", status: "added", additions: 0, deletions: 0, truncated: true },
    { path: "src/a.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1,2 +1,2 @@\n const a = 1;\n-const b = 2;\n+const b = 3;" },
  ]);
  assert.deepEqual([review.additions, review.deletions, review.changedFiles], [100_001, 100_001, 3]);
});

test("the Review tab counts every commit of a long Azure DevOps pull request, page by page, and shows the newest", async t => {
  const commits = (from: number, count: number) => Array.from({ length: count }, (_, index) => {
    const at = from + index;
    return { commitId: at.toString(16).padStart(40, "0"), comment: `Commit ${at}`, author: { name: "Ann", date: "2026-11-01T00:00:00Z" } };
  });
  const page = (token: string | null, value: unknown[]) => () => Response.json({ value }, { headers: token ? { "x-ms-continuationtoken": token } : {} });
  mock(t, {
    [`${base}/pullrequests/7?api-version=7.1`]: () => Response.json(pullRequest()),
    [`${base}/pullRequests/7/statuses?api-version=7.1`]: () => Response.json({ value: [] }),
    [`https://dev.azure.com/contoso/My%20Project/_apis/policy/evaluations?artifactId=${encodeURIComponent(`vstfs:///CodeReview/CodeReviewId/${projectId}/7`)}&api-version=7.1-preview.1`]:
      () => Response.json({ value: [] }),
    [`${base}/pullRequests/7/commits?$top=100&api-version=7.1`]: page("t 1", commits(1000, 100)),
    [`${base}/pullRequests/7/commits?$top=100&continuationToken=t%201&api-version=7.1`]: page("t2", commits(900, 100)),
    [`${base}/pullRequests/7/commits?$top=100&continuationToken=t2&api-version=7.1`]: page("t3", commits(800, 100)),
    [`${base}/pullRequests/7/commits?$top=100&continuationToken=t3&api-version=7.1`]: page(null, commits(700, 100)),
    [`${base}/pullRequests/7/iterations?api-version=7.1`]: () => Response.json({ value: [] }),
    [`${base}/pullRequests/7/threads?api-version=7.1`]: () => Response.json({ value: [] }),
  });
  const review = await readAzurePullRequestReview(api, 7);
  assert.equal(review.commits.length, 250);
  assert.deepEqual(review.omitted, { commits: 150 });
  assert.equal(review.commits.at(-1)!.message, "Commit 1000", "the newest last, as on GitHub");
});
