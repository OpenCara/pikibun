import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { PackingSettings } from '../../../packages/shared/src/packing.js';
import { automaticPackingDays } from '../../../packages/shared/src/packing.js';
import { auditStatement, hostCapabilities, requireMember, workspaceAdminSQL } from './authority/index.js';
import { asSessionOwner, errorCode } from './automatic-backups.js';
import type { Database } from './db/types.js';
import { fail, identifier, jsonObject, now } from './http.js';
import { packSession } from './session-packing.js';
import type { AppEnv, Env, SessionRow } from './types.js';

const day = 24 * 60 * 60_000;
const retryMinutes = 60;
const sweepLimit = 10;

export function packDueAfterArchiving(from = Date.now()): string {
  return new Date(from + automaticPackingDays * day).toISOString();
}

export async function workspacePackingSettings(db: Database, workspaceId: string): Promise<PackingSettings> {
  const row = await db.query<{ automatic: number }>('SELECT automatic FROM workspace_packing_settings WHERE workspace_id = ?').bind(workspaceId).first();
  return { automatic: Number(row?.automatic ?? 1) === 1 };
}

export function registerPackingSettings(app: Hono<AppEnv>): void {
  app.get('/api/workspaces/:id/packing', async c => {
    const workspaceId = identifier(c.req.param('id'));
    await requireMember(c.env, workspaceId, c.get('auth').userId);
    return c.json({ settings: await workspacePackingSettings(c.env.DB, workspaceId) });
  });
  app.put('/api/workspaces/:id/packing', async c => {
    const workspaceId = identifier(c.req.param('id'));
    const actor = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    const input = await jsonObject(c, 1024);
    const keys = Object.keys(input);
    if (keys.length !== 1 || keys[0] !== 'automatic' || typeof input.automatic !== 'boolean') fail(400, 'invalid_input', 'Set automatic to true or false.');
    const automatic = input.automatic as boolean;
    const saved = await c.env.DB.query<{ automatic: number }>(`INSERT INTO workspace_packing_settings (workspace_id, automatic, updated_by, updated_at)
      SELECT ?,?,?,? WHERE ${workspaceAdminSQL}
      ON CONFLICT (workspace_id) DO UPDATE SET automatic = excluded.automatic, updated_by = excluded.updated_by, updated_at = excluded.updated_at
        WHERE ${workspaceAdminSQL}
      RETURNING automatic`).bind(workspaceId, automatic ? 1 : 0, actor, now(), workspaceId, actor, workspaceId, actor).first();
    if (!saved) fail(403, 'forbidden', 'Workspace administrator access is required.');
    await auditStatement(c.env, actor, 'workspace.packing.updated', workspaceId, null, { automatic }).run();
    return c.json({ settings: { automatic: Number(saved.automatic) === 1 } satisfies PackingSettings });
  });
}

async function refusalReason(error: unknown): Promise<string | undefined> {
  if (!(error instanceof HTTPException) || error.status !== 422 || !error.res) return undefined;
  try {
    const body = await error.res.clone().json() as { error?: unknown };
    const reason = typeof body.error === 'string' ? body.error.replace(/^The connector could not complete the operation: /, '') : '';
    return reason && reason.length <= 400 ? reason : undefined;
  } catch { return undefined; }
}

export type AutomaticPackOutcome = { sessionId: string; packed: true } | { sessionId: string; refused: string } | { sessionId: string; deferred: string };

const finalCodes = ['session_frozen', 'pack_unavailable', 'owner_required', 'permission_revoked', 'not_found', 'forbidden'];

export async function runAutomaticPacking(env: Env, at = Date.now()): Promise<AutomaticPackOutcome[]> {
  const timestamp = new Date(at).toISOString();
  const due = await env.DB.query<SessionRow>(`SELECT s.* FROM sessions s
    JOIN connectors c ON c.id = s.connector_id
    LEFT JOIN workspace_packing_settings p ON p.workspace_id = s.workspace_id
    WHERE s.pack_due_at IS NOT NULL AND s.pack_due_at <= ? AND s.status = 'archived' AND s.packed_at IS NULL
      AND COALESCE(p.automatic, 1) = 1 AND c.connection_hash IS NOT NULL AND c.revoked_at IS NULL
    ORDER BY s.pack_due_at, s.id LIMIT ?`).bind(timestamp, sweepLimit).all();
  const outcomes: AutomaticPackOutcome[] = [];
  for (const row of due) {
    const later = (minutes: number) => new Date(at + minutes * 60_000).toISOString();
    const claimed = await env.DB.query("UPDATE sessions SET pack_due_at = ? WHERE id = ? AND pack_due_at = ? AND status = 'archived' AND packed_at IS NULL")
      .bind(later(retryMinutes), row.id, row.pack_due_at ?? null).run();
    if (claimed.changes !== 1) continue;
    const settle = (dueAt: string | null) => env.DB.query("UPDATE sessions SET pack_due_at = ? WHERE id = ? AND status = 'archived'").bind(dueAt, row.id).run();
    const capabilities = await hostCapabilities(env, row.connector_id);
    if (Number(row.host_environment ?? 0) === 1 || capabilities?.unsandboxed) {
      await settle(null);
      outcomes.push({ sessionId: row.id, refused: 'pack_unavailable' });
      continue;
    }
    if (capabilities?.sessionPacking !== true || capabilities.packIgnoredFiles !== true) {
      await settle(later(24 * 60));
      outcomes.push({ sessionId: row.id, deferred: 'connector_outdated' });
      continue;
    }
    try {
      await asSessionOwner(env, row, c => packSession(c, row.id, { automatic: true }), 'automatic-packing');
      outcomes.push({ sessionId: row.id, packed: true });
    } catch (error) {
      const code = await errorCode(error);
      const status = error instanceof HTTPException ? error.status : 500;
      if (status === 422 || finalCodes.includes(code)) {
        await settle(null);
        const reason = await refusalReason(error);
        await auditStatement(env, row.owner_id, 'session.pack_refused', row.workspace_id, row.id, { automatic: true, code, ...(reason ? { reason } : {}) }).run();
        outcomes.push({ sessionId: row.id, refused: code });
      } else {
        await env.DB.query('UPDATE sessions SET pack_due_at = NULL WHERE id = ? AND packed_at IS NOT NULL').bind(row.id).run();
        outcomes.push({ sessionId: row.id, deferred: code });
      }
    }
  }
  return outcomes;
}
