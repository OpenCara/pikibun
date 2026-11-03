import { access, constants } from "node:fs/promises";
import { homedir, release, userInfo } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readConnectorState } from "./connector.js";
import { createFauxLocalModels, loadLocalPiModels, readPiSettings, type LocalModels } from "./local-pi.js";
import type { Prerequisite } from "./desktop-protocol.js";
import { aptFix, fixes, linuxPackages } from "./prerequisite-fixes.js";
import { ConnectorSetupError } from "./protocol.js";
import { bashPath, gitForWindowsRoot, SANDBOX_SHELL_HINT, sandboxNodePath, sandboxShellPath } from "./platform.js";
import { MXC_SDK_VERSION, mxcEntry, mxcInstallHint, windowsRuntimeDirectory } from "./sandbox-backend.js";
import { SANDBOX_EXEC, seatbeltTools } from "./seatbelt.js";
import { windowsBuild, windowsSandboxSupport } from "./windows-sandbox.js";

// Front-end-neutral connector preflight shared by `pikibun connect` and the desktop host. Messages that name CLI flags
// stay in their front end; everything here reads the same in a terminal and in an app.

/** Private connector state shared by every front end, so a machine paired by one is adopted by the other. */
export const defaultStateDir = (): string => join(homedir(), ".local", "share", "pikibun", "connector");

/**
 * Node.js and operating-system rules for the chosen isolation. Linux (and WSL2) runs the bubblewrap sandbox; macOS and
 * native Windows run their experimental sandboxes (`experimentalSandbox`) or, with the owner's consent, none.
 */
export function assertConnectorPlatform(mode: { unsandboxed?: boolean; experimentalSandbox?: boolean } = {}): void {
  if (Number(process.versions.node.split(".")[0]) < 24) throw new ConnectorSetupError(`Node.js 24 or newer is required (found ${process.versions.node}).`);
  if (process.platform === "win32" && !mode.unsandboxed && !mode.experimentalSandbox) {
    throw new ConnectorSetupError("Native Windows has no sandbox by default. The isolated sandbox runs in WSL2: install it (in PowerShell: wsl --install), open the Ubuntu terminal, install Node.js 24, Pi, bubblewrap, Python 3, Git and util-linux there, then run this same command inside WSL2. On Windows 11 24H2 or later with the October 2026 update you can try the native sandbox with --experimental-sandbox, or run without one with --unsafe-no-sandbox.");
  }
  if (process.platform !== "linux" && process.platform !== "darwin" && process.platform !== "win32") throw new ConnectorSetupError(`Unsupported platform "${process.platform}": use Linux, WSL2, macOS or Windows.`);
  if (process.platform === "linux" && mode.experimentalSandbox) throw new ConnectorSetupError("--experimental-sandbox is for macOS and native Windows; Linux runs the bubblewrap sandbox.");
}

const windowsGit = (): Prerequisite[] => [
  { name: "Git for Windows (git on PATH)", ok: gitForWindowsRoot() !== undefined, fix: fixes.gitForWindows },
  { name: "Git for Windows' bash.exe", ok: bashPath() !== undefined, fix: fixes.gitForWindows },
];

/** The binaries the chosen isolation mode needs, each named with where it is looked for. */
export async function checkPrerequisites(unsandboxed: boolean, experimental?: { stateDir: string }): Promise<Prerequisite[]> {
  if (process.platform === "win32") {
    if (unsandboxed || !experimental) return windowsGit();
    const runtime = windowsRuntimeDirectory(experimental.stateDir);
    const found = windowsBuild() ?? release().split(".")[2] ?? "unknown";
    const build = Number(found.split(".")[0]);
    const sdk = mxcEntry(runtime);
    // The CLI's own Node; a desktop app's connector runs on Electron, which can't run the sandbox's steps (sandboxNodePath).
    const node = sandboxNodePath();
    const result: Prerequisite[] = [{ name: "Git for Windows (git on PATH)", ok: gitForWindowsRoot() !== undefined, fix: fixes.gitForWindows },
      { name: `busybox-w32, the sandbox's shell (${SANDBOX_SHELL_HINT}; or set PIKIBUN_SANDBOX_SHELL)`, ok: sandboxShellPath() !== undefined, fix: fixes.busybox },
      ...(process.versions.electron ? [{ name: "Node.js 24 or newer for the sandbox's steps (node on PATH, or set PIKIBUN_SANDBOX_NODE)", ok: node !== undefined, fix: fixes.nodeForWindows }] : []),
      { name: `Windows 11 24H2 or later (build 26100+, found ${found})`, ok: build >= 26100, fix: fixes.windowsUpdate },
      { name: `Microsoft MXC SDK ${MXC_SDK_VERSION} in ${runtime} (install: ${mxcInstallHint(runtime)})`, ok: sdk !== undefined, fix: fixes.mxcSdk(runtime) }];
    // The update level decides whether sessions can work, and its number differs between releases (25H2 is 26200.x,
    // 26H2 26300.x), so Windows is asked: one container with a session's network policy, resolving a path in it.
    if (sdk && node && build >= 26100) {
      const support = await windowsSandboxSupport(sdk, node);
      result.push(
        { name: `Windows' process container for sessions, with proxy-only egress (MXC's base-container tier)${support.container ? "" : `: ${support.detail}`}`, ok: support.container, fix: fixes.windowsUpdate },
        { name: `Paths that Git and Node resolve inside the container (Windows' October 2026 update or later: install the latest Windows update)${support.container && !support.paths ? `: ${support.detail}` : ""}`, ok: support.paths, fix: fixes.windowsUpdate });
    }
    return result;
  }
  const required: Record<string, string> = unsandboxed
    ? process.platform === "linux" ? { "/usr/bin/flock": "flock (util-linux)" } : { "/usr/bin/lockf": "lockf" }
    : process.platform === "darwin" ? { [SANDBOX_EXEC]: "sandbox-exec", "/usr/bin/lockf": "lockf" }
    : { "/usr/bin/bwrap": "bubblewrap", "/usr/bin/python3": "Python 3", "/usr/bin/git": "Git", "/usr/bin/flock": "flock (util-linux)" };
  const executable = (path: string) => access(path, constants.X_OK).then(() => true, () => false);
  const result: Prerequisite[] = [];
  for (const [binary, name] of Object.entries(required)) {
    result.push({ name: `${name} (${binary})`, ok: await executable(binary) });
  }
  if (process.platform === "darwin" && !unsandboxed) {
    let tools = true;
    try { seatbeltTools(); } catch { tools = false; }
    result.push({ name: "Python 3 and Git from the developer tools (xcode-select --install)", ok: tools, fix: fixes.xcodeTools });
  }
  // Unsandboxed sessions use the owner's Git from PATH, e.g. Xcode tools or Homebrew on macOS.
  if (unsandboxed) result.push({ name: "Git on PATH", ok: spawnSync("git", ["--version"], { stdio: "ignore", env: { PATH: process.env.PATH ?? "" } }).status === 0,
    ...(process.platform === "darwin" ? { fix: fixes.xcodeTools } : {}) });
  if (process.platform === "linux") {
    // Every missing package in one fix: Git on PATH counts as the git package.
    const missing = Object.entries(required).filter((_, index) => !result[index]!.ok).map(([binary]) => linuxPackages[binary]!);
    if (unsandboxed && !result.at(-1)!.ok) missing.push("git");
    const fix = aptFix(missing, await executable("/usr/bin/apt-get"));
    for (const item of result) if (!item.ok) item.fix = fix;
  }
  return result;
}

/** Fails with the missing prerequisites; `sandboxHint` offers the unsandboxed mode where the front end has one. */
export function assertPrerequisites(prerequisites: readonly Prerequisite[], unsandboxed: boolean, sandboxHint: string): void {
  const missing = prerequisites.filter(item => !item.ok).map(item => item.name);
  if (!missing.length) return;
  const hint = process.platform === "darwin" ? " Install Git, e.g. xcode-select --install or brew install git."
    : process.platform === "win32" ? (missing.some(name => name.startsWith("Git for Windows")) ? " Install Git for Windows from https://git-scm.com/download/win." : "")
    : unsandboxed ? "" : sandboxHint;
  throw new ConnectorSetupError(`Missing prerequisites: ${missing.join(", ")}.${hint}`);
}

export interface ModelChoice {
  /** Fixture models only; never combined with personal Pi configuration. */
  allowFaux?: boolean;
  piAgentDir?: string;
  /** Explicit subset; without it Pi's enabledModels setting, else every authenticated model, is advertised. */
  models?: readonly { provider: string; modelId: string }[];
}

/** The local models this machine would advertise, read from Pi's own settings and authentication. */
export async function loadConnectorModels(choice: ModelChoice): Promise<LocalModels> {
  if (choice.allowFaux && (choice.piAgentDir || choice.models)) throw new ConnectorSetupError("Fixture mode cannot select personal Pi models.");
  if (choice.allowFaux) return createFauxLocalModels();
  const settings = await readPiSettings(choice.piAgentDir).catch(error => {
    throw new ConnectorSetupError(`Pi settings could not be read: ${error instanceof SyntaxError ? "settings.json is not valid JSON" : error instanceof Error ? error.message : "unknown error"}.`);
  });
  const enabledModels = choice.models ? undefined : settings.enabledModels;
  const localModels = await loadLocalPiModels({ agentDir: choice.piAgentDir, models: choice.models, enabledModels,
    defaultThinkingLevel: settings.defaultThinkingLevel, modelThinkingLevels: settings.modelThinkingLevels,
    compaction: settings.compaction, attribution: settings.attribution });
  if (!(await localModels.manifest()).length) throw new ConnectorSetupError(enabledModels
    ? "None of the models enabled in Pi's settings.json (enabledModels) are authenticated on this machine."
    : "No authenticated local Pi models are configured. Configure a provider and model in Pi on this machine first.");
  return localModels;
}

/** The sandbox a host's sessions run in: bubblewrap (Linux, WSL2), or macOS's or Windows' own (experimental). */
export type SandboxKind = "bubblewrap" | "seatbelt" | "windows";

export interface HostIsolation {
  mode: "sandboxed" | "unsandboxed";
  /** Set when sandboxed. */
  sandbox?: SandboxKind;
  /** The sandbox's own prerequisites, present even when some are missing. */
  sandboxPrerequisites?: Prerequisite[];
  /** The chosen mode's prerequisites. */
  prerequisites: Prerequisite[];
}

/**
 * Sandboxed on Linux with every sandbox prerequisite and, with `experimental`, on macOS and native Windows with every
 * prerequisite of their own sandbox; anything else runs unsandboxed after explicit consent.
 */
export async function hostIsolation(experimental?: { stateDir: string }): Promise<HostIsolation> {
  const native = process.platform === "darwin" || process.platform === "win32";
  if (process.platform !== "linux" && !(native && experimental)) return { mode: "unsandboxed", prerequisites: await checkPrerequisites(true) };
  const sandboxPrerequisites = await checkPrerequisites(false, process.platform === "linux" ? undefined : experimental);
  const sandbox: SandboxKind = process.platform === "linux" ? "bubblewrap" : process.platform === "darwin" ? "seatbelt" : "windows";
  return sandboxPrerequisites.every(item => item.ok)
    ? { mode: "sandboxed", sandbox, sandboxPrerequisites, prerequisites: sandboxPrerequisites }
    : { mode: "unsandboxed", sandboxPrerequisites, prerequisites: await checkPrerequisites(true) };
}

/** The control-plane origin this state directory is paired with, if any. */

export async function savedPairing(dataDir: string, allowInsecureLoopback = false): Promise<string | undefined> {
  return (await readConnectorState(dataDir, undefined, allowInsecureLoopback))?.controlPlaneUrl;
}

export function unsandboxedWarning(): string {
  return `
WARNING: running WITHOUT a sandbox (--unsafe-no-sandbox).
Agent work for sessions on this host runs directly as "${userInfo().username}" on this machine:
  - Approved shell commands and commits run with your full user permissions. They can read
    and change anything you can, including ~/.ssh, cloud and Git credentials and Pi's auth.
  - Commands have unrestricted network access and no CPU, memory or disk limits.
  - File tools are confined to each session folder by path checks only, not isolation.
  - Prompts and repository content can try to trick the agent. Read every command in the
    approval desk before approving it.
  - Anyone you share this Pi with, and anyone granted approve permission on a session that
    runs here, can cause approved commands to run on this machine.
  - A session owner who turns on Auto-approve in the chat box lets their agent run
    commands and commits here immediately, with no per-command approval.
Pikibun shows this host as "Unsandboxed" to everyone who can see it.

`;
}
