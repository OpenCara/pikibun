import type { HostInspection, HostState, LoginEvent, LoginMethodType, LoginProvider, PrerequisiteFix, SetupAction } from "../../../runner/src/desktop-protocol.js";
import type { HostView, LogLine, ModelChoice, Outcome, SignInView, StartInput } from "../shared/bridge.js";
import type { UploadOutcome } from "../shared/remote-bridge.js";
import type { HostProcess } from "./host-process.js";
import { isLoopbackHttp } from "./origin.js";
import { isMacChoice, isWindowsChoice, type SandboxChoice, type SettingsStore } from "./settings.js";

// The app's view of one connector host, this computer as a host of one server (one connection, one `pikibun connect`):
// what its host process reports, the owner's settings for it, and the start flow with the native unsandboxed consent.
// Windows and the tray render from `view()` and re-render on every change. On Windows each host also has its sandbox,
// WSL2 or native Windows (`SandboxChoice`), which decides how its host process is launched (index.ts); on macOS, macOS's
// own sandbox or none, which decides what its host process is asked for.

const LOG_LIMIT = 200;

export interface HostControllerOptions {
  /** The connection in `settings` this host serves. */
  id: string;
  settings: SettingsStore;
  /** The same connection from a terminal (`pikibun connect ...`), shown for reference. */
  command(server: string): string;
  /** Fixture models instead of Pi's: development builds only. */
  fixtureModels: boolean;
  /**
   * Shows the CLI's warning in a native dialog; resolves true only when the owner accepts it. `missing` names the
   * sandbox prerequisites this computer lacks, where it has a sandbox it can't run yet.
   */
  confirmUnsandboxed(warning: string, server: string, missing: string[]): Promise<boolean>;
  /**
   * Windows and macOS: the connection's sandbox, defaulted, always of the platform's kind; undefined elsewhere (Linux,
   * whose sandbox is bubblewrap where it is installed).
   */
  sandbox?(): SandboxChoice | undefined;
  /** Does a setup action once the owner confirms it in a native dialog (index.ts, setup-actions.ts). */
  runSetup?(action: SetupAction): Promise<Outcome>;
  /** Whether this computer can do `action` (apt on Linux opens no terminal, say); others show only how to do it. */
  canSetup?(action: SetupAction): boolean;
  /** Opens an https page in the owner's browser. */
  openBrowser?(url: string): void;
}

const NOTICES = 20;
const sameAction = (a: SetupAction, b: SetupAction) => JSON.stringify(a) === JSON.stringify(b);
const isHttps = (url: string) => URL.parse(url)?.protocol === "https:";

export class HostController {
  private state: HostState = "stopped";
  private running?: { server: string; unsandboxed: boolean; sandbox?: HostInspection["sandbox"]; connectorId?: string };
  private inspection?: HostInspection;
  private inspecting = 0;
  private error?: string;
  private lastServer = "";
  private readonly logs: LogLine[] = [];
  private readonly listeners = new Set<() => void>();
  private process?: HostProcess;
  private providers?: LoginProvider[];
  /** The latest sign-in, and while it runs, its request's id, which its events and answers name. */
  private signIn?: SignInView & { login?: number };

  constructor(private readonly options: HostControllerOptions) {
    this.lastServer = this.connection?.server ?? "";
  }

  attach(process: HostProcess): void { this.process = process; }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void { for (const listener of this.listeners) listener(); }

  get hostState(): HostState { return this.state; }
  get id(): string { return this.options.id; }
  /** The connection's server; a removed connection keeps the last one it had while it shuts down. */
  get server(): string {
    const server = this.connection?.server;
    if (server) this.lastServer = server;
    return this.lastServer;
  }

  private get connection() { return this.options.settings.connection(this.options.id); }

  private setResume(resumeHost: { unsandboxedConsent: boolean } | undefined): void {
    if (this.connection) this.options.settings.updateConnection(this.options.id, { resumeHost });
  }

  view(): HostView {
    const connection = this.connection;
    const view: HostView = {
      id: this.options.id, primary: this.options.settings.get().connections[0]?.id === this.options.id, server: this.server, state: this.state,
      inspecting: this.inspecting > 0, logs: [...this.logs], command: this.options.command(this.server),
    };
    if (connection?.models) view.models = connection.models.map(model => ({ ...model }));
    if (this.running) view.running = { ...this.running };
    const sandbox = this.options.sandbox?.();
    if (sandbox && isWindowsChoice(sandbox)) view.windows = { ...sandbox };
    else if (sandbox) view.mac = { ...sandbox };
    if (this.inspection) view.inspection = this.offered(this.inspection);
    if (this.error) view.error = this.error;
    if (this.providers) view.providers = this.providers.map(provider => ({ ...provider, methods: provider.methods.map(method => ({ ...method })) }));
    if (this.signIn) {
      const { login: _login, ...signIn } = this.signIn;
      view.signIn = { ...signIn, notices: [...signIn.notices], ...(signIn.prompt ? { prompt: { ...signIn.prompt } } : {}) };
    }
    return view;
  }

  log(level: LogLine["level"], message: string): void {
    this.logs.push({ time: Date.now(), level, message });
    if (this.logs.length > LOG_LIMIT) this.logs.splice(0, this.logs.length - LOG_LIMIT);
    this.changed();
  }

  /** Host process events, already shape-checked by HostProcess. */
  handleStatus(state: HostState, detail: { server?: string; unsandboxed?: boolean; sandbox?: HostInspection["sandbox"]; connectorId?: string }): void {
    const previous = this.state;
    this.state = state;
    if (state === "stopped") this.running = undefined;
    else if (detail.server !== undefined) {
      this.running = { server: detail.server, unsandboxed: detail.unsandboxed === true,
        ...(detail.sandbox === "bubblewrap" || detail.sandbox === "seatbelt" || detail.sandbox === "windows" ? { sandbox: detail.sandbox } : {}),
        ...(state === "connected" && typeof detail.connectorId === "string" ? { connectorId: detail.connectorId } : {}) };
    }
    if (state === "connected") this.error = undefined;
    this.changed();
    // A first connection may have just saved a pairing: show it.
    if (state === "connected" && previous !== "connected") void this.refresh();
  }

  /** A started host failed or stopped by itself: it is not running, so the next launch must not resume it. */
  handleFailure(message: string): void {
    if (this.connection?.resumeHost) this.setResume(undefined);
    this.error = message;
    this.log("error", message);
  }

  handleExit(code: number, expected: boolean): void {
    const wasRunning = this.state !== "stopped";
    this.state = "stopped";
    this.running = undefined;
    if (!expected) this.handleFailure(`The host process exited unexpectedly (code ${code})${wasRunning ? "; the host is offline" : ""}. Start it again when ready.`);
    else this.changed();
  }

  private developmentOptions(server: string): { allowFaux?: true; allowInsecureLoopback?: true } {
    return { ...(this.options.fixtureModels ? { allowFaux: true } : {}), ...(isLoopbackHttp(server) ? { allowInsecureLoopback: true } : {}) };
  }

  /**
   * Native Windows and a Mac in Seatbelt ask for their platform's own sandbox; a WSL2 host is Linux, whose sandbox is
   * bubblewrap anyway, and a Mac without one runs unsandboxed after consent.
   */
  private isolationOptions(): { experimentalSandbox?: true } {
    const sandbox = this.options.sandbox?.()?.sandbox;
    return sandbox === "native" || sandbox === "seatbelt" ? { experimentalSandbox: true } : {};
  }

  async refresh(): Promise<HostInspection | undefined> {
    if (!this.process) return undefined;
    this.inspecting++;
    this.changed();
    try {
      const result = await this.process.request({ type: "inspect", ...this.isolationOptions(), ...this.developmentOptions(this.server) });
      if (result.ok && result.inspection) this.inspection = result.inspection;
      // A host that can't be launched here as configured (no WSL2, no Node.js in it) says what to do instead.
      else if (!result.ok && result.error.code === "unsupported") {
        this.inspection = { platform: process.platform, stateDir: "", unsupported: result.error.message, mode: "unsandboxed", prerequisites: [], models: [],
          ...(result.error.fix ? { unsupportedFix: result.error.fix } : {}) };
      }
      else if (!result.ok) this.error = result.error.message;
      return this.inspection;
    } finally {
      this.inspecting--;
      this.changed();
    }
  }

  /**
   * The owner's start: refuses early what the host would refuse, asks for unsandboxed consent in a native dialog, then
   * hands the request to the host. `resume` replays consent recorded at the owner's last start instead of asking.
   */
  async start(input: StartInput, resume?: { unsandboxedConsent: boolean }): Promise<Outcome> {
    if (!this.process || !this.connection) return { ok: false, error: "The host is unavailable." };
    if (this.state !== "stopped") return { ok: false, error: "The host is already running." };
    const inspection = await this.refresh();
    if (!inspection) return { ok: false, error: this.error ?? "This computer could not be inspected." };
    const failure = inspection.unsupported ?? inspection.prerequisitesError
      ?? (!input.pairing && !inspection.pairedServer ? inspection.pairingError ?? `This computer is not paired with ${this.server} yet. There, open Settings › Hosts, create a pairing code, then enter its pairing ID and code here.` : undefined);
    if (failure) return this.refuse(failure);
    let unsandboxedConsent = false;
    if (inspection.mode === "unsandboxed") {
      const missing = inspection.sandboxPrerequisites?.filter(item => !item.ok).map(item => item.name) ?? [];
      unsandboxedConsent = resume ? resume.unsandboxedConsent : await this.options.confirmUnsandboxed(inspection.unsandboxedWarning ?? "", this.server, missing);
      if (!unsandboxedConsent) return this.refuse(resume ? "Hosting was not resumed: this computer now runs agent work unsandboxed, which needs your consent. Start the host to review it." : "Unsandboxed mode was not confirmed; nothing was started.");
    }
    const server = this.server;
    const models = this.connection?.models;
    this.error = undefined;
    if (input.pairing) this.log("info", input.replacePairing ? `Replacing this computer's pairing with one for ${server}.` : `Pairing this computer with ${server}.`);
    const result = await this.process.request({
      type: "start", server,
      ...(input.pairing ? { pairing: input.pairing, replacePairing: input.replacePairing } : {}),
      ...(unsandboxedConsent ? { unsandboxedConsent: true } : {}),
      ...(models ? { models: models.map(model => ({ ...model })) } : {}),
      ...this.isolationOptions(), ...this.developmentOptions(server),
    });
    if (!result.ok) return this.refuse(result.error.message);
    this.setResume({ unsandboxedConsent });
    this.changed();
    return { ok: true };
  }

  private refuse(error: string): Outcome {
    this.error = error;
    this.changed();
    return { ok: false, error };
  }

  /**
   * Hands the running connector one chunk of a file attached to a message in one of the server's pages, when it is the
   * host `connectorId` names (LocalConnector.direct). Answers the runner's reply, or why this host can't take it.
   */
  async upload(connectorId: string, grant: string, body: string): Promise<UploadOutcome> {
    if (!this.process?.running || this.state !== "connected" || this.running?.connectorId !== connectorId) {
      return { ok: false, error: "That session's host isn't running on this computer.", local: false };
    }
    const result = await this.process.request({ type: "upload", grant, body });
    if (!result.ok) return { ok: false, error: result.error.message, local: true };
    if (!result.reply) return { ok: false, error: "The host could not take the file.", local: true };
    return { ok: true, status: result.reply.status, body: result.reply.body };
  }

  async stop(): Promise<Outcome> {
    // The owner's stop also ends resuming: the next launch leaves the host stopped.
    this.setResume(undefined);
    if (!this.process?.running || this.state === "stopped") { this.changed(); return { ok: true }; }
    const result = await this.process.request({ type: "stop" });
    return result.ok ? { ok: true } : this.refuse(result.error.message);
  }

  /** At launch: start again if the owner left the host running, without asking for consent they already gave. */
  async resume(): Promise<void> {
    const resume = this.connection?.resumeHost;
    if (!resume) return;
    const outcome = await this.start({ replacePairing: false }, resume);
    if (!outcome.ok) this.setResume(undefined);
  }

  /** Why this host's sandbox can't change now, if it can't: checked before anyone is asked to confirm a change. */
  sandboxRefusal(): string | undefined {
    if (!this.connection) return "That server is no longer in the list.";
    if (!this.options.sandbox) return "Only Windows and macOS offer a choice of sandbox.";
    if (this.state !== "stopped") return "Stop the host first: its sandbox changes from its next start.";
    return undefined;
  }

  /** Whether `choice` is this host's current sandbox already. */
  sameSandbox(choice: SandboxChoice): boolean {
    const current = this.options.sandbox?.();
    if (!current || current.sandbox !== choice.sandbox) return false;
    return current.sandbox !== "wsl2" || choice.sandbox !== "wsl2" || current.distro === choice.distro;
  }

  /** Why `choice` can't apply to this host now, if it can't: another platform's kind, or the host isn't stopped. */
  sandboxChoiceRefusal(choice: SandboxChoice): string | undefined {
    const refusal = this.sandboxRefusal();
    if (refusal) return refusal;
    const current = this.options.sandbox!();
    if (current && isWindowsChoice(current) !== isWindowsChoice(choice)) return isMacChoice(choice) ? "That sandbox is macOS's: this computer runs Windows." : "That sandbox is Windows': this computer is a Mac.";
    return undefined;
  }

  /**
   * Where this host's sessions run from its next start: on Windows WSL2 or native Windows, on macOS macOS's own sandbox
   * or none. Only while it is stopped: Windows' two are different host processes with different state (and pairings),
   * and a Mac's host is asked again what it runs. The idle host process of the old choice ends, so the next inspection
   * launches the new one; resuming at launch ends too, since its consent was for the old.
   */
  async setSandbox(choice: SandboxChoice): Promise<Outcome> {
    const refusal = this.sandboxChoiceRefusal(choice);
    if (refusal) return { ok: false, error: refusal };
    if (this.sameSandbox(choice)) return { ok: true };
    this.options.settings.updateConnection(this.options.id, isWindowsChoice(choice) ? { windows: choice, resumeHost: undefined } : { mac: choice, resumeHost: undefined });
    this.inspection = undefined;
    this.error = undefined;
    this.log("info", choice.sandbox === "native" ? "Sessions run natively on Windows from the host's next start."
      : choice.sandbox === "seatbelt" ? "Sessions run in macOS's own sandbox (experimental) from the host's next start, or without one, after your consent, while it isn't ready."
      : choice.sandbox === "none" ? "Sessions run without a sandbox, after your consent, from the host's next start."
      : `Sessions run in WSL2${choice.distro ? ` (${choice.distro})` : ""} from the host's next start.`);
    await this.process?.shutdown(10_000);
    void this.refresh();
    return { ok: true };
  }

  /** A fix as offered here: without an action this computer can't do. */
  private offeredFix(fix: PrerequisiteFix): PrerequisiteFix {
    if (!fix.action || (this.options.runSetup && (this.options.canSetup?.(fix.action) ?? true))) return fix;
    const { action: _action, ...rest } = fix;
    return rest;
  }

  /** The inspection as the window shows it: every fix as offered here. */
  private offered(inspection: HostInspection): HostInspection {
    const prerequisites = (items: HostInspection["prerequisites"]) => items.map(item => item.fix ? { ...item, fix: this.offeredFix(item.fix) } : item);
    return { ...inspection, prerequisites: prerequisites(inspection.prerequisites),
      ...(inspection.sandboxPrerequisites ? { sandboxPrerequisites: prerequisites(inspection.sandboxPrerequisites) } : {}),
      ...(inspection.unsupportedFix ? { unsupportedFix: this.offeredFix(inspection.unsupportedFix) } : {}) };
  }

  /** The fixes the latest inspection offers here: of the missing prerequisites, and of what keeps this computer from hosting. */
  private fixes(): PrerequisiteFix[] {
    const inspection = this.inspection && this.offered(this.inspection);
    if (!inspection) return [];
    return [...(inspection.unsupportedFix ? [inspection.unsupportedFix] : []),
      ...[...inspection.prerequisites, ...(inspection.sandboxPrerequisites ?? [])].filter(item => !item.ok && item.fix).map(item => item.fix!)];
  }

  /**
   * Does what a missing prerequisite's fix offers, once the owner confirms: only an action this host's latest inspection
   * offers, so a page can't ask for one this computer doesn't need. Refresh afterwards shows what changed.
   */
  async setup(action: SetupAction): Promise<Outcome> {
    if (!this.options.runSetup) return { ok: false, error: "This computer can't do that from Pikibun: follow its description instead." };
    if (!this.fixes().some(fix => fix.action && sameAction(fix.action, action))) return { ok: false, error: "This computer doesn't need that now: choose Refresh." };
    const outcome = await this.options.runSetup(action);
    if (outcome.ok) this.log("info", "Setup started outside Pikibun. When it has finished, choose Refresh.");
    return outcome;
  }

  /** Whether `url` is a page this host offered: a fix's, or one its sign-in showed. */
  knownLink(url: string): boolean {
    const links = [...this.fixes().map(fix => fix.url), ...(this.signIn?.notices ?? []).flatMap(notice =>
      notice.kind === "auth-url" ? [notice.url] : notice.kind === "device-code" ? [notice.verificationUri] : notice.kind === "info" ? (notice.links ?? []).map(item => item.url) : [])];
    return isHttps(url) && links.includes(url);
  }

  /** Lists Pi's providers this host can sign in to. */
  async loadProviders(): Promise<Outcome> {
    if (!this.process) return { ok: false, error: "The host is unavailable." };
    const result = await this.process.request({ type: "providers" });
    if (!result.ok) return { ok: false, error: result.error.message };
    this.providers = result.providers ?? [];
    this.changed();
    return { ok: true };
  }

  /**
   * Signs Pi in to a provider on this host, as `pi`'s /login does; settles once it ends. The page it shows opens in the
   * owner's browser; its questions wait in the view for answers. Afterwards the models are listed again.
   */
  async startSignIn(provider: string, method: LoginMethodType): Promise<Outcome> {
    if (!this.process) return { ok: false, error: "The host is unavailable." };
    if (this.signIn?.state === "running") return { ok: false, error: "A sign-in is under way: finish or cancel it first." };
    const name = this.providers?.find(entry => entry.id === provider)?.name ?? provider;
    const current: SignInView & { login?: number } = { provider, name, method, state: "running", notices: [] };
    this.signIn = current;
    this.changed();
    const result = await this.process.request({ type: "login", provider, method }, id => { current.login = id; });
    current.login = undefined;
    current.prompt = undefined;
    current.state = result.ok ? "done" : result.error.code === "cancelled" ? "cancelled" : "failed";
    if (!result.ok && result.error.code !== "cancelled") current.error = result.error.message;
    this.changed();
    if (!result.ok) return { ok: false, error: result.error.message };
    this.log("info", `Pi is signed in to ${name} on this computer.${this.state === "stopped" ? "" : " Its models are offered from the host's next start."}`);
    await Promise.all([this.loadProviders(), this.refresh()]);
    return { ok: true };
  }

  /** What the running sign-in shows or asks (HostProcess events); events of an earlier one are ignored. */
  handleLogin(login: number, event: LoginEvent): void {
    const current = this.signIn;
    if (!current || current.state !== "running" || current.login !== login) return;
    if (event.kind === "prompt") current.prompt = { id: event.prompt, detail: event.detail };
    else if (event.kind === "prompt-closed") { if (current.prompt?.id === event.prompt) current.prompt = undefined; }
    else {
      current.notices.push(event);
      if (current.notices.length > NOTICES) current.notices.splice(0, current.notices.length - NOTICES);
      // As `pi` does: the page to sign in on opens in the browser by itself.
      const page = event.kind === "auth-url" ? event.url : event.kind === "device-code" ? event.verificationUri : undefined;
      if (page && isHttps(page)) this.options.openBrowser?.(page);
    }
    this.changed();
  }

  async answerSignIn(prompt: number, value: string): Promise<Outcome> {
    const current = this.signIn;
    if (!this.process || current?.state !== "running" || current.login === undefined || current.prompt?.id !== prompt) return { ok: false, error: "That question has been answered or has closed." };
    if (current.prompt.detail.type === "select" && !current.prompt.detail.options.some(option => option.id === value)) return { ok: false, error: "Choose one of the options." };
    current.prompt = undefined;
    this.changed();
    const result = await this.process.request({ type: "login-answer", login: current.login, prompt, value });
    return result.ok ? { ok: true } : { ok: false, error: result.error.message };
  }

  async cancelSignIn(): Promise<Outcome> {
    const current = this.signIn;
    if (!this.process || current?.state !== "running" || current.login === undefined) return { ok: true };
    const result = await this.process.request({ type: "login-cancel", login: current.login });
    return result.ok ? { ok: true } : { ok: false, error: result.error.message };
  }

  /** The models to offer from the next start; null leaves the choice to Pi, as `pikibun connect` without --model. */
  setModels(models: ModelChoice[] | null): Outcome {
    if (!this.connection) return { ok: false, error: "That server is no longer in the list." };
    this.options.settings.updateConnection(this.options.id, { models: models ?? undefined });
    if (this.state !== "stopped") this.log("info", "The model choice applies from the host's next start.");
    this.changed();
    return { ok: true };
  }
}
