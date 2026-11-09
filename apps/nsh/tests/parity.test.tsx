import { describe, expect, open, test } from "nsh/test";
import { homedir } from "os";
import { host, ORIGIN, server, sessionRecord, signedIn, view, workspace } from "./fixtures";

// What the React web client does that this client once lacked: attachments, editing queued messages, the pull request
// link and read-only notices, sessions on the host, every workspace in the sidebar, and the web's sign-in.

type Recorded = { requests(): { method: string; url: string; body?: string | null }[] };
const bodyOf = (app: Recorded, method: string, url: string) => {
  const request = app.requests().find(item => item.method === method && item.url.endsWith(url));
  return request?.body ? JSON.parse(request.body) : undefined;
};

/** A 1×1 PNG. */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** The host, able to take images and files with a message, and sessions on it. */
const capableHost = { ...host, hostSessions: true, capabilities: { ...host.capabilities, chatImages: true, fileUploads: true } };

describe("a session's view", () => {
  test("links to its pull request and says when it's read-only", async () => {
    const pull = { url: "https://github.com/OpenCara/pikibun/pull/12", number: 12, state: "open" };
    const frozen = { ...sessionRecord, frozen: true, pullRequest: pull };
    const app = await open("../App.tsx", { storage: signedIn, platform: "macos", width: 1200, height: 800, network: server({
      [`GET ${ORIGIN}/api/sessions`]: { body: { sessions: [frozen] } },
      [`GET ${ORIGIN}/api/sessions/s1`]: { body: { session: frozen } },
    }) });
    await app.press("id:session-row-s1");
    await app.waitFor("id:session-pull-request");
    expect(app.shows("text:PR #12 · Open")).toBe(true);
    await app.waitFor("id:session-frozen");
    await app.press("id:session-pull-request");
    await app.waitUntil(() => app.openedUrls().includes(pull.url));
  });

  test("takes a queued message of yours back into the chat box to edit", async () => {
    const queued = { ...view, withdrawable: true, queue: [...view.queue, { submissionId: "q5", actorId: "u1", mode: "write", status: "queued" }] };
    const app = await open("../App.tsx", { storage: signedIn, network: server({
      [`GET ${ORIGIN}/api/sessions/s1/view`]: { body: { view: queued, revision: "r1" } },
      [`POST ${ORIGIN}/api/sessions/s1/withdraw`]: { body: { content: "Also cover the logout test", mode: "write" } },
    }) });
    await app.press("id:session-row-s1");
    await app.waitFor("id:queue-line");
    await app.press("id:queue-line");
    await app.waitFor("id:queue-edit");
    await app.press("id:queue-edit");
    await app.waitUntil(() => app.value("id:composer-input") === "Also cover the logout test");
    expect(bodyOf(app, "POST", "/api/sessions/s1/withdraw")).toEqual({ submissionId: "q5" });
  });

  test("sends a picked image with a message", async () => {
    const app = await open("../App.tsx", { storage: signedIn, network: server({
      [`GET ${ORIGIN}/api/workspaces/w1/connectors`]: { body: { connectors: [capableHost] } },
    }) });
    app.onPick(() => [{ name: "screenshot.png", type: "image/png", data: PNG }]);
    await app.press("id:session-row-s1");
    await app.waitFor("id:composer-attach");
    await app.press("id:composer-attach");
    await app.waitFor("id:attachment-image-0");
    expect(app.picks()[0]).toMatchObject({ multiple: true, maxDimension: 1568 });
    await app.type("id:composer-input", "What's wrong on this page?");
    await app.press("id:composer-send");
    await app.waitUntil(() => bodyOf(app, "POST", "/api/sessions/s1/submit") !== undefined);
    const body = bodyOf(app, "POST", "/api/sessions/s1/submit");
    expect(body.content).toBe("What's wrong on this page?");
    expect(body.images).toEqual([{ mimeType: "image/png", data: base64(PNG) }]);
    await app.waitUntil(() => !app.shows("id:attachment-image-0"));
  });
});

describe("a new session", () => {
  test("runs on its host where the host takes sessions on it", async () => {
    const app = await open("../App.tsx", { storage: signedIn, network: server({
      [`GET ${ORIGIN}/api/workspaces/w1/connectors`]: { body: { connectors: [capableHost] } },
    }) });
    await app.press("id:new-session");
    await app.waitFor("id:new-environment");
    await app.press("id:new-environment");
    await app.press("text:On this host");
    await app.waitFor("id:new-on-host");
    await app.type("id:new-message", "Profile the GPU build");
    await app.waitUntil(() => app.enabled("id:new-start"));
    await app.press("id:new-start");
    await app.waitUntil(() => bodyOf(app, "POST", "/api/sessions") !== undefined);
    expect(bodyOf(app, "POST", "/api/sessions")).toMatchObject({ workspaceId: "w1", hostEnvironment: true });
  });

  test("keeps running on its host while the host listing refreshes", async () => {
    const app = await open("../App.tsx", { storage: signedIn, clock: {}, network: server({
      [`GET ${ORIGIN}/api/workspaces/w1/connectors`]: { body: { connectors: [capableHost] } },
    }) });
    await app.press("id:new-session");
    await app.waitFor("id:new-environment");
    await app.press("id:new-environment");
    await app.press("text:On this host");
    await app.waitFor("id:new-on-host");
    const polls = () => app.requests().filter(request => request.url === `${ORIGIN}/api/workspaces/w1/connectors`).length;
    const before = polls();
    // The listing is fetched again every 10 seconds, with new objects for the same host.
    await app.clock!.runFor(25_000);
    expect(polls()).toBeGreaterThan(before);
    expect(app.shows("id:new-on-host")).toBe(true);
  });

  test("keeps trusting another member's host while the host listing refreshes", async () => {
    const shared = { ...host, ownerId: "u2", ownerName: "grace", name: "grace-mac" };
    const app = await open("../App.tsx", { storage: signedIn, clock: {}, network: server({
      [`GET ${ORIGIN}/api/workspaces/w1/connectors`]: { body: { connectors: [shared] } },
    }) });
    await app.press("id:new-session");
    await app.waitFor("id:new-trust");
    await app.press("id:new-trust");
    await app.type("id:new-message", "Run the benchmarks");
    await app.waitUntil(() => app.enabled("id:new-start"));
    await app.clock!.runFor(25_000);
    expect(app.enabled("id:new-start")).toBe(true);
  });

  test("keeps its unsent first message when another page opens in between", async () => {
    const app = await open("../App.tsx", { storage: signedIn, network: server() });
    await app.press("id:new-session");
    await app.waitFor("id:new-message");
    await app.type("id:new-message", "Half a thought");
    await app.back();
    await app.waitFor("id:session-row-s1");
    await app.press("id:new-session");
    await app.waitUntil(() => app.value("id:new-message") === "Half a thought");
  });

  test("opens its host's details from the link under the chat box, and closes them again", async () => {
    const app = await open("../App.tsx", { storage: signedIn, network: server() });
    await app.press("id:new-session");
    await app.waitFor("id:new-host-details");
    expect(app.shows("id:new-host-details-panel")).toBe(false);
    await app.press("id:new-host-details");
    await app.waitFor("id:new-host-details-panel");
    await app.press("id:new-host-details");
    await app.waitUntil(() => !app.shows("id:new-host-details-panel"));
  });
});

describe("the sidebar", () => {
  test("lists every workspace, starts a session in one without any and opens a workspace's settings", async () => {
    const second = { id: "w2", name: "Difference Engine", ownerId: "u1", role: "owner" };
    const app = await open("../App.tsx", { storage: signedIn, platform: "macos", width: 1200, height: 800, network: server({
      [`GET ${ORIGIN}/api/workspaces`]: { body: { workspaces: [workspace, second] } },
      [`GET ${ORIGIN}/api/workspaces/w2/models`]: { body: { models: [] } },
      [`GET ${ORIGIN}/api/workspaces/w2/connectors`]: { body: { connectors: [] } },
      [`GET ${ORIGIN}/api/workspaces/w2/repositories`]: { body: { repositories: [], required: true, sources: 0 } },
      [`GET ${ORIGIN}/api/workspaces/w2/attachments`]: { body: { settings: { maxFileBytes: 10485760 } } },
    }) });
    await app.waitFor("id:workspace-start-w2");
    await app.press("id:workspace-start-w2");
    await app.waitFor("id:new-add-source");
    expect(app.shows("text:Difference Engine")).toBe(true);
    // The notice's words follow its reason, which changed as the listings came in.
    expect(app.texts().join(" ")).toContain("Sessions need at least one source");
    expect(app.texts().join(" ")).not.toContain("Pair your own Pi");
    await app.press("id:workspace-options-w1");
    await app.press("id:workspace-settings-w1");
    await app.waitFor("text:Analytical Engine");
    await app.waitUntil(() => app.requests().some(request => request.url === `${ORIGIN}/api/workspaces/w1/sources`));
  });

  test("with no workspace yet, the home offers to create one", async () => {
    const app = await open("../App.tsx", { storage: signedIn, platform: "macos", width: 1200, height: 800, network: server({
      [`GET ${ORIGIN}/api/workspaces`]: { body: { workspaces: [] } },
      [`GET ${ORIGIN}/api/sessions`]: { body: { sessions: [] } },
    }) });
    await app.waitFor("text:Welcome to Pikibun");
    await app.press("id:home-new-workspace");
    await app.waitFor("id:new-workspace-name");
  });
});

/** The sign-in screen as a browser's page shows it, with what the page's host answers. */
const signInPage = (options: { invite?: string; query?: string } = {}) => open("./harness/sign-in.tsx", {
  platform: "web",
  host: {
    params: options.invite ? { invite: options.invite } : {},
    handlers: { "page.route": "#/", "page.setRoute": null, "page.open": null, "page.authorize": null, "page.query": options.query ?? "" },
  },
});

describe("signing in on the web", () => {
  test("an invite link opened signed out says so, and is remembered across GitHub's sign-in", async () => {
    const app = await signInPage({ invite: "invite-token" });
    await app.waitFor("id:sign-in-invited");
    await app.waitUntil(() => (app.storage()["pikibun.pendingInvite"] ?? "").includes("invite-token"));
  });

  test("says why GitHub's sign-in didn't complete", async () => {
    const app = await signInPage({ query: "?error=That+invite+link+was+turned+off" });
    await app.waitFor("id:sign-in-problem");
    expect(app.texts().join(" ")).toContain("GitHub sign-in did not complete: That invite link was turned off");
  });
});

describe("a file attached to a message", () => {
  test("is uploaded into the worktree, and the message says where", async () => {
    const app = await open("../App.tsx", { storage: signedIn, platform: "macos", width: 1200, height: 800, network: server({
      [`GET ${ORIGIN}/api/workspaces/w1/connectors`]: { body: { connectors: [capableHost] } },
      [`POST ${ORIGIN}/api/sessions/s1/uploads`]: { body: { received: 6, path: "attachments/notes.txt" } },
    }) });
    await app.press("id:session-row-s1");
    await app.waitFor("id:composer-input");
    // A file pasted into the chat box (a browser's page picks any file too; pnpm test:client-web covers its chooser).
    await app.paste("id:composer-input", { files: ["tests/assets/notes.txt"] });
    await app.waitFor("id:attachment-file");
    expect(app.shows("text:notes.txt")).toBe(true);
    await app.press("id:composer-send");
    await app.waitUntil(() => bodyOf(app, "POST", "/api/sessions/s1/submit") !== undefined);
    expect(bodyOf(app, "POST", "/api/sessions/s1/uploads")).toMatchObject({ name: "notes.txt", size: 6, offset: 0, data: base64(new TextEncoder().encode("hello\n")) });
    expect(bodyOf(app, "POST", "/api/sessions/s1/submit").content).toBe("Attached file, uploaded into the session worktree:\n- attachments/notes.txt (6 bytes)");
  });
});

describe("local files a desktop hands over", () => {
  // The harness puts the files in a folder of its own under the home folder, which the app may read (nsh.json).
  const staged = async () => {
    const folder = `${homedir()}/.cache/pikibun-nsh-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const app = await open("./harness/attach.tsx", { platform: "macos", width: 800, height: 600, host: { params: { folder } } });
    await app.waitFor("id:clean-up");
    return { app, url: (name: string) => `file://${folder.split("/").map(encodeURIComponent).join("/")}/${name}` };
  };

  test("dropped on the chat box, an image goes with the message and any other file into the worktree", async () => {
    const { app, url } = await staged();
    // Its attach button picks photos, as NSH does natively, and says other files are dropped or pasted.
    expect(app.shows("label:Attach images (drop or paste other files)")).toBe(true);
    await app.dropFiles("id:composer", [url("notes.txt"), url("dot.png")]);
    await app.waitFor("id:attachment-file");
    expect(app.shows("id:attachment-image-0")).toBe(true);
    expect(app.shows("text:notes.txt")).toBe(true);
    expect(app.shows("id:composer-notice")).toBe(false);
    await app.press("id:clean-up");
    await app.waitUntil(() => !app.shows("id:clean-up"));
  });

  test("copied in a file manager and pasted, says what it couldn't attach", async () => {
    const { app, url } = await staged();
    await app.paste("id:composer-input", { uris: [url("large.txt")] });
    await app.waitFor("id:composer-notice");
    expect(app.texts()).toContain("A file larger than 1 KB can't be attached in this workspace.");
    await app.paste("id:composer-input", { uris: [url("missing.txt")] });
    await app.waitFor("text:Couldn't read missing.txt.");
    await app.dropFiles("id:composer", ["file://server/share/notes.txt"]);
    await app.waitFor("text:Only files on this computer can be attached.");
    await app.dropFiles("id:composer", ["file:///etc/hosts"]);
    await app.waitFor("text:Only files in your home folder can be attached.");
    expect(app.shows("id:attachment-file")).toBe(false);
    await app.press("id:clean-up");
    await app.waitUntil(() => !app.shows("id:clean-up"));
  });
});
