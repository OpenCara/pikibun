import { HTTPException } from 'hono/http-exception';
import { hostCapabilities } from './authority/index.js';
import type { AppContext, SessionAccess, SessionRow } from './types.js';
import { auditStatement, requireSessionManager } from './authority/index.js';
import { fail, now } from './http.js';
import { ownerRequest, runnerJSON, runnerRequest } from './runner.js';
import { invalidateSessionView } from './view-feed.js';

interface PackResult { packed: true; files?: number; clones?: number; bytes?: number }

export async function packSession(c: AppContext, sessionId: string, options: { automatic?: boolean } = {}): Promise<SessionAccess> {
  const access = await requireSessionManager(c, sessionId, 'read', 'Only the session owner can pack its files.');
  const { row } = access;
  const actorId = c.get('auth').userId;
  if (actorId !== row.owner_id) fail(403, 'owner_required', 'Only the session owner can pack its files.');
  if (row.status !== 'archived') fail(409, 'session_not_archived', 'Archive the session before packing its files.');
  if (Number(row.host_environment ?? 0) === 1) fail(409, 'pack_unavailable', 'This session runs directly on its host, without the sandbox, so its files can\'t be packed.');
  if (row.connector_id) {
    const capabilities = await hostCapabilities(c.env, row.connector_id);
    if (capabilities?.unsandboxed) fail(409, 'pack_unavailable', 'This session\'s host runs without the sandbox, so its files can\'t be packed.');
    if (capabilities?.sessionPacking !== true) fail(409, 'connector_outdated', 'This session\'s host can\'t pack sessions yet. Update its connector and try again.');
  }
  const marked = await c.env.DB.query<SessionRow>(`UPDATE sessions SET packed_at = COALESCE(packed_at, ?)
    WHERE id = ? AND owner_id = ? AND policy_version = ? AND status = 'archived' RETURNING *`)
    .bind(now(), row.id, row.owner_id, row.policy_version).first();
  if (!marked) fail(409, 'policy_changed', 'Session status or permissions changed; reload and retry.');
  let result: PackResult;
  try {
    result = await runnerJSON<PackResult>(await runnerRequest(c, marked, 'pack', '', {}), 4096);
    if (result?.packed !== true) fail(502, 'invalid_runner_response', 'The host returned an invalid pack result.');
  } catch (error) {
    if (error instanceof HTTPException && (error.status === 422 || error.status === 409)) {
      await c.env.DB.query('UPDATE sessions SET packed_at = NULL WHERE id = ? AND status = \'archived\'').bind(row.id).run();
    }
    throw error;
  }
  await c.env.DB.query('UPDATE sessions SET pack_due_at = NULL WHERE id = ?').bind(row.id).run();
  marked.pack_due_at = null;
  invalidateSessionView(c, row.id);
  const summary = Object.fromEntries((['files', 'clones', 'bytes'] as const)
    .filter(key => Number.isSafeInteger(result[key]) && result[key]! >= 0).map(key => [key, result[key]]));
  await auditStatement(c.env, actorId, 'session.packed', row.workspace_id, row.id, { ...summary, ...(options.automatic ? { automatic: true } : {}) }).run();
  return { ...access, row: marked };
}

export async function reopenUnpacked(c: AppContext, row: SessionRow): Promise<void> {
  if (row.status !== 'ready') return;
  try {
    const response = await ownerRequest(c, row, 'restart');
    await response.body?.cancel();
    invalidateSessionView(c, row.id);
  } catch { }
}

export async function unpackSession(c: AppContext, access: SessionAccess): Promise<SessionRow> {
  const { row } = access;
  if (!row.packed_at) return row;
  const actorId = c.get('auth').userId;
  const result = await runnerJSON<{ unpacked?: unknown }>(await ownerRequest(c, row, 'unpack'), 4096);
  if (typeof result?.unpacked !== 'boolean') fail(502, 'invalid_runner_response', 'The host returned an invalid unpack result.');
  const unpacked = await c.env.DB.query<SessionRow>(`UPDATE sessions SET packed_at = NULL
    WHERE id = ? AND owner_id = ? AND status = 'archived' AND packed_at IS NOT NULL RETURNING *`).bind(row.id, row.owner_id).first();
  if (!unpacked) fail(409, 'policy_changed', 'Session status changed; reload and retry.');
  invalidateSessionView(c, row.id);
  await auditStatement(c.env, actorId, 'session.unpacked', row.workspace_id, row.id, { unpacked: result.unpacked }).run();
  return unpacked;
}
