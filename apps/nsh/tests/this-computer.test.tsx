import { describe, expect, open, test } from "nsh/test";
import type { HostEvent, HostRequest } from "../../../packages/shared/src/app-host-protocol";
import { agentSocketImport } from "../src/lib/agent-socket";
import { CommandChannel } from "../src/lib/pikibun-command";
import {
  appCliFolder, COMMAND_UPDATED_KEY, hostArgs, hostCommand, installCommand, installFailure, launchProblem, ownCopyManifest, serverStateDir, updateFailure,
} from "../src/lib/this-computer";
import { server, signedIn } from "./fixtures";

const SERVER = "https://pikibun.test";
const PAIRING_ID = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";
const SERVERS_KEY = "pikibun.thisComputer.servers";
const STATE_DIR = "~/.local/share/pikibun/servers/pikibun.test";

async function openPanel(params: Record<string, unknown> = {}, storage: Record<string, string> = {}) {
  const app = await open("./harness/this-computer.tsx", { platform: "macos", width: 900, height: 2400, host: { params }, storage });
  const sent = () => app.texts().filter(text => text.startsWith("sent ")).map(text => text.slice("sent ".length));
  const showsText = (part: string) => app.texts().some(text => text.includes(part));
  return { app, sent, showsText };
}

describe("starting Pikibun's command", () => {
  test("runs it through the owner's login shell, as Terminal would, or cmd.exe on Windows; never another program", () => {
    expect(hostCommand("macos", "/bin/zsh")).toEqual({ command: "zsh", args: ["-ilc", `${agentSocketImport("macos")}exec pikibun host --stdio`] });
    expect(hostCommand("linux", "/usr/bin/bash")).toEqual({ command: "bash", args: ["-ilc", `${agentSocketImport("linux")}exec pikibun host --stdio`] });
    expect(agentSocketImport("macos")).toContain("launchctl getenv SSH_AUTH_SOCK");
    expect(agentSocketImport("linux")).toContain("systemctl --user show-environment");
    expect(hostCommand("macos", "/opt/homebrew/bin/fish").command).toBe("zsh");
    expect(hostCommand("linux", undefined).command).toBe("bash");
    expect(hostCommand("windows", "/bin/zsh")).toEqual({ command: "cmd",
      args: ["/d", "/c", "chcp", "65001", ">nul", "2>nul", "&", "(", "where", "/q", "pikibun", "||", "exit", "9009", ")", "&&", "pikibun", "host", "--stdio"] });
  });

  test("keeps the app's own copy of the command in its data directory", () => {
    expect(appCliFolder("macos", "/Users/ada/Library/Application Support/com.pikibun.app/")).toBe("/Users/ada/Library/Application Support/com.pikibun.app/cli");
    expect(appCliFolder("windows", "C:\\Users\\Ada\\AppData\\Roaming\\com.pikibun.app")).toBe("C:\\Users\\Ada\\AppData\\Roaming\\com.pikibun.app\\cli");
    expect(appCliFolder("linux", null)).toBe(null);
    expect(ownCopyManifest("macos", "/Users/ada/Library/Application Support/com.pikibun.app/cli")).toBe("/Users/ada/Library/Application Support/com.pikibun.app/cli/node_modules/pikibun/package.json");
    expect(ownCopyManifest("windows", "C:\\data\\cli")).toBe("C:\\data\\cli\\node_modules\\pikibun\\package.json");
  });

  test("starts the app's own copy where there is one, else the one on PATH", () => {
    const mac = "/Users/ada/Library/Application Support/com.pikibun.app/cli";
    expect(hostCommand("macos", "/bin/zsh", mac)).toEqual({ command: "zsh",
      args: ["-ilc", `${agentSocketImport("macos")}PATH='/Users/ada/Library/Application Support/com.pikibun.app/cli/node_modules/.bin':"$PATH"; export PATH; exec pikibun host --stdio`] });
    expect(hostCommand("linux", "/bin/bash", "/home/o'neil/.local/share/pikibun/cli").args[1])
      .toBe(`${agentSocketImport("linux")}PATH='/home/o'\\''neil/.local/share/pikibun/cli/node_modules/.bin':"$PATH"; export PATH; exec pikibun host --stdio`);
    expect(hostCommand("windows", undefined, "C:\\Users\\Ada Lovelace\\AppData\\Roaming\\com.pikibun.app\\cli")).toEqual({ command: "cmd",
      args: ["/d", "/c", "chcp", "65001", ">nul", "2>nul", "&", "if", "exist", "cli\\node_modules\\.bin\\pikibun.cmd", "(", "cli\\node_modules\\.bin\\pikibun.cmd", "host", "--stdio", ")",
        "else", "(", "(", "where", "/q", "pikibun", "||", "exit", "9009", ")", "&&", "pikibun", "host", "--stdio", ")"] });
  });

  test("installs it with npm the same way, into the app's own folder, or npm's global one without it", () => {
    const mac = "/Users/ada/Library/Application Support/com.pikibun.app/cli";
    expect(installCommand("macos", "/bin/zsh", mac)).toEqual({ command: "zsh",
      args: ["-ilc", "npm install --prefix '/Users/ada/Library/Application Support/com.pikibun.app/cli' --no-audit --no-fund pikibun@latest"],
      line: "npm install --prefix '/Users/ada/Library/Application Support/com.pikibun.app/cli' --no-audit --no-fund pikibun@latest" });
    expect(installCommand("macos", "/opt/homebrew/bin/fish", mac).command).toBe("zsh");
    expect(installCommand("windows", "/bin/zsh", "C:\\data\\cli")).toEqual({ command: "cmd",
      args: ["/d", "/c", "chcp", "65001", ">nul", "2>nul", "&", "(", "where", "/q", "npm", "||", "exit", "9009", ")", "&&", "npm", "install", "--prefix", "cli", "--no-audit", "--no-fund", "pikibun@latest"],
      line: "npm install --prefix cli --no-audit --no-fund pikibun@latest" });
    expect(installCommand("linux", "/usr/bin/bash", null)).toEqual({ command: "bash", args: ["-ilc", "npm install -g pikibun@latest"], line: "npm install -g pikibun@latest" });
    expect(installCommand("windows", undefined, null).args)
      .toEqual(["/d", "/c", "chcp", "65001", ">nul", "2>nul", "&", "(", "where", "/q", "npm", "||", "exit", "9009", ")", "&&", "npm", "install", "-g", "pikibun@latest"]);
  });

  test("a released app installs into its own folder the pikibun it was released with, never npm's latest", () => {
    const mac = "/Users/ada/Library/Application Support/com.pikibun.app/cli";
    expect(installCommand("macos", "/bin/zsh", mac, "0.32.0").line)
      .toBe("npm install --prefix '/Users/ada/Library/Application Support/com.pikibun.app/cli' --no-audit --no-fund pikibun@0.32.0");
    expect(installCommand("windows", undefined, "C:\\data\\cli", "0.32.0").line).toBe("npm install --prefix cli --no-audit --no-fund pikibun@0.32.0");
    expect(installCommand("linux", "/usr/bin/bash", null, "0.32.0").line).toBe("npm install -g pikibun@latest");
    expect(installCommand("linux", "/usr/bin/bash", "/home/ada/.local/share/pikibun/cli", "dev").line).toMatch(/ pikibun@latest$/);
  });

  test("says why an install failed in a way the owner can act on", () => {
    expect(installFailure(["zsh:1: command not found: npm"], { code: 127 })).toMatch(/^npm isn't installed on this (computer|Mac)\. Install Node\.js 24 or newer/);
    expect(installFailure(["'npm' is not recognized as an internal or external command,"], { code: 1 })).toMatch(/^npm isn't installed/);
    expect(installFailure(["npm error Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules/pikibun'"], { code: 243 })).toMatch(/permission denied/);
    expect(installFailure(["npm error code EACCES", "npm error   sudo chown -R 501:20 \"/Users/ada/.npm\""], { code: 243 }))
      .toMatch(/Fix them in a terminal with sudo chown -R 501:20 "\/Users\/ada\/\.npm", then choose Install again\.$/);
    expect(installFailure([], { code: null, error: "timed out after 300000 ms" })).toBe("The install didn't finish: timed out after 300000 ms");
    expect(installFailure(["npm error code E404", "npm error 404 Not Found"], { code: 1 })).toBe("npm couldn't install pikibun: npm error code E404 npm error 404 Not Found");
    expect(installFailure(["\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD"], { code: 1 })).toBe("npm couldn't install pikibun (exit code 1).");
  });

  test("says why an automatic update failed, and that the command at hand stays", () => {
    expect(updateFailure(["npm error code ENOTFOUND", "npm error network request to https://registry.npmjs.org/pikibun failed"], { code: 1 }))
      .toMatch(/^npm couldn't update Pikibun's command \(npm error code ENOTFOUND npm error network request to https:\/\/registry\.npmjs\.org\/pikibun failed\)\. This (Computer|Mac) keeps the one it has, and Pikibun tries again the next time it opens\.$/);
    expect(updateFailure([], { code: null, error: "timed out after 300000 ms" })).toMatch(/^npm couldn't update Pikibun's command \(timed out after 300000 ms\)\./);
    expect(updateFailure([], { code: 1 })).toMatch(/^npm couldn't update Pikibun's command \(exit code 1\)\./);
  });

  test("tells a missing command from an old one, and shows anything else as it said", () => {
    expect(launchProblem(["zsh:1: command not found: pikibun"], 127)).toEqual({ kind: "missing" });
    expect(launchProblem(["bash: line 1: exec: pikibun: not found"], 127)).toEqual({ kind: "missing" });
    expect(launchProblem(["'pikibun' is not recognized as an internal or external command,"], 9009)).toEqual({ kind: "missing" });
    expect(launchProblem(["'pikibun' \uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD"], 9009)).toEqual({ kind: "missing" });
    expect(launchProblem(["'pikibun' \uFFFD\uFFFD\uFFFD\uFFFD\uFFFD"], 1)).toEqual({ kind: "failed", message: "The host could not start (exit code 1)." });
    expect(launchProblem(["Unknown command: host", "", "Usage: pikibun <command> [options]"], 2)).toEqual({ kind: "outdated" });
    expect(launchProblem(["pikibun needs Node.js 24 or newer; this is Node.js 20.11.0."], 1)).toMatchObject({ kind: "failed" });
    expect(launchProblem(["bash: no job control in this shell", "Connector failed. Check --help."], 1))
      .toEqual({ kind: "failed", message: "The host could not start: bash: no job control in this shell Connector failed. Check --help." });
  });
});

describe("a command that waits for its update", () => {
  function waitingChannel(update: Promise<void>) {
    const state = { launched: 0 };
    const channel = new CommandChannel<HostEvent, HostRequest>({
      launch: () => { state.launched++; throw new Error("launched"); }, before: () => update, eventTypes: new Set(["ready", "result"]), problem: launchProblem, subject: "The host",
      failure: (id, message) => ({ type: "result", id, ok: false, error: { code: "failed", message } }),
      onEvent: () => undefined, onOutput: () => undefined, onExit: () => undefined,
    });
    return { channel, state };
  }
  const soon = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

  test("shut down meanwhile, it waits for the update too and doesn't start until it is asked again", async () => {
    let finish = () => {};
    const { channel, state } = waitingChannel(new Promise<void>(resolve => { finish = resolve; }));
    const asked = channel.request({ type: "inspect" });
    let stopped = false;
    const stopping = channel.shutdown().then(() => { stopped = true; });
    await soon(30);
    expect(stopped).toBe(false);
    finish();
    await stopping;
    expect((await asked).ok).toBe(false);
    expect(state.launched).toBe(0);
    await channel.request({ type: "inspect" });
    expect(state.launched).toBe(1);
  });

  test("shutting down gives up on an update that doesn't finish, and still starts nothing", async () => {
    let finish = () => {};
    const { channel, state } = waitingChannel(new Promise<void>(resolve => { finish = resolve; }));
    const asked = channel.request({ type: "inspect" });
    await channel.shutdown(30);
    expect(state.launched).toBe(0);
    finish();
    expect((await asked).ok).toBe(false);
    expect(state.launched).toBe(0);
  });
});

describe("after the app is updated", () => {
  const before = { [COMMAND_UPDATED_KEY]: "0.35.0" };
  const installs = (sent: string[]) => sent.filter(line => line === "install").length;

  test("its own copy of the command is updated from npm before the host is asked anything, once for that version", async () => {
    const { app, sent, showsText } = await openPanel({ paired: SERVER, appVersion: "0.36.0", ownCopy: "0.9.0" }, before);
    await app.waitFor("id:this-computer-start");
    expect(sent()[0]).toBe("install");
    expect(installs(sent())).toBe(1);
    expect(app.storage()[COMMAND_UPDATED_KEY]).toBe("0.36.0");
    expect(app.shows("id:this-computer-updating")).toBe(false);
    await app.press("id:this-computer-refresh");
    await app.press("text:Recent activity");
    await app.waitUntil(() => showsText("npm updated pikibun to 0.10.0 in Pikibun's own folder."));
    expect(showsText("Pikibun is now 0.36.0: updating its own pikibun command (0.9.0) from npm.")).toBe(true);
    expect(installs(sent())).toBe(1);
  });

  test("the page says so while npm runs, and the host waits for it", async () => {
    const { app, sent } = await openPanel({ paired: SERVER, appVersion: "0.36.0", ownCopy: "0.9.0", npmMs: 1500 }, before);
    await app.waitFor("id:this-computer-updating");
    expect(app.shows("text:Updating Pikibun's command on this Mac")).toBe(true);
    expect(sent()).toEqual(["install"]);
    expect(app.shows("id:this-computer-start")).toBe(false);
    await app.waitFor("id:this-computer-start");
    expect(app.shows("id:this-computer-updating")).toBe(false);
  });

  test("a copy the same version of the app updated is left alone, as is a computer where the app has none", async () => {
    const same = await openPanel({ paired: SERVER, appVersion: "0.36.0", ownCopy: "0.9.0" }, { [COMMAND_UPDATED_KEY]: "0.36.0" });
    await same.app.waitFor("id:this-computer-start");
    expect(installs(same.sent())).toBe(0);
    const global = await openPanel({ paired: SERVER, appVersion: "0.36.0" }, before);
    await global.app.waitFor("id:this-computer-start");
    expect(installs(global.sent())).toBe(0);
    expect(global.app.storage()[COMMAND_UPDATED_KEY]).toBe("0.35.0");
  });

  test("a copy installed before the app kept track is updated once", async () => {
    const { app, sent } = await openPanel({ paired: SERVER, appVersion: "0.36.0", ownCopy: "0.9.0" });
    await app.waitFor("id:this-computer-start");
    expect(sent()[0]).toBe("install");
    expect(app.storage()[COMMAND_UPDATED_KEY]).toBe("0.36.0");
  });

  test("an update that fails keeps the command at hand, says why, and is tried again at the next launch", async () => {
    const { app, sent, showsText } = await openPanel({ paired: SERVER, appVersion: "0.36.0", ownCopy: "0.9.0", npm: "missing" }, before);
    await app.waitFor("id:this-computer-start");
    expect(sent()[0]).toBe("install");
    expect(app.storage()[COMMAND_UPDATED_KEY]).toBe("0.35.0");
    expect(app.shows("id:this-computer-command")).toBe(false);
    await app.press("text:Recent activity");
    await app.waitUntil(() => showsText("warning: npm couldn't update Pikibun's command (zsh:1: command not found: npm). This Mac keeps the one it has, and Pikibun tries again the next time it opens."));
  });

  test("a copy the app can't look for is left as it is, and the host's activity says why", async () => {
    const { app, sent, showsText } = await openPanel({ paired: SERVER, appVersion: "0.36.0", ownCopy: "unreadable" }, before);
    await app.waitFor("id:this-computer-start");
    expect(installs(sent())).toBe(0);
    expect(app.storage()[COMMAND_UPDATED_KEY]).toBe("0.35.0");
    await app.press("text:Recent activity");
    await app.waitUntil(() => showsText("warning: Pikibun couldn't look for its own pikibun command (filesystem read of `cli/node_modules/pikibun/package.json` is not granted by capabilities.fs.read), so it wasn't updated with the app."));
  });

  test("installing the command from the page counts as this version's update", async () => {
    const { app } = await openPanel({ command: "missing", appVersion: "0.36.0" });
    await app.waitFor("id:this-computer-install-button");
    expect(app.storage()[COMMAND_UPDATED_KEY]).toBeUndefined();
    await app.press("id:this-computer-install-button");
    await app.waitFor("id:this-computer-pair-button");
    expect(app.storage()[COMMAND_UPDATED_KEY]).toBe("0.36.0");
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
    await app.waitUntil(() => showsText("this computer's host: c9"));
    await app.press("id:this-computer-stop");
    await app.waitFor("id:this-computer-start");
    expect(sent()).toContain(JSON.stringify({ type: "stop" }));
    await app.waitUntil(() => showsText("this computer's host: none"));
  });

  test("reads a session from its host only while the host runs, and never starts one to read it", async () => {
    const { app, sent, showsText } = await openPanel();
    await app.waitFor("id:this-computer-pair-button");
    await app.press("id:fake-read-session");
    await app.waitUntil(() => showsText("local view: none"));
    expect(sent().some(line => line.startsWith("{\"type\":\"view\""))).toBe(false);
    app.onDialog(() => "Run unsandboxed");
    await app.press("id:this-computer-pair-button");
    await app.waitUntil(() => showsText("this computer's host: c9"));
    await app.press("id:fake-read-session");
    await app.waitUntil(() => showsText("local view: s1"));
    expect(sent()).toContain(JSON.stringify({ type: "view", sessionId: "s1" }));
    await app.press("id:this-computer-stop");
    await app.waitUntil(() => showsText("this computer's host: none"));
    await app.press("id:fake-read-session");
    await app.waitUntil(() => showsText("local view: none"));
    expect(sent().filter(line => line.startsWith("{\"type\":\"view\"")).length).toBe(1);
  });

  test("declining the consent starts nothing", async () => {
    const { app, sent, showsText } = await openPanel();
    await app.waitFor("id:this-computer-pair-button");
    app.onDialog(() => "Cancel");
    await app.press("id:this-computer-pair-button");
    await app.waitUntil(() => showsText("Unsandboxed mode was not confirmed; nothing was started."));
    expect(sent().some(line => line.startsWith("{\"type\":\"start\""))).toBe(false);
    expect(sent()).not.toContain("pairing My Mac");
  });

  test("a computer paired with another server pairs with this one too, in a folder of its own, and keeps the first pairing", async () => {
    const { app, sent, showsText } = await openPanel({ paired: "https://other.example" });
    await app.waitFor("id:this-computer-pair-button");
    await app.waitUntil(() => showsText("Pair this Mac with pikibun.test as your host in one step: no code to copy. It keeps hosting for other.example too."));
    expect(app.shows("id:this-computer-other-other.example")).toBe(true);
    app.onDialog(() => "Run unsandboxed");
    await app.press("id:this-computer-pair-button");
    await app.waitFor("id:this-computer-stop");
    expect(sent()).toContain(`launch ${STATE_DIR}`);
    expect(sent()).toContain(JSON.stringify({ type: "start", server: SERVER, pairing: { id: PAIRING_ID, code: "<code>" }, replacePairing: false, unsandboxedConsent: true }));
    await app.waitUntil(() => showsText(`hosts: https://other.example=stopped ${SERVER}=connected`));
    await app.waitUntil(() => showsText("this computer's host: c10"));
    expect(JSON.parse(app.storage()[SERVERS_KEY]!)).toEqual([{ server: SERVER, stateDir: STATE_DIR }]);

    await app.press("id:this-computer-other-start-other.example");
    await app.waitUntil(() => showsText(`hosts: https://other.example=connected ${SERVER}=connected`));
    expect(sent()).toContain(JSON.stringify({ type: "start", server: "https://other.example", unsandboxedConsent: true }));
    expect(app.dialogs().map(dialog => dialog.title)).toEqual(["Run pikibun.test's agent work directly on this Mac?", "Run other.example's agent work directly on this Mac?"]);
    expect(showsText("this computer's host: c10")).toBe(true);
    await app.press("id:this-computer-other-stop-other.example");
    await app.waitUntil(() => showsText(`hosts: https://other.example=stopped ${SERVER}=connected`));
  });

  test("each server it hosts for starts again at the next launch, with the consent given for it", async () => {
    const third = "https://third.example";
    const thirdDir = "~/.local/share/pikibun/servers/third.example";
    const { app, sent, showsText } = await openPanel({ paired: "https://other.example", pairedDirs: { [thirdDir]: third } }, {
      "pikibun.thisComputer": JSON.stringify({ resume: { server: "https://other.example", unsandboxedConsent: true } }),
      [SERVERS_KEY]: JSON.stringify([{ server: third, stateDir: thirdDir }]),
      [`pikibun.thisComputer:${thirdDir}`]: JSON.stringify({ resume: { server: third, unsandboxedConsent: true } }),
    });
    await app.waitFor("id:this-computer-pair-button");
    await app.press("id:fake-resume");
    await app.waitUntil(() => showsText(`hosts: https://other.example=connected ${third}=connected`));
    expect(sent()).toContain(JSON.stringify({ type: "start", server: third, unsandboxedConsent: true }));
    expect(app.dialogs().length).toBe(0);
  });

  test("removing a server stops its host and forgets its pairing here, after asking", async () => {
    const third = "https://third.example";
    const thirdDir = "~/.local/share/pikibun/servers/third.example";
    const { app, showsText } = await openPanel({ paired: SERVER, pairedDirs: { [thirdDir]: third } }, {
      [SERVERS_KEY]: JSON.stringify([{ server: third, stateDir: thirdDir }]),
    });
    await app.waitFor("id:this-computer-other-third.example");
    expect(app.shows("id:this-computer-other-remove-third.example")).toBe(true);
    app.onDialog(dialog => (dialog.title === "Run third.example's agent work directly on this Mac?" ? "Run unsandboxed" : null));
    await app.press("id:this-computer-other-start-third.example");
    await app.waitUntil(() => showsText(`hosts: ${SERVER}=stopped ${third}=connected`));
    app.onDialog(dialog => (dialog.title === "Stop hosting for third.example?" ? "Remove" : null));
    await app.press("id:this-computer-other-remove-third.example");
    await app.waitUntil(() => !app.shows("id:this-computer-others"));
    expect(showsText(`hosts: ${SERVER}=stopped`)).toBe(true);
    expect(JSON.parse(app.storage()[SERVERS_KEY]!)).toEqual([]);
    expect(app.dialogs().at(-1)?.message).toMatch(/stays in that Pikibun's Settings › Hosts, offline, until you remove it there/);
  });

  test("each server gets a folder of its own, named for it", () => {
    expect(serverStateDir("https://pikibun.example.com")).toBe("~/.local/share/pikibun/servers/pikibun.example.com");
    expect(serverStateDir("https://Pikibun.Example.com")).toBe("~/.local/share/pikibun/servers/pikibun.example.com");
    expect(serverStateDir("https://Pikibun.Example.com:8443")).toMatch(/^~\/\.local\/share\/pikibun\/servers\/pikibun\.example\.com-8443-[0-9a-f]{8}$/);
    expect(serverStateDir("http://127.0.0.1:7878")).toMatch(/^~\/\.local\/share\/pikibun\/servers\/http-127\.0\.0\.1-7878-[0-9a-f]{8}$/);
    expect(serverStateDir("http://[::1]:7878")).toMatch(/^~\/\.local\/share\/pikibun\/servers\/http-1-7878-[0-9a-f]{8}$/);
    const names = ["https://foo_bar.example", "https://foo-bar.example", "https://http-a.example", "http://a.example", "https://a.example-8443", "https://a.example:8443",
      "http://[::1]:7878", "http://[::2]:7878"].map(serverStateDir);
    expect(new Set(names).size).toBe(names.length);
    expect(hostCommand("macos", "/bin/zsh", null)).toEqual({ command: "zsh", args: ["-ilc", `${agentSocketImport("macos")}exec pikibun host --stdio`] });
    expect(hostArgs("~/.local/share/pikibun/servers/pikibun.example.com")).toEqual(["host", "--stdio", "--state-dir", "~/.local/share/pikibun/servers/pikibun.example.com"]);
    expect(launchProblem(["Unknown option. Run \"pikibun host --help\"."], 1)).toEqual({ kind: "outdated" });
  });

  test("without Pikibun's command it offers to install it from npm, and then carries on to pairing", async () => {
    const { app, sent, showsText } = await openPanel({ command: "missing" });
    await app.waitFor("id:this-computer-install-button");
    expect(showsText("Install Pikibun's command on this Mac")).toBe(true);
    expect(app.shows("text:Install pikibun")).toBe(true);
    expect(app.shows("id:this-computer-install")).toBe(false);
    expect(app.shows("id:this-computer-pair-button")).toBe(false);
    await app.press("id:this-computer-install-button");
    await app.waitFor("id:this-computer-pair-button");
    expect(sent()).toContain("install");
    expect(app.shows("id:this-computer-command")).toBe(false);
    await app.press("text:Recent activity");
    await app.waitUntil(() => showsText("added 1 package in 2s"));
    expect(showsText("Running npm install --prefix '/Users/ada/Library/Application Support/com.pikibun.app/cli' --no-audit --no-fund pikibun@latest.")).toBe(true);
    expect(showsText("npm installed pikibun in Pikibun's own folder.")).toBe(true);
  });

  test("too old a command is updated from npm the same way", async () => {
    const { app, sent } = await openPanel({ command: "outdated" });
    await app.waitFor("id:this-computer-install-button");
    expect(app.shows("text:Update Pikibun's command on this Mac")).toBe(true);
    expect(app.shows("text:Update pikibun")).toBe(true);
    await app.press("id:this-computer-install-button");
    await app.waitFor("id:this-computer-pair-button");
    expect(sent()).toContain("install");
  });

  test("an install that fails says why, and offers the command to run in a terminal", async () => {
    const noNpm = await openPanel({ command: "missing", npm: "missing" });
    await noNpm.app.waitFor("id:this-computer-install-button");
    await noNpm.app.press("id:this-computer-install-button");
    await noNpm.app.waitFor("id:this-computer-install");
    expect(noNpm.showsText("npm isn't installed on this Mac. Install Node.js 24 or newer (from nodejs.org, or brew install node), then choose Install again.")).toBe(true);
    expect(noNpm.app.shows("text:npm install -g pikibun@latest")).toBe(true);
    expect(noNpm.app.shows("id:this-computer-pair-button")).toBe(false);
    const denied = await openPanel({ command: "missing", npm: "denied" });
    await denied.app.waitFor("id:this-computer-install-button");
    await denied.app.press("id:this-computer-install-button");
    await denied.app.waitFor("id:this-computer-install");
    expect(denied.showsText("npm couldn't write a folder it needs on this Mac: permission denied. Run the command below in a terminal with sudo in front, then choose Refresh.")).toBe(true);
    const rootCache = await openPanel({ command: "missing", npm: "root-cache" });
    await rootCache.app.waitFor("id:this-computer-install-button");
    await rootCache.app.press("id:this-computer-install-button");
    await rootCache.app.waitFor("id:this-computer-install");
    expect(rootCache.showsText("npm's cache on this Mac has files it can't write, left by an earlier sudo npm. Fix them in a terminal with sudo chown -R 501:20 \"/Users/ada/.npm\", then choose Install again.")).toBe(true);
  });

  test("an install's failure is forgotten once the command is there, so it never comes back stale", async () => {
    const { app, showsText } = await openPanel({ command: "missing", npm: "denied" });
    await app.waitFor("id:this-computer-install-button");
    await app.press("id:this-computer-install-button");
    await app.waitUntil(() => showsText("install error: npm couldn't write a folder it needs"));
    await app.press("id:fake-terminal-install");
    await app.press("id:this-computer-retry");
    await app.waitFor("id:this-computer-pair-button");
    expect(app.texts()).toContain("install error: ");
  });

  test("a global install (with no app folder) the login shell can't find afterwards says to put npm's folder on PATH", async () => {
    const { app, showsText } = await openPanel({ command: "missing", npm: "elsewhere" });
    await app.waitFor("id:this-computer-install-button");
    await app.press("id:this-computer-install-button");
    await app.waitFor("id:this-computer-install");
    expect(showsText("npm installed pikibun, but this Mac's login shell doesn't find it.")).toBe(true);
  });

  test("signs Pi in to a provider with an API key, then offers only the checked models from the next start", async () => {
    const { app, sent, showsText } = await openPanel({ paired: SERVER, piSignedIn: false });
    await app.waitFor("id:this-computer-start");
    await app.waitUntil(() => showsText("Pi has no models with configured authentication."));
    await app.waitFor("id:this-computer-sign-in-start");
    await app.press("id:this-computer-sign-in-start");
    await app.waitFor("id:this-computer-sign-in-answer");
    await app.type("id:this-computer-sign-in-answer", "sk-ant-secret");
    await app.press("id:this-computer-sign-in-submit");
    await app.waitUntil(() => showsText("Pi is signed in to Anthropic on this Mac. Its models are listed above."));
    expect(sent()).toContain(JSON.stringify({ type: "login", provider: "anthropic", method: "api_key" }));
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

  test("with no model in Pi yet, pairing is refused before a code is made, pointing at the sign-in", async () => {
    const { app, sent, showsText } = await openPanel({ piSignedIn: false });
    await app.waitFor("id:this-computer-pair-button");
    await app.press("id:this-computer-pair-button");
    await app.waitUntil(() => showsText("Sign Pi in to a provider below first."));
    expect(sent()).not.toContain("pairing My Mac");
    expect(sent().some(line => line.startsWith("{\"type\":\"start\""))).toBe(false);
    expect(app.dialogs().length).toBe(0);
  });

  test("unchecking every model isn't saved as a choice: the host would offer them all", async () => {
    const { app, showsText } = await openPanel({ paired: SERVER });
    await app.waitFor("id:this-computer-model-anthropic/claude-opus");
    await app.press("id:this-computer-model-anthropic/claude-sonnet");
    await app.press("id:this-computer-model-anthropic/claude-opus");
    await app.waitUntil(() => showsText("Check at least one model, or let Pi choose."));
    let refused = "";
    try { await app.press("id:this-computer-models-save"); } catch (error) { refused = String(error); }
    expect(refused.includes("is disabled")).toBe(true);
    expect(showsText("Saved: the host offers these from its next start.")).toBe(false);
    expect(showsText("Pi chooses: its enabledModels setting")).toBe(true);
  });

  test("a development server on plain HTTP stays paired after its host connects and stops", async () => {
    const local = "http://localhost:8787";
    const { app, sent, showsText } = await openPanel({ server: local });
    await app.waitFor("id:this-computer-pair-button");
    app.onDialog(() => "Run unsandboxed");
    await app.press("id:this-computer-pair-button");
    await app.waitFor("id:this-computer-stop");
    await app.waitUntil(() => sent().filter(line => line === JSON.stringify({ type: "inspect", allowInsecureLoopback: true })).length >= 3);
    await app.press("id:this-computer-stop");
    await app.waitFor("id:this-computer-start");
    expect(app.shows("id:this-computer-pair-button")).toBe(false);
    expect(showsText("paired elsewhere")).toBe(false);
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
