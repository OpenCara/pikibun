import { describe, expect, open, test } from "nsh/test";
import { serverCommand, serverLaunchProblem } from "../src/lib/this-server";
import { server as remote, signedIn } from "./fixtures";

const LOCAL = "http://127.0.0.1:7878";
const CLAIM = "c".repeat(43);
const localHealth = (claimed: boolean) => ({
  [`GET ${LOCAL}/api/health`]: { body: { ok: true, githubConfigured: true, passwordAuth: false, localServer: { claimed } } },
});

async function openPanel(params: Record<string, unknown> = {}) {
  const app = await open("./harness/self-host.tsx", { platform: "macos", width: 900, height: 2400, host: { params }, network: localHealth(false) });
  const sent = () => app.texts().filter(text => text.startsWith("sent ")).map(text => text.slice("sent ".length));
  const showsText = (part: string) => app.texts().some(text => text.includes(part));
  return { app, sent, showsText };
}

describe("starting Pikibun's server", () => {
  test("runs pikibun serve --stdio as the host's command runs, through the login shell or cmd.exe", () => {
    expect(serverCommand("macos", "/bin/zsh")).toEqual({ command: "zsh", args: ["-ilc", "exec pikibun serve --stdio"] });
    expect(serverCommand("windows", undefined)).toEqual({ command: "cmd", args: ["/d", "/c", "pikibun", "serve", "--stdio"] });
    expect(serverCommand("windows", undefined, "C:\\data\\cli").args)
      .toEqual(["/d", "/c", "if", "exist", "cli\\node_modules\\.bin\\pikibun.cmd", "(", "cli\\node_modules\\.bin\\pikibun.cmd", "serve", "--stdio", ")", "else", "pikibun", "serve", "--stdio"]);
  });

  test("tells a command too old for serve --stdio from a missing one", () => {
    expect(serverLaunchProblem(["Pikibun failed. Check --help, the state directory's permissions, the port, local Pi configuration and sandbox prerequisites."], 1)).toEqual({ kind: "outdated" });
    expect(serverLaunchProblem(["Unknown command: serve"], 2)).toEqual({ kind: "outdated" });
    expect(serverLaunchProblem(["zsh:1: command not found: pikibun"], 127)).toEqual({ kind: "missing" });
    expect(serverLaunchProblem(["pikibun needs Node.js 24 or newer; this is Node.js 20.11.0."], 1)).toMatchObject({ kind: "failed" });
  });
});

describe("Self host", () => {
  test("starts Pikibun with the GitHub app entered, after the unsandboxed consent, signs in to it with its claim, and stops it", async () => {
    const { app, sent, showsText } = await openPanel();
    await app.waitFor("id:self-host-start");
    await app.press("id:self-host-start");
    await app.waitUntil(() => showsText("Add your GitHub OAuth app's client ID and secret first"));
    expect(sent().some(line => line.startsWith("{\"type\":\"start\""))).toBe(false);

    await app.type("id:self-host-client-id", "Ov23liAbCdEf");
    await app.type("id:self-host-client-secret", "0123456789abcdef0123456789abcdef01234567");
    app.onDialog(() => "Run unsandboxed");
    await app.press("id:self-host-start");
    await app.waitFor("id:self-host-stop");
    expect(app.dialogs()[0]).toMatchObject({ title: "Run your sessions directly on this Mac?" });
    expect(sent()).toContain(JSON.stringify({ type: "start", github: { clientId: "Ov23liAbCdEf", clientSecret: "<secret>" }, unsandboxedConsent: true }));
    await app.waitUntil(() => showsText("Running"));
    expect(showsText(LOCAL)).toBe(true);
    expect(app.shows("id:self-host-unclaimed")).toBe(true);
    expect(showsText("Waiting for your first sign-in")).toBe(true);
    await app.waitFor("id:self-host-github-saved");
    expect(app.texts()).toContain("Ov23liAbCdEf");
    expect(app.shows("id:self-host-client-secret")).toBe(false);

    await app.press("id:self-host-use");
    await app.waitUntil(() => showsText(`used: ${LOCAL}`));
    await app.press("id:fake-sign-in");
    await app.waitUntil(() => showsText(`&claim=${CLAIM}`));
    expect(showsText(`sign-in url: ${LOCAL}/api/auth/native/start?`)).toBe(true);

    await app.press("id:self-host-stop");
    await app.waitFor("id:self-host-start");
    expect(sent()).toContain(JSON.stringify({ type: "stop" }));
    expect(app.shows("id:self-host-use")).toBe(false);
  });

  test("declining the consent starts nothing", async () => {
    const { app, sent, showsText } = await openPanel({ saved: true });
    await app.waitFor("id:self-host-start");
    app.onDialog(() => "Cancel");
    await app.press("id:self-host-start");
    await app.waitUntil(() => showsText("Running sessions without a sandbox was not confirmed; nothing was started."));
    expect(sent().some(line => line.startsWith("{\"type\":\"start\""))).toBe(false);
  });

  test("a saved GitHub app starts it again without asking for one, and a sandboxed host needs no consent", async () => {
    const { app, sent } = await openPanel({ saved: true, sandboxed: true });
    await app.waitFor("id:self-host-github-saved");
    expect(app.shows("id:self-host-github-form")).toBe(false);
    await app.press("id:self-host-start");
    await app.waitFor("id:self-host-stop");
    expect(sent()).toContain(JSON.stringify({ type: "start" }));
    expect(app.dialogs().length).toBe(0);
  });

  test("where this computer can't run sessions, it says why, asks no consent, and still serves", async () => {
    const { app, sent, showsText } = await openPanel({ saved: true, hostProblem: "Pi has no models with configured authentication." });
    await app.waitUntil(() => showsText("Pi has no models with configured authentication."));
    await app.press("id:self-host-start");
    await app.waitFor("id:self-host-stop");
    expect(sent()).toContain(JSON.stringify({ type: "start" }));
    expect(app.dialogs().length).toBe(0);
  });

  test("without Pikibun's command it offers to install it from npm, then can start", async () => {
    const { app, sent, showsText } = await openPanel({ command: "missing", saved: true, sandboxed: true });
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
});

describe("Self host in the app", () => {
  test("signed out, the sign-in screen runs Pikibun on this Mac and signs in to it, claiming it", async () => {
    const app = await open("./harness/self-host.tsx", { platform: "macos", width: 1280, height: 1400, host: { params: { app: true, saved: true, sandboxed: true } },
      network: localHealth(false), storage: {} });
    await app.waitFor("id:sign-in-self-host");
    expect(app.shows("text:Run Pikibun on this Mac")).toBe(true);
    await app.press("id:sign-in-self-host");
    await app.waitFor("id:self-host-start");
    await app.press("id:self-host-start");
    await app.waitFor("id:self-host-use");
    await app.press("id:self-host-use");
    await app.waitFor("id:sign-in-self-host-claim");
    expect(app.texts()).toContain(LOCAL);
    expect(app.shows("text:Set up Pikibun on this Mac")).toBe(true);
    expect(app.shows("id:github-sign-in")).toBe(true);
  });

  test("a local Pikibun that already has an owner asks for no claim", async () => {
    const app = await open("./harness/self-host.tsx", { platform: "macos", width: 1280, height: 1400, host: { params: { app: true, saved: true, sandboxed: true } },
      network: localHealth(true), storage: {} });
    await app.waitFor("id:sign-in-self-host");
    await app.press("id:sign-in-self-host");
    await app.waitFor("id:self-host-start");
    await app.press("id:self-host-start");
    await app.waitFor("id:self-host-use");
    await app.press("id:self-host-use");
    await app.waitUntil(() => app.texts().includes(LOCAL));
    await app.wait(50);
    expect(app.shows("id:sign-in-self-host-claim")).toBe(false);
    expect(app.shows("text:This Pikibun has no owner yet")).toBe(false);
  });

  test("signed in elsewhere, Settings › Self host switches the app to Pikibun on this Mac after asking", async () => {
    const app = await open("./harness/self-host.tsx", { platform: "macos", width: 1280, height: 1400, host: { params: { app: true, saved: true, sandboxed: true } },
      network: { ...remote(), ...localHealth(false) }, storage: signedIn });
    await app.waitFor("id:session-row-s1");
    await app.press("id:open-settings");
    await app.waitFor("id:settings-section-self-host");
    await app.press("id:settings-section-self-host");
    await app.waitFor("id:self-host-start");
    await app.press("id:self-host-start");
    await app.waitFor("id:self-host-use");
    app.onDialog(() => "Switch");
    await app.press("id:self-host-use");
    await app.waitFor("id:github-sign-in");
    expect(app.dialogs()[0]).toMatchObject({ title: "Sign in to Pikibun on this Mac?" });
    expect(app.texts()).toContain(LOCAL);
    await app.waitFor("id:sign-in-self-host-claim");
  });

  test("Settings lists Self host in the desktop builds only", async () => {
    const phone = await open("../App.tsx", { network: remote(), storage: signedIn, platform: "ios" });
    await phone.waitFor("id:session-row-s1");
    await phone.press("id:open-settings");
    await phone.waitFor("id:settings-section-profile");
    expect(phone.shows("id:settings-section-self-host")).toBe(false);
  });
});
