import { describe, expect, open, test } from "nsh/test";
import { server, signedIn } from "./fixtures";

async function openProfile() {
  const app = await open("../App.tsx", { network: server(), storage: signedIn, platform: "linux", width: 1280, height: 1600 });
  await app.waitFor("id:session-row-s1");
  await app.press("id:open-profile");
  await app.waitFor("id:app-platform");
  const terminal = app.texts().some(text => text.endsWith("· terminal"));
  return { app, terminal };
}

describe("Pikibun in a terminal (nsh test tests/terminal.test.tsx --target tui), and the same steps everywhere else", () => {
  test("the app signs in, lists the sessions and opens Profile, which names the device form", async () => {
    const { app, terminal } = await openProfile();
    expect(app.texts().some(text => text.endsWith(terminal ? "· terminal" : "· desktop"))).toBe(true);
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
    if (!terminal) return;
    const cells = JSON.parse(new TextDecoder().decode(await app.screenshot())) as { format: string; rows: { symbol: string }[][] };
    expect(cells.format).toBe("nsh-tui-cells");
    const screen = cells.rows.map(row => row.map(cell => cell.symbol).join("")).join("\n");
    expect(screen.includes("Platform")).toBe(true);
    expect(screen.includes("terminal")).toBe(true);
  });
});
