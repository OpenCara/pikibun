import { validPushBranch, validRepositoryName } from '../../../packages/shared/src/repositories.js';
import type { AppContext, SessionRow } from './types.js';
import { requireCallbackScope } from './authority/index.js';
import { fail, identifier, jsonObject, now } from './http.js';

export const sessionBranchLimit = 20;

export async function reportSessionBranches(c: AppContext, connectorId: string): Promise<Response> {
  const input = await jsonObject(c, 16 * 1024);
  if (Object.keys(input).some(key => key !== 'sessionId' && key !== 'branches') || !Array.isArray(input.branches)
      || input.branches.length > sessionBranchLimit) fail(400, 'invalid_branches', 'Invalid session branches.');
  const reported = (input.branches as unknown[]).map(item => {
    const value = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {};
    if (Object.keys(value).some(key => key !== 'repository' && key !== 'branch') || !validRepositoryName('github', value.repository)
        || !validPushBranch(value.branch)) fail(400, 'invalid_branches', 'Invalid session branches.');
    return { repository: value.repository as string, branch: value.branch as string };
  });
  const row = await c.env.DB.query<SessionRow>('SELECT * FROM sessions WHERE id = ?').bind(identifier(input.sessionId, 'sessionId')).first();
  if (!row) fail(404, 'not_found', 'Session not found.');
  await requireCallbackScope(c, row, connectorId);
  if (row.repository_mode !== 'clone') fail(409, 'clone_session_required', 'Only clone sessions report branches.');
  const bound = new Map((await c.env.DB.query<{ full_name: string }>(`SELECT full_name FROM workspace_repositories
    WHERE workspace_id = ? AND provider = 'github' AND host = 'github.com'`).bind(row.workspace_id).all())
    .map(binding => [binding.full_name.toLowerCase(), binding.full_name]));
  const branches = new Map<string, { repository: string; branch: string }>();
  for (const item of reported) {
    const repository = bound.get(item.repository.toLowerCase());
    if (repository) branches.set(`${repository}\n${item.branch}`, { repository, branch: item.branch });
  }
  const at = now();
  const statements = [...branches.values()].map(item => c.env.DB.query(`INSERT INTO session_branches (session_id, repository, branch, reported_at)
    VALUES (?, ?, ?, ?) ON CONFLICT (session_id, repository, branch) DO UPDATE SET reported_at = excluded.reported_at`)
    .bind(row.id, item.repository, item.branch, at));
  const keys = [...branches.keys()];
  statements.push(keys.length
    ? c.env.DB.query(`DELETE FROM session_branches WHERE session_id = ? AND pull_request_url IS NULL
      AND repository || ? || branch NOT IN (${keys.map(() => '?').join(', ')})`).bind(row.id, '\n', ...keys)
    : c.env.DB.query('DELETE FROM session_branches WHERE session_id = ? AND pull_request_url IS NULL').bind(row.id));
  await c.env.DB.batch(statements);
  return c.json({ ok: true });
}
