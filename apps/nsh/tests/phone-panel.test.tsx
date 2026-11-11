import { describe, expect, open, test } from "nsh/test";
import { server, signedIn } from "./fixtures";

const sizes: [string, { width?: number; height?: number }][] = [
  ["phone", {}],
  ["phone landscape", { width: 932, height: 430 }],
  ["ipad", { width: 1024, height: 1366 }],
  ["ipad portrait small", { width: 744, height: 1133 }],
];

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
