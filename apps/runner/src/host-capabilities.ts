import type { ConnectorCapabilities } from "../../../packages/shared/src/connector.js";

export function withHostToolCapabilities(capabilities: ConnectorCapabilities): ConnectorCapabilities {
  return { ...capabilities, hostCommands: true, hostGrants: true, hostSessionGrants: true, ownerHostSessions: true, unboundedShellGrants: true,
    approvalFree: true, fileBrowser: true, fileUploads: true, extensions: true, builtinExtensions: true, requiredExtensions: true, fakeIpTunnels: true, autoModel: true, ...(process.platform === "linux" ? { hostMigration: true } : {}) };
}
