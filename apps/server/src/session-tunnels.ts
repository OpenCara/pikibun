import type { Hono } from 'hono';
import { parseSessionTunnelReport, type SessionTunnelReport } from '../../../packages/shared/src/tunnel.js';
import { auditStatement, requireCallbackScope, requireSession } from './authority/index.js';
import { fail, identifier, jsonObject } from './http.js';
import { runnerJSON, runnerRequest } from './runner.js';
import type { AppContext, SessionRow, AppEnv } from './types.js';
import { invalidateSessionView } from './view-feed.js';

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
      ? c.env.DB.query("UPDATE sessions SET tunnel_url = ?, tunnel_expires_at = ? WHERE id = ? AND connector_id = ? AND status <> 'archived'").bind(report.url, report.expiresAt!, row.id, connectorId)
      : c.env.DB.query('UPDATE sessions SET tunnel_url = NULL, tunnel_expires_at = NULL WHERE id = ? AND connector_id = ? AND tunnel_url = ?').bind(row.id, connectorId, report.url),
    auditStatement(c.env, actor, `session.tunnel.${report.event}`, row.workspace_id, row.id, detail),
  ]);
  invalidateSessionView(c, row.id);
  return c.json({ ok: true });
}

export async function stopSessionTunnel(c: AppContext, row: SessionRow, reason?: 'archived'): Promise<boolean> {
  const result = await runnerJSON<{ stopped?: unknown }>(await runnerRequest(c, row, 'tunnel', '', { action: 'stop', ...(reason ? { reason } : {}) }));
  invalidateSessionView(c, row.id);
  if (typeof result?.stopped !== 'boolean') fail(502, 'invalid_runner_response', 'The runner returned an invalid tunnel result.');
  return result.stopped;
}

export function registerSessionTunnels(app: Hono<AppEnv>): void {
  app.post('/api/sessions/:id/tunnel/stop', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'write');
    if (!row.connector_id) fail(409, 'tunnel_unsupported', 'Only sessions on a connected host put servers online.');
    return c.json({ stopped: await stopSessionTunnel(c, row) });
  });
}
