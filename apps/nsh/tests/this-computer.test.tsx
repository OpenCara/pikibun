import { describe, expect, open, test } from "nsh/test";
import type { HostEvent, HostRequest } from "../../../packages/shared/src/app-host-protocol";
import { agentSocketImport } from "../src/lib/agent-socket";
import { CommandChannel, pikibunCommand, reportedVersion } from "../src/lib/pikibun-command";
import {
  appCliFolder, COMMAND_AUTO_UPDATE_KEY, COMMAND_AUTO_VERSION_KEY, COMMAND_UPDATED_KEY, hostArgs, hostCommand, installCommand, installFailure, launchProblem, ownCopyManifest, parseWslList, serverStateDir, updateFailure,
  validHostConfigs, wslInstallCommand, wslPikibunCommand,
} from "../src/lib/this-computer";
import { server, signedIn } from "./fixtures";

const SERVER = "https://pikibun.test";
const PAIRING_ID = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";
const SERVERS_KEY = "pikibun.thisComputer.servers";
const HOSTS_KEY = "pikibun.thisComputer.hosts";

async function openPanel(params: Record<string, unknown> = {}, storage: Record<string, string> = {}, platform: "macos" | "windows" = "macos") {
  const app = await open("./harness/this-computer.tsx", { platform, width: 900, height: 2400, host: { params }, storage });
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

  test("reads the version pikibun --version printed, past what the login shell said first", () => {
    expect(reportedVersion(["bash: no job control in this shell", "0.38.0"])).toBe("0.38.0");
    expect(reportedVersion(["0.41.0-rc.1"])).toBe("0.41.0-rc.1");
    expect(reportedVersion(["Unknown command: --version"])).toBe(null);
    expect(reportedVersion([])).toBe(null);
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

describe("WSL on Windows", () => {
  test("runs the command inside a WSL distribution through wsl.exe, in its login shell, with the app's own copy there first", () => {
    expect(wslPikibunCommand(undefined, hostArgs("~/.local/share/pikibun/hosts/a1b2c3d4"))).toEqual({ command: "wsl",
      args: ["--cd", "~", "--exec", "bash", "-ilc",
        `PATH="$HOME/.local/share/pikibun/app-cli/node_modules/.bin:$PATH"; export PATH; exec pikibun host --stdio --state-dir '~/.local/share/pikibun/hosts/a1b2c3d4'`] });
    expect(wslPikibunCommand("Ubuntu-24.04", ["host", "--stdio"]).args.slice(0, 2)).toEqual(["--distribution", "Ubuntu-24.04"]);
    expect(() => wslPikibunCommand("Ubuntu; calc", ["host"])).toThrow();
    expect(() => wslPikibunCommand("-d", ["host"])).toThrow();
  });

  test("installs the command there with npm, into the app's own folder in WSL, the version the app was released with", () => {
    expect(wslInstallCommand("Debian", "0.32.0")).toEqual({ command: "wsl",
      args: ["--distribution", "Debian", "--cd", "~", "--exec", "bash", "-ilc", `npm install --prefix "$HOME/.local/share/pikibun/app-cli" --no-audit --no-fund pikibun@0.32.0`],
      line: `npm install --prefix "$HOME/.local/share/pikibun/app-cli" --no-audit --no-fund pikibun@0.32.0` });
    expect(wslInstallCommand(undefined, "dev").line).toMatch(/ pikibun@latest$/);
  });

  test("lists WSL's distributions from its UTF-16 output, leaving out Docker Desktop's and anything that isn't a name", () => {
    const utf16 = (text: string) => `\uFEFF${[...text].map(char => `${char}\u0000`).join("")}`;
    expect(parseWslList(utf16("Ubuntu\r\nDebian\r\ndocker-desktop\r\ndocker-desktop-data\r\nnot a name\r\n\r\n"))).toEqual(["Ubuntu", "Debian"]);
    expect(parseWslList("Ubuntu-24.04\nUbuntu-24.04\n")).toEqual(["Ubuntu-24.04"]);
  });

  test("says what to do where WSL isn't set up, or npm is missing in it", () => {
    const none = launchProblem(["Windows Subsystem for Linux has no installed distributions."], 1, { wsl: {} });
    expect(none.kind).toBe("failed");
    expect(none.kind === "failed" && none.message.startsWith("WSL isn't set up on this computer. In PowerShell, run wsl --install")).toBe(true);
    expect(launchProblem(["There is no distribution with the supplied name."], 1, { wsl: { distro: "Arch" } }))
      .toEqual({ kind: "failed", message: "WSL has no distribution named Arch any more. Add a host for another one." });
    expect(launchProblem(["bash: line 1: exec: pikibun: not found"], 127, { wsl: {} })).toEqual({ kind: "missing" });
    expect(installFailure(["bash: line 1: npm: command not found"], { code: 127 }, { wsl: { distro: "Ubuntu" } }))
      .toMatch(/^npm isn't installed in WSL \(Ubuntu\)\. Install Node\.js 24 or newer there, for example with nvm \(curl /);
  });
});

describe("saved hosts", () => {
  test("keep only what was made for them, so nothing saved reaches a shell", () => {
    const valid = { id: "a1b2c3d4", server: SERVER, name: "My Mac", sandbox: "seatbelt", stateDir: "~/.local/share/pikibun/hosts/a1b2c3d4" };
    expect(validHostConfigs([valid], "macos")).toEqual([valid]);
    expect(validHostConfigs([{ ...valid, stateDir: "~/x'; touch /tmp/owned; '" }], "macos")).toEqual([]);
    expect(validHostConfigs([{ ...valid, stateDir: "~/.local/share/pikibun/hosts/other" }], "macos")).toEqual([]);
    expect(validHostConfigs([{ ...valid, id: "../x" }], "macos")).toEqual([]);
    expect(validHostConfigs([{ ...valid, server: "file:///etc" }], "macos")).toEqual([]);
    expect(validHostConfigs([{ ...valid, sandbox: "wsl", distro: "Ubuntu; calc" }], "windows")).toEqual([]);
    expect(validHostConfigs([{ ...valid, stateDir: "~/.local/share/pikibun/servers/pikibun.test" }], "macos")[0]?.stateDir).toBe("~/.local/share/pikibun/servers/pikibun.test");
    expect(validHostConfigs([{ ...valid, sandbox: "wsl" }], "macos")[0]?.sandbox).toBe("none");
    expect(validHostConfigs([valid, { ...valid, id: "b2c3d4e5", stateDir: undefined }, { ...valid, id: "c3d4e5f6", stateDir: undefined }], "macos").map(config => config.id))
      .toEqual(["a1b2c3d4", "b2c3d4e5"]);
    expect(validHostConfigs([{ ...valid, sandbox: "wsl", stateDir: undefined }, { ...valid, id: "b2c3d4e5", sandbox: "windows", stateDir: undefined }], "windows").length).toBe(2);
  });
});

describe("after the app is updated", () => {
  const before = { [COMMAND_UPDATED_KEY]: "0.35.0" };
  const installs = (sent: string[]) => sent.filter(line => line === "install").length;

  test("its own copy of the command is updated from npm before the host is asked anything, once for that version", async () => {
    const { app, sent, showsText } = await openPanel({ paired: SERVER, appVersion: "0.36.0", ownCopy: "0.9.0" }, before);
    await app.waitFor("id:local-host-start-default");
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
    expect(app.shows("id:local-host-start-default")).toBe(false);
    await app.waitFor("id:local-host-start-default");
    expect(app.shows("id:this-computer-updating")).toBe(false);
  });

  test("a copy the same version of the app updated is left alone, as is a computer where the app has none", async () => {
    const same = await openPanel({ paired: SERVER, appVersion: "0.36.0", ownCopy: "0.9.0" }, { [COMMAND_UPDATED_KEY]: "0.36.0" });
    await same.app.waitFor("id:local-host-start-default");
    expect(installs(same.sent())).toBe(0);
    const global = await openPanel({ paired: SERVER, appVersion: "0.36.0" }, before);
    await global.app.waitFor("id:local-host-start-default");
    expect(installs(global.sent())).toBe(0);
    expect(global.app.storage()[COMMAND_UPDATED_KEY]).toBe("0.35.0");
  });

  test("a copy installed before the app kept track is updated once", async () => {
    const { app, sent } = await openPanel({ paired: SERVER, appVersion: "0.36.0", ownCopy: "0.9.0" });
    await app.waitFor("id:local-host-start-default");
    expect(sent()[0]).toBe("install");
    expect(app.storage()[COMMAND_UPDATED_KEY]).toBe("0.36.0");
  });

  test("an update that fails keeps the command at hand, says why, and is tried again at the next launch", async () => {
    const { app, sent, showsText } = await openPanel({ paired: SERVER, appVersion: "0.36.0", ownCopy: "0.9.0", npm: "missing" }, before);
    await app.waitFor("id:local-host-start-default");
    expect(sent()[0]).toBe("install");
    expect(app.storage()[COMMAND_UPDATED_KEY]).toBe("0.35.0");
    expect(app.shows("id:this-computer-command")).toBe(false);
    await app.press("text:Recent activity");
    await app.waitUntil(() => showsText("warning: npm couldn't update Pikibun's command (zsh:1: command not found: npm). This Mac keeps the one it has, and Pikibun tries again the next time it opens."));
  });

  test("a copy the app can't look for is left as it is, and the activity says why", async () => {
    const { app, sent, showsText } = await openPanel({ paired: SERVER, appVersion: "0.36.0", ownCopy: "unreadable" }, before);
    await app.waitFor("id:local-host-start-default");
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

  test("the copy the app installed in a WSL distribution is updated there too, before that distribution's hosts start", async () => {
    const wslHost = { id: "a1b2c3d4", server: SERVER, name: "My computer (WSL)", sandbox: "wsl", distro: "Ubuntu", stateDir: "~/.local/share/pikibun/hosts/a1b2c3d4" };
    const { app, sent } = await openPanel({ appVersion: "0.36.0", id: "a1b2c3d4" }, {
      [COMMAND_UPDATED_KEY]: "0.36.0", [`${COMMAND_UPDATED_KEY}:wsl:Ubuntu`]: "0.35.0", [HOSTS_KEY]: JSON.stringify([wslHost]),
    }, "windows");
    await app.waitUntil(() => app.storage()[`${COMMAND_UPDATED_KEY}:wsl:Ubuntu`] === "0.36.0");
    expect(sent().filter(line => line === "install wsl:Ubuntu").length).toBe(1);
    expect(sent().indexOf("install wsl:Ubuntu")).toBeLessThan(sent().findIndex(line => line.startsWith("wsl:Ubuntu {")));
    expect(sent()).not.toContain("install");
  });
});

describe("automatic updates of the command", () => {
  const host = { id: "default", server: SERVER, name: "My Mac", sandbox: "none", resume: { unsandboxedConsent: true } };
  const current = { paired: SERVER, appVersion: "0.36.0", cliVersion: "0.40.0", reports: "0.40.0", ownCopy: "0.40.0" };
  const updated = { [COMMAND_UPDATED_KEY]: "0.36.0", [HOSTS_KEY]: JSON.stringify([host]) };

  test("are off until chosen: nothing asks npm", async () => {
    const { app, sent } = await openPanel({ ...current, latest: "0.42.0" }, updated);
    await app.waitFor("id:this-computer-auto-update-toggle");
    await app.press("id:fake-resume");
    await app.waitFor("id:local-host-stop-default");
    expect(sent()).not.toContain("npm latest");
    expect(sent().some(line => line.startsWith("install"))).toBe(false);
    expect(app.shows("id:this-computer-auto-update-check")).toBe(false);
  });

  test("once chosen, a newer pikibun on npm is installed, with the running host stopped for it and started again after", async () => {
    const { app, sent, showsText } = await openPanel({ ...current, latest: "0.42.0" }, updated);
    await app.press("id:fake-resume");
    await app.waitFor("id:local-host-stop-default");
    await app.waitUntil(() => showsText("this computer's hosts: c9"));
    await app.press("id:this-computer-auto-update-toggle");
    await app.waitUntil(() => app.storage()[COMMAND_AUTO_VERSION_KEY] === "0.42.0");
    expect(app.storage()[COMMAND_AUTO_UPDATE_KEY]).toBe("on");
    const stop = sent().indexOf(JSON.stringify({ type: "stop" }));
    const install = sent().indexOf("install pikibun@0.42.0");
    expect(stop).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(stop);
    await app.waitUntil(() => sent().lastIndexOf(JSON.stringify({ type: "start", server: SERVER, unsandboxedConsent: true })) > install);
    await app.waitUntil(() => showsText("this computer's hosts: c9"));
    expect(JSON.parse(app.storage()[HOSTS_KEY]!)[0].resume).toEqual({ unsandboxedConsent: true });
    await app.waitUntil(() => showsText("npm's latest pikibun is 0.42.0"));
    await app.press("text:Recent activity");
    await app.waitUntil(() => showsText("npm updated pikibun to 0.42.0 on this Mac."));
    await app.press("id:this-computer-auto-update-check");
    await app.waitUntil(() => sent().filter(line => line === "npm latest").length === 2);
    expect(sent().filter(line => line.startsWith("install")).length).toBe(1);
  });

  test("a version npm has that isn't newer installs nothing, and a check that fails says why", async () => {
    const same = await openPanel({ ...current, latest: "0.40.0" }, { ...updated, [COMMAND_AUTO_UPDATE_KEY]: "on" });
    await same.app.waitFor("id:this-computer-auto-update-check");
    await same.app.press("id:this-computer-auto-update-check");
    await same.app.waitUntil(() => same.showsText("npm's latest pikibun is 0.40.0"));
    expect(same.sent().some(line => line.startsWith("install"))).toBe(false);
    const offline = await openPanel({ ...current, latest: "offline" }, { ...updated, [COMMAND_AUTO_UPDATE_KEY]: "on" });
    await offline.app.waitFor("id:this-computer-auto-update-check");
    await offline.app.press("id:this-computer-auto-update-check");
    await offline.app.waitUntil(() => offline.showsText("Couldn't ask npm for pikibun's latest version: fetch failed"));
    expect(offline.sent().some(line => line.startsWith("install"))).toBe(false);
  });

  test("the app's own update keeps the newer pikibun installed automatically, unless they were turned off", async () => {
    const kept = await openPanel({ ...current }, { [COMMAND_UPDATED_KEY]: "0.35.0", [COMMAND_AUTO_UPDATE_KEY]: "on", [COMMAND_AUTO_VERSION_KEY]: "0.42.0" });
    await kept.app.waitUntil(() => kept.app.storage()[COMMAND_UPDATED_KEY] === "0.36.0");
    expect(kept.sent()).toContain("install pikibun@0.42.0");
    const off = await openPanel({ ...current }, { [COMMAND_UPDATED_KEY]: "0.35.0", [COMMAND_AUTO_UPDATE_KEY]: "off", [COMMAND_AUTO_VERSION_KEY]: "0.42.0" });
    await off.app.waitUntil(() => off.app.storage()[COMMAND_UPDATED_KEY] === "0.36.0");
    expect(off.sent()).toContain("install");
    expect(off.sent()).not.toContain("install pikibun@0.42.0");
  });
});

describe("Local hosts", () => {
  test("pairs this Mac with the signed-in server in one step, after the unsandboxed consent, then stops its host", async () => {
    const { app, sent, showsText } = await openPanel();
    await app.waitFor("id:this-computer-pair-button");
    app.onDialog(() => "Run unsandboxed");
    await app.press("id:this-computer-pair-button");
    await app.waitFor("id:local-host-stop-default");
    expect(app.dialogs()[0]).toMatchObject({ title: "Run pikibun.test's agent work directly on this Mac?" });
    expect(sent()).toContain("pairing My Mac");
    expect(sent()).toContain(JSON.stringify({ type: "start", server: SERVER, pairing: { id: PAIRING_ID, code: "<code>" }, replacePairing: false, unsandboxedConsent: true }));
    expect(sent().some(line => line.startsWith("launch "))).toBe(false);
    await app.waitUntil(() => showsText("Online"));
    await app.waitUntil(() => showsText("this computer's hosts: c9"));
    expect(app.shows("id:this-computer-pair")).toBe(false);
    expect(JSON.parse(app.storage()[HOSTS_KEY]!)).toEqual([{ id: "default", server: SERVER, name: "My Mac", sandbox: "none", connectorIds: ["c9"], resume: { unsandboxedConsent: true } }]);
    await app.press("id:local-host-stop-default");
    await app.waitFor("id:local-host-start-default");
    expect(sent()).toContain(JSON.stringify({ type: "stop" }));
    await app.waitUntil(() => showsText("this computer's hosts: none"));
  });

  test("reads a session from its host only while the host runs, and never starts one to read it", async () => {
    const { app, sent, showsText } = await openPanel();
    await app.waitFor("id:this-computer-pair-button");
    await app.press("id:fake-read-session");
    await app.waitUntil(() => showsText("local view: none"));
    expect(sent().some(line => line.startsWith("{\"type\":\"view\""))).toBe(false);
    app.onDialog(() => "Run unsandboxed");
    await app.press("id:this-computer-pair-button");
    await app.waitUntil(() => showsText("this computer's hosts: c9"));
    await app.press("id:fake-read-session");
    await app.waitUntil(() => showsText("local view: s1"));
    expect(sent()).toContain(JSON.stringify({ type: "view", sessionId: "s1" }));
    await app.press("id:local-host-stop-default");
    await app.waitUntil(() => showsText("this computer's hosts: none"));
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
    expect(app.storage()[HOSTS_KEY]).toBe("[]");
  });

  test("a computer paired from a terminal carries over, and a host for another server gets a folder of its own", async () => {
    const { app, sent, showsText } = await openPanel({ paired: "https://other.example" });
    await app.waitFor("id:local-host-default");
    expect(showsText("other.example · Unsandboxed, after your consent")).toBe(true);
    expect(app.shows("id:this-computer-pair")).toBe(false);
    await app.press("id:this-computer-add");
    await app.waitFor("id:this-computer-pair-button");
    await app.waitUntil(() => showsText("Pair this Mac with pikibun.test as your host in one step: no code to copy."));
    app.onDialog(() => "Run unsandboxed");
    await app.press("id:this-computer-pair-button");
    await app.waitUntil(() => showsText(`hosts: https://other.example=stopped ${SERVER}=connected`));
    const saved = JSON.parse(app.storage()[HOSTS_KEY]!) as { id: string; server: string; stateDir?: string }[];
    expect(saved.map(item => item.server)).toEqual(["https://other.example", SERVER]);
    const added = saved[1]!;
    expect(added.stateDir).toBe(`~/.local/share/pikibun/hosts/${added.id}`);
    expect(added.id).toMatch(/^[0-9a-f]{8}$/);
    expect(sent()).toContain(`launch ${added.stateDir}`);
    await app.waitUntil(() => showsText("this computer's hosts: c10"));

    await app.press("id:local-host-start-default");
    await app.waitUntil(() => showsText(`hosts: https://other.example=connected ${SERVER}=connected`));
    expect(sent()).toContain(JSON.stringify({ type: "start", server: "https://other.example", unsandboxedConsent: true }));
    expect(app.dialogs().map(dialog => dialog.title)).toEqual(["Run pikibun.test's agent work directly on this Mac?", "Run other.example's agent work directly on this Mac?"]);
    await app.press("id:local-host-stop-default");
    await app.waitUntil(() => showsText(`hosts: https://other.example=stopped ${SERVER}=connected`));
  });

  test("runs two hosts for the same server side by side, each with a sandbox and a folder of its own", async () => {
    const { app, sent, showsText } = await openPanel();
    await app.waitFor("id:this-computer-pair-button");
    app.onDialog(() => "Run unsandboxed");
    await app.press("id:this-computer-pair-button");
    await app.waitFor("id:local-host-stop-default");
    await app.press("id:this-computer-add");
    await app.waitUntil(() => showsText("Pair another host on this Mac with pikibun.test in one step: no code to copy. It is a host of its own, beside My Mac"));
    await app.press("text:macOS sandbox");
    await app.clear("id:this-computer-name");
    await app.type("id:this-computer-name", "My Mac (sandboxed)");
    await app.waitUntil(() => sent().filter(line => line === JSON.stringify({ type: "inspect", experimentalSandbox: true })).length >= 1);
    await app.press("id:this-computer-pair-button");
    await app.waitUntil(() => showsText("this computer's hosts: c9,c10"));
    expect(sent()).toContain("pairing My Mac (sandboxed)");
    expect(sent()).toContain(JSON.stringify({ type: "start", server: SERVER, pairing: { id: PAIRING_ID, code: "<code>" }, replacePairing: false, unsandboxedConsent: true, experimentalSandbox: true }));
    const saved = JSON.parse(app.storage()[HOSTS_KEY]!) as { id: string; name: string; sandbox: string; stateDir?: string }[];
    expect(saved.map(item => [item.name, item.sandbox, item.stateDir === undefined])).toEqual([["My Mac", "none", true], ["My Mac (sandboxed)", "seatbelt", false]]);
    expect(sent()).toContain(`launch ${saved[1]!.stateDir}`);
    await app.waitUntil(() => showsText("pikibun.test · macOS sandbox") || showsText("pikibun.test · Unsandboxed, after your consent"));
  });

  test("each host starts again at the next launch, with the consent given for it", async () => {
    const dir = "~/.local/share/pikibun/hosts/a1b2c3d4";
    const { app, sent, showsText } = await openPanel({ paired: "https://other.example", pairedDirs: { [dir]: SERVER } }, {
      [HOSTS_KEY]: JSON.stringify([
        { id: "default", server: "https://other.example", name: "My Mac", sandbox: "none", resume: { unsandboxedConsent: true } },
        { id: "a1b2c3d4", server: SERVER, name: "Second", sandbox: "seatbelt", stateDir: dir, resume: { unsandboxedConsent: true } },
      ]),
    });
    await app.waitFor("id:local-host-a1b2c3d4");
    await app.press("id:fake-resume");
    await app.waitUntil(() => showsText(`hosts: https://other.example=connected ${SERVER}=connected`));
    expect(sent()).toContain(JSON.stringify({ type: "start", server: SERVER, unsandboxedConsent: true, experimentalSandbox: true }));
    expect(app.dialogs().length).toBe(0);
  });

  test("what earlier versions kept becomes the list of hosts, each starting again as before", async () => {
    const third = "https://third.example";
    const thirdDir = "~/.local/share/pikibun/servers/third.example";
    const { app, sent, showsText } = await openPanel({ paired: "https://other.example", pairedDirs: { [thirdDir]: third } }, {
      "pikibun.thisComputer": JSON.stringify({ sandbox: "seatbelt", models: [{ provider: "anthropic", modelId: "claude-sonnet" }], resume: { server: "https://other.example", unsandboxedConsent: true } }),
      [SERVERS_KEY]: JSON.stringify([{ server: third, stateDir: thirdDir }, { server: "https://fourth.example", stateDir: "~/x'; touch /tmp/owned; '" }]),
      [`pikibun.thisComputer:${thirdDir}`]: JSON.stringify({ resume: { server: third, unsandboxedConsent: true } }),
      "pikibun.thisComputer.connectors": JSON.stringify({ [third]: ["c3"] }),
    });
    await app.waitFor("id:local-host-default");
    const saved = JSON.parse(app.storage()[HOSTS_KEY]!) as Record<string, unknown>[];
    const shared = { name: "This Mac", sandbox: "seatbelt", models: [{ provider: "anthropic", modelId: "claude-sonnet" }], resume: { unsandboxedConsent: true } };
    expect(saved[1]?.id).toMatch(/^[0-9a-f]{8}$/);
    expect(saved).toEqual([
      { id: "default", server: "https://other.example", ...shared },
      { id: saved[1]?.id, server: third, ...shared, stateDir: thirdDir, connectorIds: ["c3"] },
    ]);
    await app.press("id:fake-resume");
    await app.waitUntil(() => showsText(`hosts: https://other.example=connected ${third}=connected`));
    expect(sent()).toContain(JSON.stringify({ type: "start", server: third, unsandboxedConsent: true, models: [{ provider: "anthropic", modelId: "claude-sonnet" }], experimentalSandbox: true }));
    expect(app.dialogs().length).toBe(0);
    expect(sent().some(line => line.includes("owned"))).toBe(false);
  });

  test("a saved host whose folder isn't the one made for it is ignored, so nothing saved reaches the shell", async () => {
    const { app, sent, showsText } = await openPanel({ paired: SERVER }, {
      [HOSTS_KEY]: JSON.stringify([{ id: "a1b2c3d4", server: "https://third.example", name: "Evil", sandbox: "none", stateDir: "~/x'; touch /tmp/owned; '" }]),
    });
    await app.waitUntil(() => showsText(`hosts: ${SERVER}=stopped`));
    expect(app.shows("id:local-host-a1b2c3d4")).toBe(false);
    expect(sent().some(line => line.includes("owned"))).toBe(false);
  });

  test("passes each argument to the login shell as one word", () => {
    expect(pikibunCommand("linux", "/bin/bash", null, hostArgs("~/.local/share/pikibun/servers/third.example")).args[1])
      .toBe(`${agentSocketImport("linux")}exec pikibun host --stdio --state-dir '~/.local/share/pikibun/servers/third.example'`);
    expect(pikibunCommand("macos", "/bin/zsh", null, ["host", "--state-dir", "/tmp/a b; touch /tmp/owned '"]).args[1])
      .toBe(`${agentSocketImport("macos")}exec pikibun host --state-dir '/tmp/a b; touch /tmp/owned '\\'''`);
  });

  test("removing a host stops it and forgets it here, after asking; the command line's own can't be removed", async () => {
    const dir = "~/.local/share/pikibun/hosts/a1b2c3d4";
    const third = "https://third.example";
    const { app, showsText } = await openPanel({ paired: SERVER, pairedDirs: { [dir]: third }, id: "a1b2c3d4" }, {
      [HOSTS_KEY]: JSON.stringify([{ id: "default", server: SERVER, name: "My Mac", sandbox: "none" }, { id: "a1b2c3d4", server: third, name: "Third", sandbox: "none", stateDir: dir }]),
    });
    await app.waitFor("id:this-computer-start");
    expect(showsText("Third is a host of third.example")).toBe(true);
    app.onDialog(dialog => (dialog.title === "Run third.example's agent work directly on this Mac?" ? "Run unsandboxed" : null));
    await app.press("id:this-computer-start");
    await app.waitUntil(() => showsText(`${third}=connected`));
    app.onDialog(dialog => (dialog.title === "Remove Third?" ? "Remove" : null));
    await app.press("id:this-computer-remove");
    await app.waitFor("id:local-host-default");
    expect(app.shows("id:local-host-a1b2c3d4")).toBe(false);
    expect(showsText(`hosts: ${SERVER}=stopped`)).toBe(true);
    expect((JSON.parse(app.storage()[HOSTS_KEY]!) as { id: string }[]).map(item => item.id)).toEqual(["default"]);
    expect(app.dialogs().at(-1)?.message).toMatch(/stays in that Pikibun's Settings › Hosts, offline, until you remove it there/);
    await app.press("id:local-host-open-default");
    await app.waitFor("id:this-computer-start");
    expect(app.shows("id:this-computer-remove")).toBe(false);
  });

  test("each server gets a folder of its own, named for it, as before", () => {
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
    expect(app.shows("id:this-computer-pair-button") && !app.shows("text:Pairing")).toBe(true);
    await app.press("id:this-computer-install-button");
    await app.waitUntil(() => !app.shows("id:this-computer-command"));
    expect(sent()).toContain("install");
    expect(sent().some(line => line.startsWith("launch "))).toBe(false);
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
    await app.waitUntil(() => !app.shows("id:this-computer-command"));
    expect(sent()).toContain("install");
  });

  test("a command older than the one the app was released with is run, but the page and the home screen say so and offer to update it", async () => {
    const { app, sent, showsText } = await openPanel({ paired: SERVER, cliVersion: "0.40.0", reports: "0.38.0" });
    await app.waitFor("id:home-command-update");
    expect(app.shows("id:local-host-start-default")).toBe(true);
    expect(showsText("This Mac runs its hosts with pikibun 0.38.0, older than the 0.40.0 this version of Pikibun comes with")).toBe(true);
    expect(showsText("This Mac runs pikibun 0.38.0, older than the 0.40.0 this version of Pikibun comes with: its hosts may miss fixes")).toBe(true);
    expect(sent()).not.toContain("pikibun --version");
    await app.press("id:home-command-update-open");
    expect(sent()).toContain("open local hosts");
    await app.press("text:Recent activity");
    await app.waitUntil(() => showsText("warning: This Mac runs pikibun 0.38.0, older than the 0.40.0 this version of Pikibun comes with"));
    const launched = () => Number(app.texts().find(text => text.startsWith("launches: "))?.slice("launches: ".length));
    const before = launched();
    await app.press("id:this-computer-install-button");
    await app.waitUntil(() => !app.shows("id:this-computer-command") && !app.shows("id:home-command-update"));
    expect(sent()).toContain("install");
    await app.waitUntil(() => launched() > before);
    await app.press("id:this-computer-refresh");
    await app.waitUntil(() => showsText("npm installed pikibun in Pikibun's own folder."));
    expect(app.shows("id:home-command-update")).toBe(false);
  });

  test("a command too old to report its version when it starts is asked for it", async () => {
    const old = await openPanel({ paired: SERVER, cliVersion: "0.40.0", probes: "0.30.0" });
    await old.app.waitFor("id:home-command-update");
    expect(old.sent()).toContain("pikibun --version");
    expect(old.showsText("pikibun 0.30.0, older than the 0.40.0")).toBe(true);
    const current = await openPanel({ paired: SERVER, cliVersion: "0.40.0", reports: "0.40.0" });
    await current.app.waitFor("id:local-host-start-default");
    expect(current.app.shows("id:home-command-update")).toBe(false);
    expect(current.app.shows("id:this-computer-command")).toBe(false);
    const newer = await openPanel({ paired: SERVER, cliVersion: "0.40.0", reports: "0.41.0" });
    await newer.app.waitFor("id:local-host-start-default");
    expect(newer.app.shows("id:home-command-update")).toBe(false);
  });

  test("Later puts the home screen's notice off, but the page still offers the update", async () => {
    const { app } = await openPanel({ paired: SERVER, cliVersion: "0.40.0", reports: "0.38.0" });
    await app.waitFor("id:home-command-update");
    await app.press("id:home-command-update-later");
    await app.waitUntil(() => !app.shows("id:home-command-update"));
    expect(app.shows("id:this-computer-install-button")).toBe(true);
  });

  test("an install that fails says why, and offers the command to run in a terminal", async () => {
    const noNpm = await openPanel({ command: "missing", npm: "missing" });
    await noNpm.app.waitFor("id:this-computer-install-button");
    await noNpm.app.press("id:this-computer-install-button");
    await noNpm.app.waitFor("id:this-computer-install");
    expect(noNpm.showsText("npm isn't installed on this Mac. Install Node.js 24 or newer (from nodejs.org, or brew install node), then choose Install again.")).toBe(true);
    expect(noNpm.app.shows("text:npm install -g pikibun@latest")).toBe(true);
    const denied = await openPanel({ command: "missing", npm: "denied" });
    await denied.app.waitFor("id:this-computer-install-button");
    await denied.app.press("id:this-computer-install-button");
    await denied.app.waitFor("id:this-computer-install");
    expect(denied.showsText("npm couldn't write a folder it needs in this Mac: permission denied. Run the command below in a terminal with sudo in front, then choose Refresh.")).toBe(true);
    const rootCache = await openPanel({ command: "missing", npm: "root-cache" });
    await rootCache.app.waitFor("id:this-computer-install-button");
    await rootCache.app.press("id:this-computer-install-button");
    await rootCache.app.waitFor("id:this-computer-install");
    expect(rootCache.showsText("npm's cache in this Mac has files it can't write, left by an earlier sudo npm. Fix them in a terminal with sudo chown -R 501:20 \"/Users/ada/.npm\", then choose Install again.")).toBe(true);
  });

  test("an install's failure is forgotten once the command is there, so it never comes back stale", async () => {
    const { app, showsText } = await openPanel({ command: "missing", npm: "denied" });
    await app.waitFor("id:this-computer-install-button");
    await app.press("id:this-computer-install-button");
    await app.waitUntil(() => showsText("install error: npm couldn't write a folder it needs"));
    await app.press("id:fake-terminal-install");
    await app.press("id:this-computer-retry");
    await app.waitUntil(() => !app.shows("id:this-computer-command"));
    expect(app.texts()).toContain("install error: ");
  });

  test("never replaces the command while a host that runs it is running", async () => {
    const { app, sent } = await openPanel();
    await app.waitFor("id:this-computer-pair-button");
    app.onDialog(() => "Run unsandboxed");
    await app.press("id:this-computer-pair-button");
    await app.waitFor("id:local-host-stop-default");
    await app.press("id:fake-old-command");
    await app.press("id:this-computer-add");
    await app.waitFor("id:this-computer-install-button");
    await app.waitFor("id:this-computer-install-hosts-running");
    let refused = "";
    try { await app.press("id:this-computer-install-button"); } catch (error) { refused = String(error); }
    expect(refused.includes("is disabled")).toBe(true);
    expect(sent()).not.toContain("install");
    await app.press("id:local-host-stop-default");
    await app.waitUntil(() => !app.shows("id:this-computer-install-hosts-running"));
    await app.press("id:this-computer-install-button");
    await app.waitUntil(() => sent().includes("install"));
  });

  test("a global install (with no app folder) the login shell can't find afterwards says to put npm's folder on PATH", async () => {
    const { app, showsText } = await openPanel({ command: "missing", npm: "elsewhere" });
    await app.waitFor("id:this-computer-install-button");
    await app.press("id:this-computer-install-button");
    await app.waitFor("id:this-computer-install");
    expect(showsText("npm installed pikibun, but this Mac's login shell doesn't find it.")).toBe(true);
  });

  test("signs Pi in to a provider with an API key on a host's page, then offers only the checked models from that host's next start", async () => {
    const { app, sent, showsText } = await openPanel({ paired: SERVER, piSignedIn: false });
    await app.waitFor("id:local-host-open-default");
    await app.press("id:local-host-open-default");
    await app.waitFor("id:this-computer-start");
    await app.waitUntil(() => showsText("Pi has no models with configured authentication."));
    await app.waitFor("id:this-computer-sign-in-start");
    await app.press("id:this-computer-sign-in-start");
    await app.waitFor("id:this-computer-sign-in-answer");
    await app.type("id:this-computer-sign-in-answer", "sk-ant-secret");
    await app.press("id:this-computer-sign-in-submit");
    await app.waitUntil(() => showsText("Pi is signed in to Anthropic in this Mac. Its models are listed above."));
    expect(sent()).toContain(JSON.stringify({ type: "login", provider: "anthropic", method: "api_key" }));
    expect(sent().some(line => line.includes("\"type\":\"login-answer\"") && line.includes("<13 characters>"))).toBe(true);
    await app.waitFor("id:this-computer-model-anthropic/claude-opus");
    await app.press("id:this-computer-model-anthropic/claude-opus");
    await app.press("id:this-computer-models-save");
    await app.waitUntil(() => showsText("Saved: the host offers these from its next start."));
    expect((JSON.parse(app.storage()[HOSTS_KEY]!) as { models?: unknown }[])[0]?.models).toEqual([{ provider: "anthropic", modelId: "claude-sonnet" }]);
    app.onDialog(() => "Run unsandboxed");
    await app.press("id:this-computer-start");
    await app.waitFor("id:this-computer-stop");
    expect(sent()).toContain(JSON.stringify({ type: "start", server: SERVER, unsandboxedConsent: true, models: [{ provider: "anthropic", modelId: "claude-sonnet" }] }));
    await app.press("id:local-hosts-back");
    await app.waitFor("id:local-host-stop-default");
  });

  test("a host started while npm updates the command keeps the warning until it is stopped, and its next start runs the new command", async () => {
    const { app, sent, showsText } = await openPanel({ paired: SERVER, cliVersion: "0.40.0", reports: "0.38.0", npmMs: 1500 }, {
      [HOSTS_KEY]: JSON.stringify([{ id: "default", server: SERVER, name: "This Mac", sandbox: "none" }]),
    });
    const launched = () => Number(app.texts().find(text => text.startsWith("launches: "))?.slice("launches: ".length));
    await app.waitFor("id:this-computer-install-button");
    await app.press("id:this-computer-install-button");
    app.onDialog(() => "Run unsandboxed");
    await app.press("id:local-host-start-default");
    await app.waitFor("id:local-host-stop-default");
    expect(showsText("npm is installing pikibun")).toBe(true);
    await app.waitUntil(() => sent().includes("install") && !showsText("npm is installing pikibun"));
    expect(app.shows("id:home-command-update")).toBe(true);
    expect(app.shows("id:this-computer-install-hosts-running")).toBe(true);
    const before = launched();
    await app.press("id:local-host-stop-default");
    await app.waitUntil(() => !app.shows("id:home-command-update"));
    await app.press("id:local-host-start-default");
    await app.waitFor("id:local-host-stop-default");
    expect(launched()).toBeGreaterThan(before);
    expect(app.shows("id:home-command-update")).toBe(false);
  });

  test("an update during a sign-in leaves the sign-in to finish, then restarts the host's command", async () => {
    const { app, sent, showsText } = await openPanel({ paired: SERVER, piSignedIn: false, cliVersion: "0.40.0", reports: "0.38.0" });
    const launched = () => Number(app.texts().find(text => text.startsWith("launches: "))?.slice("launches: ".length));
    await app.waitFor("id:local-host-open-default");
    await app.press("id:local-host-open-default");
    await app.waitFor("id:this-computer-sign-in-start");
    await app.press("id:this-computer-sign-in-start");
    await app.waitFor("id:this-computer-sign-in-answer");
    await app.waitFor("id:this-computer-install-button");
    const before = launched();
    await app.press("id:this-computer-install-button");
    await app.waitUntil(() => sent().includes("install") && !showsText("npm is installing pikibun"));
    expect(launched()).toBe(before);
    expect(app.shows("id:home-command-update")).toBe(true);
    await app.type("id:this-computer-sign-in-answer", "sk-ant-secret");
    await app.press("id:this-computer-sign-in-submit");
    await app.waitUntil(() => showsText("Pi is signed in to Anthropic in this Mac."));
    await app.waitUntil(() => launched() > before);
    await app.waitUntil(() => !app.shows("id:home-command-update") && !app.shows("id:this-computer-command"));
  });

  test("with no model in Pi yet, pairing is refused before a code is made, pointing at the sign-in", async () => {
    const { app, sent, showsText } = await openPanel({ piSignedIn: false });
    await app.waitFor("id:this-computer-pair-button");
    await app.waitFor("id:this-computer-sign-in-start");
    await app.press("id:this-computer-pair-button");
    await app.waitUntil(() => showsText("Sign Pi in to a provider below first."));
    expect(sent()).not.toContain("pairing My Mac");
    expect(sent().some(line => line.startsWith("{\"type\":\"start\""))).toBe(false);
    expect(app.dialogs().length).toBe(0);
  });

  test("unchecking every model isn't saved as a choice: the host would offer them all", async () => {
    const { app, showsText } = await openPanel({ paired: SERVER, id: "default" }, { [HOSTS_KEY]: JSON.stringify([{ id: "default", server: SERVER, name: "My Mac", sandbox: "none" }]) });
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
    const { app, sent } = await openPanel({ server: local });
    await app.waitFor("id:this-computer-pair-button");
    app.onDialog(() => "Run unsandboxed");
    await app.press("id:this-computer-pair-button");
    await app.waitFor("id:local-host-stop-default");
    await app.waitUntil(() => sent().filter(line => line === JSON.stringify({ type: "inspect", allowInsecureLoopback: true })).length >= 3);
    await app.press("id:local-host-stop-default");
    await app.press("id:local-host-open-default");
    await app.waitFor("id:this-computer-start");
    expect(app.shows("id:this-computer-repair")).toBe(false);
  });

  test("a host whose pairing can't be used is paired again in place, replacing it", async () => {
    const { app, sent, showsText } = await openPanel({ paired: "https://other.example", id: "default" }, {
      [HOSTS_KEY]: JSON.stringify([{ id: "default", server: SERVER, name: "My Mac", sandbox: "none" }]),
    });
    await app.waitFor("id:this-computer-repair");
    expect(showsText("This host's pairing for pikibun.test can't be used (https://other.example).")).toBe(true);
    app.onDialog(() => "Run unsandboxed");
    await app.press("id:this-computer-pair-button");
    await app.waitFor("id:this-computer-stop");
    expect(sent()).toContain(JSON.stringify({ type: "start", server: SERVER, pairing: { id: PAIRING_ID, code: "<code>" }, replacePairing: true, unsandboxedConsent: true }));
  });

  test("macOS's own sandbox is asked for once chosen, and a host's sandbox changes while it is stopped", async () => {
    const { app, sent } = await openPanel();
    await app.waitFor("id:this-computer-sandbox-choice");
    await app.press("text:macOS sandbox");
    await app.waitUntil(() => sent().includes(JSON.stringify({ type: "inspect", experimentalSandbox: true })));
    const page = await openPanel({ paired: SERVER, id: "default" }, { [HOSTS_KEY]: JSON.stringify([{ id: "default", server: SERVER, name: "My Mac", sandbox: "none" }]) });
    await page.app.waitFor("id:this-computer-sandbox-choice");
    await page.app.press("text:macOS sandbox");
    await page.app.waitUntil(() => page.sent().includes(JSON.stringify({ type: "inspect", experimentalSandbox: true })));
    expect((JSON.parse(page.app.storage()[HOSTS_KEY]!) as { sandbox: string }[])[0]?.sandbox).toBe("seatbelt");
  });

  test("pairs a host with another server the app is signed in to, without switching to it", async () => {
    const { app, sent, showsText } = await openPanel({ servers: [SERVER, "https://team.example"] });
    await app.waitFor("id:this-computer-server-choice");
    await app.press("id:this-computer-server-choice");
    await app.press("text:team.example");
    await app.waitUntil(() => showsText("Pair this Mac with team.example as your host in one step"));
    app.onDialog(() => "Run unsandboxed");
    await app.press("id:this-computer-pair-button");
    await app.waitFor("id:local-host-stop-default");
    expect(sent()).toContain("pairing My Mac for https://team.example");
    expect(sent()).toContain(JSON.stringify({ type: "start", server: "https://team.example", pairing: { id: PAIRING_ID, code: "<code>" }, replacePairing: false, unsandboxedConsent: true }));
    expect(showsText("this computer's hosts: none")).toBe(true);
  });
});

describe("Local hosts on Windows", () => {
  test("two hosts for one server: one in Windows' own sandbox, one in WSL2's", async () => {
    const { app, sent, showsText } = await openPanel({ distros: ["Ubuntu", "Debian"] }, {}, "windows");
    await app.waitFor("id:this-computer-pair-button");
    app.onDialog(() => "Run unsandboxed");
    await app.press("id:this-computer-pair-button");
    await app.waitFor("id:local-host-stop-default");
    expect(sent()).toContain(JSON.stringify({ type: "start", server: SERVER, pairing: { id: PAIRING_ID, code: "<code>" }, replacePairing: false, unsandboxedConsent: true, experimentalSandbox: true }));
    expect(sent()).toContain("pairing My computer");

    await app.press("id:this-computer-add");
    await app.waitFor("id:this-computer-sandbox-choice");
    await app.press("text:WSL2");
    await app.waitFor("id:this-computer-distro");
    await app.press("id:this-computer-distro");
    await app.press("text:Debian");
    await app.waitUntil(() => sent().some(line => line.startsWith("wsl:Debian {\"type\":\"inspect\"")));
    await app.waitUntil(() => sent().includes(`wsl: ${JSON.stringify({ type: "stop" })}`));
    expect(sent().filter(line => line.startsWith("wsl:Debian ")).every(line => !line.includes("experimentalSandbox"))).toBe(true);
    await app.waitUntil(() => showsText("Sandboxed (bubblewrap in WSL (Debian))"));
    const dialogs = app.dialogs().length;
    await app.press("id:this-computer-pair-button");
    await app.waitUntil(() => app.texts().some(text => /^this computer's hosts: c9,c\d+$/.test(text)));
    expect(app.dialogs().length).toBe(dialogs);
    expect(sent()).toContain("pairing My computer (WSL)");
    expect(sent()).toContain(`wsl:Debian ${JSON.stringify({ type: "start", server: SERVER, pairing: { id: PAIRING_ID, code: "<code>" }, replacePairing: false })}`);
    const saved = JSON.parse(app.storage()[HOSTS_KEY]!) as { id: string; sandbox: string; distro?: string; stateDir?: string }[];
    expect(saved.map(item => [item.sandbox, item.distro ?? null, item.stateDir === undefined])).toEqual([["windows", null, true], ["wsl", "Debian", false]]);
    expect(sent()).toContain(`launch wsl:Debian:${saved[1]!.stateDir}`);
    expect(showsText("pikibun.test · Sandboxed (bubblewrap in WSL (Debian))")).toBe(true);
  });

  test("installs Pikibun's command inside WSL when it isn't there, and remembers the version it installed", async () => {
    const { app, sent, showsText } = await openPanel({ wslCommand: "missing", appVersion: "0.36.0" }, { [COMMAND_UPDATED_KEY]: "0.36.0" }, "windows");
    await app.waitFor("id:this-computer-sandbox-choice");
    await app.press("text:WSL2");
    await app.waitFor("id:this-computer-install-button");
    expect(showsText("Install Pikibun's command in WSL")).toBe(true);
    await app.press("id:this-computer-install-button");
    await app.waitUntil(() => !app.shows("id:this-computer-command"));
    expect(sent()).toContain("install wsl:");
    expect(sent()).not.toContain("install");
    expect(app.storage()[`${COMMAND_UPDATED_KEY}:wsl:`]).toBe("0.36.0");
    await app.waitUntil(() => showsText("Sandboxed (bubblewrap in WSL)"));
  });

  test("says how to set up WSL where it has no distribution", async () => {
    const { app, showsText } = await openPanel({ wslCommand: "no-wsl", distros: null }, {}, "windows");
    await app.waitFor("id:this-computer-sandbox-choice");
    await app.press("text:WSL2");
    await app.waitUntil(() => showsText("WSL isn't set up on this computer, or has no distribution yet."));
    await app.waitUntil(() => showsText("WSL isn't set up on this computer. In PowerShell, run wsl --install"));
    expect(app.shows("id:this-computer-install-button")).toBe(false);
  });

  test("lists WSL's distributions again once it is set up, without a restart", async () => {
    const { app } = await openPanel({ distros: null }, {}, "windows");
    await app.waitFor("id:this-computer-sandbox-choice");
    await app.press("text:WSL2");
    await app.waitFor("id:this-computer-distros-refresh");
    await app.press("id:fake-wsl-installed");
    await app.press("id:this-computer-distros-refresh");
    await app.waitUntil(() => !app.shows("id:this-computer-distros-refresh"));
    await app.press("id:this-computer-distro");
    await app.waitFor("text:Ubuntu-24.04");
  });
});

describe("Settings", () => {
  test("puts the Pikibun server's settings and this device's in two sets, with Local hosts in the desktop builds only", async () => {
    const mac = await open("../App.tsx", { network: server(), storage: signedIn, platform: "macos", width: 1280, height: 820 });
    await mac.waitFor("id:session-row-s1");
    await mac.press("id:open-settings");
    await mac.waitFor("id:settings-section-desktop");
    expect(mac.shows("id:settings-group-title-server")).toBe(true);
    expect(mac.shows("text:pikibun.test")).toBe(true);
    expect(mac.shows("text:This Mac")).toBe(true);
    expect(mac.shows("text:Local hosts")).toBe(true);
    for (const id of ["profile", "notifications", "hosts", "workspaces", "self-host", "appearance"]) expect(mac.shows(`id:settings-section-${id}`)).toBe(true);
    expect(mac.shows("id:settings-group-device")).toBe(true);
    await mac.press("id:settings-section-desktop");
    await mac.waitFor("id:settings-this-computer");
    const phone = await open("../App.tsx", { network: server(), storage: signedIn, platform: "ios" });
    await phone.waitFor("id:session-row-s1");
    await phone.press("id:open-settings");
    await phone.waitFor("id:settings-section-profile");
    expect(phone.shows("id:settings-section-desktop")).toBe(false);
    expect(phone.shows("id:settings-section-appearance")).toBe(true);
    expect(phone.shows("text:This device")).toBe(true);
  });
});
