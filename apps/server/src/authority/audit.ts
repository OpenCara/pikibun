import type { Env } from '../types.js';
import { id, now } from '../http.js';
import type { Query } from '../db/types.js';

/*
 * The audit log. Entries carry metadata only: who did what, where, with which ids, never prompts, credentials,
 * environment values or operation bodies.
 */

export function auditAfterChange(
  env: Env, actorId: string, action: string, workspaceId: string | null,
  detail: Record<string, unknown>, auditId = id(),
): Query<never> {
  // This must immediately follow a single-row mutation in the same atomic batch.
  return env.DB.query<never>(`INSERT INTO audit (id, workspace_id, session_id, actor_id, action, detail_json, created_at)
    SELECT ?, ?, NULL, ?, ?, ?, ? WHERE changes() = 1`)
    .bind(auditId, workspaceId, actorId, action, JSON.stringify(detail), now());
}
export function auditStatement(env: Env, actorId: string | null, action: string, workspaceId: string | null = null, sessionId: string | null = null, detail: Record<string, unknown> = {}): Query<never> {
  // Callers supply metadata, never prompts, credentials, environment values, or operation bodies.
  return env.DB.query<never>('INSERT INTO audit (id, workspace_id, session_id, actor_id, action, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id(), workspaceId, sessionId, actorId, action, JSON.stringify(detail), now());
}
