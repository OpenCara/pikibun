import type { ConnectorCapabilities } from "../../../packages/shared/src/connector.js";

export function withHostToolCapabilities(capabilities: ConnectorCapabilities): ConnectorCapabilities {
  return { ...capabilities, hostCommands: true, hostGrants: true, hostSessionGrants: true, unboundedShellGrants: true, hostOwnerDecides: true,
    automaticGitHub: true, requesterAutoApprove: true, memberAutoApprove: true, fileBrowser: true, fileUploads: true, extensions: true, builtinExtensions: true, requiredExtensions: true, ...(process.platform === "linux" ? { hostMigration: true } : {}) };
}
