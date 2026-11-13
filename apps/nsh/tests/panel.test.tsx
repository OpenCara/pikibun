import { describe, expect, open, test } from "nsh/test";
import { host, ORIGIN, server, sessionRecord, signedIn, view, workspace } from "./fixtures";

const bodyOf = (app: { requests(): { method: string; url: string; body?: string | null }[] }, method: string, url: string) => {
  const request = app.requests().find(item => item.method === method && item.url === url);
  return request?.body ? JSON.parse(request.body) : undefined;
};

async function openPanel(routes: Parameters<typeof server>[0] = {}) {
  const app = await open("../App.tsx", { network: server(routes), storage: signedIn, platform: "macos", width: 1280, height: 820 });
  await app.press("id:session-row-s1");
  await app.waitFor("id:session-details");
  await app.press("id:session-details");
  await app.waitFor("id:session-panel");
  return app;
}

describe("a session's panel", () => {
  test("Details shows the host, people, backups and access", async () => {
    const app = await openPanel();
    for (const part of ["panel-details", "session-host", "panel-people", "panel-backups", "panel-access"]) await app.waitFor(`id:${part}`);
    await app.waitFor("text:Link sharing off");
    await app.waitFor("text:Runs as Ada Lovelace (you)");
  });

  test("Details shows how full the context window is, and where Pi compacts it", async () => {
    const app = await openPanel();
    await app.waitFor("id:panel-context");
    await app.waitFor("text:84.2K of 200K tokens");
    expect(app.shows("text:42%")).toBe(true);
    expect(app.shows("text:Pi summarizes the older messages once it passes about 184K tokens")).toBe(true);
    expect(app.shows("label:Context: 84.2K of 200K tokens, 42%")).toBe(true);
  });

  test("Details says when compaction is off, and leaves the meter out without a window", async () => {
    const off = await openPanel({ [`GET ${ORIGIN}/api/sessions/s1/view`]: { body: { view: { ...view, context: { tokens: 950, window: 8192 } }, revision: "r1" } } });
    await off.waitFor("text:950 of 8.2K tokens");
    await off.waitFor("text:Compaction is off for this model on its host: a conversation that outgrows the window fails until it is shortened");
    off.dispose();
    const unknown = await openPanel({ [`GET ${ORIGIN}/api/sessions/s1/view`]: { body: { view: { ...view, context: { tokens: 1_250_000 } }, revision: "r1" } } });
    await unknown.waitFor("text:About 1.3M tokens");
    expect(unknown.shows("id:context-percent")).toBe(false);
    unknown.dispose();
    const due = await openPanel({ [`GET ${ORIGIN}/api/sessions/s1/view`]: { body: { view: { ...view, context: { tokens: 1200, window: 8192, compactsAt: 0 } }, revision: "r1" } } });
    await due.waitFor("text:Past where Pi compacts it, at about 0 tokens: Pi summarizes the older messages at its next step");
    expect(due.shows("text:15%")).toBe(true);
  });

  test("Details offers the host's owner a chat on the host, in their private workspace, that installs the programs it lacks", async () => {
    const personal = { id: "w0", name: "Private", ownerId: "u1", role: "owner", personal: true };
    const unavailable = [{ source: "piki:node", tools: ["node"], reason: "programs", programs: ["pnpm", "yarn"] }, { source: "piki:browser", tools: ["browser"], reason: "missing" },
      { source: "piki:tunnel", tools: ["tunnel"], reason: "off" }];
    const app = await openPanel({
      [`GET ${ORIGIN}/api/sessions/s1/view`]: { body: { view: { ...view, extensions: { running: [], missing: [], unavailable } }, revision: "r1" } },
      [`GET ${ORIGIN}/api/workspaces`]: { body: { workspaces: [personal, workspace] } },
      [`GET ${ORIGIN}/api/workspaces/w1/connectors`]: { body: { connectors: [{ ...host, hostSessions: true }] } },
      [`GET ${ORIGIN}/api/workspaces/w0/models`]: { body: { models: [{ id: "m0", workspaceId: "w0", name: "Claude Sonnet", connectorId: "c1", provider: "anthropic", modelId: "claude-sonnet" }] } },
    });
    await app.waitFor("text:Missing programs");
    await app.waitFor("id:install-chat-browser");
    expect(app.shows("id:install-chat-tunnel")).toBe(false);
    await app.press("id:install-chat-node");
    await app.waitUntil(() => Boolean(bodyOf(app, "POST", `${ORIGIN}/api/sessions/s3/submit`)));
    expect(bodyOf(app, "POST", `${ORIGIN}/api/sessions`)).toEqual({ workspaceId: "w0", modelId: "m0", title: "Install pnpm and yarn on ada-mac", visibility: "private", hostEnvironment: true });
    const submitted = bodyOf(app, "POST", `${ORIGIN}/api/sessions/s3/submit`);
    expect(submitted.content).toContain("Install on this host (ada-mac) the programs Pikibun's sessions on it lack: the node tool's pnpm and yarn.");
    expect(submitted.options.model).toEqual({ provider: "anthropic", modelId: "claude-sonnet" });
    await app.waitFor("text:Add a dark mode");
  });

  test("an install chat whose opening message can't be sent still opens, with the message waiting in its chat box", async () => {
    const app = await openPanel({
      [`GET ${ORIGIN}/api/sessions/s1/view`]: { body: { view: { ...view, extensions: { running: [], missing: [],
        unavailable: [{ source: "piki:node", tools: ["node"], reason: "programs", programs: ["pnpm"] }] } }, revision: "r1" } },
      [`GET ${ORIGIN}/api/workspaces`]: { body: { workspaces: [{ id: "w0", name: "Private", ownerId: "u1", role: "owner", personal: true }, workspace] } },
      [`GET ${ORIGIN}/api/workspaces/w0/models`]: { body: { models: [{ id: "m0", workspaceId: "w0", name: "Claude Sonnet", connectorId: "c1", provider: "anthropic", modelId: "claude-sonnet" }] } },
      [`POST ${ORIGIN}/api/sessions/s3/submit`]: { status: 503, body: { error: "The host is busy" } },
    });
    await app.waitFor("id:install-chat-node");
    await app.press("id:install-chat-node");
    await app.waitFor("text:Add a dark mode");
    expect(bodyOf(app, "POST", `${ORIGIN}/api/sessions`)).toEqual({ workspaceId: "w0", modelId: "m0", title: "Install pnpm on ada-mac", visibility: "private" });
    await app.waitUntil(() => (app.value("id:composer-input") ?? "").startsWith("Install on this host (ada-mac)"));
  });

  test("Details offers no install chat on someone else's host", async () => {
    const app = await openPanel({
      [`GET ${ORIGIN}/api/sessions/s1`]: { body: { session: { ...sessionRecord, connectorOwnerId: "u2", viewable: true } } },
      [`GET ${ORIGIN}/api/sessions/s1/view`]: { body: { view: { ...view, extensions: { running: [], missing: [],
        unavailable: [{ source: "piki:node", tools: ["node"], reason: "programs", programs: ["pnpm"] }] } }, revision: "r1" } },
      [`GET ${ORIGIN}/api/workspaces/w1/connectors`]: { body: { connectors: [{ ...host, ownerId: "u2", ownerName: "grace" }] } },
    });
    await app.waitFor("text:Missing programs");
    await app.waitFor("text:Hosted by grace");
    expect(app.shows("id:install-chat-node")).toBe(false);
  });

  test("Files lists the worktree and previews a file", async () => {
    const app = await openPanel();
    await app.press("text:Files");
    await app.waitFor("id:file-README.md");
    await app.press("id:file-README.md");
    await app.waitFor("id:file-text");
    expect(app.texts().join(" ")).toContain("The login test races the cookie.");
    expect(app.shows("label:README.md, markdown")).toBe(true);
    expect(app.shows("label:README.md")).toBe(true);
    const texts = app.texts();
    expect(texts.slice(texts.indexOf("# Pikibun") - 2, texts.indexOf("# Pikibun"))).toEqual(["1", "2"]);
    await app.press("id:file-back");
    await app.waitFor("id:file-src");
  });

  test("Browser says when the agent hasn't used it", async () => {
    const app = await openPanel();
    await app.press("text:Browser");
    await app.waitFor("text:No browser calls yet");
  });

  test("Schedules creates a scheduled prompt", async () => {
    const app = await openPanel();
    await app.press("text:Schedules");
    await app.waitFor("id:schedule-new");
    await app.press("id:schedule-new");
    await app.type("id:schedule-content", "Run the tests");
    await app.press("id:schedule-save");
    await app.waitUntil(() => Boolean(bodyOf(app, "POST", `${ORIGIN}/api/sessions/s1/schedules`)));
    expect(bodyOf(app, "POST", `${ORIGIN}/api/sessions/s1/schedules`)).toMatchObject({ content: "Run the tests", cron: "0 9 * * 1-5", access: "auto" });
    expect(Object.keys(bodyOf(app, "POST", `${ORIGIN}/api/sessions/s1/schedules`) as object)).not.toContain("runIn");
  });

  test("Activity shows the audit log", async () => {
    const app = await openPanel();
    await app.press("text:Activity");
    await app.waitFor("text:session.create");
  });
});

describe("a session's header menu", () => {
  test("renames the session", async () => {
    const app = await open("../App.tsx", { network: server(), storage: signedIn, platform: "macos", width: 1280, height: 820 });
    await app.press("id:session-row-s1");
    await app.waitFor("id:session-actions");
    await app.press("id:session-actions");
    await app.press("id:session-rename");
    await app.clear("id:rename-title");
    await app.type("id:rename-title", "Fix the login race");
    await app.press("id:rename-save");
    await app.waitUntil(() => Boolean(bodyOf(app, "PATCH", `${ORIGIN}/api/sessions/s1`)));
    expect(bodyOf(app, "PATCH", `${ORIGIN}/api/sessions/s1`)).toEqual({ title: "Fix the login race" });
  });
});
