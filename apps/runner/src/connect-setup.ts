import { access, constants } from "node:fs/promises";
import { homedir, release, userInfo } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readConnectorState } from "./connector.js";
import { createFauxLocalModels, loadLocalPiModels, readPiSettings, type LocalModels } from "./local-pi.js";
import type { Prerequisite, PrerequisiteFix } from "../../../packages/shared/src/app-host-protocol.js";
import { aptFix, fixes, linuxPackages } from "./prerequisite-fixes.js";
import { ConnectorSetupError } from "./protocol.js";
import { bashPath, gitForWindowsRoot, SANDBOX_SHELL_HINT, sandboxNodePath, sandboxShellPath } from "./platform.js";
import { MXC_SDK_VERSION, mxcEntry, mxcInstallHint, windowsRuntimeDirectory } from "./sandbox-backend.js";
import { SANDBOX_EXEC, seatbeltTools } from "./seatbelt.js";
import { windowsBuild, windowsSandboxSupport } from "./windows-sandbox.js";

export const defaultStateDir = (): string => join(homedir(), ".local", "share", "pikibun", "connector");

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

export async function checkPrerequisites(unsandboxed: boolean, experimental?: { stateDir: string }): Promise<Prerequisite[]> {
  if (process.platform === "win32") {
    if (unsandboxed || !experimental) return windowsGit();
    const runtime = windowsRuntimeDirectory(experimental.stateDir);
    const found = windowsBuild() ?? release().split(".")[2] ?? "unknown";
    const build = Number(found.split(".")[0]);
    const sdk = mxcEntry(runtime);
    const node = sandboxNodePath();
    const result: Prerequisite[] = [{ name: "Git for Windows (git on PATH)", ok: gitForWindowsRoot() !== undefined, fix: fixes.gitForWindows },
      { name: `busybox-w32, the sandbox's shell (${SANDBOX_SHELL_HINT}; or set PIKIBUN_SANDBOX_SHELL)`, ok: sandboxShellPath() !== undefined, fix: fixes.busybox },
      { name: `Windows 11 24H2 or later (build 26100+, found ${found})`, ok: build >= 26100, fix: fixes.windowsUpdate },
      { name: `Microsoft MXC SDK ${MXC_SDK_VERSION} in ${runtime} (install: ${mxcInstallHint(runtime)})`, ok: sdk !== undefined, fix: fixes.mxcSdk(runtime) }];
    if (sdk && build >= 26100) {
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
  if (unsandboxed) result.push({ name: "Git on PATH", ok: spawnSync("git", ["--version"], { stdio: "ignore", env: { PATH: process.env.PATH ?? "" } }).status === 0,
    ...(process.platform === "darwin" ? { fix: fixes.xcodeTools } : {}) });
  if (process.platform === "linux") {
    const missing = Object.entries(required).filter((_, index) => !result[index]!.ok).map(([binary]) => linuxPackages[binary]!);
    if (unsandboxed && !result.at(-1)!.ok) missing.push("git");
    const fix = aptFix(missing, await executable("/usr/bin/apt-get"));
    for (const item of result) if (!item.ok) item.fix = fix;
    if (!unsandboxed && result.every(item => item.ok)) result.push(bubblewrapPrerequisite());
  }
  return result;
}

export const BUBBLEWRAP_PROBE = ["--unshare-all", "--unshare-user", "--disable-userns", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
  "--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib", "--ro-bind-try", "/lib64", "/lib64", "--symlink", "usr/bin", "/bin",
  "--proc", "/proc", "--dev", "/dev", "--", "/usr/bin/python3", "-I", "-c", ""] as const;

export interface BubblewrapProbe {
  run(): { status: number | null; stderr: string; error?: Error };
  sysctl(name: string): string | undefined;
}

const hostProbe: BubblewrapProbe = {
  run: () => {
    const probe = spawnSync("/usr/bin/bwrap", BUBBLEWRAP_PROBE, { encoding: "utf8", timeout: 15_000, env: { PATH: "/usr/bin:/bin" } });
    return { status: probe.status, stderr: probe.stderr ?? "", ...(probe.error ? { error: probe.error } : {}) };
  },
  sysctl: name => { try { return readFileSync(`/proc/sys/${name.replaceAll(".", "/")}`, "utf8").trim(); } catch { return undefined; } },
};

export function bubblewrapFix(sysctl: BubblewrapProbe["sysctl"]): PrerequisiteFix {
  if (sysctl("kernel.apparmor_restrict_unprivileged_userns") === "1") return {
    text: "AppArmor stops bubblewrap from making user namespaces (Ubuntu 23.10 and later). Allow them, then start again; to keep the setting after a restart, put kernel.apparmor_restrict_unprivileged_userns=0 in a file under /etc/sysctl.d.",
    command: "sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0" };
  if (sysctl("kernel.unprivileged_userns_clone") === "0") return {
    text: "This kernel doesn't let users make user namespaces. Allow them, then start again; to keep the setting after a restart, put kernel.unprivileged_userns_clone=1 in a file under /etc/sysctl.d.",
    command: "sudo sysctl -w kernel.unprivileged_userns_clone=1" };
  if (sysctl("user.max_user_namespaces") === "0") return {
    text: "user.max_user_namespaces is 0, so no user namespace can be made. Raise it, then start again; to keep the setting after a restart, put it in a file under /etc/sysctl.d.",
    command: "sudo sysctl -w user.max_user_namespaces=15000" };
  return { text: "Let bubblewrap make user namespaces on this machine. In a container or a VM that forbids them, allow them there, or run the connector without the sandbox (--unsafe-no-sandbox) after reading its warning." };
}

export function bubblewrapPrerequisite(probe: BubblewrapProbe = hostProbe): Prerequisite {
  const result = probe.run();
  if (result.status === 0) return { name: "bubblewrap can make the sandbox", ok: true };
  const said = (result.error?.message ?? result.stderr).replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 200)
    || (result.status === null ? "it didn't finish" : `it exited with ${result.status}`);
  const fix: PrerequisiteFix = /unknown option|unrecognized option/i.test(said)
    ? { text: "This bubblewrap is too old for the sandbox: install bubblewrap 0.8 or newer." }
    : bubblewrapFix(probe.sysctl);
  return { name: `bubblewrap can make the sandbox (it can't here: ${said})`, ok: false, fix };
}

export function npmPrerequisite(platform: NodeJS.Platform = process.platform, path = process.env.PATH ?? ""): Prerequisite {
  const found = spawnSync(platform === "win32" ? "npm.cmd" : "npm", ["--version"], { stdio: "ignore", timeout: 15_000, windowsHide: true,
    shell: platform === "win32", env: { ...process.env, PATH: path } }).status === 0;
  return { name: "Node.js and npm on PATH, to install extensions from npm or Git", ok: found, optional: true, ...(found ? {} : { fix: fixes.node(platform) }) };
}

export function pythonVenvPrerequisite(platform: NodeJS.Platform = process.platform, python = "/usr/bin/python3",
  apt = existsSync("/usr/bin/apt-get")): Prerequisite | undefined {
  if (platform !== "linux") return undefined;
  const found = spawnSync(python, ["-I", "-c", "import ensurepip, venv"], { stdio: "ignore", timeout: 15_000, env: { PATH: "/usr/bin:/bin" } }).status === 0;
  return { name: "Python's venv and ensurepip (python3-venv), for the python tool's virtual environments", ok: found, optional: true,
    ...(found ? {} : { fix: aptFix(["python3-venv"], apt) }) };
}

export function assertPrerequisites(prerequisites: readonly Prerequisite[], unsandboxed: boolean, sandboxHint: string): void {
  const missing = prerequisites.filter(item => !item.ok && !item.optional).map(item => item.name);
  if (!missing.length) return;
  const hint = process.platform === "darwin" ? " Install Git, e.g. xcode-select --install or brew install git."
    : process.platform === "win32" ? (missing.some(name => name.startsWith("Git for Windows")) ? " Install Git for Windows from https://git-scm.com/download/win." : "")
    : unsandboxed ? "" : sandboxHint;
  const fixes = [...new Set(prerequisites.filter(item => !item.ok && !item.optional && item.fix)
    .map(({ fix }) => `${fix!.text}${fix!.command ? ` (${fix!.command})` : ""}`))];
  throw new ConnectorSetupError(`Missing prerequisites: ${missing.join(", ")}.${fixes.map(text => ` ${text}`).join("")}${hint}`);
}

export interface ModelChoice {
  allowFaux?: boolean;
  piAgentDir?: string;
  models?: readonly { provider: string; modelId: string }[];
}

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

export type SandboxKind = "bubblewrap" | "seatbelt" | "windows";

export interface HostIsolation {
  mode: "sandboxed" | "unsandboxed";
  sandbox?: SandboxKind;
  sandboxPrerequisites?: Prerequisite[];
  prerequisites: Prerequisite[];
}

export async function hostIsolation(experimental?: { stateDir: string }): Promise<HostIsolation> {
  const native = process.platform === "darwin" || process.platform === "win32";
  if (process.platform !== "linux" && !(native && experimental)) return { mode: "unsandboxed", prerequisites: await checkPrerequisites(true) };
  const sandboxPrerequisites = await checkPrerequisites(false, process.platform === "linux" ? undefined : experimental);
  const sandbox: SandboxKind = process.platform === "linux" ? "bubblewrap" : process.platform === "darwin" ? "seatbelt" : "windows";
  return sandboxPrerequisites.every(item => item.ok)
    ? { mode: "sandboxed", sandbox, sandboxPrerequisites, prerequisites: sandboxPrerequisites }
    : { mode: "unsandboxed", sandboxPrerequisites, prerequisites: await checkPrerequisites(true) };
}

export async function savedPairing(dataDir: string, allowInsecureLoopback = false): Promise<string | undefined> {
  return (await readConnectorState(dataDir, undefined, allowInsecureLoopback))?.controlPlaneUrl;
}

export function unsandboxedWarning(): string {
  return `
WARNING: running WITHOUT a sandbox (--unsafe-no-sandbox).
Agent work for sessions on this host runs directly as "${userInfo().username}" on this machine:
  - Shell commands and commits run with your full user permissions, as soon as the agent
    calls them: nobody approves them one by one. They can read and change anything you can,
    including ~/.ssh, cloud and Git credentials and Pi's auth.
  - Commands have unrestricted network access and no CPU, memory or disk limits.
  - File tools are confined to each session folder by path checks only, not isolation.
  - Prompts and repository content can try to trick the agent.
  - Only you, and members you grant host commands, run commands here; everyone else's
    sessions on this host are refused them.
Pikibun shows this host as "Unsandboxed" to everyone who can see it.

`;
}
