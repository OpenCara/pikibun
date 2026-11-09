import { platform, signal, Storage, untracked } from "nsh";
import { homedir } from "os";
import nshProcess from "process";
import type {
  HostEvent, HostInspection, HostRequest, HostState, LoginEvent, LoginMethodType, LoginPrompt, LoginProvider,
} from "../../../runner/src/desktop-protocol";

// This computer as a host, in the desktop builds (Settings › This Mac, or This Computer): the app runs `pikibun host
// --stdio` (apps/runner/src/host-cli.ts) and talks to it with JSON lines on its stdin and framed events on its stdout
// (desktop-protocol.ts). The host's connector state is the CLI's own, so a computer paired with `pikibun connect` (or
// the former Electron app's primary server) is adopted as it is; only one of them runs at a time. Hosting lasts while
// the app is open, and resumes when it opens again if it was running when it quit.
//
// NSH runs a command without a shell and with the app's own PATH, which on a Mac opened from Finder lacks Homebrew's,
// nvm's and npm's directories. So on macOS and Linux the owner's login shell starts the command, as Terminal would
// (`$SHELL -ilc`); on Windows cmd.exe does, which finds npm's `pikibun.cmd`. The command line is fixed: pairing codes
// travel only on the host's stdin.

/** The desktops that can host: NSH runs processes on these only. */
export const hostsHere = platform.os === "macos" || platform.os === "windows" || platform.os === "linux";
export const computerTitle = platform.os === "macos" ? "This Mac" : "This Computer";
/** "this Mac" or "this computer", within a sentence. */
export const computerName = platform.os === "macos" ? "this Mac" : "this computer";

/** desktop-protocol.ts's STDIO_FRAME: the host's own lines on its stdout start with it; anything else is output. */
const STDIO_FRAME = "\u001epikibun ";
/**
 * The login shells the app may start the command with, and cmd on Windows: bare names, as nsh.json grants them, which
 * NSH finds through the app's PATH (launchd's /usr/bin:/bin on a Mac, System32 on Windows). nsh.json is every target's,
 * and an absolute path of one platform isn't one on another, so no paths. Another shell falls back to the platform's.
 */
const SHELLS = ["zsh", "bash", "sh"];
const CMD = "cmd";
/** What gets the command, with Node.js 24 or newer: the Install button runs it, and a terminal can. */
export const INSTALL_COMMAND = "npm install -g pikibun@latest";
/** How long npm may take before the install is given up on. */
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const LOG_LIMIT = 200;
const NOTICES = 20;

/** The owner's login shell by name, if the app is granted it, else the platform's. */
function loginShell(os: string, shell: string | undefined): string {
  const name = shell?.split("/").pop();
  return name && SHELLS.includes(name) ? name : os === "macos" ? "zsh" : "bash";
}

/** How the app starts the host on this desktop: a login shell (macOS, Linux) or cmd.exe (Windows). */
export function hostCommand(os: string, shell: string | undefined): { command: string; args: string[] } {
  if (os === "windows") return { command: CMD, args: ["/d", "/c", "pikibun", "host", "--stdio"] };
  return { command: loginShell(os, shell), args: ["-ilc", "exec pikibun host --stdio"] };
}

/**
 * How the app installs or updates the command: npm, started as the host is, so it is the npm (and the global folder)
 * Terminal would use, and the pikibun it installs is the one the host's shell then finds. The command line is fixed.
 */
export function installCommand(os: string, shell: string | undefined): { command: string; args: string[] } {
  if (os === "windows") return { command: CMD, args: ["/d", "/c", ...INSTALL_COMMAND.split(" ")] };
  return { command: loginShell(os, shell), args: ["-ilc", INSTALL_COMMAND] };
}

/** One running host process, however it was started: the real command, or a test's stand-in. */
export interface HostLink {
  /** A request, as one JSON line on its stdin. */
  send(message: object): void;
  /** Its protocol messages, parsed. */
  onMessage(listener: (value: unknown) => void): void;
  /** What it printed outside the protocol (a shell's banner, a library's warning, why it can't start). */
  onOutput(listener: (line: string) => void): void;
  onExit(listener: (result: { code?: number | null; error?: string | null }) => void): void;
  /** Ends its stdin: the host stops its connector and exits. */
  end(): void;
  kill(): void;
}

export type HostLauncher = () => HostLink;

/** Starts `pikibun host --stdio` with NSH's process API. */
export const spawnHost: HostLauncher = () => {
  const { command, args } = hostCommand(platform.os, nshProcess.env.SHELL);
  // It runs in the app's data directory; a host without one (headless tests) names the home folder instead, which only
  // an app granted to write there may.
  let cwd: string | undefined;
  if (!nshProcess.dataDir) { try { cwd = homedir(); } catch { cwd = undefined; } }
  const child = nshProcess.spawn(command, args, { stdin: "pipe", lines: true, ...(cwd ? { cwd } : {}) });
  const messages: ((value: unknown) => void)[] = [];
  const output: ((line: string) => void)[] = [];
  const say = (line: string) => { if (line.trim()) for (const listener of output) listener(line.slice(0, 1000)); };
  child.on("stdout", line => {
    if (!line.startsWith(STDIO_FRAME)) { say(line); return; }
    let value: unknown;
    try { value = JSON.parse(line.slice(STDIO_FRAME.length)); } catch { say("The host sent a malformed message."); return; }
    for (const listener of messages) listener(value);
  });
  child.on("stderr", say);
  return {
    send: message => { try { child.write(`${JSON.stringify(message)}\n`); } catch { /* The host has gone; its exit follows. */ } },
    onMessage: listener => { messages.push(listener); },
    onOutput: listener => { output.push(listener); },
    onExit: listener => { child.on("exit", result => listener(result)); },
    end: () => { try { child.end(); } catch { /* Already gone. */ } },
    kill: () => { try { child.kill(); } catch { /* Already gone. */ } },
  };
};

let launcher: HostLauncher = spawnHost;
/** Tests run a stand-in host instead of the command. Call before anything starts one. */
export function setHostLauncher(next: HostLauncher): void { launcher = next; }

/** One run of npm installing the command: its output lines, then how it ended. */
export interface InstallRun {
  onOutput(listener: (line: string) => void): void;
  onExit(listener: (result: { code?: number | null; error?: string | null }) => void): void;
}

export type Installer = () => InstallRun;

/** Runs `npm install -g pikibun@latest` with NSH's process API, as the owner's shell would. */
export const spawnInstall: Installer = () => {
  const { command, args } = installCommand(platform.os, nshProcess.env.SHELL);
  let cwd: string | undefined;
  if (!nshProcess.dataDir) { try { cwd = homedir(); } catch { cwd = undefined; } }
  const child = nshProcess.spawn(command, args, { lines: true, timeoutMs: INSTALL_TIMEOUT_MS, ...(cwd ? { cwd } : {}) });
  return {
    onOutput: listener => { child.on("stdout", listener); child.on("stderr", listener); },
    onExit: listener => { child.on("exit", result => listener(result)); },
  };
};

let installer: Installer = spawnInstall;
/** Tests run a stand-in for npm instead. */
export function setInstaller(next: Installer): void { installer = next; }

/** Why npm couldn't install the command, as the owner can fix it, from what it printed and how it ended. */
export function installFailure(lines: readonly string[], result: { code?: number | null; error?: string | null }): string {
  const text = lines.join("\n");
  const node = `Node.js 24 or newer (from nodejs.org${platform.os === "macos" ? ", or brew install node" : ""})`;
  if (result.code === 127 || result.code === 9009 || /npm: (command )?not found|not found: npm|'npm' is not recognized/i.test(text)) {
    return `npm isn't installed on ${computerName}. Install ${node}, then choose Install again.`;
  }
  if (/\bEACCES\b|\bEPERM\b|permission denied/i.test(text)) {
    return `npm couldn't write to its global folder on ${computerName}: permission denied. Run the command below in a terminal${platform.os === "windows" ? " as administrator" : " with sudo in front"}, then choose Refresh.`;
  }
  if (result.error) return `The install didn't finish: ${result.error}`;
  const last = lines.filter(line => line.trim()).slice(-3).join(" ");
  return last ? `npm couldn't install pikibun: ${last}` : `npm couldn't install pikibun (exit code ${result.code ?? "unknown"}).`;
}

/** Why the command couldn't start the host, as the owner can fix it. */
export type LaunchProblem =
  | { kind: "missing" }
  | { kind: "outdated" }
  | { kind: "failed"; message: string };

/** What the lines a host printed before it exited say about why it never got ready. */
export function launchProblem(lines: readonly string[], code: number | null | undefined): LaunchProblem {
  const text = lines.join("\n");
  if (/Unknown command: host/.test(text)) return { kind: "outdated" };
  if (code === 127 || code === 9009 || /pikibun: (command )?not found|not found: pikibun|'pikibun' is not recognized/i.test(text)) return { kind: "missing" };
  const node = lines.find(line => line.startsWith("pikibun needs Node.js"));
  if (node) return { kind: "failed", message: `${node} Install Node.js 24 (from https://nodejs.org, or nvm install 24), then choose Refresh.` };
  const last = lines.filter(line => line.trim()).slice(-3).join(" ");
  return { kind: "failed", message: last ? `The host could not start: ${last}` : `The host could not start (exit code ${code ?? "unknown"}).` };
}

type Request = HostRequest extends infer R ? R extends HostRequest ? Omit<R, "id"> : never : never;
type HostResult = Extract<HostEvent, { type: "result" }>;
const eventTypes = new Set(["ready", "result", "status", "log", "failed", "login"]);
const isHostEvent = (value: unknown): value is HostEvent => typeof value === "object" && value !== null
  && "type" in value && typeof value.type === "string" && eventTypes.has(value.type);

/**
 * The host process, started on the first request and never restarted by itself: an exit is reported, and the next
 * request starts a fresh one.
 */
class HostChannel {
  private link?: HostLink;
  private ready?: Promise<void>;
  private readonly pending = new Map<number, (result: HostResult) => void>();
  private nextId = 1;
  private stopping = false;
  private problem?: LaunchProblem;

  constructor(private readonly handlers: {
    onEvent(event: Exclude<HostEvent, HostResult | { type: "ready" }>): void;
    onOutput(line: string): void;
    onExit(code: number | null | undefined, expected: boolean): void;
  }) {}

  get running(): boolean { return this.link !== undefined; }

  private spawn(): Promise<void> {
    this.problem = undefined;
    let link: HostLink;
    try { link = launcher(); }
    catch (error) {
      this.problem = { kind: "failed", message: `The host could not be started: ${error instanceof Error ? error.message : String(error)}` };
      return Promise.reject(error);
    }
    this.link = link;
    this.stopping = false;
    let isReady = false;
    let settled = false;
    /** What it printed before it got ready: why it never did, if it doesn't. */
    const early: string[] = [];
    return new Promise<void>((resolve, reject) => {
      // Until it is ready, what it prints is the login shell's (bash's job-control warnings, a banner) or why it can't
      // start, which becomes its launch problem; once ready, the host's own output goes to its activity.
      link.onOutput(line => {
        if (isReady) { this.handlers.onOutput(line); return; }
        early.push(line);
        if (early.length > 40) early.shift();
      });
      link.onMessage(value => {
        if (!isHostEvent(value)) return;
        if (value.type === "ready") { isReady = true; settled = true; resolve(); return; }
        if (value.type !== "result") { this.handlers.onEvent(value); return; }
        const settle = this.pending.get(value.id);
        this.pending.delete(value.id);
        settle?.(value);
      });
      link.onExit(result => {
        if (this.link !== link) return;
        this.link = undefined;
        this.ready = undefined;
        if (!isReady) this.problem = launchProblem(early, result.code);
        if (!settled) { settled = true; reject(new Error("exited")); }
        for (const [id, settle] of this.pending) settle({ type: "result", id, ok: false, error: { code: "failed", message: "The host process exited before it answered." } });
        this.pending.clear();
        this.handlers.onExit(result.code, this.stopping || !isReady);
      });
    });
  }

  /** Why the latest start failed, if it did. */
  get launchFailure(): LaunchProblem | undefined { return this.problem; }

  /** Sends `message` once the host is ready; `sent` learns its id first (a sign-in's, which its answers name). */
  async request(message: Request, sent?: (id: number) => void): Promise<HostResult> {
    this.ready ??= this.spawn();
    const starting = this.ready;
    try { await starting; }
    catch {
      if (this.ready === starting) this.ready = undefined;
      const problem = this.problem;
      return { type: "result", id: 0, ok: false, error: { code: "unsupported", message: problem?.kind === "failed" ? problem.message : "The pikibun command isn't ready on this computer." } };
    }
    const link = this.link!;
    const id = this.nextId++;
    const result = new Promise<HostResult>(resolve => this.pending.set(id, resolve));
    sent?.(id);
    link.send({ ...message, id });
    return result;
  }

  /** Stops the connector, then ends the process; one that doesn't exit in time is killed. */
  async shutdown(timeoutMs = 10_000): Promise<void> {
    const link = this.link;
    if (!link) { this.ready = undefined; return; }
    this.stopping = true;
    const exited = new Promise<void>(resolve => link.onExit(() => resolve()));
    const deadline = setTimeout(() => link.kill(), timeoutMs);
    void this.request({ type: "stop" }).then(() => link.end());
    await exited;
    clearTimeout(deadline);
  }
}

export interface LogLine { time: number; level: "info" | "warning" | "error"; message: string }
export interface ModelChoice { provider: string; modelId: string }
/** macOS's choice: its own Seatbelt sandbox (experimental), or none, after consent at each start. */
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

/** What the owner chose here, kept in the app's storage. */
interface Saved {
  sandbox?: MacSandbox;
  /** The models to offer; none: Pi chooses, as `pikibun connect` without --model. */
  models?: ModelChoice[];
  /** The host was running when the app quit: start it again for this server, with the consent given then. */
  resume?: { server: string; unsandboxedConsent: boolean };
}

const SAVED_KEY = "pikibun.thisComputer";

export interface Outcome { ok: boolean; error?: string }

const isLoopbackHttp = (origin: string) => {
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  } catch { return false; }
};
const isHttps = (url: string) => { try { return new URL(url).protocol === "https:"; } catch { return false; } };

/**
 * This computer's host as the app sees it: what the host process reports, the owner's settings, and the start flow with
 * the unsandboxed consent. One per app: the host outlives the settings page that shows it.
 */
export class ThisComputerHost {
  readonly state = signal<HostState>("stopped");
  /** The server it runs for, and how, while it runs. */
  readonly running = signal<{ server: string; unsandboxed: boolean; sandbox?: HostInspection["sandbox"] } | null>(null);
  readonly inspection = signal<HostInspection | null>(null);
  readonly inspecting = signal(false);
  /** Why the command couldn't start the host: not installed, too old, or what it said. */
  readonly problem = signal<LaunchProblem | null>(null);
  /** npm is installing or updating the command. */
  readonly installing = signal(false);
  /** Why the latest install didn't give this computer a command the host starts with. */
  readonly installError = signal("");
  readonly error = signal("");
  readonly logs = signal<LogLine[]>([]);
  readonly providers = signal<LoginProvider[] | null>(null);
  readonly providersError = signal("");
  readonly signIn = signal<(SignInView & { login?: number }) | null>(null);
  readonly sandbox = signal<MacSandbox>("none");
  readonly models = signal<ModelChoice[] | null>(null);
  private resume: Saved["resume"];
  private loaded?: Promise<void>;
  /** The server the page or the host last named: refreshes of their own keep its loopback allowance. */
  private server?: string;
  /** Whether `error` is an inspection's, which the next good one clears; a failure's stays until the next start. */
  private inspectError = false;
  private readonly channel = new HostChannel({
    onEvent: event => this.handleEvent(event),
    onOutput: line => this.log("info", line),
    onExit: (code, expected) => this.handleExit(code, expected),
  });

  constructor(private readonly confirmUnsandboxed: (warning: string, server: string, missing: string[]) => Promise<boolean>) {}

  /** The owner's choices, read once from storage. */
  load(): Promise<void> {
    this.loaded ??= Storage.getItem(SAVED_KEY).then(raw => {
      if (!raw) return;
      const saved = JSON.parse(raw) as Saved;
      if (saved.sandbox === "seatbelt") this.sandbox.set("seatbelt");
      const models = Array.isArray(saved.models) ? saved.models.filter(model => typeof model?.provider === "string" && typeof model?.modelId === "string") : [];
      if (models.length) this.models.set(models);
      if (saved.resume && typeof saved.resume.server === "string") this.resume = { server: saved.resume.server, unsandboxedConsent: saved.resume.unsandboxedConsent === true };
    }).catch(() => undefined);
    return this.loaded;
  }

  private save(): void {
    const saved: Saved = { ...(untracked(this.sandbox) === "seatbelt" ? { sandbox: "seatbelt" as const } : {}), ...(untracked(this.models)?.length ? { models: untracked(this.models)! } : {}),
      ...(this.resume ? { resume: this.resume } : {}) };
    Storage.setItem(SAVED_KEY, JSON.stringify(saved)).catch(() => undefined);
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
      this.running.set({ server: event.server, unsandboxed: event.unsandboxed === true,
        ...(event.sandbox === "bubblewrap" || event.sandbox === "seatbelt" || event.sandbox === "windows" ? { sandbox: event.sandbox } : {}) });
    }
    if (event.server !== undefined) this.server = event.server;
    if (event.state === "connected") this.error.set("");
    // A first connection may have just saved a pairing: show it.
    if (event.state === "connected" && previous !== "connected") void this.refresh(event.server);
  }

  /** A started host failed or stopped by itself: the next launch must not resume it. */
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

  /** macOS in Seatbelt, and native Windows always (its only sandbox here), ask for the platform's own sandbox. */
  private isolation(): { experimentalSandbox?: true } {
    return platform.os === "windows" || (platform.os === "macos" && untracked(this.sandbox) === "seatbelt") ? { experimentalSandbox: true } : {};
  }

  /**
   * Looks at what this computer would run, without starting anything. `server`, else the one last named, decides
   * whether a pairing with plain HTTP on loopback (a development server) reads as one.
   */
  async refresh(server?: string): Promise<HostInspection | undefined> {
    if (server) this.server = server;
    const origin = server ?? this.server;
    this.inspecting.set(true);
    try {
      const result = await this.channel.request({ type: "inspect", ...this.isolation(), ...(origin && isLoopbackHttp(origin) ? { allowInsecureLoopback: true } : {}) });
      const problem = this.channel.launchFailure;
      this.problem.set(!result.ok && problem ? problem : null);
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

  /**
   * The owner's start: refuses early what the host would refuse, asks for unsandboxed consent, then hands the request
   * to the host. `resume` replays the consent given at the last start instead of asking again. A pairing is made only
   * once everything else is settled (`pairing.create`), so a refusal leaves no unused code on the server.
   */
  async start(server: string, pairing?: { create: () => Promise<{ id: string; code: string }>; replace: boolean }, resume?: { unsandboxedConsent: boolean }): Promise<Outcome> {
    if (untracked(this.state) !== "stopped") return { ok: false, error: "The host is already running." };
    this.inspectError = false;
    const inspection = await this.refresh(server);
    if (!inspection) return this.refuse(untracked(this.problem) ? "" : untracked(this.error) || `${computerTitle} could not be inspected.`);
    const offered = this.offeredModels(inspection);
    const failure = inspection.unsupported ?? inspection.prerequisitesError
      ?? (!pairing && inspection.pairedServer !== server ? `${computerTitle} is not paired with ${server} yet.` : undefined)
      // Checked here, before a pairing is made: the host would refuse to start without a model to offer.
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

  /**
   * Installs or updates the command with npm (`npm install -g pikibun@latest`), then looks at this computer again for
   * `server`: once the command is there, the page carries on to pairing. Its output goes to the activity.
   */
  async install(server?: string): Promise<Outcome> {
    if (untracked(this.installing)) return { ok: false, error: "pikibun is already being installed." };
    if (untracked(this.state) !== "stopped") return { ok: false, error: "Stop the host first." };
    this.installing.set(true);
    this.installError.set("");
    this.log("info", `Running ${INSTALL_COMMAND}.`);
    const lines: string[] = [];
    let failure: string | undefined;
    try {
      const result = await new Promise<{ code?: number | null; error?: string | null }>(resolve => {
        let run: InstallRun;
        try { run = installer(); }
        catch (error) { resolve({ code: null, error: error instanceof Error ? error.message : String(error) }); return; }
        run.onOutput(line => {
          if (!line.trim()) return;
          lines.push(line);
          if (lines.length > 40) lines.shift();
          this.log("info", line.slice(0, 1000));
        });
        run.onExit(resolve);
      });
      if (result.code !== 0) failure = installFailure(lines, result);
    } finally {
      this.installing.set(false);
    }
    if (failure) {
      this.installError.set(failure);
      this.log("error", failure);
      return { ok: false, error: failure };
    }
    this.log("info", "npm installed pikibun.");
    await this.refresh(server);
    // Installed, yet still not found: npm's global folder isn't on the login shell's PATH.
    if (untracked(this.problem)?.kind === "missing") {
      const message = `npm installed pikibun, but ${computerName}'s ${platform.os === "windows" ? "PATH" : "login shell"} doesn't find it. Add npm's global folder (npm prefix -g${platform.os === "windows" ? "" : ", then its bin"}) to your PATH, then choose Refresh.`;
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
    // The owner's stop also ends resuming: the next launch leaves the host stopped.
    this.setResume(undefined);
    if (!this.channel.running || untracked(this.state) === "stopped") return { ok: true };
    const result = await this.channel.request({ type: "stop" });
    return result.ok ? { ok: true } : this.refuse(result.error.message);
  }

  /** At launch: start again if the owner left the host running, without asking for consent they already gave. */
  async resumeHosting(): Promise<void> {
    await this.load();
    const resume = this.resume;
    if (!resume) return;
    const outcome = await this.start(resume.server, undefined, resume);
    if (!outcome.ok) this.setResume(undefined);
  }

  /** macOS: its own sandbox or none, from the host's next start; only while it is stopped. */
  async setSandbox(choice: MacSandbox): Promise<Outcome> {
    if (platform.os !== "macos") return { ok: false, error: "Only macOS offers a choice of sandbox here." };
    if (untracked(this.state) !== "stopped") return { ok: false, error: "Stop the host first: its sandbox changes from its next start." };
    if (untracked(this.signIn)?.state === "running") return { ok: false, error: "Finish or cancel the sign-in first." };
    if (choice === untracked(this.sandbox)) return { ok: true };
    this.sandbox.set(choice);
    // Its consent was for the other choice.
    this.resume = undefined;
    this.save();
    this.inspection.set(null);
    this.error.set("");
    this.log("info", choice === "seatbelt" ? "Sessions run in macOS's own sandbox (experimental) from the host's next start, or without one, after your consent, while it isn't ready."
      : "Sessions run without a sandbox, after your consent, from the host's next start.");
    await this.refresh();
    return { ok: true };
  }

  /**
   * The models to offer from the next start; null leaves the choice to Pi. An empty list is refused: the host offers
   * Pi's whole set without one, the opposite of what it would say.
   */
  setModels(models: ModelChoice[] | null): Outcome {
    if (models && !models.length) return { ok: false, error: "Check at least one model, or let Pi choose." };
    this.models.set(models);
    this.save();
    if (untracked(this.state) !== "stopped") this.log("info", "The model choice applies from the host's next start.");
    return { ok: true };
  }

  /** What a start would offer: the chosen models Pi still has, or, with no choice, Pi's own. */
  private offeredModels(inspection: HostInspection): ModelChoice[] {
    const chosen = untracked(this.models);
    const available = inspection.models.map(model => ({ provider: model.provider, modelId: model.modelId }));
    return chosen ? chosen.filter(model => available.some(entry => entry.provider === model.provider && entry.modelId === model.modelId)) : available;
  }

  /** Lists Pi's providers this host can sign in to. */
  async loadProviders(): Promise<Outcome> {
    const result = await this.channel.request({ type: "providers" });
    if (result.ok) { this.providers.set(result.providers ?? []); this.providersError.set(""); }
    else { this.providers.set(null); this.providersError.set(result.error.message); }
    return result.ok ? { ok: true } : { ok: false, error: result.error.message };
  }

  /**
   * Signs Pi in to a provider on this computer, as `pi`'s /login does; settles once it ends. Its page opens in the
   * browser; its questions wait in `signIn` for answers. Afterwards the models are listed again.
   */
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

  /** What the running sign-in shows or asks; events of an earlier one are ignored. */
  private handleLogin(login: number, event: LoginEvent): void {
    const current = this.current;
    if (!current || current.state !== "running" || current.login !== login) return;
    if (event.kind === "prompt") current.prompt = { id: event.prompt, detail: event.detail };
    else if (event.kind === "prompt-closed") { if (current.prompt?.id === event.prompt) current.prompt = undefined; }
    else {
      current.notices = [...current.notices, event].slice(-NOTICES);
      // As `pi` does: the page to sign in on opens in the browser by itself.
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

  /** Ends the host process (the app is going away, or a test is done). */
  shutdown(): Promise<void> { return this.channel.shutdown(); }
}

let shared: ThisComputerHost | undefined;
let consent: (warning: string, server: string, missing: string[]) => Promise<boolean> = async () => false;

/** How the app asks for unsandboxed consent: a dialog, set once by the UI. */
export function setUnsandboxedConsent(ask: typeof consent): void { consent = ask; }

/** The app's one host. */
export function thisComputer(): ThisComputerHost {
  shared ??= new ThisComputerHost((warning, server, missing) => consent(warning, server, missing));
  return shared;
}

/** At launch, on the desktops: hosting starts again if it was running when the app quit. */
export function resumeThisComputer(): void {
  if (!hostsHere) return;
  void thisComputer().resumeHosting();
}
