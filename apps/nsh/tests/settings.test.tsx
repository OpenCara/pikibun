import { describe, expect, open, test } from "nsh/test";
import { ORIGIN, server, signedIn, user } from "./fixtures";

const bodyOf = (app: { requests(): { method: string; url: string; body?: string | null }[] }, method: string, url: string) => {
  const request = app.requests().find(item => item.method === method && item.url === url);
  return request?.body ? JSON.parse(request.body) : undefined;
};

async function openSettings(section: string, overrides: Record<string, unknown> = {}) {
  const app = await open("../App.tsx", { network: server(overrides), storage: signedIn, platform: "macos", width: 1280, height: 820 });
  await app.waitFor("id:session-row-s1");
  await app.press("id:open-settings");
  await app.press(`id:settings-section-${section}`);
  return app;
}

describe("settings", () => {
  test("Profile saves the identity and lists the signed-in apps and connected accounts", async () => {
    const app = await openSettings("profile");
    await app.waitFor("id:settings-profile");
    await app.waitFor("text:Ada's iPhone");
    expect(app.shows("id:git-accounts")).toBe(true);
    expect(app.shows("id:document-accounts")).toBe(true);
    await app.clear("id:profile-display-name");
    await app.type("id:profile-display-name", "Countess Ada");
    await app.press("id:profile-save");
    await app.waitFor("text:Profile saved. New sessions use your configured identity.");
    expect(bodyOf(app, "PATCH", `${ORIGIN}/api/me`)).toMatchObject({ displayName: "Countess Ada", gitName: "Ada", gitEmail: "ada@example.com", env: {} });
  });

  test("Password sets a first password where the server takes them", async () => {
    const app = await openSettings("password", {
      [`GET ${ORIGIN}/api/health`]: { body: { ok: true, githubConfigured: true, passwordAuth: true, testMode: true } },
      [`GET ${ORIGIN}/api/me`]: { body: { user: { ...user, username: "ada", hasPassword: false } } },
      [`POST ${ORIGIN}/api/me/password`]: { body: { user: { ...user, username: "ada", hasPassword: true } } },
    });
    await app.waitFor("id:password-form");
    await app.type("id:password-new", "four unrelated words here");
    await app.type("id:password-confirm", "four unrelated words here");
    await app.press("id:password-save");
    await app.waitFor("text:Password set. You can now sign in with your username and this password.");
    expect(bodyOf(app, "POST", `${ORIGIN}/api/me/password`)).toEqual({ newPassword: "four unrelated words here" });
  });

  test("Password is listed only where the server takes passwords or the account has one", async () => {
    const app = await openSettings("profile");
    await app.waitFor("id:settings-profile");
    expect(app.shows("id:settings-section-password")).toBe(false);
  });

  test("Notifications saves what to be told about", async () => {
    const app = await openSettings("notifications");
    await app.waitFor("id:notify-finished");
    await app.press("id:notify-finished");
    await app.waitUntil(() => Boolean(bodyOf(app, "PUT", `${ORIGIN}/api/notifications/preferences`)));
    expect(bodyOf(app, "PUT", `${ORIGIN}/api/notifications/preferences`)).toEqual({ finished: true });
  });

  test("Hosts lists the hosts, opens one's page, pairs a new one and goes back", async () => {
    const app = await openSettings("hosts");
    await app.waitFor("id:host-row-c1");
    await app.press("id:host-row-c1");
    await app.waitFor("id:host-detail");
    for (const part of ["host-models", "host-sharing", "host-configuration", "host-extensions", "host-admins", "host-danger"]) await app.waitFor(`id:${part}`);
    await app.press("id:hosts-back");
    await app.waitFor("id:host-row-c1");
    await app.press("id:pair-host");
    await app.type("id:pair-host-name", "Build box");
    await app.press("id:pair-create");
    await app.waitFor("text:pair-secret-code");
    expect(bodyOf(app, "POST", `${ORIGIN}/api/connectors/pairings`)).toEqual({ name: "Build box" });
  });

  test("a host's browser setup keeps what is being typed while its status refreshes", async () => {
    const app = await open("./harness/tool-setup.tsx", {});
    await app.press("text:This path");
    await app.waitFor("text:Chromium executable");
    await app.type("id:browser-path", "/opt/chromium/chrome");
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(app.shows("text:Chromium executable")).toBe(true);
    expect(app.value("id:browser-path")).toBe("/opt/chromium/chrome");
  });

  test("Workspaces opens a workspace's page with its sources, settings and members", async () => {
    const app = await openSettings("workspaces");
    await app.waitFor("id:workspace-w1");
    await app.press("id:workspace-w1");
    for (const part of ["workspace-sources", "workspace-connections", "workspace-push-access", "workspace-network", "workspace-extensions", "workspace-database", "workspace-members", "workspace-invite"]) {
      await app.waitFor(`id:${part}`);
    }
    await app.waitFor("text:OpenCara/pikibun");
    await app.press("id:workspaces-back");
    await app.waitFor("id:workspace-w1");
  });

  test("a new workspace is created and its first session starts there", async () => {
    const app = await openSettings("workspaces");
    await app.waitFor("id:new-workspace");
    await app.press("id:new-workspace");
    await app.type("id:new-workspace-name", "Difference Engine");
    await app.press("id:new-workspace-create");
    await app.waitFor("text:What should we work on?");
    expect(bodyOf(app, "POST", `${ORIGIN}/api/workspaces`)).toEqual({ name: "Difference Engine" });
  });
});

describe("a new GitHub account", () => {
  test("chooses its username before anything else", async () => {
    const app = await open("../App.tsx", { storage: signedIn, network: server({
      [`GET ${ORIGIN}/api/me`]: { body: { user: { ...user, usernameRequired: true } } },
      [`POST ${ORIGIN}/api/me/username`]: { body: { user: { ...user, username: "ada", usernameRequired: false } } },
    }) });
    await app.waitFor("id:username-setup");
    expect(app.shows("id:session-row-s1")).toBe(false);
    expect(app.value("id:username-input")).toBe("ada");
    await app.press("id:username-continue");
    await app.waitFor("id:session-row-s1");
    expect(bodyOf(app, "POST", `${ORIGIN}/api/me/username`)).toEqual({ username: "ada" });
  });
});
