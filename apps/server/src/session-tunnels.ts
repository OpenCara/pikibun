import type { Hono } from 'hono';
import { parseSessionTunnelReport, type SessionTunnelReport } from '../../../packages/shared/src/tunnel.js';
import { auditStatement, requireCallbackScope, requireSession } from './authority/index.js';
import { fail, identifier, jsonObject } from './http.js';
import { runnerJSON, runnerRequest } from './runner.js';
import type { AppContext, SessionRow, WorkerEnv } from './types.js';
import { invalidateSessionView } from './view-feed.js';

/*
 * Sessions online through their tunnel (piki:tunnel; docs/design/tunnel.md). The session's host runs the server and
 * cloudflared, and reports each start and stop here: the audit log records them with the address
 * (`session.tunnel.started`, `session.tunnel.stopped` with why), and the session list marks the session online until
 * its host reports it stopped or its service lifetime is over, whichever comes first, so a host that went away without
 * saying so leaves no mark past that. The session panel's Stop button asks the host to take it offline.
 */

/**
 * A connector reports a session's tunnel started or stopped. The person it names (who started it, or stopped it) is
 * recorded only where they are in the session's workspace; a stop the host decided by itself (its lifetime, the
 * server exiting, the session closing) names none.
 */
export async function reportSessionTunnel(c: AppContext, connectorId: string): Promise<Response> {
  let report: SessionTunnelReport;
  try { report = parseSessionTunnelReport(await jsonObject(c, 4096)); }
  catch (error) { return fail(400, 'invalid_tunnel', error instanceof Error ? error.message : 'Invalid tunnel report.'); }
  const row = await c.env.DB.query<SessionRow>('SELECT * FROM sessions WHERE id = ?').bind(report.sessionId).first();
  if (!row) fail(404, 'not_found', 'Session not found.');
  await requireCallbackScope(c, row, connectorId);
  const actor = report.actorId && await c.env.DB.query('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
    .bind(row.workspace_id, report.actorId).first() ? report.actorId : null;
  const detail = { connectorId, url: report.url, ...(report.expiresAt ? { expiresAt: report.expiresAt } : {}), ...(report.reason ? { reason: report.reason } : {}) };
  await c.env.DB.batch([
    report.event === 'started'
      // A start reported late, after the session was archived, marks nothing: it is still audited.
      ? c.env.DB.query("UPDATE sessions SET tunnel_url = ?, tunnel_expires_at = ? WHERE id = ? AND connector_id = ? AND status <> 'archived'").bind(report.url, report.expiresAt!, row.id, connectorId)
      // Only the address it names: a stop reported after a newer start leaves that one's mark.
      : c.env.DB.query('UPDATE sessions SET tunnel_url = NULL, tunnel_expires_at = NULL WHERE id = ? AND connector_id = ? AND tunnel_url = ?').bind(row.id, connectorId, report.url),
    auditStatement(c.env, actor, `session.tunnel.${report.event}`, row.workspace_id, row.id, detail),
  ]);
  invalidateSessionView(c, row.id);
  return c.json({ ok: true });
}

/**
 * Asks the session's host to take its server offline (the tunnel runner action), as `c`'s user; whether it was online.
 * `archived`: the session is being archived, which its host reports as the reason.
 */
export async function stopSessionTunnel(c: AppContext, row: SessionRow, reason?: 'archived'): Promise<boolean> {
  const result = await runnerJSON<{ stopped?: unknown }>(await runnerRequest(c, row, 'tunnel', '', { action: 'stop', ...(reason ? { reason } : {}) }));
  invalidateSessionView(c, row.id);
  if (typeof result?.stopped !== 'boolean') fail(502, 'invalid_runner_response', 'The runner returned an invalid tunnel result.');
  return result.stopped;
}

export function registerSessionTunnels(app: Hono<WorkerEnv>): void {
  // The session panel's Stop button: anyone who can write to the session takes its server offline, as they can stop its work.
  app.post('/api/sessions/:id/tunnel/stop', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'write');
    if (!row.connector_id) fail(409, 'tunnel_unsupported', 'Only sessions on a connected host put servers online.');
    return c.json({ stopped: await stopSessionTunnel(c, row) });
  });
}
