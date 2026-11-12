export interface ServerInspectRequest { type: "inspect"; id: number }

export interface ServerStartRequest {
  type: "start";
  id: number;
  unsandboxedConsent?: boolean;
}

export interface ServerStopRequest { type: "stop"; id: number }

export type ServerRequest = ServerInspectRequest | ServerStartRequest | ServerStopRequest;

export interface ServerInspection {
  stateDir: string;
  port: number;
  hostMode: "sandboxed" | "unsandboxed";
  unsandboxedWarning?: string;
  hostProblem?: string;
}

export type ServerState = "stopped" | "starting" | "running" | "stopping";
export type ServerHostState = "off" | "waiting" | "connecting" | "connected" | "disconnected" | "stopped" | "failed";

export interface ServerStatus {
  state: ServerState;
  origin?: string;
  signInToken?: string;
  host: ServerHostState;
}

export type ServerEvent =
  | { type: "ready" }
  | { type: "result"; id: number; ok: true; inspection?: ServerInspection }
  | { type: "result"; id: number; ok: false; error: { message: string } }
  | ({ type: "status" } & ServerStatus)
  | { type: "log"; level: "info" | "warning" | "error"; message: string };
