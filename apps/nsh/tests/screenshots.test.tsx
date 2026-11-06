import { open, test } from "nsh/test";
import type { App } from "nsh/test";
import { ORIGIN, server, signedIn } from "./fixtures";

// Renders the main screens and saves them for review. Screenshots need a platform that draws the app, so run it with
// one: `nsh test --target macos tests/screenshots.test.tsx` (or ios, android, linux, windows, web). Headless, it only
// walks the screens.
const out = "../.nsh/screenshots";

async function shot(app: App, name: string) {
  try {
    await app.screenshot(`${out}/${name}.png`);
  } catch (error) {
    if (!String((error as Error)?.message ?? error).includes("needs a real platform")) throw error;
  }
}

test("phone screens", async () => {
  const app = await open("../App.tsx", { network: server(), storage: { "pikibun.origin": ORIGIN }, safeArea: { top: 47, bottom: 34 } });
  await app.waitFor("id:developer-toggle");
  await shot(app, "phone-sign-in");
  app.dispose();

  const signed = await open("../App.tsx", { network: server(), storage: signedIn, safeArea: { top: 47, bottom: 34 } });
  await signed.waitFor("id:session-row-s1");
  await shot(signed, "phone-sessions");
  await signed.press("id:session-row-s1");
  await signed.waitFor("id:approval-approve");
  await shot(signed, "phone-session");
});

test("desktop, light and dark", async () => {
  const app = await open("../App.tsx", { network: server(), storage: signedIn, platform: "macos", width: 1280, height: 820 });
  await app.waitFor("id:session-row-s1");
  await app.press("id:session-row-s1");
  await app.waitFor("id:approval-approve");
  await shot(app, "desktop-session");
  await app.setColorScheme("dark");
  await shot(app, "desktop-session-dark");
  await app.press("id:new-session");
  await app.waitFor("id:new-start");
  await shot(app, "desktop-dark-new-session");
});
