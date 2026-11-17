import { describe, expect, open, test } from "nsh/test";
import { ORIGIN, server, sessionRecord, signedIn, view } from "./fixtures";

type Requests = { requests(): { method: string; url: string; body?: string | null }[] };
const sent = (app: Requests, method: string, path: string) => app.requests().filter(item => item.method === method && item.url === `${ORIGIN}${path}`);
const bodyOf = (app: Requests, method: string, path: string) => {
  const request = sent(app, method, path).at(-1);
  return request?.body ? JSON.parse(request.body) : undefined;
};

const other = { ...sessionRecord, id: "s3", title: "Add a dark mode", createdAt: "2026-11-05T09:00:00.000Z", activity: "idle" };
const archived = { ...sessionRecord, id: "s2", title: "Old spike", status: "archived", createdAt: "2026-10-01T09:00:00.000Z", activity: "idle" };
const threeSessions = { [`GET ${ORIGIN}/api/sessions`]: { body: { sessions: [sessionRecord, other, archived] } } };

const desktop = async (overrides: Record<string, unknown> = {}) => {
  const app = await open("../App.tsx", { storage: signedIn, platform: "macos", width: 1200, height: 800, network: server({ ...threeSessions, ...overrides }) });
  await app.press("id:session-row-s1");
  await app.waitFor("id:chat-model");
  return app;
};

describe("the command palette", () => {
  test("Ctrl/⌘ K opens it on the session's commands, grouped, then the global ones, and Escape closes it", async () => {
    const app = await desktop();
    await app.keyboard.press("mod+k");
    await app.waitFor("id:command-palette");
    for (const id of ["session-rename", "session-archive", "session-copy-id", "panel-open", "sharing-copy-link"]) {
      expect(app.shows(`id:palette-command-${id}`)).toBe(true);
    }
    expect(app.texts()).toContain("Session");
    expect(app.texts()).toContain("Panel");
    expect(app.texts()).toContain("Sharing");
    expect(app.shows("id:palette-command-new-session")).toBe(false);
    await app.scroll("id:palette-rows", 2000);
    await app.waitFor("id:palette-command-new-session");
    expect(app.texts()).toContain("Sessions");
    await app.keyboard.press("escape");
    await app.waitFor("id:command-palette", { state: "gone" });
  });

  test("a command that can't run now is dimmed with the reason", async () => {
    const app = await desktop();
    await app.keyboard.press("mod+k");
    await app.waitFor("id:palette-command-session-backup");
    expect(app.enabled("id:palette-command-session-backup")).toBe(false);
    expect(app.texts()).toContain("Wait until the session is idle");
    await app.type("id:palette-input", "stop");
    await app.waitFor("id:palette-command-chat-stop");
    expect(app.enabled("id:palette-command-chat-stop")).toBe(true);
  });

  test("typing ranks the matching commands, then the sessions whose title matches, and choosing a session opens it", async () => {
    const app = await desktop();
    await app.keyboard.press("mod+k");
    await app.waitFor("id:palette-input");
    await app.type("id:palette-input", "dark");
    await app.waitFor("id:palette-session-s3");
    expect(app.shows("id:palette-command-session-rename")).toBe(false);
    await app.submit("id:palette-input");
    await app.waitFor("id:command-palette", { state: "gone" });
    await app.waitUntil(() => app.texts().includes("Add a dark mode"));
    await app.waitFor("id:chat-model");
    expect(sent(app, "GET", "/api/sessions/s3/view").length).toBeGreaterThan(0);
  });

  test("Rename… asks for the title in the palette, starting from the current one", async () => {
    const app = await desktop();
    await app.keyboard.press("mod+k");
    await app.waitFor("id:palette-input");
    await app.type("id:palette-input", "rena");
    await app.waitFor("id:palette-command-new-session", { state: "gone" });
    await app.submit("id:palette-input");
    await app.waitUntil(() => app.value("id:palette-input") === "Fix the flaky login test");
    expect(app.texts()).toContain("Rename…");
    await app.clear("id:palette-input");
    await app.type("id:palette-input", "Fix the login race");
    await app.waitFor("text:Rename to “Fix the login race”");
    await app.submit("id:palette-input");
    await app.waitUntil(() => bodyOf(app, "PATCH", "/api/sessions/s1") !== undefined);
    expect(bodyOf(app, "PATCH", "/api/sessions/s1")).toEqual({ title: "Fix the login race" });
    await app.waitFor("text:Session renamed");
  });

  test("Escape in a command's input goes back to the commands", async () => {
    const app = await desktop();
    await app.keyboard.press("mod+k");
    await app.waitFor("id:palette-rows");
    await app.scroll("id:palette-rows", 200);
    await app.waitFor("id:palette-command-chat-reasoning");
    await app.press("id:palette-command-chat-reasoning");
    await app.waitFor("id:palette-choice-high");
    expect(app.shows("id:palette-command-session-rename")).toBe(false);
    await app.keyboard.press("escape");
    await app.waitFor("id:palette-command-session-rename");
    expect(app.shows("id:command-palette")).toBe(true);
  });

  test("a choice sets the model of the next message", async () => {
    const opus = { provider: "anthropic", modelId: "claude-opus", name: "Claude Opus", reasoning: true, thinkingLevels: ["off", "high"] };
    const hostWithOpus = { id: "c1", ownerId: "u1", ownerName: "ada", name: "ada-mac", createdAt: "2026-11-01T10:00:00.000Z", revokedAt: null, online: true, workspaceIds: ["w1"],
      capabilities: { sandbox: true, chatOptions: true },
      models: [{ provider: "anthropic", modelId: "claude-sonnet", name: "Claude Sonnet", reasoning: true, thinkingLevels: ["off", "low", "medium", "high"] }, opus] };
    const app = await desktop({ [`GET ${ORIGIN}/api/workspaces/w1/connectors`]: { body: { connectors: [hostWithOpus] } } });
    await app.keyboard.press("mod+k");
    await app.waitFor("id:palette-command-chat-model");
    await app.press("id:palette-command-chat-model");
    await app.waitFor("id:palette-choice-anthropic/claude-opus");
    await app.type("id:palette-input", "opus");
    await app.waitFor("id:palette-choice-anthropic/claude-sonnet", { state: "gone" });
    await app.submit("id:palette-input");
    await app.waitFor("text:Model set to Claude Opus, from your next message.");
    await app.type("id:composer-input", "Carry on");
    await app.submit("id:composer-input");
    await app.waitUntil(() => bodyOf(app, "POST", "/api/sessions/s1/submit") !== undefined);
    expect(bodyOf(app, "POST", "/api/sessions/s1/submit").options.model).toEqual({ provider: "anthropic", modelId: "claude-opus" });
  });

  test("Ctrl/⌘ O opens Switch session… straight away", async () => {
    const app = await desktop();
    await app.keyboard.press("mod+o");
    await app.waitFor("id:palette-choice-s3");
    expect(app.shows("id:palette-choice-s1")).toBe(true);
    expect(app.shows("id:palette-choice-s2")).toBe(false);
    expect(app.texts()).toContain("Switch session…");
    await app.keyboard.press("down");
    await app.submit("id:palette-input");
    await app.waitFor("id:command-palette", { state: "gone" });
    await app.waitUntil(() => sent(app, "GET", "/api/sessions/s3/view").length > 0);
  });

  test("the highlighted row stays where the keys put it while the lists refresh underneath", async () => {
    const app = await open("../App.tsx", { storage: signedIn, platform: "macos", width: 1200, height: 800, clock: {}, network: server(threeSessions) });
    await app.press("id:session-row-s1");
    await app.waitFor("id:chat-model");
    await app.keyboard.press("mod+o");
    await app.waitFor("id:palette-choice-s3");
    await app.keyboard.press("down");
    const listed = sent(app, "GET", "/api/sessions").length;
    await app.wait(31_000);
    await app.waitUntil(() => sent(app, "GET", "/api/sessions").length > listed);
    await app.wait(100);
    await app.submit("id:palette-input");
    await app.waitFor("id:command-palette", { state: "gone" });
    await app.waitUntil(() => sent(app, "GET", "/api/sessions/s3/view").length > 0);
  });

  test("opened again, the palette highlights its first row, not the one left highlighted", async () => {
    const app = await desktop();
    await app.keyboard.press("mod+k");
    await app.waitFor("id:palette-command-session-archive");
    await app.keyboard.press("down");
    await app.keyboard.press("escape");
    await app.waitFor("id:command-palette", { state: "gone" });
    await app.keyboard.press("mod+k");
    await app.waitFor("id:palette-input");
    await app.submit("id:palette-input");
    await app.waitUntil(() => app.value("id:palette-input") === "Fix the flaky login test");
    expect(app.dialogs()).toHaveLength(0);
  });

  test("a slash command goes into the chat box, and is dimmed while the box holds a message", async () => {
    const app = await desktop();
    await app.keyboard.press("mod+k");
    await app.waitFor("id:palette-input");
    await app.type("id:palette-input", "/new");
    await app.waitFor("id:palette-command-slash-new");
    await app.submit("id:palette-input");
    await app.waitUntil(() => app.value("id:composer-input") === "/new");
    await app.clear("id:composer-input");
    await app.type("id:composer-input", "Hello");
    await app.keyboard.press("mod+k");
    await app.waitFor("id:palette-input");
    await app.type("id:palette-input", "/new");
    await app.waitFor("id:palette-command-slash-new");
    expect(app.enabled("id:palette-command-slash-new")).toBe(false);
    expect(app.texts()).toContain("The chat box has a message in it");
    expect(app.value("id:composer-input")).toBe("Hello");
  });

  test("without a session open, only the global commands are offered, and a settings section opens", async () => {
    const app = await open("../App.tsx", { storage: signedIn, platform: "macos", width: 1200, height: 800, network: server(threeSessions) });
    await app.waitFor("id:sidebar");
    await app.press("id:open-commands");
    await app.waitFor("id:palette-command-new-session");
    expect(app.shows("id:palette-command-session-rename")).toBe(false);
    await app.type("id:palette-input", "appear");
    await app.waitFor("id:palette-command-settings-appearance");
    await app.submit("id:palette-input");
    await app.waitFor("id:settings-sections");
  });

  test("a collaborator who doesn't manage the session isn't offered Rename… or Archive", async () => {
    const app = await desktop({
      [`GET ${ORIGIN}/api/sessions/s1`]: { body: { session: { ...sessionRecord, ownerId: "u2", permissions: ["read", "ask", "write"], viewable: true } } },
      [`GET ${ORIGIN}/api/workspaces`]: { body: { workspaces: [{ id: "w1", name: "Analytical Engine", ownerId: "u2", role: "member" }] } },
    });
    await app.keyboard.press("mod+k");
    await app.waitFor("id:palette-command-session-copy-id");
    expect(app.shows("id:palette-command-session-rename")).toBe(false);
    expect(app.shows("id:palette-command-session-archive")).toBe(false);
    expect(app.shows("id:palette-command-session-backup")).toBe(false);
  });

  test("on a phone, the session header's button opens it as a sheet, and a panel command opens that tab", async () => {
    const app = await open("../App.tsx", { storage: signedIn, platform: "ios", network: server({ ...threeSessions,
      [`GET ${ORIGIN}/api/sessions/s1/view`]: { body: { view: { ...view, busy: false, queue: [], activity: "idle" }, revision: "r1" } } }) });
    await app.press("id:session-row-s1");
    await app.waitFor("id:session-commands");
    await app.press("id:session-commands");
    await app.waitFor("id:command-palette");
    expect(app.shows("id:palette-keys")).toBe(false);
    await app.type("id:palette-input", "activity");
    await app.waitFor("id:palette-command-panel-activity");
    await app.press("id:palette-command-panel-activity");
    await app.waitFor("id:panel-activity");
  });
});
