import { describe, expect, open, test } from "nsh/test";
import { server, signedIn } from "./fixtures";

describe("a session's panel on a phone", () => {
  test("opens from the session's header", async () => {
    const app = await open("../App.tsx", { network: server(), storage: signedIn, platform: "ios" });
    await app.press("id:session-row-s1");
    await app.waitFor("id:session-details");
    await app.press("id:session-details");
    await app.waitFor("id:session-panel");
    await app.waitFor("id:panel-details");
    expect(app.shows("id:session-panel-close")).toBe(true);
  });
});
