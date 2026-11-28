import { readFile } from "fs/promises";
import { platform, signal, Storage, untracked, type Signal } from "nsh";
import nshProcess from "process";
import { APP_VERSION, CLI_VERSION } from "../app-version";
import type {
  HostEvent, HostInspection, HostRequest, HostState, LocalPage, LocalView, LoginEvent, LoginMethodType, LoginPrompt, LoginProvider,
} from "../../../../packages/shared/src/app-host-protocol";
import {
  appCliFolder, CommandChannel, commandDirectory, commandProblem, commandVersion, installCommand, NVM_INSTALL, parseWslList, pikibunCommand, plainOutput, spawnPikibun, WSL, WSL_DISTRO,
  wslInstallCommand, type CommandLink, type CommandTarget, type LaunchProblem, type LogLine,
} from "./pikibun-command";
import { auth } from "./auth";
import { compareVersions, isVersion } from "./version";
import { lastLines } from "./windows-cmd";

export { appCliFolder, INSTALL_COMMAND, installCommand, NVM_INSTALL, parseWslList, wslInstallCommand, wslPikibunCommand } from "./pikibun-command";
export type { LaunchProblem, LogLine } from "./pikibun-command";

export const hostsHere = platform.os === "macos" || platform.os === "windows" || platform.os === "linux";
export const computerTitle = platform.os === "macos" ? "This Mac" : "This Computer";
export const computerName = platform.os === "macos" ? "this Mac" : "this computer";

const HOST_ARGS = ["host", "--stdio"];
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const LIST_TIMEOUT_MS = 20_000;
const LOG_LIMIT = 200;
const NOTICES = 20;
const LOCAL_READ_MS = 5_000;
const CONNECTORS_KEPT = 20;

export function hostCommand(os: string, shell: string | undefined, cli?: string | null): { command: string; args: string[] } {
  return pikibunCommand(os, shell, cli, HOST_ARGS);
}

export function hostArgs(stateDir?: string): string[] {
  return stateDir ? [...HOST_ARGS, "--state-dir", stateDir] : [...HOST_ARGS];
}

const PLAIN_HOST = /^[a-z0-9][a-z0-9.-]{0,99}$/;
const HOST_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const CONNECTOR_ID = /^[A-Za-z0-9_-]{1,128}$/;

function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, "0");
}

export function serverStateDir(server: string): string {
  let url: URL | undefined;
  try { url = new URL(server); } catch { url = undefined; }
  const hostname = url?.hostname.toLowerCase() ?? "";
  if (url && url.protocol === "https:" && !url.port && PLAIN_HOST.test(hostname)) return `~/.local/share/pikibun/servers/${hostname}`;
  const readable = url ? `${url.protocol === "https:" ? "" : "http-"}${hostname}${url.port ? `-${url.port}` : ""}` : server.toLowerCase();
  const name = readable.replace(/[^a-z0-9.-]+/g, "-").replace(/-{2,}/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 80) || "server";
  return `~/.local/share/pikibun/servers/${name}-${shortHash(url?.origin ?? server)}`;
}

export const hostStateDir = (id: string) => `~/.local/share/pikibun/hosts/${id}`;

export type LocalSandbox = "none" | "seatbelt" | "windows" | "wsl" | "bubblewrap";

export function sandboxChoices(os: string = platform.os): LocalSandbox[] {
  return os === "macos" ? ["none", "seatbelt"] : os === "windows" ? ["windows", "wsl"] : ["bubblewrap"];
}

export const sandboxNames: Record<LocalSandbox, string> = {
  none: "No sandbox", seatbelt: "macOS sandbox", windows: "Windows sandbox", wsl: "WSL2", bubblewrap: "bubblewrap",
};

export type HostTarget = CommandTarget;

export function targetOf(config: { sandbox: LocalSandbox; distro?: string }): HostTarget {
  return config.sandbox === "wsl" ? { wsl: config.distro ? { distro: config.distro } : {} } : {};
}

export const environmentKey = (target: HostTarget) => (target.wsl ? `wsl:${target.wsl.distro ?? ""}` : "native");

export type HostLink = CommandLink;
export type HostLauncher = (args: string[], target: HostTarget) => HostLink;

export const spawnHost: HostLauncher = (args, target) => spawnPikibun(args, target);

let launcher: HostLauncher = spawnHost;
export function setHostLauncher(next: HostLauncher): void { launcher = next; }

export interface InstallRun {
  line: string;
  where: "app" | "global" | "wsl";
  onOutput(listener: (line: string) => void): void;
  onExit(listener: (result: { code?: number | null; error?: string | null }) => void): void;
}

export type Installer = (target: HostTarget, version?: string) => InstallRun;

export const spawnInstall: Installer = (target, version = CLI_VERSION) => {
  const cli = target.wsl ? null : appCliFolder(platform.os, nshProcess.dataDir);
  const { command, args, line } = target.wsl ? wslInstallCommand(target.wsl.distro, version) : installCommand(platform.os, nshProcess.env.SHELL, cli, version);
  const cwd = commandDirectory();
  const child = nshProcess.spawn(command, args, { lines: true, timeoutMs: INSTALL_TIMEOUT_MS, ...(cwd ? { cwd } : {}) });
  return {
    line,
    where: target.wsl ? "wsl" : cli ? "app" : "global",
    onOutput: listener => { const say = (text: string) => listener(plainOutput(text)); child.on("stdout", say); child.on("stderr", say); },
    onExit: listener => { child.on("exit", result => listener(result)); },
  };
};

let installer: Installer = spawnInstall;
export function setInstaller(next: Installer): void { installer = next; }

export type WslLister = () => Promise<string[] | null>;

export const listWsl: WslLister = async () => {
  try {
    const output = await nshProcess.run(WSL, ["--list", "--quiet"], { timeoutMs: LIST_TIMEOUT_MS });
    return output.code === 0 ? parseWslList(output.stdout) : null;
  } catch { return null; }
};

let wslLister: WslLister = listWsl;
export function setWslLister(next: WslLister): void { wslLister = next; }

const wslDistros = signal<string[] | null | undefined>(undefined);
let listingWsl: Promise<void> | undefined;
export function wslDistributions(): string[] | null | undefined {
  if (platform.os === "windows") listingWsl ??= wslLister().catch(() => null).then(list => wslDistros.set(list));
  return wslDistros();
}

export function relistWsl(): void {
  listingWsl = undefined;
  wslDistros.set(undefined);
}

export const COMMAND_UPDATED_KEY = "pikibun.commandUpdatedFor";

export function ownCopyManifest(os: string, cli: string): string {
  return [cli, "node_modules", "pikibun", "package.json"].join(os === "windows" ? "\\" : "/");
}

async function ownCopyVersion(): Promise<string | null> {
  const cli = appCliFolder(platform.os, nshProcess.dataDir);
  if (!cli) return null;
  let text: string;
  try { text = await readFile(ownCopyManifest(platform.os, cli), "utf8"); }
  catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
  try {
    const manifest = JSON.parse(text) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : "";
  } catch { return ""; }
}

export interface CommandUpdate {
  appVersion: string;
  ownCopy(): Promise<string | null>;
  cliVersion?: string;
  commandVersion?(target: HostTarget): Promise<string | null>;
  latest?(): Promise<string | null>;
}

export const NPM_LATEST = "https://registry.npmjs.org/pikibun/latest";

export async function npmLatest(): Promise<string | null> {
  const response = await fetch(NPM_LATEST, { headers: { Accept: "application/json", "User-Agent": "Pikibun-App" } });
  if (!response.ok) throw new Error(`npm answered ${response.status}.`);
  const body = await response.json() as { version?: unknown };
  return typeof body.version === "string" && isVersion(body.version) ? body.version : null;
}

const defaultUpdate: CommandUpdate = { appVersion: APP_VERSION, ownCopy: ownCopyVersion, cliVersion: CLI_VERSION, commandVersion, latest: npmLatest };
let commandUpdate: CommandUpdate = defaultUpdate;
export function setCommandUpdate(next: CommandUpdate): void { commandUpdate = next; }

export interface StaleCommand { version: string; wanted: string }

export const COMMAND_AUTO_UPDATE_KEY = "pikibun.commandAutoUpdate";
export const COMMAND_AUTO_VERSION_KEY = "pikibun.commandAutoUpdatedTo";
const AUTO_FIRST_CHECK_MS = 60_000;
const AUTO_CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

export const commandAutoUpdate = signal(false);
export const commandAutoCheck = signal<{ at: number; latest?: string; error?: string } | null>(null);
export const commandAutoChecking = signal(false);
const autoVersion = signal<string | null>(null);
let autoLoading: Promise<void> | undefined;

function loadAutoUpdate(): Promise<void> {
  autoLoading ??= Promise.all([Storage.getItem(COMMAND_AUTO_UPDATE_KEY).catch(() => null), Storage.getItem(COMMAND_AUTO_VERSION_KEY).catch(() => null)])
    .then(([on, version]) => {
      commandAutoUpdate.set(on === "on");
      autoVersion.set(version && isVersion(version) ? version : null);
    });
  return autoLoading;
}

function packageVersion(): string | undefined {
  const auto = untracked(commandAutoUpdate) ? untracked(autoVersion) : null;
  const shipped = commandUpdate.cliVersion;
  return auto && (shipped === undefined || !isVersion(shipped) || compareVersions(auto, shipped) === 1) ? auto : undefined;
}

interface CommandUser { kind: "host" | "server"; running(): boolean; restart(): Promise<void> }

type InstallResult = { code?: number | null; error?: string | null };

export const wslName = (distro?: string) => (distro ? `WSL (${distro})` : "WSL");

export function wslProblem(text: string, distro?: string): string | undefined {
  if (/no installed distributions|has not been enabled|is not installed|WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED|0x8007019e/i.test(text)) {
    return "WSL isn't set up on this computer. In PowerShell, run wsl --install, restart if Windows asks, and open Ubuntu once to create your Linux user; then choose Refresh.";
  }
  if (/no distribution with the supplied name|WSL_E_DISTRO_NOT_FOUND/i.test(text)) return `WSL has no distribution named ${distro ?? "that"} any more. Add a host for another one.`;
  return undefined;
}

export function installFailure(lines: readonly string[], result: InstallResult, target: HostTarget = {}): string {
  const text = lines.join("\n");
  if (target.wsl) {
    const wsl = wslProblem(text, target.wsl.distro);
    if (wsl) return wsl;
    if (result.code === 127 || /npm: (command )?not found/i.test(text)) {
      return `npm isn't installed in ${wslName(target.wsl.distro)}. Install Node.js 24 or newer there, for example with nvm (${NVM_INSTALL}), then choose Install again.`;
    }
  }
  const node = `Node.js 24 or newer (from nodejs.org${platform.os === "macos" ? ", or brew install node" : ""})`;
  if (!target.wsl && (result.code === 127 || result.code === 9009 || /npm: (command )?not found|not found: npm|'npm' is not recognized/i.test(text))) {
    return `npm isn't installed on ${computerName}. Install ${node}, then choose Install again.`;
  }
  if (/\bEACCES\b|\bEPERM\b|permission denied/i.test(text)) {
    const chown = /sudo chown -R [^\s"]+ "[^"\n]+"/.exec(text)?.[0];
    const where = target.wsl ? wslName(target.wsl.distro) : computerName;
    if (chown) return `npm's cache in ${where} has files it can't write, left by an earlier sudo npm. Fix them in a terminal with ${chown}, then choose Install again.`;
    return `npm couldn't write a folder it needs in ${where}: permission denied. Run the command below in a terminal${platform.os === "windows" && !target.wsl ? " as administrator" : " with sudo in front"}, then choose Refresh.`;
  }
  if (result.error) return `The install didn't finish: ${result.error}`;
  const last = lastLines(lines);
  return last ? `npm couldn't install pikibun: ${last}` : `npm couldn't install pikibun (exit code ${result.code ?? "unknown"}).`;
}

export function updateFailure(lines: readonly string[], result: InstallResult, who: string = computerTitle): string {
  const last = lastLines(lines);
  const why = result.error || last || `exit code ${result.code ?? "unknown"}`;
  return `npm couldn't update Pikibun's command (${why}). ${who} keeps the one it has, and Pikibun tries again the next time it opens.`;
}

export function launchProblem(lines: readonly string[], code: number | null | undefined, target: HostTarget = {}): LaunchProblem {
  if (target.wsl) {
    const wsl = wslProblem(lines.join("\n"), target.wsl.distro);
    if (wsl) return { kind: "failed", message: wsl };
  }
  return commandProblem(lines, code, /Unknown command: host|Unknown option\. Run "pikibun host --help"/, "The host");
}

export interface Outcome { ok: boolean; error?: string }

export class LocalEnvironment {
  readonly installing = signal(false);
  readonly updating = signal(false);
  readonly installError = signal("");
  readonly problem = signal<LaunchProblem | null>(null);
  readonly logs = signal<LogLine[]>([]);
  readonly stale = signal<StaleCommand | null>(null);
  readonly updatingTo = signal<string | null>(null);
  private updated?: Promise<void>;
  private autoRun?: Promise<void>;
  private autoBlocked?: string;
  private autoFailed?: string;
  private installDone: Promise<void> = Promise.resolve();
  private readonly users = new Set<CommandUser>();
  private readonly versions = new Map<CommandUser, string>();
  private readonly checks = new Map<CommandUser, number>();

  constructor(readonly target: HostTarget) {}

  use(user: CommandUser): void { this.users.add(user); }

  private wanted(): string | undefined {
    const wanted = commandUpdate.cliVersion;
    return wanted !== undefined && isVersion(wanted) ? wanted : undefined;
  }

  started(user: CommandUser, reported: string | undefined): void {
    if (!this.wanted()) return;
    const check = (this.checks.get(user) ?? 0) + 1;
    this.checks.set(user, check);
    const probe = commandUpdate.commandVersion;
    const version = reported !== undefined ? Promise.resolve(reported) : probe ? probe(this.target).catch(() => null) : Promise.resolve(null);
    void version.then(found => {
      if (this.checks.get(user) !== check) return;
      if (found) this.versions.set(user, found);
      else this.versions.delete(user);
      this.judge();
    });
  }

  exited(user: CommandUser): void {
    this.checks.set(user, (this.checks.get(user) ?? 0) + 1);
    if (this.versions.delete(user)) this.judge();
  }

  private judge(): void {
    const wanted = this.wanted();
    if (!wanted) return;
    let oldest: string | undefined;
    for (const version of this.versions.values()) {
      if (compareVersions(version, wanted) === -1 && (oldest === undefined || compareVersions(version, oldest) === -1)) oldest = version;
    }
    const before = untracked(this.stale);
    if (oldest === undefined) { if (before) this.stale.set(null); return; }
    if (before?.version === oldest && before.wanted === wanted) return;
    this.stale.set({ version: oldest, wanted });
    this.log("warning", `${this.title()} runs pikibun ${oldest}, older than the ${wanted} this version of Pikibun comes with, so its hosts may miss fixes and features they need. Choose Update pikibun${this.wsl ? "" : " under Local hosts"} to update it${untracked(() => this.stopFirst()) ? ", once what runs it is stopped" : ""}.`);
  }

  private async restartAll(): Promise<void> {
    await Promise.all([...this.users].map(user => user.restart().catch(() => undefined)));
  }

  get key(): string { return environmentKey(this.target); }
  hostsRunning(): boolean { return localHosts().all().some(host => host.environment === this && host.state() !== "stopped"); }
  serverRunning(): boolean { return [...this.users].some(user => user.kind === "server" && user.running()); }

  stopFirst(): string {
    if (this.hostsRunning()) return `Stop the hosts that run ${this.wsl ? "in" : "on"} ${this.where()} first: they run the command this replaces.`;
    if (this.serverRunning()) return `Stop Pikibun on ${computerName} under Self host first: it runs the command this replaces.`;
    return "";
  }
  get wsl(): boolean { return Boolean(this.target.wsl); }
  where(): string { return this.target.wsl ? wslName(this.target.wsl.distro) : computerName; }
  title(): string { return this.target.wsl ? wslName(this.target.wsl.distro) : computerTitle; }
  private updatedKey(): string { return this.wsl ? `${COMMAND_UPDATED_KEY}:${this.key}` : COMMAND_UPDATED_KEY; }

  log(level: LogLine["level"], message: string): void {
    this.logs.update(lines => [...lines, { time: Date.now(), level, message }].slice(-LOG_LIMIT));
  }

  private runInstall(version: string | undefined = packageVersion()): Promise<{ where: InstallRun["where"]; lines: string[]; result: InstallResult }> {
    const run = this.npmInstall(version);
    this.installDone = run.then(() => undefined, () => undefined);
    return run;
  }

  private async npmInstall(version: string | undefined): Promise<{ where: InstallRun["where"]; lines: string[]; result: InstallResult }> {
    this.installing.set(true);
    const lines: string[] = [];
    let where = "global" as InstallRun["where"];
    try {
      const result = await new Promise<InstallResult>(resolve => {
        let run: InstallRun;
        try { run = version === undefined ? installer(this.target) : installer(this.target, version); }
        catch (error) { resolve({ code: null, error: error instanceof Error ? error.message : String(error) }); return; }
        where = run.where;
        this.log("info", `Running ${run.line}${this.wsl ? ` in ${this.where()}` : ""}.`);
        run.onOutput(line => {
          if (!line.trim()) return;
          lines.push(line);
          if (lines.length > 40) lines.shift();
          this.log("info", line.slice(0, 1000));
        });
        run.onExit(resolve);
      });
      return { where, lines, result };
    } finally {
      this.installing.set(false);
    }
  }

  commandUpdated(): Promise<void> {
    this.updated ??= loadAutoUpdate().then(() => (this.wsl ? this.updateWslCommand() : this.updateOwnCommand())).catch(() => undefined);
    const auto = this.autoRun;
    return auto ? Promise.all([this.updated, auto]).then(() => undefined) : this.updated;
  }

  private async installedVersion(): Promise<string | null> {
    if (!this.wsl) return commandUpdate.ownCopy().catch(() => null);
    if (!await Storage.getItem(this.updatedKey()).catch(() => null)) return null;
    return (await commandUpdate.commandVersion?.(this.target).catch(() => null)) ?? null;
  }

  async autoUpdate(latest: string, options: { retry?: boolean } = {}): Promise<void> {
    if (!hostsHere || !isVersion(latest) || this.autoRun) return;
    await this.commandUpdated();
    while (untracked(this.installing)) { await this.installDone; await this.commandUpdated(); }
    if (this.autoRun) return;
    if (this.autoFailed === latest && !options.retry) return;
    const has = await this.installedVersion();
    if (!has || !isVersion(has) || compareVersions(latest, has) !== 1 || this.autoRun || untracked(this.installing) || untracked(this.updating)) return;
    if (untracked(() => this.serverRunning())) {
      if (this.autoBlocked !== latest) {
        this.autoBlocked = latest;
        this.log("info", `npm has pikibun ${latest}, newer than the ${has} ${this.wsl ? "in" : "on"} ${this.where()}, but Pikibun runs on it under Self host: stop it there, then choose Check now under Updates, or the next check updates it.`);
      }
      return;
    }
    this.autoBlocked = undefined;
    const running = localHosts().all().filter(host => host.environment === this && untracked(host.state) !== "stopped");
    const install = this.runAutoInstall(latest, has, running);
    const run = install.then(() => undefined, () => undefined);
    this.autoRun = run;
    let stopped: LocalHost[] = [];
    try { stopped = await install; }
    finally { if (this.autoRun === run) this.autoRun = undefined; }
    for (const host of stopped) {
      const resume = untracked(host.config).resume;
      const outcome = await host.start(resume ? { resume } : {}).catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      if (!outcome.ok) this.log("warning", `${host.name()} didn't start again after the update${outcome.error ? `: ${outcome.error}` : ""}. Start it under Local hosts, or it starts again the next time Pikibun opens.`);
    }
  }

  private async runAutoInstall(latest: string, has: string, running: LocalHost[]): Promise<LocalHost[]> {
    this.updating.set(true);
    this.updatingTo.set(latest);
    const stopped: LocalHost[] = [];
    try {
      this.log("info", `npm has pikibun ${latest}, newer than the ${has} ${this.wsl ? "in" : "on"} ${this.where()}: updating it${running.length ? ", and restarting the hosts that run it" : ""}.`);
      for (const host of running) {
        const outcome = await host.stop({ keepResume: true });
        if (!outcome.ok) {
          this.log("warning", `${host.name()} didn't stop${outcome.error ? ` (${outcome.error})` : ""}, so Pikibun's command wasn't updated to ${latest}. Pikibun tries again at its next check.`);
          return stopped;
        }
        stopped.push(host);
      }
      const { lines, result } = await this.runInstall(latest);
      if (result.code !== 0) {
        this.autoFailed = latest;
        const last = lastLines(lines);
        this.log("warning", `npm couldn't update Pikibun's command to ${latest} (${result.error || last || `exit code ${result.code ?? "unknown"}`}). ${this.title()} keeps the ${has} it has. Pikibun tries again once npm has a newer pikibun, or on Check now under Updates.`);
        return stopped;
      }
      this.autoFailed = undefined;
      autoVersion.set(latest);
      await Storage.setItem(COMMAND_AUTO_VERSION_KEY, latest).catch(() => undefined);
      this.log("info", `npm updated pikibun to ${latest} ${this.wsl ? "in" : "on"} ${this.where()}.`);
      await this.restartAll();
      return stopped;
    } finally {
      this.updatingTo.set(null);
      this.updating.set(false);
    }
  }

  private async updateOwnCommand(): Promise<void> {
    const { appVersion, ownCopy } = commandUpdate;
    if (!hostsHere || !isVersion(appVersion)) return;
    if (await Storage.getItem(COMMAND_UPDATED_KEY).catch(() => null) === appVersion) return;
    let had: string | null;
    try { had = await ownCopy(); }
    catch (error) {
      this.log("warning", `Pikibun couldn't look for its own pikibun command (${error instanceof Error ? error.message : String(error)}), so it wasn't updated with the app. Pikibun tries again the next time it opens.`);
      return;
    }
    if (had === null || untracked(this.installing)) return;
    this.updating.set(true);
    try {
      this.log("info", `Pikibun is now ${appVersion}: updating its own pikibun command${had ? ` (${had})` : ""} from npm.`);
      const { lines, result } = await this.runInstall();
      if (result.code !== 0) { this.log("warning", updateFailure(lines, result)); return; }
      const has = await ownCopy().catch(() => null);
      this.log("info", has && has === had ? `pikibun ${has} is the one this version of Pikibun installs already.` : `npm updated pikibun${has ? ` to ${has}` : ""} in Pikibun's own folder.`);
      await Storage.setItem(COMMAND_UPDATED_KEY, appVersion).catch(() => undefined);
    } finally {
      this.updating.set(false);
    }
  }

  private async updateWslCommand(): Promise<void> {
    const { appVersion } = commandUpdate;
    if (!hostsHere || !isVersion(appVersion)) return;
    const had = await Storage.getItem(this.updatedKey()).catch(() => null);
    if (!had || had === appVersion || untracked(this.installing)) return;
    this.updating.set(true);
    try {
      this.log("info", `Pikibun is now ${appVersion}: updating its pikibun command in ${this.where()} from npm.`);
      const { lines, result } = await this.runInstall();
      if (result.code !== 0) { this.log("warning", updateFailure(lines, result, this.title())); return; }
      this.log("info", `npm updated pikibun in ${this.where()}.`);
      await Storage.setItem(this.updatedKey(), appVersion).catch(() => undefined);
    } finally {
      this.updating.set(false);
    }
  }

  async install(check: () => Promise<LaunchProblem | null | undefined>): Promise<Outcome> {
    if (untracked(this.installing)) return { ok: false, error: "pikibun is already being installed." };
    const running = untracked(() => this.stopFirst());
    if (running) return { ok: false, error: running };
    this.installError.set("");
    const { where, lines, result } = await this.runInstall();
    const failure = result.code !== 0 ? installFailure(lines, result, this.target) : undefined;
    if (failure) {
      this.installError.set(failure);
      this.log("error", failure);
      return { ok: false, error: failure };
    }
    this.log("info", where === "app" ? "npm installed pikibun in Pikibun's own folder." : where === "wsl" ? `npm installed pikibun in ${this.where()}.` : "npm installed pikibun.");
    await this.restartAll();
    if (where !== "global" && isVersion(commandUpdate.appVersion)) await Storage.setItem(this.updatedKey(), commandUpdate.appVersion).catch(() => undefined);
    if ((await check())?.kind === "missing") {
      const message = where === "app"
        ? `npm installed pikibun, but ${computerName} still can't start it. Install it in a terminal with the command below, then choose Refresh.`
        : where === "wsl"
          ? `npm installed pikibun in ${this.where()}, but its login shell still can't start it. Install it there in a terminal with npm install -g pikibun@latest, then choose Refresh.`
          : `npm installed pikibun, but ${computerName}'s ${platform.os === "windows" ? "PATH" : "login shell"} doesn't find it. Add npm's global folder (npm prefix -g${platform.os === "windows" ? "" : ", then its bin"}) to your PATH, then choose Refresh.`;
      this.installError.set(message);
      return { ok: false, error: message };
    }
    return { ok: true };
  }
}

const environments = new Map<string, LocalEnvironment>();
const environmentList = signal<LocalEnvironment[]>([]);

export function staleCommands(): { environment: LocalEnvironment; stale: StaleCommand }[] {
  return environmentList().flatMap(environment => { const stale = environment.stale(); return stale ? [{ environment, stale }] : []; });
}

export function localEnvironment(target: HostTarget = {}): LocalEnvironment {
  const key = environmentKey(target);
  let environment = environments.get(key);
  if (!environment) {
    environment = new LocalEnvironment(target.wsl ? { wsl: target.wsl.distro ? { distro: target.wsl.distro } : {} } : {});
    environments.set(key, environment);
    const created = environment;
    void Promise.resolve().then(() => environmentList.update(list => [...list, created]));
  }
  return environment;
}

export const nativeEnvironment = () => localEnvironment({});

type HostResult = Extract<HostEvent, { type: "result" }>;
const hostEventTypes: ReadonlySet<string> = new Set(["ready", "result", "status", "log", "failed", "login"]);

export interface SignInView {
  provider: string;
  name: string;
  method: LoginMethodType;
  state: "running" | "done" | "failed" | "cancelled";
  error?: string;
  prompt?: { id: number; detail: LoginPrompt };
  notices: Exclude<LoginEvent, { kind: "prompt" | "prompt-closed" }>[];
}

export interface ModelChoice { provider: string; modelId: string }

export interface LocalHostConfig {
  id: string;
  server: string;
  name: string;
  sandbox: LocalSandbox;
  distro?: string;
  stateDir?: string;
  models?: ModelChoice[];
  connectorIds?: string[];
  resume?: { unsandboxedConsent: boolean };
}

const HOSTS_KEY = "pikibun.thisComputer.hosts";
const LEGACY_KEY = "pikibun.thisComputer";
const LEGACY_SERVERS_KEY = "pikibun.thisComputer.servers";
const CONNECTORS_KEY = "pikibun.thisComputer.connectors";

export const originOf = (value: string) => { try { return new URL(value).origin; } catch { return value; } };

const seenConnectors = signal<Record<string, string[]> | null>(null);
let seenLoading: Promise<Record<string, string[]>> | undefined;

function loadSeen(): Promise<Record<string, string[]>> {
  seenLoading ??= Storage.getItem(CONNECTORS_KEY).catch(() => null).then(raw => {
    let seen: Record<string, string[]> = {};
    try {
      const parsed = raw ? JSON.parse(raw) as unknown : {};
      if (parsed && typeof parsed === "object") {
        for (const [origin, ids] of Object.entries(parsed)) if (Array.isArray(ids)) seen[origin] = ids.filter(id => typeof id === "string");
      }
    } catch { seen = {}; }
    const current = untracked(seenConnectors);
    const merged = current ? { ...seen, ...Object.fromEntries(Object.entries(current).map(([origin, ids]) => [origin, [...new Set([...(seen[origin] ?? []), ...ids])]])) } : seen;
    seenConnectors.set(merged);
    return merged;
  });
  return seenLoading;
}

function noteConnector(server: string, connectorId: string): void {
  const origin = originOf(server);
  void loadSeen().then(() => {
    const seen = untracked(seenConnectors) ?? {};
    const ids = seen[origin] ?? [];
    if (ids.includes(connectorId)) return;
    const next = { ...seen, [origin]: [...ids, connectorId].slice(-CONNECTORS_KEPT) };
    seenConnectors.set(next);
    Storage.setItem(CONNECTORS_KEY, JSON.stringify(next)).catch(() => undefined);
  });
}

export function ranHere(server: string, connectorId: string): boolean {
  const seen = seenConnectors();
  if (seen === null) { void loadSeen(); return false; }
  return seen[originOf(server)]?.includes(connectorId) ?? false;
}

const isLoopbackHttp = (origin: string) => {
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  } catch { return false; }
};
const isHttps = (url: string) => { try { return new URL(url).protocol === "https:"; } catch { return false; } };

let consent: (warning: string, server: string, missing: string[], host: string) => Promise<boolean> = async () => false;
export function setUnsandboxedConsent(next: typeof consent): void { consent = next; }

interface HostOwner {
  changed(host: LocalHost): void;
  inspected(host: LocalHost): void;
}

export type ThisComputerHost = LocalHost;

export class LocalHost {
  readonly config: Signal<LocalHostConfig>;
  readonly environment: LocalEnvironment;
  readonly state = signal<HostState>("stopped");
  readonly running = signal<{ server: string; unsandboxed: boolean; sandbox?: HostInspection["sandbox"]; connectorId?: string } | null>(null);
  readonly inspection = signal<HostInspection | null>(null);
  readonly inspecting = signal(false);
  readonly error = signal("");
  readonly logs = signal<LogLine[]>([]);
  readonly providers = signal<LoginProvider[] | null>(null);
  readonly providersError = signal("");
  readonly signIn = signal<(SignInView & { login?: number }) | null>(null);
  private inspectError = false;
  private readonly channel: CommandChannel<HostEvent, HostRequest>;

  constructor(config: LocalHostConfig, private readonly owner?: HostOwner) {
    this.config = signal(config);
    this.environment = localEnvironment(targetOf(config));
    const target = targetOf(config);
    this.channel = new CommandChannel<HostEvent, HostRequest>({
      launch: () => launcher(hostArgs(untracked(this.config).stateDir), target), before: () => this.environment.commandUpdated(), eventTypes: hostEventTypes,
      problem: (lines, code) => launchProblem(lines, code, target), subject: "The host",
      onReady: version => this.environment.started(this.user, version),
      failure: (id, message, notReady) => ({ type: "result", id, ok: false, error: { code: notReady ? "unsupported" : "failed", message } }),
      onEvent: event => this.handleEvent(event),
      onOutput: line => this.log("info", line),
      onExit: (code, expected) => this.handleExit(code, expected),
    });
    this.environment.use(this.user);
  }

  get id(): string { return untracked(this.config).id; }
  get stateDir(): string | undefined { return untracked(this.config).stateDir; }
  server(): string { return this.config().server; }
  name(): string { return this.config().name; }
  sandbox(): LocalSandbox { return this.config().sandbox; }
  models(): ModelChoice[] | null { return this.config().models ?? null; }
  problem(): LaunchProblem | null { return this.environment.problem(); }
  where(): string { return this.environment.where(); }

  isolationName(): string {
    const config = this.config();
    return config.sandbox === "wsl" ? wslName(config.distro) : sandboxNames[config.sandbox];
  }

  change(update: Partial<LocalHostConfig>, persist = true): void {
    this.config.update(config => {
      const next: LocalHostConfig = { ...config, ...update };
      for (const key of Object.keys(next) as (keyof LocalHostConfig)[]) if (next[key] === undefined) delete next[key];
      return next;
    });
    if (persist) this.owner?.changed(this);
  }

  pairedWith(): string | undefined {
    return this.running()?.server ?? this.inspection()?.pairedServer;
  }

  paired(): boolean {
    const paired = this.pairedWith();
    return Boolean(paired && this.server() && originOf(paired) === originOf(this.server()));
  }

  private setResume(resume: LocalHostConfig["resume"]): void {
    this.change({ resume });
  }

  log(level: LogLine["level"], message: string): void {
    this.logs.update(lines => [...lines, { time: Date.now(), level, message }].slice(-LOG_LIMIT));
  }

  private noteId(connectorId: string): void {
    const ids = untracked(this.config).connectorIds ?? [];
    if (!ids.includes(connectorId)) this.change({ connectorIds: [...ids, connectorId].slice(-CONNECTORS_KEPT) });
  }

  private handleEvent(event: Exclude<HostEvent, HostResult | { type: "ready" }>): void {
    if (event.type === "log") { this.log(event.level, event.message); return; }
    if (event.type === "failed") { this.fail(event.error.message); return; }
    if (event.type === "login") { this.handleLogin(event.login, event.event); return; }
    const previous = untracked(this.state);
    this.state.set(event.state);
    if (event.state === "stopped") this.running.set(null);
    else if (event.server !== undefined) {
      const before = untracked(this.running);
      const connectorId = event.connectorId ?? (before?.server === event.server ? before.connectorId : undefined);
      if (event.connectorId) { noteConnector(event.server, event.connectorId); this.noteId(event.connectorId); }
      this.running.set({ server: event.server, unsandboxed: event.unsandboxed === true,
        ...(event.sandbox === "bubblewrap" || event.sandbox === "seatbelt" || event.sandbox === "windows" ? { sandbox: event.sandbox } : {}),
        ...(connectorId ? { connectorId } : {}) });
    }
    if (event.state === "connected") this.error.set("");
    if (event.state === "connected" && previous !== "connected") void this.refresh();
  }

  private fail(message: string): void {
    if (untracked(this.config).resume) this.setResume(undefined);
    this.inspectError = false;
    this.error.set(message);
    this.log("error", message);
  }

  private handleExit(code: number | null | undefined, expected: boolean): void {
    this.restartPending = false;
    this.environment.exited(this.user);
    const wasRunning = untracked(this.state) !== "stopped";
    this.state.set("stopped");
    this.running.set(null);
    if (!expected) this.fail(`The host process exited unexpectedly (code ${code ?? "unknown"})${wasRunning ? "; the host is offline" : ""}. Start it again when ready.`);
  }

  private isolation(): { experimentalSandbox?: true } {
    const sandbox = untracked(this.config).sandbox;
    return sandbox === "seatbelt" || sandbox === "windows" ? { experimentalSandbox: true } : {};
  }

  async refresh(server?: string): Promise<HostInspection | undefined> {
    await this.fresh();
    const origin = untracked(this.config).server || server;
    this.inspecting.set(true);
    try {
      const result = await this.channel.request({ type: "inspect", ...this.isolation(), ...(origin && isLoopbackHttp(origin) ? { allowInsecureLoopback: true } : {}) });
      const problem = this.channel.launchFailure;
      this.environment.problem.set(!result.ok && problem ? problem : null);
      if (untracked(this.environment.problem)?.kind !== "missing" && untracked(this.environment.problem)?.kind !== "outdated") this.environment.installError.set("");
      if (result.ok && result.inspection) {
        this.inspection.set(result.inspection);
        if (this.inspectError) { this.inspectError = false; this.error.set(""); }
        this.owner?.inspected(this);
      } else if (!result.ok && !problem) { this.inspectError = true; this.error.set(result.error.message); }
      if (result.ok && untracked(this.providers) === null && untracked(this.signIn)?.state !== "running") void this.loadProviders();
      return result.ok ? result.inspection : undefined;
    } finally {
      this.inspecting.set(false);
    }
  }

  async start(options: { pairing?: { create: () => Promise<{ id: string; code: string }>; replace: boolean }; resume?: { unsandboxedConsent: boolean } } = {}): Promise<Outcome> {
    const { pairing, resume } = options;
    const server = untracked(this.config).server;
    if (!server) return this.refuse("Choose the server this host is for first.");
    if (untracked(this.state) !== "stopped") return { ok: false, error: "The host is already running." };
    this.inspectError = false;
    const inspection = await this.refresh();
    if (!inspection) return this.refuse(untracked(this.environment.problem) ? "" : untracked(this.error) || `${this.environment.title()} could not be inspected.`);
    const offered = this.offeredModels(inspection);
    const pairedHere = inspection.pairedServer !== undefined && originOf(inspection.pairedServer) === originOf(server);
    const failure = inspection.unsupported ?? inspection.prerequisitesError
      ?? (!pairing && !pairedHere ? `This host is not paired with ${server} yet.` : undefined)
      ?? (!inspection.models.length ? `${inspection.modelsError ?? `Pi has no models to offer in ${this.where()}.`} Sign Pi in to a provider below first.`
        : !offered.length ? "None of the models chosen to offer is configured in Pi any more. Check some under Models offered, or let Pi choose." : undefined);
    if (failure) return this.refuse(failure);
    let unsandboxedConsent = false;
    if (inspection.mode === "unsandboxed") {
      const missing = inspection.sandboxPrerequisites?.filter(item => !item.ok).map(item => item.name) ?? [];
      unsandboxedConsent = resume ? resume.unsandboxedConsent : await consent(inspection.unsandboxedWarning ?? "", server, missing, untracked(this.config).name);
      if (!unsandboxedConsent) return this.refuse(resume ? `Hosting was not resumed: ${this.where()} now runs agent work unsandboxed, which needs your consent. Start the host to review it.` : "Unsandboxed mode was not confirmed; nothing was started.");
    }
    const models = untracked(this.config).models;
    this.error.set("");
    let made: { id: string; code: string } | undefined;
    if (pairing) {
      try { made = await pairing.create(); }
      catch (error) { return this.refuse(error instanceof Error ? error.message : String(error)); }
      this.log("info", pairing.replace ? `Replacing this host's pairing with one for ${server}.` : `Pairing ${untracked(this.config).name} with ${server}.`);
    }
    const result = await this.channel.request({
      type: "start", server,
      ...(made && pairing ? { pairing: { id: made.id, code: made.code }, replacePairing: pairing.replace } : {}),
      ...(unsandboxedConsent ? { unsandboxedConsent: true } : {}),
      ...(models ? { models: offered.map(model => ({ ...model })) } : {}),
      ...this.isolation(), ...(isLoopbackHttp(server) ? { allowInsecureLoopback: true } : {}),
    });
    if (!result.ok) return this.refuse(result.error.message);
    this.setResume({ unsandboxedConsent });
    return { ok: true };
  }

  private refuse(error: string): Outcome {
    if (error) this.error.set(error);
    return { ok: false, error: error || undefined };
  }

  async stop(options: { keepResume?: boolean } = {}): Promise<Outcome> {
    if (!options.keepResume && untracked(this.config).resume) this.setResume(undefined);
    if (!this.channel.running || untracked(this.state) === "stopped") return { ok: true };
    const result = await this.channel.request({ type: "stop" });
    await this.fresh();
    return result.ok ? { ok: true } : this.refuse(result.error.message);
  }

  async resumeHosting(): Promise<void> {
    const resume = untracked(this.config).resume;
    if (!resume || !untracked(this.config).server) return;
    const outcome = await this.start({ resume });
    if (!outcome.ok && untracked(this.config).resume) this.setResume(undefined);
  }

  async setSandbox(choice: LocalSandbox): Promise<Outcome> {
    const config = untracked(this.config);
    if (!sandboxChoices().includes(choice)) return { ok: false, error: `That sandbox isn't offered on ${computerName}.` };
    if (choice === config.sandbox) return { ok: true };
    if (environmentKey(targetOf({ sandbox: choice })) !== this.environment.key) return { ok: false, error: `A host runs in ${this.where()} for good: add another host to run sessions in ${sandboxNames[choice]}.` };
    if (untracked(this.state) !== "stopped") return { ok: false, error: "Stop the host first: its sandbox changes from its next start." };
    if (untracked(this.signIn)?.state === "running") return { ok: false, error: "Finish or cancel the sign-in first." };
    this.change({ sandbox: choice, resume: undefined });
    this.inspection.set(null);
    this.error.set("");
    this.log("info", choice === "seatbelt" ? "Sessions run in macOS's own sandbox (experimental) from the host's next start, or without one, after your consent, while it isn't ready."
      : "Sessions run without a sandbox, after your consent, from the host's next start.");
    await this.refresh();
    return { ok: true };
  }

  setModels(models: ModelChoice[] | null): Outcome {
    if (models && !models.length) return { ok: false, error: "Check at least one model, or let Pi choose." };
    this.change({ models: models ?? undefined });
    if (untracked(this.state) !== "stopped") this.log("info", "The model choice applies from the host's next start.");
    return { ok: true };
  }

  private offeredModels(inspection: HostInspection): ModelChoice[] {
    const chosen = untracked(this.config).models;
    const available = inspection.models.map(model => ({ provider: model.provider, modelId: model.modelId }));
    return chosen ? chosen.filter(model => available.some(entry => entry.provider === model.provider && entry.modelId === model.modelId)) : available;
  }

  async loadProviders(): Promise<Outcome> {
    const result = await this.channel.request({ type: "providers" });
    if (result.ok) { this.providers.set(result.providers ?? []); this.providersError.set(""); }
    else { this.providers.set(null); this.providersError.set(result.error.message); }
    return result.ok ? { ok: true } : { ok: false, error: result.error.message };
  }

  async startSignIn(provider: string, method: LoginMethodType, openBrowser: (url: string) => void): Promise<Outcome> {
    if (untracked(this.signIn)?.state === "running") return { ok: false, error: "A sign-in is under way: finish or cancel it first." };
    const name = untracked(this.providers)?.find(entry => entry.id === provider)?.name ?? provider;
    const current: SignInView & { login?: number; openBrowser?: (url: string) => void } = { provider, name, method, state: "running", notices: [], openBrowser };
    this.signIn.set({ ...current });
    const update = () => { if (untracked(this.signIn)?.provider === provider) this.signIn.set({ ...current, notices: [...current.notices] }); };
    this.current = current;
    const result = await this.channel.request({ type: "login", provider, method }, id => { current.login = id; update(); });
    current.login = undefined;
    current.prompt = undefined;
    current.state = result.ok ? "done" : result.error.code === "cancelled" ? "cancelled" : "failed";
    if (!result.ok && result.error.code !== "cancelled") current.error = result.error.message;
    this.current = undefined;
    update();
    await this.fresh();
    if (!result.ok) return { ok: false, error: result.error.message };
    this.log("info", `Pi is signed in to ${name} in ${this.where()}.${untracked(this.state) === "stopped" ? "" : " Its models are offered from the host's next start."}`);
    await Promise.all([this.loadProviders(), this.refresh()]);
    return { ok: true };
  }

  private current?: SignInView & { login?: number; openBrowser?: (url: string) => void };
  private restartPending = false;
  private readonly user: CommandUser = { kind: "host", running: () => this.state() !== "stopped", restart: () => this.restartCommand() };

  private restartCommand(): Promise<void> {
    if (!this.channel.running) return Promise.resolve();
    this.restartPending = true;
    return this.fresh();
  }

  private async fresh(): Promise<void> {
    if (!this.restartPending || untracked(this.state) !== "stopped" || untracked(this.signIn)?.state === "running") return;
    this.restartPending = false;
    if (this.channel.running) await this.channel.shutdown();
  }

  private handleLogin(login: number, event: LoginEvent): void {
    const current = this.current;
    if (!current || current.state !== "running" || current.login !== login) return;
    if (event.kind === "prompt") current.prompt = { id: event.prompt, detail: event.detail };
    else if (event.kind === "prompt-closed") { if (current.prompt?.id === event.prompt) current.prompt = undefined; }
    else {
      current.notices = [...current.notices, event].slice(-NOTICES);
      const page = event.kind === "auth-url" ? event.url : event.kind === "device-code" ? event.verificationUri : undefined;
      if (page && isHttps(page)) current.openBrowser?.(page);
    }
    this.signIn.set({ ...current, notices: [...current.notices] });
  }

  async answerSignIn(prompt: number, value: string): Promise<Outcome> {
    const current = this.current;
    if (!current || current.login === undefined || current.prompt?.id !== prompt) return { ok: false, error: "That question has been answered or has closed." };
    if (current.prompt.detail.type === "select" && !current.prompt.detail.options.some(option => option.id === value)) return { ok: false, error: "Choose one of the options." };
    current.prompt = undefined;
    this.signIn.set({ ...current, notices: [...current.notices] });
    const result = await this.channel.request({ type: "login-answer", login: current.login, prompt, value });
    return result.ok ? { ok: true } : { ok: false, error: result.error.message };
  }

  async cancelSignIn(): Promise<Outcome> {
    const current = this.current;
    if (!current || current.login === undefined) return { ok: true };
    const result = await this.channel.request({ type: "login-cancel", login: current.login });
    return result.ok ? { ok: true } : { ok: false, error: result.error.message };
  }

  serving(): { server: string; connectorId: string } | undefined {
    const running = untracked(this.running);
    const state = untracked(this.state);
    if (!this.channel.running || !running?.connectorId || state === "stopped" || state === "stopping") return undefined;
    return { server: running.server, connectorId: running.connectorId };
  }

  async readView(sessionId: string, options: { since?: string; brief: boolean }): Promise<LocalView | null> {
    if (!this.serving()) return null;
    const result = await this.localRequest({ type: "view", sessionId, ...(options.since ? { since: options.since } : {}), ...(options.brief ? { brief: true } : {}) });
    return result?.ok && result.view ? result.view : null;
  }

  async readEntries(sessionId: string, options: { conversation: string; before: string; limit: number; brief: boolean }): Promise<LocalPage | null> {
    if (!this.serving()) return null;
    const result = await this.localRequest({ type: "entries", sessionId, conversation: options.conversation, before: options.before, limit: options.limit,
      ...(options.brief ? { brief: true } : {}) });
    return result?.ok && result.page ? result.page : null;
  }

  private async localRequest(message: { type: "view"; sessionId: string; since?: string; brief?: boolean }
    | { type: "entries"; sessionId: string; conversation: string; before: string; limit: number; brief?: boolean }): Promise<HostResult | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), LOCAL_READ_MS); });
    try { return await Promise.race([this.channel.request(message), late]); }
    finally { clearTimeout(timer); }
  }

  shutdown(): Promise<void> { return this.channel.shutdown(); }
}

const validModels = (value: unknown): ModelChoice[] | undefined => {
  const models = Array.isArray(value)
    ? value.filter(model => typeof model?.provider === "string" && typeof model?.modelId === "string").map(model => ({ provider: model.provider as string, modelId: model.modelId as string }))
    : [];
  return models.length ? models : undefined;
};

const validOrigin = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : undefined;
  } catch { return undefined; }
};

export const defaultHostName = (sandbox?: LocalSandbox) => `${platform.os === "macos" ? "My Mac" : "My computer"}${sandbox === "wsl" ? " (WSL)" : ""}`;

export function validHostConfigs(value: unknown, os: string = platform.os): LocalHostConfig[] {
  if (!Array.isArray(value)) return [];
  const choices = sandboxChoices(os);
  const ids = new Set<string>();
  const folders = new Set<string>();
  const configs: LocalHostConfig[] = [];
  for (const item of value as Record<string, unknown>[]) {
    if (!item || typeof item !== "object") continue;
    const id = typeof item.id === "string" && HOST_ID.test(item.id) ? item.id : undefined;
    const server = validOrigin(item.server);
    if (!id || !server || ids.has(id)) continue;
    const sandbox = choices.includes(item.sandbox as LocalSandbox) ? item.sandbox as LocalSandbox : choices[0]!;
    if (item.distro !== undefined && (sandbox !== "wsl" || typeof item.distro !== "string" || !WSL_DISTRO.test(item.distro))) continue;
    const distro = item.distro as string | undefined;
    const stateDir = item.stateDir;
    if (stateDir !== undefined && stateDir !== hostStateDir(id) && stateDir !== serverStateDir(server)) continue;
    const folder = `${environmentKey(targetOf({ sandbox, ...(distro ? { distro } : {}) }))}|${(stateDir as string | undefined) ?? ""}`;
    if (folders.has(folder)) continue;
    ids.add(id);
    folders.add(folder);
    const name = typeof item.name === "string" && item.name.trim() ? item.name.trim().slice(0, 120) : computerTitle;
    const models = validModels(item.models);
    const connectorIds = Array.isArray(item.connectorIds) ? item.connectorIds.filter((entry): entry is string => typeof entry === "string" && CONNECTOR_ID.test(entry)).slice(-CONNECTORS_KEPT) : [];
    const resume = item.resume && typeof item.resume === "object" ? { unsandboxedConsent: (item.resume as { unsandboxedConsent?: unknown }).unsandboxedConsent === true } : undefined;
    configs.push({
      id, server, name, sandbox, ...(distro ? { distro } : {}), ...(stateDir !== undefined ? { stateDir: stateDir as string } : {}),
      ...(models ? { models } : {}), ...(connectorIds.length ? { connectorIds } : {}), ...(resume ? { resume } : {}),
    });
  }
  return configs;
}

interface Legacy { sandbox?: unknown; models?: unknown; resume?: { server?: unknown; unsandboxedConsent?: unknown } }

const parse = (raw: string | null): unknown => { try { return raw ? JSON.parse(raw) as unknown : undefined; } catch { return undefined; } };

const newHostId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8).toLowerCase();

export class LocalHosts implements HostOwner {
  readonly list = signal<LocalHost[]>([]);
  private readonly probeHost = signal<LocalHost | undefined>(undefined);
  private readonly drafts = new Map<string, LocalHost>();
  private loaded?: Promise<void>;
  private discovering?: Promise<void>;

  load(): Promise<void> {
    this.loaded ??= this.read().then(({ configs, legacy }) => {
      const known = new Set(untracked(this.list).map(host => host.id));
      const hosts = configs.filter(config => !known.has(config.id)).map(config => new LocalHost(config, this));
      this.list.update(list => [...list, ...hosts]);
      if (!configs.some(config => config.sandbox !== "wsl" && config.stateDir === undefined)) {
        const sandbox = sandboxChoices().includes(legacy.sandbox as LocalSandbox) ? legacy.sandbox as LocalSandbox : sandboxChoices()[0]!;
        const models = validModels(legacy.models);
        this.probeHost.set(new LocalHost({ id: "default", server: "", name: defaultHostName(), sandbox, ...(models ? { models } : {}) }, this));
      }
    });
    return this.loaded;
  }

  private async read(): Promise<{ configs: LocalHostConfig[]; legacy: Legacy }> {
    const [raw, legacyRaw] = await Promise.all([Storage.getItem(HOSTS_KEY).catch(() => null), Storage.getItem(LEGACY_KEY).catch(() => null)]);
    const legacy = (parse(legacyRaw) ?? {}) as Legacy;
    if (raw !== null) return { configs: validHostConfigs(parse(raw)), legacy };
    const configs = await this.migrate(legacy);
    await this.write(configs);
    return { configs, legacy };
  }

  private async migrate(legacy: Legacy): Promise<LocalHostConfig[]> {
    const [serversRaw, seen] = await Promise.all([Storage.getItem(LEGACY_SERVERS_KEY).catch(() => null), loadSeen()]);
    const sandbox = sandboxChoices().includes(legacy.sandbox as LocalSandbox) ? legacy.sandbox as LocalSandbox : sandboxChoices()[0]!;
    const models = validModels(legacy.models);
    const shared = { name: computerTitle, sandbox, ...(models ? { models } : {}) };
    const ids = (origin: string) => (seen[origin]?.length ? { connectorIds: seen[origin]!.slice(-CONNECTORS_KEPT) } : {});
    const configs: unknown[] = [];
    const resumed = validOrigin(legacy.resume?.server);
    if (resumed) configs.push({ id: "default", server: resumed, ...shared, ...ids(resumed), resume: { unsandboxedConsent: legacy.resume?.unsandboxedConsent === true } });
    const servers = parse(serversRaw);
    for (const item of Array.isArray(servers) ? servers as { server?: unknown; stateDir?: unknown }[] : []) {
      const server = validOrigin(item?.server);
      if (!server || item.stateDir !== serverStateDir(server)) continue;
      const saved = parse(await Storage.getItem(`${LEGACY_KEY}:${item.stateDir}`).catch(() => null)) as Legacy | undefined;
      const resume = saved?.resume && typeof saved.resume === "object" ? { resume: { unsandboxedConsent: saved.resume.unsandboxedConsent === true } } : {};
      configs.push({ id: shortHash(server), server, ...shared, stateDir: item.stateDir, ...ids(server), ...resume });
    }
    return validHostConfigs(configs);
  }

  private write(configs: LocalHostConfig[]): Promise<void> {
    return Storage.setItem(HOSTS_KEY, JSON.stringify(configs)).catch(() => undefined);
  }

  private persist(): Promise<void> {
    return this.write(untracked(this.list).map(host => untracked(host.config)));
  }

  changed(host: LocalHost): void {
    if (untracked(this.list).includes(host)) void this.persist();
  }

  inspected(host: LocalHost): void {
    const paired = untracked(host.inspection)?.pairedServer;
    if (host !== untracked(this.probeHost) || !paired || untracked(host.state) !== "stopped" || untracked(host.config).server) return;
    const server = validOrigin(paired);
    if (!server) return;
    host.change({ server, name: computerTitle }, false);
    void this.add(host);
  }

  discover(server?: string): Promise<void> {
    this.discovering ??= this.load().then(async () => {
      const probe = untracked(this.probeHost) ?? untracked(this.list).find(host => !host.stateDir && host.environment.key === "native");
      if (probe && !untracked(probe.inspection)) await probe.refresh(server);
    }).finally(() => { this.discovering = undefined; });
    return this.discovering;
  }

  probe(): LocalHost | undefined { return this.probeHost(); }

  all(): LocalHost[] {
    const listed = this.list();
    const probe = this.probeHost();
    const extra = [...(probe ? [probe] : []), ...this.drafts.values()].filter(host => !listed.includes(host) && host.state() !== "stopped");
    return [...listed, ...new Set(extra)];
  }

  byId(id: string): LocalHost | undefined {
    return this.list().find(host => host.id === id);
  }

  forServer(server: string): LocalHost[] {
    const origin = originOf(server);
    return this.list().filter(host => originOf(host.server()) === origin);
  }

  withConnector(server: string, connectorId: string): LocalHost | undefined {
    return this.forServer(server).find(host => host.running()?.connectorId === connectorId || (host.config().connectorIds ?? []).includes(connectorId));
  }

  draft(sandbox: LocalSandbox, distro?: string): LocalHost {
    const target = targetOf({ sandbox, ...(distro ? { distro } : {}) });
    const key = environmentKey(target);
    const probe = this.probeHost();
    if (key === "native" && probe && !this.list().includes(probe)) {
      const inspection = probe.inspection();
      if (probe.state() !== "stopped" || !inspection || (!inspection.pairedServer && !inspection.pairingError)) return probe;
    }
    let draft = this.drafts.get(key);
    if (!draft) {
      const id = newHostId();
      draft = new LocalHost({ id, server: "", name: defaultHostName(sandbox), sandbox, ...(distro ? { distro } : {}), stateDir: hostStateDir(id) }, this);
      this.drafts.set(key, draft);
    }
    return draft;
  }

  async add(host: LocalHost): Promise<void> {
    await this.load();
    if (untracked(this.list).includes(host)) return;
    if (untracked(this.probeHost) === host) this.probeHost.set(undefined);
    for (const [key, draft] of this.drafts) if (draft === host) this.drafts.delete(key);
    this.list.update(list => [...list, host]);
    await this.persist();
  }

  async remove(id: string): Promise<Outcome> {
    const host = untracked(this.list).find(item => item.id === id);
    if (!host) return { ok: false, error: `${computerTitle} has no such host.` };
    if (!host.stateDir) return { ok: false, error: "This host is the command line's (pikibun connect's) pairing: stop it here, or remove it from its Pikibun server's Settings › Hosts." };
    const stopped = await host.stop();
    if (!stopped.ok) return stopped;
    this.list.update(list => list.filter(item => item !== host));
    await this.persist();
    void host.shutdown();
    return { ok: true };
  }

  serving(server: string, connectorId?: string): { host: LocalHost; connectorId: string } | undefined {
    const origin = originOf(server);
    for (const host of this.all()) {
      const serving = host.serving();
      if (serving && originOf(serving.server) === origin && (connectorId === undefined || serving.connectorId === connectorId)) return { host, connectorId: serving.connectorId };
    }
    return undefined;
  }

  servingIds(server: string): string[] {
    const origin = originOf(server);
    const ids: string[] = [];
    for (const host of this.all()) {
      host.running();
      host.state();
      const serving = host.serving();
      if (serving && originOf(serving.server) === origin) ids.push(serving.connectorId);
    }
    return ids;
  }

  async resumeHosting(): Promise<void> {
    await this.load();
    await Promise.all(untracked(this.list).map(host => host.resumeHosting()));
  }

  shutdown(): Promise<unknown> {
    const probe = untracked(this.probeHost);
    return Promise.all([...new Set([...untracked(this.list), ...(probe ? [probe] : []), ...this.drafts.values()])].map(host => host.shutdown()));
  }
}

let hosts: LocalHosts | undefined;

export function localHosts(): LocalHosts {
  hosts ??= new LocalHosts();
  return hosts;
}

export async function hostRenamed(server: string, connectorId: string, name: string): Promise<void> {
  if (!hostsHere) return;
  const all = localHosts();
  await all.load();
  untracked(() => all.withConnector(server, connectorId))?.change({ name });
}

export function thisComputerHostIds(server?: string): string[] {
  if (!hostsHere) return [];
  const signedIn = server === undefined ? auth() : undefined;
  const origin = server ?? (signedIn?.status === "signedIn" ? signedIn.origin : undefined);
  if (!origin) return [];
  return localHosts().servingIds(origin);
}

export async function checkCommandUpdates(options: { retry?: boolean } = {}): Promise<void> {
  if (!hostsHere) return;
  await loadAutoUpdate();
  if (!untracked(commandAutoUpdate) || untracked(commandAutoChecking)) return;
  commandAutoChecking.set(true);
  try {
    let latest: string | null;
    try { latest = await (commandUpdate.latest ?? npmLatest)(); }
    catch (error) {
      commandAutoCheck.set({ at: Date.now(), error: `Couldn't ask npm for pikibun's latest version: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    commandAutoCheck.set({ at: Date.now(), ...(latest ? { latest } : {}) });
    if (!latest || !untracked(commandAutoUpdate)) return;
    await localHosts().load();
    nativeEnvironment();
    await Promise.all([...environments.values()].map(environment => environment.autoUpdate(latest, options).catch(() => undefined)));
  } finally {
    commandAutoChecking.set(false);
  }
}

export async function setCommandAutoUpdate(on: boolean): Promise<void> {
  await loadAutoUpdate();
  commandAutoUpdate.set(on);
  await Storage.setItem(COMMAND_AUTO_UPDATE_KEY, on ? "on" : "off").catch(() => undefined);
  if (on) void checkCommandUpdates({ retry: true });
}

export function commandAutoUpdateLoaded(): Promise<void> { return loadAutoUpdate(); }

let autoTimer: ReturnType<typeof setTimeout> | undefined;

export function startCommandAutoUpdates(delay = AUTO_FIRST_CHECK_MS, interval = AUTO_CHECK_EVERY_MS): void {
  if (!hostsHere || autoTimer !== undefined) return;
  const schedule = (wait: number) => {
    autoTimer = setTimeout(() => { void checkCommandUpdates().finally(() => schedule(interval)); }, wait);
  };
  schedule(delay);
}

export function resumeThisComputer(): void {
  if (!hostsHere) return;
  void nativeEnvironment().commandUpdated();
  void localHosts().resumeHosting();
  startCommandAutoUpdates();
}
