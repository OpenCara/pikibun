import { describe, expect, open, test } from "nsh/test";
import { hostCommand, launchProblem } from "../src/lib/this-computer";
import { server, signedIn } from "./fixtures";

// Settings › This Mac in the desktop builds: this computer as one of your hosts, through `pikibun host --stdio`, here a
// stand-in that speaks its protocol (harness/this-computer.tsx).

const SERVER = "https://pikibun.test";
const PAIRING_ID = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";

async function openPanel(params: Record<string, unknown> = {}) {
  const app = await open("./harness/this-computer.tsx", { platform: "macos", width: 900, height: 2400, host: { params } });
  const sent = () => app.texts().filter(text => text.startsWith("sent ")).map(text => text.slice("sent ".length));
  const showsText = (part: string) => app.texts().some(text => text.includes(part));
  return { app, sent, showsText };
}

describe("starting Pikibun's command", () => {
  test("runs it through the owner's login shell, as Terminal would, or cmd.exe on Windows; never another program", () => {
    expect(hostCommand("macos", "/bin/zsh")).toEqual({ command: "/bin/zsh", args: ["-ilc", "exec pikibun host --stdio"] });
    expect(hostCommand("linux", "/usr/bin/bash")).toEqual({ command: "/usr/bin/bash", args: ["-ilc", "exec pikibun host --stdio"] });
    // A shell the app isn't granted (fish, a path of the owner's) falls back to the platform's own.
    expect(hostCommand("macos", "/opt/homebrew/bin/fish").command).toBe("/bin/zsh");
    expect(hostCommand("linux", undefined).command).toBe("/bin/bash");
    expect(hostCommand("windows", "/bin/zsh")).toEqual({ command: "cmd", args: ["/d", "/c", "pikibun", "host", "--stdio"] });
  });

  test("tells a missing command from an old one, and shows anything else as it said", () => {
    expect(launchProblem(["zsh:1: command not found: pikibun"], 127)).toEqual({ kind: "missing" });
    expect(launchProblem(["bash: line 1: exec: pikibun: not found"], 127)).toEqual({ kind: "missing" });
    expect(launchProblem(["'pikibun' is not recognized as an internal or external command,"], 9009)).toEqual({ kind: "missing" });
    expect(launchProblem(["Unknown command: host", "", "Usage: pikibun <command> [options]"], 2)).toEqual({ kind: "outdated" });
    expect(launchProblem(["pikibun needs Node.js 24 or newer; this is Node.js 20.11.0."], 1)).toMatchObject({ kind: "failed" });
    expect(launchProblem(["bash: no job control in this shell", "Connector failed. Check --help."], 1))
      .toEqual({ kind: "failed", message: "The host could not start: bash: no job control in this shell Connector failed. Check --help." });
  });
});

describe("This Mac", () => {
  test("pairs this Mac with the signed-in server in one step, after the unsandboxed consent, then stops its host", async () => {
    const { app, sent, showsText } = await openPanel();
    await app.waitFor("id:this-computer-pair-button");
    app.onDialog(() => "Run unsandboxed");
    await app.press("id:this-computer-pair-button");
    await app.waitFor("id:this-computer-stop");
    await app.waitUntil(() => showsText("This Mac is a host of pikibun.test"));
    expect(app.dialogs()[0]).toMatchObject({ title: "Run pikibun.test's agent work directly on this Mac?" });
    expect(sent()).toContain("pairing My Mac");
    expect(sent()).toContain(JSON.stringify({ type: "start", server: SERVER, pairing: { id: PAIRING_ID, code: "<code>" }, replacePairing: false, unsandboxedConsent: true }));
    await app.waitUntil(() => showsText("Online"));
    await app.press("id:this-computer-stop");
    await app.waitFor("id:this-computer-start");
    expect(sent()).toContain(JSON.stringify({ type: "stop" }));
  });

  test("declining the consent starts nothing", async () => {
    const { app, sent, showsText } = await openPanel();
    await app.waitFor("id:this-computer-pair-button");
    app.onDialog(() => "Cancel");
    await app.press("id:this-computer-pair-button");
    await app.waitUntil(() => showsText("Unsandboxed mode was not confirmed; nothing was started."));
    expect(sent().some(line => line.startsWith("{\"type\":\"start\""))).toBe(false);
    // Nor did it make a pairing code it wouldn't use.
    expect(sent()).not.toContain("pairing My Mac");
  });

  test("a computer paired with another server is paired again only by replacing that pairing", async () => {
    const { app, sent, showsText } = await openPanel({ paired: "https://other.example" });
    await app.waitFor("id:this-computer-pair-button");
    await app.waitUntil(() => showsText("This Mac is paired elsewhere (https://other.example)"));
    app.onDialog(() => "Run unsandboxed");
    await app.press("id:this-computer-pair-button");
    await app.waitFor("id:this-computer-stop");
    expect(sent()).toContain(JSON.stringify({ type: "start", server: SERVER, pairing: { id: PAIRING_ID, code: "<code>" }, replacePairing: true, unsandboxedConsent: true }));
  });

  test("without Pikibun's command it says how to install it, and too old a one how to update it", async () => {
    const missing = await openPanel({ command: "missing" });
    await missing.app.waitFor("id:this-computer-install");
    expect(missing.showsText("Install Pikibun's command on this Mac")).toBe(true);
    expect(missing.app.shows("text:npm install -g pikibun@latest")).toBe(true);
    expect(missing.app.shows("id:this-computer-pair-button")).toBe(false);
    const outdated = await openPanel({ command: "outdated" });
    await outdated.app.waitFor("id:this-computer-install");
    expect(outdated.showsText("Update Pikibun's command on this Mac")).toBe(true);
  });

  test("signs Pi in to a provider with an API key, then offers only the checked models from the next start", async () => {
    const { app, sent, showsText } = await openPanel({ paired: SERVER });
    await app.waitFor("id:this-computer-start");
    await app.waitUntil(() => showsText("Pi has no models with configured authentication."));
    await app.waitFor("id:this-computer-sign-in-start");
    await app.press("id:this-computer-sign-in-start");
    await app.waitFor("id:this-computer-sign-in-answer");
    await app.type("id:this-computer-sign-in-answer", "sk-ant-secret");
    await app.press("id:this-computer-sign-in-submit");
    await app.waitUntil(() => showsText("Pi is signed in to Anthropic on this Mac. Its models are listed above."));
    expect(sent()).toContain(JSON.stringify({ type: "login", provider: "anthropic", method: "api_key" }));
    // The key went to the host only: what the stand-in shows of it is its length.
    expect(sent().some(line => line.includes("\"type\":\"login-answer\"") && line.includes("<13 characters>"))).toBe(true);
    await app.waitFor("id:this-computer-model-anthropic/claude-opus");
    await app.press("id:this-computer-model-anthropic/claude-opus");
    await app.press("id:this-computer-models-save");
    await app.waitUntil(() => showsText("Saved: the host offers these from its next start."));
    app.onDialog(() => "Run unsandboxed");
    await app.press("id:this-computer-start");
    await app.waitFor("id:this-computer-stop");
    expect(sent()).toContain(JSON.stringify({ type: "start", server: SERVER, unsandboxedConsent: true, models: [{ provider: "anthropic", modelId: "claude-sonnet" }] }));
  });

  test("macOS's own sandbox is asked for once chosen", async () => {
    const { app, sent } = await openPanel({ paired: SERVER });
    await app.waitFor("id:this-computer-sandbox-choice");
    await app.press("text:macOS sandbox");
    await app.waitUntil(() => sent().includes(JSON.stringify({ type: "inspect", experimentalSandbox: true })));
  });

  test("Settings lists This Mac in the desktop builds only", async () => {
    const mac = await open("../App.tsx", { network: server(), storage: signedIn, platform: "macos", width: 1280, height: 820 });
    await mac.waitFor("id:session-row-s1");
    await mac.press("id:open-settings");
    await mac.waitFor("id:settings-section-desktop");
    expect(mac.shows("text:This Mac")).toBe(true);
    const phone = await open("../App.tsx", { network: server(), storage: signedIn, platform: "ios" });
    await phone.waitFor("id:session-row-s1");
    await phone.press("id:open-settings");
    await phone.waitFor("id:settings-section-profile");
    expect(phone.shows("id:settings-section-desktop")).toBe(false);
  });
});
