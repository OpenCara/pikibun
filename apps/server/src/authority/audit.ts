import type { Env } from '../types.js';
import { id, now } from '../http.js';
import type { Query } from '../db/types.js';

export function auditAfterChange(
  env: Env, actorId: string, action: string, workspaceId: string | null,
  detail: Record<string, unknown>, auditId = id(),
): Query<never> {
  return env.DB.query<never>(`INSERT INTO audit (id, workspace_id, session_id, actor_id, action, detail_json, created_at)
    SELECT ?, ?, NULL, ?, ?, ?, ? WHERE changes() = 1`)
    .bind(auditId, workspaceId, actorId, action, JSON.stringify(detail), now());
}
export function workspaceDeletionAuditStatements(
  env: Env, actorId: string, workspace: { id: string; name: string }, auditId: string,
): [Query<never>, Query<never>] {
  return [
    env.DB.query<never>(`INSERT INTO audit (id, workspace_id, session_id, actor_id, action, detail_json, created_at)
      SELECT ?, NULL, NULL, ?, 'workspace.deleted', ?, ? WHERE EXISTS (SELECT 1 FROM workspaces w WHERE w.id = ? AND w.owner_id = ?)
        AND NOT EXISTS (SELECT 1 FROM personal_workspaces WHERE workspace_id = ?)
        AND NOT EXISTS (SELECT 1 FROM sessions WHERE workspace_id = ?)`)
      .bind(auditId, actorId, JSON.stringify({ workspaceId: workspace.id, name: workspace.name }), now(), workspace.id, actorId, workspace.id, workspace.id),
    env.DB.query<never>('UPDATE audit SET workspace_id = NULL WHERE workspace_id = ? AND EXISTS (SELECT 1 FROM audit WHERE id = ?)').bind(workspace.id, auditId),
  ];
}
export function auditStatement(env: Env, actorId: string | null, action: string, workspaceId: string | null = null, sessionId: string | null = null, detail: Record<string, unknown> = {}): Query<never> {
  return env.DB.query<never>('INSERT INTO audit (id, workspace_id, session_id, actor_id, action, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id(), workspaceId, sessionId, actorId, action, JSON.stringify(detail), now());
}
