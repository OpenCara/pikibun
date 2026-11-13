import { readFile } from "fs/promises";
import { platform, signal, Storage, untracked, type Signal } from "nsh";
import nshProcess from "process";
import { APP_VERSION } from "../app-version";
import type {
  HostEvent, HostInspection, HostRequest, HostState, LocalPage, LocalView, LoginEvent, LoginMethodType, LoginPrompt, LoginProvider,
} from "../../../../packages/shared/src/app-host-protocol";
import {
  appCliFolder, CommandChannel, commandDirectory, commandProblem, installCommand, pikibunCommand, spawnPikibun, type CommandLink, type LaunchProblem, type LogLine,
} from "./pikibun-command";
import { auth } from "./auth";
import { isVersion } from "./version";
import { lastLines } from "./windows-cmd";

export { appCliFolder, INSTALL_COMMAND, installCommand } from "./pikibun-command";
export type { LaunchProblem, LogLine } from "./pikibun-command";

export const hostsHere = platform.os === "macos" || platform.os === "windows" || platform.os === "linux";
export const computerTitle = platform.os === "macos" ? "This Mac" : "This Computer";
export const computerName = platform.os === "macos" ? "this Mac" : "this computer";

const HOST_ARGS = ["host", "--stdio"];
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const LOG_LIMIT = 200;
const NOTICES = 20;
const LOCAL_READ_MS = 5_000;

export function hostCommand(os: string, shell: string | undefined, cli?: string | null): { command: string; args: string[] } {
  return pikibunCommand(os, shell, cli, HOST_ARGS);
}

export function hostArgs(stateDir?: string): string[] {
  return stateDir ? [...HOST_ARGS, "--state-dir", stateDir] : [...HOST_ARGS];
}

export function serverStateDir(server: string): string {
  let name: string;
  try {
    const url = new URL(server);
    name = `${url.protocol === "https:" ? "" : "http-"}${url.host}`;
  } catch { name = server; }
  return `~/.local/share/pikibun/servers/${name.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^[.-]+/, "").slice(0, 100) || "server"}`;
}

export type HostLink = CommandLink;
export type HostLauncher = (args: string[]) => HostLink;

export const spawnHost: HostLauncher = args => spawnPikibun(args);

let launcher: HostLauncher = spawnHost;
export function setHostLauncher(next: HostLauncher): void { launcher = next; }

export interface InstallRun {
  line: string;
  where: "app" | "global";
  onOutput(listener: (line: string) => void): void;
  onExit(listener: (result: { code?: number | null; error?: string | null }) => void): void;
}

export type Installer = () => InstallRun;

export const spawnInstall: Installer = () => {
  const cli = appCliFolder(platform.os, nshProcess.dataDir);
  const { command, args, line } = installCommand(platform.os, nshProcess.env.SHELL, cli);
  const cwd = commandDirectory();
  const child = nshProcess.spawn(command, args, { lines: true, timeoutMs: INSTALL_TIMEOUT_MS, ...(cwd ? { cwd } : {}) });
  return {
    line,
    where: cli ? "app" : "global",
    onOutput: listener => { child.on("stdout", listener); child.on("stderr", listener); },
    onExit: listener => { child.on("exit", result => listener(result)); },
  };
};

let installer: Installer = spawnInstall;
export function setInstaller(next: Installer): void { installer = next; }

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
}

let commandUpdate: CommandUpdate = { appVersion: APP_VERSION, ownCopy: ownCopyVersion };
export function setCommandUpdate(next: CommandUpdate): void { commandUpdate = next; }

type InstallResult = { code?: number | null; error?: string | null };

export function installFailure(lines: readonly string[], result: InstallResult): string {
  const text = lines.join("\n");
  const node = `Node.js 24 or newer (from nodejs.org${platform.os === "macos" ? ", or brew install node" : ""})`;
  if (result.code === 127 || result.code === 9009 || /npm: (command )?not found|not found: npm|'npm' is not recognized/i.test(text)) {
    return `npm isn't installed on ${computerName}. Install ${node}, then choose Install again.`;
  }
  if (/\bEACCES\b|\bEPERM\b|permission denied/i.test(text)) {
    const chown = /sudo chown -R [^\s"]+ "[^"\n]+"/.exec(text)?.[0];
    if (chown) return `npm's cache on ${computerName} has files it can't write, left by an earlier sudo npm. Fix them in a terminal with ${chown}, then choose Install again.`;
    return `npm couldn't write a folder it needs on ${computerName}: permission denied. Run the command below in a terminal${platform.os === "windows" ? " as administrator" : " with sudo in front"}, then choose Refresh.`;
  }
  if (result.error) return `The install didn't finish: ${result.error}`;
  const last = lastLines(lines);
  return last ? `npm couldn't install pikibun: ${last}` : `npm couldn't install pikibun (exit code ${result.code ?? "unknown"}).`;
}

export function updateFailure(lines: readonly string[], result: InstallResult): string {
  const last = lastLines(lines);
  const why = result.error || last || `exit code ${result.code ?? "unknown"}`;
  return `npm couldn't update Pikibun's command (${why}). ${computerTitle} keeps the one it has, and Pikibun tries again the next time it opens.`;
}

export function launchProblem(lines: readonly string[], code: number | null | undefined): LaunchProblem {
  return commandProblem(lines, code, /Unknown command: host|Unknown option '--state-dir'/, "The host");
}

type HostResult = Extract<HostEvent, { type: "result" }>;
const hostEventTypes: ReadonlySet<string> = new Set(["ready", "result", "status", "log", "failed", "login"]);

export type MacSandbox = "none" | "seatbelt";

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
interface Saved {
  sandbox?: MacSandbox;
  models?: ModelChoice[];
  resume?: { server: string; unsandboxedConsent: boolean };
}

const SAVED_KEY = "pikibun.thisComputer";
const SERVERS_KEY = "pikibun.thisComputer.servers";

export interface Outcome { ok: boolean; error?: string }

export interface HostOptions {
  stateDir?: string;
  computer?: ThisComputerHost;
}

const isLoopbackHttp = (origin: string) => {
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  } catch { return false; }
};
const isHttps = (url: string) => { try { return new URL(url).protocol === "https:"; } catch { return false; } };

export class ThisComputerHost {
  readonly state = signal<HostState>("stopped");
  readonly running = signal<{ server: string; unsandboxed: boolean; sandbox?: HostInspection["sandbox"]; connectorId?: string } | null>(null);
  readonly inspection = signal<HostInspection | null>(null);
  readonly inspecting = signal(false);
  readonly problem = signal<LaunchProblem | null>(null);
  readonly installing = signal(false);
  readonly updating = signal(false);
  readonly installError = signal("");
  readonly error = signal("");
  readonly logs = signal<LogLine[]>([]);
  readonly providers = signal<LoginProvider[] | null>(null);
  readonly providersError = signal("");
  readonly signIn = signal<(SignInView & { login?: number }) | null>(null);
  readonly sandbox: Signal<MacSandbox>;
  readonly models: Signal<ModelChoice[] | null>;
  readonly stateDir?: string;
  private readonly computer?: ThisComputerHost;
  private readonly savedKey: string;
  private resume: Saved["resume"];
  private loaded?: Promise<void>;
  private server?: string;
  private inspectError = false;
  private updated?: Promise<void>;
  private readonly channel = new CommandChannel<HostEvent, HostRequest>({
    launch: () => launcher(hostArgs(this.stateDir)), before: () => this.commandUpdated(), eventTypes: hostEventTypes, problem: launchProblem, subject: "The host",
    failure: (id, message, notReady) => ({ type: "result", id, ok: false, error: { code: notReady ? "unsupported" : "failed", message } }),
    onEvent: event => this.handleEvent(event),
    onOutput: line => this.log("info", line),
    onExit: (code, expected) => this.handleExit(code, expected),
  });

  constructor(private readonly confirmUnsandboxed: (warning: string, server: string, missing: string[]) => Promise<boolean>, options: HostOptions = {}) {
    this.stateDir = options.stateDir;
    this.computer = options.computer;
    this.sandbox = options.computer?.sandbox ?? signal<MacSandbox>("none");
    this.models = options.computer?.models ?? signal<ModelChoice[] | null>(null);
    this.savedKey = options.stateDir ? `${SAVED_KEY}:${options.stateDir}` : SAVED_KEY;
  }

  load(): Promise<void> {
    this.loaded ??= Promise.all([this.computer?.load(), Storage.getItem(this.savedKey)]).then(([, raw]) => {
      if (!raw) return;
      const saved = JSON.parse(raw) as Saved;
      if (this.computer) {
        if (saved.resume && typeof saved.resume.server === "string") this.resume = { server: saved.resume.server, unsandboxedConsent: saved.resume.unsandboxedConsent === true };
        return;
      }
      if (saved.sandbox === "seatbelt") this.sandbox.set("seatbelt");
      const models = Array.isArray(saved.models) ? saved.models.filter(model => typeof model?.provider === "string" && typeof model?.modelId === "string") : [];
      if (models.length) this.models.set(models);
      if (saved.resume && typeof saved.resume.server === "string") this.resume = { server: saved.resume.server, unsandboxedConsent: saved.resume.unsandboxedConsent === true };
    }).catch(() => undefined);
    return this.loaded;
  }

  private save(): void {
    const own = !this.computer;
    const saved: Saved = { ...(own && untracked(this.sandbox) === "seatbelt" ? { sandbox: "seatbelt" as const } : {}), ...(own && untracked(this.models)?.length ? { models: untracked(this.models)! } : {}),
      ...(this.resume ? { resume: this.resume } : {}) };
    Storage.setItem(this.savedKey, JSON.stringify(saved)).catch(() => undefined);
  }

  pairedWith(): string | undefined {
    return this.running()?.server ?? this.inspection()?.pairedServer;
  }

  forget(): Promise<void> {
    this.resume = undefined;
    return Storage.removeItem(this.savedKey).catch(() => undefined);
  }

  private setResume(resume: Saved["resume"]): void {
    this.resume = resume;
    this.save();
  }

  log(level: LogLine["level"], message: string): void {
    this.logs.update(lines => [...lines, { time: Date.now(), level, message }].slice(-LOG_LIMIT));
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
      this.running.set({ server: event.server, unsandboxed: event.unsandboxed === true,
        ...(event.sandbox === "bubblewrap" || event.sandbox === "seatbelt" || event.sandbox === "windows" ? { sandbox: event.sandbox } : {}),
        ...(connectorId ? { connectorId } : {}) });
    }
    if (event.server !== undefined) this.server = event.server;
    if (event.state === "connected") this.error.set("");
    if (event.state === "connected" && previous !== "connected") void this.refresh(event.server);
  }

  private fail(message: string): void {
    if (this.resume) this.setResume(undefined);
    this.inspectError = false;
    this.error.set(message);
    this.log("error", message);
  }

  private handleExit(code: number | null | undefined, expected: boolean): void {
    const wasRunning = untracked(this.state) !== "stopped";
    this.state.set("stopped");
    this.running.set(null);
    if (!expected) this.fail(`The host process exited unexpectedly (code ${code ?? "unknown"})${wasRunning ? "; the host is offline" : ""}. Start it again when ready.`);
  }

  private isolation(): { experimentalSandbox?: true } {
    return platform.os === "windows" || (platform.os === "macos" && untracked(this.sandbox) === "seatbelt") ? { experimentalSandbox: true } : {};
  }

  async refresh(server?: string): Promise<HostInspection | undefined> {
    if (server) this.server = server;
    const origin = server ?? this.server;
    this.inspecting.set(true);
    try {
      const result = await this.channel.request({ type: "inspect", ...this.isolation(), ...(origin && isLoopbackHttp(origin) ? { allowInsecureLoopback: true } : {}) });
      const problem = this.channel.launchFailure;
      this.problem.set(!result.ok && problem ? problem : null);
      if (untracked(this.problem)?.kind !== "missing" && untracked(this.problem)?.kind !== "outdated") this.installError.set("");
      if (result.ok && result.inspection) {
        this.inspection.set(result.inspection);
        if (this.inspectError) { this.inspectError = false; this.error.set(""); }
      } else if (!result.ok && !problem) { this.inspectError = true; this.error.set(result.error.message); }
      if (result.ok && untracked(this.providers) === null && untracked(this.signIn)?.state !== "running") void this.loadProviders();
      return result.ok ? result.inspection : undefined;
    } finally {
      this.inspecting.set(false);
    }
  }

  async start(server: string, pairing?: { create: () => Promise<{ id: string; code: string }>; replace: boolean }, resume?: { unsandboxedConsent: boolean }): Promise<Outcome> {
    if (untracked(this.state) !== "stopped") return { ok: false, error: "The host is already running." };
    this.inspectError = false;
    const inspection = await this.refresh(server);
    if (!inspection) return this.refuse(untracked(this.problem) ? "" : untracked(this.error) || `${computerTitle} could not be inspected.`);
    const offered = this.offeredModels(inspection);
    const failure = inspection.unsupported ?? inspection.prerequisitesError
      ?? (!pairing && inspection.pairedServer !== server ? `${computerTitle} is not paired with ${server} yet.` : undefined)
      ?? (!inspection.models.length ? `${inspection.modelsError ?? "Pi has no models to offer on this computer."} Sign Pi in to a provider below first.`
        : !offered.length ? "None of the models chosen to offer is configured in Pi any more. Check some under Models offered, or let Pi choose." : undefined);
    if (failure) return this.refuse(failure);
    let unsandboxedConsent = false;
    if (inspection.mode === "unsandboxed") {
      const missing = inspection.sandboxPrerequisites?.filter(item => !item.ok).map(item => item.name) ?? [];
      unsandboxedConsent = resume ? resume.unsandboxedConsent : await this.confirmUnsandboxed(inspection.unsandboxedWarning ?? "", server, missing);
      if (!unsandboxedConsent) return this.refuse(resume ? `Hosting was not resumed: ${computerName} now runs agent work unsandboxed, which needs your consent. Start the host to review it.` : "Unsandboxed mode was not confirmed; nothing was started.");
    }
    const models = untracked(this.models);
    this.error.set("");
    let made: { id: string; code: string } | undefined;
    if (pairing) {
      try { made = await pairing.create(); }
      catch (error) { return this.refuse(error instanceof Error ? error.message : String(error)); }
      this.log("info", pairing.replace ? `Replacing ${computerName}'s pairing with one for ${server}.` : `Pairing ${computerName} with ${server}.`);
    }
    const result = await this.channel.request({
      type: "start", server,
      ...(made && pairing ? { pairing: { id: made.id, code: made.code }, replacePairing: pairing.replace } : {}),
      ...(unsandboxedConsent ? { unsandboxedConsent: true } : {}),
      ...(models ? { models: offered.map(model => ({ ...model })) } : {}),
      ...this.isolation(), ...(isLoopbackHttp(server) ? { allowInsecureLoopback: true } : {}),
    });
    if (!result.ok) return this.refuse(result.error.message);
    this.setResume({ server, unsandboxedConsent });
    return { ok: true };
  }

  private async runInstall(): Promise<{ where: InstallRun["where"]; lines: string[]; result: InstallResult }> {
    this.installing.set(true);
    const lines: string[] = [];
    let where = "global" as InstallRun["where"];
    try {
      const result = await new Promise<InstallResult>(resolve => {
        let run: InstallRun;
        try { run = installer(); }
        catch (error) { resolve({ code: null, error: error instanceof Error ? error.message : String(error) }); return; }
        where = run.where;
        this.log("info", `Running ${run.line}.`);
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
    if (this.computer) return this.computer.commandUpdated();
    this.updated ??= this.updateOwnCommand().catch(() => undefined);
    return this.updated;
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

  async install(server?: string): Promise<Outcome> {
    if (untracked(this.installing)) return { ok: false, error: "pikibun is already being installed." };
    if (untracked(this.state) !== "stopped") return { ok: false, error: "Stop the host first." };
    this.installError.set("");
    const { where, lines, result } = await this.runInstall();
    const failure = result.code !== 0 ? installFailure(lines, result) : undefined;
    if (failure) {
      this.installError.set(failure);
      this.log("error", failure);
      return { ok: false, error: failure };
    }
    this.log("info", where === "app" ? "npm installed pikibun in Pikibun's own folder." : "npm installed pikibun.");
    if (where === "app" && isVersion(commandUpdate.appVersion)) await Storage.setItem(COMMAND_UPDATED_KEY, commandUpdate.appVersion).catch(() => undefined);
    await this.refresh(server);
    if (untracked(this.problem)?.kind === "missing") {
      const message = where === "app"
        ? `npm installed pikibun, but ${computerName} still can't start it. Install it in a terminal with the command below, then choose Refresh.`
        : `npm installed pikibun, but ${computerName}'s ${platform.os === "windows" ? "PATH" : "login shell"} doesn't find it. Add npm's global folder (npm prefix -g${platform.os === "windows" ? "" : ", then its bin"}) to your PATH, then choose Refresh.`;
      this.installError.set(message);
      return { ok: false, error: message };
    }
    return { ok: true };
  }

  private refuse(error: string): Outcome {
    if (error) this.error.set(error);
    return { ok: false, error: error || undefined };
  }

  async stop(): Promise<Outcome> {
    this.setResume(undefined);
    if (!this.channel.running || untracked(this.state) === "stopped") return { ok: true };
    const result = await this.channel.request({ type: "stop" });
    return result.ok ? { ok: true } : this.refuse(result.error.message);
  }

  async resumeHosting(): Promise<void> {
    await this.load();
    const resume = this.resume;
    if (!resume) return;
    const outcome = await this.start(resume.server, undefined, resume);
    if (!outcome.ok) this.setResume(undefined);
  }

  async setSandbox(choice: MacSandbox): Promise<Outcome> {
    if (platform.os !== "macos") return { ok: false, error: "Only macOS offers a choice of sandbox here." };
    if (computerHosts().all().some(host => untracked(host.state) !== "stopped")) return { ok: false, error: `Stop ${computerName}'s hosts first: their sandbox changes from their next start.` };
    if (untracked(this.signIn)?.state === "running") return { ok: false, error: "Finish or cancel the sign-in first." };
    if (choice === untracked(this.sandbox)) return { ok: true };
    this.sandbox.set(choice);
    for (const host of computerHosts().all()) {
      if (host === this) continue;
      void host.forget();
      host.inspection.set(null);
    }
    this.resume = undefined;
    this.save();
    this.inspection.set(null);
    this.error.set("");
    this.log("info", choice === "seatbelt" ? "Sessions run in macOS's own sandbox (experimental) from the host's next start, or without one, after your consent, while it isn't ready."
      : "Sessions run without a sandbox, after your consent, from the host's next start.");
    await this.refresh();
    return { ok: true };
  }

  setModels(models: ModelChoice[] | null): Outcome {
    if (models && !models.length) return { ok: false, error: "Check at least one model, or let Pi choose." };
    this.models.set(models);
    this.save();
    if (untracked(this.state) !== "stopped") this.log("info", "The model choice applies from the host's next start.");
    return { ok: true };
  }

  private offeredModels(inspection: HostInspection): ModelChoice[] {
    const chosen = untracked(this.models);
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
    if (!result.ok) return { ok: false, error: result.error.message };
    this.log("info", `Pi is signed in to ${name} on ${computerName}.${untracked(this.state) === "stopped" ? "" : " Its models are offered from the host's next start."}`);
    await Promise.all([this.loadProviders(), this.refresh()]);
    return { ok: true };
  }

  private current?: SignInView & { login?: number; openBrowser?: (url: string) => void };

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

let shared: ThisComputerHost | undefined;
let consent: (warning: string, server: string, missing: string[]) => Promise<boolean> = async () => false;
const ask = (warning: string, server: string, missing: string[]) => consent(warning, server, missing);

export function setUnsandboxedConsent(next: typeof consent): void { consent = next; }

export function thisComputer(): ThisComputerHost {
  shared ??= new ThisComputerHost(ask);
  return shared;
}

const originOf = (value: string) => { try { return new URL(value).origin; } catch { return value; } };

interface SavedServer { server: string; stateDir: string }

export class ComputerHosts {
  readonly added = signal<{ server: string; host: ThisComputerHost }[]>([]);
  private readonly candidates = new Map<string, ThisComputerHost>();
  private loaded?: Promise<void>;

  constructor(readonly computer: ThisComputerHost) {}

  load(): Promise<void> {
    this.loaded ??= Promise.all([this.computer.load(), Storage.getItem(SERVERS_KEY).catch(() => null)]).then(([, raw]) => {
      let saved: SavedServer[] = [];
      try { saved = raw ? (JSON.parse(raw) as SavedServer[]).filter(item => typeof item?.server === "string" && typeof item?.stateDir === "string") : []; } catch { saved = []; }
      const known = untracked(this.added);
      const loaded = saved.filter(item => !known.some(entry => entry.server === item.server))
        .map(item => ({ server: item.server, host: this.candidates.get(item.server) ?? new ThisComputerHost(ask, { stateDir: item.stateDir, computer: this.computer }) }));
      if (loaded.length) this.added.set([...known, ...loaded]);
    });
    return this.loaded;
  }

  all(): ThisComputerHost[] {
    return [this.computer, ...this.added().map(entry => entry.host)];
  }

  others(server: string): { server: string; host: ThisComputerHost; added: boolean }[] {
    const own = this.computer.pairedWith();
    return [
      ...(own && originOf(own) !== originOf(server) ? [{ server: own, host: this.computer, added: false }] : []),
      ...this.added().filter(entry => originOf(entry.server) !== originOf(server)).map(entry => ({ ...entry, added: true })),
    ];
  }

  forServer(server: string): ThisComputerHost | undefined {
    const origin = originOf(server);
    const own = this.computer.pairedWith();
    if (own && originOf(own) === origin) return this.computer;
    return this.added().find(entry => originOf(entry.server) === origin)?.host;
  }

  slotFor(server: string): ThisComputerHost {
    const found = this.forServer(server);
    if (found) return found;
    const inspection = this.computer.inspection();
    const free = this.computer.state() === "stopped" && (!inspection || (!inspection.pairedServer && !inspection.pairingError));
    if (free) return this.computer;
    const origin = originOf(server);
    let candidate = this.candidates.get(origin);
    if (!candidate) {
      candidate = new ThisComputerHost(ask, { stateDir: serverStateDir(origin), computer: this.computer });
      this.candidates.set(origin, candidate);
    }
    return candidate;
  }

  async remember(server: string, host: ThisComputerHost): Promise<void> {
    if (host === this.computer || !host.stateDir) return;
    const origin = originOf(server);
    if (!untracked(this.added).some(entry => entry.host === host)) this.added.update(list => [...list.filter(entry => originOf(entry.server) !== origin), { server: origin, host }]);
    await this.persist();
  }

  async remove(server: string): Promise<Outcome> {
    const origin = originOf(server);
    const entry = untracked(this.added).find(item => originOf(item.server) === origin);
    if (!entry) return { ok: false, error: `${computerTitle} has no pairing of its own for ${server} to remove.` };
    const stopped = await entry.host.stop();
    if (!stopped.ok) return stopped;
    await entry.host.forget();
    this.added.update(list => list.filter(item => item !== entry));
    this.candidates.delete(origin);
    await this.persist();
    void entry.host.shutdown();
    return { ok: true };
  }

  serving(server: string): { host: ThisComputerHost; connectorId: string } | undefined {
    const origin = originOf(server);
    for (const host of this.all()) {
      const serving = host.serving();
      if (serving && originOf(serving.server) === origin) return { host, connectorId: serving.connectorId };
    }
    return undefined;
  }

  async resumeHosting(): Promise<void> {
    await this.load();
    await Promise.all(this.all().map(host => host.resumeHosting()));
  }

  shutdown(): Promise<unknown> {
    return Promise.all([...this.all(), ...this.candidates.values()].map(host => host.shutdown()));
  }

  private persist(): Promise<void> {
    const saved: SavedServer[] = untracked(this.added).map(entry => ({ server: entry.server, stateDir: entry.host.stateDir! }));
    return Storage.setItem(SERVERS_KEY, JSON.stringify(saved)).catch(() => undefined);
  }
}

let hosts: ComputerHosts | undefined;

export function computerHosts(): ComputerHosts {
  hosts ??= new ComputerHosts(thisComputer());
  return hosts;
}

export function thisComputerHostId(server?: string): string | undefined {
  if (!hostsHere) return undefined;
  const signedIn = server === undefined ? auth() : undefined;
  const origin = server ?? (signedIn?.status === "signedIn" ? signedIn.origin : undefined);
  if (!origin) return undefined;
  for (const host of computerHosts().all()) host.running();
  return computerHosts().serving(origin)?.connectorId;
}

export function resumeThisComputer(): void {
  if (!hostsHere) return;
  void thisComputer().commandUpdated();
  void computerHosts().resumeHosting();
}
