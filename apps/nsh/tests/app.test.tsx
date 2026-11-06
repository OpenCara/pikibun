import { describe, expect, open, test } from "nsh/test";
import { approval, ORIGIN, server, signedIn, TOKEN } from "./fixtures";

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

describe("on a phone", () => {
  test("lists sessions by workspace, archived ones on request", async () => {
    const app = await open("../App.tsx", { network: server(), storage: signedIn });
    await app.waitFor("text:Fix the flaky login test");
    expect(app.texts()).toContain("ANALYTICAL ENGINE");
    expect(app.shows("text:Old spike")).toBe(false);
    await app.press("text:🗄  Show archived (1)");
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
    await app.waitFor("text:No session open");
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

  test("keeps its layout through an appearance change", async () => {
    const app = await open("../App.tsx", { network: server(), storage: signedIn, platform: "macos", width: 1280, height: 820 });
    await app.waitFor("text:No session open");
    await app.press("id:session-row-s1");
    await app.waitFor("id:approval-approve");
    await app.setColorScheme("dark");
    expect(app.shows("id:session-row-s1")).toBe(true);
    expect(app.shows("id:header-back")).toBe(false);
  });
});
