import { describe, expect, open, test } from "nsh/test";
import { agentSocketImport } from "../src/lib/agent-socket";
import { serverCommand, serverLaunchProblem } from "../src/lib/this-server";
import { ORIGIN, server as remote, signedIn, TOKEN, user } from "./fixtures";

const LOCAL = "http://127.0.0.1:7878";
const SIGN_IN_TOKEN = "c".repeat(43);
const localHealth = (claimed: boolean) => ({
  [`GET ${LOCAL}/api/health`]: { body: { ok: true, githubConfigured: false, passwordAuth: false, localServer: { claimed } } },
});
const bodyOf = (app: { requests(): { method: string; url: string; body?: string | null }[] }, method: string, url: string) => {
  const request = app.requests().find(item => item.method === method && item.url === url);
  return request?.body ? JSON.parse(request.body) as Record<string, unknown> : undefined;
};
function servedLocally(claimed = true, me?: () => unknown) {
  const network: Record<string, unknown> = Object.fromEntries(Object.entries(remote()).map(([key, value]) => [key.replace(ORIGIN, LOCAL), value]));
  if (me) network[`GET ${LOCAL}/api/me`] = me;
  network[`POST ${LOCAL}/api/auth/native/local`] = (request: { body?: string | null }) => (JSON.parse(request.body ?? "{}").token === SIGN_IN_TOKEN
    ? { body: { token: TOKEN, expiresAt: "2099-01-01T00:00:00.000Z", user } }
    : { status: 403, body: { error: "This sign-in link is not valid for this Pikibun.", code: "invalid_local_sign_in" } });
  return { ...network, ...localHealth(claimed) };
}

async function openPanel(params: Record<string, unknown> = {}) {
  const app = await open("./harness/self-host.tsx", { platform: "macos", width: 900, height: 2400, host: { params }, network: localHealth(false) });
  const sent = () => app.texts().filter(text => text.startsWith("sent ")).map(text => text.slice("sent ".length));
  const showsText = (part: string) => app.texts().some(text => text.includes(part));
  return { app, sent, showsText };
}

describe("starting Pikibun's server", () => {
  test("runs pikibun serve --stdio as the host's command runs, through the login shell or cmd.exe", () => {
    expect(serverCommand("macos", "/bin/zsh")).toEqual({ command: "zsh", args: ["-ilc", `${agentSocketImport("macos")}exec pikibun serve --stdio`] });
    expect(serverCommand("windows", undefined)).toEqual({ command: "cmd",
      args: ["/d", "/c", "chcp", "65001", ">nul", "2>nul", "&", "(", "where", "/q", "pikibun", "||", "exit", "9009", ")", "&&", "pikibun", "serve", "--stdio"] });
    expect(serverCommand("windows", undefined, "C:\\data\\cli").args)
      .toEqual(["/d", "/c", "chcp", "65001", ">nul", "2>nul", "&", "if", "exist", "cli\\node_modules\\.bin\\pikibun.cmd", "(", "cli\\node_modules\\.bin\\pikibun.cmd", "serve", "--stdio", ")",
        "else", "(", "(", "where", "/q", "pikibun", "||", "exit", "9009", ")", "&&", "pikibun", "serve", "--stdio", ")"]);
  });

  test("tells a command too old for serve --stdio from a missing one", () => {
    expect(serverLaunchProblem(["Pikibun failed. Check --help, the state directory's permissions, the port, local Pi configuration and sandbox prerequisites."], 1)).toEqual({ kind: "outdated" });
    expect(serverLaunchProblem(["Unknown command: serve"], 2)).toEqual({ kind: "outdated" });
    expect(serverLaunchProblem(["zsh:1: command not found: pikibun"], 127)).toEqual({ kind: "missing" });
    expect(serverLaunchProblem(["pikibun needs Node.js 24 or newer; this is Node.js 20.11.0."], 1)).toMatchObject({ kind: "failed" });
  });
});

describe("Self host", () => {
  test("starts Pikibun with nothing to set up, after the unsandboxed consent, offers to sign in to it with its token, and stops it", async () => {
    const { app, sent, showsText } = await openPanel();
    await app.waitFor("id:self-host-start");
    expect(showsText("GitHub")).toBe(false);
    app.onDialog(() => "Run unsandboxed");
    await app.press("id:self-host-start");
    await app.waitFor("id:self-host-stop");
    expect(app.dialogs()[0]).toMatchObject({ title: "Run your sessions directly on this Mac?" });
    expect(sent()).toContain(JSON.stringify({ type: "start", unsandboxedConsent: true }));
    await app.waitUntil(() => showsText("Running"));
    expect(showsText(LOCAL)).toBe(true);
    expect(showsText("Waiting for your first sign-in")).toBe(true);
    expect(showsText(`sign-in token: ${SIGN_IN_TOKEN}`)).toBe(true);

    await app.press("id:self-host-use");
    await app.waitUntil(() => showsText(`used: ${LOCAL}`));

    await app.press("id:self-host-stop");
    await app.waitFor("id:self-host-start");
    expect(sent()).toContain(JSON.stringify({ type: "stop" }));
    expect(app.shows("id:self-host-use")).toBe(false);
    expect(showsText("sign-in token: none")).toBe(true);
  });

  test("declining the consent starts nothing", async () => {
    const { app, sent, showsText } = await openPanel();
    await app.waitFor("id:self-host-start");
    app.onDialog(() => "Cancel");
    await app.press("id:self-host-start");
    await app.waitUntil(() => showsText("Running sessions without a sandbox was not confirmed; nothing was started."));
    expect(sent().some(line => line.startsWith("{\"type\":\"start\""))).toBe(false);
  });

  test("a sandboxed host needs no consent", async () => {
    const { app, sent } = await openPanel({ sandboxed: true });
    await app.waitFor("id:self-host-start");
    await app.press("id:self-host-start");
    await app.waitFor("id:self-host-stop");
    expect(sent()).toContain(JSON.stringify({ type: "start" }));
    expect(app.dialogs().length).toBe(0);
  });

  test("where this computer can't run sessions, it says why, asks no consent, and still serves", async () => {
    const { app, sent, showsText } = await openPanel({ hostProblem: "Pi has no models with configured authentication." });
    await app.waitUntil(() => showsText("Pi has no models with configured authentication."));
    await app.press("id:self-host-start");
    await app.waitFor("id:self-host-stop");
    expect(sent()).toContain(JSON.stringify({ type: "start" }));
    expect(app.dialogs().length).toBe(0);
  });

  test("without Pikibun's command it offers to install it from npm, then can start", async () => {
    const { app, sent, showsText } = await openPanel({ command: "missing", sandboxed: true });
    await app.waitFor("id:self-host-install");
    expect(showsText("Install Pikibun's command on this Mac")).toBe(true);
    expect(app.enabled("id:self-host-start")).toBe(false);
    await app.press("id:self-host-install");
    await app.waitUntil(() => !app.shows("id:self-host-command"));
    expect(sent()).toContain("install");
    expect(app.enabled("id:self-host-start")).toBe(true);
  });

  test("a command too old for serve --stdio is updated the same way", async () => {
    const { app, showsText } = await openPanel({ command: "outdated" });
    await app.waitFor("id:self-host-install");
    expect(showsText("Update Pikibun's command on this Mac")).toBe(true);
    expect(app.shows("text:Update pikibun")).toBe(true);
  });

  test("a command from before, which still asks for a GitHub OAuth app, is offered as an update", async () => {
    const { app, showsText } = await openPanel({ command: "old", sandboxed: true });
    await app.waitFor("id:self-host-start");
    await app.press("id:self-host-start");
    await app.waitFor("id:self-host-install");
    expect(showsText("Update Pikibun's command on this Mac")).toBe(true);
    expect(showsText("Add your GitHub OAuth app")).toBe(false);
  });

  test("after the app is updated, its own copy of the command is updated before Pikibun's server is asked anything", async () => {
    const app = await open("./harness/self-host.tsx", { platform: "macos", width: 900, height: 2400, network: localHealth(false),
      host: { params: { sandboxed: true, appVersion: "0.36.0", ownCopy: "0.9.0" } }, storage: { "pikibun.commandUpdatedFor": "0.35.0" } });
    const sent = () => app.texts().filter(text => text.startsWith("sent ")).map(text => text.slice("sent ".length));
    await app.waitFor("id:self-host-start");
    await app.waitUntil(() => sent().length >= 2);
    expect(sent().slice(0, 2)).toEqual(["install", JSON.stringify({ type: "inspect" })]);
    expect(app.storage()["pikibun.commandUpdatedFor"]).toBe("0.36.0");
    expect(app.shows("id:self-host-updating")).toBe(false);
  });
});

describe("Self host in the app", () => {
  test("signed out, the sign-in screen runs Pikibun on this Mac and signs in to it with its token, no GitHub needed", async () => {
    const app = await open("./harness/self-host.tsx", { platform: "macos", width: 1280, height: 1400, host: { params: { app: true, sandboxed: true } },
      network: servedLocally(false), storage: {} });
    await app.waitFor("id:sign-in-self-host");
    expect(app.shows("text:Run Pikibun on this Mac")).toBe(true);
    await app.press("id:sign-in-self-host");
    await app.waitFor("id:self-host-start");
    await app.press("id:self-host-start");
    await app.waitFor("id:self-host-use");
    await app.press("id:self-host-use");
    await app.waitFor("id:session-row-s1");
    expect(bodyOf(app, "POST", `${LOCAL}/api/auth/native/local`)).toMatchObject({ token: SIGN_IN_TOKEN, deviceName: "Pikibun (macos)" });
    expect(app.storage()["pikibun.origin"]).toBe(LOCAL);
    expect(app.storage()["pikibun.token"]).toBe(TOKEN);
  });

  test("signed out of a Pikibun this Mac runs, one button signs back in to it, and GitHub isn't offered", async () => {
    const app = await open("./harness/self-host.tsx", { platform: "macos", width: 1280, height: 1400, host: { params: { app: true, sandboxed: true } },
      network: servedLocally(true), storage: { "pikibun.origin": LOCAL, "pikibun.thisServer": JSON.stringify({ resume: { unsandboxedConsent: false } }) } });
    await app.waitFor("id:sign-in-self-host-sign-in");
    expect(app.shows("text:Sign in to Pikibun on this Mac")).toBe(true);
    expect(app.shows("id:github-sign-in")).toBe(false);
    expect(app.shows("id:local-link")).toBe(false);
    expect(app.shows("id:code-form")).toBe(false);
    await app.press("id:sign-in-self-host-sign-in");
    await app.waitFor("id:session-row-s1");
    expect(app.storage()["pikibun.token"]).toBe(TOKEN);
  });

  test("a Pikibun on this Mac that the app didn't start signs in with the link pikibun serve printed", async () => {
    const app = await open("./harness/self-host.tsx", { platform: "macos", width: 1280, height: 1400, host: { params: { app: true, sandboxed: true } },
      network: servedLocally(true), storage: { "pikibun.origin": LOCAL } });
    await app.waitFor("id:local-link");
    expect(app.shows("id:github-sign-in")).toBe(false);
    expect(app.shows("id:code-form")).toBe(false);
    expect(app.shows("id:sign-in-self-host-sign-in")).toBe(false);
    await app.type("id:local-link", `${LOCAL}/api/auth/local?token=${SIGN_IN_TOKEN}`);
    await app.press("id:local-link-sign-in");
    await app.waitFor("id:session-row-s1");
    expect(bodyOf(app, "POST", `${LOCAL}/api/auth/native/local`)).toMatchObject({ token: SIGN_IN_TOKEN });
    expect(app.storage()["pikibun.token"]).toBe(TOKEN);
  });

  test("a sign-in link for another server isn't sent anywhere, and a wrong one says so", async () => {
    const elsewhere = await open("./harness/self-host.tsx", { platform: "macos", width: 1280, height: 1400, host: { params: { app: true, sandboxed: true } },
      network: servedLocally(true), storage: { "pikibun.origin": LOCAL } });
    await elsewhere.waitFor("id:local-link");
    await elsewhere.type("id:local-link", `https://pikibun.example.com/api/auth/local?token=${SIGN_IN_TOKEN}`);
    await elsewhere.press("id:local-link-sign-in");
    await elsewhere.waitFor("id:sign-in-problem");
    expect(elsewhere.texts().some(text => text.startsWith("That isn't this Pikibun's sign-in link."))).toBe(true);
    expect(elsewhere.requests().some(item => item.url.endsWith("/api/auth/native/local"))).toBe(false);

    const wrong = await open("./harness/self-host.tsx", { platform: "macos", width: 1280, height: 1400, host: { params: { app: true, sandboxed: true } },
      network: servedLocally(true), storage: { "pikibun.origin": LOCAL } });
    await wrong.waitFor("id:local-link");
    await wrong.type("id:local-link", "x".repeat(43));
    await wrong.press("id:local-link-sign-in");
    await wrong.waitUntil(() => wrong.texts().some(text => text.includes("This sign-in link is not valid for this Pikibun.")));
    expect(wrong.storage()["pikibun.token"]).toBe(undefined);
  });

  test("a code link opened while the app points at a Pikibun on this Mac keeps its form open as it is edited, until it is cancelled", async () => {
    const app = await open("./harness/self-host.tsx", { platform: "macos", width: 1280, height: 1400, host: { params: { app: true, sandboxed: true } },
      network: servedLocally(true), storage: { "pikibun.origin": LOCAL } });
    await app.waitFor("id:local-link");
    expect(app.shows("id:code-form")).toBe(false);
    await app.openWithUrl(`pikibun://auth/code?${new URLSearchParams({ server: ORIGIN, code: "d".repeat(43) }).toString()}`);
    await app.waitFor("id:code-link-confirm");
    await app.type("id:code-input", "x");
    await app.waitUntil(() => !app.shows("id:code-link-confirm"));
    expect(app.shows("id:code-form")).toBe(true);
    await app.clear("id:code-input");
    await app.wait(100);
    expect(app.shows("id:code-form")).toBe(true);
    await app.openWithUrl(`pikibun://auth/code?${new URLSearchParams({ server: ORIGIN, code: "d".repeat(43) }).toString()}`);
    await app.waitFor("id:code-link-confirm");
    await app.press("id:code-cancel");
    await app.waitUntil(() => !app.shows("id:code-form"));
    expect(app.storage()["pikibun.token"]).toBeUndefined();
  });

  test("signed in elsewhere, Settings › Self host switches the app to Pikibun on this Mac after asking, and signs in to it", async () => {
    const app = await open("./harness/self-host.tsx", { platform: "macos", width: 1280, height: 1400, host: { params: { app: true, sandboxed: true } },
      network: { ...remote(), ...servedLocally(true) }, storage: signedIn });
    await app.waitFor("id:session-row-s1");
    await app.press("id:open-settings");
    await app.waitFor("id:settings-section-self-host");
    await app.press("id:settings-section-self-host");
    await app.waitFor("id:self-host-start");
    await app.press("id:self-host-start");
    await app.waitFor("id:self-host-use");
    app.onDialog(() => "Switch");
    await app.press("id:self-host-use");
    await app.waitUntil(() => app.storage()["pikibun.origin"] === LOCAL && app.storage()["pikibun.token"] === TOKEN);
    expect(app.dialogs()[0]).toMatchObject({ title: "Sign in to Pikibun on this Mac?" });
    expect(bodyOf(app, "POST", `${LOCAL}/api/auth/native/local`)).toMatchObject({ token: SIGN_IN_TOKEN });
    expect(app.requests().some(item => item.method === "POST" && item.url === `${ORIGIN}/api/auth/logout`)).toBe(true);
  });

  test("Settings › Self host leaves the app signed in where it is, and says why, when it can't sign in to Pikibun on this Mac", async () => {
    for (const params of [{ noToken: true }, {}]) {
      const served = { ...remote(), ...servedLocally(true) };
      const network = "noToken" in params ? served
        : { ...served, [`POST ${LOCAL}/api/auth/native/local`]: { status: 503, body: { error: "Authentication storage is temporarily unavailable.", code: "auth_unavailable" } } };
      const app = await open("./harness/self-host.tsx", { platform: "macos", width: 1280, height: 1400, host: { params: { app: true, sandboxed: true, ...params } },
        network, storage: signedIn });
      await app.waitFor("id:session-row-s1");
      await app.press("id:open-settings");
      await app.press("id:settings-section-self-host");
      await app.waitFor("id:self-host-start");
      await app.press("id:self-host-start");
      await app.waitFor("id:self-host-use");
      app.onDialog(() => "Switch");
      await app.press("id:self-host-use");
      await app.waitUntil(() => app.texts().some(text => text.includes("noToken" in params ? "didn't give this app its sign-in token" : "temporarily unavailable")));
      expect(app.storage()["pikibun.origin"]).toBe(ORIGIN);
      expect(app.storage()["pikibun.token"]).toBe(TOKEN);
      expect(app.requests().some(item => item.url.endsWith("/api/auth/logout"))).toBe(false);
      expect(app.shows("id:settings-section-self-host")).toBe(true);
    }
  });

  function notRunningAtFirst() {
    let asked = 0;
    return servedLocally(true, () => (++asked === 1 ? { status: 503, body: { error: { code: "unavailable", message: "Pikibun isn't running." } } } : { body: { user } }));
  }

  test("signed in to a Pikibun on this Mac that isn't running, the app offers to start it, then carries on signed in", async () => {
    const app = await open("./harness/self-host.tsx", { platform: "macos", width: 1280, height: 1400, host: { params: { app: true, sandboxed: true } },
      network: notRunningAtFirst(), storage: { "pikibun.token": TOKEN, "pikibun.origin": LOCAL } });
    await app.waitFor("text:Can't reach Pikibun");
    await app.press("id:unreachable-self-host");
    await app.waitFor("id:self-host-start");
    await app.press("id:self-host-start");
    await app.waitFor("id:self-host-use");
    await app.press("id:self-host-use");
    await app.waitFor("id:session-row-s1");
    expect(app.storage()["pikibun.token"]).toBe(TOKEN);
  });

  test("a Pikibun left running when the app quit starts again at launch, and the app signs back in to it", async () => {
    const app = await open("./harness/self-host.tsx", { platform: "macos", width: 1280, height: 1400, host: { params: { app: true, sandboxed: true } },
      network: notRunningAtFirst(), storage: { "pikibun.token": TOKEN, "pikibun.origin": LOCAL, "pikibun.thisServer": JSON.stringify({ resume: { unsandboxedConsent: false } }) } });
    await app.waitFor("id:session-row-s1");
    expect(app.storage()["pikibun.thisServer"]).toBe(JSON.stringify({ resume: { unsandboxedConsent: false } }));
  });

  test("a Pikibun that can't start again at launch says why, and isn't tried again", async () => {
    const app = await open("./harness/self-host.tsx", { platform: "macos", width: 1280, height: 1400, host: { params: { app: true } },
      network: notRunningAtFirst(), storage: { "pikibun.token": TOKEN, "pikibun.origin": LOCAL, "pikibun.thisServer": JSON.stringify({ resume: { unsandboxedConsent: false } }) } });
    await app.waitFor("text:Can't reach Pikibun");
    await app.press("id:unreachable-self-host");
    await app.waitFor("id:self-host-error");
    expect(app.texts().some(text => text.startsWith("Pikibun was not started again: this Mac runs your sessions unsandboxed, which needs your consent."))).toBe(true);
    expect(app.storage()["pikibun.thisServer"]).toBe("{}");
    expect(app.dialogs().length).toBe(0);
  });

  test("Settings lists Self host in the desktop builds only", async () => {
    const phone = await open("../App.tsx", { network: remote(), storage: signedIn, platform: "ios" });
    await phone.waitFor("id:session-row-s1");
    await phone.press("id:open-settings");
    await phone.waitFor("id:settings-section-profile");
    expect(phone.shows("id:settings-section-self-host")).toBe(false);
  });
});
