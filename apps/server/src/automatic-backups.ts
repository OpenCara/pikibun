import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { createBackup } from './backups.js';
import type { AppContext, Env, SessionRow, AppEnv } from './types.js';

export const automaticBackupIntervals = [15, 60, 360, 1440] as const;
export type AutomaticBackupInterval = (typeof automaticBackupIntervals)[number];

export function isAutomaticBackupInterval(value: unknown): value is AutomaticBackupInterval {
  return automaticBackupIntervals.includes(value as AutomaticBackupInterval);
}

const retryMinutes = 15;
const sweepLimit = 10;

type DueSession = SessionRow & { automatic_changed_at: string; automatic_database_id: string; automatic_minutes: number };

export type AutomaticBackupOutcome = { sessionId: string; backupId: string } | { sessionId: string; error: string };

function minutesLater(from: number, minutes: number): string {
  return new Date(from + minutes * 60_000).toISOString();
}

export async function asSessionOwner<T>(env: Env, row: Pick<SessionRow, 'owner_id'>, work: (c: AppContext) => Promise<T>, as = 'automatic-backup'): Promise<T> {
  const app = new Hono<AppEnv>();
  const result: { outcome?: { value: T } | { error: unknown } } = {};
  app.post('/', async c => {
    c.set('auth', { userId: row.owner_id, tokenHash: as, csrfToken: '', client: 'native' });
    try {
      result.outcome = { value: await work(c) };
    } catch (error) {
      result.outcome = { error };
    }
    return c.body(null, 204);
  });
  await app.request('/', { method: 'POST' }, env);
  const { outcome } = result;
  if (!outcome) throw new Error(`The ${as} work did not run.`);
  if ('error' in outcome) throw outcome.error;
  return outcome.value;
}

export async function errorCode(error: unknown): Promise<string> {
  if (error instanceof HTTPException) {
    try {
      const body = await (error.res ? error.res.clone() : error.getResponse()).json() as { code?: unknown };
      if (typeof body.code === 'string' && /^[a-z0-9_]{1,64}$/.test(body.code)) return body.code;
    } catch { }
  }
  return 'internal_error';
}

export async function runAutomaticBackups(env: Env, at = Date.now()): Promise<AutomaticBackupOutcome[]> {
  if (!env.WORKSPACE_DATABASES) return [];
  const timestamp = new Date(at).toISOString();
  const due = await env.DB.query<DueSession>(`SELECT s.*, a.changed_at AS automatic_changed_at, d.id AS automatic_database_id,
      d.automatic_backup_minutes AS automatic_minutes
    FROM automatic_backups a
    JOIN sessions s ON s.id = a.session_id
    JOIN workspaces w ON w.id = s.workspace_id
    JOIN workspace_databases d ON d.workspace_id = s.workspace_id
    WHERE a.changed_at IS NOT NULL AND (a.due_at IS NULL OR a.due_at <= ?)
      AND d.automatic_backup_minutes IS NOT NULL
      AND s.status <> 'archived'
      AND (s.activity IS NULL OR s.activity NOT IN ('working', 'waiting'))
      AND (s.owner_id = w.owner_id OR EXISTS (SELECT 1 FROM workspace_database_consents c
        WHERE c.database_id = d.id AND c.user_id = s.owner_id))
    ORDER BY a.changed_at, a.session_id LIMIT ?`).bind(timestamp, sweepLimit).all();
  const outcomes: AutomaticBackupOutcome[] = [];
  for (const row of due) {
    const claimed = await env.DB.query(`UPDATE automatic_backups SET changed_at = NULL, attempted_at = ?, due_at = ?
      WHERE session_id = ? AND changed_at = ?`)
      .bind(timestamp, minutesLater(at, row.automatic_minutes), row.id, row.automatic_changed_at).run();
    if (claimed.changes !== 1) continue;
    try {
      const { backup } = await asSessionOwner(env, row, c => createBackup(c, row, { automatic: true, trustedDatabaseId: row.automatic_database_id }));
      await env.DB.query('UPDATE automatic_backups SET backup_id = ?, error = NULL WHERE session_id = ?').bind(backup.id, row.id).run();
      outcomes.push({ sessionId: row.id, backupId: backup.id });
    } catch (error) {
      const code = await errorCode(error);
      await env.DB.query(`UPDATE automatic_backups SET changed_at = COALESCE(changed_at, ?), due_at = ?, error = ? WHERE session_id = ?`)
        .bind(row.automatic_changed_at, minutesLater(at, Math.min(retryMinutes, row.automatic_minutes)), code, row.id).run();
      outcomes.push({ sessionId: row.id, error: code });
    }
  }
  return outcomes;
}
