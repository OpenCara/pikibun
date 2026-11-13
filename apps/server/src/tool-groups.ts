import type { Hono } from 'hono';
import {
  groupTools, legacyGroupToolNames, parseGroupTools, roleTools, toolGroupLimits, type GroupTool, type ToolGroup, type ToolGroupMember, type ToolGroupSettings,
} from '../../../packages/shared/src/tool-groups.js';
import { workspaceRoles, type WorkspaceRole } from '../../../packages/shared/src/types.js';
import { createToolGroup, deleteToolGroup, requireMember, setMemberToolGroup, updateToolGroup } from './authority/index.js';
import { requireMemberManagement } from './catalog.js';
import { fail, identifier, userIdentifier } from './http.js';
import { body, fields, identifier as identifierField, parsed, text } from './schemas.js';
import type { AppEnv, Env } from './types.js';

type GroupRow = { id: string; name: string; tools_json: string; created_at: string; updated_at: string };

function savedTools(row: GroupRow): GroupTool[] {
  try { return parseGroupTools(JSON.parse(row.tools_json)); } catch { return []; }
}

function groupRecord(row: GroupRow): ToolGroup {
  return { id: row.id, name: row.name, tools: legacyGroupToolNames(savedTools(row)), createdAt: row.created_at, updatedAt: row.updated_at };
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
    roles: Object.fromEntries(workspaceRoles.map(role => [role, legacyGroupToolNames(roleTools[role])])) as Record<WorkspaceRole, string[]>,
    tools: legacyGroupToolNames(groupTools),
    admin,
  };
}

const groupName = text('name', toolGroupLimits.name).transform(name => name.trim())
  .refine(name => name !== '' && !/[\r\n]/.test(name), 'A tool group\'s name is one non-empty line.');
const groupToolsInput = parsed(parseGroupTools, 'Invalid tools.');
const newGroup = fields({ name: groupName, tools: groupToolsInput }, 'A tool group has a name and tools.');
const groupChange = fields({ name: groupName.optional(), tools: groupToolsInput.optional() }, 'Change a tool group\'s name or tools.', { some: true });
const memberGroup = fields({ groupId: identifierField('groupId').nullable() }, 'Set groupId to a tool group of the workspace, or null for the member\'s role.',
  { required: ['groupId'] });

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
    const { name, tools } = await body(c, newGroup, { maxBytes: 16 * 1024 });
    await createToolGroup(c.env, workspaceId, actor, name, tools);
    return c.json(await toolGroupSettings(c.env, workspaceId, true), 201);
  });

  app.patch('/api/workspaces/:id/tool-groups/:groupId', async c => {
    const workspaceId = identifier(c.req.param('id'));
    const groupId = identifier(c.req.param('groupId'));
    const actor = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    const input = await body(c, groupChange, { maxBytes: 16 * 1024 });
    const current = await c.env.DB.query<GroupRow>('SELECT id, name, tools_json, created_at, updated_at FROM workspace_tool_groups WHERE id = ? AND workspace_id = ?')
      .bind(groupId, workspaceId).first();
    if (!current) fail(404, 'not_found', 'Tool group not found.');
    const name = input.name ?? current.name;
    const tools: GroupTool[] = input.tools ?? savedTools(current);
    await updateToolGroup(c.env, workspaceId, groupId, actor, name, tools);
    return c.json(await toolGroupSettings(c.env, workspaceId, true));
  });

  app.delete('/api/workspaces/:id/tool-groups/:groupId', async c => {
    const workspaceId = identifier(c.req.param('id'));
    const groupId = identifier(c.req.param('groupId'));
    const actor = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    await deleteToolGroup(c.env, workspaceId, groupId, actor);
    return c.json(await toolGroupSettings(c.env, workspaceId, true));
  });

  app.put('/api/workspaces/:id/members/:userId/tool-group', async c => {
    const workspaceId = identifier(c.req.param('id'));
    const targetId = userIdentifier(c.req.param('userId'), 'userId');
    const actor = c.get('auth').userId;
    const { groupId } = await body(c, memberGroup, { maxBytes: 1024 });
    const targetRole = await requireMemberManagement(c.env, workspaceId, actor, targetId);
    if (!targetRole) fail(404, 'not_found', 'Membership not found.');
    await setMemberToolGroup(c.env, workspaceId, targetId, actor, groupId);
    return c.json(await toolGroupSettings(c.env, workspaceId, true));
  });
}
