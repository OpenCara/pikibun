import type { PrerequisiteFix } from "./app-host-protocol.js";
import { MXC_SDK_VERSION, mxcInstallHint } from "./sandbox-backend.js";

export const fixes = {
  gitForWindows: { text: "Install Git for Windows.", command: "winget install --id Git.Git -e --source winget", url: "https://git-scm.com/download/win", action: { kind: "git-for-windows" } },
  busybox: { text: "Download busybox64.exe and save it as %LOCALAPPDATA%\\Programs\\busybox\\busybox.exe.", url: "https://frippery.org/busybox/" },
  windowsUpdate: { text: "Install the latest Windows update (Windows 11 24H2 or later, with the October 2026 update).", action: { kind: "windows-update" } },
  mxcSdk: (runtime: string): PrerequisiteFix => ({ text: `Install Microsoft's MXC SDK ${MXC_SDK_VERSION} with npm (it needs Node.js on Windows).`, command: mxcInstallHint(runtime), url: "https://github.com/microsoft/mxc", action: { kind: "mxc-sdk" } }),
  xcodeTools: { text: "Install Apple's developer tools (the Command Line Tools), which bring Git and Python 3.", command: "xcode-select --install", action: { kind: "xcode-tools" } },
  node: (platform: NodeJS.Platform): PrerequisiteFix => platform === "darwin"
    ? { text: "Install Node.js, which brings npm, to install extensions from npm or Git: with Homebrew, or the macOS installer from nodejs.org. Then quit and reopen Pikibun, which reads your PATH as it starts its hosts.", command: "brew install node", url: "https://nodejs.org/en/download" }
    : platform === "win32"
    ? { text: "Install Node.js, which brings npm, to install extensions from npm or Git. Then quit and reopen Pikibun.", command: "winget install OpenJS.NodeJS.LTS", url: "https://nodejs.org/en/download" }
    : { text: "Install Node.js and npm to install extensions from npm or Git. Then quit and reopen Pikibun.", url: "https://nodejs.org/en/download" },
} satisfies Record<string, PrerequisiteFix | ((runtime: string) => PrerequisiteFix) | ((platform: NodeJS.Platform) => PrerequisiteFix)>;

export const linuxPackages: Record<string, string> = { "/usr/bin/bwrap": "bubblewrap", "/usr/bin/python3": "python3", "/usr/bin/git": "git", "/usr/bin/flock": "util-linux" };

export function aptFix(packages: readonly string[], apt: boolean): PrerequisiteFix {
  const list = [...new Set(packages)];
  return apt
    ? { text: `Install ${list.join(", ")} with apt.`, command: `sudo apt install ${list.join(" ")}`, action: { kind: "apt", packages: list } }
    : { text: `Install ${list.join(", ")} with this system's package manager.` };
}
