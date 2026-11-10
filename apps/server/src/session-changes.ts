import { now } from './http.js';
import type { Env } from './types.js';

export async function markSessionChanged(env: Env, sessionId: string, at = now()): Promise<void> {
  await env.DB.query(`INSERT INTO automatic_backups (session_id, changed_at) VALUES (?, ?)
    ON CONFLICT (session_id) DO UPDATE SET changed_at = COALESCE(automatic_backups.changed_at, excluded.changed_at)`)
    .bind(sessionId, at).run();
}
