import { describe, expect, open, test } from "nsh/test";
import { ORIGIN, server, sessionRecord, signedIn, view } from "./fixtures";

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

describe("the session list", () => {
  const teammates = { ...sessionRecord, id: "s5", ownerId: "u2", ownerName: "Grace Hopper", title: "Babbage's notes", permissions: ["read"] };
  const helped = { ...sessionRecord, id: "s6", ownerId: "u3", ownerName: "Charles Babbage", title: "Engine drawings", permissions: ["read", "ask", "write"] };
  const network = () => server({ [`GET ${ORIGIN}/api/sessions`]: { body: { sessions: [{ ...sessionRecord, ownerName: "Ada Lovelace" }, teammates, helped] } } });

  test("names the owner beside someone else's session, and finds sessions by it", async () => {
    const app = await open("../App.tsx", { network: network(), storage: signedIn, platform: "macos", width: 1280, height: 820 });
    await app.waitFor("id:session-row-s5");
    expect(app.texts()).toContain("Needs you · Grace Hopper · Viewer");
    expect(app.texts()).toContain("Needs you · Charles Babbage");
    expect(app.texts().join("\n")).not.toContain("Ada Lovelace");
    await app.type("id:session-search", "grace");
    await app.waitUntil(() => !app.shows("id:session-row-s6"));
    expect(app.shows("id:session-row-s5")).toBe(true);
    expect(app.shows("id:session-row-s1")).toBe(false);
  });

  test("every session's page names the owner too", async () => {
    const app = await open("../App.tsx", { network: network(), storage: signedIn, platform: "macos", width: 1280, height: 820 });
    await app.waitFor("id:all-sessions");
    await app.press("id:all-sessions");
    await app.waitFor("id:sessions-row-s5");
    const texts = app.texts().join("\n");
    expect(texts).toContain("Grace Hopper · Viewer · Workspace-visible");
    expect(texts).toContain("Yours · Workspace-visible");
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
    await app.waitFor("id:composer-input");
  });
});
