import type { ConnectorInfo } from "../../shared/src/connector";
import type { ApprovalRecord, Operation, SessionRecord } from "../../shared/src/types";
import { requesterAutoApproves } from "../../shared/src/host-operations";

export function isHostCommand(operation: Pick<Operation, "kind">, session: Pick<SessionRecord, "hostEnvironment">): boolean {
  return operation.kind === "host.bash" || operation.kind === "extension.tool" || ((operation.kind === "bash" || operation.kind === "program") && session.hostEnvironment === true);
}

export { decidedAsHostCommand } from "../../shared/src/host-operations";
export { requesterAutoApproves };

export function offersAlwaysApprove(approval: Pick<ApprovalRecord, "operation" | "requestedBy" | "unbounded">,
  session: Pick<SessionRecord, "ownerId" | "connectorOwnerId" | "hostEnvironment" | "requesterAutoApprove">,
  host: Pick<ConnectorInfo, "capabilities"> | undefined, userId: string): boolean {
  return session.ownerId === userId && approval.requestedBy !== session.ownerId && session.requesterAutoApprove === true
    && (host === undefined || host.capabilities.requesterAutoApprove === true) && requesterAutoApproves(approval.operation, session, approval.unbounded === true);
}

export function decidesHostCommands(session: Pick<SessionRecord, "connectorOwnerId">, host: Pick<ConnectorInfo, "hostCommandAccess"> | undefined,
  userId: string): boolean {
  return (session.connectorOwnerId !== undefined && session.connectorOwnerId === userId) || host?.hostCommandAccess !== undefined;
}

type ListedHost = Pick<ConnectorInfo, "hostCommandAccess"> & { capabilities?: Pick<ConnectorInfo["capabilities"], "hostOwnerDecides"> };

function hostOwnerDecides(operation: Pick<Operation, "kind">, host: ListedHost | undefined): boolean {
  if (operation.kind === "extension.tool") return true;
  return operation.kind === "host.bash" && host?.capabilities?.hostOwnerDecides === true;
}

export function decidesHostCommand(operation: Pick<Operation, "kind">, session: Pick<SessionRecord, "connectorOwnerId">,
  host: ListedHost | undefined, userId: string, canApprove: boolean): boolean {
  const hostOwner = session.connectorOwnerId !== undefined && session.connectorOwnerId === userId;
  return (canApprove && decidesHostCommands(session, host, userId)) || (hostOwner && hostOwnerDecides(operation, host));
}

export function hostCommandWaiting(operation: Pick<Operation, "kind">, host: ListedHost | undefined): string {
  return hostOwnerDecides(operation, host) ? "Waiting for the host's owner, or a member granted host commands with approve access to this session"
    : "Waiting for the host's owner or a member granted host commands, either with approve access to this session";
}

export function extensionToolNotice(operation: { source: string; tool: string }): string {
  if (operation.source === "piki:tunnel" && operation.tool === "tunnel") {
    return "This puts the session's web server online at a public address: the server runs in the session's sandbox, and cloudflared, on the session's host, "
      + "publishes it from the host's network through a Cloudflare tunnel that anyone with the address can open. Only the host's owner, or a member granted host commands, can approve it.";
  }
  return `${operation.tool} comes from the extension ${operation.source}. It runs on the session's host, in its connector, as the host's OS user, `
    + "with access to their files, credentials and network, outside the sandbox. Only the host's owner, or a member granted host commands, can approve it.";
}

export function extensionToolArguments(operation: { arguments: string }): string {
  try { return JSON.stringify(JSON.parse(operation.arguments), null, 2); }
  catch { return operation.arguments; }
}

export function automaticNote(operation: Pick<Operation, "kind">): string {
  return operation.kind === "extension.tool"
    ? "Ran without a decision: its workspace runs this extension's tools automatically on this host, or the owner's auto-approve access ran it"
    : "Ran under the owner's auto-approve access, without a per-command decision";
}
