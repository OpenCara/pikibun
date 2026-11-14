import { describe, expect, open, test } from "nsh/test";
import { ORIGIN, server, sessionRecord, signedIn, TOKEN, user, view } from "./fixtures";

const bodyOf = (app: { requests(): { method: string; url: string; body?: string | null }[] }, method: string, url: string) => {
  const request = app.requests().find(item => item.method === method && item.url === url);
  return request?.body ? JSON.parse(request.body) : undefined;
};

describe("signing in", () => {
  test("a test-mode server takes a developer token", async () => {
    const app = await open("../App.tsx", { network: server(), storage: { "pikibun.origin": ORIGIN } });
    await app.waitFor("id:code-input");
    await app.waitFor("id:developer-toggle");
    await app.press("id:developer-toggle");
    await app.type("id:developer-token", TOKEN);
    await app.press("id:developer-sign-in");
    await app.waitFor("text:Fix the flaky login test");
    expect(app.storage()["pikibun.token"]).toBe(TOKEN);
    const me = app.requests().find(item => item.url === `${ORIGIN}/api/me`);
    expect(me?.headers?.authorization ?? me?.headers?.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  test("the app signs in only with a code: no GitHub or password, even where the server offers them", async () => {
    const app = await open("../App.tsx", {
      network: server({ [`GET ${ORIGIN}/api/health`]: { body: { ok: true, githubConfigured: true, codeSignIn: true, passwordAuth: true, passwordSignup: "open" } } }),
      storage: { "pikibun.origin": ORIGIN },
    });
    await app.waitFor("id:code-form");
    await app.wait(200);
    expect(app.shows("id:code-input")).toBe(true);
    expect(app.shows("id:github-sign-in")).toBe(false);
    expect(app.shows("id:password-form")).toBe(false);
    await app.openWithUrl("pikibun://auth?code=c1&state=s1");
    await app.wait(200);
    expect(app.requests().some(item => item.url.endsWith("/api/auth/native/token") || item.url.includes("/api/auth/native/start"))).toBe(false);
    expect(app.storage()["pikibun.token"]).toBeUndefined();
  });

  test("a sign-in the server revoked signs out", async () => {
    const app = await open("../App.tsx", {
      network: server({ [`GET ${ORIGIN}/api/me`]: { status: 401, body: { error: { code: "unauthorized", message: "Authentication is required." } } } }),
      storage: signedIn,
    });
    await app.waitFor("text:Your sign-in expired or was revoked. Sign in again to continue.");
    expect(app.storage()["pikibun.token"]).toBeUndefined();
  });

  test("a sign-in saved for preview.pikibun.com goes on at pikibun.com, the same server, with the same token", async () => {
    const moved = "https://pikibun.com";
    const routes = Object.fromEntries(Object.entries(server()).map(([route, answer]) => [route.replace(ORIGIN, moved), answer]));
    const app = await open("../App.tsx", { network: routes, storage: { "pikibun.token": TOKEN, "pikibun.origin": "https://preview.pikibun.com" } });
    await app.waitFor("text:Fix the flaky login test");
    expect(app.storage()["pikibun.origin"]).toBe(moved);
    expect(app.storage()["pikibun.token"]).toBe(TOKEN);
    const me = app.requests().find(item => item.url === `${moved}/api/me`);
    expect(me?.headers?.authorization ?? me?.headers?.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(app.requests().some(item => item.url.startsWith("https://preview.pikibun.com"))).toBe(false);
  });

  test("any other saved server stays as it is", async () => {
    const app = await open("../App.tsx", { network: server(), storage: signedIn });
    await app.waitFor("text:Fix the flaky login test");
    expect(app.storage()["pikibun.origin"]).toBe(ORIGIN);
  });

  const CODE = "c".repeat(40) + "_-0";
  const codeLink = (origin = ORIGIN) => `pikibun://auth/code?${new URLSearchParams({ server: origin, code: CODE }).toString()}`;
  const codeServer = () => server({
    [`GET ${ORIGIN}/api/health`]: { body: { ok: true, githubConfigured: true, codeSignIn: true } },
    [`POST ${ORIGIN}/api/auth/native/code`]: { body: { token: TOKEN, expiresAt: "2099-01-01T00:00:00.000Z", user } },
  });

  test("a code made in another signed-in app signs in when its link is pasted", async () => {
    const app = await open("../App.tsx", { network: codeServer(), storage: { "pikibun.origin": ORIGIN } });
    await app.waitFor("id:code-input");
    await app.type("id:code-input", "not a code");
    await app.waitFor("id:code-hint");
    expect(app.texts().join(" ")).toContain("isn't a sign-in link or code");
    await app.clear("id:code-input");
    await app.type("id:code-input", codeLink());
    await app.waitFor("text:Signs in to pikibun.test.");
    await app.press("id:code-sign-in");
    await app.waitFor("text:Fix the flaky login test");
    expect(app.storage()["pikibun.token"]).toBe(TOKEN);
    expect(bodyOf(app, "POST", `${ORIGIN}/api/auth/native/code`)).toMatchObject({ code: CODE });
    expect(bodyOf(app, "POST", `${ORIGIN}/api/auth/native/code`).deviceName).toMatch(/^Pikibun \(/);
    expect(app.requests().some(item => item.url.includes("/api/auth/native/start"))).toBe(false);
  });

  test("a new app asks for no server: a pasted sign-in link signs in to the server it names", async () => {
    const app = await open("../App.tsx", { network: codeServer(), storage: {} });
    await app.waitFor("id:code-input");
    expect(app.shows("id:server-input")).toBe(false);
    expect(app.shows("id:server-change")).toBe(false);
    await app.type("id:code-input", codeLink());
    await app.waitFor("text:Signs in to pikibun.test.");
    await app.press("id:code-sign-in");
    await app.waitFor("text:Fix the flaky login test");
    expect(app.storage()["pikibun.origin"]).toBe(ORIGIN);
    expect(app.storage()["pikibun.token"]).toBe(TOKEN);
    expect(app.requests().some(item => item.url === "https://pikibun.com/api/auth/native/code")).toBe(false);
  });

  test("a sign-in link opened from a QR code asks first, naming its server, and signs in to that server", async () => {
    const app = await open("../App.tsx", { network: codeServer(), storage: { "pikibun.origin": "https://elsewhere.test" } });
    await app.waitFor("id:code-input");
    await app.openWithUrl(codeLink());
    await app.waitFor("id:code-link-confirm");
    expect(app.texts().join(" ")).toContain("Sign in to pikibun.test?");
    expect(app.requests().some(item => item.url.endsWith("/api/auth/native/code"))).toBe(false);
    await app.press("id:code-sign-in");
    await app.waitFor("text:Fix the flaky login test");
    expect(app.storage()["pikibun.origin"]).toBe(ORIGIN);
    expect(app.storage()["pikibun.token"]).toBe(TOKEN);
  });

  test("a sign-in link opened and then cancelled signs nobody in, and a broken one says so", async () => {
    const app = await open("../App.tsx", { network: codeServer(), storage: { "pikibun.origin": ORIGIN } });
    await app.waitFor("id:code-input");
    await app.openWithUrl(codeLink());
    await app.waitFor("id:code-link-confirm");
    await app.press("id:code-cancel");
    await app.waitUntil(() => !app.shows("id:code-link-confirm"));
    expect(app.value("id:code-input")).toBe("");
    await app.openWithUrl("pikibun://auth/code?code=short");
    await app.waitFor("id:sign-in-problem");
    expect(app.texts().join(" ")).toContain("isn't complete");
    expect(app.requests().some(item => item.url.endsWith("/api/auth/native/code"))).toBe(false);
    expect(app.storage()["pikibun.token"]).toBeUndefined();
  });
});

describe("signing out", () => {
  const other = { ...user, id: "u2", githubLogin: "grace", displayName: "Grace Hopper" };
  const OTHER_TOKEN = "tok_abcdefghijklmnopqrstuvwxyz012345";
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
    const unauthorized = { status: 401, body: { error: { code: "unauthorized", message: "Authentication is required." } } };
    const app = await open("../App.tsx", { network: server({ [`POST ${ORIGIN}/api/sessions/s1/submit`]: unauthorized }), storage: signedIn });
    await app.press("id:session-row-s1");
    await app.waitFor("id:composer-input");
    await app.type("id:composer-input", "left behind");
    await app.press("id:composer-send");
    await app.waitFor("text:Your sign-in expired or was revoked. Sign in again to continue.");
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
    await app.waitFor("id:code-input", { timeout: 15_000 });
    expect(app.texts().join(" ")).toContain("the server could not revoke the sign-in (it didn't answer)");
    expect(app.storage()["pikibun.token"]).toBeUndefined();
  }, 30_000);

  test("a session opened again shows its transcript before its host answers, and never to the next account", async () => {
    let slow = false;
    const later = (response: Record<string, unknown>) => () => (slow ? { ...response, delay: 10_000 } : response);
    const app = await open("../App.tsx", {
      network: {
        ...accounts,
        [`GET ${ORIGIN}/api/sessions/s1/view`]: later({ body: { view, revision: "r1" } }),
        [`GET ${ORIGIN}/api/sessions/s1/events*`]: later({ status: 200, headers: { "content-type": "text/event-stream" }, body: "" }),
      },
      storage: signedIn,
    });
    app.onDialog(() => "Sign out");
    await app.press("id:session-row-s1");
    await app.waitFor("text:Why does the login test fail on CI?");
    await app.back();
    slow = true;
    await app.press("id:session-row-s1");
    await app.waitFor("text:Why does the login test fail on CI?", { timeout: 2_000 });
    await app.back();
    await app.press("id:open-settings");
    await app.press("id:settings-section-profile");
    await app.press("id:sign-out");
    await app.waitFor("id:developer-toggle");
    await app.press("id:developer-toggle");
    await app.type("id:developer-token", OTHER_TOKEN);
    await app.press("id:developer-sign-in");
    await app.press("id:session-row-s1");
    await app.waitFor("text:Loading…");
    await app.wait(1_000);
    expect(app.texts().join(" ")).not.toContain("Why does the login test fail on CI?");
  });

  test("a session whose host stopped being shared never shows its kept transcript again, though its metadata still reads", async () => {
    let unshared = false;
    const refusal = { status: 403, body: { error: { code: "connector_unavailable", message: "The connector or its workspace sharing is no longer authorized." } } };
    const app = await open("../App.tsx", {
      network: server({
        [`GET ${ORIGIN}/api/sessions/s1`]: () => ({ body: { session: { ...sessionRecord, viewable: !unshared } } }),
        [`GET ${ORIGIN}/api/sessions/s1/view`]: () => (unshared ? refusal : { body: { view, revision: "r1" } }),
        [`GET ${ORIGIN}/api/sessions/s1/events*`]: () => (unshared ? refusal : { status: 200, headers: { "content-type": "text/event-stream" }, body: "" }),
      }),
      storage: signedIn,
    });
    await app.press("id:session-row-s1");
    await app.waitFor("text:Why does the login test fail on CI?");
    await app.back();
    unshared = true;
    await app.press("id:session-row-s1");
    await app.waitFor("text:The connector or its workspace sharing is no longer authorized.");
    expect(app.texts().join(" ")).not.toContain("Why does the login test fail on CI?");
    await app.back();
    await app.press("id:session-row-s1");
    await app.waitFor("text:The connector or its workspace sharing is no longer authorized.");
    expect(app.texts().join(" ")).not.toContain("Why does the login test fail on CI?");
  });
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

  test("opens a session with its transcript, and nothing in it waits for anyone to approve", async () => {
    const app = await open("../App.tsx", { network: server(), storage: signedIn });
    await app.press("id:session-row-s1");
    await app.waitFor("text:Why does the login test fail on CI?");
    await app.waitFor("id:composer-input");
    expect(app.shows("id:approval-approve")).toBe(false);
    expect(app.shows("id:session-approvals")).toBe(false);
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

  test("a session's chat box offers no access choice, and its messages act whatever its last message was, naming no access", async () => {
    const app = await open("../App.tsx", {
      network: server({ [`GET ${ORIGIN}/api/sessions/s1/view`]: { body: { view: { ...view, access: "approval" }, revision: "r1" } } }),
      storage: signedIn,
    });
    await app.press("id:session-row-s1");
    await app.waitFor("id:chat-model");
    expect(app.shows("id:chat-access")).toBe(false);
    expect(app.texts().join(" ")).not.toContain("Read only");
    expect(app.texts().join(" ")).not.toContain("Auto-approve");
    expect(app.texts().join(" ")).not.toContain("Ask before acting");
    await app.type("id:composer-input", "Carry on");
    await app.press("id:composer-send");
    await app.waitUntil(() => bodyOf(app, "POST", `${ORIGIN}/api/sessions/s1/submit`) !== undefined);
    expect(bodyOf(app, "POST", `${ORIGIN}/api/sessions/s1/submit`).options?.access).toBeUndefined();
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
    await app.waitFor("text:What should we work on?");
    expect(app.shows("id:new-start")).toBe(true);
    await app.press("id:session-row-s1");
    await app.waitFor("text:Why does the login test fail on CI?");
    expect(app.shows("id:session-row-s1")).toBe(true);
  });

  test("the chat box keeps its controls on one line on a phone-wide window, with only the hints that warn, and wraps them with its hint on a wide one", async () => {
    const app = await open("../App.tsx", { network: server(), storage: signedIn, platform: "macos", width: 390, height: 800 });
    await app.press("id:session-row-s1");
    await app.waitFor("id:composer-input");
    expect(app.shows("id:composer-tools")).toBe(true);
    expect(app.shows("id:composer-mode")).toBe(true);
    expect(app.shows("text:Runs as Ada Lovelace (you)")).toBe(false);
    expect(app.shows("id:composer-hint")).toBe(false);
    await app.press("id:composer-mode");
    await app.press("text:Side ask");
    await app.waitFor("text:Read-only · anyone who can view this session can see side asks");
    await app.press("id:composer-mode");
    await app.press("text:Shared");
    await app.waitUntil(() => !app.shows("id:composer-hint"));
    await app.setViewport(1200, 800);
    await app.waitFor("text:Runs as Ada Lovelace (you)");
    expect(app.shows("id:composer-tools")).toBe(false);
    expect(app.shows("id:composer-mode")).toBe(true);
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
    await app.press("id:header-back");
    await app.waitFor("id:sidebar");
    await app.waitUntil(() => !app.shows("id:settings-sections"));
    expect(app.shows("text:Why does the login test fail on CI?")).toBe(true);
  });

  test("keeps its layout through an appearance change", async () => {
    const app = await open("../App.tsx", { network: server(), storage: signedIn, platform: "macos", width: 1280, height: 820 });
    await app.waitFor("text:What should we work on?");
    await app.press("id:session-row-s1");
    await app.waitFor("id:composer-input");
    await app.setColorScheme("dark");
    expect(app.shows("id:session-row-s1")).toBe(true);
    expect(app.shows("id:header-back")).toBe(false);
  });
});
