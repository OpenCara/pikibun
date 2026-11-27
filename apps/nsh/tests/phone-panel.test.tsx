import { describe, expect, open, test } from "nsh/test";
import { ORIGIN, server, signedIn, view } from "./fixtures";

const sizes: [string, { width?: number; height?: number }][] = [
  ["phone", {}],
  ["phone landscape", { width: 932, height: 430 }],
  ["ipad", { width: 1024, height: 1366 }],
  ["ipad mini portrait", { width: 744, height: 1133 }],
];

describe("pages' headers on an iPhone", () => {
  test("are the app's own, in the page: their buttons and back work", async () => {
    const app = await open("../App.tsx", { network: server(), storage: signedIn, platform: "ios", safeArea: { top: 47, bottom: 34 } });
    await app.waitFor("id:new-session");
    await app.press("id:open-settings");
    await app.waitFor("id:header-back");
    await app.press("id:header-back");
    await app.waitFor("id:session-row-s1");
    await app.press("id:session-row-s1");
    await app.waitFor("id:session-header");
    expect(app.shows("id:session-actions")).toBe(true);
    await app.press("id:session-actions");
    await app.waitFor("id:session-copy-id");
    await app.press("id:session-copy-id");
    await app.press("id:header-back");
    await app.waitFor("id:session-row-s1");
  });
});

describe("a session's panel", () => {
  test("says which account a session on its host reaches the workspace's repositories with", async () => {
    for (const [access, badge] of [["owner", "Pikibun account"], ["host", "Host's credentials"]] as const) {
      const app = await open("../App.tsx", { network: server({ [`GET ${ORIGIN}/api/sessions/s1/view`]: { body: { view: { ...view, forgeAccess: access }, revision: "r1" } } }),
        storage: signedIn, platform: "ios" });
      await app.press("id:session-row-s1");
      await app.waitFor("id:session-details");
      await app.press("id:session-details");
      await app.waitFor("id:session-forge-access");
      expect(app.texts().join(" ")).toContain(badge);
      app.dispose();
    }
    const plain = await open("../App.tsx", { network: server(), storage: signedIn, platform: "ios" });
    await plain.press("id:session-row-s1");
    await plain.waitFor("id:session-details");
    await plain.press("id:session-details");
    await plain.waitFor("id:panel-details");
    expect(plain.shows("id:session-forge-access")).toBe(false);
    plain.dispose();
  });
});

describe("a session's panel on iOS", () => {
  for (const [name, size] of sizes) {
    test(`opens from the session's header (${name})`, async () => {
      const app = await open("../App.tsx", { network: server(), storage: signedIn, platform: "ios", ...size });
      await app.press("id:session-row-s1");
      await app.waitFor("id:session-details");
      await app.press("id:session-details");
      await app.waitFor("id:session-panel");
      await app.waitFor("id:panel-details");
      expect(app.shows("id:session-panel-close")).toBe(true);
      await app.press("id:session-panel-close");
      await app.waitUntil(() => !app.shows("id:session-panel"));
      await app.press("id:session-details");
      await app.waitFor("id:panel-details");
      await app.press("text:Files");
      await app.waitFor("id:file-README.md");
    });
  }
});
