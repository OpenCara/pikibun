import { describe, expect, open, test } from "nsh/test";
import { ORIGIN, server, sessionRecord, signedIn } from "./fixtures";

const head = "c".repeat(40);
const first = "e".repeat(40);
const repositories = [{ directory: "app", branch: "fix-login", head }, { directory: "docs", branch: null, head: first }];
const commits = [
  { sha: head, message: "Wait for the redirect", author: "Ada", date: "2026-11-06T09:30:00.000Z", unpushed: true },
  { sha: first, message: "Add the login test", author: "Ada", date: "2026-11-06T09:00:00.000Z" },
];
const uncommitted = {
  repositories, directory: "app", commit: null, additions: 3, deletions: 1, commits,
  files: [
    { path: "src/login.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1,3 +1,3 @@\n import { get } from \"./http\";\n-const early = get(\"/api/me\");\n+const afterRedirect = get(\"/api/me\");\n export {};" },
    { path: "tests/login.test.ts", status: "added", additions: 2, deletions: 0, patch: "@@ -0,0 +1,2 @@\n+test(\"logs in\", () => {});\n+export {};" },
    { path: "notes.bin", status: "added", additions: 0, deletions: 0 },
  ],
};
const committed = { repositories, directory: "app", commit: head, additions: 1, deletions: 0, commits,
  files: [{ path: "src/redirect.ts", status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+export const redirected = true;" }] };
const docs = { repositories, directory: "docs", commit: null, additions: 0, deletions: 0, commits: [commits[1]], files: [] };

function routes(extra: Parameters<typeof server>[0] = {}) {
  return server({
    [`GET ${ORIGIN}/api/sessions/s1/changes`]: { body: { changes: uncommitted } },
    [`GET ${ORIGIN}/api/sessions/s1/changes?directory=app`]: { body: { changes: uncommitted } },
    [`GET ${ORIGIN}/api/sessions/s1/changes?directory=app&commit=${head}`]: { body: { changes: committed } },
    [`GET ${ORIGIN}/api/sessions/s1/changes?directory=docs`]: { body: { changes: docs } },
    ...extra,
  });
}

async function openChanges(extra: Parameters<typeof server>[0] = {}, size: { width: number; height: number } = { width: 1280, height: 820 }) {
  const app = await open("../App.tsx", { network: routes(extra), storage: signedIn, platform: "macos", ...size });
  await app.press("id:session-row-s1");
  await app.waitFor("id:session-details");
  await app.press("id:session-details");
  await app.waitFor("id:session-panel");
  await app.press("text:Changes");
  await app.waitFor("id:panel-changes");
  return app;
}

describe("the Changes tab of a session's panel", () => {
  test("shows the clone, its branch and its uncommitted files as a tree", async () => {
    const app = await openChanges();
    await app.waitFor("id:changes-sidebar");
    expect(app.shows("text:app")).toBe(true);
    expect(app.shows("text:fix-login")).toBe(true);
    expect(app.shows("text:ccccccc")).toBe(true);
    expect(app.shows("text:1 commit not pushed")).toBe(true);
    expect(app.shows("text:Uncommitted changes")).toBe(true);
    expect(app.shows("text:3 files")).toBe(true);
    await app.waitFor("id:review-file:src/login.ts");
    expect(app.shows("label:src/login.ts, Modified")).toBe(true);
    expect(app.shows("label:tests/login.test.ts, Added")).toBe(true);
  });

  test("opens a file's diff against HEAD, and says when a file has none", async () => {
    const app = await openChanges();
    await app.waitFor("id:review-file:src/login.ts");
    await app.press("id:review-file:src/login.ts");
    await app.waitFor("id:review-diff");
    await app.waitFor("text:1 difference");
    expect(app.texts().join("\n")).toContain("afterRedirect");
    await app.press("id:review-layout-split");
    await app.waitFor("id:review-revisions");
    expect(app.shows("text:HEAD (ccccccc)")).toBe(true);
    expect(app.shows("text:Working tree")).toBe(true);
    await app.press("id:review-back");
    await app.waitFor("id:review-file:notes.bin");
    await app.press("id:review-file:notes.bin");
    await app.waitFor("text:No text changes to show");
    expect(app.shows("text:Open on GitHub")).toBe(false);
  });

  test("lists the commits, shows one commit's files and goes back to the uncommitted changes", async () => {
    const app = await openChanges();
    await app.waitFor("id:changes-tabs");
    await app.press("text:Commits 2");
    await app.waitFor("id:changes-commits");
    expect(app.shows("label:Commit ccccccc: Wait for the redirect, not pushed")).toBe(true);
    expect(app.shows("label:Commit eeeeeee: Add the login test")).toBe(true);
    await app.press("id:changes-commit-ccccccc");
    await app.waitFor("id:review-file:src/redirect.ts");
    expect(app.shows("text:ccccccc Wait for the redirect")).toBe(true);
    expect(app.shows("id:review-file:src/login.ts")).toBe(false);
    await app.press("id:review-file:src/redirect.ts");
    await app.waitFor("id:review-diff");
    await app.press("id:review-layout-split");
    await app.waitFor("id:review-revisions");
    expect(app.shows("text:ccccccc")).toBe(true);
    await app.press("id:review-back");
    await app.press("id:changes-uncommitted");
    await app.waitFor("id:review-file:src/login.ts");
    expect(app.shows("text:Uncommitted changes")).toBe(true);
  });

  test("switches to another repository of the worktree", async () => {
    const app = await openChanges();
    await app.waitFor("id:changes-repository-pick");
    await app.press("id:changes-repository-pick");
    await app.press("label:docs");
    await app.waitFor("text:No uncommitted changes");
    expect(app.shows("text:detached HEAD")).toBe(true);
    expect(app.shows("text:Commits 1")).toBe(true);
  });

  test("expands to the full window, the files beside a side-by-side diff, and comes back", async () => {
    const app = await openChanges();
    await app.waitFor("id:changes-expand");
    await app.press("id:changes-expand");
    await app.waitFor("id:changes-full");
    await app.waitFor("id:review-diff");
    expect(app.shows("id:review-tree")).toBe(true);
    expect(app.shows("id:review-revisions")).toBe(true);
    await app.press("id:review-diff-expand");
    await app.waitUntil(() => !app.shows("id:changes-full"));
    expect(app.shows("id:review-diff")).toBe(true);
  });

  test("says when the worktree has no repository, when the host is too old, and when the reader is a viewer", async () => {
    const none = await openChanges({ [`GET ${ORIGIN}/api/sessions/s1/changes`]: { body: { changes: { repositories: [], directory: null, commit: null, files: [], commits: [], additions: 0, deletions: 0 } } } });
    await none.waitFor("text:No Git repository in the worktree");
    none.dispose();
    const old = await openChanges({ [`GET ${ORIGIN}/api/sessions/s1/changes`]: { status: 409, body: { error: "This session's host can't show its Git changes yet. Its owner can update the pikibun connector there." } } });
    await old.waitFor("text:Couldn't read the changes");
    expect(old.shows("text:This session's host can't show its Git changes yet. Its owner can update the pikibun connector there.")).toBe(true);
    old.dispose();
    const viewer = await openChanges({ [`GET ${ORIGIN}/api/sessions/s1`]: { body: { session: { ...sessionRecord, ownerId: "u2", permissions: ["read"], viewable: true } } } });
    await viewer.waitFor("text:Changes unavailable");
    expect(viewer.requests().some(request => request.url.includes("/changes"))).toBe(false);
  });
});
