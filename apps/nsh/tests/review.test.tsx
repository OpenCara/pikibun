import { describe, expect, open, test } from "nsh/test";
import { ORIGIN, server, sessionRecord, signedIn } from "./fixtures";

const pull = { url: "https://github.com/OpenCara/pikibun/pull/345", number: 345, state: "open" };
const headSha = "c".repeat(40);

export const review = {
  pull: {
    repository: "OpenCara/pikibun", number: 345, url: pull.url, title: "A pull request reviewer in the session's panel", state: "open", author: "ada",
    createdAt: "2026-11-06T09:00:00.000Z", body: "Adds a **Review** tab.", labels: [],
    comments: [{ id: 31, author: "grace", createdAt: "2026-11-06T10:00:00.000Z", body: "Looks promising.", url: `${pull.url}#issuecomment-31` }],
    pullRequest: {
      draft: false, merged: false, mergeable: true, mergeableState: "clean",
      head: { ref: "reviewer", sha: headSha, repository: "OpenCara/pikibun" }, base: { ref: "main", sha: "a".repeat(40) },
      reviews: [{ id: 11, author: "grace", state: "CHANGES_REQUESTED", submittedAt: "2026-11-06T10:05:00.000Z", commit: headSha, body: "One thing to fix.", url: `${pull.url}#pullrequestreview-11` }],
      reviewComments: [{ id: 21, inReplyTo: null, author: "grace", createdAt: "2026-11-06T10:05:00.000Z", path: "apps/nsh/src/ui.tsx", line: 2, originalLine: 2, commit: headSha,
        body: "Name this better.", diffHunk: "@@ -1,2 +1,2 @@", url: `${pull.url}#discussion_r21` }],
      checks: [{ name: "verify", status: "completed", conclusion: "success" }, { name: "platforms", status: "completed", conclusion: "failure" }],
    },
  },
  additions: 14, deletions: 3, changedFiles: 4,
  commits: [
    { sha: "e".repeat(40), message: "Add the review's shape\n\nWith its tree.", author: "ada", date: "2026-11-06T09:00:00.000Z" },
    { sha: headSha, message: "Draw the reviewer", author: "ada", date: "2026-11-06T09:30:00.000Z" },
  ],
  files: [
    { path: "apps/nsh/src/ui.tsx", status: "modified", additions: 1, deletions: 1, patch: "@@ -1,3 +1,3 @@\n import { View } from \"nsh\";\n-const oldName = 1;\n+const betterName = 2;\n export {};" },
    { path: "apps/nsh/src/session-panel/Review.tsx", status: "added", additions: 2, deletions: 0, patch: "@@ -0,0 +1,2 @@\n+export function Review() {}\n+export const reviewer = true;" },
    { path: "docs/sessions.md", previousPath: "docs/session.md", status: "renamed", additions: 0, deletions: 0 },
    { path: "README.md", status: "removed", additions: 0, deletions: 2, patch: "@@ -1,2 +0,0 @@\n-# Old\n-Gone." },
  ],
};

const withPull = { ...sessionRecord, pullRequest: pull };

function routes(extra: Parameters<typeof server>[0] = {}) {
  return server({
    [`GET ${ORIGIN}/api/sessions`]: { body: { sessions: [withPull] } },
    [`GET ${ORIGIN}/api/sessions/s1`]: { body: { session: { ...withPull, viewable: true } } },
    [`GET ${ORIGIN}/api/sessions/s1/pull-request`]: { body: { review } },
    ...extra,
  });
}

async function openReview(extra: Parameters<typeof server>[0] = {}, size: { width: number; height: number } = { width: 1280, height: 820 }) {
  const app = await open("../App.tsx", { network: routes(extra), storage: signedIn, platform: "macos", ...size });
  await app.press("id:session-row-s1");
  await app.waitFor("id:session-details");
  await app.press("id:session-details");
  await app.waitFor("id:session-panel");
  await app.press("text:Review");
  await app.waitFor("id:panel-review");
  return app;
}

describe("the Review tab of a session's panel", () => {
  test("shows the pull request's title, branches and state, and its files as a tree by directory", async () => {
    const app = await openReview();
    await app.waitFor("id:review-title");
    expect(app.shows("text:A pull request reviewer in the session's panel #345")).toBe(true);
    expect(app.shows("label:reviewer into main")).toBe(true);
    expect(app.shows("text:Open")).toBe(true);
    expect(app.shows("text:1 check failed")).toBe(true);
    expect(app.shows("text:4 files")).toBe(true);
    await app.waitFor("id:review-file:apps/nsh/src/ui.tsx");
    expect(app.shows("id:review-dir:apps/nsh/src")).toBe(true);
    expect(app.shows("id:review-dir:apps/nsh/src/session-panel")).toBe(true);
    expect(app.shows("label:apps/nsh/src/ui.tsx, Modified")).toBe(true);
    expect(app.shows("label:README.md, Deleted")).toBe(true);
    expect(app.shows("label:1 review comment")).toBe(true);
    const texts = app.texts();
    expect(texts.indexOf("apps/nsh/src")).toBeLessThan(texts.indexOf("docs"));
    expect(texts.indexOf("docs")).toBeLessThan(texts.indexOf("README.md"));
  });

  test("opens a file's diff in the panel, steps through the files and goes back to the tree", async () => {
    const app = await openReview();
    await app.waitFor("id:review-file:apps/nsh/src/ui.tsx");
    await app.press("id:review-file:apps/nsh/src/ui.tsx");
    await app.waitFor("id:review-diff");
    expect(app.shows("label:apps/nsh/src/ui.tsx, Modified")).toBe(true);
    await app.waitFor("text:1 difference");
    expect(app.texts().join("\n")).toContain("betterName");
    expect(app.shows("id:review-revisions")).toBe(false);
    await app.press("id:review-layout-split");
    await app.waitFor("id:review-revisions");
    expect(app.shows("text:main (aaaaaaa)")).toBe(true);
    await app.press("id:review-previous-file");
    await app.waitFor("label:apps/nsh/src/session-panel/Review.tsx, Added");
    expect(app.enabled("id:review-previous-file")).toBe(false);
    await app.press("id:review-back");
    await app.waitFor("id:review-tree");
    expect(app.shows("id:review-diff")).toBe(false);
  });

  test("says why a renamed file has no diff", async () => {
    const app = await openReview();
    await app.waitFor("id:review-file:docs/sessions.md");
    await app.press("id:review-file:docs/sessions.md");
    await app.waitFor("text:No text changes to show");
    expect(app.shows("text:The file was renamed without changes.")).toBe(true);
  });

  test("expands to the full window, the files beside a side-by-side diff of the first one, and comes back", async () => {
    const app = await openReview();
    await app.waitFor("id:review-expand");
    await app.press("id:review-expand");
    await app.waitFor("id:review-full");
    await app.waitFor("id:review-diff");
    expect(app.shows("id:review-tree")).toBe(true);
    expect(app.shows("label:apps/nsh/src/session-panel/Review.tsx, Added")).toBe(true);
    expect(app.shows("id:review-revisions")).toBe(true);
    expect(app.shows("id:review-back")).toBe(false);
    await app.press("id:review-file:README.md");
    await app.waitFor("label:README.md, Deleted");
    await app.press("id:review-diff-expand");
    await app.waitUntil(() => !app.shows("id:review-full"));
    expect(app.shows("id:review-diff")).toBe(true);
    expect(app.shows("id:review-back")).toBe(true);
  });

  test("lists the files without directories, and collapses and expands them all", async () => {
    const app = await openReview();
    await app.waitFor("id:review-file:apps/nsh/src/ui.tsx");
    await app.press("id:review-collapse-all");
    await app.waitUntil(() => !app.shows("id:review-file:apps/nsh/src/ui.tsx"));
    expect(app.shows("id:review-dir:apps/nsh/src")).toBe(true);
    await app.press("id:review-expand-all");
    await app.waitFor("id:review-file:apps/nsh/src/ui.tsx");
    await app.press("id:review-group");
    await app.waitUntil(() => !app.shows("id:review-dir:apps/nsh/src"));
    expect(app.shows("id:review-file:apps/nsh/src/ui.tsx")).toBe(true);
    expect(app.shows("text:apps/nsh/src/session-panel")).toBe(true);
  });

  test("lists the commits, and the description, checks, reviews and comments", async () => {
    const app = await openReview();
    await app.waitFor("id:review-tabs");
    await app.press("text:Commits 2");
    await app.waitFor("id:review-commits");
    expect(app.shows("text:Add the review's shape")).toBe(true);
    expect(app.shows("text:Draw the reviewer")).toBe(true);
    await app.press("text:Info");
    await app.waitFor("id:review-info");
    expect(app.shows("text:platforms")).toBe(true);
    expect(app.shows("text:Changes requested")).toBe(true);
    expect(app.shows("text:Looks promising.")).toBe(true);
    expect(app.shows("text:apps/nsh/src/ui.tsx:2")).toBe(true);
    await app.press("text:apps/nsh/src/ui.tsx:2");
    await app.waitFor("id:review-diff");
    expect(app.shows("label:apps/nsh/src/ui.tsx, Modified")).toBe(true);
  });

  test("says when the session has no pull request, when it is hosted elsewhere, and when the reader is a viewer", async () => {
    const none = await openReview({
      [`GET ${ORIGIN}/api/sessions`]: { body: { sessions: [sessionRecord] } },
      [`GET ${ORIGIN}/api/sessions/s1`]: { body: { session: { ...sessionRecord, viewable: true } } },
    });
    await none.waitFor("text:No pull request yet");
    expect(none.requests().some(request => request.url.endsWith("/pull-request"))).toBe(false);
    none.dispose();
    const elsewhere = { ...sessionRecord, pullRequest: { url: "https://gitlab.com/acme/app/-/merge_requests/7", number: 7 } };
    const other = await openReview({
      [`GET ${ORIGIN}/api/sessions`]: { body: { sessions: [elsewhere] } },
      [`GET ${ORIGIN}/api/sessions/s1`]: { body: { session: { ...elsewhere, viewable: true } } },
    });
    await other.waitFor("id:review-open-external");
    expect(other.requests().some(request => request.url.endsWith("/pull-request"))).toBe(false);
    other.dispose();
    const viewer = await openReview({ [`GET ${ORIGIN}/api/sessions/s1`]: { body: { session: { ...withPull, ownerId: "u2", permissions: ["read"], viewable: true } } } });
    await viewer.waitFor("text:Review unavailable");
    expect(viewer.requests().some(request => request.url.endsWith("/pull-request"))).toBe(false);
  });

  test("says why the pull request couldn't be read, and tries again", async () => {
    const app = await openReview({ [`GET ${ORIGIN}/api/sessions/s1/pull-request`]: { status: 429, body: { error: "The session owner's GitHub rate limit is used up. Try again later." } } });
    await app.waitFor("text:Couldn't load the pull request");
    expect(app.shows("text:The session owner's GitHub rate limit is used up. Try again later.")).toBe(true);
    const before = app.requests().filter(request => request.url.endsWith("/pull-request")).length;
    await app.press("text:Try again");
    await app.waitUntil(() => app.requests().filter(request => request.url.endsWith("/pull-request")).length > before);
  });

  test("has no full-window button in a narrow window, where the panel is a bottom sheet", async () => {
    const app = await openReview({}, { width: 640, height: 820 });
    await app.waitFor("id:review-title");
    expect(app.shows("id:review-expand")).toBe(false);
  });
});
