import { describe, expect, open, test } from "nsh/test";
import { parseRoute, routeHash } from "../src/lib/page";
import { ORIGIN, server, signedIn } from "./fixtures";

describe("the web app's addresses", () => {
  test("each route reads back from its address, as links people already have point", () => {
    expect(parseRoute("#/s/abc-123")).toEqual({ name: "session", sessionId: "abc-123" });
    expect(parseRoute("#/shared/t%2Fk")).toEqual({ name: "shared", token: "t/k" });
    expect(parseRoute("#/join/inv")).toEqual({ name: "join", token: "inv" });
    expect(parseRoute("#/w/w1/new")).toEqual({ name: "new", workspaceId: "w1" });
    expect(parseRoute("#/settings/hosts/c1")).toEqual({ name: "settings", section: "hosts", id: "c1" });
    expect(parseRoute("#/settings")).toEqual({ name: "settings" });
    for (const unknown of ["", "#", "#/", "#/nope", "#/s/", "#/s/%E0%A4%A"]) expect(parseRoute(unknown)).toEqual({ name: "home" });
    for (const route of [{ name: "session", sessionId: "a b" }, { name: "shared", token: "x/y" }, { name: "settings", section: "hosts", id: "c1" }, { name: "new", workspaceId: "w1" }] as const) {
      expect(parseRoute(routeHash(route))).toEqual(route);
    }
    expect(routeHash({ name: "home" })).toBe("#/");
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
