import type { Hono } from 'hono';
import { parseSudoAnswer } from '../../../packages/shared/src/sudo.js';
import { auditStatement, isPersonalWorkspace, requireSession } from './authority/index.js';
import { fail, id, identifier } from './http.js';
import { runnerJSON, runnerRequest } from './runner.js';
import { body, parsed } from './schemas.js';
import type { AppEnv } from './types.js';
import { invalidateSessionView } from './view-feed.js';

const sudoAnswer = parsed(parseSudoAnswer, 'Invalid sudo answer.');

export function registerSessionSudo(app: Hono<AppEnv>): void {
  app.post('/api/sessions/:id/sudo', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'write');
    const actor = c.get('auth').userId;
    if (!row.connector_id || row.connector_owner_id !== actor || row.owner_id !== actor) {
      fail(403, 'host_owner_required', 'Only the host\'s owner answers sudo on it, in their own sessions.');
    }
    const answer = await body(c, sudoAnswer, { maxBytes: 4096 });
    const password = answer.password;
    if (password !== undefined && !await isPersonalWorkspace(c.env, row.workspace_id, actor)) {
      fail(403, 'private_workspace_required', 'sudo takes a password only in sessions of your private workspace.');
    }
    const relayed = { id: answer.id, ...(password !== undefined ? { password } : { decline: true }), nonce: id().replace(/-/g, '') };
    const result = await runnerJSON<{ answered?: unknown }>(await runnerRequest(c, row, 'sudo', '', relayed));
    invalidateSessionView(c, row.id);
    if (typeof result?.answered !== 'boolean') fail(502, 'invalid_runner_response', 'The runner returned an invalid sudo result.');
    await auditStatement(c.env, actor, password !== undefined ? 'session.sudo.answered' : 'session.sudo.declined', row.workspace_id, row.id,
      { promptId: answer.id, answered: result.answered }).run();
    return c.json({ answered: result.answered });
  });
}
