import type { ConnectorInfo } from "../../shared/src/connector";
import type { ApprovalRecord, Operation, SessionRecord } from "../../shared/src/types";
import { requesterAutoApproves } from "../../shared/src/host-operations";

/**
 * Whether an operation runs outside the sandbox, on the session's host, as a host command: `host_bash`, an extension's
 * tool call (`extension.tool`, which runs in the host's connector), or any command
 * of a session that runs directly on its host (SessionRecord.hostEnvironment). Only someone with host command authority
 * decides one (see `decidesHostCommands`); approve permission on the session isn't enough.
 */
export function isHostCommand(operation: Pick<Operation, "kind">, session: Pick<SessionRecord, "hostEnvironment">): boolean {
  return operation.kind === "host.bash" || operation.kind === "extension.tool" || (operation.kind === "bash" && session.hostEnvironment === true);
}

/**
 * Whether deciding an operation takes host command authority: every host command (see `isHostCommand`), and a command
 * without the resource limits the host lacks (`unbounded`, see ApprovalRecord.unbounded) in a session whose owner isn't
 * the host's owner, which still runs in the sandbox, as that owner. The rule the control plane and the host decide by.
 */
export { decidedAsHostCommand } from "../../shared/src/host-operations";
export { requesterAutoApproves };

/**
 * Whether `userId` can choose "Always approve" on `approval`: they own the session, the card is another member's, of an
 * operation that member's requests may run without asking (requesterAutoApproves), the workspace lets owners choose that
 * (SessionRecord.requesterAutoApprove), and the session's host runs such requests (requesterAutoApprove), or isn't in
 * the viewer's host listing to say. The control plane checks all of it again.
 */
export function offersAlwaysApprove(approval: Pick<ApprovalRecord, "operation" | "requestedBy" | "unbounded">,
  session: Pick<SessionRecord, "ownerId" | "connectorOwnerId" | "hostEnvironment" | "requesterAutoApprove">,
  host: Pick<ConnectorInfo, "capabilities"> | undefined, userId: string): boolean {
  return session.ownerId === userId && approval.requestedBy !== session.ownerId && session.requesterAutoApprove === true
    && (host === undefined || host.capabilities.requesterAutoApprove === true) && requesterAutoApproves(approval.operation, session, approval.unbounded === true);
}

/**
 * Whether `userId` holds host command authority in the session, as the control plane checks it before a host command is
 * decided: they own the session's host, or its owner or one of its admins granted them host commands in the session's
 * workspace. `host` is the session's host as that workspace's host listing reports it to them (its `hostCommandAccess`);
 * before the listing loads, only the host's owner is known.
 */
export function decidesHostCommands(session: Pick<SessionRecord, "connectorOwnerId">, host: Pick<ConnectorInfo, "hostCommandAccess"> | undefined,
  userId: string): boolean {
  return (session.connectorOwnerId !== undefined && session.connectorOwnerId === userId) || host?.hostCommandAccess !== undefined;
}

/** The session's host as a host listing reports it, for what host command decisions need of it. */
type ListedHost = Pick<ConnectorInfo, "hostCommandAccess"> & { capabilities?: Pick<ConnectorInfo["capabilities"], "hostOwnerDecides"> };

/**
 * Whether the host's owner decides `operation` without approve permission on the session, as the control plane and the
 * host let them: a host_bash card, once the host's connector lets its owner decide those so (`hostOwnerDecides`; older
 * ones check approve permission on every decision). The commands of a session that runs directly on its host are its
 * owner's own, who decides them with the approve permission they hold there, like every other card.
 */
function hostOwnerDecides(operation: Pick<Operation, "kind">, host: ListedHost | undefined): boolean {
  // An extension's tool call (connectors with extensions all let their owner decide them so).
  if (operation.kind === "extension.tool") return true;
  return operation.kind === "host.bash" && host?.capabilities?.hostOwnerDecides === true;
}

/**
 * Whether `userId` decides `operation`, one decided as a host command is (see `decidedAsHostCommand`), in a session they
 * can see, as the control plane lets them: with approve permission on it (`canApprove`) and host command authority there
 * (see `decidesHostCommands`); or, as the owner of its host, a host_bash card without approve permission where the host
 * lets them (see `hostOwnerDecides`). The caller still leaves out archived and read-only sessions.
 */
export function decidesHostCommand(operation: Pick<Operation, "kind">, session: Pick<SessionRecord, "connectorOwnerId">,
  host: ListedHost | undefined, userId: string, canApprove: boolean): boolean {
  const hostOwner = session.connectorOwnerId !== undefined && session.connectorOwnerId === userId;
  return (canApprove && decidesHostCommands(session, host, userId)) || (hostOwner && hostOwnerDecides(operation, host));
}

/** What host command `operation`'s card says while it waits for someone who may decide it (see `decidesHostCommand`). */
export function hostCommandWaiting(operation: Pick<Operation, "kind">, host: ListedHost | undefined): string {
  return hostOwnerDecides(operation, host) ? "Waiting for the host's owner, or a member granted host commands with approve access to this session"
    : "Waiting for the host's owner or a member granted host commands, either with approve access to this session";
}

/** What an extension tool card says it does: it runs in the host's connector, outside the sandbox, decided like a host command. */
export function extensionToolNotice(operation: { source: string; tool: string }): string {
  return `${operation.tool} comes from the extension ${operation.source}. It runs on the session's host, in its connector, as the host's OS user, `
    + "with access to their files, credentials and network, outside the sandbox. Only the host's owner, or a member granted host commands, can approve it.";
}

/** An extension tool call's arguments for its card: indented JSON, or as they are when cut short. */
export function extensionToolArguments(operation: { arguments: string }): string {
  try { return JSON.stringify(JSON.parse(operation.arguments), null, 2); }
  catch { return operation.arguments; }
}

/** Why a card ran without a decision. */
export function automaticNote(operation: Pick<Operation, "kind">): string {
  return operation.kind === "extension.tool"
    ? "Ran without a decision: its workspace runs this extension's tools automatically on this host, or the owner's auto-approve access ran it"
    : "Ran under the owner's auto-approve access, without a per-command decision";
}
