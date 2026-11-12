import {
  isGroupTool, memberTools, retiredGroupTools, roleGroupNames, toolsLeftOut, toolsOff, type GroupTool, type MemberToolGroup,
} from '../../../../packages/shared/src/tool-groups.js';
import type { WorkspaceRole } from '../../../../packages/shared/src/types.js';
import { fail } from '../http.js';
import type { Env, SessionRow } from '../types.js';

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
