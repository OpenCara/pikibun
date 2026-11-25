import { describe, expect, open, test } from "nsh/test";
import { notificationRoute } from "../src/lib/notifications";
import { defaultHostConfig } from "../../../packages/shared/src/host-config";
import { host, ORIGIN, server, signedIn, toolGroups, user, workspace } from "./fixtures";

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

async function openWorkspace(app: { waitFor(target: string): Promise<unknown>; press(target: string): Promise<unknown> }, tab?: "sources" | "agents" | "sessions") {
  await app.waitFor("id:workspace-w1");
  await app.press("id:workspace-w1");
  await app.waitFor("id:workspace-tab-overview");
  if (!tab) return;
  await app.press(`id:workspace-tabs-${tab}`);
  await app.waitFor(`id:workspace-tab-${tab}`);
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

  test("Profile connects a remote MCP server once and uses the connection in a workspace whose server signs in with members' own accounts", async () => {
    const at = "2026-11-20T10:00:00.000Z";
    const mine = { id: "mc1", name: "Linear", url: "https://mcp.linear.app/mcp", headerNames: [], workspaces: [], offeredIn: [{ id: "w1", name: workspace.name }], createdAt: at, updatedAt: at };
    let added = false;
    let used = false;
    const app = await openSettings("profile", {
      [`GET ${ORIGIN}/api/mcp-connections`]: () => ({ body: { connections: !added ? [] : [used ? { ...mine, workspaces: [{ id: "w1", name: workspace.name }], offeredIn: [] } : mine] } }),
      [`POST ${ORIGIN}/api/mcp-connections`]: () => { added = true; return { status: 201, body: { connection: mine } }; },
      [`PUT ${ORIGIN}/api/mcp-connections/mc1/workspaces/w1`]: () => { used = true; return { body: { connection: mine } }; },
    });
    await app.waitFor("id:mcp-connections");
    await app.waitFor("text:No connections");
    await app.press("id:mcp-connection-add");
    await app.waitFor("id:mcp-connection-name");
    await app.type("id:mcp-connection-name", "Linear");
    await app.type("id:mcp-connection-url", "https://mcp.linear.app/mcp");
    await app.press("id:mcp-connection-connect");
    await app.waitFor("id:mcp-connection-mc1");
    expect(bodyOf(app, "POST", `${ORIGIN}/api/mcp-connections`)).toEqual({ name: "Linear", url: "https://mcp.linear.app/mcp" });
    await app.press("text:Linear");
    await app.waitFor("id:mcp-connection-use-w1");
    await app.press("id:mcp-connection-use-w1");
    await app.waitFor(`text:${workspace.name} uses it for your requests from your next message.`);
    await app.waitUntil(() => app.texts().join(" ").includes(`used in ${workspace.name}`));
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

  test("on a Pikibun that runs on its owner's computer, Profile signs in to GitHub with a code entered there, or a pasted token, and makes a sign-in code with nothing to type", async () => {
    const owner = { ...user, id: "password:ada", username: "ada", githubId: null, githubLogin: null, githubConnected: false, passwordSignIn: true, localOwner: true };
    let connected = false;
    let polls = 0;
    const app = await openSettings("profile", {
      [`POST ${ORIGIN}/api/git/accounts/github/device`]: { status: 201, body: { signIn: { id: "d1", userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", expiresAt: "2099-01-01T00:00:00.000Z", interval: 1 } } },
      [`POST ${ORIGIN}/api/git/accounts/github/device/d1`]: () => {
        if (++polls < 2) return { body: { status: "pending", interval: 1 } };
        connected = true;
        return { body: { status: "connected", account: { id: "github", provider: "github", host: "github.com", organization: "", login: "octo", createdAt: null } } };
      },
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
    await app.waitFor("id:github-sign-in-open");
    expect(app.texts().join(" ")).toContain("WDJB-MJHT");
    await app.press("id:github-sign-in-open");
    expect(app.openedUrls()).toEqual(["https://github.com/login/device"]);
    await app.waitFor("id:disconnect-github", { timeout: 10_000 });
    expect(polls).toBe(2);
    expect(app.shows("id:github-sign-in-open")).toBe(false);
    expect(app.texts().join(" ")).toContain("@octo · connected");

    connected = false;
    await app.press("id:connect-github");
    await app.waitFor("id:github-sign-in-use-token");
    await app.press("id:github-sign-in-use-token");
    await app.waitFor("id:github-token");
    await app.type("id:github-token", "ghp_secret");
    await app.press("id:github-token-connect");
    await app.waitUntil(() => Boolean(bodyOf(app, "PUT", `${ORIGIN}/api/git/accounts/github`)));
    expect(bodyOf(app, "PUT", `${ORIGIN}/api/git/accounts/github`)).toEqual({ token: "ghp_secret" });
    await app.waitUntil(() => !app.shows("id:github-token"));
    expect(polls).toBe(2);

    await app.press("id:sign-in-app-start");
    await app.waitFor("id:sign-in-app-local");
    expect(bodyOf(app, "POST", `${ORIGIN}/api/me/app-codes`)).toEqual({});
    expect(app.shows("id:sign-in-app-qr")).toBe(false);
    expect(app.shows("id:sign-in-app-password")).toBe(false);
    expect(app.shows("id:sign-in-app-copy")).toBe(true);
  });

  test("in the app, Profile disconnects GitHub and signs in to it again in the browser, then shows it connected by itself", async () => {
    let connected = true;
    const app = await openSettings("profile", {
      [`GET ${ORIGIN}/api/me`]: () => ({ body: { user: { ...user, githubConnected: connected } } }),
      [`DELETE ${ORIGIN}/api/git/accounts/github`]: () => { connected = false; return { status: 204 }; },
    });
    await app.waitFor("id:disconnect-github");
    app.onDialog(dialog => (dialog.title === "Disconnect GitHub" ? "Disconnect" : null));
    await app.press("id:disconnect-github");
    await app.waitFor("text:GitHub disconnected.");
    await app.waitFor("id:connect-github");
    await app.press("id:connect-github");
    expect(app.openedUrls()).toEqual([`${ORIGIN}/api/auth/github`]);
    await app.waitFor("text:github.com · Finish signing in with GitHub as @ada in your browser; this updates by itself");
    connected = true;
    await app.waitFor("id:disconnect-github", { timeout: 10_000 });
    expect(app.texts().join(" ")).toContain("@ada · signed in");
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
    await app.waitFor("id:code-input");
    expect(app.shows("id:server-input")).toBe(false);
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
    await app.waitFor("id:code-input");
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

  test("in the desktop app, notifications turned on show the account's new ones as the system's and take them from the phone, each opening its session, but not one about the session in front", async () => {
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
    expect(bodyOf(app, "POST", `${ORIGIN}/api/notifications/handled`)).toEqual({ ids: ["n1"] });
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
      browser: { source: "auto" }, serviceLifetimeSeconds: 3600, tunnel: { source: "auto" }, fakeIpTunnels: false, buildCaches: "off", buildCacheGiB: 20, commandTimeoutUnlimited: false, modelExtensions: [], cacheWarming: true, extensionFiles: [] };
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
    expect(bodyOf(app, "POST", `${ORIGIN}/api/sessions`)).toEqual({ workspaceId: "w0", modelId: "m0", title: "Install chromium on ada-mac" });
    expect(bodyOf(app, "POST", `${ORIGIN}/api/sessions/s3/submit`).content).toContain("the browser tool's chromium");
    await app.waitFor("text:Add a dark mode");
  });

  test("a host's owner marks an installed extension as providing models once they confirm what it runs as, and unmarks one the host lacks", async () => {
    const config = { commandTimeoutSeconds: 30, gpu: false, gitCredentials: false, repositoryCache: "off", hostSessions: false, compaction: {}, builtinExtensions: [], requiredExtensions: [],
      browser: { source: "auto" }, serviceLifetimeSeconds: 3600, tunnel: { source: "auto" }, fakeIpTunnels: false, buildCaches: "off", buildCacheGiB: 20, modelExtensions: ["npm:pi-gone@1.0.0"] };
    const installed = { source: "npm:pi-provider@1.0.0", dev: false, description: "Models from a proxy",
      modules: [{ path: "index.ts", tools: [], events: [], flags: [], noops: [], ignored: ["provider proxy"] }] };
    const routes = (role: "owner" | "admin", capabilities: Record<string, unknown>) => ({
      [`GET ${ORIGIN}/api/connectors`]: { body: { connectors: [{ ...host, role, connectedWorkspaceIds: ["w1"], version: "0.40.0", config, capabilities: { ...host.capabilities, extensions: true, ...capabilities } }] } },
      [`GET ${ORIGIN}/api/connectors/c1/extensions`]: { body: { role, automaticTools: false, requests: [], workspaces: [], report: { installed: [installed], remoteInstalls: true } } },
      [`PATCH ${ORIGIN}/api/connectors/c1/config`]: { body: { config } },
    });
    const patched = (app: Parameters<typeof bodyOf>[0]) => app.requests().filter(item => item.method === "PATCH" && item.url === `${ORIGIN}/api/connectors/c1/config`).map(item => JSON.parse(item.body ?? "{}"));
    const app = await openSettings("hosts", routes("owner", { extensionModels: true }));
    await app.press("id:host-row-c1");
    await app.waitFor("text:npm:pi-provider@1.0.0");
    await app.waitFor("text:npm:pi-gone@1.0.0");
    expect(app.texts().join(" ")).toContain("Marked to provide models, but not installed here at that version");
    await app.press("text:npm:pi-provider@1.0.0");
    await app.waitFor("id:provide-models-npm:pi-provider@1.0.0");
    const asked: string[] = [];
    app.onDialog(dialog => { asked.push(`${dialog.title}: ${dialog.message}`); return "Cancel"; });
    await app.press("id:provide-models-npm:pi-provider@1.0.0");
    await app.waitUntil(() => asked.length === 1);
    expect(asked[0]).toContain("Let npm:pi-provider@1.0.0 provide models?");
    expect(asked[0]).toContain("as your OS user and outside any sandbox");
    expect(patched(app)).toEqual([]);
    app.onDialog(dialog => (dialog.title === "Let npm:pi-provider@1.0.0 provide models?" ? "Provide models" : null));
    await app.press("id:provide-models-npm:pi-provider@1.0.0");
    await app.waitUntil(() => patched(app).length === 1);
    expect(patched(app)).toEqual([{ modelExtensions: ["npm:pi-gone@1.0.0", "npm:pi-provider@1.0.0"] }]);
    await app.press("text:Unmark");
    await app.waitUntil(() => patched(app).length === 2);
    expect(patched(app)[1]).toEqual({ modelExtensions: [] });

    const refusing = await openSettings("hosts", routes("owner", {}));
    await refusing.press("id:host-row-c1");
    await refusing.waitFor("text:npm:pi-provider@1.0.0");
    await refusing.press("text:npm:pi-provider@1.0.0");
    await refusing.waitFor("text:Provide models (not with this host's connector)");
    await expect(refusing.press("id:provide-models-npm:pi-provider@1.0.0")).rejects.toThrow(/is disabled/);
    expect(patched(refusing)).toEqual([]);

    const admin = await openSettings("hosts", routes("admin", { extensionModels: true }));
    await admin.press("id:host-row-c1");
    await admin.waitFor("text:npm:pi-provider@1.0.0");
    await admin.press("text:npm:pi-provider@1.0.0");
    await admin.waitFor("text:Not supported: provider proxy");
    expect(admin.shows("id:provide-models-npm:pi-provider@1.0.0")).toBe(false);
    expect(admin.shows("text:Unmark")).toBe(false);
  });

  test("a host's owner shares a host file with an extension, prefilled for pi-web-access, once they confirm who reads it, and stops sharing it", async () => {
    const config = { commandTimeoutSeconds: 30, gpu: false, gitCredentials: false, repositoryCache: "off", hostSessions: false, compaction: {}, builtinExtensions: [], requiredExtensions: [],
      browser: { source: "auto" }, serviceLifetimeSeconds: 3600, tunnel: { source: "auto" }, fakeIpTunnels: false, buildCaches: "off", buildCacheGiB: 20, modelExtensions: [], cacheWarming: true,
      extensionFiles: [{ extension: "npm:other", path: "~/other.json", target: "other.json" }] };
    const installed = { source: "npm:pi-web-access@0.46.0", dev: false, description: "Web search", modules: [] };
    const routes = (role: "owner" | "admin") => ({
      [`GET ${ORIGIN}/api/connectors`]: { body: { connectors: [{ ...host, role, connectedWorkspaceIds: ["w1"], version: "0.40.0", config, capabilities: { ...host.capabilities, extensions: true } }] } },
      [`GET ${ORIGIN}/api/connectors/c1/extensions`]: { body: { role, automaticTools: false, requests: [], workspaces: [], report: { installed: [installed], remoteInstalls: true } } },
      [`PATCH ${ORIGIN}/api/connectors/c1/config`]: { body: { config } },
    });
    const patched = (app: Parameters<typeof bodyOf>[0]) => app.requests().filter(item => item.method === "PATCH" && item.url === `${ORIGIN}/api/connectors/c1/config`).map(item => JSON.parse(item.body ?? "{}"));
    const app = await openSettings("hosts", routes("owner"));
    await app.press("id:host-row-c1");
    await app.waitFor("id:host-extension-files");
    await app.waitFor("text:~/other.json");
    await app.press("id:share-extension-file");
    await app.waitFor("id:extension-file-target");
    const asked: string[] = [];
    app.onDialog(dialog => { asked.push(`${dialog.title}: ${dialog.message}`); return dialog.title?.startsWith("Share ") ? "Share" : null; });
    await app.press("text:Share");
    await app.waitUntil(() => patched(app).length === 1);
    expect(asked[0]).toContain("Share ~/.pi/agent/web-search.json with npm:pi-web-access?");
    expect(asked[0]).toContain("The agent's own commands can't");
    expect(patched(app)).toEqual([{ extensionFiles: [config.extensionFiles[0], { extension: "npm:pi-web-access", path: "~/.pi/agent/web-search.json", target: ".config/pi/web-search.json" }] }]);
    await app.press("text:Stop sharing");
    await app.waitUntil(() => patched(app).length === 2);
    expect(patched(app)[1]).toEqual({ extensionFiles: [] });

    const admin = await openSettings("hosts", routes("admin"));
    await admin.press("id:host-row-c1");
    await admin.waitFor("text:npm:pi-web-access@0.46.0");
    expect(admin.shows("id:host-extension-files")).toBe(false);
    expect(admin.shows("text:~/other.json")).toBe(false);
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

  test("Workspaces opens a workspace's page on its overview, with its other settings a tab away", async () => {
    const app = await openSettings("workspaces");
    await openWorkspace(app);
    expect(app.shows("id:workspace-title")).toBe(true);
    const tabs: Record<string, string[]> = {
      overview: ["workspace-members", "workspace-invite"],
      sources: ["workspace-sources", "workspace-connections", "workspace-push-access"],
      agents: ["workspace-extensions", "workspace-tool-groups", "workspace-network", "workspace-github-reach", "workspace-memory"],
      sessions: ["workspace-schedules", "workspace-cache-warming", "workspace-database"],
    };
    const everyPart = Object.values(tabs).flat();
    for (const [tab, parts] of Object.entries(tabs)) {
      await app.press(`id:workspace-tabs-${tab}`);
      await app.waitFor(`id:workspace-tab-${tab}`);
      for (const part of parts) await app.waitFor(`id:${part}`);
      for (const part of everyPart.filter(item => !parts.includes(item))) expect(app.shows(`id:${part}`)).toBe(false);
    }
    await app.press("id:workspace-tabs-sources");
    await app.waitFor("text:OpenCara/pikibun");
    await app.press("id:workspace-new-session");
    await app.waitFor("text:What should we work on?");
  });

  test("Workspaces goes back from a workspace's page to the list, and opens the next workspace on its overview", async () => {
    const app = await openSettings("workspaces");
    await openWorkspace(app, "agents");
    await app.press("id:workspaces-back");
    await openWorkspace(app);
    expect(app.shows("id:workspace-members")).toBe(true);
  });

  test("Workspaces adds a repository by any URL, switching to the account of its host, without listing the account's repositories", async () => {
    const url = "https://gitlab.com/group/project/-/tree/main";
    const lookup = `${ORIGIN}/api/git/accounts/g2/repositories?path=${encodeURIComponent(url)}`;
    const app = await openSettings("workspaces", {
      [`GET ${ORIGIN}/api/git/accounts`]: { body: { accounts: [
        { id: "github", provider: "github", host: "github.com", organization: "", login: "ada", createdAt: null },
        { id: "g2", provider: "gitlab", host: "gitlab.com", organization: "", login: "ada-gl", createdAt: "2026-01-01T00:00:00.000Z" },
      ] } },
      [`GET ${lookup}`]: { body: { repositories: [{ id: "42", fullName: "group/project", defaultBranch: "main", private: false }], truncated: false } },
      [`POST ${ORIGIN}/api/workspaces/w1/repositories`]: { status: 201, body: { repository: { id: "r2", workspaceId: "w1", provider: "gitlab", host: "gitlab.com",
        repositoryId: "42", fullName: "group/project", ref: "main", private: false, createdAt: "2026-01-01T00:00:00.000Z", forbidDefaultBranchPush: false, lfs: false, readAs: "members" } } },
    });
    await openWorkspace(app, "sources");
    await app.waitFor("id:add-repository");
    await app.press("id:add-repository");
    await app.waitFor("id:repository-url");
    await app.type("id:repository-url", url);
    await app.press("text:Look up");
    await app.waitFor("text:group/project");
    expect(app.texts().join(" ")).toContain("Public · default branch main");
    await app.press("text:Bind repository");
    await app.waitUntil(() => bodyOf(app, "POST", `${ORIGIN}/api/workspaces/w1/repositories`) !== undefined);
    expect(bodyOf(app, "POST", `${ORIGIN}/api/workspaces/w1/repositories`)).toEqual({ provider: "gitlab", host: "gitlab.com", repositoryId: "42", fullName: "group/project" });
    expect(app.requests().some(item => /\/api\/git\/accounts\/[^/]+\/repositories$/.test(item.url))).toBe(false);
  });

  test("Workspaces matches an SSH remote to the account of its server, whose HTTPS host has a port", async () => {
    const remote = "git@git.example.com:octo/tools.git";
    const lookup = `${ORIGIN}/api/git/accounts/ghe/repositories?path=${encodeURIComponent(remote)}`;
    const app = await openSettings("workspaces", {
      [`GET ${ORIGIN}/api/git/accounts`]: { body: { accounts: [
        { id: "github", provider: "github", host: "github.com", organization: "", login: "ada", createdAt: null },
        { id: "ghe", provider: "github-enterprise", host: "git.example.com:8443", organization: "", login: "ada", createdAt: "2026-01-01T00:00:00.000Z" },
      ] } },
      [`GET ${lookup}`]: { body: { repositories: [{ id: "7", fullName: "octo/tools", defaultBranch: "main", private: true }], truncated: false } },
    });
    await openWorkspace(app, "sources");
    await app.waitFor("id:add-repository");
    await app.press("id:add-repository");
    await app.waitFor("id:repository-url");
    await app.type("id:repository-url", remote);
    await app.press("text:Look up");
    await app.waitFor("text:octo/tools");
    expect(app.texts().join(" ")).not.toContain("No connected account reads");
  });

  test("Workspaces lets an admin choose when hosts keep the workspace's prompt caches warm", async () => {
    const app = await openSettings("workspaces", {
      [`PUT ${ORIGIN}/api/workspaces/w1/cache-warming`]: { body: { settings: { mode: "streaming" } } },
    });
    await openWorkspace(app, "sessions");
    await app.waitFor("id:cache-warming-mode");
    expect(app.texts().join(" ")).toContain("Working and waiting");
    await app.press("id:cache-warming-mode");
    await app.press("text:While working");
    await app.waitUntil(() => bodyOf(app, "PUT", `${ORIGIN}/api/workspaces/w1/cache-warming`) !== undefined);
    expect(bodyOf(app, "PUT", `${ORIGIN}/api/workspaces/w1/cache-warming`)).toEqual({ mode: "streaming" });
  });

  test("Workspaces lets each member turn off their own GitHub reach beyond the workspace's repositories, which starts on", async () => {
    const app = await openSettings("workspaces", {
      [`PUT ${ORIGIN}/api/workspaces/w1/github-reach`]: { body: { settings: { anyRepository: false } } },
    });
    await openWorkspace(app, "agents");
    await app.waitFor("id:github-reach-any");
    expect(app.texts().join(" ")).toContain("Your own messages in your sessions reach every repository your GitHub account can");
    await app.press("id:github-reach-any");
    await app.waitUntil(() => bodyOf(app, "PUT", `${ORIGIN}/api/workspaces/w1/github-reach`) !== undefined);
    expect(bodyOf(app, "PUT", `${ORIGIN}/api/workspaces/w1/github-reach`)).toEqual({ anyRepository: false });
  });

  test("Workspaces signs an app in to a remote MCP server with OAuth through the system browser, finished by the link it opens or a pasted code", async () => {
    const mcp = { id: "m1", name: "Gen", prefix: "gen", url: "https://mcp.example.com/mcp", enabled: true, headerNames: [], readOnlyTools: [], tools: [],
      error: "The server needs a sign-in (HTTP 401)", updatedAt: "2026-01-01T00:00:00.000Z" };
    const begin = `${ORIGIN}/api/mcp-servers/oauth/app/begin?token=${"b".repeat(43)}`;
    const code = "c".repeat(43);
    const app = await openSettings("workspaces", {
      [`GET ${ORIGIN}/api/workspaces/w1/mcp-servers`]: { body: { servers: [mcp], admin: true } },
      [`POST ${ORIGIN}/api/workspaces/w1/mcp-servers/m1/oauth/app`]: { status: 201, body: { url: begin, expiresAt: "2099-01-01T00:00:00.000Z" } },
      [`POST ${ORIGIN}/api/mcp-servers/oauth/app/finish`]: { body: { workspaceId: "w1", server: { ...mcp, error: undefined, oauth: { signedInAt: "2026-01-01T00:00:00.000Z" } } } },
    });
    await openWorkspace(app, "agents");
    await app.waitFor("text:Gen · gen_");
    await app.press("text:Gen · gen_");
    await app.press("id:mcp-sign-in-gen");
    await app.waitFor("id:mcp-app-sign-in");
    expect(app.openedUrls()).toContain(begin);
    expect(app.texts().join(" ")).not.toContain("from Pikibun on the web");
    const finishes = () => app.requests().filter(item => item.method === "POST" && item.url === `${ORIGIN}/api/mcp-servers/oauth/app/finish`);

    await app.type("id:mcp-app-code", "not a code");
    await app.press("id:mcp-app-finish");
    await app.waitUntil(() => app.texts().join(" ").includes("isn't a sign-in code"));
    await app.openWithUrl(`pikibun://mcp/sign-in?server=${encodeURIComponent("https://other.example.com")}&code=${code}`);
    await app.waitUntil(() => app.texts().join(" ").includes("for another Pikibun server"));
    expect(finishes().length).toBe(0);

    await app.openWithUrl(`pikibun://mcp/sign-in?server=${encodeURIComponent(ORIGIN)}&code=${code}`);
    await app.waitUntil(() => finishes().length === 1);
    expect(JSON.parse(finishes()[0]!.body!)).toEqual({ code });
    await app.waitUntil(() => !app.shows("id:mcp-app-sign-in"));
    expect(app.texts().join(" ")).toContain("Signed in.");

    await app.openWithUrl(`pikibun://mcp/sign-in?server=${encodeURIComponent(ORIGIN)}&code=${code}`);
    await app.wait(200);
    expect(finishes().length).toBe(1);
    await app.press("id:mcp-sign-in-gen");
    await app.waitFor("id:mcp-app-sign-in");
    await app.type("id:mcp-app-code", ` ${code} `);
    await app.press("id:mcp-app-finish");
    await app.waitUntil(() => finishes().length === 2);
    await app.waitUntil(() => !app.shows("id:mcp-app-sign-in"));
  });

  test("Workspaces says a remote MCP server signed in with OAuth whose tools couldn't be listed is signed in, and counts the tools it left out (#530)", async () => {
    const base = { url: "https://mcp.example.com/mcp", enabled: true, headerNames: [], readOnlyTools: [], updatedAt: "2026-01-01T00:00:00.000Z" };
    const failed = { ...base, id: "m1", name: "Gen", prefix: "gen", tools: [], oauth: { signedInAt: "2026-01-01T00:00:00.000Z" },
      error: "The answer was larger than 8388608 bytes" };
    const partial = { ...base, id: "m2", name: "Many", prefix: "many", toolsLeftOut: { overLimit: 6, unusable: 2 },
      tools: [{ name: "run", toolName: "many_run", description: "Run.", inputSchema: { type: "object" }, readOnly: false }] };
    const app = await openSettings("workspaces", {
      [`GET ${ORIGIN}/api/workspaces/w1/mcp-servers`]: { body: { servers: [failed, partial], admin: true } },
    });
    await openWorkspace(app, "agents");
    await app.waitFor("text:Gen · gen_");
    await app.press("text:Gen · gen_");
    await app.waitUntil(() => app.texts().join(" ").includes("Signed in, but its tools couldn't be listed"));
    expect(app.texts().join(" ")).not.toContain("It couldn't be signed in to");
    await app.press("text:Many · many_");
    await app.waitUntil(() => app.texts().join(" ").includes("Some of its tools are left out"));
    expect(app.texts().join(" ")).toContain("Left out 6 tools past the 64 Pikibun offers from one server and 2 tools whose names or input schemas Pikibun can't offer.");
  });

  test("Workspaces lets an admin choose whose sign-in a remote MCP server calls with, and a member use their own connection there", async () => {
    const at = "2026-01-01T00:00:00.000Z";
    const tracker = { id: "m1", name: "Tracker", prefix: "tracker", url: "https://mcp.example.com/mcp", enabled: true, signInAs: "members", headerNames: [], readOnlyTools: [],
      tools: [{ name: "search", toolName: "tracker_search", description: "Search.", inputSchema: { type: "object" }, readOnly: true }], updatedAt: at,
      connection: { id: "mc1", name: "My tracker", using: false, signedIn: true } };
    let using = false;
    const app = await openSettings("workspaces", {
      [`GET ${ORIGIN}/api/workspaces/w1/mcp-servers`]: () => ({ body: { servers: [{ ...tracker, connection: { ...tracker.connection, using } }], admin: true } }),
      [`PUT ${ORIGIN}/api/mcp-connections/mc1/workspaces/w1`]: () => { using = true; return { body: { connection: {} } }; },
      [`PATCH ${ORIGIN}/api/workspaces/w1/mcp-servers/m1`]: { body: { server: tracker } },
    });
    await openWorkspace(app, "agents");
    await app.waitFor("text:Tracker · tracker_");
    expect(app.texts().join(" ")).toContain("each member's own");
    await app.press("text:Tracker · tracker_");
    await app.waitFor("id:mcp-use-connection-tracker");
    expect(app.texts().join(" ")).toContain("You have a connection to it, My tracker, which this workspace doesn't use yet.");
    await app.press("id:mcp-use-connection-tracker");
    await app.waitUntil(() => app.texts().join(" ").includes("Your requests use your own connection, My tracker."));
    expect(app.requests().some(item => item.method === "PUT" && item.url === `${ORIGIN}/api/mcp-connections/mc1/workspaces/w1`)).toBe(true);
  });

  test("Workspaces shows the workspace's memory and the notes agents proposed, and an admin adds one to the memory as they save it", async () => {
    const app = await openSettings("workspaces", {
      [`PUT ${ORIGIN}/api/workspaces/w1/memory`]: { body: { memory: { instructions: "Use pnpm.", memory: "- The login test races the cookie.\n- Retry the login test once before failing it.\n",
        revision: 3, updatedBy: "u1", updatedAt: "2026-11-06T09:00:00.000Z" }, notes: [], pendingNotes: 0, enabled: true, admin: true } },
    });
    await openWorkspace(app, "agents");
    await app.waitFor("id:workspace-memory-text");
    expect(app.value("id:workspace-memory-instructions")).toBe("Use pnpm.");
    expect(app.value("id:workspace-memory-text")).toBe("- The login test races the cookie.");
    expect(app.texts().join(" ")).toContain("Retry the login test once before failing it.");
    expect(app.shows("id:workspace-memory-save")).toBe(false);
    await app.press("text:Add to memory");
    await app.waitFor("id:workspace-memory-save");
    expect(app.value("id:workspace-memory-text")).toBe("- The login test races the cookie.\n- Retry the login test once before failing it.\n");
    expect(app.texts().join(" ")).toContain("Save, adding 1 note");
    await app.press("id:workspace-memory-save");
    await app.waitUntil(() => bodyOf(app, "PUT", `${ORIGIN}/api/workspaces/w1/memory`) !== undefined);
    expect(bodyOf(app, "PUT", `${ORIGIN}/api/workspaces/w1/memory`)).toEqual({ revision: 2,
      memory: "- The login test races the cookie.\n- Retry the login test once before failing it.\n", accept: ["n1"] });
  });

  test("Workspaces shows each role's tools and creates a tool group with the tools an admin picks", async () => {
    const app = await openSettings("workspaces");
    await openWorkspace(app, "agents");
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

  test("Hosts lets the owner share build caches by role once confirmed, with a size limit in GiB", async () => {
    const app = await openSettings("hosts", {
      [`GET ${ORIGIN}/api/connectors`]: { body: { connectors: [{ ...host, role: "owner", connectedWorkspaceIds: ["w1"], version: "0.40.0",
        capabilities: { ...host.capabilities, hostConfig: true, buildCaches: true } }] } },
      [`PATCH ${ORIGIN}/api/connectors/c1/config`]: { body: { ok: true } },
    });
    await app.press("id:host-row-c1");
    await app.waitFor("id:host-build-caches");
    expect(app.shows("id:host-build-cache-gib")).toBe(false);
    await app.press("text:By role");
    await app.waitFor("id:host-build-cache-gib");
    await app.clear("id:host-build-cache-gib");
    await app.type("id:host-build-cache-gib", "0");
    await app.waitFor("text:The build caches' size limit is a whole number of GiB from 1 to 10000.");
    await app.clear("id:host-build-cache-gib");
    await app.type("id:host-build-cache-gib", "50");
    await app.waitUntil(() => !app.shows("text:The build caches' size limit is a whole number of GiB from 1 to 10000."));
    const asked: string[] = [];
    app.onDialog(dialog => { asked.push(dialog.title ?? ""); return "Cancel"; });
    await app.press("id:host-config-save");
    await app.waitUntil(() => asked.length === 1);
    expect(asked).toEqual(["Share build caches between people on this host?"]);
    expect(bodyOf(app, "PATCH", `${ORIGIN}/api/connectors/c1/config`)).toBeUndefined();
    app.onDialog(dialog => (dialog.title === "Share build caches between people on this host?" ? "Share caches" : null));
    await app.press("id:host-config-save");
    await app.waitUntil(() => bodyOf(app, "PATCH", `${ORIGIN}/api/connectors/c1/config`) !== undefined);
    expect(bodyOf(app, "PATCH", `${ORIGIN}/api/connectors/c1/config`)).toEqual({ buildCaches: "workspace", buildCacheGiB: 50 });
  });

  test("Hosts start with an hour's command time limit, and their owner lifts it with No limit or sets a time again", async () => {
    const app = await openSettings("hosts", {
      [`GET ${ORIGIN}/api/connectors`]: { body: { connectors: [{ ...host, role: "owner", connectedWorkspaceIds: ["w1"], version: "0.40.0",
        capabilities: { ...host.capabilities, hostConfig: true } }] } },
      [`PATCH ${ORIGIN}/api/connectors/c1/config`]: { body: { ok: true } },
    });
    await app.press("id:host-row-c1");
    await app.waitFor("id:host-command-time-limit");
    expect(app.texts()).toContain("1 hour");
    await app.press("id:host-command-time-limit");
    await app.press("text:No limit");
    await app.press("id:host-config-save");
    await app.waitUntil(() => bodyOf(app, "PATCH", `${ORIGIN}/api/connectors/c1/config`) !== undefined);
    expect(bodyOf(app, "PATCH", `${ORIGIN}/api/connectors/c1/config`)).toEqual({ commandTimeoutUnlimited: true });
  });

  test("Hosts let their owner turn prompt cache warming off, and show admins the owner's choice read-only", async () => {
    const app = await openSettings("hosts", {
      [`GET ${ORIGIN}/api/connectors`]: { body: { connectors: [{ ...host, role: "owner", connectedWorkspaceIds: ["w1"], version: "0.40.0",
        capabilities: { ...host.capabilities, hostConfig: true } }] } },
      [`PATCH ${ORIGIN}/api/connectors/c1/config`]: { body: { ok: true } },
    });
    await app.press("id:host-row-c1");
    await app.waitFor("id:host-cache-warming-allow");
    await app.press("id:host-cache-warming-allow");
    await app.press("id:host-config-save");
    await app.waitUntil(() => bodyOf(app, "PATCH", `${ORIGIN}/api/connectors/c1/config`) !== undefined);
    expect(bodyOf(app, "PATCH", `${ORIGIN}/api/connectors/c1/config`)).toEqual({ cacheWarming: false });
    app.dispose();

    const admin = await openSettings("hosts", {
      [`GET ${ORIGIN}/api/connectors`]: { body: { connectors: [{ ...host, ownerId: "u9", ownerName: "grace", role: "admin", connectedWorkspaceIds: ["w1"], version: "0.40.0",
        config: { ...defaultHostConfig, cacheWarming: false }, capabilities: { ...host.capabilities, hostConfig: true } }] } },
    });
    await admin.press("id:host-row-c1");
    await admin.waitFor("id:host-cache-warming");
    expect(admin.shows("id:host-cache-warming-allow")).toBe(false);
    expect(admin.texts().join(" ")).toContain("Only the host's owner changes this");
  });

  test("a new workspace starts as the preset chosen for it, and an existing one takes a preset once confirmed", async () => {
    const app = await openSettings("workspaces", {
      [`POST ${ORIGIN}/api/workspaces/w1/preset`]: { body: { preset: "locked" } },
    });
    await app.waitFor("id:new-workspace");
    await app.press("id:new-workspace");
    await app.type("id:new-workspace-name", "Vault");
    expect(app.texts().join(" ")).toContain("Ready to work: any public host");
    await app.press("id:new-workspace-preset");
    await app.press("text:Locked down");
    await app.waitUntil(() => app.texts().join(" ").includes("No network beyond the workspace's repositories"));
    await app.press("id:new-workspace-create");
    await app.waitUntil(() => bodyOf(app, "POST", `${ORIGIN}/api/workspaces`) !== undefined);
    expect(bodyOf(app, "POST", `${ORIGIN}/api/workspaces`)).toEqual({ name: "Vault", preset: "locked" });
    app.dispose();

    const existing = await openSettings("workspaces", { [`POST ${ORIGIN}/api/workspaces/w1/preset`]: { body: { preset: "locked" } } });
    await openWorkspace(existing);
    await existing.waitFor("id:workspace-presets");
    const asked: string[] = [];
    existing.onDialog(dialog => { asked.push(dialog.title ?? ""); return "Cancel"; });
    await existing.press("id:workspace-preset-locked");
    await existing.waitUntil(() => asked.length === 1);
    expect(asked).toEqual(["Apply Locked down to Analytical Engine?"]);
    expect(bodyOf(existing, "POST", `${ORIGIN}/api/workspaces/w1/preset`)).toBeUndefined();
    existing.onDialog(() => "Apply preset");
    await existing.press("id:workspace-preset-locked");
    await existing.waitUntil(() => bodyOf(existing, "POST", `${ORIGIN}/api/workspaces/w1/preset`) !== undefined);
    expect(bodyOf(existing, "POST", `${ORIGIN}/api/workspaces/w1/preset`)).toEqual({ preset: "locked" });
    await existing.waitFor("text:Locked down applied. See Agents for the network access, GitHub reach and extensions it set.");
  });

  test("Extensions shows each one in a line, opens to its whole description, and filters by name, source or tool", async () => {
    const on = (source: string) => ({ source, enabled: true, tools: "automatic", settings: {} });
    const app = await openSettings("workspaces", {
      [`GET ${ORIGIN}/api/workspaces/w1/extensions`]: { body: { admin: true, hosts: [],
        extensions: ["piki:git", "piki:node", "piki:python", "piki:schedule", "piki:sessions", "piki:workspace", "piki:gh", "npm:cc-safety-net@2.7.2"].map(on) } },
      [`DELETE ${ORIGIN}/api/workspaces/w1/extensions?source=piki%3Anode`]: { body: { extensions: [] } },
    });
    await openWorkspace(app, "agents");
    await app.waitFor("id:extensions-filter");
    await app.waitFor("id:session-tools-node");
    expect(app.texts().join(" ")).not.toContain("each call checked as a command is");
    await app.type("id:extensions-filter", "git_push");
    await app.waitUntil(() => !app.shows("id:session-tools-node"));
    expect(app.shows("id:session-tools-git")).toBe(true);
    await app.clear("id:extensions-filter");
    await app.type("id:extensions-filter", "safety");
    await app.waitUntil(() => !app.shows("id:session-tools-git"));
    expect(app.texts()).toContain("npm:cc-safety-net@2.7.2");
    await app.clear("id:extensions-filter");
    await app.type("id:extensions-filter", "no such thing");
    await app.waitFor("id:extensions-filter-empty");
    await app.clear("id:extensions-filter");
    await app.type("id:extensions-filter", "node");
    await app.waitFor("id:session-tools-node");
    await app.press("text:Node.js · piki:node");
    await app.waitUntil(() => app.texts().join(" ").includes("each call checked as a command is"));
    await app.press("id:session-tools-remove-node");
    await app.waitUntil(() => app.requests().some(item => item.method === "DELETE" && item.url.endsWith("source=piki%3Anode")));
  });

  test("Hosts says a connector predates build caches, and shows admins the owner's choice read-only", async () => {
    const config = { commandTimeoutSeconds: 30, gpu: false, gitCredentials: false, repositoryCache: "off", hostSessions: false, compaction: {}, builtinExtensions: [], requiredExtensions: [],
      browser: { source: "auto" }, serviceLifetimeSeconds: 3600, tunnel: { source: "auto" }, fakeIpTunnels: false, buildCaches: "owner", buildCacheGiB: 64, commandTimeoutUnlimited: false, modelExtensions: [], cacheWarming: true, extensionFiles: [] };
    const older = await openSettings("hosts", {
      [`GET ${ORIGIN}/api/connectors`]: { body: { connectors: [{ ...host, role: "owner", connectedWorkspaceIds: ["w1"], version: "0.40.0", capabilities: { ...host.capabilities, hostConfig: true } }] } },
    });
    await older.press("id:host-row-c1");
    await older.waitFor("id:host-build-caches");
    expect(older.texts().join(" ")).toContain("Only sandboxed Linux and macOS hosts offer it");
    expect(older.shows("text:By role")).toBe(false);

    const admin = await openSettings("hosts", {
      [`GET ${ORIGIN}/api/connectors`]: { body: { connectors: [{ ...host, ownerId: "u9", ownerName: "grace", role: "admin", connectedWorkspaceIds: ["w1"], version: "0.40.0", config,
        capabilities: { ...host.capabilities, hostConfig: true, buildCaches: true } }] } },
    });
    await admin.press("id:host-row-c1");
    await admin.waitFor("id:host-build-caches");
    expect(admin.shows("text:By role")).toBe(false);
    expect(admin.shows("id:host-build-cache-gib")).toBe(false);
    expect(admin.texts().join(" ")).toContain("64 GiB");
  });

  test("Workspaces lists build caches, names a deleted writer group, and adds and edits caches with the variable checked", async () => {
    const stamp = "2026-11-20T10:00:00.000Z";
    const ccache = { name: "ccache", env: "CCACHE_DIR", writerGroups: ["gone"], createdAt: stamp, updatedAt: stamp };
    const list = { caches: [ccache], admin: true, limits: { caches: 16, writerGroups: 16 } };
    const app = await openSettings("workspaces", {
      [`GET ${ORIGIN}/api/workspaces/w1/build-caches`]: { body: list },
      [`GET ${ORIGIN}/api/workspaces/w1/tool-groups`]: { body: { ...toolGroups, groups: [{ id: "g1", name: "Builders", tools: ["read", "write"], createdAt: stamp, updatedAt: stamp }] } },
      [`PUT ${ORIGIN}/api/workspaces/w1/build-caches/gradle`]: { status: 201, body: list },
      [`PUT ${ORIGIN}/api/workspaces/w1/build-caches/ccache`]: { body: list },
      [`DELETE ${ORIGIN}/api/workspaces/w1/build-caches/ccache`]: { body: { ...list, caches: [] } },
    });
    await openWorkspace(app, "sessions");
    await app.waitFor("id:build-cache-ccache");
    await app.waitUntil(() => app.texts().join(" ").includes("CCACHE_DIR · Shared by the workspace's owner and: deleted group"));

    await app.press("id:new-build-cache");
    await app.waitFor("id:build-cache-editor");
    await app.type("id:build-cache-name", "ccache");
    await app.waitFor("text:This workspace already has a build cache named ccache");
    await app.clear("id:build-cache-name");
    await app.type("id:build-cache-name", "gradle");
    await app.type("id:build-cache-env", "PATH");
    await app.waitFor("text:PATH is a variable the sandbox or the tools set themselves; name another");
    await app.press("id:build-cache-save");
    expect(bodyOf(app, "PUT", `${ORIGIN}/api/workspaces/w1/build-caches/gradle`)).toBeUndefined();
    await app.clear("id:build-cache-env");
    await app.type("id:build-cache-env", "CCACHE_DIR");
    await app.waitFor("text:The build cache ccache already uses CCACHE_DIR");
    await app.clear("id:build-cache-env");
    await app.type("id:build-cache-env", "GRADLE_BUILD_CACHE");
    await app.press("id:build-cache-group-g1");
    await app.press("id:build-cache-save");
    await app.waitUntil(() => bodyOf(app, "PUT", `${ORIGIN}/api/workspaces/w1/build-caches/gradle`) !== undefined);
    expect(bodyOf(app, "PUT", `${ORIGIN}/api/workspaces/w1/build-caches/gradle`)).toEqual({ env: "GRADLE_BUILD_CACHE", writerGroups: ["g1"] });
    await app.waitUntil(() => !app.shows("id:build-cache-editor"));

    await app.press("id:build-cache-actions-ccache");
    await app.press("text:Edit");
    await app.waitFor("id:build-cache-editor");
    expect(app.shows("id:build-cache-name")).toBe(false);
    await app.waitFor("id:build-cache-group-gone");
    await app.press("id:build-cache-group-gone");
    await app.waitFor("text:With no writer groups left, every admin and collaborator who can write files shares this cache's copy.");
    expect(app.shows("id:build-cache-group-gone")).toBe(true);
    await app.press("id:build-cache-group-gone");
    await app.waitUntil(() => !app.texts().join(" ").includes("With no writer groups left"));
    await app.press("id:build-cache-group-gone");
    await app.waitFor("text:With no writer groups left, every admin and collaborator who can write files shares this cache's copy.");
    await app.press("id:build-cache-save");
    await app.waitUntil(() => bodyOf(app, "PUT", `${ORIGIN}/api/workspaces/w1/build-caches/ccache`) !== undefined);
    expect(bodyOf(app, "PUT", `${ORIGIN}/api/workspaces/w1/build-caches/ccache`)).toEqual({ env: "CCACHE_DIR", writerGroups: [] });
    await app.waitUntil(() => !app.shows("id:build-cache-editor"));

    app.onDialog(dialog => (dialog.title === "Delete ccache?" ? "Delete cache" : null));
    await app.press("id:build-cache-actions-ccache");
    await app.press("text:Delete");
    await app.waitUntil(() => app.requests().some(item => item.method === "DELETE" && item.url === `${ORIGIN}/api/workspaces/w1/build-caches/ccache`));
    await app.waitFor("text:ccache deleted.");
  });

  test("Workspaces lets the owner delete a workspace, sessions and all, and restore it from Deleted workspaces", async () => {
    let deletes = 0;
    let deleted = false;
    const team = { id: "w2", name: "Difference Engine", ownerId: "u1", role: "owner" };
    const gone = { id: "w2", name: "Difference Engine", deletedAt: "2026-11-24T05:00:00.000Z", deletedBy: "u1", members: 3, sessions: 4 };
    const app = await openSettings("workspaces", {
      [`GET ${ORIGIN}/api/workspaces`]: () => ({ body: { workspaces: deleted ? [workspace] : [workspace, team] } }),
      [`GET ${ORIGIN}/api/deleted-workspaces`]: () => ({ body: { workspaces: deleted ? [gone] : [] } }),
      [`DELETE ${ORIGIN}/api/workspaces/w2`]: () => {
        if (++deletes === 1) return { status: 409, body: { code: "workspace_changed", error: "The workspace changed. Refresh and try again." } };
        deleted = true;
        return { body: { workspace: gone } };
      },
      [`POST ${ORIGIN}/api/deleted-workspaces/w2/restore`]: () => { deleted = false; return { body: { workspace: team } }; },
    });
    await app.waitFor("id:workspace-w2");
    expect(app.shows("id:deleted-workspaces")).toBe(false);
    await app.press("id:workspace-w2");
    await app.waitFor("id:workspace-delete");

    app.onDialog(dialog => (dialog.title === "Delete Difference Engine?" ? "Cancel" : null));
    await app.press("id:workspace-delete");
    expect(app.requests().some(item => item.method === "DELETE" && item.url === `${ORIGIN}/api/workspaces/w2`)).toBe(false);

    app.onDialog(dialog => (dialog.title === "Delete Difference Engine?" ? "Delete workspace" : null));
    await app.press("id:workspace-delete");
    await app.waitFor("text:The workspace changed. Refresh and try again.");
    expect(app.shows("id:workspace-delete")).toBe(true);

    await app.press("id:workspace-delete");
    await app.waitUntil(() => deletes === 2);
    await app.waitFor("id:deleted-workspace-w2");
    await app.waitUntil(() => !app.shows("id:workspace-w2") && app.shows("id:workspace-w1"));
    expect(app.texts().join(" ")).toContain("3 members · 4 sessions");
    expect(app.shows("id:deleted-workspace-purge-w2")).toBe(false);

    await app.press("id:deleted-workspace-restore-w2");
    await app.waitFor("text:Difference Engine restored, with its members and sessions.");
    await app.waitUntil(() => app.shows("id:workspace-w2") && !app.shows("id:deleted-workspace-w2"));
  });

  test("Deleted workspaces deletes one without sessions for good, once confirmed", async () => {
    let purged = false;
    const empty = { id: "w4", name: "Scratch", deletedAt: "2026-11-24T05:00:00.000Z", deletedBy: "u1", members: 1, sessions: 0 };
    const app = await openSettings("workspaces", {
      [`GET ${ORIGIN}/api/deleted-workspaces`]: () => ({ body: { workspaces: purged ? [] : [empty] } }),
      [`DELETE ${ORIGIN}/api/deleted-workspaces/w4`]: () => { purged = true; return { status: 204 }; },
    });
    await app.waitFor("id:deleted-workspace-purge-w4");
    app.onDialog(dialog => (dialog.title === "Delete Scratch for good?" ? "Cancel" : null));
    await app.press("id:deleted-workspace-purge-w4");
    expect(purged).toBe(false);
    app.onDialog(dialog => (dialog.title === "Delete Scratch for good?" ? "Delete for good" : null));
    await app.press("id:deleted-workspace-purge-w4");
    await app.waitFor("text:Scratch deleted for good.");
    await app.waitUntil(() => !app.shows("id:deleted-workspace-w4"));
  });

  test("Workspaces offers no delete to admins, nor on a private workspace", async () => {
    const app = await openSettings("workspaces", {
      [`GET ${ORIGIN}/api/workspaces`]: { body: { workspaces: [{ ...workspace, personal: true }, { id: "w3", name: "Shared", ownerId: "u9", role: "admin" }] } },
    });
    for (const id of ["w1", "w3"]) {
      await app.waitFor(`id:workspace-${id}`);
      await app.press(`id:workspace-${id}`);
      await app.waitFor("id:workspace-rename");
      expect(app.shows("id:workspace-delete")).toBe(false);
      await app.press("id:workspaces-back");
    }
  });

  test("Workspaces shows members the build caches without letting them change any", async () => {
    const stamp = "2026-11-20T10:00:00.000Z";
    const app = await openSettings("workspaces", {
      [`GET ${ORIGIN}/api/workspaces/w1/build-caches`]: { body: { caches: [{ name: "turbo", env: "TURBO_CACHE_DIR", writerGroups: [], createdAt: stamp, updatedAt: stamp }],
        admin: false, limits: { caches: 16, writerGroups: 16 } } },
    });
    await openWorkspace(app, "sessions");
    await app.waitFor("id:build-cache-turbo");
    expect(app.texts().join(" ")).toContain("TURBO_CACHE_DIR · Shared by owners, admins and collaborators who can write files");
    expect(app.shows("id:new-build-cache")).toBe(false);
    expect(app.shows("id:build-cache-actions-turbo")).toBe(false);
  });

  test("Extensions adds auto mode as one of Pikibun's features, which needs no host", async () => {
    const autoMode = { source: "piki:auto-mode", enabled: true, tools: "automatic", settings: {} };
    const app = await openSettings("workspaces", {
      [`PUT ${ORIGIN}/api/workspaces/w1/extensions`]: { body: { extensions: [autoMode] } },
    });
    await openWorkspace(app, "agents");
    await app.waitFor("id:workspace-extensions");
    await app.press("text:Add extension");
    await app.waitFor("text:Pikibun features");
    await app.press("text:Auto mode");
    await app.waitUntil(() => app.texts().some(item => item.startsWith("Adds Auto to the host and model dropdowns") && item.endsWith("Set its settings with Edit once added.")));
    await app.press("text:Save");
    await app.waitUntil(() => bodyOf(app, "PUT", `${ORIGIN}/api/workspaces/w1/extensions`) !== undefined);
    expect(bodyOf(app, "PUT", `${ORIGIN}/api/workspaces/w1/extensions`)).toMatchObject({ source: "piki:auto-mode", enabled: true });
  });

  test("Extensions lists auto mode without hosts to install it on", async () => {
    const app = await openSettings("workspaces", {
      [`GET ${ORIGIN}/api/workspaces/w1/extensions`]: { body: { admin: true, extensions: [{ source: "piki:auto-mode", enabled: true, tools: "automatic", settings: {} }],
        hosts: [{ id: "c1", name: "ada-mac", ownerId: "u1", ownerName: "ada" }] } },
    });
    await openWorkspace(app, "agents");
    await app.waitFor("text:Auto mode · piki:auto-mode");
    expect(app.texts().join(" ")).toContain("Runs in Pikibun itself: hosts install nothing");
    expect(app.texts().join(" ")).not.toContain("0 of 1 host");
  });

  test("Extensions limits the models auto mode may choose with its models setting", async () => {
    const autoMode = { source: "piki:auto-mode", enabled: true, tools: "automatic", settings: {} };
    const app = await openSettings("workspaces", {
      [`GET ${ORIGIN}/api/workspaces/w1/extensions`]: { body: { admin: true, extensions: [autoMode], hosts: [] } },
      [`PUT ${ORIGIN}/api/workspaces/w1/extensions`]: { body: { extensions: [{ ...autoMode, settings: { models: "anthropic/claude-sonnet-*" } }] } },
    });
    await openWorkspace(app, "agents");
    await app.waitFor("text:Auto mode · piki:auto-mode");
    await app.press("text:Auto mode · piki:auto-mode");
    await app.waitFor("id:auto-mode-models");
    expect(app.texts().join(" ")).toContain("Auto chooses among every model the session's host offers");
    await app.press("text:Edit");
    await app.waitFor("id:extension-setting-models");
    await app.type("id:extension-setting-models", "anthropic/claude-sonnet-*");
    await app.press("text:Save");
    await app.waitUntil(() => bodyOf(app, "PUT", `${ORIGIN}/api/workspaces/w1/extensions`) !== undefined);
    expect(bodyOf(app, "PUT", `${ORIGIN}/api/workspaces/w1/extensions`)).toMatchObject({ source: "piki:auto-mode", settings: { models: "anthropic/claude-sonnet-*" } });
  });

  const autoModels = {
    [`GET ${ORIGIN}/api/workspaces/w1/auto-mode`]: { body: { enabled: true } },
    [`GET ${ORIGIN}/api/workspaces/w1/models`]: { body: { models: [
      { id: "m1", workspaceId: "w1", name: "Claude Sonnet", connectorId: "c1", provider: "anthropic", modelId: "claude-sonnet" },
      { id: "m2", workspaceId: "w1", name: "Claude Opus", connectorId: "c1", provider: "anthropic", modelId: "claude-opus" },
      { id: "m3", workspaceId: "w1", name: "Claude Opus", connectorId: "c2", provider: "anthropic", modelId: "claude-opus" },
      { id: "m4", workspaceId: "w1", name: "GPT-5", connectorId: "c1", provider: "openai", modelId: "gpt-5" },
    ] } },
  };

  test("Your Auto models stays hidden while auto mode is off", async () => {
    const app = await openSettings("workspaces");
    await openWorkspace(app, "agents");
    await app.waitFor("id:workspace-extensions");
    expect(app.shows("id:workspace-auto-models")).toBe(false);
    expect(app.requests().some(item => item.url.endsWith("/auto-mode/models"))).toBe(false);
  });

  test("Your Auto models lets a member keep only some of the models the workspace lets Auto choose", async () => {
    const app = await openSettings("workspaces", {
      ...autoModels,
      [`GET ${ORIGIN}/api/workspaces/w1/auto-mode/models`]: { body: { settings: { selected: null, workspace: ["anthropic/*"] } } },
      [`PUT ${ORIGIN}/api/workspaces/w1/auto-mode/models`]: { body: { settings: { selected: ["anthropic/claude-opus", "anthropic/claude-sonnet"], workspace: ["anthropic/*"] } } },
    });
    await openWorkspace(app, "agents");
    await app.waitFor("id:workspace-auto-models");
    await app.waitFor("id:auto-model-anthropic/claude-opus");
    expect(app.shows("id:auto-model-openai/gpt-5")).toBe(false);
    expect(app.texts().join(" ")).toContain("Auto chooses among every model the workspace allows it (anthropic/*)");
    await app.press("id:auto-models-every-toggle");
    await app.waitUntil(() => bodyOf(app, "PUT", `${ORIGIN}/api/workspaces/w1/auto-mode/models`) !== undefined);
    expect(bodyOf(app, "PUT", `${ORIGIN}/api/workspaces/w1/auto-mode/models`)).toEqual({ models: ["anthropic/claude-opus", "anthropic/claude-sonnet"] });
  });

  test("Your Auto models unchecks a model and keeps the ones no host offers now", async () => {
    const app = await openSettings("workspaces", {
      ...autoModels,
      [`GET ${ORIGIN}/api/workspaces/w1/auto-mode/models`]: { body: { settings: { selected: ["anthropic/claude-opus", "anthropic/claude-sonnet", "google/gemini"], workspace: null } } },
      [`PUT ${ORIGIN}/api/workspaces/w1/auto-mode/models`]: { body: { settings: { selected: ["anthropic/claude-sonnet", "google/gemini"], workspace: null } } },
    });
    await openWorkspace(app, "agents");
    await app.waitFor("id:auto-model-anthropic/claude-opus");
    expect(app.texts().join(" ")).toContain("Auto chooses only among the 3 models you keep below");
    await app.waitFor("id:auto-models-missing");
    expect(app.texts().join(" ")).toContain("no host here offers it to you now: google/gemini.");
    await app.press("id:auto-model-toggle-anthropic/claude-opus");
    await app.waitUntil(() => bodyOf(app, "PUT", `${ORIGIN}/api/workspaces/w1/auto-mode/models`) !== undefined);
    expect(bodyOf(app, "PUT", `${ORIGIN}/api/workspaces/w1/auto-mode/models`)).toEqual({ models: ["anthropic/claude-sonnet", "google/gemini"] });
  });

  test("Extensions shows a models setting with nothing readable in it as allowing no model, as Auto treats it", async () => {
    const app = await openSettings("workspaces", {
      [`GET ${ORIGIN}/api/workspaces/w1/extensions`]: { body: { admin: true, hosts: [],
        extensions: [{ source: "piki:auto-mode", enabled: true, tools: "automatic", settings: { models: "x".repeat(201) } }] } },
    });
    await openWorkspace(app, "agents");
    await app.waitFor("text:Auto mode · piki:auto-mode");
    await app.press("text:Auto mode · piki:auto-mode");
    await app.waitFor("id:auto-mode-models");
    expect(app.texts().join(" ")).toContain("Auto chooses only among: none it can read.");
  });

  test("Extensions warns that Sub-agents does nothing while Other sessions is off, and adds it from there", async () => {
    const app = await openSettings("workspaces", {
      [`GET ${ORIGIN}/api/workspaces/w1/extensions`]: { body: { admin: true, hosts: [], extensions: [
        { source: "piki:sub-agents", enabled: true, tools: "automatic", settings: {} }, { source: "piki:sessions", enabled: false, tools: "automatic", settings: {} }] } },
      [`PUT ${ORIGIN}/api/workspaces/w1/extensions`]: { body: { extensions: [] } },
    });
    await openWorkspace(app, "agents");
    await app.waitFor("text:Sub-agents · piki:sub-agents");
    expect(app.texts().join(" ")).toContain("Does nothing without Other sessions, which is off here");
    await app.press("text:Sub-agents · piki:sub-agents");
    await app.waitFor("id:needs-sessions");
    await app.press("text:Add Other sessions");
    await app.waitUntil(() => bodyOf(app, "PUT", `${ORIGIN}/api/workspaces/w1/extensions`) !== undefined);
    expect(bodyOf(app, "PUT", `${ORIGIN}/api/workspaces/w1/extensions`)).toEqual({ source: "piki:sessions", enabled: true, tools: "automatic", settings: {} });
  });

  test("Extensions manages every extension in one panel and saves the changes together", async () => {
    const app = await openSettings("workspaces", {
      [`GET ${ORIGIN}/api/workspaces/w1/extensions`]: { body: { admin: true, hosts: [], extensions: [
        { source: "npm:cc-safety-net@2.7.2", enabled: true, tools: "automatic", settings: { mode: "strict" } },
        { source: "piki:node", enabled: true, tools: "automatic", settings: {} }] } },
      [`PUT ${ORIGIN}/api/workspaces/w1/extensions`]: { body: { extensions: [] } },
      [`DELETE ${ORIGIN}/api/workspaces/w1/extensions?source=piki%3Anode`]: { body: { extensions: [] } },
    });
    await openWorkspace(app, "agents");
    await app.waitFor("id:manage-extensions");
    await app.press("id:manage-extensions");
    await app.waitFor("id:extensions-manager");
    await app.press("id:manage-npm:cc-safety-net@2.7.2");
    await app.press("id:manage-piki:node");
    await app.waitFor("text:Save 2 changes");
    await app.press("id:extensions-manager-save");
    await app.waitUntil(() => app.requests().some(item => item.method === "DELETE" && item.url.endsWith("source=piki%3Anode")));
    expect(bodyOf(app, "PUT", `${ORIGIN}/api/workspaces/w1/extensions`)).toEqual({ source: "npm:cc-safety-net@2.7.2", enabled: false, tools: "automatic", settings: { mode: "strict" } });
    await app.waitFor("text:2 changes saved. Sessions pick them up from their next message.");
  });

  test("Extensions says that adding Sub-agents adds Other sessions too", async () => {
    const app = await openSettings("workspaces", {
      [`GET ${ORIGIN}/api/workspaces/w1/extensions`]: { body: { admin: true, hosts: [], extensions: [{ source: "piki:sessions", enabled: false, tools: "automatic", settings: {} }] } },
    });
    await openWorkspace(app, "agents");
    await app.waitFor("id:workspace-extensions");
    await app.press("text:Add extension");
    await app.waitFor("text:Workflows");
    await app.press("text:Sub-agents");
    await app.waitUntil(() => app.texts().some(item => item.startsWith("It works through Other sessions (piki:sessions), off here: adding it adds that too")));
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

  test("Workspace schedules start a new session each run, on a model chosen for them, trusting another member's host only when told to", async () => {
    const models = [{ id: "m1", name: "Claude Sonnet", provider: "anthropic", modelId: "claude-sonnet", host: "c1" },
      { id: "m2", name: "Claude Opus", provider: "anthropic", modelId: "claude-opus", thinkingLevels: ["off", "low", "high"], host: "c2", foreignHost: true }];
    const app = await openSettings("workspaces", {
      [`GET ${ORIGIN}/api/workspaces/w1/schedules`]: { body: { schedules: [], canCreate: true, admin: false, models } },
      [`POST ${ORIGIN}/api/workspaces/w1/schedules`]: { status: 201, body: { schedule: { id: "sc1" } } },
    });
    await openWorkspace(app, "sessions");
    await app.waitFor("id:workspace-schedules");
    await app.waitFor("text:No schedules");
    await app.press("id:workspace-schedule-new");
    await app.type("id:schedule-content", "Triage the new issues");
    await app.press("id:schedule-model");
    await app.press("text:Claude Opus");
    await app.waitFor("id:schedule-trust");
    await app.press("id:schedule-thinking");
    await app.press("text:High");
    await app.press("id:schedule-trust");
    await app.press("id:schedule-save");
    await app.waitUntil(() => Boolean(bodyOf(app, "POST", `${ORIGIN}/api/workspaces/w1/schedules`)));
    expect(bodyOf(app, "POST", `${ORIGIN}/api/workspaces/w1/schedules`)).toMatchObject({ content: "Triage the new issues", modelId: "m2", thinkingLevel: "high",
      trustedConnectorId: "c2", oneShot: true, access: "auto" });
  });

  test("Workspace schedules show whom each runs as, and tell an admin that changing someone else's makes it theirs", async () => {
    const schedule = { id: "sc2", workspaceId: "w1", sessionId: null, ownerId: "u2", ownerName: "Grace Hopper", name: "Nightly", cron: "0 3 * * *", timeZone: "UTC",
      content: "Run the nightly checks", access: "auto", runIn: "child", oneShot: true, modelId: "m1", enabled: true, nextRunAt: "2099-01-01T03:00:00.000Z",
      lastRunAt: null, lastSubmissionId: null, lastSessionId: null, lastError: null, createdBy: "u2", createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z", canManage: true };
    const app = await openSettings("workspaces", {
      [`GET ${ORIGIN}/api/workspaces/w1/schedules`]: { body: { schedules: [schedule], canCreate: true, admin: true,
        models: [{ id: "m1", name: "Claude Sonnet", provider: "anthropic", modelId: "claude-sonnet", host: "c1" }] } },
      [`PATCH ${ORIGIN}/api/workspaces/w1/schedules/sc2`]: { body: { schedule: { ...schedule, ownerId: "u1" } } },
    });
    await openWorkspace(app, "sessions");
    await app.waitFor("id:schedule-sc2");
    expect(app.texts().join(" ")).toContain("runs as Grace Hopper");
    expect(app.texts().join(" ")).not.toContain("Run the nightly checks");
    await app.press("text:Pause");
    await app.waitUntil(() => Boolean(bodyOf(app, "PATCH", `${ORIGIN}/api/workspaces/w1/schedules/sc2`)));
    expect(bodyOf(app, "PATCH", `${ORIGIN}/api/workspaces/w1/schedules/sc2`)).toEqual({ enabled: false });
    await app.press("text:Edit");
    await app.waitFor("id:schedule-takeover");
    expect(app.texts().join(" ")).toContain("This schedule runs as Grace Hopper. Saving a change makes it yours");
    expect(app.value("id:schedule-content")).toBe("Run the nightly checks");
    expect(app.texts().join(" ")).not.toContain("choose a model for it");
  });

  test("a workspace schedule made from a session keeps that session's model while the session's owner runs it, and asks for one of anyone else", async () => {
    const base = { workspaceId: "w1", sessionId: null, originSessionId: "s9", cron: "0 3 * * *", timeZone: "UTC", content: "Triage", access: "auto", runIn: "child",
      oneShot: true, enabled: true, nextRunAt: null, lastRunAt: null, lastSubmissionId: null, lastSessionId: null, lastError: null, createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z", canManage: true };
    const mine = { ...base, id: "sc3", name: "Mine", ownerId: "u1", originOwnerId: "u1", createdBy: "u1" };
    const theirs = { ...base, id: "sc4", name: "Theirs", ownerId: "u2", ownerName: "Grace Hopper", originOwnerId: "u2", createdBy: "u2" };
    const app = await openSettings("workspaces", {
      [`GET ${ORIGIN}/api/workspaces/w1/schedules`]: { body: { schedules: [mine, theirs], canCreate: true, admin: true,
        models: [{ id: "m1", name: "Claude Sonnet", provider: "anthropic", modelId: "claude-sonnet", host: "c1" }] } },
      [`PATCH ${ORIGIN}/api/workspaces/w1/schedules/sc3`]: { body: { schedule: mine } },
    });
    await openWorkspace(app, "sessions");
    await app.waitFor("id:schedule-sc3");
    expect(app.texts().join(" ")).toContain("on its session's model");
    await app.press("text:Edit >> nth=0");
    await app.waitFor("id:schedule-form");
    expect(app.texts().join(" ")).toContain("Its session's model");
    await app.press("id:schedule-save");
    await app.waitUntil(() => Boolean(bodyOf(app, "PATCH", `${ORIGIN}/api/workspaces/w1/schedules/sc3`)));
    expect(Object.keys(bodyOf(app, "PATCH", `${ORIGIN}/api/workspaces/w1/schedules/sc3`))).not.toContain("modelId");
    await app.waitFor("id:schedule-sc4");
    await app.press("text:Edit >> nth=1");
    await app.waitFor("id:schedule-takeover");
    expect(app.texts().join(" ")).toContain("which isn't yours: choose a model for it");
    expect(app.texts().join(" ")).not.toContain("Its session's model");
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
