import { describe, expect, open, test } from "nsh/test";
import { ORIGIN, server, sessionRecord, signedIn, workspace } from "./fixtures";

const bodyOf = (app: { requests(): { method: string; url: string; body?: string | null }[] }, method: string, url: string) => {
  const request = app.requests().find(item => item.method === method && item.url === url);
  return request?.body ? JSON.parse(request.body) : undefined;
};
const asked = (app: { requests(): { method: string; url: string }[] }, method: string, url: string) => app.requests().some(item => item.method === method && item.url === url);

const desktop = (overrides: Record<string, unknown> = {}) =>
  open("../App.tsx", { network: server(overrides), storage: signedIn, platform: "macos", width: 1280, height: 820 });

describe("a session's right-click menu", () => {
  test("offers what its manager can do, and copies its ID and link", async () => {
    const app = await desktop();
    await app.waitFor("id:session-row-s1");
    await app.rightClick("id:session-row-s1");
    await app.waitFor("id:menu-copy-id");
    for (const item of ["menu-copy-link", "menu-rename", "menu-visibility", "menu-archive"]) expect(app.shows(`id:${item}`)).toBe(true);
    expect(app.shows("id:menu-open-tab")).toBe(false);
    expect(app.shows("text:Make private")).toBe(true);
    await app.press("id:menu-copy-id");
    expect(app.clipboard()).toBe("s1");
    await app.waitFor("text:Session ID copied");
    expect(app.shows("id:session-actions")).toBe(false);

    await app.rightClick("id:session-row-s1");
    await app.press("id:menu-copy-link");
    expect(app.clipboard()).toBe(`${ORIGIN}/#/s/s1`);
    await app.waitFor("text:Link copied");
  });

  test("renames the session", async () => {
    const app = await desktop();
    await app.waitFor("id:session-row-s1");
    await app.rightClick("id:session-row-s1");
    await app.press("id:menu-rename");
    await app.waitFor("id:rename-title");
    expect(app.value("id:rename-title")).toBe(sessionRecord.title);
    await app.clear("id:rename-title");
    await app.type("id:rename-title", "Fix the login race");
    await app.press("id:rename-save");
    await app.waitUntil(() => Boolean(bodyOf(app, "PATCH", `${ORIGIN}/api/sessions/s1`)));
    expect(bodyOf(app, "PATCH", `${ORIGIN}/api/sessions/s1`)).toEqual({ title: "Fix the login race" });
    await app.waitFor("text:Session renamed");
    expect(app.shows("id:rename-title")).toBe(false);
  });

  test("archives the session once confirmed, and changes nothing when not", async () => {
    const app = await desktop({ [`POST ${ORIGIN}/api/sessions/s1/archive`]: { body: { ok: true } } });
    await app.waitFor("id:session-row-s1");
    app.onDialog(() => "Cancel");
    await app.rightClick("id:session-row-s1");
    await app.press("id:menu-archive");
    expect(asked(app, "POST", `${ORIGIN}/api/sessions/s1/archive`)).toBe(false);

    app.onDialog(dialog => (dialog.title === "Archive session?" ? "Archive" : null));
    await app.rightClick("id:session-row-s1");
    await app.press("id:menu-archive");
    await app.waitUntil(() => asked(app, "POST", `${ORIGIN}/api/sessions/s1/archive`));
    await app.waitFor("text:Session archived");
  });

  test("changes the session's visibility once confirmed", async () => {
    const app = await desktop();
    await app.waitFor("id:session-row-s1");
    app.onDialog(() => "Make private");
    await app.rightClick("id:session-row-s1");
    await app.press("id:menu-visibility");
    await app.waitUntil(() => Boolean(bodyOf(app, "PATCH", `${ORIGIN}/api/sessions/s1`)));
    expect(bodyOf(app, "PATCH", `${ORIGIN}/api/sessions/s1`)).toEqual({ visibility: "private" });
    await app.waitFor("text:Session is private. Existing explicit grants still apply.");
  });

  test("unarchives an archived session", async () => {
    const app = await desktop({ [`POST ${ORIGIN}/api/sessions/s2/unarchive`]: { body: { ok: true } } });
    await app.press("id:toggle-archived");
    await app.waitFor("id:session-row-s2");
    await app.rightClick("id:session-row-s2");
    await app.waitFor("id:menu-unarchive");
    expect(app.shows("id:menu-archive")).toBe(false);
    expect(app.shows("id:menu-rename")).toBe(false);
    await app.press("id:menu-unarchive");
    await app.waitUntil(() => asked(app, "POST", `${ORIGIN}/api/sessions/s2/unarchive`));
  });

  test("offers only opening and copying to someone who doesn't manage the session", async () => {
    const team = { id: "w2", name: "Difference Engine", ownerId: "u2", role: "member" };
    const theirs = { ...sessionRecord, id: "s5", workspaceId: "w2", ownerId: "u2", title: "Babbage's notes", visibility: "workspace", permissions: ["read"] };
    const app = await desktop({
      [`GET ${ORIGIN}/api/workspaces`]: { body: { workspaces: [workspace, team] } },
      [`GET ${ORIGIN}/api/sessions`]: { body: { sessions: [sessionRecord, theirs] } },
    });
    await app.waitFor("id:session-row-s5");
    await app.rightClick("id:session-row-s5");
    await app.waitFor("id:menu-copy-id");
    expect(app.shows("id:menu-copy-link")).toBe(true);
    for (const item of ["menu-rename", "menu-visibility", "menu-archive"]) expect(app.shows(`id:${item}`)).toBe(false);
  });

  test("opens from a finger held on the row on a phone, without opening the session", async () => {
    const app = await open("../App.tsx", { network: server(), storage: signedIn });
    await app.waitFor("id:session-row-s1");
    await app.longPress("id:session-row-s1");
    await app.waitFor("id:menu-copy-id");
    expect(app.shows("id:menu-rename")).toBe(true);
    await app.press("id:session-row-s1");
    expect(app.shows("id:menu-copy-id")).toBe(true);
    expect(app.shows("id:session-actions")).toBe(false);
    await app.press("id:menu-copy-id");
    expect(app.clipboard()).toBe("s1");
    await app.waitUntil(() => !app.shows("id:menu-copy-id"));

    await app.press("id:session-row-s1");
    await app.waitFor("id:session-actions");
  });

  test("a finger held on a workspace's row on a phone opens its menu without folding it", async () => {
    const app = await open("../App.tsx", { network: server(), storage: signedIn });
    await app.waitFor("id:workspace-row-w1");
    await app.longPress("id:workspace-row-w1");
    await app.waitFor("id:workspace-copy-id-w1");
    await app.press("id:workspace-row-w1");
    expect(app.shows("id:session-row-s1")).toBe(true);
    expect(app.shows("text:Collapse")).toBe(true);
  });
});

describe("the Sessions page", () => {
  test("a session's row has the same right-click menu", async () => {
    const app = await desktop();
    await app.waitFor("id:all-sessions");
    await app.press("id:all-sessions");
    await app.waitFor("id:sessions-row-s1");
    await app.rightClick("id:sessions-row-s1");
    await app.waitFor("id:menu-rename");
    await app.press("id:menu-copy-id");
    expect(app.clipboard()).toBe("s1");
    await app.waitFor("id:sessions-feedback");
    expect(app.texts()).toContain("Session ID copied");
  });
});

describe("a workspace's right-click menu", () => {
  test("has its options: a new session, folding it, its ID and its settings", async () => {
    const app = await desktop();
    await app.waitFor("id:workspace-row-w1");
    await app.rightClick("id:workspace-row-w1");
    await app.waitFor("id:workspace-copy-id-w1");
    for (const item of ["workspace-menu-new-w1", "workspace-fold-w1", "workspace-settings-w1"]) expect(app.shows(`id:${item}`)).toBe(true);
    expect(app.shows("text:Collapse")).toBe(true);
    await app.press("id:workspace-copy-id-w1");
    expect(app.clipboard()).toBe("w1");
    await app.waitFor("text:Workspace ID copied");

    await app.rightClick("id:workspace-row-w1");
    await app.press("id:workspace-fold-w1");
    await app.waitUntil(() => !app.shows("id:session-row-s1"));
    await app.rightClick("id:workspace-row-w1");
    await app.waitFor("text:Expand");
    await app.press("id:workspace-fold-w1");
    await app.waitFor("id:session-row-s1");
  });

  test("its options button offers the same", async () => {
    const app = await desktop();
    await app.waitFor("id:workspace-options-w1");
    await app.press("id:workspace-options-w1");
    await app.waitFor("id:workspace-copy-id-w1");
    expect(app.shows("id:workspace-fold-w1")).toBe(true);
  });
});
