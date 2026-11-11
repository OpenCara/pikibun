import type { Hono } from 'hono';
import type { Operation, ToolName } from '../../../../packages/shared/src/types.js';
import { fail, identifier, jsonObject, now } from '../http.js';
import type { AppEnv, Env, SessionRow } from '../types.js';
import { requireOwnerTool } from './tool-groups.js';
import { requireSession } from './access.js';
import { auditStatement } from './audit.js';
import { sessionChanged } from './changes.js';

const operationTools: Record<Exclude<Operation['kind'], 'permission' | 'extension.tool' | 'program'>, ToolName> = {
  'github.comment': 'github_comment', 'github.merge': 'github_merge', 'github.issue': 'github_issue', 'git.commit': 'git_commit', bash: 'bash',
  'git.push': 'git_push', 'git.repin': 'git_repin', 'host.bash': 'host_bash',
};

export async function requireOperationTool(env: Env, row: SessionRow, operation: Operation): Promise<void> {
  if (operation.kind === 'permission') fail(400, 'invalid_operation', 'Permission requests were removed: a session runs its tools or refuses them.');
  if (operation.kind === 'extension.tool') return;
  await requireOwnerTool(env, row, operation.kind === 'program' ? operation.tool : operationTools[operation.kind]);
}

export async function requireToolCall(env: Env, row: SessionRow, tool: ToolName): Promise<void> {
  await requireOwnerTool(env, row, tool);
}

export async function sessionsNeedGranted(env: Env, row: SessionRow, need: 'write' | 'audience'): Promise<boolean> {
  if (need === 'write') return false;
  return audienceSharing(env, row.id);
}

export async function audienceSharing(env: Env, sessionId: string): Promise<boolean> {
  return !!await env.DB.query(`SELECT 1 AS n FROM session_tool_grants WHERE session_id = ? AND tool = 'sessions:audience' AND call_id = ''`)
    .bind(sessionId).first();
}

export async function setAudienceSharing(env: Env, row: SessionRow, actorId: string, enabled: boolean, at: string): Promise<void> {
  if (!enabled) {
    await env.DB.query(`DELETE FROM session_tool_grants WHERE session_id = ? AND tool = 'sessions:audience'`).bind(row.id).run();
    return;
  }
  await env.DB.query(`INSERT INTO session_tool_grants (session_id, tool, call_id, approval_id, granted_by, created_at) VALUES (?, 'sessions:audience', '', 'setting', ?, ?)
    ON CONFLICT DO NOTHING`).bind(row.id, actorId, at).run();
}

export function registerAudienceSharing(app: Hono<AppEnv>): void {
  app.put('/api/sessions/:id/audience-sharing', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'read');
    const actor = c.get('auth').userId;
    if (actor !== row.owner_id) fail(403, 'owner_required', 'Only the session owner can change what passes between this session and sessions with other readers.');
    const input = await jsonObject(c, 1024);
    if (Object.keys(input).length !== 1 || typeof input.enabled !== 'boolean') fail(400, 'invalid_input', 'Set enabled to true or false.');
    await setAudienceSharing(c.env, row, actor, input.enabled, now());
    await auditStatement(c.env, actor, input.enabled ? 'session.audience_sharing.started' : 'session.audience_sharing.stopped', row.workspace_id, row.id, {}).run();
    sessionChanged(c, row.id);
    return c.json({ audienceSharing: input.enabled });
  });
}
