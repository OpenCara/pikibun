import type { LocalModelSummary } from "../../../packages/shared/src/connector.js";

/**
 * What an app could do itself to provide something a host lacks, once its owner confirms: a fixed list, never a command
 * the host chose. Each would run where the owner sees it (an installer, a terminal window, Settings), never silently.
 */
export type SetupAction =
  /** macOS: Apple's installer for the Command Line Tools (`xcode-select --install`). */
  | { kind: "xcode-tools" }
  /** Windows: Git for Windows, with winget. */
  | { kind: "git-for-windows" }
  /** Windows: Microsoft's MXC SDK, with npm, into the directory the app's native hosts use. */
  | { kind: "mxc-sdk" }
  /** Windows: Settings › Windows Update. */
  | { kind: "windows-update" }
  /** Windows: WSL with Ubuntu (`wsl --install`), as administrator. */
  | { kind: "wsl-install" }
  /** WSL2: Node.js 24 from nvm, in the host's distribution. */
  | { kind: "wsl-node" }
  /** Debian and Ubuntu (WSL2): these packages with apt, in a terminal that asks for the sudo password. */
  | { kind: "apt"; packages: string[] };

/** Microsoft's MXC SDK version the Windows sandbox runs, which the app's mxc-sdk action installs. */
export const MXC_SDK_VERSION = "1.0.1";

/** Packages a SetupAction of kind apt may name: the sandbox's own prerequisites. */
export const APT_PACKAGES = ["bubblewrap", "python3", "git", "util-linux", "python3-venv"] as const;

/** How to get what is missing: what to do, a command or page that does it, and what the app can do itself. */
export interface PrerequisiteFix {
  /** One sentence: what to install or change. */
  text: string;
  /** A terminal command that does it, for the owner to copy. */
  command?: string;
  /** An https page that explains it or downloads it. */
  url?: string;
  action?: SetupAction;
}

/** One binary or tool the chosen isolation mode needs, as connect-setup.ts checks it, and how to get it when missing. */
export interface Prerequisite {
  name: string;
  ok: boolean;
  fix?: PrerequisiteFix;
  /** Needed only for some work (npm for installing extensions): a host lacking it still starts, and lists it as optional. */
  optional?: boolean;
}

// Messages between the app and its connector host (`pikibun host --stdio`, app-host.ts), over the host's stdin and
// stdout only. Pairing codes travel here and nowhere else: never argv, environment, files or logs. Types and patterns
// only, so the app imports nothing from the connector; the host validates every request against them.

export const pairingIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const pairingCodePattern = /^[A-Za-z0-9_-]{8,256}$/;

/**
 * Marks each message line on a --stdio host's stdout (app-host-transport.ts stdioTransport). Anything else there (a
 * library's console.log, say) reaches the app as output, never as a message: the app reads only lines that start with it.
 */
export const STDIO_FRAME = "\u001epikibun ";

/** Development only: the app sets these solely when it runs unpackaged or against a loopback server. */
interface DevelopmentOptions {
  allowFaux?: boolean;
  allowInsecureLoopback?: boolean;
}

/**
 * On macOS and native Windows, run sessions in that platform's own sandbox (`pikibun connect --experimental-sandbox`)
 * where its prerequisites are met, else unsandboxed with consent. Without it those platforms run unsandboxed (macOS) or
 * are refused (native Windows, whose sandbox is otherwise WSL2's). Linux ignores it: bubblewrap is its sandbox.
 */
interface IsolationOptions {
  experimentalSandbox?: boolean;
}

export interface InspectRequest extends DevelopmentOptions, IsolationOptions { type: "inspect"; id: number }

export interface StartRequest extends DevelopmentOptions, IsolationOptions {
  type: "start";
  id: number;
  /** The app's configured origin; a saved pairing for another server is refused, never silently used. */
  server: string;
  pairing?: { id: string; code: string };
  /** With `pairing`, replace this machine's saved pairing. */
  replacePairing?: boolean;
  /** Set only after the owner accepted the unsandboxed warning in a native dialog. */
  unsandboxedConsent?: boolean;
  /** Explicit subset; without it Pi's enabledModels setting, else every authenticated model, is advertised. */
  models?: { provider: string; modelId: string }[];
}

export interface StopRequest { type: "stop"; id: number }

/**
 * One chunk of a file attached to a message in one of the app's pages, for the running connector to take itself
 * (LocalConnector.direct): the grant the control plane signed for it, and the chunk's exact request body.
 */
export interface UploadRequest { type: "upload"; id: number; grant: string; body: string }

/** Pi's providers this host can sign in to, and which it is signed in to already (LoginProvider). */
export interface ProvidersRequest { type: "providers"; id: number }

/**
 * Signs Pi on this host in to a provider, as `pi`'s /login does: the credential is saved in Pi's auth.json here and
 * never leaves the host. Its result comes once the sign-in ends; meanwhile `login` events (LoginEvent) carry what the
 * owner has to see and answer, each naming this request's id. One sign-in at a time.
 */
export interface LoginRequest { type: "login"; id: number; provider: string; method: LoginMethodType }

/** The owner's answer to one of a sign-in's prompts; `value` is what they entered or the option they chose. */
export interface LoginAnswerRequest { type: "login-answer"; id: number; login: number; prompt: number; value: string }

/** Ends a sign-in under way: its own request then fails as cancelled. */
export interface LoginCancelRequest { type: "login-cancel"; id: number; login: number }

export type HostRequest = InspectRequest | StartRequest | StopRequest | UploadRequest | ProvidersRequest | LoginRequest | LoginAnswerRequest | LoginCancelRequest;

export type LoginMethodType = "oauth" | "api_key";

export interface LoginMethod {
  type: LoginMethodType;
  /** Pi's name for it, e.g. "Anthropic (Claude Pro/Max)" or "Anthropic API key". */
  name: string;
  /** Whether it signs in with a provider subscription rather than paid API use. */
  subscription?: boolean;
}

export interface LoginProvider {
  id: string;
  name: string;
  /** Pi has a credential for it saved on this host. */
  signedIn: boolean;
  methods: LoginMethod[];
}

/** A sign-in's prompt, as Pi asks it. A `secret` answer is never shown, logged or kept. */
export type LoginPrompt =
  | { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
  | { type: "select"; message: string; options: { id: string; label: string; description?: string }[] };

export type LoginEvent =
  | { kind: "prompt"; prompt: number; detail: LoginPrompt }
  /** The prompt needs no answer any more: the browser's callback arrived first, say. */
  | { kind: "prompt-closed"; prompt: number }
  /** A page the owner signs in on, in their browser. */
  | { kind: "auth-url"; url: string; instructions?: string }
  | { kind: "device-code"; userCode: string; verificationUri: string }
  | { kind: "info"; message: string; links?: { url: string; label?: string }[] }
  | { kind: "progress"; message: string };

/** Upper bounds of an UploadRequest, which the host checks again. */
export const uploadRequestLimits = { grant: 16_384, body: 1024 * 1024 } as const;

export type HostState = "stopped" | "starting" | "connecting" | "connected" | "disconnected" | "stopping";

/** What this machine would run, read without starting anything. */
export interface HostInspection {
  platform: string;
  stateDir: string;
  /** Why this machine cannot host at all (native Windows, an old Node.js). */
  unsupported?: string;
  /** What would let it host, where the app knows (WSL2 missing, or Node.js in it). */
  unsupportedFix?: PrerequisiteFix;
  /**
   * Linux with bubblewrap and its companions runs sandboxed, as do macOS and native Windows with `experimentalSandbox`
   * and every prerequisite of their own sandbox; everything else needs the owner's unsandboxed consent.
   */
  mode: "sandboxed" | "unsandboxed";
  /** Which sandbox, when sandboxed; absent from hosts that predate it, which sandbox only with bubblewrap. */
  sandbox?: "bubblewrap" | "seatbelt" | "windows";
  /** The isolated sandbox's prerequisites, present even when they are missing (Linux, or `experimentalSandbox`). */
  sandboxPrerequisites?: Prerequisite[];
  /** The chosen mode's prerequisites. */
  prerequisites: Prerequisite[];
  prerequisitesError?: string;
  pairedServer?: string;
  pairingError?: string;
  models: LocalModelSummary[];
  modelsError?: string;
  /** The CLI's exact --unsafe-no-sandbox warning, for the app's native consent dialog. */
  unsandboxedWarning?: string;
}

/** Stable reasons a front end may act on; the message is always shown as is. */
export type HostErrorCode = "invalid-request" | "unsupported" | "consent-required" | "not-paired" | "already-paired"
  | "server-mismatch" | "already-running" | "lease-busy" | "setup" | "failed" | "not-running" | "cancelled" | "busy";

export interface HostError {
  code: HostErrorCode;
  message: string;
  /** What would let this computer host, for a host the app can't launch here (`unsupported`), where it knows. */
  fix?: PrerequisiteFix;
}

export type HostEvent =
  | { type: "ready" }
  | { type: "result"; id: number; ok: true; inspection?: HostInspection; reply?: { status: number; body: string }; providers?: LoginProvider[] }
  /** What the sign-in `login` (its LoginRequest's id) shows or asks now. */
  | { type: "login"; login: number; event: LoginEvent }
  | { type: "result"; id: number; ok: false; error: HostError }
  /** `connectorId`, once connected: the host this computer is on that server, which its pages hand uploads to directly. */
  | { type: "status"; state: HostState; server?: string; unsandboxed?: boolean; sandbox?: HostInspection["sandbox"]; connectorId?: string }
  | { type: "log"; level: "info" | "warning" | "error"; message: string }
  /** A started connector failed or stopped without being asked to. */
  | { type: "failed"; error: HostError };
