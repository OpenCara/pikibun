import type { HostInspection, HostState } from "../../../runner/src/desktop-protocol.js";
import type { LocalInspection, LocalSharedSettings, LocalStatus } from "../../../server/src/local/desktop-protocol.js";

// The typed surface between the app's local pages and its main process. Remote content never sees any of it.

export type { HostInspection, HostState, LocalInspection, LocalSharedSettings, LocalStatus };

export const channels = {
  hostView: "host:view",
  hostUpdate: "host:update",
  hostRefresh: "host:refresh",
  hostStart: "host:start",
  hostStop: "host:stop",
  hostAdd: "host:add",
  hostRemove: "host:remove",
  hostOpen: "host:open",
  hostModels: "host:models",
  hostSandbox: "host:sandbox",
  hostOpenAtLogin: "host:open-at-login",
  settingsView: "settings:view",
  settingsServer: "settings:server",
  settingsUpdate: "settings:update",
  localStart: "local:start",
  localStop: "local:stop",
  localCreateAdmin: "local:create-admin",
  localOpen: "local:open",
} as const;

export interface LogLine { time: number; level: "info" | "warning" | "error"; message: string }

export const stateLabels: Record<HostState, string> = {
  stopped: "Stopped", starting: "Starting…", connecting: "Connecting…", connected: "Online",
  disconnected: "Reconnecting…", stopping: "Stopping…",
};

export interface ModelChoice { provider: string; modelId: string }

/**
 * Where a Windows host's sessions run: in WSL2 (its bubblewrap sandbox, with WSL2's own Pi and connector state, as
 * `pikibun connect` run there), or natively (Windows' own process-container sandbox, experimental, as
 * `pikibun connect --experimental-sandbox`, else unsandboxed with consent). Each server's host has its own choice.
 */
export type WindowsSandbox = "wsl2" | "native";

export interface WindowsSandboxChoice {
  sandbox: WindowsSandbox;
  /** WSL2 only: the distribution, else WSL's default WSL2 one. */
  distro?: string;
}

/**
 * Whether a Mac host's sessions run in macOS's own Seatbelt sandbox (experimental, as
 * `pikibun connect --experimental-sandbox`, else unsandboxed with consent while it isn't ready), or without one, with
 * consent (as `--unsafe-no-sandbox`). Each server's host has its own choice; both share its pairing.
 */
export type MacSandbox = "seatbelt" | "none";

export interface MacSandboxChoice { sandbox: MacSandbox }

/** A host's sandbox, of its platform's kind: Windows' on Windows, the Mac's on macOS. */
export type SandboxChoice = WindowsSandboxChoice | MacSandboxChoice;

export interface WslDistro { name: string; version: number; default: boolean }

/** This computer's WSL: whether wsl.exe lists anything, and its distributions (Docker Desktop's own left out). */
export interface WslStatus { installed: boolean; distros: WslDistro[] }

/** This computer as a host of one server: one connector, like one `pikibun connect`. */
export interface HostView {
  id: string;
  /** The primary connection uses the CLI's own connector state, and its server is what the Pikibun window opens. */
  primary: boolean;
  /** The server the host pairs with and connects to. */
  server: string;
  state: HostState;
  /**
   * Set while the connector runs: the server it connects to and whether it runs unsandboxed; once connected, its id
   * there, which the server's pages hand uploads to directly.
   */
  running?: { server: string; unsandboxed: boolean; sandbox?: HostInspection["sandbox"]; connectorId?: string };
  /** Windows only: where this host's sessions run, WSL2 or native Windows. */
  windows?: WindowsSandboxChoice;
  /** macOS only: whether this host's sessions run in macOS's own sandbox. Absent from apps that predate it. */
  mac?: MacSandboxChoice;
  inspection?: HostInspection;
  inspecting: boolean;
  /** The latest failure, cleared by the next start. */
  error?: string;
  logs: LogLine[];
  /** The models the owner chose to offer; absent, Pi's enabledModels setting or every configured model. */
  models?: ModelChoice[];
  /** The same connection from a terminal, for reference. */
  command: string;
}

export interface HostsView {
  /** "This Mac" on macOS, "This Computer" elsewhere. */
  title: string;
  connections: HostView[];
  /** Absent where the platform has no login items (Linux). */
  openAtLogin?: boolean;
  /** Development builds may advertise fixture models instead of Pi's. */
  fixtureModels: boolean;
  /** Windows only: WSL2's distributions, for hosts that run there. */
  wsl?: WslStatus;
}

export interface StartInput {
  pairing?: { id: string; code: string };
  replacePairing: boolean;
}

export type Outcome = { ok: true } | { ok: false; error: string };

/** Pikibun on this computer (Settings): the local server's state and what starting it would do. */
export interface LocalView {
  /** On while the owner wants it running: it starts again at launch. */
  enabled: boolean;
  /** How it runs, or ran last: for its owner alone, or shared with others. */
  mode: "local" | "shared";
  status: LocalStatus;
  inspection?: LocalInspection;
  /** The latest failure, cleared by the next start. */
  error?: string;
  /** The latest success worth telling (an administrator created). */
  notice?: string;
  logs: LogLine[];
}

export interface GitHubApp { clientId: string; clientSecret: string }

/**
 * Settings' start of Pikibun on this computer. Shared, `admins` may name GitHub logins too (`octocat`, `@octocat`): the
 * app looks up their user IDs before it starts the server.
 */
export type LocalStartInput =
  | { mode: "local"; github?: GitHubApp }
  | { mode: "shared"; shared: LocalSharedSettings & { github?: GitHubApp } };

export interface SettingsView { server: string; defaultServer: string; local: LocalView }

export interface PikibunBridge {
  host: {
    view(): Promise<HostsView>;
    refresh(id: string): Promise<void>;
    start(id: string, input: StartInput): Promise<Outcome>;
    stop(id: string): Promise<Outcome>;
    /** Adds a server to connect this computer to. */
    add(server: string): Promise<Outcome>;
    /** Stops the host and forgets the server; its pairing stays in its state directory. */
    remove(id: string): Promise<Outcome>;
    /** Opens the server in a Pikibun window. */
    open(id: string): Promise<Outcome>;
    /** The models to offer, or null for Pi's own choice. */
    setModels(id: string, models: ModelChoice[] | null): Promise<Outcome>;
    /** Windows and macOS: where the host's sessions run, from its next start; refused while it runs. */
    setSandbox(id: string, choice: SandboxChoice): Promise<Outcome>;
    setOpenAtLogin(enabled: boolean): Promise<Outcome>;
    onUpdate(listener: (view: HostsView) => void): () => void;
  };
  settings: {
    view(): Promise<SettingsView>;
    setServer(origin: string): Promise<Outcome>;
    startLocal(input: LocalStartInput): Promise<Outcome>;
    stopLocal(): Promise<Outcome>;
    createAdmin(input: { username: string; password: string }): Promise<Outcome>;
    /** Opens Pikibun on this computer in the Pikibun window. */
    openLocal(): Promise<Outcome>;
    onUpdate(listener: (view: SettingsView) => void): () => void;
  };
}
