// Messages between a desktop app and its local server process (desktop.ts), over the parent's IPC channel only. The
// GitHub OAuth app's secret travels here and nowhere else: never argv, environment or logs. Types only, so the app's
// bundle imports nothing from the server; the process validates every request.

export interface LocalInspectRequest { type: "inspect"; id: number }

/** How a shared Pikibun serves others (the server's state.ts SharedConfig); its GitHub OAuth app's secret only ever goes in. */
export interface LocalSharedSettings {
  /** The public HTTPS origin people open, served through the owner's TLS proxy or tunnel. */
  origin: string;
  listen: "loopback" | "all";
  trustProxy: boolean;
  signup: "open" | "invite" | "off";
  passwordAuth: boolean;
  /** User IDs: github:12345 or password:alice. */
  admins: string[];
}

export interface LocalStartRequest {
  type: "start";
  id: number;
  /** `shared` serves others with `shared`'s settings (or the saved ones); `local`, the default, its owner alone. */
  mode?: "local" | "shared";
  /** A GitHub OAuth app to save first; without one, the saved app (the first start needs one). For `local` only. */
  github?: { clientId: string; clientSecret: string };
  /** For `shared`: the settings to save first, with a GitHub OAuth app for the public origin to replace the saved one. */
  shared?: LocalSharedSettings & { github?: { clientId: string; clientSecret: string } };
  /** Set only after the owner accepted the unsandboxed warning in a native dialog; without it, no host on this computer. */
  unsandboxedConsent?: boolean;
  /** Development builds only: the fixture model, and test sign-ins for 24 hours. */
  testMode?: boolean;
}

export interface LocalStopRequest { type: "stop"; id: number }

/** While shared with password sign-in: creates the administrator password:<username>, which the settings must list. */
export interface LocalCreateAdminRequest { type: "create-admin"; id: number; username: string; password: string }

export type LocalServerRequest = LocalInspectRequest | LocalStartRequest | LocalStopRequest | LocalCreateAdminRequest;

/** What starting would do, read without starting anything. */
export interface LocalInspection {
  stateDir: string;
  port: number;
  /** The saved GitHub OAuth app's client ID; its secret never leaves the process. */
  githubClientId?: string;
  /** How this computer would run sessions as the local server's host. */
  hostMode: "sandboxed" | "unsandboxed";
  unsandboxedWarning?: string;
  /** Why this computer can't be the host (prerequisites, Pi's models); the server still runs without it. */
  hostProblem?: string;
  /** The saved sharing settings, with only the client ID of their GitHub OAuth app. */
  shared?: LocalSharedSettings & { githubClientId?: string };
}

export type LocalServerState = "stopped" | "starting" | "running" | "stopping";
/** This computer as the local server's host: waiting until the owner has signed in, then the connector's own states. */
export type LocalHostState = "off" | "waiting" | "connecting" | "connected" | "disconnected" | "stopped" | "failed";

export interface LocalStatus {
  state: LocalServerState;
  /** While it runs: for its owner alone, or shared with others. */
  mode?: "local" | "shared";
  origin?: string;
  /** While it runs: where it listens (what a shared server's proxy or tunnel forwards to). */
  address?: string;
  /** The owner's sign-in link while nobody has claimed the server. */
  claimUrl?: string;
  host: LocalHostState;
}

export type LocalServerEvent =
  | { type: "ready" }
  | { type: "result"; id: number; ok: true; inspection?: LocalInspection; message?: string }
  | { type: "result"; id: number; ok: false; error: { message: string } }
  | ({ type: "status" } & LocalStatus)
  | { type: "log"; level: "info" | "warning" | "error"; message: string };
