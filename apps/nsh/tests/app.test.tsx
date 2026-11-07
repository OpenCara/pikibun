import { describe, expect, open, test } from "nsh/test";
import { approval, ORIGIN, server, signedIn, TOKEN, user } from "./fixtures";

const bodyOf = (app: { requests(): { method: string; url: string; body?: string | null }[] }, method: string, url: string) => {
  const request = app.requests().find(item => item.method === method && item.url === url);
  return request?.body ? JSON.parse(request.body) : undefined;
};

describe("signing in", () => {
  test("a test-mode server takes a developer token", async () => {
    const app = await open("../App.tsx", { network: server(), storage: { "pikibun.origin": ORIGIN } });
    await app.waitFor("id:github-sign-in");
    await app.waitFor("id:developer-toggle");
    await app.press("id:developer-toggle");
    await app.type("id:developer-token", TOKEN);
    await app.press("id:developer-sign-in");
    await app.waitFor("text:Fix the flaky login test");
    expect(app.storage()["pikibun.token"]).toBe(TOKEN);
    const me = app.requests().find(item => item.url === `${ORIGIN}/api/me`);
    expect(me?.headers?.authorization ?? me?.headers?.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  test("a sign-in the server revoked signs out", async () => {
    const app = await open("../App.tsx", {
      network: server({ [`GET ${ORIGIN}/api/me`]: { status: 401, body: { error: { code: "unauthorized", message: "Authentication is required." } } } }),
      storage: signedIn,
    });
    await app.waitFor("text:Your sign-in expired or was revoked. Sign in again to continue.");
    expect(app.storage()["pikibun.token"]).toBeUndefined();
  });
});

describe("signing out", () => {
  const other = { ...user, id: "u2", githubLogin: "grace", displayName: "Grace Hopper" };
  const OTHER_TOKEN = "tok_abcdefghijklmnopqrstuvwxyz012345";
  // Each token is its own account; both may read the shared session.
  const accounts = server({
    [`GET ${ORIGIN}/api/me`]: (request: { headers?: Record<string, string> }) => {
      const authorization = Object.entries(request.headers ?? {}).find(([name]) => name.toLowerCase() === "authorization")?.[1];
      if (authorization === `Bearer ${TOKEN}`) return { body: { user } };
      if (authorization === `Bearer ${OTHER_TOKEN}`) return { body: { user: other } };
      return { status: 401, body: { error: { code: "unauthorized", message: "Authentication is required." } } };
    },
  });

  test("an unsent draft stays with its account and never reaches the next one", async () => {
    const app = await open("../App.tsx", { network: accounts, storage: signedIn });
    app.onDialog(() => "Sign out");
    await app.press("id:session-row-s1");
    await app.waitFor("id:composer-input");
    await app.type("id:composer-input", "my unsent secret plan");
    // Leaving the session and coming back keeps it, for the same account.
    await app.back();
    await app.press("id:session-row-s1");
    await app.waitFor("id:composer-input");
    expect(app.value("id:composer-input")).toBe("my unsent secret plan");
    await app.back();
    await app.press("id:open-settings");
    await app.press("id:settings-section-profile");
    await app.press("id:sign-out");
    await app.waitFor("id:developer-toggle");
    await app.press("id:developer-toggle");
    await app.type("id:developer-token", OTHER_TOKEN);
    await app.press("id:developer-sign-in");
    await app.press("id:session-row-s1");
    await app.waitFor("id:composer-input");
    expect(app.value("id:composer-input")).toBe("");
    expect(app.texts().join(" ")).not.toContain("my unsent secret plan");
  });

  test("a sign-in that ends on its own takes the drafts with it", async () => {
    // The server revokes the sign-in while a message is being written: sending it is answered 401, and it stays unsent.
    const unauthorized = { status: 401, body: { error: { code: "unauthorized", message: "Authentication is required." } } };
    const app = await open("../App.tsx", { network: server({ [`POST ${ORIGIN}/api/sessions/s1/submit`]: unauthorized }), storage: signedIn });
    await app.press("id:session-row-s1");
    await app.waitFor("id:composer-input");
    await app.type("id:composer-input", "left behind");
    await app.press("id:composer-send");
    await app.waitFor("text:Your sign-in expired or was revoked. Sign in again to continue.");
    // The same account signs in again: the draft is gone all the same, as it would be for anyone else.
    await app.press("id:developer-toggle");
    await app.type("id:developer-token", TOKEN);
    await app.press("id:developer-sign-in");
    await app.press("id:session-row-s1");
    await app.waitFor("id:composer-input");
    expect(app.value("id:composer-input")).toBe("");
  });

  test("a server that doesn't answer doesn't hold up signing out", async () => {
    const app = await open("../App.tsx", {
      network: server({ [`POST ${ORIGIN}/api/auth/logout`]: { status: 204, delay: 60_000 } }),
      storage: signedIn,
    });
    app.onDialog(() => "Sign out");
    await app.press("id:open-settings");
    await app.press("id:settings-section-profile");
    await app.press("id:sign-out");
    await app.waitFor("id:github-sign-in", { timeout: 15_000 });
    expect(app.texts().join(" ")).toContain("the server could not revoke the sign-in (it didn't answer)");
    expect(app.storage()["pikibun.token"]).toBeUndefined();
  }, 30_000);
});

describe("on a phone", () => {
  test("lists sessions by workspace, archived ones on request", async () => {
    const app = await open("../App.tsx", { network: server(), storage: signedIn });
    await app.waitFor("text:Fix the flaky login test");
    expect(app.texts()).toContain("Analytical Engine");
    expect(app.shows("text:Old spike")).toBe(false);
    await app.press("id:toggle-archived");
    await app.waitFor("text:Old spike");
  });

  test("opens a session with its transcript and pending approval, and approves it", async () => {
    const app = await open("../App.tsx", { network: server(), storage: signedIn });
    await app.press("id:session-row-s1");
    await app.waitFor("text:Why does the login test fail on CI?");
    await app.waitFor("id:approval-approve");
    expect(app.texts().join(" ")).toContain("OpenCara/pikibun");
    await app.press("id:approval-approve");
    await app.waitFor("text:Approval decision recorded");
    expect(bodyOf(app, "POST", `${ORIGIN}/api/sessions/s1/approvals/ap1`)).toEqual({ decision: "approve", reviewHash: approval.reviewHash });
  });

  test("sends a message with the session's model", async () => {
    const app = await open("../App.tsx", { network: server(), storage: signedIn });
    await app.press("id:session-row-s1");
    await app.waitFor("id:composer-input");
    await app.type("id:composer-input", "Please also add a regression test");
    await app.press("id:composer-send");
    await app.waitUntil(() => bodyOf(app, "POST", `${ORIGIN}/api/sessions/s1/submit`) !== undefined);
    const body = bodyOf(app, "POST", `${ORIGIN}/api/sessions/s1/submit`);
    expect(body.content).toBe("Please also add a regression test");
    expect(typeof body.requestId).toBe("string");
    await app.waitUntil(() => app.value("id:composer-input") === "");
  });

  test("starts a new session with a first message", async () => {
    const app = await open("../App.tsx", { network: server(), storage: signedIn });
    await app.waitFor("id:new-session");
    await app.press("id:new-session");
    await app.waitFor("text:What should we work on?");
    await app.type("id:new-message", "Add a dark mode");
    await app.waitUntil(() => app.enabled("id:new-start"));
    await app.press("id:new-start");
    await app.waitUntil(() => bodyOf(app, "POST", `${ORIGIN}/api/sessions`) !== undefined);
    expect(bodyOf(app, "POST", `${ORIGIN}/api/sessions`)).toMatchObject({ workspaceId: "w1", modelId: "m1", title: "Add a dark mode", visibility: "workspace" });
    await app.waitUntil(() => bodyOf(app, "POST", `${ORIGIN}/api/sessions/s3/submit`) !== undefined);
    expect(bodyOf(app, "POST", `${ORIGIN}/api/sessions/s3/submit`).content).toBe("Add a dark mode");
  });
});

describe("on a desktop", () => {
  test("shows the list and the open session side by side", async () => {
    const app = await open("../App.tsx", { network: server(), storage: signedIn, platform: "macos", width: 1200, height: 800 });
    // With no session open, the home beside the sidebar starts a new one.
    await app.waitFor("text:What should we work on?");
    expect(app.shows("id:new-start")).toBe(true);
    await app.press("id:session-row-s1");
    await app.waitFor("text:Why does the login test fail on CI?");
    // The list stays beside it.
    expect(app.shows("id:session-row-s1")).toBe(true);
  });

  test("a session opened on a narrow window moves beside the list when the window widens, and back", async () => {
    const app = await open("../App.tsx", { network: server(), storage: signedIn, platform: "macos", width: 500, height: 800 });
    await app.press("id:session-row-s1");
    await app.waitFor("text:Why does the login test fail on CI?");
    expect(app.shows("id:session-row-s1")).toBe(false);
    await app.setViewport(1200, 800);
    await app.waitFor("id:session-row-s1");
    expect(app.shows("text:Why does the login test fail on CI?")).toBe(true);
    await app.setViewport(500, 800);
    await app.waitUntil(() => !app.shows("id:session-row-s1"));
    expect(app.shows("text:Why does the login test fail on CI?")).toBe(true);
  });

  test("starts a session from the home beside the sidebar, opens it there, and goes back home for another", async () => {
    const app = await open("../App.tsx", { network: server(), storage: signedIn, platform: "macos", width: 1200, height: 800 });
    await app.waitFor("text:What should we work on?");
    await app.type("id:new-message", "Add a dark mode");
    await app.waitUntil(() => app.enabled("id:new-start"));
    await app.press("id:new-start");
    await app.waitUntil(() => bodyOf(app, "POST", `${ORIGIN}/api/sessions/s3/submit`) !== undefined);
    expect(bodyOf(app, "POST", `${ORIGIN}/api/sessions`)).toMatchObject({ workspaceId: "w1", title: "Add a dark mode" });
    // The new session opens beside the sidebar, which stays.
    await app.waitUntil(() => !app.shows("text:What should we work on?"));
    expect(app.shows("id:session-row-s1")).toBe(true);
    await app.press("id:new-session");
    await app.waitFor("text:What should we work on?");
    expect(app.value("id:new-message")).toBe("");
  });

  test("settings switch sections in place beside their list, and Back leaves them for the session", async () => {
    const app = await open("../App.tsx", { network: server(), storage: signedIn, platform: "macos", width: 1200, height: 800 });
    await app.press("id:session-row-s1");
    await app.waitFor("id:composer-input");
    await app.press("id:open-settings");
    await app.waitFor("id:settings-sections");
    await app.press("id:settings-section-appearance");
    await app.waitFor("id:appearance-scheme");
    await app.press("id:settings-section-profile");
    await app.waitFor("id:sign-out");
    // One Back: the sections were one page, not a page each.
    await app.press("id:header-back");
    await app.waitFor("id:sidebar");
    await app.waitUntil(() => !app.shows("id:settings-sections"));
    expect(app.shows("text:Why does the login test fail on CI?")).toBe(true);
  });

  test("keeps its layout through an appearance change", async () => {
    const app = await open("../App.tsx", { network: server(), storage: signedIn, platform: "macos", width: 1280, height: 820 });
    await app.waitFor("text:What should we work on?");
    await app.press("id:session-row-s1");
    await app.waitFor("id:approval-approve");
    await app.setColorScheme("dark");
    expect(app.shows("id:session-row-s1")).toBe(true);
    expect(app.shows("id:header-back")).toBe(false);
  });
});
