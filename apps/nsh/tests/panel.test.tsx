import { openSudoPassword, sudoSealKeys, type SealedSudoPassword } from "../../../packages/shared/src/sudo-seal";
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

  test("Details shows what the session cost, its tokens, and how well its prompt cache works", async () => {
    const app = await openPanel();
    await app.waitFor("id:panel-usage");
    await app.waitFor("text:$1.84");
    expect(app.shows("text:363K tokens in, 310K of them from the cache, 8.9K out")).toBe(true);
    expect(app.shows("text:97% of the last request's prompt · 85% of all prompts")).toBe(true);
    expect(app.shows("text:anthropic/claude-sonnet")).toBe(false);
  });

  test("Details shows each model's cost, and the tools', once the session used more than one", async () => {
    const sonnet = { model: "anthropic/claude-sonnet", input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, cost: 2.5 };
    const haiku = { model: "anthropic/claude-haiku", input: 500, output: 100, cacheRead: 1500, cacheWrite: 0, cost: 0.004 };
    const tools = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    const usage = { total: { input: 1500, output: 300, cacheRead: 1500, cacheWrite: 0, cost: 2.504 }, models: [sonnet, haiku], tools };
    const app = await openPanel({ [`GET ${ORIGIN}/api/sessions/s1/view`]: { body: { view: { ...view, usage }, revision: "r1" } } });
    await app.waitFor("text:anthropic/claude-haiku");
    expect(app.shows("text:$2.50")).toBe(true);
    expect(app.shows("text:<$0.01")).toBe(true);
    expect(app.shows("text:Tools")).toBe(true);
    expect(app.shows("text:$0.00")).toBe(true);
    expect(app.shows("text:50% of all prompts")).toBe(true);
  });

  test("Details shows what the session uses of its host's CPU, memory, disk and GPU, and nothing from a host that doesn't say", async () => {
    const MiB = 1024 * 1024;
    const resources = { sampledAt: new Date().toISOString(), source: "cgroup", processes: 3, cpuSeconds: 125, cpuCores: 1.5, memoryBytes: 512 * MiB,
      peakMemoryBytes: 1536 * MiB, limits: { cpuCores: 2, memoryBytes: 4096 * MiB }, diskBytes: 2560 * MiB, gpuMemoryBytes: 300 * MiB };
    const app = await openPanel({ [`GET ${ORIGIN}/api/sessions/s1/resources`]: { body: { resources } } });
    await app.waitFor("id:panel-resources");
    for (const text of ["1.5 CPUs in use of 2 CPUs it may use", "2.1 min of CPU time since the session opened on its host", "512 MB memory of 4 GB it may use",
      "At most 1.5 GB since the session opened on its host", "3 processes running", "300 MB GPU memory", "2.5 GB on disk"]) expect(app.shows(`text:${text}`)).toBe(true);
    app.dispose();
    const older = await openPanel({ [`GET ${ORIGIN}/api/sessions/s1/resources`]: { body: { resources: null } } });
    await older.waitFor("id:panel-usage");
    expect(older.shows("id:panel-resources")).toBe(false);
    older.dispose();
    const invalid = await openPanel({ [`GET ${ORIGIN}/api/sessions/s1/resources`]: { body: { resources: { ...resources, processes: -1 } } } });
    await invalid.waitFor("id:panel-usage");
    expect(invalid.shows("id:panel-resources")).toBe(false);
  });

  test("Details says when no prompt tokens are reported yet", async () => {
    const none = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    const app = await openPanel({ [`GET ${ORIGIN}/api/sessions/s1/view`]: { body: { view: { ...view, usage: { total: none, models: [{ model: "faux/faux-1", ...none }] } }, revision: "r1" } } });
    await app.waitFor("text:No prompt tokens reported yet");
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
    expect(bodyOf(app, "POST", `${ORIGIN}/api/sessions`)).toEqual({ workspaceId: "w0", modelId: "m0", title: "Install pnpm and yarn on ada-mac", hostEnvironment: true });
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
    expect(bodyOf(app, "POST", `${ORIGIN}/api/sessions`)).toEqual({ workspaceId: "w0", modelId: "m0", title: "Install pnpm on ada-mac" });
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

  test("Artifacts lists what the agent published and shows each version, sanitized", async () => {
    const info = { kind: "markdown", title: "Release notes", size: 40, createdAt: "2026-11-06T09:00:00.000Z" };
    const app = await openPanel({
      [`GET ${ORIGIN}/api/sessions/s1/artifacts`]: { body: { artifacts: [{ name: "notes", versions: [{ ...info, version: 1, kind: "text", title: "Draft" }, { ...info, version: 2 }] }] } },
      [`GET ${ORIGIN}/api/sessions/s1/artifacts?name=notes&version=2`]: { body: { artifact: { name: "notes", ...info, version: 2,
        content: "# Shipped\n\nThe login fix.\n\n<script>alert(1)</script>\n\n![tracker](https://tracker.example/pixel.png)" } } },
      [`GET ${ORIGIN}/api/sessions/s1/artifacts?name=notes&version=1`]: { body: { artifact: { name: "notes", ...info, version: 1, kind: "text", title: "Draft", content: "plain draft text" } } },
    });
    await app.press("text:Artifacts");
    await app.waitFor("id:artifact-notes");
    await app.press("id:artifact-notes");
    await app.waitFor("text:Version 2 of 2");
    await app.waitFor("text:The login fix.");
    expect(app.texts().join(" ")).toContain("<script>alert(1)</script>");
    await app.waitFor("text:[image: tracker]");
    await app.press("label:Earlier version");
    await app.waitFor("text:Version 1 of 2");
    await app.waitFor("text:plain draft text");
    await app.press("text:All artifacts");
    await app.waitFor("id:artifact-notes");
  });

  test("a published artifact is a card in the transcript that shows it in a sandboxed frame", async () => {
    const entries = [
      { id: "0:1", kind: "message", role: "assistant", text: 'publish_artifact({"name":"chart","kind":"svg","content":"<svg/>","title":"Sales chart"})',
        toolCalls: [{ id: "c1", name: "publish_artifact" }], conversationId: "0" },
      { id: "0:2", kind: "message", role: "toolResult", text: "Published artifact chart version 1 (svg).\nTitle: Sales chart\nPeople see it in the transcript and in the session panel's Artifacts tab.",
        toolResult: { tool: "publish_artifact", callId: "c1" }, conversationId: "0" },
    ];
    const app = await open("../App.tsx", { network: server({
      [`GET ${ORIGIN}/api/sessions/s1/view`]: { body: { view: { ...view, entries, approvals: [], busy: false, queue: [] }, revision: "r1" } },
      [`GET ${ORIGIN}/api/sessions/s1/artifacts?name=chart&version=1`]: { body: { artifact: { name: "chart", version: 1, kind: "svg", title: "Sales chart", size: 6,
        createdAt: "2026-11-06T09:00:00.000Z", content: "<svg/>" } } },
    }), storage: signedIn, platform: "macos", width: 1280, height: 820 });
    await app.press("id:session-row-s1");
    await app.waitFor("id:artifact-card-chart-1");
    expect(app.shows("text:Sales chart")).toBe(true);
    await app.press("text:Show");
    await app.waitFor("id:artifact-frame");
    expect(app.requests().some(item => item.url === `${ORIGIN}/api/sessions/s1/artifacts?name=chart&version=1`)).toBe(true);
  });

  test("an image the agent shows with show_image is in the chat at once, while a read's image stays folded into its tool row", async () => {
    const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const call = (tool: string, id: string) => [
      { id: `0:${id}a`, kind: "message", role: "assistant", text: `${tool}({"path":"art/lighthouse.png"})`, toolCalls: [{ id, name: tool }], conversationId: "0" },
      { id: `0:${id}b`, kind: "message", role: "toolResult", text: `${tool === "show_image" ? "Shown in the chat: art/lighthouse.png" : "Read image file"} [image/png]\n[image image/png]`,
        images: [{ mimeType: "image/png" }], toolResult: { tool, callId: id }, conversationId: "0" },
    ];
    const thumbnail = (entry: string) => ({ [`GET ${ORIGIN}/api/sessions/s1/images?entry=${encodeURIComponent(entry)}&index=0&size=thumbnail`]: { body: { image: { mimeType: "image/png", data: pixel } } } });
    const shown = await open("../App.tsx", { network: server({
      [`GET ${ORIGIN}/api/sessions/s1/view`]: { body: { view: { ...view, entries: call("show_image", "c1"), approvals: [], busy: false, queue: [] }, revision: "r1" } },
      ...thumbnail("0:c1b"),
    }), storage: signedIn, platform: "macos", width: 1280, height: 820 });
    await shown.press("id:session-row-s1");
    await shown.waitFor("label:Image 1 (image/png): show it whole");
    expect(shown.requests().some(item => item.url === `${ORIGIN}/api/sessions/s1/images?entry=0%3Ac1b&index=0&size=thumbnail`)).toBe(true);
    shown.dispose();
    const read = await open("../App.tsx", { network: server({
      [`GET ${ORIGIN}/api/sessions/s1/view`]: { body: { view: { ...view, entries: call("read", "c2"), approvals: [], busy: false, queue: [] }, revision: "r1" } },
      ...thumbnail("0:c2b"),
    }), storage: signedIn, platform: "macos", width: 1280, height: 820 });
    await read.press("id:session-row-s1");
    let row: string | undefined;
    for (let tries = 0; !row && tries < 200; tries++) {
      row = read.texts().find(item => item.startsWith("read · art/lighthouse.png"));
      if (!row) await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(row).toBeDefined();
    expect(read.shows("label:Image 1 (image/png): show it whole")).toBe(false);
    await read.press(`text:${row}`);
    await read.waitFor("label:Image 1 (image/png): show it whole");
  });

  test("a reply's Markdown images of worktree files show in the chat: a video in its player, audio in one the app plays, through signed links", async () => {
    const reply = { id: "0:m1", kind: "message", role: "assistant", conversationId: "0",
      text: "Here is the demo:\n\n![Demo run](out/demo.mp4)\n\n![Theme](out/theme.mp3)\n\n![Elsewhere](../outside.mp4)" };
    const link = (path: string, kind: string, mimeType: string) => ({ body: { media: { url: `/api/media/token-${kind}`, path, kind, mimeType, expiresAt: Date.now() + 3600000 } } });
    const app = await open("../App.tsx", { network: server({
      [`GET ${ORIGIN}/api/sessions/s1/view`]: { body: { view: { ...view, entries: [reply], approvals: [], busy: false, queue: [] }, revision: "r1" } },
      [`POST ${ORIGIN}/api/sessions/s1/media`]: (request: { body?: string | null }) =>
        JSON.parse(request.body ?? "{}").path === "out/demo.mp4" ? link("out/demo.mp4", "video", "video/mp4") : link("out/theme.mp3", "audio", "audio/mpeg"),
    }), storage: signedIn, platform: "macos", width: 1280, height: 820 });
    await app.press("id:session-row-s1");
    await app.waitFor("id:media-video");
    await app.waitFor("id:media-audio");
    const asked = app.requests().filter(item => item.method === "POST" && item.url === `${ORIGIN}/api/sessions/s1/media`).map(item => JSON.parse(item.body ?? "{}").path).sort();
    expect(asked).toEqual(["out/demo.mp4", "out/theme.mp3"]);
    expect(app.shows("text:Demo run")).toBe(true);
    expect(app.shows("text:[image: Elsewhere]")).toBe(true);
    await app.press("label:Play Theme");
    await app.waitFor("label:Pause Theme");
    const audio = app.audio();
    expect(audio.some(call => call.command === "open" && call.src === `${ORIGIN}/api/media/token-audio`)).toBe(true);
    expect(audio.some(call => call.command === "resume")).toBe(true);
    await app.press("label:Pause Theme");
    await app.waitFor("label:Play Theme");
    expect(app.audio().some(call => call.command === "pause")).toBe(true);
  });

  test("a viewer sees a reply's worktree media as its path, without asking for a link", async () => {
    const reply = { id: "0:m2", kind: "message", role: "assistant", conversationId: "0", text: "![Demo run](out/demo.mp4)" };
    const app = await open("../App.tsx", { network: server({
      [`GET ${ORIGIN}/api/sessions`]: { body: { sessions: [{ ...sessionRecord, permissions: ["read"] }] } },
      [`GET ${ORIGIN}/api/sessions/s1`]: { body: { session: { ...sessionRecord, permissions: ["read"], viewable: true } } },
      [`GET ${ORIGIN}/api/sessions/s1/view`]: { body: { view: { ...view, entries: [reply], approvals: [], busy: false, queue: [] }, revision: "r1" } },
    }), storage: signedIn, platform: "macos", width: 1280, height: 820 });
    await app.press("id:session-row-s1");
    await app.waitFor("text:out/demo.mp4");
    expect(app.shows("text:Video in the session's worktree")).toBe(true);
    expect(app.requests().some(item => item.url.endsWith("/media"))).toBe(false);
  });

  test("Artifacts says when there are none, and when the host is too old to show them", async () => {
    const none = await openPanel({ [`GET ${ORIGIN}/api/sessions/s1/artifacts`]: { body: { artifacts: [] } } });
    await none.press("text:Artifacts");
    await none.waitFor("text:No artifacts yet");
    none.dispose();
    const old = await openPanel({ [`GET ${ORIGIN}/api/sessions/s1/artifacts`]: { status: 409, body: { error: "This session's host can't show artifacts yet. Its owner can update the pikibun connector there.", code: "artifacts_unsupported" } } });
    await old.press("text:Artifacts");
    await old.waitFor("text:This session's host can't show artifacts yet. Its owner can update the pikibun connector there.");
  });

  test("App shows the session's app through its tunnel's link, live, opens it in the browser, and says how to get one when nothing is online", async () => {
    const link = "https://quiet-river.trycloudflare.com/?pikibun_tunnel=abcdefghijklmnopqrstuvwxyz012345";
    const tunnel = { url: link, access: "link", startedBy: "u1", startedAt: "2026-11-22T09:00:00.000Z", expiresAt: "2026-11-22T13:00:00.000Z",
      command: "python3 desktop.py", port: 6080, connected: true };
    const app = await openPanel({ [`GET ${ORIGIN}/api/sessions/s1/view`]: { body: { view: { ...view, tunnel }, revision: "r1" } } });
    await app.press("text:App");
    await app.waitFor("id:app-frame");
    expect(app.shows("text:quiet-river.trycloudflare.com")).toBe(true);
    expect(app.shows("text:Online")).toBe(true);
    expect(app.shows("text:python3 desktop.py on port 6080, in the session's sandbox. Anyone with its link can use it too.")).toBe(true);
    await app.press("id:app-open");
    expect(app.openedUrls()).toContain(link);
    await app.press("id:app-reload");
    await app.waitFor("id:app-frame");
    await app.press("id:app-expand");
    await app.waitFor("label:Back to the side panel");
    expect(app.shows("text:python3 desktop.py on port 6080, in the session's sandbox. Anyone with its link can use it too.")).toBe(false);
    app.dispose();

    const elsewhere = await openPanel({ [`GET ${ORIGIN}/api/sessions/s1/view`]: { body: { view: { ...view, tunnel: { ...tunnel, url: "https://evil.example/?pikibun_tunnel=x" } }, revision: "r1" } } });
    await elsewhere.press("text:App");
    await elsewhere.waitFor("id:app-unavailable");
    expect(elsewhere.shows("id:app-frame")).toBe(false);
    elsewhere.dispose();

    const none = await openPanel();
    await none.press("text:App");
    await none.waitFor("text:Nothing online");
    expect(none.shows("id:app-frame")).toBe(false);
  });

  test("App is the session's collaborators': a viewer sees that the app is online, at its bare address, and neither frames nor opens it", async () => {
    const address = "https://quiet-river.trycloudflare.com";
    const tunnel = { url: address, access: "link", startedBy: "u1", startedAt: "2026-11-22T09:00:00.000Z", expiresAt: "2026-11-22T13:00:00.000Z",
      command: "python3 desktop.py", port: 6080, connected: true };
    const reader = { [`GET ${ORIGIN}/api/sessions/s1`]: { body: { session: { ...sessionRecord, ownerId: "u2", permissions: ["read"], viewable: true } } } };
    const app = await openPanel({ ...reader, [`GET ${ORIGIN}/api/sessions/s1/view`]: { body: { view: { ...view, tunnel }, revision: "r1" } } });
    await app.waitFor("text:quiet-river.trycloudflare.com");
    await app.waitFor("text:Opening it takes its link, which the session's collaborators get. Viewers see that it is online.");
    expect(app.shows("text:Online")).toBe(true);
    expect(app.shows("text:Public address")).toBe(false);
    expect(app.shows("label:Open")).toBe(false);
    expect(app.shows("label:Stop")).toBe(false);
    await app.press("text:App");
    await app.waitFor("text:App unavailable");
    expect(app.shows("id:app-frame")).toBe(false);
    expect(app.shows("id:app-open")).toBe(false);
    expect(app.openedUrls()).toEqual([]);
    app.dispose();

    const idle = await openPanel(reader);
    await idle.press("text:App");
    await idle.waitFor("text:App unavailable");
    expect(idle.shows("text:Nothing online")).toBe(false);
    idle.dispose();

    const link = `${address}/?pikibun_tunnel=abcdefghijklmnopqrstuvwxyz012345`;
    const writer = await openPanel({ [`GET ${ORIGIN}/api/sessions/s1/view`]: { body: { view: { ...view, tunnel: { ...tunnel, url: link } }, revision: "r1" } } });
    await writer.waitFor("text:Public address");
    expect(writer.shows("label:Open")).toBe(true);
    expect(writer.shows("label:Stop")).toBe(true);
    writer.dispose();

    const withheld = await openPanel({ [`GET ${ORIGIN}/api/sessions/s1/view`]: { body: { view: { ...view, tunnel }, revision: "r1" } } });
    await withheld.press("text:App");
    await withheld.waitFor("text:App unavailable");
    expect(withheld.shows("id:app-frame")).toBe(false);
    withheld.dispose();

    const open = await openPanel({ ...reader, [`GET ${ORIGIN}/api/sessions/s1/view`]: { body: { view: { ...view, tunnel: { ...tunnel, access: "public" } }, revision: "r1" } } });
    await open.waitFor("text:Public address");
    expect(open.shows("label:Open")).toBe(true);
  });

  test("Schedules lists the schedules made in the session, which belong to the workspace, and opens the workspace's", async () => {
    const models = [{ id: "m2", name: "Claude Opus", provider: "anthropic", modelId: "claude-opus", thinkingLevels: ["off", "low", "high"] }];
    const schedule = { id: "sc1", workspaceId: "w1", sessionId: null, originSessionId: "s1", ownerId: "u1", name: "Review", cron: "0 9 * * 1", timeZone: "UTC",
      content: "Review the architecture", access: "auto", runIn: "child", oneShot: true, modelId: "m2", thinkingLevel: "high", enabled: true, nextRunAt: null,
      lastRunAt: "2026-11-16T09:00:00.000Z", lastSubmissionId: "sub1", lastSessionId: "s2", lastError: "model_unavailable", createdBy: "u1",
      createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", canManage: true };
    const app = await openPanel({
      [`GET ${ORIGIN}/api/sessions/s1/schedules`]: { body: { schedules: [schedule], canManage: true, canCreate: true, models, childModels: true } },
      [`PATCH ${ORIGIN}/api/sessions/s1/schedules/sc1`]: { body: { schedule } },
    });
    await app.press("text:Schedules");
    await app.waitFor("id:schedules-made-here");
    await app.waitFor("id:schedule-sc1");
    expect(app.texts().join(" ")).toContain("on Claude Opus, High reasoning");
    expect(app.texts().join(" ")).toContain("the schedule's model is no longer available");
    expect(app.texts().join(" ")).toContain("No scheduled prompts");

    await app.press("text:Pause");
    await app.waitUntil(() => Boolean(bodyOf(app, "PATCH", `${ORIGIN}/api/sessions/s1/schedules/sc1`)));
    expect(bodyOf(app, "PATCH", `${ORIGIN}/api/sessions/s1/schedules/sc1`)).toEqual({ enabled: false });

    await app.press("text:Edit");
    await app.waitFor("id:workspace-schedules");
    expect(app.shows("id:schedule-form")).toBe(false);
  });

  test("Schedules offers no choice of where a run goes: a new session each run is the workspace's", async () => {
    const app = await openPanel();
    await app.press("text:Schedules");
    await app.waitFor("id:schedule-new");
    await app.press("id:schedule-new");
    await app.waitFor("id:schedule-content");
    expect(app.shows("id:schedule-run-in")).toBe(false);
    expect(app.shows("id:schedule-model")).toBe(false);
  });

  test("Activity shows the audit log", async () => {
    const app = await openPanel();
    await app.press("text:Activity");
    await app.waitFor("text:session.create");
  });
});

describe("sudo's password box", () => {
  const prompt = { id: "prompt1", prompt: "[sudo] password for ada:", command: "python3 -c 'sudo -A apt-get install -y make'",
    requestedAt: "2026-11-06T09:10:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" };
  const open_ = (routes: Parameters<typeof server>[0]) => open("../App.tsx", { network: server({
    [`GET ${ORIGIN}/api/sessions/s1/view`]: { body: { view: { ...view, sudo: prompt }, revision: "r1" } },
    [`POST ${ORIGIN}/api/sessions/s1/sudo`]: { body: { answered: true } },
    ...routes,
  }), storage: signedIn, platform: "macos", width: 1280, height: 820 });

  test("in the private workspace, takes the host owner's password apart from the chat box, sends it to that sudo alone and clears it", async () => {
    const app = await open_({ [`GET ${ORIGIN}/api/workspaces`]: { body: { workspaces: [{ ...workspace, personal: true }] } } });
    await app.press("id:session-row-s1");
    await app.waitFor("id:sudo-prompt");
    expect(app.shows("text:sudo asks for your password on ada-mac")).toBe(true);
    expect(app.shows("text:sudo's prompt: “[sudo] password for ada:”, while this command ran:")).toBe(true);
    expect(app.shows("text:python3 -c 'sudo -A apt-get install -y make'")).toBe(true);
    await app.type("id:sudo-password", "hunter2");
    expect(app.value("id:composer-input")).toBe("");
    await app.press("id:sudo-send");
    await app.waitUntil(() => Boolean(bodyOf(app, "POST", `${ORIGIN}/api/sessions/s1/sudo`)));
    expect(bodyOf(app, "POST", `${ORIGIN}/api/sessions/s1/sudo`)).toEqual({ id: "prompt1", password: "hunter2" });
    expect(app.value("id:sudo-password")).toBe("");
    expect(app.requests().some(request => request.url.endsWith("/submit") && (request.body ?? "").includes("hunter2"))).toBe(false);
  });

  test("where the host gave a key, the password is sealed to it, so the server never reads it", async () => {
    const host = await sudoSealKeys();
    const app = await open("../App.tsx", { network: server({
      [`GET ${ORIGIN}/api/sessions/s1/view`]: { body: { view: { ...view, sudo: { ...prompt, key: host.publicKey } }, revision: "r1" } },
      [`POST ${ORIGIN}/api/sessions/s1/sudo`]: { body: { answered: true } },
      [`GET ${ORIGIN}/api/workspaces`]: { body: { workspaces: [{ ...workspace, personal: true }] } },
    }), storage: signedIn, platform: "macos", width: 1280, height: 820 });
    await app.press("id:session-row-s1");
    await app.waitFor("id:sudo-prompt");
    await app.type("id:sudo-password", "hunter2");
    await app.press("id:sudo-send");
    await app.waitUntil(() => Boolean(bodyOf(app, "POST", `${ORIGIN}/api/sessions/s1/sudo`)));
    const sent = bodyOf(app, "POST", `${ORIGIN}/api/sessions/s1/sudo`) as { id: string; sealed: SealedSudoPassword; password?: string };
    expect(sent.password).toBe(undefined);
    expect(JSON.stringify(sent).includes("hunter2")).toBe(false);
    expect(await openSudoPassword(host.privateKey, "prompt1", sent.sealed)).toBe("hunter2");
  });

  test("outside the private workspace, the host's owner can only decline, and anyone else only sees that sudo waits", async () => {
    const app = await open_({});
    await app.press("id:session-row-s1");
    await app.waitFor("id:sudo-prompt");
    expect(app.shows("id:sudo-password")).toBe(false);
    await app.press("id:sudo-decline");
    await app.waitUntil(() => Boolean(bodyOf(app, "POST", `${ORIGIN}/api/sessions/s1/sudo`)));
    expect(bodyOf(app, "POST", `${ORIGIN}/api/sessions/s1/sudo`)).toEqual({ id: "prompt1", decline: true });
    app.dispose();
    const viewer = await open_({ [`GET ${ORIGIN}/api/sessions/s1`]: { body: { session: { ...sessionRecord, ownerId: "u2", connectorOwnerId: "u2", viewable: true } } } });
    await viewer.press("id:session-row-s1");
    await viewer.waitFor("id:sudo-prompt");
    expect(viewer.shows("text:sudo asks for the host owner's password on ada-mac")).toBe(true);
    expect(viewer.shows("id:sudo-password")).toBe(false);
    expect(viewer.shows("id:sudo-decline")).toBe(false);
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
