import type { Hono } from 'hono';
import {
  groupTools, parseGroupTools, roleTools, toolGroupLimits, type GroupTool, type ToolGroup, type ToolGroupMember, type ToolGroupSettings,
} from '../../../packages/shared/src/tool-groups.js';
import { workspaceRoles, type WorkspaceRole } from '../../../packages/shared/src/types.js';
import { auditStatement, requireMember, workspaceAdminSQL } from './authority/index.js';
import { requireMemberManagement } from './catalog.js';
import { ConstraintError } from './db/types.js';
import { fail, id, identifier, jsonObject, now, text, userIdentifier } from './http.js';
import type { AppEnv, Env } from './types.js';

type GroupRow = { id: string; name: string; tools_json: string; created_at: string; updated_at: string };

function groupRecord(row: GroupRow): ToolGroup {
  let tools: GroupTool[];
  try { tools = parseGroupTools(JSON.parse(row.tools_json)); } catch { tools = []; }
  return { id: row.id, name: row.name, tools, createdAt: row.created_at, updatedAt: row.updated_at };
}

export async function toolGroupSettings(env: Env, workspaceId: string, admin: boolean): Promise<ToolGroupSettings> {
  const groups = await env.DB.query<GroupRow>(`SELECT id, name, tools_json, created_at, updated_at FROM workspace_tool_groups
    WHERE workspace_id = ? ORDER BY created_at, id`).bind(workspaceId).all();
  const members = await env.DB.query<ToolGroupMember>(`SELECT m.user_id AS userId, u.display_name AS displayName, u.username, u.github_login AS githubLogin,
      m.role, a.group_id AS groupId
    FROM workspace_members m JOIN users u ON u.id = m.user_id
    LEFT JOIN workspace_member_tool_groups a ON a.workspace_id = m.workspace_id AND a.user_id = m.user_id
    WHERE m.workspace_id = ? ORDER BY m.created_at, m.user_id`).bind(workspaceId).all();
  return {
    groups: groups.map(groupRecord),
    members: members.map(member => ({ ...member, groupId: member.groupId ?? null })),
    roles: Object.fromEntries(workspaceRoles.map(role => [role, [...roleTools[role]]])) as Record<WorkspaceRole, GroupTool[]>,
    tools: [...groupTools],
    admin,
  };
}

function groupName(value: unknown): string {
  const name = text(value, 'name', toolGroupLimits.name).trim();
  if (!name || /[\r\n]/.test(name)) fail(400, 'invalid_input', 'A tool group\'s name is one non-empty line.');
  return name;
}

function groupToolsInput(value: unknown): GroupTool[] {
  try { return parseGroupTools(value); }
  catch (error) { return fail(400, 'invalid_input', error instanceof Error ? error.message : 'Invalid tools.'); }
}

function sameName(error: unknown): never {
  if (error instanceof ConstraintError || (error instanceof Error && /UNIQUE|unique|duplicate/.test(error.message))) {
    fail(409, 'name_taken', 'This workspace has a tool group with that name already.');
  }
  throw error;
}

export function registerToolGroups(app: Hono<AppEnv>): void {
  app.get('/api/workspaces/:id/tool-groups', async c => {
    const workspaceId = identifier(c.req.param('id'));
    const member = await requireMember(c.env, workspaceId, c.get('auth').userId);
    return c.json(await toolGroupSettings(c.env, workspaceId, member.role === 'owner' || member.role === 'admin'));
  });

  app.post('/api/workspaces/:id/tool-groups', async c => {
    const workspaceId = identifier(c.req.param('id'));
    const actor = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    const input = await jsonObject(c, 16 * 1024);
    if (Object.keys(input).some(key => key !== 'name' && key !== 'tools')) fail(400, 'invalid_input', 'A tool group has a name and tools.');
    const name = groupName(input.name);
    const tools = groupToolsInput(input.tools);
    const groupId = id();
    const at = now();
    const saved = await c.env.DB.query<GroupRow>(`INSERT INTO workspace_tool_groups (id, workspace_id, name, tools_json, created_by, created_at, updated_by, updated_at)
      SELECT ?,?,?,?,?,?,?,? WHERE ${workspaceAdminSQL}
        AND (SELECT COUNT(*) FROM workspace_tool_groups WHERE workspace_id = ?) < ?
      RETURNING id`).bind(groupId, workspaceId, name, JSON.stringify(tools), actor, at, actor, at, workspaceId, actor, workspaceId, toolGroupLimits.groups)
      .first().catch(sameName);
    if (!saved) fail(409, 'tool_group_limit', `A workspace has at most ${toolGroupLimits.groups} tool groups.`);
    await auditStatement(c.env, actor, 'workspace.tool_group.created', workspaceId, null, { groupId, name, tools }).run();
    return c.json(await toolGroupSettings(c.env, workspaceId, true), 201);
  });

  app.patch('/api/workspaces/:id/tool-groups/:groupId', async c => {
    const workspaceId = identifier(c.req.param('id'));
    const groupId = identifier(c.req.param('groupId'));
    const actor = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    const input = await jsonObject(c, 16 * 1024);
    if (!Object.keys(input).length || Object.keys(input).some(key => key !== 'name' && key !== 'tools')) fail(400, 'invalid_input', 'Change a tool group\'s name or tools.');
    const current = await c.env.DB.query<GroupRow>('SELECT id, name, tools_json, created_at, updated_at FROM workspace_tool_groups WHERE id = ? AND workspace_id = ?')
      .bind(groupId, workspaceId).first();
    if (!current) fail(404, 'not_found', 'Tool group not found.');
    const name = input.name === undefined ? current.name : groupName(input.name);
    const tools = input.tools === undefined ? groupRecord(current).tools : groupToolsInput(input.tools);
    const saved = await c.env.DB.query(`UPDATE workspace_tool_groups SET name = ?, tools_json = ?, updated_by = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ? AND ${workspaceAdminSQL} RETURNING id`)
      .bind(name, JSON.stringify(tools), actor, now(), groupId, workspaceId, workspaceId, actor).first().catch(sameName);
    if (!saved) {
      const exists = await c.env.DB.query('SELECT 1 AS n FROM workspace_tool_groups WHERE id = ? AND workspace_id = ?').bind(groupId, workspaceId).first();
      fail(exists ? 403 : 404, exists ? 'forbidden' : 'not_found', exists ? 'Workspace administrator access is required.' : 'Tool group not found.');
    }
    await auditStatement(c.env, actor, 'workspace.tool_group.updated', workspaceId, null, { groupId, name, tools }).run();
    return c.json(await toolGroupSettings(c.env, workspaceId, true));
  });

  app.delete('/api/workspaces/:id/tool-groups/:groupId', async c => {
    const workspaceId = identifier(c.req.param('id'));
    const groupId = identifier(c.req.param('groupId'));
    const actor = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    const [, removed] = await c.env.DB.batch<{ id: string }>([
      c.env.DB.query<{ id: string }>(`DELETE FROM workspace_member_tool_groups WHERE group_id = ? AND workspace_id = ? AND ${workspaceAdminSQL}`)
        .bind(groupId, workspaceId, workspaceId, actor),
      c.env.DB.query<{ id: string }>(`DELETE FROM workspace_tool_groups WHERE id = ? AND workspace_id = ? AND ${workspaceAdminSQL} RETURNING id`)
        .bind(groupId, workspaceId, workspaceId, actor),
    ]);
    if (!removed?.results.length) fail(404, 'not_found', 'Tool group not found.');
    await auditStatement(c.env, actor, 'workspace.tool_group.deleted', workspaceId, null, { groupId }).run();
    return c.json(await toolGroupSettings(c.env, workspaceId, true));
  });

  app.put('/api/workspaces/:id/members/:userId/tool-group', async c => {
    const workspaceId = identifier(c.req.param('id'));
    const targetId = userIdentifier(c.req.param('userId'), 'userId');
    const actor = c.get('auth').userId;
    const input = await jsonObject(c, 1024);
    if (Object.keys(input).length !== 1 || !('groupId' in input)) fail(400, 'invalid_input', 'Set groupId to a tool group of the workspace, or null for the member\'s role.');
    const groupId = input.groupId === null ? null : identifier(input.groupId, 'groupId');
    const targetRole = await requireMemberManagement(c.env, workspaceId, actor, targetId);
    if (!targetRole) fail(404, 'not_found', 'Membership not found.');
    if (groupId === null) {
      await c.env.DB.query(`DELETE FROM workspace_member_tool_groups WHERE workspace_id = ? AND user_id = ? AND ${workspaceAdminSQL}`)
        .bind(workspaceId, targetId, workspaceId, actor).run();
    } else {
      const saved = await c.env.DB.query(`INSERT INTO workspace_member_tool_groups (workspace_id, user_id, group_id, assigned_by, assigned_at)
        SELECT ?,?,g.id,?,? FROM workspace_tool_groups g WHERE g.id = ? AND g.workspace_id = ? AND ${workspaceAdminSQL}
          AND EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = ? AND m.user_id = ?)
        ON CONFLICT (workspace_id, user_id) DO UPDATE SET group_id = excluded.group_id, assigned_by = excluded.assigned_by, assigned_at = excluded.assigned_at
        RETURNING group_id`).bind(workspaceId, targetId, actor, now(), groupId, workspaceId, workspaceId, actor, workspaceId, targetId).first();
      if (!saved) fail(404, 'not_found', 'Tool group not found.');
    }
    await auditStatement(c.env, actor, 'workspace.member.tool_group', workspaceId, null, { userId: targetId, groupId }).run();
    return c.json(await toolGroupSettings(c.env, workspaceId, true));
  });
}
