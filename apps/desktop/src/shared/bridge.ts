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
  running?: { server: string; unsandboxed: boolean; connectorId?: string };
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
