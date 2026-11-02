import type { HostInspection, HostState } from "../../../runner/src/desktop-protocol.js";
import type { HostView, LogLine, ModelChoice, Outcome, StartInput } from "../shared/bridge.js";
import type { UploadOutcome } from "../shared/remote-bridge.js";
import type { HostProcess } from "./host-process.js";
import { isLoopbackHttp } from "./origin.js";
import type { SandboxChoice, SettingsStore } from "./settings.js";

// The app's view of one connector host, this computer as a host of one server (one connection, one `pikibun connect`):
// what its host process reports, the owner's settings for it, and the start flow with the native unsandboxed consent.
// Windows and the tray render from `view()` and re-render on every change. On Windows each host also has its sandbox,
// WSL2 or native Windows (`SandboxChoice`), which decides how its host process is launched (index.ts).

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
  /** Windows only: the connection's sandbox, defaulted; undefined elsewhere. */
  sandbox?(): SandboxChoice | undefined;
}

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
    if (sandbox) view.windows = { ...sandbox };
    if (this.inspection) view.inspection = this.inspection;
    if (this.error) view.error = this.error;
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

  /** Native Windows asks for its own sandbox; a WSL2 host is Linux, whose sandbox is bubblewrap anyway. */
  private isolationOptions(): { experimentalSandbox?: true } {
    return this.options.sandbox?.()?.sandbox === "native" ? { experimentalSandbox: true } : {};
  }

  async refresh(): Promise<HostInspection | undefined> {
    if (!this.process) return undefined;
    this.inspecting++;
    this.changed();
    try {
      const result = await this.process.request({ type: "inspect", ...this.isolationOptions(), ...this.developmentOptions(this.server) });
      if (result.ok && result.inspection) this.inspection = result.inspection;
      // A host that can't be launched here as configured (no WSL2, no Node.js in it) says what to do instead.
      else if (!result.ok && result.error.code === "unsupported") this.inspection = { platform: process.platform, stateDir: "", unsupported: result.error.message, mode: "unsandboxed", prerequisites: [], models: [] };
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
    if (!this.options.sandbox) return "Only Windows offers a choice of sandbox.";
    if (this.state !== "stopped") return "Stop the host first: its sandbox changes from its next start.";
    return undefined;
  }

  /**
   * Windows: where this host's sessions run from its next start, WSL2 or native Windows. Only while it is stopped: the
   * two are different host processes with different state (and pairings). The idle host process of the old choice
   * ends, so the next inspection launches the new one; resuming at launch ends too, since its consent was for the old.
   */
  async setSandbox(choice: SandboxChoice): Promise<Outcome> {
    const refusal = this.sandboxRefusal();
    if (refusal) return { ok: false, error: refusal };
    const current = this.options.sandbox!();
    if (current && current.sandbox === choice.sandbox && (current.sandbox !== "wsl2" || choice.sandbox !== "wsl2" || current.distro === choice.distro)) return { ok: true };
    this.options.settings.updateConnection(this.options.id, { windows: choice, resumeHost: undefined });
    this.inspection = undefined;
    this.error = undefined;
    this.log("info", choice.sandbox === "native" ? "Sessions run natively on Windows from the host's next start." : `Sessions run in WSL2${choice.distro ? ` (${choice.distro})` : ""} from the host's next start.`);
    await this.process?.shutdown(10_000);
    void this.refresh();
    return { ok: true };
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
