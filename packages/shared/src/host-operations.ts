import { EXTENSION_ARGUMENTS_SHOWN, type ExtensionToolOperation, type GitRepinOperation, type HostCommandOperation } from "./types.js";

declare module "./connector.js" {
  interface ConnectorCapabilities {
    hostCommands?: boolean;
  }
}

export interface HostCommandSession {
  ownerId?: string;
  connectorOwnerId?: string | null;
  hostEnvironment?: boolean;
}

export function grantedShell(session: HostCommandSession): boolean {
  return session.connectorOwnerId !== session.ownerId;
}

export function decidedAsHostCommand(operation: { kind: string }, session: HostCommandSession, unbounded = false): boolean {
  if (operation.kind === "host.bash" || operation.kind === "extension.tool") return true;
  return (operation.kind === "bash" || operation.kind === "program") && (session.hostEnvironment === true || (unbounded && grantedShell(session)));
}

export function requesterAutoApproves(operation: { kind: string }, session: HostCommandSession, unbounded = false): boolean {
  if (operation.kind === "bash" || operation.kind === "program") return !unbounded && !decidedAsHostCommand(operation, session, unbounded);
  return operation.kind === "git.push" || operation.kind === "github.comment" || operation.kind === "github.issue";
}

/**
 * Whether `operation` runs without asking in an Auto-approve message of a member who isn't the session's owner, which
 * their workspace role lets them send (memberAutoApproveRoles in policy.ts): a command that stays in the sandbox, with
 * the host's limits (bash and the program tools: git, node, python, cargo, the browser). Pushes, GitHub comments, issues
 * and merges, host commands, every command of a session that runs on its host, a command without the host's limits and
 * anything the session doesn't allow yet (a permission request) still ask. The control plane, the host and the apps all
 * decide by this one rule.
 */
export function memberAutoApproves(operation: { kind: string }, session: HostCommandSession, unbounded = false): boolean {
  return (operation.kind === "bash" || operation.kind === "program") && requesterAutoApproves(operation, session, unbounded);
}

export function validRepinRef(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 255
    && !/[\s\x00-\x1f\x7f\\~^:?*\[]/.test(value) && !/[\uD800-\uDFFF]/u.test(value)
    && value !== "@" && !value.includes("..") && !value.includes("@{") && !value.endsWith(".")
    && !value.split("/").some(part => !part || part.startsWith(".") || part.endsWith(".lock"));
}

export function validHostOperation(value: unknown): value is HostCommandOperation | GitRepinOperation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const op = value as Record<string, unknown>;
  if (op.kind === "host.bash") return Object.keys(op).sort().join() === "command,kind,timeoutSeconds"
    && typeof op.command === "string" && !!op.command.trim() && op.command.length <= 8192 && !op.command.includes("\0")
    && Number.isSafeInteger(op.timeoutSeconds) && Number(op.timeoutSeconds) >= 1 && Number(op.timeoutSeconds) <= 3600;
  return op.kind === "git.repin" && Object.keys(op).sort().join() === "kind,ref,repository"
    && typeof op.repository === "string" && op.repository.length <= 512
    && /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){1,63}$/.test(op.repository)
    && !op.repository.split("/").some(part => [".", "..", ".git"].includes(part.toLowerCase())) && validRepinRef(op.ref);
}

export function validExtensionToolOperation(value: unknown): value is ExtensionToolOperation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const op = value as Record<string, unknown>;
  return op.kind === "extension.tool" && Object.keys(op).sort().join() === "arguments,digest,kind,source,tool"
    && typeof op.source === "string" && op.source.length > 0 && op.source.length <= 1024 && !op.source.includes("\0")
    && typeof op.tool === "string" && /^[A-Za-z0-9_][A-Za-z0-9_.:/-]{0,127}$/.test(op.tool)
    && typeof op.arguments === "string" && op.arguments.length <= EXTENSION_ARGUMENTS_SHOWN + 1 && !op.arguments.includes("\0")
    && typeof op.digest === "string" && /^[0-9a-f]{64}$/.test(op.digest);
}
