import type { PrerequisiteFix } from "./desktop-protocol.js";
import { MXC_SDK_VERSION, mxcInstallHint } from "./sandbox-backend.js";

// How to get what a host lacks (connect-setup.ts checkPrerequisites): advice the CLI and the apps show alike, and the
// action a desktop app may take for its owner (desktop-protocol.ts SetupAction). Pure, so tests read it without Pi.

/** How to get each missing prerequisite: the same advice in a terminal (its command) and in the app (its action). */
export const fixes = {
  gitForWindows: { text: "Install Git for Windows.", command: "winget install --id Git.Git -e --source winget", url: "https://git-scm.com/download/win", action: { kind: "git-for-windows" } },
  nodeForWindows: { text: "Install Node.js 24 or newer for Windows (the sandbox runs its steps on it, and npm installs the MXC SDK).", command: "winget install --id OpenJS.NodeJS.LTS -e --source winget", url: "https://nodejs.org", action: { kind: "node-for-windows" } },
  busybox: { text: "Download busybox64.exe and save it as %LOCALAPPDATA%\\Programs\\busybox\\busybox.exe.", url: "https://frippery.org/busybox/" },
  windowsUpdate: { text: "Install the latest Windows update (Windows 11 24H2 or later, with the October 2026 update).", action: { kind: "windows-update" } },
  mxcSdk: (runtime: string): PrerequisiteFix => ({ text: `Install Microsoft's MXC SDK ${MXC_SDK_VERSION} with npm (it needs Node.js on Windows).`, command: mxcInstallHint(runtime), url: "https://github.com/microsoft/mxc", action: { kind: "mxc-sdk" } }),
  xcodeTools: { text: "Install Apple's developer tools (the Command Line Tools), which bring Git and Python 3.", command: "xcode-select --install", action: { kind: "xcode-tools" } },
} satisfies Record<string, PrerequisiteFix | ((runtime: string) => PrerequisiteFix)>;

/** Debian and Ubuntu packages of the Linux binaries the connector checks. */
export const linuxPackages: Record<string, string> = { "/usr/bin/bwrap": "bubblewrap", "/usr/bin/python3": "python3", "/usr/bin/git": "git", "/usr/bin/flock": "util-linux" };

/**
 * Linux: one fix for every missing package, with apt where the system has it (Debian, Ubuntu, and so WSL2's default),
 * so installing from any missing item installs them all.
 */
export function aptFix(packages: readonly string[], apt: boolean): PrerequisiteFix {
  const list = [...new Set(packages)];
  return apt
    ? { text: `Install ${list.join(", ")} with apt.`, command: `sudo apt install ${list.join(" ")}`, action: { kind: "apt", packages: list } }
    : { text: `Install ${list.join(", ")} with this system's package manager.` };
}
