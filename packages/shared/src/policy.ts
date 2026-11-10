import { permissions, sessionRoles, type Permission, type SessionRole, type WorkspaceRole } from "./types.js";

export function hasPermission(grants: readonly Permission[], required: Permission): boolean {
  return grants.includes(required) || (required === "read" && grants.some((grant) => permissions.includes(grant)));
}

export function normalizePermissions(input: unknown): Permission[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > permissions.length) throw new Error("Select one or more valid permissions");
  if (input.some((value) => typeof value !== "string" || !permissions.includes(value as Permission))) throw new Error("Unknown permission");
  const result = new Set<Permission>(input as Permission[]);
  result.add("read");
  return permissions.filter((permission) => result.has(permission));
}

export function validateUserEnv(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Environment must be an object");
  const pairs = Object.entries(input);
  if (pairs.length > 32) throw new Error("At most 32 environment values are supported");
  const result: Record<string, string> = Object.create(null);
  for (const [key, value] of pairs) {
    if (!/^APP_[A-Z0-9_]{1,48}$/.test(key)) throw new Error("Personal environment names must start with APP_ and contain uppercase letters, digits or underscores");
    if (typeof value !== "string" || value.length > 2048 || value.includes("\0")) throw new Error("Environment values must be strings of at most 2048 characters without null bytes");
    if (/(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY)/.test(key)) throw new Error("Credentials belong in connected accounts, not personal environment values");
    result[key] = value;
  }
  return result;
}

export function isSafeRelativePath(path: string): boolean {
  if (!path || path.length > 1024 || path.startsWith("/") || path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path)) return false;
  if (/^[a-zA-Z]:/.test(path)) return false;
  return path.split("/").every((segment) => segment !== ".." && segment !== "." && segment.length > 0 && segment.toLowerCase() !== ".git");
}

export const sessionCreatorRoles: readonly WorkspaceRole[] = ["owner", "admin", "collaborator", "member"];
export const workspaceManagerRoles: readonly WorkspaceRole[] = ["owner", "admin"];
export const adminManagedRoles: readonly WorkspaceRole[] = ["collaborator", "member", "viewer"];

export function workspaceSessionPermissions(role: WorkspaceRole, visibility: "private" | "workspace"): Permission[] {
  if (workspaceManagerRoles.includes(role)) return ["read", "ask", "write", "manage"];
  if (visibility !== "workspace") return [];
  return sharedSessionWriterRoles.includes(role) ? ["read", "ask", "write"] : ["read"];
}

/**
 * Whether `userId`, whose role in the session's workspace is `role`, manages the session as a whole as its owner does:
 * renames, archives and unarchives it, changes its visibility and tool output, and turns off its share link. Its owner
 * does, and so do its workspace's owner and admins; a session admin role manages only who holds a session role.
 * What acts as the session's owner or takes their work elsewhere stays theirs alone: Auto-approve beyond sandboxed
 * commands (see mayAutoApprove), auto-approving another member's requests (where the workspace allows it; see
 * requester-auto-approve.ts), permission requests,
 * scheduled prompts, restarts, backups, restores, moves, exports and creating a share link.
 */
export function managesSession(userId: string, ownerId: string, role: WorkspaceRole | undefined): boolean {
  return userId === ownerId || (role !== undefined && workspaceManagerRoles.includes(role));
}
export const sharedSessionWriterRoles: readonly WorkspaceRole[] = ["owner", "admin", "collaborator"];
/**
 * Workspace roles whose members may send their own messages with Auto-approve to a session they write to but don't own.
 * Approved operations run as the session's owner, so such a message runs without asking only the commands that stay in
 * the sandbox, within the host's limits (memberAutoApproves in host-operations.ts); its pushes, GitHub effects, host
 * commands and anything the session doesn't allow yet still ask, as they do in any of their messages.
 */
export const memberAutoApproveRoles: readonly WorkspaceRole[] = ["owner", "admin", "collaborator"];

/**
 * Whether `userId`, whose role in the session's workspace is `role`, may choose Auto-approve for their messages to a
 * session owned by `ownerId`: its owner always (with everything Auto-approve covers), and a member whose workspace role
 * is one of memberAutoApproveRoles (for their sandboxed commands only). Write permission on the session is checked apart.
 */
export function mayAutoApprove(userId: string, ownerId: string, role: WorkspaceRole | undefined): boolean {
  return userId === ownerId || (role !== undefined && memberAutoApproveRoles.includes(role));
}
/** Roles whose explicit session grants are capped at read (see roleSessionCeiling). */
export const readOnlyRoles: readonly WorkspaceRole[] = ["viewer"];

export function roleSessionCeiling(role: WorkspaceRole): readonly Permission[] | null {
  return readOnlyRoles.includes(role) ? ["read"] : null;
}

export function canCreateSessions(role: WorkspaceRole | undefined): boolean {
  return sessionCreatorRoles.includes(role ?? "member");
}

export const sessionRolePermissions: Readonly<Record<SessionRole, readonly Permission[]>> = {
  viewer: ["read"],
  member: ["read", "ask"],
  collaborator: ["read", "ask", "write"],
  admin: ["read", "ask", "write", "approve", "manage"],
};

export function sessionRoleOf(grants: readonly Permission[]): SessionRole | null {
  const held = new Set<Permission>(grants);
  if (held.size) held.add("read");
  return sessionRoles.find((role) => {
    const tier = sessionRolePermissions[role];
    return tier.length === held.size && tier.every((permission) => held.has(permission));
  }) ?? null;
}

export function sessionRoleAllowed(role: SessionRole, workspaceRole: WorkspaceRole | undefined): boolean {
  const ceiling = workspaceRole ? roleSessionCeiling(workspaceRole) : null;
  return !ceiling || sessionRolePermissions[role].every((permission) => ceiling.includes(permission));
}

export function sessionRoleGrantable(role: SessionRole, held: readonly Permission[]): boolean {
  return sessionRolePermissions[role].every((permission) => hasPermission(held, permission));
}
