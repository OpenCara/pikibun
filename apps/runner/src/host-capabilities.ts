import type { ConnectorCapabilities } from "../../../packages/shared/src/connector.js";

/**
 * Every connector of this version carries host_bash, honors host command grants (those that include sessions on the
 * host too, and the sandboxed commands of members holding one where the host has no resource limits), lets the host's
 * owner decide host commands in any session on it they can read, runs the session owner's GitHub effects under
 * Auto-approve and the requests of members a session's owner auto-approves, lets the session panel browse a session's worktree read-only, and takes
 * files attached to messages into it; the control plane still
 * offers each per host and session. Web tools come from extensions now: no connector of this version advertises `web`;
 * every one runs extensions (`extensions`). On Linux, where restores can be published, it also accepts sessions moved to it from another host.
 */
export function withHostToolCapabilities(capabilities: ConnectorCapabilities): ConnectorCapabilities {
  return { ...capabilities, hostCommands: true, hostGrants: true, hostSessionGrants: true, unboundedShellGrants: true, hostOwnerDecides: true,
    automaticGitHub: true, requesterAutoApprove: true, fileBrowser: true, fileUploads: true, extensions: true, ...(process.platform === "linux" ? { hostMigration: true } : {}) };
}
