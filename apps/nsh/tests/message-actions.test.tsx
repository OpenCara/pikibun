import { describe, expect, open, test } from "nsh/test";
import { ORIGIN, server, sessionRecord, signedIn, view } from "./fixtures";

const idle = {
  ...view,
  entries: [
    { id: "0:1", kind: "message", role: "user", text: "Why does the login test fail on CI?", actorId: "u1", conversationId: "0" },
    { id: "0:2", kind: "message", role: "assistant", text: "The test races the session cookie.", conversationId: "0", durationMs: 4200 },
  ],
  approvals: [],
  busy: false,
  activity: "idle",
  queue: [],
};

const bodyOf = (app: { requests(): { method: string; url: string; body?: string | null }[] }, method: string, url: string) => {
  const request = app.requests().find(item => item.method === method && item.url === url);
  return request?.body ? JSON.parse(request.body) : undefined;
};

const desktop = (overrides: Record<string, unknown> = {}) => open("../App.tsx", { storage: signedIn, platform: "macos", width: 1200, height: 800, network: server({
  [`GET ${ORIGIN}/api/sessions/s1/view`]: { body: { view: idle, revision: "r1" } },
  ...overrides,
}) });

describe("a message's actions", () => {
  test("show as icons beside each message, and copy it", async () => {
    const app = await desktop();
    await app.press("id:session-row-s1");
    await app.waitFor("id:message-copy-0-2");
    for (const id of ["message-copy-0-1", "message-revert-0-1", "message-fork-0-1", "message-revert-0-2", "message-fork-0-2"]) expect(app.shows(`id:${id}`)).toBe(true);
    await app.press("id:message-copy-0-2");
    await app.waitFor("text:Message copied");
    expect(app.clipboard()).toBe("The test races the session cookie.");
  });

  test("copy a code block of a reply with its own button", async () => {
    const coded = { ...idle, entries: [idle.entries[0], { ...idle.entries[1], text: "Wait for the cookie:\n\n```ts\nawait page.waitForResponse(\"/login\");\n```\n\nThen read it." }] };
    const app = await desktop({ [`GET ${ORIGIN}/api/sessions/s1/view`]: { body: { view: coded, revision: "r1" } } });
    await app.press("id:session-row-s1");
    await app.waitFor("id:message-copy-0-2");
    await app.hover('text:await page.waitForResponse("/login");');
    await app.waitFor("label:Copy code");
    await app.press("label:Copy code");
    await app.waitUntil(() => app.clipboard() === 'await page.waitForResponse("/login");');
  });

  test("go back to before a message, which returns to the chat box", async () => {
    const app = await desktop({ [`POST ${ORIGIN}/api/sessions/s1/revert`]: { body: { ok: true } } });
    app.onDialog(dialog => (dialog.title === "Go back to before this message?" ? "Go back" : null));
    await app.press("id:session-row-s1");
    await app.waitFor("id:message-revert-0-1");
    await app.press("id:message-revert-0-1");
    await app.waitUntil(() => bodyOf(app, "POST", `${ORIGIN}/api/sessions/s1/revert`) !== undefined);
    expect(bodyOf(app, "POST", `${ORIGIN}/api/sessions/s1/revert`)).toEqual({ entryId: "0:1" });
    await app.waitUntil(() => app.value("id:composer-input") === "Why does the login test fail on CI?");
  });

  test("fork a new session from a reply", async () => {
    const app = await desktop({ [`POST ${ORIGIN}/api/sessions/s1/fork`]: { body: { session: { ...sessionRecord, id: "s3", title: "Fork: Fix the flaky login test" } } } });
    app.onDialog(dialog => (dialog.title === "Fork a new session from here?" ? "Fork session" : null));
    await app.press("id:session-row-s1");
    await app.waitFor("id:message-fork-0-2");
    await app.press("id:message-fork-0-2");
    await app.waitUntil(() => bodyOf(app, "POST", `${ORIGIN}/api/sessions/s1/fork`) !== undefined);
    expect(bodyOf(app, "POST", `${ORIGIN}/api/sessions/s1/fork`)).toEqual({ entryId: "0:2" });
  });

  test("offer a collaborator who drives the work going back, and forking where the host allows it", async () => {
    const app = await desktop({ [`GET ${ORIGIN}/api/sessions/s1`]: { body: { session: { ...sessionRecord, ownerId: "u2", permissions: ["read", "ask", "write"], viewable: true } } } });
    await app.press("id:session-row-s1");
    await app.waitFor("id:message-revert-0-1");
    expect(app.shows("id:message-copy-0-1")).toBe(true);
    expect(app.shows("id:message-fork-0-1")).toBe(false);
    expect(app.shows("id:message-fork-0-2")).toBe(false);
  });

  test("fork a collaborator's own session from a reply, on a host that allows it", async () => {
    const app = await desktop({
      [`GET ${ORIGIN}/api/sessions/s1/view`]: { body: { view: { ...idle, memberForks: true }, revision: "r1" } },
      [`GET ${ORIGIN}/api/sessions/s1`]: { body: { session: { ...sessionRecord, ownerId: "u2", permissions: ["read", "ask", "write"], viewable: true } } },
      [`POST ${ORIGIN}/api/sessions/s1/fork`]: { body: { session: { ...sessionRecord, id: "s3", title: "Fork: Fix the flaky login test" } } },
    });
    app.onDialog(dialog => (dialog.title === "Fork a new session from here?" ? "Fork session" : null));
    await app.press("id:session-row-s1");
    await app.waitFor("id:message-fork-0-2");
    await app.press("id:message-fork-0-2");
    await app.waitUntil(() => bodyOf(app, "POST", `${ORIGIN}/api/sessions/s1/fork`) !== undefined);
    expect(bodyOf(app, "POST", `${ORIGIN}/api/sessions/s1/fork`)).toEqual({ entryId: "0:2" });
  });

  const asked = {
    ...idle,
    askForks: true,
    conversations: [{ id: "0", mode: "write" }, { id: "5", mode: "ask", actorId: "u1" }],
    entries: [...idle.entries,
      { id: "5:3", kind: "message", role: "user", text: "Could we wait for the cookie instead?", actorId: "u1", conversationId: "5" },
      { id: "5:4", kind: "message", role: "assistant", text: "Yes: await the login response before reading it.", conversationId: "5" }],
  };

  test("continue a side ask in a new session, from its reply or before its question", async () => {
    const app = await desktop({
      [`GET ${ORIGIN}/api/sessions/s1/view`]: { body: { view: asked, revision: "r1" } },
      [`POST ${ORIGIN}/api/sessions/s1/fork`]: { body: { session: { ...sessionRecord, id: "s3", title: "Side ask: Fix the flaky login test" } } },
    });
    app.onDialog(dialog => (dialog.title === "Continue in a new session?" ? "Start session" : null));
    await app.press("id:session-row-s1");
    await app.waitFor("id:composer-mode");
    await app.press("id:composer-mode");
    await app.press("text:Side ask");
    await app.waitFor("id:message-fork-5-4");
    expect(app.shows("id:message-revert-5-4")).toBe(false);
    expect(app.shows("id:message-fork-5-3")).toBe(true);
    await app.press("id:message-fork-5-4");
    await app.waitUntil(() => bodyOf(app, "POST", `${ORIGIN}/api/sessions/s1/fork`) !== undefined);
    expect(bodyOf(app, "POST", `${ORIGIN}/api/sessions/s1/fork`)).toEqual({ entryId: "5:4" });
  });

  test("don't offer continuing a side ask where the host can't fork one", async () => {
    const app = await desktop({ [`GET ${ORIGIN}/api/sessions/s1/view`]: { body: { view: { ...asked, askForks: undefined }, revision: "r1" } } });
    await app.press("id:session-row-s1");
    await app.waitFor("id:composer-mode");
    await app.press("id:composer-mode");
    await app.press("text:Side ask");
    await app.waitFor("id:message-copy-5-4");
    for (const id of ["message-fork-5-3", "message-fork-5-4", "message-revert-5-4"]) expect(app.shows(`id:${id}`)).toBe(false);
  });

  test("offer a reader neither going back nor forking", async () => {
    const app = await desktop({
      [`GET ${ORIGIN}/api/sessions/s1/view`]: { body: { view: { ...idle, memberForks: true }, revision: "r1" } },
      [`GET ${ORIGIN}/api/sessions/s1`]: { body: { session: { ...sessionRecord, ownerId: "u2", permissions: ["read", "ask"], viewable: true } } },
    });
    await app.press("id:session-row-s1");
    await app.waitFor("id:message-copy-0-2");
    for (const id of ["message-revert-0-1", "message-fork-0-1", "message-fork-0-2"]) expect(app.shows(`id:${id}`)).toBe(false);
  });
});
