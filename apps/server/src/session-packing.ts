import { HTTPException } from 'hono/http-exception';
import type { ConnectorCapabilities } from '../../../packages/shared/src/connector.js';
import type { AppContext, Env, SessionAccess, SessionRow } from './types.js';
import { auditStatement, requireSessionManager } from './db.js';
import { fail, now } from './http.js';
import { runnerJSON, runnerRequest } from './runner.js';
import { invalidateSessionView } from './view-feed.js';

/**
 * Packing an archived session's files on its host (apps/runner/src/pack.ts), to save the host's disk: its owner asks,
 * and unarchiving unpacks them. The conversation stays on the host as it is.
 *
 * `packed_at` is set before the host is asked and cleared once it has unpacked them, so whatever happens to an answer,
 * a session whose files may be packed is unpacked when it is unarchived; unpacking a session that isn't packed changes
 * nothing. It is cleared at once only when the host refused, as it does before changing anything.
 */

async function hostCapabilities(env: Env, connectorId: string): Promise<ConnectorCapabilities | null> {
  const host = await env.DB.query<{ capabilities_json: string }>('SELECT capabilities_json FROM connectors WHERE id = ?').bind(connectorId).first();
  try { return JSON.parse(host?.capabilities_json ?? 'null') as ConnectorCapabilities | null; }
  catch { return null; }
}

/** The host's answer to a pack. */
interface PackResult { packed: true; files?: number; clones?: number; bytes?: number }

/** Packs the files of the archived session `sessionId` as the request's user, its owner. */
export async function packSession(c: AppContext, sessionId: string): Promise<SessionAccess> {
  // An archived session admits read access only; its owner packs it.
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
  // Marked first (see above); a pack asked again, once its outcome was unclear, keeps its first time.
  const marked = await c.env.DB.query<SessionRow>(`UPDATE sessions SET packed_at = COALESCE(packed_at, ?)
    WHERE id = ? AND owner_id = ? AND policy_version = ? AND status = 'archived' RETURNING *`)
    .bind(now(), row.id, row.owner_id, row.policy_version).first();
  if (!marked) fail(409, 'policy_changed', 'Session status or permissions changed; reload and retry.');
  let result: PackResult;
  try {
    result = await runnerJSON<PackResult>(await runnerRequest(c, marked, 'pack', '', {}), 4096);
    if (result?.packed !== true) fail(502, 'invalid_runner_response', 'The host returned an invalid pack result.');
  } catch (error) {
    // The host refused (it says why in a 422) or the session was busy: nothing changed there. Any other failure leaves the
    // outcome unclear, so the mark stays and unarchiving unpacks whatever was packed.
    if (error instanceof HTTPException && (error.status === 422 || error.status === 409)) {
      await c.env.DB.query('UPDATE sessions SET packed_at = NULL WHERE id = ? AND status = \'archived\'').bind(row.id).run();
    }
    throw error;
  }
  invalidateSessionView(c, row.id);
  const summary = Object.fromEntries((['files', 'clones', 'bytes'] as const)
    .filter(key => Number.isSafeInteger(result[key]) && result[key]! >= 0).map(key => [key, result[key]]));
  await auditStatement(c.env, actorId, 'session.packed', row.workspace_id, row.id, summary).run();
  return { ...access, row: marked };
}

/**
 * Before an archived session whose files may be packed is unarchived: its owner unarchives it, and its host unpacks
 * them first. The session as it is then, still archived.
 */
export async function unpackSession(c: AppContext, access: SessionAccess): Promise<SessionRow> {
  const { row } = access;
  if (!row.packed_at) return row;
  const actorId = c.get('auth').userId;
  if (actorId !== row.owner_id) fail(403, 'owner_required', 'Only the session owner can unarchive it while its files are packed, as its host unpacks them first.');
  const result = await runnerJSON<{ unpacked?: unknown }>(await runnerRequest(c, row, 'unpack', '', {}), 4096);
  if (typeof result?.unpacked !== 'boolean') fail(502, 'invalid_runner_response', 'The host returned an invalid unpack result.');
  const unpacked = await c.env.DB.query<SessionRow>(`UPDATE sessions SET packed_at = NULL
    WHERE id = ? AND owner_id = ? AND status = 'archived' AND packed_at IS NOT NULL RETURNING *`).bind(row.id, row.owner_id).first();
  if (!unpacked) fail(409, 'policy_changed', 'Session status changed; reload and retry.');
  invalidateSessionView(c, row.id);
  await auditStatement(c.env, actorId, 'session.unpacked', row.workspace_id, row.id, { unpacked: result.unpacked }).run();
  return unpacked;
}
