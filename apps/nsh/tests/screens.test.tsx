import { describe, expect, open, test } from "nsh/test";
import { ORIGIN, server, sessionRecord, signedIn, view, workspace } from "./fixtures";

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

  test("shows a published artifact's card, and the artifact through the link", async () => {
    const entries = [
      { id: "0:1", kind: "message", role: "assistant", text: 'publish_artifact({"name":"notes","kind":"markdown","content":"# Notes","title":"Release notes"})', conversationId: "0" },
      { id: "0:2", kind: "message", role: "toolResult", text: "Published artifact notes version 2 (markdown).\nTitle: Release notes\nPeople see it in the transcript and in the session panel's Artifacts tab.",
        toolResult: { tool: "publish_artifact", callId: "c1" }, conversationId: "0" },
    ];
    const app = await shared({
      [`GET ${ORIGIN}/api/shared`]: { body: { session: { id: "s1", title: "Fix the flaky login test", ownerName: "ada", status: "ready", createdAt: sessionRecord.createdAt } } },
      [`GET ${ORIGIN}/api/shared/view`]: { body: { view: { busy: false, entries } } },
      [`GET ${ORIGIN}/api/shared/artifacts?name=notes&version=2`]: { body: { artifact: { name: "notes", version: 2, kind: "markdown", title: "Release notes", size: 7,
        createdAt: sessionRecord.createdAt, content: "# Notes\n\nShipped the fix." } } },
    });
    await app.waitFor("id:artifact-card-notes-2");
    expect(app.shows("text:Release notes")).toBe(true);
    expect(app.shows("text:notes · version 2")).toBe(true);
    await app.press("text:Show");
    await app.waitFor("text:Shipped the fix.");
    const request = app.requests().find(item => item.url.endsWith("/api/shared/artifacts?name=notes&version=2"));
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
    expect(texts).toContain("Grace Hopper · Viewer · ");
    expect(texts).toContain("Yours · ");
    expect(texts).not.toContain("Workspace-visible");
  });
});

describe("private sessions on a computer", () => {
  test("each computer's private sessions are listed in the private workspace as any other, by computer, and marked offline while it is", async () => {
    const laptop = { ...sessionRecord, id: "p1", title: "Kept on my laptop", forwarded: { hostName: "Ada's laptop", online: false } };
    const desktop = { ...sessionRecord, id: "p2", title: "On the desktop", forwarded: { hostName: "Ada's desktop", online: true } };
    const app = await open("../App.tsx", { storage: signedIn, platform: "macos", width: 1280, height: 820, network: server({
      [`GET ${ORIGIN}/api/workspaces`]: { body: { workspaces: [{ ...workspace, personal: true, name: "Private" }] } },
      [`GET ${ORIGIN}/api/sessions`]: { body: { sessions: [sessionRecord, laptop, desktop] } },
    }) });
    await app.waitFor("id:session-row-p1");
    const texts = app.texts().join("\n");
    expect(texts).toContain("Ada's laptop · Offline");
    expect(texts).toContain("Ada's desktop\n");
    expect(texts).not.toContain("Bring here");
    expect(app.requests().some(item => item.url.includes("/api/portable-sessions"))).toBe(false);
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
