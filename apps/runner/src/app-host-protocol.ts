import type { LocalModelSummary } from "../../../packages/shared/src/connector.js";
import type { EntryView, SessionView } from "../../../packages/shared/src/types.js";
import type { SessionViewPatch } from "../../../packages/shared/src/view-patch.js";

export type SetupAction =
  | { kind: "xcode-tools" }
  | { kind: "git-for-windows" }
  | { kind: "mxc-sdk" }
  | { kind: "windows-update" }
  | { kind: "wsl-install" }
  | { kind: "wsl-node" }
  | { kind: "apt"; packages: string[] };

export const MXC_SDK_VERSION = "1.0.1";

export const APT_PACKAGES = ["bubblewrap", "python3", "git", "util-linux", "python3-venv"] as const;

export interface PrerequisiteFix {
  text: string;
  command?: string;
  url?: string;
  action?: SetupAction;
}

export interface Prerequisite {
  name: string;
  ok: boolean;
  fix?: PrerequisiteFix;
  optional?: boolean;
}

export const pairingIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const pairingCodePattern = /^[A-Za-z0-9_-]{8,256}$/;

export const STDIO_FRAME = "\u001epikibun ";

interface DevelopmentOptions {
  allowFaux?: boolean;
  allowInsecureLoopback?: boolean;
}

interface IsolationOptions {
  experimentalSandbox?: boolean;
}

export interface InspectRequest extends DevelopmentOptions, IsolationOptions { type: "inspect"; id: number }

export interface StartRequest extends DevelopmentOptions, IsolationOptions {
  type: "start";
  id: number;
  server: string;
  pairing?: { id: string; code: string };
  replacePairing?: boolean;
  unsandboxedConsent?: boolean;
  models?: { provider: string; modelId: string }[];
}

export interface StopRequest { type: "stop"; id: number }

export interface UploadRequest { type: "upload"; id: number; grant: string; body: string }

export interface ProvidersRequest { type: "providers"; id: number }

export interface LoginRequest { type: "login"; id: number; provider: string; method: LoginMethodType }

export interface LoginAnswerRequest { type: "login-answer"; id: number; login: number; prompt: number; value: string }

export interface LoginCancelRequest { type: "login-cancel"; id: number; login: number }

/** A session on this host, read for the app that started it, without the server (docs/design/local-views.md). */
export interface ViewRequest { type: "view"; id: number; sessionId: string; since?: string; brief?: boolean }

/** Entries of a conversation before one the app holds, as the server's /entries reads them. */
export interface EntriesRequest { type: "entries"; id: number; sessionId: string; conversation: string; before: string; limit: number; brief?: boolean }

export type HostRequest = InspectRequest | StartRequest | StopRequest | UploadRequest | ProvidersRequest | LoginRequest | LoginAnswerRequest | LoginCancelRequest
  | ViewRequest | EntriesRequest;

export type LocalView = { view: SessionView; revision: string } | { patch: SessionViewPatch };

export interface LocalPage { entries: EntryView[]; older: number }

export type LoginMethodType = "oauth" | "api_key";

export interface LoginMethod {
  type: LoginMethodType;
  name: string;
  subscription?: boolean;
}

export interface LoginProvider {
  id: string;
  name: string;
  signedIn: boolean;
  methods: LoginMethod[];
}

export type LoginPrompt =
  | { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
  | { type: "select"; message: string; options: { id: string; label: string; description?: string }[] };

export type LoginEvent =
  | { kind: "prompt"; prompt: number; detail: LoginPrompt }
  | { kind: "prompt-closed"; prompt: number }
  | { kind: "auth-url"; url: string; instructions?: string }
  | { kind: "device-code"; userCode: string; verificationUri: string }
  | { kind: "info"; message: string; links?: { url: string; label?: string }[] }
  | { kind: "progress"; message: string };

export const uploadRequestLimits = { grant: 16_384, body: 1024 * 1024 } as const;

export type HostState = "stopped" | "starting" | "connecting" | "connected" | "disconnected" | "stopping";

export interface HostInspection {
  platform: string;
  stateDir: string;
  unsupported?: string;
  unsupportedFix?: PrerequisiteFix;
  mode: "sandboxed" | "unsandboxed";
  sandbox?: "bubblewrap" | "seatbelt" | "windows";
  sandboxPrerequisites?: Prerequisite[];
  prerequisites: Prerequisite[];
  prerequisitesError?: string;
  pairedServer?: string;
  pairingError?: string;
  models: LocalModelSummary[];
  modelsError?: string;
  unsandboxedWarning?: string;
}

export type HostErrorCode = "invalid-request" | "unsupported" | "consent-required" | "not-paired" | "already-paired"
  | "server-mismatch" | "already-running" | "lease-busy" | "setup" | "failed" | "not-running" | "cancelled" | "busy" | "not-found";

export interface HostError {
  code: HostErrorCode;
  message: string;
  fix?: PrerequisiteFix;
}

export type HostEvent =
  | { type: "ready" }
  | { type: "result"; id: number; ok: true; inspection?: HostInspection; reply?: { status: number; body: string }; providers?: LoginProvider[]; view?: LocalView;
    page?: LocalPage | null }
  | { type: "login"; login: number; event: LoginEvent }
  | { type: "result"; id: number; ok: false; error: HostError }
  | { type: "status"; state: HostState; server?: string; unsandboxed?: boolean; sandbox?: HostInspection["sandbox"]; connectorId?: string }
  | { type: "log"; level: "info" | "warning" | "error"; message: string }
  | { type: "failed"; error: HostError };
