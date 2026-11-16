import { describe, expect, open, test } from "nsh/test";
import { ORIGIN, server, sessionRecord, signedIn, view } from "./fixtures";

const asked = {
  ...view,
  busy: false,
  activity: "idle",
  queue: [],
  approvals: [],
  conversations: [{ id: "0", mode: "write" }, { id: "5", mode: "ask", actorId: "u1" }, { id: "6", mode: "ask", actorId: "u1" }],
  entries: [...view.entries,
    { id: "5:3", kind: "message", role: "user", text: "Could we wait for the cookie instead?", actorId: "u1", conversationId: "5" },
    { id: "5:4", kind: "message", role: "assistant", text: "Yes: await the login response before reading it.", conversationId: "5" },
    { id: "6:3", kind: "message", role: "user", text: "Which test runner is it?", actorId: "u1", conversationId: "6" },
    { id: "6:4", kind: "message", role: "assistant", text: "Node's own test runner.", conversationId: "6" }],
};

const listed = {
  ...sessionRecord,
  sideAsks: [
    { conversationId: "6", preview: "Which test runner is it?", createdAt: "2026-11-06T09:20:00.000Z" },
    { conversationId: "5", preview: "Could we wait for the cookie instead?", createdAt: "2026-11-06T09:10:00.000Z" },
  ],
};

const desktop = (overrides: Record<string, unknown> = {}) => open("../App.tsx", { storage: signedIn, platform: "macos", width: 1200, height: 800, network: server({
  [`GET ${ORIGIN}/api/sessions`]: { body: { sessions: [listed] } },
  [`GET ${ORIGIN}/api/sessions/s1/view`]: { body: { view: asked, revision: "r1" } },
  ...overrides,
}) });

describe("side asks in the session list", () => {
  test("are listed under their session, newest first, by their question", async () => {
    const app = await desktop();
    await app.waitFor("id:side-ask-row-s1-6");
    expect(app.shows("id:side-ask-row-s1-5")).toBe(true);
    expect(app.shows("text:Could we wait for the cookie instead?")).toBe(true);
    expect(app.shows("text:Which test runner is it?")).toBe(true);
  });

  test("open the session on that side ask, and the session's own row on the shared conversation", async () => {
    const app = await desktop();
    await app.waitFor("id:side-ask-row-s1-5");
    await app.press("id:side-ask-row-s1-5");
    await app.waitFor("text:Yes: await the login response before reading it.");
    expect(app.shows("text:Read-only · anyone who can view this session can see side asks")).toBe(true);
    expect(app.shows("text:Node's own test runner.")).toBe(false);
    expect(app.shows("text:Why does the login test fail on CI?")).toBe(false);

    await app.press("id:side-ask-row-s1-6");
    await app.waitFor("text:Node's own test runner.");
    expect(app.shows("text:Yes: await the login response before reading it.")).toBe(false);

    await app.press("id:session-row-s1");
    await app.waitFor("text:Why does the login test fail on CI?");
    expect(app.shows("text:Node's own test runner.")).toBe(false);
  });

  test("a side ask the host no longer has opens all of one's side asks", async () => {
    const app = await desktop({ [`GET ${ORIGIN}/api/sessions`]: { body: { sessions: [{ ...listed, sideAsks: [{ conversationId: "9", preview: "Gone", createdAt: "2026-11-06T09:30:00.000Z" }] }] } } });
    await app.waitFor("id:side-ask-row-s1-9");
    await app.press("id:side-ask-row-s1-9");
    await app.waitFor("text:Yes: await the login response before reading it.");
    expect(app.shows("text:Node's own test runner.")).toBe(true);
    expect(app.shows("text:All my side asks")).toBe(true);
  });
});
