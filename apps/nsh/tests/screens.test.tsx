import { describe, expect, open, test } from "nsh/test";
import { ORIGIN, server, sessionRecord, signedIn, view } from "./fixtures";

// The screens ported from the web app: a share link, an invite link and the list of every session.

const shared = (overrides: Record<string, unknown>) => open("./harness/shared.tsx", { network: server(overrides) });

describe("a share link", () => {
  test("shows the shared conversation, read-only", async () => {
    const app = await shared({
      [`GET ${ORIGIN}/api/shared`]: { body: { session: { id: "s1", title: "Fix the flaky login test", ownerName: "ada", status: "ready", createdAt: sessionRecord.createdAt } } },
      [`GET ${ORIGIN}/api/shared/view`]: { body: { view: { ...view, busy: false } } },
    });
    await app.waitFor("text:Why does the login test fail on CI?");
    expect(app.shows("text:Shared by ada")).toBe(true);
    expect(app.shows("text:Read-only")).toBe(true);
    expect(app.shows("id:composer-input")).toBe(false);
    const request = app.requests().find(item => item.url.endsWith("/api/shared/view"));
    expect(request?.headers?.["X-Share-Token"] ?? request?.headers?.["x-share-token"]).toBe("share-token");
  });

  test("that was turned off says so", async () => {
    const app = await shared({ [`GET ${ORIGIN}/api/shared`]: { status: 404, body: { error: "Not found", code: "not_found" } } });
    await app.waitFor("text:This link doesn't work");
  });
});

describe("an invite link", () => {
  test("asks to join, then waits for approval", async () => {
    const invite = { workspaceName: "Difference Engine", status: "none" };
    const app = await open("./harness/join.tsx", { storage: signedIn, network: server({
      [`GET ${ORIGIN}/api/invite`]: { body: { invite } },
      [`POST ${ORIGIN}/api/invite`]: { body: { invite: { ...invite, status: "pending" } } },
    }) });
    await app.waitFor("id:join-ask");
    expect(app.shows("text:Difference Engine")).toBe(true);
    const looked = app.requests().find(item => item.method === "GET" && item.url.endsWith("/api/invite"));
    expect(looked?.headers?.["x-invite-token"]).toBe("invite-token");
    await app.press("id:join-ask");
    await app.waitFor("text:Waiting for approval");
    const asked = app.requests().find(item => item.method === "POST" && item.url.endsWith("/api/invite"));
    expect(JSON.parse(asked?.body ?? "{}")).toEqual({ token: "invite-token" });
  });
});

describe("every session", () => {
  test("lists them by workspace, searchable, and opens one", async () => {
    const app = await open("../App.tsx", { network: server(), storage: signedIn, platform: "macos", width: 1280, height: 820 });
    await app.waitFor("id:all-sessions");
    await app.press("id:all-sessions");
    await app.waitFor("id:sessions-row-s1");
    expect(app.shows("id:sessions-row-s2")).toBe(false);
    await app.press("id:sessions-archived");
    await app.waitFor("id:sessions-row-s2");
    await app.type("id:sessions-search", "flaky");
    await app.waitUntil(() => !app.shows("id:sessions-row-s2"));
    await app.press("id:sessions-row-s1");
    await app.waitFor("id:approval-approve");
  });
});
