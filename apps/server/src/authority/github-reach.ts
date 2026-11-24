import type { Hono } from 'hono';
import { z } from 'zod';
import { defaultGitHubReach, type GitHubReachSettings } from '../../../../packages/shared/src/github-reach.js';
import type { Database } from '../db/types.js';
import type { AppEnv, SessionRow } from '../types.js';
import { requireMember } from './access.js';
import { auditStatement } from './audit.js';
import { fail, identifier, now } from '../http.js';
import { body } from '../schemas.js';

export async function memberGitHubReach(db: Database, workspaceId: string, userId: string): Promise<GitHubReachSettings> {
  const row = await db.query<{ any_repository: number }>('SELECT any_repository FROM member_github_reach WHERE workspace_id = ? AND user_id = ?')
    .bind(workspaceId, userId).first();
  return row ? { anyRepository: Number(row.any_repository) === 1 } : { ...defaultGitHubReach };
}

export async function ownerReachesAnyGitHubRepository(db: Database, row: Pick<SessionRow, 'workspace_id' | 'owner_id'>): Promise<boolean> {
  return (await memberGitHubReach(db, row.workspace_id, row.owner_id)).anyRepository;
}

export async function senderReachesAnyGitHubRepository(db: Database, row: Pick<SessionRow, 'workspace_id' | 'owner_id'>, senderId: string): Promise<boolean> {
  return senderId === row.owner_id && await ownerReachesAnyGitHubRepository(db, row);
}

export function registerGitHubReach(app: Hono<AppEnv>): void {
  app.get('/api/workspaces/:id/github-reach', async c => {
    const workspaceId = identifier(c.req.param('id'));
    const actor = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actor);
    return c.json({ settings: await memberGitHubReach(c.env.DB, workspaceId, actor) });
  });
  app.put('/api/workspaces/:id/github-reach', async c => {
    const workspaceId = identifier(c.req.param('id'));
    const actor = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actor);
    const { anyRepository } = await body(c, z.strictObject({ anyRepository: z.boolean() }), { maxBytes: 1024, message: 'Set anyRepository to true or false.' });
    const saved = await c.env.DB.query<{ any_repository: number }>(`INSERT INTO member_github_reach (workspace_id, user_id, any_repository, updated_at)
      SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?)
      ON CONFLICT (workspace_id, user_id) DO UPDATE SET any_repository = excluded.any_repository, updated_at = excluded.updated_at
      RETURNING any_repository`).bind(workspaceId, actor, anyRepository ? 1 : 0, now(), workspaceId, actor).first();
    if (!saved) fail(404, 'not_found', 'Workspace not found.');
    await auditStatement(c.env, actor, 'workspace.github_reach.updated', workspaceId, null, { anyRepository }).run();
    return c.json({ settings: { anyRepository: Number(saved.any_repository) === 1 } satisfies GitHubReachSettings });
  });
}
