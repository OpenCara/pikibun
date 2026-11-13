import {
  isGroupTool, memberTools, retiredGroupTools, roleGroupNames, toolGroupLimits, toolsLeftOut, toolsOff, type GroupTool, type MemberToolGroup,
} from '../../../../packages/shared/src/tool-groups.js';
import type { WorkspaceRole } from '../../../../packages/shared/src/types.js';
import { ConstraintError } from '../db/types.js';
import { fail, id, now } from '../http.js';
import type { Env, SessionRow } from '../types.js';
import { workspaceAdminSQL } from './access.js';
import { auditStatement } from './audit.js';

type MemberGroupRow = { user_id: string; role: WorkspaceRole; group_name: string | null; tools_json: string | null };

function groupOf(row: MemberGroupRow): { name: string; tools: GroupTool[] } {
  let tools: unknown = null;
  if (row.tools_json !== null) {
    try { tools = JSON.parse(row.tools_json); } catch { tools = []; }
  }
  const group = row.group_name !== null ? { tools: Array.isArray(tools) ? tools.filter(isGroupTool) : [] } : null;
  return { name: row.group_name ?? roleGroupNames[row.role], tools: memberTools(row.role, group) };
}

const memberGroupsSQL = `SELECT m.user_id, m.role, g.name AS group_name, g.tools_json FROM workspace_members m
  LEFT JOIN workspace_member_tool_groups a ON a.workspace_id = m.workspace_id AND a.user_id = m.user_id
  LEFT JOIN workspace_tool_groups g ON g.id = a.group_id AND g.workspace_id = m.workspace_id
  WHERE m.workspace_id = ?`;

export async function memberToolGroup(env: Env, workspaceId: string, userId: string): Promise<{ name: string; tools: GroupTool[] }> {
  const row = await env.DB.query<MemberGroupRow>(`${memberGroupsSQL} AND m.user_id = ?`).bind(workspaceId, userId).first();
  return row ? groupOf(row) : { name: 'No membership', tools: [] };
}

export async function memberToolGroups(env: Env, workspaceId: string): Promise<Record<string, MemberToolGroup>> {
  const rows = await env.DB.query<MemberGroupRow>(memberGroupsSQL).bind(workspaceId).all();
  const result: Record<string, MemberToolGroup> = {};
  for (const row of rows) {
    const group = groupOf(row);
    const off = toolsOff(group.tools);
    if (off.length) result[row.user_id] = { name: group.name, off };
  }
  return result;
}

function groupHas(group: { tools: GroupTool[] }, tool: string): boolean {
  return retiredGroupTools.includes(tool) ? !toolsLeftOut(group.tools).length : group.tools.includes(tool as GroupTool);
}

function sameName(error: unknown): never {
  if (error instanceof ConstraintError || (error instanceof Error && /UNIQUE|unique|duplicate/.test(error.message))) {
    fail(409, 'name_taken', 'This workspace has a tool group with that name already.');
  }
  throw error;
}

const workspaceOwnerSQL = `EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND owner_id = ?)`;
const groupHasAdminsSQL = `EXISTS (SELECT 1 FROM workspace_member_tool_groups held
  JOIN workspace_members holder ON holder.workspace_id = held.workspace_id AND holder.user_id = held.user_id
  WHERE held.group_id = ? AND held.workspace_id = ? AND holder.role IN ('owner', 'admin'))`;
const groupManagerSQL = `${workspaceAdminSQL} AND (${workspaceOwnerSQL} OR NOT ${groupHasAdminsSQL})`;
const groupManagerBinds = (workspaceId: string, groupId: string, actorId: string) => [workspaceId, actorId, workspaceId, actorId, groupId, workspaceId];
const adminsGroup = 'Only the workspace owner changes or deletes a tool group with an administrator or the owner among its members: it limits what they run.';

async function groupRefusal(env: Env, workspaceId: string, groupId: string, actorId: string): Promise<never> {
  const found = await env.DB.query<{ admin: number; owner: number; admins: number }>(`SELECT ${workspaceAdminSQL} AS admin, ${workspaceOwnerSQL} AS owner,
    ${groupHasAdminsSQL} AS admins FROM workspace_tool_groups WHERE id = ? AND workspace_id = ?`)
    .bind(workspaceId, actorId, workspaceId, actorId, groupId, workspaceId, groupId, workspaceId).first();
  if (!found) fail(404, 'not_found', 'Tool group not found.');
  if (!Number(found.admin)) fail(403, 'forbidden', 'Workspace administrator access is required.');
  if (!Number(found.owner) && Number(found.admins)) fail(403, 'admins_group', adminsGroup);
  fail(409, 'tool_group_changed', 'The tool group changed meanwhile; try again.');
}

export async function createToolGroup(env: Env, workspaceId: string, actorId: string, name: string, tools: GroupTool[]): Promise<void> {
  const groupId = id();
  const at = now();
  const saved = await env.DB.query(`INSERT INTO workspace_tool_groups (id, workspace_id, name, tools_json, created_by, created_at, updated_by, updated_at)
    SELECT ?,?,?,?,?,?,?,? WHERE ${workspaceAdminSQL}
      AND (SELECT COUNT(*) FROM workspace_tool_groups WHERE workspace_id = ?) < ?
    RETURNING id`).bind(groupId, workspaceId, name, JSON.stringify(tools), actorId, at, actorId, at, workspaceId, actorId, workspaceId, toolGroupLimits.groups)
    .first().catch(sameName);
  if (!saved) fail(409, 'tool_group_limit', `A workspace has at most ${toolGroupLimits.groups} tool groups.`);
  await auditStatement(env, actorId, 'workspace.tool_group.created', workspaceId, null, { groupId, name, tools }).run();
}

export async function updateToolGroup(env: Env, workspaceId: string, groupId: string, actorId: string, name: string, tools: GroupTool[]): Promise<void> {
  const saved = await env.DB.query(`UPDATE workspace_tool_groups SET name = ?, tools_json = ?, updated_by = ?, updated_at = ?
    WHERE id = ? AND workspace_id = ? AND ${groupManagerSQL} RETURNING id`)
    .bind(name, JSON.stringify(tools), actorId, now(), groupId, workspaceId, ...groupManagerBinds(workspaceId, groupId, actorId)).first().catch(sameName);
  if (!saved) await groupRefusal(env, workspaceId, groupId, actorId);
  await auditStatement(env, actorId, 'workspace.tool_group.updated', workspaceId, null, { groupId, name, tools }).run();
}

export async function deleteToolGroup(env: Env, workspaceId: string, groupId: string, actorId: string): Promise<void> {
  const allowed = await env.DB.query(`SELECT 1 AS n FROM workspace_tool_groups WHERE id = ? AND workspace_id = ? AND ${groupManagerSQL}`)
    .bind(groupId, workspaceId, ...groupManagerBinds(workspaceId, groupId, actorId)).first();
  if (!allowed) await groupRefusal(env, workspaceId, groupId, actorId);
  const [, removed] = await env.DB.batch<{ id: string }>([
    env.DB.query<{ id: string }>(`DELETE FROM workspace_member_tool_groups WHERE group_id = ? AND workspace_id = ? AND ${groupManagerSQL}`)
      .bind(groupId, workspaceId, ...groupManagerBinds(workspaceId, groupId, actorId)),
    env.DB.query<{ id: string }>(`DELETE FROM workspace_tool_groups WHERE id = ? AND workspace_id = ? AND ${groupManagerSQL} RETURNING id`)
      .bind(groupId, workspaceId, ...groupManagerBinds(workspaceId, groupId, actorId)),
  ]);
  if (!removed?.results.length) await groupRefusal(env, workspaceId, groupId, actorId);
  await auditStatement(env, actorId, 'workspace.tool_group.deleted', workspaceId, null, { groupId }).run();
}

export async function setMemberToolGroup(env: Env, workspaceId: string, targetId: string, actorId: string, groupId: string | null): Promise<void> {
  if (groupId === null) {
    await env.DB.query(`DELETE FROM workspace_member_tool_groups WHERE workspace_id = ? AND user_id = ? AND ${workspaceAdminSQL}`)
      .bind(workspaceId, targetId, workspaceId, actorId).run();
  } else {
    const saved = await env.DB.query(`INSERT INTO workspace_member_tool_groups (workspace_id, user_id, group_id, assigned_by, assigned_at)
      SELECT ?,?,g.id,?,? FROM workspace_tool_groups g WHERE g.id = ? AND g.workspace_id = ? AND ${workspaceAdminSQL}
        AND EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = ? AND m.user_id = ?)
      ON CONFLICT (workspace_id, user_id) DO UPDATE SET group_id = excluded.group_id, assigned_by = excluded.assigned_by, assigned_at = excluded.assigned_at
      RETURNING group_id`).bind(workspaceId, targetId, actorId, now(), groupId, workspaceId, workspaceId, actorId, workspaceId, targetId).first();
    if (!saved) fail(404, 'not_found', 'Tool group not found.');
  }
  await auditStatement(env, actorId, 'workspace.member.tool_group', workspaceId, null, { userId: targetId, groupId }).run();
}

export async function requireSessionTool(env: Env, row: Pick<SessionRow, 'workspace_id' | 'owner_id'>, actorId: string, tool: string): Promise<void> {
  if (!isGroupTool(tool) && !retiredGroupTools.includes(tool)) return;
  const owner = await memberToolGroup(env, row.workspace_id, row.owner_id);
  if (!groupHas(owner, tool)) {
    fail(403, 'tool_not_in_group', `${tool} isn't among the tools of this session's owner (${owner.name}). Workspace owners and admins choose each member's tools under Settings → Workspaces → Tool groups.`);
  }
  if (actorId === row.owner_id) return;
  const actor = await memberToolGroup(env, row.workspace_id, actorId);
  if (!groupHas(actor, tool)) {
    fail(403, 'tool_not_in_group', `${tool} isn't among the tools of the person who sent this message (${actor.name}): a message runs only the tools both its sender and the session's owner have. Workspace owners and admins choose each member's tools under Settings → Workspaces → Tool groups.`);
  }
}
