import { adminManagedRoles } from '../../../../packages/shared/src/policy.js';
import type { AssignableWorkspaceRole } from '../../../../packages/shared/src/types.js';
import type { Database, Query } from '../db/types.js';
import { personalWorkspaceSQL } from './personal-workspaces.js';

const managedRoles = adminManagedRoles.map(role => `'${role}'`).join(', ');

export function workspaceOwnerStatement(db: Pick<Database, 'query'>, workspaceId: string, ownerId: string, createdAt: string): Query<never> {
  return db.query<never>("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)")
    .bind(workspaceId, ownerId, createdAt);
}

export interface MemberChange {
  workspaceId: string;
  actorId: string;
  userId: string;
  role: AssignableWorkspaceRole;
  previous: string | null | undefined;
  at: string;
}

export function addMemberStatement(db: Pick<Database, 'query'>, change: MemberChange): Query<never> {
  return db.query<never>(`INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
    SELECT w.id, u.id, ?, ?
    FROM workspaces w
    INNER JOIN workspace_members actor ON actor.workspace_id = w.id AND actor.user_id = ?
    INNER JOIN users u ON u.id = ?
    LEFT JOIN workspace_members target ON target.workspace_id = w.id AND target.user_id = u.id
    WHERE w.id = ? AND u.id <> w.owner_id AND (target.role IS NULL OR target.role <> 'owner') AND NOT ${personalWorkspaceSQL('w.id')}
      AND ((actor.role = 'owner' AND actor.user_id = w.owner_id)
        OR (actor.role = 'admin' AND ? IN (${managedRoles}) AND (target.role IS NULL OR target.role IN (${managedRoles}))))
    ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = excluded.role
      WHERE workspace_members.role = ?`)
    .bind(change.role, change.at, change.actorId, change.userId, change.workspaceId, change.role, change.previous ?? '');
}

export function changeMemberRoleStatement(db: Pick<Database, 'query'>, change: Omit<MemberChange, 'at'> & { previous: string }): Query<never> {
  return db.query<never>(`UPDATE workspace_members SET role = ?
    WHERE workspace_id = ? AND user_id = ? AND role = ? AND role <> 'owner'
      AND EXISTS (SELECT 1 FROM workspaces w
        INNER JOIN workspace_members actor ON actor.workspace_id = w.id AND actor.user_id = ?
        WHERE w.id = workspace_members.workspace_id AND w.owner_id <> workspace_members.user_id
          AND ((actor.role = 'owner' AND actor.user_id = w.owner_id)
            OR (actor.role = 'admin' AND ? IN (${managedRoles}) AND workspace_members.role IN (${managedRoles}))))`)
    .bind(change.role, change.workspaceId, change.userId, change.previous, change.actorId, change.role);
}

export function removeMemberStatements(db: Pick<Database, 'query'>, removal: { workspaceId: string; actorId: string; userId: string; auditId: string }): {
  member: Query<never>; grants: Query<never>; toolGroup: Query<never>;
} {
  return {
    member: db.query<never>(`DELETE FROM workspace_members
      WHERE workspace_id = ? AND user_id = ? AND role <> 'owner'
        AND EXISTS (SELECT 1 FROM workspaces w
          INNER JOIN workspace_members actor ON actor.workspace_id = w.id AND actor.user_id = ?
          WHERE w.id = workspace_members.workspace_id AND w.owner_id <> workspace_members.user_id
            AND ((actor.role = 'owner' AND actor.user_id = w.owner_id)
              OR (actor.role = 'admin' AND workspace_members.role IN (${managedRoles}))))`)
      .bind(removal.workspaceId, removal.userId, removal.actorId),
    grants: db.query<never>(`DELETE FROM session_grants WHERE user_id = ?
      AND session_id IN (SELECT id FROM sessions WHERE workspace_id = ?)
      AND EXISTS (SELECT 1 FROM audit WHERE id = ?)`)
      .bind(removal.userId, removal.workspaceId, removal.auditId),
    toolGroup: db.query<never>(`DELETE FROM workspace_member_tool_groups WHERE workspace_id = ? AND user_id = ?
      AND EXISTS (SELECT 1 FROM audit WHERE id = ?)`)
      .bind(removal.workspaceId, removal.userId, removal.auditId),
  };
}

export function acceptJoinRequestStatement(db: Pick<Database, 'query'>, change: Omit<MemberChange, 'previous'>): Query<never> {
  return db.query<never>(`INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
    SELECT r.workspace_id, r.user_id, ?, ?
    FROM workspace_join_requests r
    INNER JOIN workspaces w ON w.id = r.workspace_id
    INNER JOIN workspace_members actor ON actor.workspace_id = w.id AND actor.user_id = ?
    WHERE r.workspace_id = ? AND r.user_id = ? AND r.user_id <> w.owner_id AND NOT ${personalWorkspaceSQL('w.id')}
      AND ((actor.role = 'owner' AND actor.user_id = w.owner_id)
        OR (actor.role = 'admin' AND ? IN (${managedRoles})))
    ON CONFLICT (workspace_id, user_id) DO NOTHING`)
    .bind(change.role, change.at, change.actorId, change.workspaceId, change.userId, change.role);
}

export function grantSessionStatement(db: Pick<Database, 'query'>, grant: { sessionId: string; policyVersion: number; workspaceId: string; userId: string;
  permissionsJson: string; at: string }): Query<never> {
  return db.query<never>(`INSERT INTO session_grants (session_id, user_id, permissions_json, created_at)
    SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ? AND policy_version = ?)
      AND EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?)
    ON CONFLICT(session_id, user_id) DO UPDATE SET permissions_json = excluded.permissions_json`)
    .bind(grant.sessionId, grant.userId, grant.permissionsJson, grant.at, grant.sessionId, grant.policyVersion, grant.workspaceId, grant.userId);
}

export function revokeSessionGrantStatement(db: Pick<Database, 'query'>, grant: { sessionId: string; policyVersion: number; userId: string }): Query<never> {
  return db.query<never>('DELETE FROM session_grants WHERE session_id = ? AND user_id = ? AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND policy_version = ?)')
    .bind(grant.sessionId, grant.userId, grant.sessionId, grant.policyVersion);
}
