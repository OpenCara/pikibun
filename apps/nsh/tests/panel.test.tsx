import { describe, expect, open, test } from "nsh/test";
import { ORIGIN, server, signedIn } from "./fixtures";

// A session's panel and header menu, ported from the web app: its details, approvals, files, schedules and activity.

const bodyOf = (app: { requests(): { method: string; url: string; body?: string | null }[] }, method: string, url: string) => {
  const request = app.requests().find(item => item.method === method && item.url === url);
  return request?.body ? JSON.parse(request.body) : undefined;
};

async function openPanel() {
  const app = await open("../App.tsx", { network: server(), storage: signedIn, platform: "macos", width: 1280, height: 820 });
  await app.press("id:session-row-s1");
  await app.waitFor("id:session-details");
  await app.press("id:session-details");
  await app.waitFor("id:session-panel");
  return app;
}

describe("a session's panel", () => {
  test("Details shows the host, people, backups and access", async () => {
    const app = await openPanel();
    for (const part of ["panel-details", "session-host", "panel-people", "panel-backups", "panel-access"]) await app.waitFor(`id:${part}`);
    await app.waitFor("text:Link sharing off");
    await app.waitFor("text:Runs as Ada Lovelace (you)");
  });

  test("Approvals lists the session's approvals, pending first", async () => {
    const app = await openPanel();
    await app.press("text:Approvals 1");
    await app.waitFor("id:panel-approvals");
    await app.waitFor("id:approval-ap1");
  });

  test("Files lists the worktree and previews a file", async () => {
    const app = await openPanel();
    await app.press("text:Files");
    await app.waitFor("id:file-README.md");
    await app.press("id:file-README.md");
    await app.waitFor("id:file-text");
    expect(app.texts().join(" ")).toContain("The login test races the cookie.");
    // Highlighted for its language, as the web app's Files tab does.
    expect(app.shows("label:README.md, markdown")).toBe(true);
    await app.press("id:file-back");
    await app.waitFor("id:file-src");
  });

  test("Browser says when the agent hasn't used it", async () => {
    const app = await openPanel();
    await app.press("text:Browser");
    await app.waitFor("text:No browser calls yet");
  });

  test("Schedules creates a scheduled prompt", async () => {
    const app = await openPanel();
    await app.press("text:Schedules");
    await app.waitFor("id:schedule-new");
    await app.press("id:schedule-new");
    await app.type("id:schedule-content", "Run the tests");
    await app.press("id:schedule-save");
    await app.waitUntil(() => Boolean(bodyOf(app, "POST", `${ORIGIN}/api/sessions/s1/schedules`)));
    expect(bodyOf(app, "POST", `${ORIGIN}/api/sessions/s1/schedules`)).toMatchObject({ content: "Run the tests", cron: "0 9 * * 1-5", access: "approval" });
  });

  test("Activity shows the audit log", async () => {
    const app = await openPanel();
    await app.press("text:Activity");
    await app.waitFor("text:session.create");
  });
});

describe("a session's header menu", () => {
  test("renames the session", async () => {
    const app = await open("../App.tsx", { network: server(), storage: signedIn, platform: "macos", width: 1280, height: 820 });
    await app.press("id:session-row-s1");
    await app.waitFor("id:session-actions");
    await app.press("id:session-actions");
    await app.press("id:session-rename");
    await app.clear("id:rename-title");
    await app.type("id:rename-title", "Fix the login race");
    await app.press("id:rename-save");
    await app.waitUntil(() => Boolean(bodyOf(app, "PATCH", `${ORIGIN}/api/sessions/s1`)));
    expect(bodyOf(app, "PATCH", `${ORIGIN}/api/sessions/s1`)).toEqual({ title: "Fix the login race" });
  });
});
