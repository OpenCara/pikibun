import { describe, expect, open, test } from "nsh/test";
import { host, ORIGIN, server, signedIn, workspace } from "./fixtures";

const offline = { ...host, online: false };
const privateWorkspace = { ...workspace, name: "Private", personal: true };

function network(overrides: Record<string, unknown> = {}) {
  return server({
    [`GET ${ORIGIN}/api/workspaces`]: { body: { workspaces: [privateWorkspace] } },
    [`GET ${ORIGIN}/api/workspaces/w1/connectors`]: { body: { connectors: [offline] } },
    ...overrides,
  });
}

async function openSession(platform: "macos" | "ios" | "web", overrides: Record<string, unknown> = {}, storage: Record<string, string> = {}) {
  const app = await open("../App.tsx", { network: network(overrides), storage: { ...signedIn, ...storage }, platform, width: 1280, height: 900 });
  await app.waitFor("id:session-row-s1");
  await app.press("id:session-row-s1");
  return app;
}

describe("a private session whose host is offline", () => {
  test("on a desktop, asks to connect this Mac to the server signed in to, which opens This Mac's settings", async () => {
    const app = await openSession("macos");
    await app.waitFor("id:session-host-offline");
    expect(app.shows("text:ada-mac is offline")).toBe(true);
    expect(app.texts().some(text => text.includes("If that's this Mac, connect This Mac to pikibun.test too, to continue it"))).toBe(true);
    await app.press("id:session-host-connect");
    await app.waitFor("id:settings-this-computer");
  });

  test("says so plainly when the host was this Mac, from the host IDs it has run as", async () => {
    const app = await openSession("macos", {}, { "pikibun.thisComputer.connectors": JSON.stringify({ [ORIGIN]: ["c1"] }) });
    await app.waitFor("id:session-host-offline");
    await app.waitUntil(() => app.shows("text:This Mac isn't hosting this session"));
    expect(app.texts().some(text => text.includes("This private session ran on this Mac, which is no longer connected to pikibun.test."))).toBe(true);
    expect(app.shows("id:session-host-connect")).toBe(true);
  });

  test("elsewhere, says to start the host on that computer, with nothing to press", async () => {
    const app = await openSession("ios");
    await app.waitFor("id:session-host-offline");
    expect(app.texts().some(text => text.includes("This private session runs on ada-mac, one of your computers"))).toBe(true);
    expect(app.shows("id:session-host-connect")).toBe(false);
  });

  test("where this Mac is paired with the server but not hosting, starts its host from the banner", async () => {
    const app = await open("./harness/offline-host.tsx", { platform: "macos", width: 900, height: 600 });
    await app.waitFor("id:session-host-start");
    expect(app.texts().some(text => text.includes("If that's this Mac, start its host for pikibun.test"))).toBe(true);
    expect(app.shows("id:session-host-connect")).toBe(false);
    await app.press("id:session-host-start");
    await app.waitUntil(() => app.texts().includes("hosts: https://pikibun.test=connected"));
    expect(app.texts().some(text => text.startsWith("sent: ") && text.includes("start"))).toBe(true);
  });

  test("where this Mac is paired with another server only, sends to its settings to connect this one too", async () => {
    const app = await open("./harness/offline-host.tsx", { platform: "macos", width: 900, height: 600, host: { params: { paired: "https://other.example" } } });
    await app.waitFor("id:session-host-connect");
    expect(app.shows("id:session-host-start")).toBe(false);
    await app.press("id:session-host-connect");
    await app.waitUntil(() => app.texts().includes("settings opened: 1"));
  });

  test("says nothing while the host is online, nor in a workspace that isn't private", async () => {
    const online = await openSession("macos", { [`GET ${ORIGIN}/api/workspaces/w1/connectors`]: { body: { connectors: [host] } } });
    await online.waitFor("text:Why does the login test fail on CI?");
    expect(online.shows("id:session-host-offline")).toBe(false);
    const team = await openSession("macos", { [`GET ${ORIGIN}/api/workspaces`]: { body: { workspaces: [workspace] } } });
    await team.waitFor("text:Why does the login test fail on CI?");
    await team.wait(500);
    expect(team.shows("id:session-host-offline")).toBe(false);
  });
});
