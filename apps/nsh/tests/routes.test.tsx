import { describe, expect, open, test } from "nsh/test";
import { parseRoute, routeHash, sessionIdIn } from "../src/lib/page";
import { ORIGIN, server, signedIn } from "./fixtures";

describe("the web app's addresses", () => {
  test("each route reads back from its address, as links people already have point", () => {
    expect(parseRoute("#/s/abc-123")).toEqual({ name: "session", sessionId: "abc-123" });
    expect(parseRoute("#/shared/t%2Fk")).toEqual({ name: "shared", token: "t/k" });
    expect(parseRoute("#/join/inv")).toEqual({ name: "join", token: "inv" });
    expect(parseRoute("#/w/w1/new")).toEqual({ name: "new", workspaceId: "w1" });
    expect(parseRoute("#/settings/hosts/c1")).toEqual({ name: "settings", section: "hosts", id: "c1" });
    expect(parseRoute("#/settings")).toEqual({ name: "settings" });
    expect(parseRoute("#/settings/workspaces/w1/agents")).toEqual({ name: "settings", section: "workspaces", id: "w1", tab: "agents" });
    expect(routeHash({ name: "settings", section: "workspaces", id: "w1", tab: "sessions" })).toBe("#/settings/workspaces/w1/sessions");
    expect(routeHash({ name: "settings", section: "workspaces", tab: "sessions" })).toBe("#/settings/workspaces");
    for (const unknown of ["", "#", "#/", "#/nope", "#/s/", "#/s/%E0%A4%A"]) expect(parseRoute(unknown)).toEqual({ name: "home" });
    for (const route of [{ name: "session", sessionId: "a b" }, { name: "shared", token: "x/y" }, { name: "settings", section: "hosts", id: "c1" }, { name: "new", workspaceId: "w1" }] as const) {
      expect(parseRoute(routeHash(route))).toEqual(route);
    }
    expect(routeHash({ name: "home" })).toBe("#/");
  });

  test("a session's ID, or a link to it, names the session; any other text doesn't", () => {
    const id = "3f2b8c1e-9d4a-4c5e-8f00-12ab34cd56ef";
    expect(sessionIdIn(id)).toBe(id);
    expect(sessionIdIn(`  ${id}\n`)).toBe(id);
    expect(sessionIdIn(`https://pikibun.com/#/s/${id}`)).toBe(id);
    expect(sessionIdIn("#/s/a%20b")).toBe("a b");
    for (const other of ["", "rename", "s1", `open ${id}`, "https://pikibun.com/#/settings/hosts", "https://pikibun.com/"]) expect(sessionIdIn(other)).toBe(null);
  });
});

describe("in a browser", () => {
  test("a share link opens without signing in", async () => {
    const app = await open("../App.tsx", {
      platform: "web",
      network: server(),
      host: { handlers: { "page.route": "#/shared/share-token", "page.setRoute": null, "page.open": null } },
    });
    await app.waitFor("id:shared-session");
    expect(app.shows("id:github-sign-in")).toBe(false);
  });
});

describe("on a device", () => {
  test("there is no page: the app opens at home and asks the host nothing", async () => {
    const app = await open("../App.tsx", { network: server(), storage: signedIn });
    await app.waitFor("id:session-row-s1");
    expect(app.requests().every(request => request.url.startsWith(ORIGIN))).toBe(true);
  });

  test("settings: the sections, each a page; administration only for administrators", async () => {
    const app = await open("../App.tsx", { network: server(), storage: signedIn });
    await app.press("id:open-settings");
    await app.waitFor("id:settings-sections");
    expect(app.shows("id:settings-section-admin")).toBe(false);
    await app.press("id:settings-section-appearance");
    await app.waitFor("id:appearance-scheme");
    await app.press("text:Dark");
    expect(app.storage()["pikibun.appearance"]).toBe("dark");
    await app.press("text:Pikibun");
    expect(app.storage()["pikibun.appearance"]).toBe("pikibun");
    app.dispose();
    const again = await open("../App.tsx", { network: server(), storage: { ...signedIn, "pikibun.appearance": "pikibun" } });
    await again.press("id:open-settings");
    await again.press("id:settings-section-appearance");
    await again.waitFor("id:appearance-scheme");
    expect(again.shows("text:Pikibun")).toBe(true);
  });

  test("language: the device's first, chosen in Appearance, kept on the device", async () => {
    const chinese = await open("../App.tsx", { network: server(), storage: signedIn, locale: "zh-CN" });
    await chinese.press("id:open-settings");
    await chinese.waitFor("text:外观");
    chinese.dispose();
    const traditional = await open("../App.tsx", { network: server(), storage: signedIn, locale: "zh-TW" });
    await traditional.press("id:open-settings");
    await traditional.waitFor("text:外觀");
    traditional.dispose();
    const app = await open("../App.tsx", { network: server(), storage: signedIn });
    await app.press("id:open-settings");
    await app.press("id:settings-section-appearance");
    await app.waitFor("id:appearance-language");
    expect(app.shows("text:Display language")).toBe(true);
    await app.press("id:appearance-language");
    await app.press("text:日本語");
    await app.waitFor("text:表示言語");
    expect(app.storage()["pikibun.language"]).toBe("ja");
    app.dispose();
    const again = await open("../App.tsx", { network: server(), storage: { ...signedIn, "pikibun.language": "ko" } });
    await again.press("id:open-settings");
    await again.waitFor("text:모양");
    await again.press("id:settings-section-appearance");
    await again.press("id:appearance-language");
    await again.press("text:English");
    await again.waitFor("text:Display language");
    expect(again.storage()["pikibun.language"]).toBe("en");
  });

  test("a workspace's row folds its sessions away and back", async () => {
    const app = await open("../App.tsx", { network: server(), storage: signedIn });
    await app.waitFor("id:session-row-s1");
    await app.press("id:workspace-row-w1");
    await app.waitUntil(() => !app.shows("id:session-row-s1"));
    expect(app.shows("text:Analytical Engine")).toBe(true);
    await app.press("id:workspace-row-w1");
    await app.waitFor("id:session-row-s1");
  });

  test("a session's panel opens from its header, one tab at a time", async () => {
    const app = await open("../App.tsx", { network: server(), storage: signedIn, platform: "macos", width: 1200, height: 800 });
    await app.press("id:session-row-s1");
    await app.waitFor("id:session-details");
    await app.press("id:session-details");
    await app.waitFor("id:session-panel");
    await app.waitFor("id:panel-overview");
    await app.press("text:Files");
    await app.waitFor("id:panel-files");
  });
});
