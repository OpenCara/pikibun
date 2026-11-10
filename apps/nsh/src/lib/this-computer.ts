import { platform, signal, Storage, untracked } from "nsh";
import { homedir } from "os";
import nshProcess from "process";
import type {
  HostEvent, HostInspection, HostRequest, HostState, LoginEvent, LoginMethodType, LoginPrompt, LoginProvider,
} from "../../../runner/src/app-host-protocol";

export const hostsHere = platform.os === "macos" || platform.os === "windows" || platform.os === "linux";
export const computerTitle = platform.os === "macos" ? "This Mac" : "This Computer";
export const computerName = platform.os === "macos" ? "this Mac" : "this computer";

const STDIO_FRAME = "\u001epikibun ";
const SHELLS = ["zsh", "bash", "sh"];
const CMD = "cmd";
export const APP_CLI_VERSION = "0.27.0";
const CLI_PACKAGE = `pikibun@${APP_CLI_VERSION}`;
export const INSTALL_COMMAND = `npm install -g ${CLI_PACKAGE}`;
const CLI_FOLDER = "cli";
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const LOG_LIMIT = 200;
const NOTICES = 20;

function loginShell(os: string, shell: string | undefined): string {
  const name = shell?.split("/").pop();
  return name && SHELLS.includes(name) ? name : os === "macos" ? "zsh" : "bash";
}

const shellWord = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;

export function appCliFolder(os: string, dataDir: string | null | undefined): string | null {
  if (!dataDir) return null;
  const separator = os === "windows" ? "\\" : "/";
  return `${dataDir.replace(/[\\/]+$/, "")}${separator}${CLI_FOLDER}`;
}

export function hostCommand(os: string, shell: string | undefined, cli?: string | null): { command: string; args: string[] } {
  if (os === "windows") {
    if (!cli) return { command: CMD, args: ["/d", "/c", "pikibun", "host", "--stdio"] };
    const own = `${CLI_FOLDER}\\node_modules\\.bin\\pikibun.cmd`;
    return { command: CMD, args: ["/d", "/c", "if", "exist", own, "(", own, "host", "--stdio", ")", "else", "pikibun", "host", "--stdio"] };
  }
  const path = cli ? `PATH=${shellWord(`${cli}/node_modules/.bin`)}:"$PATH"; export PATH; ` : "";
  return { command: loginShell(os, shell), args: ["-ilc", `${path}exec pikibun host --stdio`] };
}

export function installCommand(os: string, shell: string | undefined, cli?: string | null): { command: string; args: string[]; line: string } {
  const own = ["npm", "install", "--prefix", os === "windows" ? CLI_FOLDER : cli ?? "", "--no-audit", "--no-fund", CLI_PACKAGE];
  if (os === "windows") {
    const words = cli ? own : INSTALL_COMMAND.split(" ");
    return { command: CMD, args: ["/d", "/c", ...words], line: words.join(" ") };
  }
  const line = cli ? own.map((word, index) => (index === 3 ? shellWord(word) : word)).join(" ") : INSTALL_COMMAND;
  return { command: loginShell(os, shell), args: ["-ilc", line], line };
}

export interface HostLink {
  send(message: object): void;
  onMessage(listener: (value: unknown) => void): void;
  onOutput(listener: (line: string) => void): void;
  onExit(listener: (result: { code?: number | null; error?: string | null }) => void): void;
  end(): void;
  kill(): void;
}

export type HostLauncher = () => HostLink;

export const spawnHost: HostLauncher = () => {
  const { command, args } = hostCommand(platform.os, nshProcess.env.SHELL, appCliFolder(platform.os, nshProcess.dataDir));
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
    send: message => { try { child.write(`${JSON.stringify(message)}\n`); } catch { } },
    onMessage: listener => { messages.push(listener); },
    onOutput: listener => { output.push(listener); },
    onExit: listener => { child.on("exit", result => listener(result)); },
    end: () => { try { child.end(); } catch { } },
    kill: () => { try { child.kill(); } catch { } },
  };
};

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
  let cwd: string | undefined;
  if (!nshProcess.dataDir) { try { cwd = homedir(); } catch { cwd = undefined; } }
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

export function installFailure(lines: readonly string[], result: { code?: number | null; error?: string | null }): string {
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
  const last = lines.filter(line => line.trim()).slice(-3).join(" ");
  return last ? `npm couldn't install pikibun: ${last}` : `npm couldn't install pikibun (exit code ${result.code ?? "unknown"}).`;
}

export type LaunchProblem =
  | { kind: "missing" }
  | { kind: "outdated" }
  | { kind: "failed"; message: string };

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
    const early: string[] = [];
    return new Promise<void>((resolve, reject) => {
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

  get launchFailure(): LaunchProblem | undefined { return this.problem; }

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

interface Saved {
  sandbox?: MacSandbox;
  models?: ModelChoice[];
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

export class ThisComputerHost {
  readonly state = signal<HostState>("stopped");
  readonly running = signal<{ server: string; unsandboxed: boolean; sandbox?: HostInspection["sandbox"] } | null>(null);
  readonly inspection = signal<HostInspection | null>(null);
  readonly inspecting = signal(false);
  readonly problem = signal<LaunchProblem | null>(null);
  readonly installing = signal(false);
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
  private server?: string;
  private inspectError = false;
  private readonly channel = new HostChannel({
    onEvent: event => this.handleEvent(event),
    onOutput: line => this.log("info", line),
    onExit: (code, expected) => this.handleExit(code, expected),
  });

  constructor(private readonly confirmUnsandboxed: (warning: string, server: string, missing: string[]) => Promise<boolean>) {}

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

  async install(server?: string): Promise<Outcome> {
    if (untracked(this.installing)) return { ok: false, error: "pikibun is already being installed." };
    if (untracked(this.state) !== "stopped") return { ok: false, error: "Stop the host first." };
    this.installing.set(true);
    this.installError.set("");
    const lines: string[] = [];
    let failure: string | undefined;
    let where = "global" as InstallRun["where"];
    try {
      const result = await new Promise<{ code?: number | null; error?: string | null }>(resolve => {
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
      if (result.code !== 0) failure = installFailure(lines, result);
    } finally {
      this.installing.set(false);
    }
    if (failure) {
      this.installError.set(failure);
      this.log("error", failure);
      return { ok: false, error: failure };
    }
    this.log("info", where === "app" ? "npm installed pikibun in Pikibun's own folder." : "npm installed pikibun.");
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
    if (untracked(this.state) !== "stopped") return { ok: false, error: "Stop the host first: its sandbox changes from its next start." };
    if (untracked(this.signIn)?.state === "running") return { ok: false, error: "Finish or cancel the sign-in first." };
    if (choice === untracked(this.sandbox)) return { ok: true };
    this.sandbox.set(choice);
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

  shutdown(): Promise<void> { return this.channel.shutdown(); }
}

let shared: ThisComputerHost | undefined;
let consent: (warning: string, server: string, missing: string[]) => Promise<boolean> = async () => false;

export function setUnsandboxedConsent(ask: typeof consent): void { consent = ask; }

export function thisComputer(): ThisComputerHost {
  shared ??= new ThisComputerHost((warning, server, missing) => consent(warning, server, missing));
  return shared;
}

export function resumeThisComputer(): void {
  if (!hostsHere) return;
  void thisComputer().resumeHosting();
}
