import { describe, expect, open, test } from "nsh/test";
import { ORIGIN, server, signedIn, view } from "./fixtures";

const linked = {
  ...view,
  entries: [
    ...view.entries,
    {
      id: "e4", kind: "message", role: "assistant", conversationId: "0",
      text: "See [the CI run](https://github.com/OpenCara/pikibun/actions/runs/1), [the notes](#notes), [the log](file:///etc/passwd) and [mail Ada](mailto:ada@example.com).",
    },
  ],
};

const queued = { ...view, withdrawable: true, queue: [...view.queue, { submissionId: "q5", actorId: "u1", mode: "write", status: "queued" }] };
const withdrawn = (app: { requests(): { method: string; url: string }[] }) =>
  app.requests().filter(item => item.method === "POST" && item.url.endsWith("/api/sessions/s1/withdraw")).length;

describe("a message's links", () => {
  test("open web and mail addresses in the browser, and nothing else", async () => {
    const app = await open("../App.tsx", { storage: signedIn, platform: "macos", width: 1200, height: 800, network: server({
      [`GET ${ORIGIN}/api/sessions/s1/view`]: { body: { view: linked, revision: "r1" } },
    }) });
    await app.press("id:session-row-s1");
    await app.waitFor("text:the CI run");
    await app.press("text:the CI run");
    await app.waitUntil(() => app.openedUrls().includes("https://github.com/OpenCara/pikibun/actions/runs/1"));
    await app.press("text:the notes");
    await app.press("text:the log");
    await app.press("text:mail Ada");
    await app.waitUntil(() => app.openedUrls().length === 2);
    expect(app.openedUrls()).toEqual(["https://github.com/OpenCara/pikibun/actions/runs/1", "mailto:ada@example.com"]);
  });
});

describe("selecting a message's text", () => {
  test("on a desktop, takes the focus from the chat box, so Copy copies the selection", async () => {
    const app = await open("../App.tsx", { storage: signedIn, platform: "macos", width: 1200, height: 800, network: server({
      [`GET ${ORIGIN}/api/sessions/s1/view`]: { body: { view: queued, revision: "r1" } },
      [`POST ${ORIGIN}/api/sessions/s1/withdraw`]: { body: { content: "Also cover the logout test", mode: "write" } },
    }) });
    await app.press("id:session-row-s1");
    await app.waitFor("text:Why does the login test fail on CI?");
    await app.type("id:composer-input", "x");
    await app.clear("id:composer-input");
    await app.drag("text:Why does the login test fail on CI?", { x: 60, y: 0 });
    await app.keyboard.press("up");
    expect(withdrawn(app)).toBe(0);
    await app.type("id:composer-input", "x");
    await app.clear("id:composer-input");
    await app.keyboard.press("up");
    await app.waitUntil(() => app.value("id:composer-input") === "Also cover the logout test");
    expect(withdrawn(app)).toBe(1);
  });

  test("on a phone, leaves the chat box its focus", async () => {
    const app = await open("../App.tsx", { storage: signedIn, platform: "ios", network: server({
      [`GET ${ORIGIN}/api/sessions/s1/view`]: { body: { view: queued, revision: "r1" } },
      [`POST ${ORIGIN}/api/sessions/s1/withdraw`]: { body: { content: "Also cover the logout test", mode: "write" } },
    }) });
    await app.press("id:session-row-s1");
    await app.waitFor("text:Why does the login test fail on CI?");
    await app.type("id:composer-input", "x");
    await app.clear("id:composer-input");
    await app.drag("text:Why does the login test fail on CI?", { x: 60, y: 0 });
    await app.keyboard.press("up");
    await app.waitUntil(() => app.value("id:composer-input") === "Also cover the logout test");
    expect(withdrawn(app)).toBe(1);
  });
});
