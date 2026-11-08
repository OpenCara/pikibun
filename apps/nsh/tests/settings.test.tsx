import { describe, expect, open, test } from "nsh/test";
import { ORIGIN, server, signedIn } from "./fixtures";

// Settings, ported from the web app: each section opens, shows what the server has, and sends what the person changes.

const bodyOf = (app: { requests(): { method: string; url: string; body?: string | null }[] }, method: string, url: string) => {
  const request = app.requests().find(item => item.method === method && item.url === url);
  return request?.body ? JSON.parse(request.body) : undefined;
};

async function openSettings(section: string) {
  const app = await open("../App.tsx", { network: server(), storage: signedIn, platform: "macos", width: 1280, height: 820 });
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
