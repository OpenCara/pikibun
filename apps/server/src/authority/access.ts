import type { Permission, WorkspaceRole } from '../../../../packages/shared/src/types.js';
import { permissions } from '../../../../packages/shared/src/types.js';
import { hasPermission, managesSession, normalizePermissions, roleSessionCeiling, sessionCreatorRoles, workspaceManagerRoles, workspaceSessionPermissions } from '../../../../packages/shared/src/policy.js';
import type { AppContext, Env, MemberRow, SessionAccess, SessionRow } from '../types.js';
import { fail, testMode } from '../http.js';
import { requireActiveSession } from '../db.js';

/*
 * Who may do what: workspace membership and roles, and each person's access to a session from one policy snapshot
 * (ownership, workspace visibility and role, explicit grants). Every other check of the authority starts from these.
 */

export async function requireMember(env: Env, workspaceId: string, userId: string, roles?: readonly WorkspaceRole[]): Promise<MemberRow> {
  const member = await env.DB.query<MemberRow>('SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?').bind(workspaceId, userId).first();
  if (!member) fail(404, 'not_found', 'Workspace not found.');
  if (roles && !roles.includes(member.role)) fail(403, 'forbidden', 'Workspace administrator access is required.');
  return member;
}
/** The actor's membership, as long as its role may create sessions there: a viewer only follows other people's. */
export async function requireSessionCreator(env: Env, workspaceId: string, userId: string): Promise<MemberRow> {
  const member = await requireMember(env, workspaceId, userId);
  if (!sessionCreatorRoles.includes(member.role)) fail(403, 'viewer_role', 'Viewers cannot create sessions in this workspace.');
  return member;
}
/** SQL true while `user` (a bound user id) is a member of `workspace` (an SQL expression) whose role creates sessions. */
export function sessionCreatorSQL(workspace: string): string {
  return `EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ${workspace} AND user_id = ?
    AND role IN (${sessionCreatorRoles.map(role => `'${role}'`).join(', ')}))`;
}
/** The roles that manage every session of their workspace (workspaceManagerRoles), as an SQL list. */
const sessionManagerRolesSQL = workspaceManagerRoles.map(role => `'${role}'`).join(', ');
/**
 * SQL true while the bound user (one `?`) still manages `session` (the alias of a sessions row) as a whole, as
 * managesSession decides it: a member of its workspace, not suspended, who owns it or is the workspace's owner or an
 * admin. Writes check it themselves rather than trust the policy version alone, which a suspension doesn't bump.
 */
export function sessionManagerSQL(session: string): string {
  return `EXISTS (SELECT 1 FROM workspace_members manager JOIN users manager_user ON manager_user.id = manager.user_id
    WHERE manager.workspace_id = ${session}.workspace_id AND manager.user_id = ? AND manager_user.suspended_at IS NULL
      AND (manager.user_id = ${session}.owner_id OR manager.role IN (${sessionManagerRolesSQL})))`;
}
type SessionPolicyRow = SessionRow & { grants_json: string | null; actor_role: WorkspaceRole };

// Membership, visibility and explicit grants must come from the same policy snapshot. A suspended account opens no
// session, and nobody opens the sessions it owns, as if it had left the workspace.
// The newest pull request a push opened or found comes along for session lists and headers, with its last read state;
// for a session on a host, which pushes with the host's own Git, the one found last for a branch it reported.
const SESSION_ACCESS_SQL = `SELECT s.*, g.permissions_json AS grants_json, actor.role AS actor_role,
  (SELECT pr.pull_request_url FROM push_credentials pr WHERE pr.session_id = s.id AND pr.pull_request_url IS NOT NULL
    ORDER BY pr.completed_at DESC, pr.created_at DESC, pr.id DESC LIMIT 1) AS pull_request_url,
  (SELECT pr.pull_request_state FROM push_credentials pr WHERE pr.session_id = s.id AND pr.pull_request_url IS NOT NULL
    ORDER BY pr.completed_at DESC, pr.created_at DESC, pr.id DESC LIMIT 1) AS pull_request_state,
  (SELECT b.pull_request_url FROM session_branches b WHERE b.session_id = s.id AND b.pull_request_url IS NOT NULL
    ORDER BY b.pull_request_found_at DESC, b.repository, b.branch LIMIT 1) AS branch_pull_request_url,
  (SELECT b.pull_request_state FROM session_branches b WHERE b.session_id = s.id AND b.pull_request_url IS NOT NULL
    ORDER BY b.pull_request_found_at DESC, b.repository, b.branch LIMIT 1) AS branch_pull_request_state FROM sessions s
  INNER JOIN workspace_members actor ON actor.workspace_id = s.workspace_id AND actor.user_id = ?
  INNER JOIN workspace_members owner ON owner.workspace_id = s.workspace_id AND owner.user_id = s.owner_id
  INNER JOIN users actor_user ON actor_user.id = actor.user_id
  INNER JOIN users owner_user ON owner_user.id = owner.user_id
  INNER JOIN agent_versions pinned_agent ON pinned_agent.id = s.agent_version_id
  INNER JOIN models session_model ON session_model.id = pinned_agent.model_id
  LEFT JOIN session_grants g ON g.session_id = s.id AND g.user_id = actor.user_id
  WHERE actor_user.suspended_at IS NULL AND owner_user.suspended_at IS NULL
    AND (? = 1 OR (actor_user.auth_kind <> 'test' AND owner_user.auth_kind <> 'test' AND session_model.provider <> 'faux'))`;

function accessFromSnapshot(snapshot: SessionPolicyRow | null, actorId: string): SessionAccess | null {
  if (!snapshot) return null;
  const { grants_json, actor_role, ...row } = snapshot;
  if (row.owner_id === actorId) return { row, permissions: [...permissions], role: actor_role };
  // Each member's workspace role gives what it allows on the session (the workspace's owner and admins manage every
  // session, private ones included; anyone else only follows or messages one shared with the workspace); explicit
  // grants add to that, up to the role's ceiling (a viewer only ever reads).
  const held = new Set<Permission>(grants_json ? normalizePermissions(JSON.parse(grants_json)) : []);
  for (const permission of workspaceSessionPermissions(actor_role, row.visibility ?? 'private')) held.add(permission);
  if (held.size) held.add('read');
  const ceiling = roleSessionCeiling(actor_role);
  const grants = permissions.filter(permission => held.has(permission) && (!ceiling || ceiling.includes(permission)));
  return grants.length ? { row, permissions: grants, role: actor_role } : null;
}

export async function sessionAccess(env: Env, sessionId: string, actorId: string): Promise<SessionAccess | null> {
  const snapshot = await env.DB.query<SessionPolicyRow>(`${SESSION_ACCESS_SQL} AND s.id = ?`)
    .bind(actorId, testMode(env) ? 1 : 0, sessionId).first();
  return accessFromSnapshot(snapshot, actorId);
}

// The same policy snapshot as SESSION_ACCESS_SQL, for every member of the session's workspace at once.
const actorJoin = 'INNER JOIN workspace_members actor ON actor.workspace_id = s.workspace_id AND actor.user_id = ?';
if (!SESSION_ACCESS_SQL.includes(actorJoin)) throw new Error('Session access SQL changed: update SESSION_READERS_SQL.');
const SESSION_READERS_SQL = SESSION_ACCESS_SQL.replace(actorJoin, 'INNER JOIN workspace_members actor ON actor.workspace_id = s.workspace_id')
  .replace('SELECT s.*,', 'SELECT s.*, actor.user_id AS reader_id,');

/**
 * Everyone who can read the session now, by the rules `sessionAccess` applies to each of them (its owner, its
 * workspace's members where it is shared with the workspace, explicit grants; suspended accounts never). Share links
 * aren't people: callers that care ask `isLinkShared` too.
 */
export async function sessionReaders(env: Env, sessionId: string): Promise<Set<string>> {
  const snapshots = await env.DB.query<SessionPolicyRow & { reader_id: string }>(`${SESSION_READERS_SQL} AND s.id = ?`)
    .bind(testMode(env) ? 1 : 0, sessionId).all();
  const readers = new Set<string>();
  for (const { reader_id, ...snapshot } of snapshots) if (accessFromSnapshot(snapshot, reader_id)) readers.add(reader_id);
  return readers;
}

// The sessions a list may show the actor, before accessFromSnapshot decides each: theirs, those shared with the
// workspace, those they hold a grant on, and every session of a workspace they manage.
const LISTED_SESSIONS_SQL = `(s.owner_id = ? OR s.visibility = 'workspace' OR g.user_id IS NOT NULL OR actor.role IN (${sessionManagerRolesSQL}))`;

export async function listSessionAccess(env: Env, actorId: string): Promise<SessionAccess[]> {
  const snapshots = await env.DB.query<SessionPolicyRow>(`${SESSION_ACCESS_SQL}
    AND ${LISTED_SESSIONS_SQL}
    ORDER BY s.created_at DESC, s.id DESC LIMIT 500`)
    .bind(actorId, testMode(env) ? 1 : 0, actorId).all();
  return snapshots.flatMap(snapshot => {
    const access = accessFromSnapshot(snapshot, actorId);
    return access ? [access] : [];
  });
}
/** Every session of one workspace the actor can read, newest first, on the same policy snapshot as `listSessionAccess`. */
export async function workspaceSessionAccess(env: Env, workspaceId: string, actorId: string): Promise<SessionAccess[]> {
  const snapshots = await env.DB.query<SessionPolicyRow>(`${SESSION_ACCESS_SQL}
    AND s.workspace_id = ? AND ${LISTED_SESSIONS_SQL}
    ORDER BY s.created_at DESC, s.id DESC`)
    .bind(actorId, testMode(env) ? 1 : 0, workspaceId, actorId).all();
  return snapshots.flatMap(snapshot => {
    const access = accessFromSnapshot(snapshot, actorId);
    return access ? [access] : [];
  });
}
export async function requireSession(c: AppContext, sessionId: string, permission: Permission): Promise<SessionAccess> {
  const access = await sessionAccess(c.env, sessionId, c.get('auth').userId);
  if (!access) fail(404, 'not_found', 'Session not found.');
  if (!hasPermission(access.permissions, permission)) fail(403, 'forbidden', `Session ${permission} permission is required.`);
  if (permission !== 'read') await requireActiveSession(c.env, access.row);
  return access;
}
/**
 * Session `sessionId`, for a change to it as a whole that its owner makes, and so do its workspace's owner and admins
 * (managesSession): renaming it, archiving or unarchiving it, its visibility and tool output, turning off its share link.
 * `permission` is what the change takes besides: manage, or read for what an archived session still allows.
 */
export async function requireSessionManager(c: AppContext, sessionId: string, permission: 'read' | 'manage', refusal: string): Promise<SessionAccess> {
  const access = await requireSession(c, sessionId, permission);
  if (!managesSession(c.get('auth').userId, access.row.owner_id, access.role)) fail(403, 'owner_required', refusal);
  return access;
}
