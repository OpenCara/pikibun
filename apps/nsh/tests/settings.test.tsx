import { describe, expect, open, test } from "nsh/test";
import { notificationRoute } from "../src/lib/notifications";
import { host, ORIGIN, server, signedIn, user, workspace } from "./fixtures";

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

  const appCode = { id: "k1", code: "c".repeat(43), link: `pikibun://auth/code?server=${encodeURIComponent(ORIGIN)}&code=${"c".repeat(43)}`, expiresAt: "2099-01-01T00:00:00.000Z" };

  test("Profile signs in another app with a code, shown as a QR code and a link, until the app uses it", async () => {
    let polls = 0;
    const app = await openSettings("profile", {
      [`POST ${ORIGIN}/api/me/app-codes`]: { status: 201, body: appCode },
      [`GET ${ORIGIN}/api/me/app-codes/k1`]: () => ({ body: { id: "k1", expiresAt: appCode.expiresAt, ...(++polls < 2 ? { status: "pending", deviceName: null } : { status: "used", deviceName: "Ada's MacBook" }) } }),
    });
    await app.waitFor("id:sign-in-app-start");
    await app.press("id:sign-in-app-start");
    await app.waitFor("id:sign-in-app-qr");
    expect(bodyOf(app, "POST", `${ORIGIN}/api/me/app-codes`)).toEqual({});
    expect(app.texts().join(" ")).toContain("Works once");
    expect(app.shows("id:sign-in-app-copy")).toBe(true);
    await app.waitFor("text:Ada's MacBook signed in with the code.", { timeout: 10_000 });
    expect(app.shows("id:sign-in-app-qr")).toBe(false);
  });

  test("Profile asks for a recent sign-in or the password before it makes a code", async () => {
    const app = await openSettings("profile", {
      [`GET ${ORIGIN}/api/me`]: { body: { user: { ...user, username: "ada", hasPassword: true } } },
      [`POST ${ORIGIN}/api/me/app-codes`]: (request: { body?: string | null }) => (JSON.parse(request.body ?? "{}").currentPassword === "four unrelated words here"
        ? { status: 201, body: appCode }
        : { status: 403, body: { error: "Enter your password, or sign in with GitHub again.", code: "recent_sign_in_required" } }),
      [`DELETE ${ORIGIN}/api/me/app-codes/k1`]: { body: { ok: true } },
      [`GET ${ORIGIN}/api/me/app-codes/k1`]: { body: { id: "k1", status: "pending", expiresAt: appCode.expiresAt, deviceName: null } },
    });
    await app.waitFor("id:sign-in-app-start");
    await app.press("id:sign-in-app-start");
    await app.waitFor("text:Sign in with GitHub again");
    await app.waitFor("id:sign-in-app-password");
    await app.type("id:sign-in-app-password", "four unrelated words here");
    await app.press("id:sign-in-app-make");
    await app.waitFor("id:sign-in-app-qr");
    await app.press("id:sign-in-app-cancel");
    await app.waitUntil(() => app.requests().some(item => item.method === "DELETE" && item.url === `${ORIGIN}/api/me/app-codes/k1`));
    expect(app.shows("id:sign-in-app")).toBe(false);
  });

  test("on a Pikibun that runs on its owner's computer, Profile connects github.com with a pasted token and makes a sign-in code with nothing to type", async () => {
    const owner = { ...user, id: "password:ada", username: "ada", githubId: null, githubLogin: null, githubConnected: false, passwordSignIn: true, localOwner: true };
    let connected = false;
    const app = await openSettings("profile", {
      [`GET ${ORIGIN}/api/health`]: { body: { ok: true, githubConfigured: false, passwordAuth: false, codeSignIn: true, localServer: { claimed: true } } },
      [`GET ${ORIGIN}/api/me`]: () => ({ body: { user: connected ? { ...owner, githubId: "4242", githubLogin: "octo", githubConnected: true } : owner } }),
      [`PUT ${ORIGIN}/api/git/accounts/github`]: () => {
        connected = true;
        return { status: 201, body: { account: { id: "github", provider: "github", host: "github.com", organization: "", login: "octo", createdAt: null } } };
      },
      [`POST ${ORIGIN}/api/me/app-codes`]: { status: 201, body: appCode },
      [`GET ${ORIGIN}/api/me/app-codes/k1`]: { body: { id: "k1", status: "pending", expiresAt: appCode.expiresAt, deviceName: null } },
      [`DELETE ${ORIGIN}/api/me/app-codes/k1`]: { body: { ok: true } },
    });
    await app.waitFor("id:connect-github");
    expect(app.texts().join(" ")).toContain("github.com · Not connected");
    expect(app.shows("id:disconnect-github")).toBe(false);
    await app.press("id:connect-github");
    await app.waitFor("id:github-token");
    await app.type("id:github-token", "ghp_secret");
    await app.press("id:github-token-connect");
    await app.waitFor("id:disconnect-github");
    expect(bodyOf(app, "PUT", `${ORIGIN}/api/git/accounts/github`)).toEqual({ token: "ghp_secret" });
    expect(app.texts().join(" ")).toContain("@octo · personal access token");

    await app.press("id:sign-in-app-start");
    await app.waitFor("id:sign-in-app-local");
    expect(bodyOf(app, "POST", `${ORIGIN}/api/me/app-codes`)).toEqual({});
    expect(app.shows("id:sign-in-app-qr")).toBe(false);
    expect(app.shows("id:sign-in-app-password")).toBe(false);
    expect(app.shows("id:sign-in-app-copy")).toBe(true);
  });

  test("Profile lists the servers the app is signed in to, switches between them without signing out, and adds another", async () => {
    const OTHER = "https://team.example.com";
    const OTHER_TOKEN = "tok_other_0123456789abcdefghijklmnop";
    const there = Object.fromEntries(Object.entries(server({ [`GET ${ORIGIN}/api/me`]: { body: { user: { ...user, id: "u1", githubLogin: "grace", displayName: "Grace Hopper" } } } }))
      .map(([key, value]) => [key.replace(ORIGIN, OTHER), value]));
    const app = await open("../App.tsx", { network: { ...there, ...server() }, platform: "macos", width: 1280, height: 820,
      storage: { ...signedIn, "pikibun.servers": JSON.stringify([{ origin: OTHER, token: OTHER_TOKEN, expiresAt: null, account: "@grace" }]) } });
    const saved = () => (JSON.parse(app.storage()["pikibun.servers"] ?? "[]") as { origin: string; token: string }[]).map(item => [item.origin, item.token]);
    await app.waitFor("id:session-row-s1");
    await app.waitUntil(() => saved().length === 2);
    await app.press("id:open-settings");
    await app.press("id:settings-section-profile");
    await app.waitFor("id:server-switch-team.example.com");
    expect(app.shows("id:server-switch-pikibun.test")).toBe(false);
    expect(app.texts().join(" ")).toContain("This server");

    await app.press("id:server-switch-team.example.com");
    await app.waitUntil(() => app.storage()["pikibun.origin"] === OTHER && app.storage()["pikibun.token"] === OTHER_TOKEN);
    await app.waitFor("id:session-row-s1");
    expect(app.requests().some(item => item.url.endsWith("/api/auth/logout"))).toBe(false);
    expect(saved()).toEqual([[ORIGIN, signedIn["pikibun.token"]], [OTHER, OTHER_TOKEN]]);

    await app.press("id:open-settings");
    await app.press("id:settings-section-profile");
    await app.waitFor("id:server-switch-pikibun.test");
    await app.press("id:server-add");
    await app.waitFor("id:server-input");
    expect(app.shows("id:switch-server-team.example.com")).toBe(true);
    await app.press("id:switch-server-pikibun.test");
    await app.waitUntil(() => app.storage()["pikibun.origin"] === ORIGIN);
    await app.waitFor("id:session-row-s1");
    expect(saved().length).toBe(2);

    await app.press("id:open-servers");
    await app.waitFor("id:server-menu-team.example.com");
    await app.press("id:server-menu-team.example.com");
    await app.waitUntil(() => app.storage()["pikibun.origin"] === OTHER && app.storage()["pikibun.token"] === OTHER_TOKEN);
    await app.waitFor("id:session-row-s1");
    await app.press("id:open-servers");
    await app.waitFor("id:server-menu-add");
    await app.press("id:server-menu-add");
    await app.waitFor("id:server-input");
    expect(saved().length).toBe(2);
  });

  test("the sidebar's server switch says why it couldn't switch, and stays where it is", async () => {
    const OTHER = "https://team.example.com";
    const app = await open("../App.tsx", { platform: "macos", width: 1280, height: 820,
      network: server({ [`GET ${OTHER}/api/me`]: { status: 401, body: { error: "Authentication is required.", code: "unauthorized" } } }),
      storage: { ...signedIn, "pikibun.servers": JSON.stringify([{ origin: OTHER, token: "tok_revoked_0123456789abcdefghijklmn", expiresAt: null, account: "@grace" }]) } });
    await app.waitFor("id:session-row-s1");
    await app.press("id:open-servers");
    await app.waitFor("id:server-menu-team.example.com");
    await app.press("id:server-menu-team.example.com");
    await app.waitFor("id:server-switch-problem");
    expect(app.texts().join(" ")).toContain("Your sign-in to team.example.com expired or was revoked.");
    expect(app.storage()["pikibun.origin"]).toBe(ORIGIN);
    expect(app.shows("id:open-hosts")).toBe(false);
  });

  test("a server whose sign-in was revoked is forgotten when the app switches to it, and the app stays where it is", async () => {
    const OTHER = "https://team.example.com";
    const app = await open("../App.tsx", { platform: "macos", width: 1280, height: 820,
      network: server({ [`GET ${OTHER}/api/me`]: { status: 401, body: { error: "Authentication is required.", code: "unauthorized" } } }),
      storage: { ...signedIn, "pikibun.servers": JSON.stringify([{ origin: OTHER, token: "tok_revoked_0123456789abcdefghijklmn", expiresAt: null, account: "@grace" }]) } });
    await app.waitFor("id:session-row-s1");
    await app.press("id:open-settings");
    await app.press("id:settings-section-profile");
    await app.waitFor("id:server-switch-team.example.com");
    await app.press("id:server-switch-team.example.com");
    await app.waitFor("text:Your sign-in to team.example.com expired or was revoked. Add it again to sign in.");
    expect(app.shows("id:server-switch-team.example.com")).toBe(false);
    expect([app.storage()["pikibun.origin"], app.storage()["pikibun.token"]]).toEqual([ORIGIN, signedIn["pikibun.token"]]);
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

  test("in the desktop app, notifications turned on show the account's new ones as the system's, each opening its session, but not one about the session in front", async () => {
    let permission = "default";
    const shown: { id: string; title: string; body?: string }[] = [];
    let fed = 0;
    const app = await open("../App.tsx", {
      storage: signedIn, platform: "macos", width: 1280, height: 820, clock: {},
      network: server({
        [`GET ${ORIGIN}/api/notifications/feed*`]: () => (fed++ === 0
          ? { body: { notifications: [], cursor: "c1" } }
          : { body: { notifications: [{ id: "n1", kind: "finished", title: "Finished: Fix the flaky login test", body: "The agent finished.", sessionId: "s1", createdAt: "2026-11-12T00:00:00.000Z" }], cursor: "c2" } }),
      }),
      modules: { nsh: {
        "Notifications.permission": () => permission,
        "Notifications.requestPermission": () => (permission = "granted"),
        "Notifications.show": (notification: { id: string; title: string; body?: string }) => { shown.push(notification); return true; },
      } },
    });
    await app.waitFor("id:session-row-s1");
    await app.press("id:open-settings");
    await app.press("id:settings-section-notifications");
    await app.waitFor("id:notifications-device-toggle");
    expect(app.texts().join(" ")).toContain("This app shows notifications while it's open");
    await app.press("id:notifications-device-toggle");
    await app.waitFor("text:Notifications are on for this device.");
    expect(app.storage()[`pikibun.notifications.${user.id}`]).toBe("on");
    await app.clock!.runFor(25_000);
    await app.waitUntil(() => shown.length > 0);
    expect(shown).toEqual([{ id: "n1 #/s/s1", title: "Finished: Fix the flaky login test", body: "The agent finished." }]);
    expect(notificationRoute(shown[0]!.id)).toEqual({ name: "session", sessionId: "s1" });
    expect(notificationRoute("n2 #/settings/notifications")).toEqual({ name: "settings", section: "notifications" });
    expect(notificationRoute("n3")).toBe(null);

    await app.press("id:header-back");
    await app.waitUntil(() => !app.shows("id:settings-sections"));
    await app.press("id:session-row-s1");
    await app.waitFor("id:composer-input");
    fed = 1;
    await app.clock!.runFor(25_000);
    expect(fed).toBeGreaterThan(1);
    expect(shown.length).toBe(1);
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

  test("a host without Chromium offers its owner a chat on it, in their private workspace, that installs one", async () => {
    const config = { commandTimeoutSeconds: 30, gpu: false, gitCredentials: false, repositoryCache: "off", hostSessions: false, compaction: {}, builtinExtensions: [], requiredExtensions: [],
      browser: { source: "auto" }, serviceLifetimeSeconds: 3600, tunnel: { source: "auto" }, fakeIpTunnels: false };
    const browser = { source: "piki:browser", dev: false, description: "A headless Chromium", modules: [] };
    const app = await openSettings("hosts", {
      [`GET ${ORIGIN}/api/workspaces`]: { body: { workspaces: [{ id: "w0", name: "Private", ownerId: "u1", role: "owner", personal: true }, workspace] } },
      [`GET ${ORIGIN}/api/connectors`]: { body: { connectors: [{ ...host, role: "owner", connectedWorkspaceIds: ["w1"], version: "0.40.0", config, capabilities: { ...host.capabilities, extensions: true } }] } },
      [`GET ${ORIGIN}/api/connectors/c1/extensions`]: { body: { role: "owner", automaticTools: false, requests: [], workspaces: [],
        report: { installed: [browser], remoteInstalls: true, browser: { source: "auto", state: "missing" }, tunnel: { source: "auto", state: "ready" } } } },
      [`GET ${ORIGIN}/api/workspaces/w0/models`]: { body: { models: [{ id: "m0", workspaceId: "w0", name: "Claude Sonnet", connectorId: "c1", provider: "anthropic", modelId: "claude-sonnet" }] } },
    });
    await app.press("id:host-row-c1");
    await app.waitFor("text:piki:browser");
    await app.press("text:piki:browser");
    await app.waitFor("id:install-chat-browser");
    await app.press("id:install-chat-browser");
    await app.waitUntil(() => Boolean(bodyOf(app, "POST", `${ORIGIN}/api/sessions/s3/submit`)));
    expect(bodyOf(app, "POST", `${ORIGIN}/api/sessions`)).toEqual({ workspaceId: "w0", modelId: "m0", title: "Install chromium on ada-mac", visibility: "private" });
    expect(bodyOf(app, "POST", `${ORIGIN}/api/sessions/s3/submit`).content).toContain("the browser tool's chromium");
    await app.waitFor("text:Add a dark mode");
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

  test("Workspaces shows each role's tools and creates a tool group with the tools an admin picks", async () => {
    const app = await openSettings("workspaces");
    await app.waitFor("id:workspace-w1");
    await app.press("id:workspace-w1");
    await app.waitFor("id:workspace-tool-groups");
    await app.waitFor("id:workspace-member-tools");
    expect(app.texts().join(" ")).toContain("Members (role)");
    expect(app.texts().join(" ")).toContain("All but: Push to other branches, open pull requests");
    await app.press("id:new-tool-group");
    await app.waitFor("id:tool-group-editor");
    await app.type("id:tool-group-name", "Releasers");
    for (const tool of ["read", "git", "git_push", "github_merge"]) await app.press(`id:tool-${tool}`);
    await app.press("id:tool-group-save");
    await app.waitUntil(() => bodyOf(app, "POST", `${ORIGIN}/api/workspaces/w1/tool-groups`) !== undefined);
    expect(bodyOf(app, "POST", `${ORIGIN}/api/workspaces/w1/tool-groups`)).toEqual({ name: "Releasers", tools: ["read", "git", "git_push", "github_merge"] });
  });

  test("Extensions adds auto mode as one of Pikibun's features, which needs no host", async () => {
    const autoMode = { source: "piki:auto-mode", enabled: true, tools: "automatic", settings: {} };
    const app = await openSettings("workspaces", {
      [`PUT ${ORIGIN}/api/workspaces/w1/extensions`]: { body: { extensions: [autoMode] } },
    });
    await app.waitFor("id:workspace-w1");
    await app.press("id:workspace-w1");
    await app.waitFor("id:workspace-extensions");
    await app.press("text:Add extension");
    await app.waitFor("text:Pikibun features");
    await app.press("text:Auto mode");
    await app.waitUntil(() => app.texts().some(item => item.startsWith("Adds Auto to the host and model dropdowns") && item.endsWith("It has no settings.")));
    await app.press("text:Save");
    await app.waitUntil(() => bodyOf(app, "PUT", `${ORIGIN}/api/workspaces/w1/extensions`) !== undefined);
    expect(bodyOf(app, "PUT", `${ORIGIN}/api/workspaces/w1/extensions`)).toMatchObject({ source: "piki:auto-mode", enabled: true });
  });

  test("Extensions lists auto mode without hosts to install it on", async () => {
    const app = await openSettings("workspaces", {
      [`GET ${ORIGIN}/api/workspaces/w1/extensions`]: { body: { admin: true, extensions: [{ source: "piki:auto-mode", enabled: true, tools: "automatic", settings: {} }],
        hosts: [{ id: "c1", name: "ada-mac", ownerId: "u1", ownerName: "ada" }] } },
    });
    await app.waitFor("id:workspace-w1");
    await app.press("id:workspace-w1");
    await app.waitFor("text:Auto mode · piki:auto-mode");
    expect(app.texts().join(" ")).toContain("Runs in Pikibun itself: hosts install nothing");
    expect(app.texts().join(" ")).not.toContain("0 of 1 host");
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
