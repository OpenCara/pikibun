import { APT_PACKAGES, MXC_SDK_VERSION, type SetupAction } from "../../../runner/src/desktop-protocol.js";
import { isRecord } from "./requests.js";
import { NVM_INSTALL, WSL_DISTRO } from "./wsl.js";

// What the app does itself to get this computer ready to host, once its owner confirms (a SetupAction): a fixed list,
// each built here from the action's kind alone, never from a command a host or a page sent. Each runs where the owner
// sees it: Apple's installer, a PowerShell window that stays open with its output, or Settings. Pure, so tests run it
// without Electron or Windows.

export type { SetupAction };

/** An action as a page sent it: one of the kinds, apt naming only sandbox packages. */
export function parseSetupAction(value: unknown): SetupAction | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  switch (value.kind) {
    case "xcode-tools": case "git-for-windows": case "mxc-sdk": case "windows-update": case "wsl-install": case "wsl-node":
      return keys.length === 1 ? { kind: value.kind } : undefined;
    case "apt": {
      const packages = value.packages;
      if (keys.length !== 2 || !Array.isArray(packages) || !packages.length || packages.length > APT_PACKAGES.length) return undefined;
      if (!packages.every(item => typeof item === "string" && (APT_PACKAGES as readonly string[]).includes(item))) return undefined;
      return { kind: "apt", packages: [...new Set(packages as string[])] };
    }
    default: return undefined;
  }
}

/** Where the action runs: this computer, and for a WSL2 host, its distribution. */
export interface SetupContext {
  platform: NodeJS.Platform;
  /** Windows hosts in WSL2: the distribution the host runs in, once there is one. */
  distro?: string;
  /** Native Windows: where the app's hosts look for the MXC SDK. */
  mxcRuntime?: string;
}

/** What the app runs: a program (its own window, if any, shows the owner what happens), or a Settings page to open. */
export type SetupStep =
  | { type: "run"; file: string; args: string[]; console: boolean }
  | { type: "open"; url: string };

export interface SetupPlan {
  /** The confirmation dialog's question and what it says will happen. */
  title: string;
  detail: string;
  step: SetupStep;
}

/** A PowerShell single-quoted string: nothing in it is expanded. */
export const psQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/**
 * A PowerShell window that runs `script` and stays open with its output, then says what to do next. Windows passes the
 * script to powershell.exe as one argument; it holds no double quotes, which Windows PowerShell's native argument
 * passing mangles.
 */
function console(script: string): SetupStep {
  const done = "Write-Host ''; Write-Host 'When this is done, close this window and choose Refresh in Pikibun.'";
  const full = `${script}; ${done}`;
  if (full.includes("\"")) throw new Error("Setup scripts hold no double quotes");
  return { type: "run", file: "powershell.exe", args: ["-NoProfile", "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", full], console: true };
}

/**
 * A bash command line run in a WSL2 distribution, in a PowerShell window. --exec hands bash its arguments as they are
 * (without it, WSL joins them for the Linux shell to parse again). No quotes inside, as console() needs.
 */
function inWsl(distro: string, command: string): SetupStep {
  if (!WSL_DISTRO.test(distro) || /['"]/.test(command)) throw new Error("Invalid WSL setup");
  return console(`wsl.exe --distribution ${psQuote(distro)} --exec bash -lc ${psQuote(command)}`);
}

/**
 * What `action` does here, or why it can't: an action for another platform, or a WSL2 one without a distribution, is
 * refused rather than guessed at.
 */
export function setupPlan(action: SetupAction, context: SetupContext): SetupPlan | { error: string } {
  const windows = context.platform === "win32";
  const wrong = { error: "That can't be done on this computer: install it as its description says." };
  switch (action.kind) {
    case "xcode-tools":
      if (context.platform !== "darwin") return wrong;
      return { title: "Install Apple's developer tools?", detail: "macOS shows Apple's installer for the Command Line Tools (Git, Python 3 and more). When it finishes, choose Refresh in Pikibun.",
        step: { type: "run", file: "/usr/bin/xcode-select", args: ["--install"], console: false } };
    case "git-for-windows":
      if (!windows) return wrong;
      return { title: "Install Git for Windows?", detail: "A PowerShell window runs winget install --id Git.Git, which may ask for administrator permission.",
        step: console("winget install --id Git.Git -e --source winget --accept-source-agreements") };
    case "mxc-sdk":
      if (!windows || !context.mxcRuntime) return wrong;
      return { title: "Install Microsoft's MXC SDK?", detail: `A PowerShell window runs npm install @microsoft/mxc-sdk@${MXC_SDK_VERSION} into ${context.mxcRuntime}. It needs Node.js and npm on Windows (https://nodejs.org).`,
        step: console(`npm install --prefix ${psQuote(context.mxcRuntime)} @microsoft/mxc-sdk@${MXC_SDK_VERSION}`) };
    case "windows-update":
      if (!windows) return wrong;
      return { title: "Open Windows Update?", detail: "Settings opens at Windows Update. Install what it offers, restart if it asks, then choose Refresh in Pikibun.", step: { type: "open", url: "ms-settings:windowsupdate" } };
    case "wsl-install":
      if (!windows) return wrong;
      return { title: "Install WSL with Ubuntu?", detail: "Windows asks for administrator permission, then installs WSL and Ubuntu (wsl --install). Restart if it asks, open Ubuntu once from the Start menu to create your Linux user, then choose Refresh in Pikibun.",
        step: console("Start-Process -Verb RunAs -FilePath wsl.exe -ArgumentList '--install'") };
    case "wsl-node":
      if (!windows || !context.distro) return wrong;
      return { title: `Install Node.js 24 in ${context.distro}?`, detail: `A PowerShell window installs nvm (v0.40.3, from GitHub) in WSL2's ${context.distro}, then Node.js 24 with it.`,
        step: inWsl(context.distro, NVM_INSTALL) };
    case "apt":
      if (!windows || !context.distro) return wrong;
      return { title: `Install ${action.packages.join(", ")} in ${context.distro}?`, detail: `A PowerShell window runs sudo apt-get install in WSL2's ${context.distro}, which asks for your Linux password.`,
        step: inWsl(context.distro, `sudo apt-get update && sudo apt-get install -y ${action.packages.join(" ")}`) };
  }
}
