import { describe, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";
import { server, signedIn } from "./fixtures";

type Cells = { format: string; width: number; height: number; rows: { symbol: string }[][] };

const out = ".nsh";

async function cells(app: App, name?: string): Promise<Cells | null> {
  try {
    return JSON.parse(new TextDecoder().decode(await app.screenshot(name ? `${out}/tui-${name}.json` : undefined))) as Cells;
  } catch (error) {
    if (String((error as Error)?.message ?? error).includes("needs a real platform")) return null;
    throw error;
  }
}

const screen = (drawn: Cells) => drawn.rows.map(row => row.map(cell => cell.symbol).join("")).join("\n");

async function openProfile() {
  const app = await open("../App.tsx", { network: server(), storage: signedIn, platform: "linux", width: 1280, height: 1600 });
  await app.waitFor("id:session-row-s1");
  await app.press("id:open-profile");
  await app.waitFor("id:app-platform");
  const terminal = app.texts().some(text => text.endsWith("· terminal"));
  return { app, terminal };
}

describe("Pikibun in a terminal (nsh test tests/terminal.test.tsx --target tui), and the same steps everywhere else", () => {
  test("the app signs in, lists the sessions and opens Profile, which names the device form the target draws in", async () => {
    const { app, terminal } = await openProfile();
    expect(app.texts().some(text => text.endsWith(terminal ? "· terminal" : "· desktop"))).toBe(true);
    const drawn = await cells(app);
    expect(drawn?.format === "nsh-tui-cells").toBe(terminal);
  });

  test("in a terminal npm updates the app, never the app itself; elsewhere npm isn't mentioned", async () => {
    const { app, terminal } = await openProfile();
    expect(app.shows("id:app-update-npm")).toBe(terminal);
    expect(app.texts().some(text => text.includes("npm install -g @pikibun/tui@latest"))).toBe(terminal);
    expect(app.shows("id:app-update-check")).toBe(false);
    expect(app.shows("id:home-update")).toBe(false);
  });

  test("the terminal draws the app in Cells: the profile page's own words are on the grid", async () => {
    const { app, terminal } = await openProfile();
    const drawn = await cells(app, "profile");
    expect(drawn !== null).toBe(terminal);
    if (!drawn) return;
    expect(screen(drawn).includes("Platform")).toBe(true);
    expect(screen(drawn).includes("terminal")).toBe(true);
  });

  test("a 120 × 40 terminal shows the sessions, a session with its chat box, a new session and settings, light and dark", async () => {
    const app = await open("../App.tsx", { network: server(), storage: signedIn, platform: "linux", width: 960, height: 640 });
    await app.waitFor("id:session-row-s1");
    await cells(app, "home");
    await app.press("id:session-row-s1");
    await app.waitFor("id:composer-input");
    await app.waitFor("text:Why does the login test fail on CI?");
    const session = await cells(app, "session");
    expect(app.shows("id:composer-attach")).toBe(session === null);
    if (session) {
      expect([session.width, session.height]).toEqual([120, 40]);
      expect(screen(session).includes("login test")).toBe(true);
    }
    await app.press("id:new-session");
    await app.waitFor("id:new-start");
    await cells(app, "new-session");
    await app.press("id:open-profile");
    await app.waitFor("id:app-platform");
    await cells(app, "settings");
    const dark = await app.setColorScheme("dark").then(() => true, (error: { code?: string }) => {
      if (error?.code === "ERR_NSH_TEST_UNSUPPORTED") return false;
      throw error;
    });
    if (dark) await cells(app, "settings-dark");
  });
});
