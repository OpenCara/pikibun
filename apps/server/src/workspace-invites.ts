import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { assignableWorkspaceRoles, type AssignableWorkspaceRole } from '../../../packages/shared/src/types.js';
import { adminManagedRoles, workspaceManagerRoles } from '../../../packages/shared/src/policy.js';
import type { OwnJoinRequest, WorkspaceInvite, WorkspaceInviteLink, WorkspaceJoinRequest } from '../../../packages/shared/src/invites.js';
import { sha256 } from '../../../packages/shared/src/crypto.js';
import {
  auditAfterChange, auditStatement, decryptToken, encryptToken, INVALID_LINK, INVITE_TOKEN, joinRequestStatement, personalWorkspaceSQL,
  requireInvitedWorkspace, requireMember, requireSharedWorkspace,
} from './authority/index.js';
import { appOrigin, fail, identifier, id, jsonObject, now, randomToken, userIdentifier } from './http.js';
import type { Env, AppEnv } from './types.js';
import { ownerHostStatements } from './connectors.js';

const roleList = (roles: readonly string[]) => roles.map(role => `'${role}'`).join(', ');

interface LinkRow { token_hash: string; token_ciphertext: string; created_at: string }

const linkIdentity = (workspaceId: string) => `workspace-invite:${workspaceId}`;

const linkUrl = (env: Env, token: string) => `${appOrigin(env)}/#/join/${token}`;

function currentLink(env: Env, workspaceId: string): Promise<LinkRow | null> {
  return env.DB.query<LinkRow>('SELECT token_hash, token_ciphertext, created_at FROM workspace_invite_links WHERE workspace_id = ?')
    .bind(workspaceId).first();
}

async function presentLink(env: Env, workspaceId: string, link: LinkRow): Promise<WorkspaceInviteLink> {
  let token: string;
  try {
    token = await decryptToken(env, linkIdentity(workspaceId), link.token_ciphertext);
  } catch (error) {
    if (error instanceof HTTPException && error.status === 503) throw error;
    token = '';
  }
  if (!INVITE_TOKEN.test(token) || await sha256(token) !== link.token_hash) {
    fail(500, 'link_unavailable', 'The invite link could not be read. Turn it off and on again to get a new link.');
  }
  return { url: linkUrl(env, token), createdAt: link.created_at };
}

async function inviteFor(env: Env, workspace: { id: string; name: string }, userId: string): Promise<WorkspaceInvite> {
  const standing = await env.DB.query<{ member: number; pending: number }>(`SELECT
      EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?) AS member,
      EXISTS (SELECT 1 FROM workspace_join_requests WHERE workspace_id = ? AND user_id = ?) AS pending`)
    .bind(workspace.id, userId, workspace.id, userId).first();
  if (Number(standing?.member)) return { workspaceName: workspace.name, status: 'member', workspaceId: workspace.id };
  return { workspaceName: workspace.name, status: Number(standing?.pending) ? 'pending' : 'none' };
}

function joinRequests(env: Env, workspaceId: string) {
  return env.DB.query<WorkspaceJoinRequest>(`SELECT r.user_id AS userId, u.display_name AS displayName,
      u.username, u.github_login AS githubLogin, r.created_at AS createdAt
    FROM workspace_join_requests r JOIN users u ON u.id = r.user_id
    WHERE r.workspace_id = ? ORDER BY r.created_at, r.user_id`).bind(workspaceId);
}

const requireManager = (env: Env, workspaceId: string, actorId: string) => requireMember(env, workspaceId, actorId, workspaceManagerRoles);

export function registerWorkspaceInvites(app: Hono<AppEnv>): void {
  app.get('/api/invite', async c => {
    const workspace = await requireInvitedWorkspace(c.env, c.req.header('x-invite-token'));
    return c.json({ invite: await inviteFor(c.env, workspace, c.get('auth').userId) });
  });

  app.post('/api/invite', async c => {
    const body = await jsonObject(c, 1024);
    if (Object.keys(body).some(key => key !== 'token')) fail(400, 'invalid_input', 'Unexpected request field.');
    const workspace = await requireInvitedWorkspace(c.env, body.token);
    const userId = c.get('auth').userId;
    const before = await inviteFor(c.env, workspace, userId);
    if (before.status !== 'none') return c.json({ invite: before });
    const tokenHash = await sha256(body.token as string);
    const result = await c.env.DB.batch([
      joinRequestStatement(c.env.DB, workspace.id, tokenHash, userId),
      auditAfterChange(c.env, userId, 'workspace.join.request', workspace.id, { userId }),
    ]);
    if (result[0].changes !== 1) {
      const after = await inviteFor(c.env, workspace, userId);
      if (after.status !== 'none') return c.json({ invite: after });
      if (!await currentLink(c.env, workspace.id).then(link => link?.token_hash === tokenHash)) fail(404, 'not_found', INVALID_LINK);
      fail(409, 'too_many_pending', 'This workspace has too many people waiting to join. Ask an owner or admin to review them first.');
    }
    return c.json({ invite: { workspaceName: workspace.name, status: 'pending' } satisfies WorkspaceInvite }, 201);
  });

  app.delete('/api/invite', async c => {
    const workspace = await requireInvitedWorkspace(c.env, c.req.header('x-invite-token'));
    const userId = c.get('auth').userId;
    await c.env.DB.batch([
      c.env.DB.query('DELETE FROM workspace_join_requests WHERE workspace_id = ? AND user_id = ?').bind(workspace.id, userId),
      auditAfterChange(c.env, userId, 'workspace.join.withdraw', workspace.id, { userId }),
    ]);
    return c.json({ invite: await inviteFor(c.env, workspace, userId) });
  });

  app.get('/api/join-requests', async c => {
    const requests = await c.env.DB.query<OwnJoinRequest>(`SELECT r.workspace_id AS workspaceId, w.name AS workspaceName,
        r.created_at AS createdAt
      FROM workspace_join_requests r JOIN workspaces w ON w.id = r.workspace_id
      WHERE r.user_id = ? ORDER BY r.created_at, r.workspace_id`).bind(c.get('auth').userId).all();
    return c.json({ requests });
  });

  app.delete('/api/join-requests/:workspaceId', async c => {
    const workspaceId = identifier(c.req.param('workspaceId'), 'workspaceId');
    const userId = c.get('auth').userId;
    const result = await c.env.DB.batch([
      c.env.DB.query('DELETE FROM workspace_join_requests WHERE workspace_id = ? AND user_id = ?').bind(workspaceId, userId),
      auditAfterChange(c.env, userId, 'workspace.join.withdraw', workspaceId, { userId }),
    ]);
    if (result[0].changes !== 1) fail(404, 'not_found', 'You are not waiting to join this workspace.');
    return c.body(null, 204);
  });

  app.get('/api/workspaces/:id/invite-link', async c => {
    const workspaceId = identifier(c.req.param('id'), 'workspaceId');
    await requireManager(c.env, workspaceId, c.get('auth').userId);
    const link = await currentLink(c.env, workspaceId);
    return c.json({ link: link ? await presentLink(c.env, workspaceId, link) : null });
  });

  app.put('/api/workspaces/:id/invite-link', async c => {
    const workspaceId = identifier(c.req.param('id'), 'workspaceId');
    const actorId = c.get('auth').userId;
    await requireManager(c.env, workspaceId, actorId);
    await requireSharedWorkspace(c.env, workspaceId);
    const existing = await currentLink(c.env, workspaceId);
    if (existing) return c.json({ link: await presentLink(c.env, workspaceId, existing) });
    const token = randomToken();
    const createdAt = now();
    const ciphertext = await encryptToken(c.env, linkIdentity(workspaceId), token);
    const created = await c.env.DB.query(`INSERT INTO workspace_invite_links (workspace_id, token_hash, token_ciphertext, created_by, created_at)
      SELECT workspace_id, ?, ?, user_id, ? FROM workspace_members
      WHERE workspace_id = ? AND user_id = ? AND role IN (${roleList(workspaceManagerRoles)})
        AND NOT ${personalWorkspaceSQL('workspace_members.workspace_id')}
      ON CONFLICT (workspace_id) DO NOTHING RETURNING workspace_id`)
      .bind(await sha256(token), ciphertext, createdAt, workspaceId, actorId).first();
    if (!created) {
      const raced = await currentLink(c.env, workspaceId);
      if (raced) return c.json({ link: await presentLink(c.env, workspaceId, raced) });
      fail(409, 'membership_changed', 'Membership changed. Refresh and try again.');
    }
    await auditStatement(c.env, actorId, 'workspace.invite_link.created', workspaceId).run();
    return c.json({ link: { url: linkUrl(c.env, token), createdAt } satisfies WorkspaceInviteLink }, 201);
  });

  app.delete('/api/workspaces/:id/invite-link', async c => {
    const workspaceId = identifier(c.req.param('id'), 'workspaceId');
    const actorId = c.get('auth').userId;
    await requireManager(c.env, workspaceId, actorId);
    const removed = await c.env.DB.query('DELETE FROM workspace_invite_links WHERE workspace_id = ? RETURNING workspace_id').bind(workspaceId).first();
    if (removed) await auditStatement(c.env, actorId, 'workspace.invite_link.revoked', workspaceId).run();
    return c.json({ ok: true });
  });

  app.get('/api/workspaces/:id/join-requests', async c => {
    const workspaceId = identifier(c.req.param('id'), 'workspaceId');
    await requireManager(c.env, workspaceId, c.get('auth').userId);
    return c.json({ requests: await joinRequests(c.env, workspaceId).all() });
  });

  app.post('/api/workspaces/:id/join-requests/:userId/accept', async c => {
    const workspaceId = identifier(c.req.param('id'), 'workspaceId');
    const targetId = userIdentifier(c.req.param('userId'));
    const actorId = c.get('auth').userId;
    const body = await jsonObject(c, 1024);
    if (Object.keys(body).some(key => key !== 'role')) fail(400, 'invalid_input', 'Unexpected request field.');
    const role = body.role;
    if (typeof role !== 'string' || !(assignableWorkspaceRoles as readonly string[]).includes(role)) fail(400, 'invalid_input', 'Invalid role.');
    const actor = await requireManager(c.env, workspaceId, actorId);
    await requireSharedWorkspace(c.env, workspaceId);
    if (actor.role !== 'owner' && !adminManagedRoles.includes(role as AssignableWorkspaceRole)) {
      fail(403, 'forbidden', 'Only the workspace owner can make someone an administrator.');
    }
    const auditId = id();
    const result = await c.env.DB.batch([
      c.env.DB.query(`INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
        SELECT r.workspace_id, r.user_id, ?, ?
        FROM workspace_join_requests r
        INNER JOIN workspaces w ON w.id = r.workspace_id
        INNER JOIN workspace_members actor ON actor.workspace_id = w.id AND actor.user_id = ?
        WHERE r.workspace_id = ? AND r.user_id = ? AND r.user_id <> w.owner_id AND NOT ${personalWorkspaceSQL('w.id')}
          AND ((actor.role = 'owner' AND actor.user_id = w.owner_id)
            OR (actor.role = 'admin' AND ? IN (${roleList(adminManagedRoles)})))
        ON CONFLICT (workspace_id, user_id) DO NOTHING`)
        .bind(role, now(), actorId, workspaceId, targetId, role),
      auditAfterChange(c.env, actorId, 'workspace.join.accept', workspaceId, { userId: targetId, role }, auditId),
      c.env.DB.query(`DELETE FROM workspace_join_requests WHERE workspace_id = ? AND user_id = ?
        AND EXISTS (SELECT 1 FROM audit WHERE id = ?)`).bind(workspaceId, targetId, auditId),
      ...ownerHostStatements(c.env, targetId, workspaceId),
    ]);
    if (result[0].changes !== 1) {
      const pending = await c.env.DB.query('SELECT 1 FROM workspace_join_requests WHERE workspace_id = ? AND user_id = ?').bind(workspaceId, targetId).first();
      if (!pending) fail(404, 'not_found', 'This person is no longer waiting to join.');
      fail(409, 'membership_changed', 'Membership changed. Refresh and try again.');
    }
    return c.json({ requests: await joinRequests(c.env, workspaceId).all() });
  });

  app.delete('/api/workspaces/:id/join-requests/:userId', async c => {
    const workspaceId = identifier(c.req.param('id'), 'workspaceId');
    const targetId = userIdentifier(c.req.param('userId'));
    const actorId = c.get('auth').userId;
    await requireManager(c.env, workspaceId, actorId);
    const result = await c.env.DB.batch([
      c.env.DB.query(`DELETE FROM workspace_join_requests WHERE workspace_id = ? AND user_id = ?
        AND EXISTS (SELECT 1 FROM workspace_members actor WHERE actor.workspace_id = ? AND actor.user_id = ?
          AND actor.role IN (${roleList(workspaceManagerRoles)}))`).bind(workspaceId, targetId, workspaceId, actorId),
      auditAfterChange(c.env, actorId, 'workspace.join.decline', workspaceId, { userId: targetId }),
    ]);
    if (result[0].changes !== 1) fail(404, 'not_found', 'This person is no longer waiting to join.');
    return c.json({ requests: await joinRequests(c.env, workspaceId).all() });
  });
}
