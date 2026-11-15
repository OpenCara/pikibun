import { describe, expect, open, test } from "nsh/test";
import { host, ORIGIN, server, sessionRecord, signedIn, view } from "./fixtures";

const idle = {
  ...view,
  entries: [
    { id: "0:1", kind: "message", role: "user", text: "Why does the login test fail on CI?", actorId: "u1", conversationId: "0" },
    { id: "0:2", kind: "message", role: "assistant", text: "The test races the session cookie.", conversationId: "0", durationMs: 4200 },
  ],
  approvals: [],
  busy: false,
  activity: "idle",
  queue: [],
};

const opus = { provider: "anthropic", modelId: "claude-opus", name: "Claude Opus", reasoning: true, thinkingLevels: ["off", "low", "high", "xhigh"] };
const twoModels = { [`GET ${ORIGIN}/api/workspaces/w1/connectors`]: { body: { connectors: [{ ...host, models: [...host.models, opus] }] } } };

type Requests = { requests(): { method: string; url: string; body?: string | null }[] };
const sent = (app: Requests, method: string, path: string) => app.requests().filter(item => item.method === method && item.url === `${ORIGIN}${path}`);
const bodyOf = (app: Requests, method: string, path: string) => {
  const request = sent(app, method, path).at(-1);
  return request?.body ? JSON.parse(request.body) : undefined;
};

const desktop = async (overrides: Record<string, unknown> = {}) => {
  const app = await open("../App.tsx", { storage: signedIn, platform: "macos", width: 1200, height: 800, network: server({
    [`GET ${ORIGIN}/api/sessions/s1/view`]: { body: { view: idle, revision: "r1" } },
    ...overrides,
  }) });
  await app.press("id:session-row-s1");
  await app.waitFor("id:chat-model");
  return app;
};

const offered = (app: { shows(selector: string): boolean }) =>
  ["model", "thinking", "name", "new", "clone", "copy", "session", "settings"].filter(name => app.shows(`id:composer-suggestion-${name}`));

describe("the chat box's slash commands", () => {
  test("a slash lists the commands, what follows narrows them, and Escape closes the list", async () => {
    const app = await desktop();
    expect(app.shows("id:composer-suggestions")).toBe(false);
    await app.type("id:composer-input", "/");
    await app.waitFor("id:composer-suggestions");
    expect(offered(app)).toEqual(["model", "thinking", "name", "new", "clone", "copy", "session", "settings"]);
    expect(app.texts()).toContain("/model [provider/model]");
    expect(app.texts()).toContain("Choose the model for your next messages");
    await app.type("id:composer-input", "s");
    await app.waitFor("id:composer-suggestion-name", { state: "gone" });
    expect(offered(app)).toEqual(["session", "settings"]);
    await app.keyboard.press("escape");
    await app.waitFor("id:composer-suggestions", { state: "gone" });
    expect(app.value("id:composer-input")).toBe("/s");
    await app.type("id:composer-input", "e");
    await app.waitFor("id:composer-suggestions");
    expect(offered(app)).toEqual(["session", "settings"]);
    expect(sent(app, "POST", "/api/sessions/s1/submit")).toHaveLength(0);
  });

  test("the list goes away once the text is no command", async () => {
    const app = await desktop();
    await app.type("id:composer-input", "/usr");
    expect(app.shows("id:composer-suggestions")).toBe(false);
    await app.clear("id:composer-input");
    await app.type("id:composer-input", "see /");
    expect(app.shows("id:composer-suggestions")).toBe(false);
  });

  test("Return completes /model to the host's models, and choosing one sets it for the next message", async () => {
    const app = await desktop(twoModels);
    await app.type("id:composer-input", "/mo");
    await app.waitFor("id:composer-suggestion-model");
    await app.submit("id:composer-input");
    await app.waitUntil(() => app.value("id:composer-input") === "/model ");
    await app.waitFor("id:composer-suggestion-anthropic/claude-opus");
    expect(app.shows("id:composer-suggestion-anthropic/claude-sonnet")).toBe(true);
    await app.type("id:composer-input", "opus");
    await app.waitFor("id:composer-suggestion-anthropic/claude-sonnet", { state: "gone" });
    await app.submit("id:composer-input");
    await app.waitFor("text:Model set to Claude Opus, from your next message.");
    expect(app.value("id:composer-input")).toBe("");
    expect(app.texts()).toContain("Claude Opus");
    expect(sent(app, "POST", "/api/sessions/s1/submit")).toHaveLength(0);
    await app.type("id:composer-input", "Carry on");
    await app.submit("id:composer-input");
    await app.waitUntil(() => bodyOf(app, "POST", "/api/sessions/s1/submit") !== undefined);
    expect(bodyOf(app, "POST", "/api/sessions/s1/submit")).toMatchObject({ content: "Carry on", options: { model: { provider: "anthropic", modelId: "claude-opus" } } });
  });

  test("the arrow keys move through the list, and Tab completes without running", async () => {
    const app = await desktop(twoModels);
    await app.type("id:composer-input", "/model ");
    await app.waitFor("id:composer-suggestion-anthropic/claude-opus");
    await app.keyboard.press("down");
    await app.keyboard.press("tab");
    await app.waitUntil(() => app.value("id:composer-input") === "/model anthropic/claude-opus");
    expect(app.texts().join(" ")).not.toContain("Model set to");
    await app.clear("id:composer-input");
    await app.type("id:composer-input", "/model ");
    await app.waitFor("id:composer-suggestion-anthropic/claude-opus");
    await app.keyboard.press("up");
    await app.submit("id:composer-input");
    await app.waitFor("text:Model set to Claude Opus, from your next message.");
  });

  test("/model says when no model, or more than one, matches, and keeps what was typed", async () => {
    const app = await desktop(twoModels);
    await app.type("id:composer-input", "/model llama");
    await app.submit("id:composer-input");
    await app.waitFor("text:This session's host offers no model matching \"llama\".");
    expect(app.value("id:composer-input")).toBe("/model llama");
    await app.clear("id:composer-input");
    await app.type("id:composer-input", "/model claude");
    await app.keyboard.press("escape");
    await app.submit("id:composer-input");
    await app.waitFor("text:\"claude\" matches 2 models (anthropic/claude-sonnet, anthropic/claude-opus). Type more of its name.");
    expect(sent(app, "POST", "/api/sessions/s1/submit")).toHaveLength(0);
  });

  test("/thinking sets the reasoning level of the next message, among those the model offers", async () => {
    const app = await desktop();
    await app.type("id:composer-input", "/thinking ");
    await app.waitFor("id:composer-suggestion-high");
    expect(["off", "low", "medium", "high", "xhigh"].filter(level => app.shows(`id:composer-suggestion-${level}`))).toEqual(["off", "low", "medium", "high"]);
    await app.type("id:composer-input", "max");
    await app.submit("id:composer-input");
    await app.waitFor("text:Claude Sonnet has no \"max\" reasoning level. It offers: off, low, medium, high.");
    await app.clear("id:composer-input");
    await app.type("id:composer-input", "/thinking hi");
    await app.submit("id:composer-input");
    await app.waitFor("text:Reasoning set to High, from your next message.");
    await app.type("id:composer-input", "Carry on");
    await app.submit("id:composer-input");
    await app.waitUntil(() => bodyOf(app, "POST", "/api/sessions/s1/submit") !== undefined);
    expect(bodyOf(app, "POST", "/api/sessions/s1/submit").options).toMatchObject({ thinkingLevel: "high" });
  });

  test("/name renames the session, or opens the rename sheet without a title", async () => {
    const app = await desktop();
    await app.type("id:composer-input", "/name Fix the login race");
    await app.submit("id:composer-input");
    await app.waitFor("text:Session renamed");
    expect(bodyOf(app, "PATCH", "/api/sessions/s1")).toEqual({ title: "Fix the login race" });
    expect(app.value("id:composer-input")).toBe("");
    await app.type("id:composer-input", "/na");
    await app.keyboard.press("tab");
    await app.waitUntil(() => app.value("id:composer-input") === "/name ");
    expect(app.shows("id:rename-title")).toBe(false);
    await app.clear("id:composer-input");
    await app.type("id:composer-input", "/na");
    await app.submit("id:composer-input");
    await app.waitFor("id:rename-title");
    expect(app.value("id:composer-input")).toBe("");
    expect(sent(app, "PATCH", "/api/sessions/s1")).toHaveLength(1);
  });

  test("/copy copies the agent's latest reply", async () => {
    const app = await desktop();
    await app.type("id:composer-input", "/copy");
    await app.submit("id:composer-input");
    await app.waitFor("text:Reply copied");
    expect(app.clipboard()).toBe("The test races the session cookie.");
    expect(app.value("id:composer-input")).toBe("");
  });

  test("/clone forks a new session from the agent's latest reply, once confirmed", async () => {
    const app = await desktop({ [`POST ${ORIGIN}/api/sessions/s1/fork`]: { body: { session: { ...sessionRecord, id: "s3", title: "Fork: Fix the flaky login test" } } } });
    app.onDialog(dialog => (dialog.title === "Fork a new session from here?" ? "Fork session" : null));
    await app.type("id:composer-input", "/clone");
    await app.submit("id:composer-input");
    await app.waitUntil(() => bodyOf(app, "POST", "/api/sessions/s1/fork") !== undefined);
    expect(bodyOf(app, "POST", "/api/sessions/s1/fork")).toEqual({ entryId: "0:2" });
    expect(app.dialogs().at(-1)?.message).toContain("up to the agent's latest finished reply");
  });

  test("/session opens the session's details, /settings the settings, and /new a new session", async () => {
    const app = await desktop();
    await app.type("id:composer-input", "/session");
    await app.submit("id:composer-input");
    await app.waitFor("id:session-panel");
    await app.press("id:session-panel-close");
    await app.type("id:composer-input", "/new");
    await app.submit("id:composer-input");
    await app.waitFor("text:What should we work on?");
    await app.press("id:session-row-s1");
    await app.waitFor("id:chat-model");
    await app.type("id:composer-input", "/settings");
    await app.submit("id:composer-input");
    await app.waitFor("id:settings-sections");
    expect(sent(app, "POST", "/api/sessions/s1/submit")).toHaveLength(0);
  });

  test("text that starts with a slash but names no command is sent as a message", async () => {
    const app = await desktop();
    await app.type("id:composer-input", "/usr/local/bin is missing from PATH");
    await app.submit("id:composer-input");
    await app.waitUntil(() => bodyOf(app, "POST", "/api/sessions/s1/submit") !== undefined);
    expect(bodyOf(app, "POST", "/api/sessions/s1/submit").content).toBe("/usr/local/bin is missing from PATH");
    await app.waitUntil(() => app.value("id:composer-input") === "");
    await app.type("id:composer-input", " /copy");
    await app.press("id:composer-send");
    await app.waitUntil(() => sent(app, "POST", "/api/sessions/s1/submit").length === 2);
    expect(bodyOf(app, "POST", "/api/sessions/s1/submit").content).toBe(" /copy");
  });

  test("a collaborator is offered neither /name nor /clone, and is told why when they type one", async () => {
    const app = await desktop({ [`GET ${ORIGIN}/api/sessions/s1`]: { body: { session: { ...sessionRecord, ownerId: "u2", permissions: ["read", "ask", "write"], viewable: true } } },
      [`GET ${ORIGIN}/api/workspaces`]: { body: { workspaces: [{ id: "w1", name: "Analytical Engine", ownerId: "u2", role: "member" }] } } });
    await app.type("id:composer-input", "/");
    await app.waitFor("id:composer-suggestions");
    expect(offered(app)).toEqual(["model", "thinking", "new", "copy", "session", "settings"]);
    await app.type("id:composer-input", "name Mine now");
    await app.submit("id:composer-input");
    await app.waitFor("text:Only the session's owner, or the workspace's owner or an admin, can rename it.");
    expect(sent(app, "PATCH", "/api/sessions/s1")).toHaveLength(0);
    expect(app.value("id:composer-input")).toBe("/name Mine now");
  });

  test("on a phone, a command is chosen by pressing it", async () => {
    const app = await open("../App.tsx", { storage: signedIn, platform: "ios", network: server({
      [`GET ${ORIGIN}/api/sessions/s1/view`]: { body: { view: idle, revision: "r1" } },
    }) });
    await app.press("id:session-row-s1");
    await app.waitFor("id:chat-model");
    await app.type("id:composer-input", "/");
    await app.waitFor("id:composer-suggestion-thinking");
    expect(app.shows("id:composer-suggestions-hint")).toBe(false);
    await app.press("id:composer-suggestion-thinking");
    await app.waitUntil(() => app.value("id:composer-input") === "/thinking ");
    await app.press("id:composer-suggestion-low");
    await app.waitFor("text:Reasoning set to Low, from your next message.");
    expect(app.value("id:composer-input")).toBe("");
  });
});
