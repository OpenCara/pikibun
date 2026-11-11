import { workspaceManagerRolesSQL } from './authority/index.js';
import type { Hono } from 'hono';
import { assignableWorkspaceRoles, retiredToolNames, toolNames } from '../../../packages/shared/src/types.js';
import type { AnyToolName, AssignableWorkspaceRole, Workspace, WorkspaceRole } from '../../../packages/shared/src/types.js';
import { bundledToolDefinitions } from '../../../packages/shared/src/tool-definitions.js';
import { adminManagedRoles } from '../../../packages/shared/src/policy.js';
import type { ConnectorCapabilities } from '../../../packages/shared/src/connector.js';
import {
  addMemberStatement, auditAfterChange, defaultWorkspaceExtensionStatements, auditStatement, changeMemberRoleStatement, personalWorkspaceName, removeMemberStatements, requireMember,
  requireSharedWorkspace, workspaceOwnerStatement,
} from './authority/index.js';
import { modelDefinition } from './db.js';
import { fail, id, identifier, jsonObject, now, testMode, text, userIdentifier } from './http.js';
import type { AgentRow, Env, ModelRow, AppEnv } from './types.js';
import { ConstraintError, type Query } from './db/types.js';
import { ownerHostStatements } from './connectors.js';
import { modelEnabledSQL } from './host-models.js';

interface SafeMember {
  userId: string;
  displayName: string;
  username: string | null;
  githubLogin: string | null;
  role: WorkspaceRole;
}

interface AgentInput {
  name: string;
  description: string;
  instructions: string;
  toolsJson: string;
  modelId: string;
}

function onlyFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(body).some(key => !allowed.includes(key))) {
    fail(400, 'invalid_input', 'Unexpected request field.');
  }
}

function nameInput(value: unknown): string {
  const result = text(value, 'name', 200).trim();
  if (!result) fail(400, 'invalid_input', 'Invalid name.');
  return result;
}

function membersStatement(env: Env, workspaceId: string, actorId: string): Query<SafeMember> {
  return env.DB.query<SafeMember>(`SELECT member.user_id AS userId, u.display_name AS displayName,
      u.username, u.github_login AS githubLogin, member.role
    FROM workspace_members member
    INNER JOIN users u ON u.id = member.user_id
    INNER JOIN workspace_members actor ON actor.workspace_id = member.workspace_id AND actor.user_id = ?
    WHERE member.workspace_id = ?
    ORDER BY member.created_at, member.user_id`).bind(actorId, workspaceId);
}

export async function requireMemberManagement(
  env: Env, workspaceId: string, actorId: string, targetId: string, role?: AssignableWorkspaceRole,
): Promise<WorkspaceRole | null> {
  const authority = await env.DB.query<{ ownerId: string; actorRole: WorkspaceRole; targetRole: WorkspaceRole | null }>(`SELECT w.owner_id AS ownerId, actor.role AS actorRole,
      target.role AS targetRole
    FROM workspaces w
    INNER JOIN workspace_members actor ON actor.workspace_id = w.id AND actor.user_id = ?
    LEFT JOIN workspace_members target ON target.workspace_id = w.id AND target.user_id = ?
    WHERE w.id = ?`).bind(actorId, targetId, workspaceId)
    .first();
  if (!authority) fail(404, 'not_found', 'Workspace not found.');
  const owner = authority.actorRole === 'owner' && authority.ownerId === actorId;
  if (!owner && authority.actorRole !== 'admin') {
    fail(403, 'forbidden', 'Workspace administrator access is required.');
  }
  if (targetId === authority.ownerId || authority.targetRole === 'owner') {
    fail(403, 'forbidden', 'The workspace owner membership cannot be changed or removed.');
  }
  if (!owner && targetId === actorId) {
    fail(403, 'forbidden', 'Administrators cannot change or remove their own membership. Ask the workspace owner.');
  }
  if (!owner && ((role && !adminManagedRoles.includes(role)) || (authority.targetRole && !adminManagedRoles.includes(authority.targetRole)))) {
    fail(403, 'forbidden', 'Only the workspace owner can manage administrators.');
  }
  return authority.targetRole;
}

function modelAccessSQL(actor: 'member.user_id' | 'actor.user_id' | 'a.author_id', disabled: 'excluded' | 'included' = 'excluded'): string {
  return `m.available = 1 AND (? = 1 OR m.provider <> 'faux')
    AND (m.connector_id IS NULL OR EXISTS (
      SELECT 1 FROM connectors c
      JOIN connector_workspaces cw ON cw.connector_id = c.id AND cw.workspace_id = m.workspace_id
      JOIN workspace_members host ON host.workspace_id = cw.workspace_id AND host.user_id = c.owner_id
      JOIN users host_user ON host_user.id = c.owner_id
      WHERE c.id = m.connector_id AND c.owner_id = m.connector_owner_id AND c.revoked_at IS NULL AND host_user.suspended_at IS NULL
        AND (? = 1 OR host_user.auth_kind <> 'test')
        AND (c.owner_id = ${actor} OR EXISTS (SELECT 1 FROM connector_shares sh
          WHERE sh.connector_id = c.id AND sh.workspace_id = cw.workspace_id))
        AND EXISTS (SELECT 1 FROM json_each(c.models_json) local_model
          WHERE json_extract(local_model.value, '$.provider') = m.provider
            AND json_extract(local_model.value, '$.modelId') = m.model_id)
        ${disabled === 'excluded' ? `AND ${modelEnabledSQL('c.id', 'm')}` : ''}
    ))`;
}

export async function usableModels(env: Env, workspaceId: string, actorId: string): Promise<ModelRow[]> {
  return env.DB.query<ModelRow>(`SELECT m.* FROM models m
    INNER JOIN workspace_members actor ON actor.workspace_id = m.workspace_id AND actor.user_id = ?
    WHERE m.workspace_id = ? AND ${modelAccessSQL('actor.user_id')}
    ORDER BY m.created_at, m.id LIMIT 1000`)
    .bind(actorId, workspaceId, testMode(env) ? 1 : 0, testMode(env) ? 1 : 0).all();
}

export async function requireModel(env: Env, modelId: string, actorId: string): Promise<ModelRow> {
  const usable = (disabled: 'excluded' | 'included') => env.DB.query<ModelRow>(`SELECT m.* FROM models m
    INNER JOIN workspace_members member ON member.workspace_id = m.workspace_id AND member.user_id = ?
    WHERE m.id = ? AND ${modelAccessSQL('member.user_id', disabled)}`)
    .bind(actorId, modelId, testMode(env) ? 1 : 0, testMode(env) ? 1 : 0).first();
  const model = await usable('excluded');
  if (model) return model;
  if (await usable('included')) fail(403, 'model_disabled', 'This model is disabled on its host. Choose another model.');
  fail(404, 'not_found', 'Model not found.');
}

function privateVersionStatement(
  env: Env, actorId: string, agentId: string, versionId: string, input: AgentInput, createdAt: string,
): Query<AgentRow> {
  return env.DB.query<AgentRow>(`INSERT INTO agent_versions
      (id, agent_id, author_id, workspace_id, version, name, description, instructions, tools_json, model_id, created_at)
    SELECT ?, a.id, a.author_id, NULL,
      (SELECT COALESCE(MAX(version), 0) + 1 FROM agent_versions WHERE agent_id = a.id),
      ?, ?, ?, ?, m.id, ?
    FROM agents a
    INNER JOIN models m ON m.id = ?
    INNER JOIN workspace_members member ON member.workspace_id = m.workspace_id AND member.user_id = a.author_id
    WHERE a.id = ? AND a.author_id = ?
      AND ${modelAccessSQL('a.author_id')}
    RETURNING *`).bind(versionId, input.name, input.description, input.instructions, input.toolsJson,
      createdAt, input.modelId, agentId, actorId, testMode(env) ? 1 : 0, testMode(env) ? 1 : 0);
}

const VERSION_CONFLICT = /agent_versions\.agent_id,\s*agent_versions\.version|agent_versions_agent_id_version_key/;

function versionConflict(error: unknown): boolean {
  const seen = new Set<Error>();
  while (error instanceof Error && !seen.has(error)) {
    if (error instanceof ConstraintError && VERSION_CONFLICT.test(error.constraint)) return true;
    seen.add(error);
    error = error.cause;
  }
  return false;
}

async function versionBatch(env: Env, statements: Query<AgentRow>[], versionIndex: number): Promise<AgentRow> {
  try {
    const results = await env.DB.batch<AgentRow>(statements);
    const row = results[versionIndex].results[0];
    if (!row) fail(409, 'catalog_changed', 'Agent, model, or membership changed. Refresh and try again.');
    return row;
  } catch (error) {
    if (versionConflict(error)) fail(409, 'version_conflict', 'Another agent version was created. Refresh and try again.');
    throw error;
  }
}

const agentToolNames: readonly AnyToolName[] = [...toolNames, ...bundledToolDefinitions.map(item => item.name).filter(name => !(toolNames as readonly string[]).includes(name))];

function carries(capabilities: ConnectorCapabilities, tool: AnyToolName): boolean {
  if ((retiredToolNames as readonly string[]).includes(tool)) return false;
  if (tool === 'git_push') return capabilities.gitPush === true;
  if (tool === 'github_read' || tool === 'github_merge') return capabilities.github === true;
  if (tool === 'github_issue') return capabilities.githubIssues === true;
  if (tool === 'source_read') return capabilities.sources === true;
  if (tool === 'schedule') return capabilities.schedules === true;
  if (tool === 'sessions') return capabilities.crossSessions === true;
  return true;
}

export async function chatAgentVersion(env: Env, ownerId: string, model: ModelRow, capabilities: ConnectorCapabilities): Promise<AgentRow> {
  const agentId = id();
  const createdAt = now();
  const tools = agentToolNames.filter(tool => carries(capabilities, tool));
  const input: AgentInput = { name: model.name, description: '', instructions: '', toolsJson: JSON.stringify(tools), modelId: model.id };
  return versionBatch(env, [
    env.DB.query<never>(`INSERT INTO agents (id, author_id, created_at, chat)
      SELECT ?, ?, ?, 1 FROM models m
      INNER JOIN workspace_members member ON member.workspace_id = m.workspace_id AND member.user_id = ?
      WHERE m.id = ? AND ${modelAccessSQL('member.user_id')}`)
      .bind(agentId, ownerId, createdAt, ownerId, model.id, testMode(env) ? 1 : 0, testMode(env) ? 1 : 0),
    privateVersionStatement(env, ownerId, agentId, id(), input, createdAt),
  ], 1);
}

export async function migratedAgentVersion(env: Env, ownerId: string, source: AgentRow, model: ModelRow, capabilities: ConnectorCapabilities): Promise<AgentRow> {
  const agentId = id();
  const createdAt = now();
  const wanted = JSON.parse(source.tools_json) as unknown[];
  const tools = agentToolNames.filter(tool => wanted.includes(tool) && carries(capabilities, tool));
  const input: AgentInput = { name: source.name, description: source.description, instructions: source.instructions,
    toolsJson: JSON.stringify(tools), modelId: model.id };
  return versionBatch(env, [
    env.DB.query<never>(`INSERT INTO agents (id, author_id, created_at, chat)
      SELECT ?, ?, ?, 1 FROM models m
      INNER JOIN workspace_members member ON member.workspace_id = m.workspace_id AND member.user_id = ?
      WHERE m.id = ? AND ${modelAccessSQL('member.user_id')}`)
      .bind(agentId, ownerId, createdAt, ownerId, model.id, testMode(env) ? 1 : 0, testMode(env) ? 1 : 0),
    privateVersionStatement(env, ownerId, agentId, id(), input, createdAt),
  ], 1);
}

function newWorkspaceStatements(env: Env, workspace: { id: string; name: string; ownerId: string }, createdAt: string, detail: Record<string, unknown> = {}): Query<never>[] {
  return [
    env.DB.query<never>('INSERT INTO workspaces (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)')
      .bind(workspace.id, workspace.name, workspace.ownerId, createdAt),
    workspaceOwnerStatement(env.DB, workspace.id, workspace.ownerId, createdAt),
    auditStatement(env, workspace.ownerId, 'workspace.create', workspace.id, null, detail),
    ...defaultWorkspaceExtensionStatements(env.DB, workspace.id, workspace.ownerId, createdAt),
    ...ownerHostStatements(env, workspace.ownerId, workspace.id),
  ];
}

export async function ensurePersonalWorkspace(env: Env, userId: string): Promise<void> {
  if (await env.DB.query('SELECT 1 AS found FROM personal_workspaces WHERE user_id = ?').bind(userId).first()) return;
  const workspace = { id: id(), name: personalWorkspaceName, ownerId: userId };
  const createdAt = now();
  try {
    await env.DB.batch([
      ...newWorkspaceStatements(env, workspace, createdAt, { personal: true }),
      env.DB.query<never>('INSERT INTO personal_workspaces (user_id, workspace_id, created_at) VALUES (?, ?, ?)')
        .bind(userId, workspace.id, createdAt),
    ]);
  } catch (error) {
    if (error instanceof ConstraintError && await env.DB.query('SELECT 1 AS found FROM personal_workspaces WHERE user_id = ?').bind(userId).first()) return;
    throw error;
  }
}

export function registerCatalog(app: Hono<AppEnv>): void {
  app.get('/api/workspaces', async c => {
    const userId = c.get('auth').userId;
    await ensurePersonalWorkspace(c.env, userId);
    const rows = await c.env.DB.query<Omit<Workspace, 'personal'> & { personal: number }>(`SELECT w.id, w.name, w.owner_id AS ownerId, member.role,
        CASE WHEN p.workspace_id IS NULL THEN 0 ELSE 1 END AS personal
      FROM workspaces w
      INNER JOIN workspace_members member ON member.workspace_id = w.id AND member.user_id = ?
      LEFT JOIN personal_workspaces p ON p.workspace_id = w.id AND p.user_id = member.user_id
      ORDER BY CASE WHEN p.workspace_id IS NULL THEN 1 ELSE 0 END, w.created_at, w.id`).bind(userId).all();
    const workspaces: Workspace[] = rows.map(row => ({ ...row, personal: Number(row.personal) === 1 }));
    return c.json({ workspaces });
  });

  app.post('/api/workspaces', async c => {
    const body = await jsonObject(c);
    onlyFields(body, ['name']);
    const workspace = { id: id(), name: nameInput(body.name), ownerId: c.get('auth').userId, role: 'owner' as const, personal: false };
    await c.env.DB.batch(newWorkspaceStatements(c.env, workspace, now()));
    return c.json({ workspace }, 201);
  });

  app.patch('/api/workspaces/:id', async c => {
    const workspaceId = identifier(c.req.param('id'), 'workspaceId');
    const actorId = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actorId, ['owner', 'admin']);
    const body = await jsonObject(c);
    onlyFields(body, ['name']);
    const name = nameInput(body.name);
    const result = await c.env.DB.batch<Omit<Workspace, 'personal'> & { personal: number }>([
      c.env.DB.query<never>(`UPDATE workspaces SET name = ?
        WHERE id = ? AND EXISTS (SELECT 1 FROM workspace_members actor
          WHERE actor.workspace_id = workspaces.id AND actor.user_id = ? AND actor.role IN (${workspaceManagerRolesSQL}))`)
        .bind(name, workspaceId, actorId),
      auditAfterChange(c.env, actorId, 'workspace.renamed', workspaceId, {}),
      c.env.DB.query<Omit<Workspace, 'personal'> & { personal: number }>(`SELECT w.id, w.name, w.owner_id AS ownerId, member.role,
          CASE WHEN p.workspace_id IS NULL THEN 0 ELSE 1 END AS personal
        FROM workspaces w
        INNER JOIN workspace_members member ON member.workspace_id = w.id AND member.user_id = ?
        LEFT JOIN personal_workspaces p ON p.workspace_id = w.id AND p.user_id = member.user_id
        WHERE w.id = ?`).bind(actorId, workspaceId),
    ]);
    const row = result[2].results[0];
    if (result[0].changes !== 1 || !row) fail(403, 'forbidden', 'Workspace administrator access is required.');
    const workspace: Workspace = { ...row, personal: Number(row.personal) === 1 };
    return c.json({ workspace });
  });

  app.get('/api/workspaces/:id/members', async c => {
    const workspaceId = identifier(c.req.param('id'), 'workspaceId');
    const actorId = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actorId);
    const members = await membersStatement(c.env, workspaceId, actorId).all();
    return c.json({ members });
  });

  app.post('/api/workspaces/:id/members', async c => {
    const workspaceId = identifier(c.req.param('id'), 'workspaceId');
    const actorId = c.get('auth').userId;
    const body = await jsonObject(c);
    onlyFields(body, ['userId', 'role']);
    const targetId = userIdentifier(body.userId);
    const role = body.role;
    if (typeof role !== 'string' || !(assignableWorkspaceRoles as readonly string[]).includes(role)) fail(400, 'invalid_input', 'Invalid role.');
    const previous = await requireMemberManagement(c.env, workspaceId, actorId, targetId, role as AssignableWorkspaceRole);
    await requireSharedWorkspace(c.env, workspaceId);
    if (previous === role) return c.json({ members: await membersStatement(c.env, workspaceId, actorId).all() });
    const user = await c.env.DB.query<{ id: string }>('SELECT id FROM users WHERE id = ?').bind(targetId).first();
    if (!user) fail(404, 'not_found', 'User not found.');
    const auditId = id();
    const result = await c.env.DB.batch<SafeMember>([
      addMemberStatement(c.env.DB, { workspaceId, actorId, userId: targetId, role: role as AssignableWorkspaceRole, previous, at: now() }),
      auditAfterChange(c.env, actorId, 'workspace.member.upsert', workspaceId, { userId: targetId, role }, auditId),
      c.env.DB.query<never>(`UPDATE sessions SET policy_version = policy_version + 1
        WHERE workspace_id = ? AND ? = 1 AND EXISTS (SELECT 1 FROM audit WHERE id = ?)`)
        .bind(workspaceId, previous ? 1 : 0, auditId),
      membersStatement(c.env, workspaceId, actorId),
      c.env.DB.query<never>(`DELETE FROM workspace_join_requests WHERE workspace_id = ? AND user_id = ?
        AND EXISTS (SELECT 1 FROM audit WHERE id = ?)`)
        .bind(workspaceId, targetId, auditId),
      ...ownerHostStatements(c.env, targetId, workspaceId),
    ]);
    if (result[0].changes !== 1) fail(409, 'membership_changed', 'Membership changed. Refresh and try again.');
    return c.json({ members: result[3].results });
  });

  app.patch('/api/workspaces/:id/members/:userId', async c => {
    const workspaceId = identifier(c.req.param('id'), 'workspaceId');
    const targetId = userIdentifier(c.req.param('userId'));
    const actorId = c.get('auth').userId;
    const body = await jsonObject(c);
    onlyFields(body, ['role']);
    const role = body.role;
    if (typeof role !== 'string' || !(assignableWorkspaceRoles as readonly string[]).includes(role)) fail(400, 'invalid_input', 'Invalid role.');
    const previous = await requireMemberManagement(c.env, workspaceId, actorId, targetId, role as AssignableWorkspaceRole);
    if (!previous) fail(404, 'not_found', 'Membership not found.');
    if (previous === role) return c.json({ members: await membersStatement(c.env, workspaceId, actorId).all() });
    const auditId = id();
    const result = await c.env.DB.batch<SafeMember>([
      changeMemberRoleStatement(c.env.DB, { workspaceId, actorId, userId: targetId, role: role as AssignableWorkspaceRole, previous, at: now() }),
      auditAfterChange(c.env, actorId, 'workspace.member.role', workspaceId, { userId: targetId, from: previous, role }, auditId),
      c.env.DB.query<never>(`UPDATE sessions SET policy_version = policy_version + 1
        WHERE workspace_id = ? AND EXISTS (SELECT 1 FROM audit WHERE id = ?)`)
        .bind(workspaceId, auditId),
      membersStatement(c.env, workspaceId, actorId),
    ]);
    if (result[0].changes !== 1) fail(409, 'membership_changed', 'Membership changed. Refresh and try again.');
    return c.json({ members: result[3].results });
  });

  app.delete('/api/workspaces/:id/members/:userId', async c => {
    const workspaceId = identifier(c.req.param('id'), 'workspaceId');
    const targetId = userIdentifier(c.req.param('userId'));
    const actorId = c.get('auth').userId;
    const targetRole = await requireMemberManagement(c.env, workspaceId, actorId, targetId);
    if (!targetRole) fail(404, 'not_found', 'Membership not found.');
    const auditId = id();
    const removal = removeMemberStatements(c.env.DB, { workspaceId, actorId, userId: targetId, auditId });
    const result = await c.env.DB.batch([
      removal.member,
      auditAfterChange(c.env, actorId, 'workspace.member.remove', workspaceId, { userId: targetId }, auditId),
      removal.grants,
      c.env.DB.query(`DELETE FROM workspace_database_consents WHERE workspace_id = ? AND user_id = ?
        AND EXISTS (SELECT 1 FROM audit WHERE id = ?)`)
        .bind(workspaceId, targetId, auditId),
      c.env.DB.query(`DELETE FROM workspace_member_tool_groups WHERE workspace_id = ? AND user_id = ?
        AND EXISTS (SELECT 1 FROM audit WHERE id = ?)`)
        .bind(workspaceId, targetId, auditId),
      c.env.DB.query(`DELETE FROM connector_workspaces WHERE workspace_id = ?
        AND connector_id IN (SELECT id FROM connectors WHERE owner_id = ?)
        AND EXISTS (SELECT 1 FROM audit WHERE id = ?)`)
        .bind(workspaceId, targetId, auditId),
      c.env.DB.query(`UPDATE sessions SET policy_version = policy_version + 1
        WHERE workspace_id = ? AND EXISTS (SELECT 1 FROM audit WHERE id = ?)`)
        .bind(workspaceId, auditId),
    ]);
    if (result[0].changes !== 1) fail(409, 'membership_changed', 'Membership changed. Refresh and try again.');
    return c.body(null, 204);
  });

  app.get('/api/workspaces/:id/models', async c => {
    const workspaceId = identifier(c.req.param('id'), 'workspaceId');
    const actorId = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actorId);
    return c.json({ models: (await usableModels(c.env, workspaceId, actorId)).map(modelDefinition) });
  });

  app.post('/api/workspaces/:id/models', async c => {
    const workspaceId = identifier(c.req.param('id'), 'workspaceId');
    const actorId = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actorId, ['owner', 'admin']);
    const body = await jsonObject(c);
    onlyFields(body, ['name', 'provider', 'modelId']);
    const name = nameInput(body.name);
    const provider = body.provider;
    if (provider !== 'openai' && provider !== 'anthropic' && provider !== 'faux') {
      fail(400, 'invalid_input', 'Invalid provider.');
    }
    if (provider === 'faux' && !testMode(c.env)) fail(400, 'invalid_input', 'The faux provider requires test mode.');
    const providerModelId = text(body.modelId, 'modelId', 200);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(providerModelId)) fail(400, 'invalid_input', 'Invalid modelId.');
    const modelId = id();
    const result = await c.env.DB.batch<ModelRow>([
      c.env.DB.query<ModelRow>(`INSERT INTO models (id, workspace_id, name, provider, model_id, created_at)
        SELECT ?, member.workspace_id, ?, ?, ?, ? FROM workspace_members member
        WHERE member.workspace_id = ? AND member.user_id = ? AND member.role IN (${workspaceManagerRolesSQL})
        RETURNING *`).bind(modelId, name, provider, providerModelId, now(), workspaceId, actorId),
      auditAfterChange(c.env, actorId, 'model.create', workspaceId, { modelId, provider }),
    ]);
    const model = result[0].results[0];
    if (!model) fail(409, 'membership_changed', 'Membership changed. Refresh and try again.');
    return c.json({ model: modelDefinition(model) }, 201);
  });
}
