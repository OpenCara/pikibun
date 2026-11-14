import { describe, expect, open, test } from "nsh/test";
import { swipedBack } from "../src/session-panel/parts";
import { ORIGIN, server, sessionRecord, signedIn } from "./fixtures";

const pull = { url: "https://github.com/OpenCara/pikibun/pull/345", number: 345, state: "open" };
const head = "c".repeat(40);
const first = "e".repeat(40);
const files = [
  { path: "apps/nsh/src/ui.tsx", status: "modified", additions: 1, deletions: 1, patch: "@@ -1,3 +1,3 @@\n import { View } from \"nsh\";\n-const oldName = 1;\n+const betterName = 2;\n export {};" },
  { path: "apps/nsh/src/icons.tsx", status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+export const icons = true;" },
  { path: "README.md", status: "removed", additions: 0, deletions: 2, patch: "@@ -1,2 +0,0 @@\n-# Old\n-Gone." },
];
const review = {
  pull: {
    repository: "OpenCara/pikibun", number: 345, url: pull.url, title: "A pull request reviewer", state: "open", author: "ada", createdAt: "2026-11-06T09:00:00.000Z", body: "", labels: [], comments: [],
    pullRequest: { draft: false, merged: false, mergeable: true, mergeableState: "clean", head: { ref: "reviewer", sha: head, repository: "OpenCara/pikibun" }, base: { ref: "main", sha: "a".repeat(40) },
      reviews: [], reviewComments: [], checks: [] },
  },
  additions: 2, deletions: 3, changedFiles: 3, commits: [{ sha: head, message: "Draw the reviewer", author: "ada", date: "2026-11-06T09:30:00.000Z" }], files,
};
const repositories = [{ directory: "app", branch: "fix-login", head }];
const commits = [{ sha: head, message: "Wait for the redirect", author: "Ada", date: "2026-11-06T09:30:00.000Z", unpushed: true }, { sha: first, message: "Add the login test", author: "Ada", date: "2026-11-06T09:00:00.000Z" }];
const uncommitted = { repositories, directory: "app", commit: null, additions: 2, deletions: 3, commits, files };
const committed = { repositories, directory: "app", commit: head, additions: 1, deletions: 0, commits,
  files: [{ path: "src/redirect.ts", status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+export const redirected = true;" }] };
const withPull = { ...sessionRecord, pullRequest: pull };

const routes = () => server({
  [`GET ${ORIGIN}/api/sessions`]: { body: { sessions: [withPull] } },
  [`GET ${ORIGIN}/api/sessions/s1`]: { body: { session: { ...withPull, viewable: true } } },
  [`GET ${ORIGIN}/api/sessions/s1/pull-request`]: { body: { review } },
  [`GET ${ORIGIN}/api/sessions/s1/changes`]: { body: { changes: uncommitted } },
  [`GET ${ORIGIN}/api/sessions/s1/changes?directory=app`]: { body: { changes: uncommitted } },
  [`GET ${ORIGIN}/api/sessions/s1/changes?directory=app&commit=${head}`]: { body: { changes: committed } },
});

async function openTab(tab: string, platform: "android" | "ios" | "macos" = "android", size: { width?: number; height?: number } = {}) {
  const app = await open("../App.tsx", { network: routes(), storage: signedIn, platform, ...size });
  await app.press("id:session-row-s1");
  await app.waitFor("id:session-details");
  await app.press("id:session-details");
  await app.waitFor("id:session-panel");
  await app.press(`text:${tab}`);
  return app;
}

describe("Review and Changes on a phone", () => {
  test("list the files by directory in rows a finger can press, without the tree", async () => {
    const app = await openTab("Review");
    await app.waitFor("id:review-list");
    expect(app.shows("id:review-tree")).toBe(false);
    expect(app.shows("id:review-expand-all")).toBe(false);
    expect(app.shows("id:review-expand")).toBe(false);
    expect(app.shows("text:apps/nsh/src")).toBe(true);
    expect(app.shows("label:apps/nsh/src/ui.tsx, Modified")).toBe(true);
    const texts = app.texts();
    expect(texts.indexOf("apps/nsh/src")).toBeLessThan(texts.indexOf("icons.tsx"));
    expect(texts.indexOf("ui.tsx")).toBeLessThan(texts.indexOf("README.md"));
    await app.press("id:review-group");
    await app.waitUntil(() => !app.texts().includes("/"));
    expect(app.shows("id:review-file:apps/nsh/src/ui.tsx")).toBe(true);
  });

  test("show a diff in one column with its controls under the thumb", async () => {
    const app = await openTab("Review");
    await app.waitFor("id:review-file:apps/nsh/src/icons.tsx");
    await app.press("id:review-file:apps/nsh/src/icons.tsx");
    await app.waitFor("id:review-diff-bar");
    expect(app.shows("id:review-diff-header")).toBe(true);
    expect(app.shows("text:1 of 3")).toBe(true);
    expect(app.shows("id:review-layout-split")).toBe(false);
    expect(app.shows("id:review-revisions")).toBe(false);
    await app.waitFor("text:1 difference");
    expect(app.shows("label:Scroll long lines sideways")).toBe(true);
    await app.press("id:review-wrap");
    await app.waitFor("label:Wrap long lines");
    await app.press("id:review-next-file");
    await app.waitFor("label:apps/nsh/src/ui.tsx, Modified");
    expect(app.shows("text:2 of 3")).toBe(true);
    expect(app.texts().join("\n")).toContain("betterName");
  });

  test("go back from a diff to the files with a swipe to the right, and not with a short or a leftward one", async () => {
    const app = await openTab("Review");
    await app.waitFor("id:review-file:README.md");
    await app.press("id:review-file:README.md");
    await app.waitFor("id:review-diff-header");
    await app.drag("id:review-diff-header", { x: 40 });
    await app.drag("id:review-diff-header", { x: -200 });
    expect(app.shows("id:review-diff")).toBe(true);
    await app.drag("id:review-diff-header", { x: 200 });
    await app.waitFor("id:review-list");
    expect(app.shows("id:review-diff")).toBe(false);
    expect(app.shows("id:session-panel")).toBe(true);
  });

  test("the back button steps back through the diff, then closes the panel", async () => {
    const app = await openTab("Review");
    await app.waitFor("id:review-file:README.md");
    await app.press("id:review-file:README.md");
    await app.waitFor("id:review-diff");
    await app.back();
    await app.waitFor("id:review-list");
    expect(app.shows("id:session-panel")).toBe(true);
    await app.back();
    await app.waitUntil(() => !app.shows("id:session-panel"));
  });

  test("Changes goes back from a diff to a commit's files, then to the uncommitted changes, by swipe and by the back button", async () => {
    const app = await openTab("Changes");
    await app.waitFor("id:review-list");
    await app.press("text:Commits 2");
    await app.press("id:changes-commit-ccccccc");
    await app.waitFor("id:review-file:src/redirect.ts");
    await app.press("id:review-file:src/redirect.ts");
    await app.waitFor("id:review-diff-header");
    await app.drag("id:review-diff-header", { x: 200 });
    await app.waitFor("id:review-file:src/redirect.ts");
    expect(app.shows("id:changes-uncommitted")).toBe(true);
    await app.drag("id:changes-scope", { x: 200 });
    await app.waitFor("text:Uncommitted changes");
    await app.waitFor("id:review-file:README.md");
    await app.press("text:Commits 2");
    await app.press("id:changes-commit-ccccccc");
    await app.waitFor("id:changes-uncommitted");
    await app.back();
    await app.waitFor("text:Uncommitted changes");
    expect(app.shows("id:session-panel")).toBe(true);
  });

  test("Files goes back from a file with a swipe", async () => {
    const app = await openTab("Files");
    await app.waitFor("id:file-README.md");
    await app.press("id:file-README.md");
    await app.waitFor("id:file-text");
    await app.drag("id:file-back", { x: 200 });
    await app.waitFor("id:file-README.md");
  });

  test("on an iPhone's sheet too", async () => {
    const app = await openTab("Review", "ios");
    await app.waitFor("id:review-list");
    await app.press("id:review-file:README.md");
    await app.waitFor("id:review-diff-bar");
    await app.drag("id:review-diff-header", { x: 200 });
    await app.waitFor("id:review-list");
  });

  test("a desktop keeps the tree and the toolbar, and a drag there goes nowhere", async () => {
    const app = await openTab("Review", "macos", { width: 1280, height: 820 });
    await app.waitFor("id:review-tree");
    expect(app.shows("id:review-list")).toBe(false);
    await app.press("id:review-file:README.md");
    await app.waitFor("id:review-diff");
    expect(app.shows("id:review-diff-bar")).toBe(false);
    expect(app.shows("id:review-layout-split")).toBe(true);
    await app.drag("id:review-diff-path", { x: 200 });
    expect(app.shows("id:review-diff")).toBe(true);
    await app.keyboard.press("escape");
    await app.waitFor("id:review-tree");
    expect(app.shows("id:session-panel")).toBe(true);
    await app.keyboard.press("escape");
    await app.waitUntil(() => !app.shows("id:session-panel"));
  });

  test("a swipe goes back once it is long or fast enough, rightward, and not cancelled", () => {
    const pan = (x: number, velocity: number, cancelled = false) => swipedBack({ cancelled, translation: { x, y: 0 }, velocity: { x: velocity, y: 0 } });
    expect(pan(96, 0)).toBe(true);
    expect(pan(40, 900)).toBe(true);
    expect(pan(40, 600)).toBe(false);
    expect(pan(20, 2000)).toBe(false);
    expect(pan(-200, -900)).toBe(false);
    expect(pan(200, 0, true)).toBe(false);
  });
});
