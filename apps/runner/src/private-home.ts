import type { ConnectorCapabilities } from "../../../packages/shared/src/connector.js";
import type { PrivateForwardRequest, PrivateForwardResponse } from "../../../packages/shared/src/private-sessions.js";
import type { ConnectorOptions } from "./connector.js";

export type PrivateHomeHost = Pick<ConnectorOptions, "localModels" | "unsandboxed" | "resources" | "sandboxBackend" | "allowFaux" | "allowTestShell" | "identityDir">
  & { capabilities?: ConnectorCapabilities };

export interface PrivateHome {
  forward(request: PrivateForwardRequest, signal: AbortSignal): Promise<PrivateForwardResponse>;
  sessions(signal: AbortSignal): Promise<unknown[] | null>;
  stop(): Promise<void>;
}

export type PrivateHomeFactory = (host: PrivateHomeHost) => PrivateHome;

let factory: PrivateHomeFactory | undefined;

export function providePrivateHomes(value: PrivateHomeFactory | undefined): void {
  factory = value;
}

export function startPrivateHome(host: PrivateHomeHost): PrivateHome | undefined {
  return factory?.(host);
}
