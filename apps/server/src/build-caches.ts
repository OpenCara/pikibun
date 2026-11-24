import type { Hono } from 'hono';
import { z } from 'zod';
import {
  buildCacheLimits, parseBuildCache, parseBuildCacheName, sessionBuildCaches, type BuildCache, type BuildCacheSender, type BuildCacheSenders,
  type SessionBuildCaches, type StoredBuildCache,
} from '../../../packages/shared/src/build-caches.js';
import { hasPermission, normalizePermissions, roleSessionCeiling, workspaceSessionPermissions } from '../../../packages/shared/src/policy.js';
import { canonicalGroupTools, memberTools } from '../../../packages/shared/src/tool-groups.js';
import type { Permission, WorkspaceRole } from '../../../packages/shared/src/types.js';
import type { Database } from './db/types.js';
import { auditStatement, authenticateConnector, requireCallbackScope, requireMember, workspaceAdminSQL } from './authority/index.js';
import { connectorHostConfig } from './host-config.js';
import { fail, identifier, now } from './http.js';
import { body } from './schemas.js';
import type { AppEnv, Env, SessionRow } from './types.js';

type CacheRow = { name: string; env: string; writer_groups_json: string; created_at: string; updated_at: string };

function writerGroups(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, buildCacheLimits.writerGroups) : [];
  } catch { return []; }
}

export async function workspaceBuildCaches(db: Database, workspaceId: string): Promise<StoredBuildCache[]> {
  const rows = await db.query<CacheRow>(`SELECT name, env, writer_groups_json, created_at, updated_at FROM workspace_build_caches
    WHERE workspace_id = ? ORDER BY name`).bind(workspaceId).all();
  return rows.slice(0, buildCacheLimits.caches).map(row => ({ name: row.name, env: row.env, writerGroups: writerGroups(row.writer_groups_json),
    createdAt: row.created_at, updatedAt: row.updated_at }));
}

type SenderRow = { role: WorkspaceRole; group_id: string | null; tools_json: string | null; user_id: string; grants_json: string | null; personal: number | null };
type SessionSender = BuildCacheSender & { userId: string; messages: boolean; granted: boolean };

function grantedPermissions(json: string | null): Permission[] {
  if (json === null) return [];
  try { return normalizePermissions(JSON.parse(json)); } catch { return []; }
}

async function sessionSenders(env: Env, row: Pick<SessionRow, 'id' | 'workspace_id' | 'owner_id'>): Promise<SessionSender[]> {
  const rows = await env.DB.query<SenderRow>(`SELECT m.user_id, m.role, g.id AS group_id, g.tools_json, sg.permissions_json AS grants_json,
      (SELECT 1 FROM personal_workspaces p WHERE p.workspace_id = m.workspace_id AND p.user_id = m.user_id) AS personal
    FROM workspace_members m
    INNER JOIN users u ON u.id = m.user_id
    LEFT JOIN workspace_member_tool_groups a ON a.workspace_id = m.workspace_id AND a.user_id = m.user_id
    LEFT JOIN workspace_tool_groups g ON g.id = a.group_id AND g.workspace_id = m.workspace_id
    LEFT JOIN session_grants sg ON sg.session_id = ? AND sg.user_id = m.user_id
    WHERE m.workspace_id = ? AND (u.suspended_at IS NULL OR m.user_id = ?)`).bind(row.id, row.workspace_id, row.owner_id).all();
  return rows.map(member => {
    let tools: unknown = [];
    if (member.tools_json !== null) { try { tools = JSON.parse(member.tools_json); } catch { tools = []; } }
    const group = member.group_id !== null ? { tools: Array.isArray(tools) ? canonicalGroupTools(tools) : [] } : null;
    const owns = member.user_id === row.owner_id;
    const ceiling = roleSessionCeiling(member.role);
    const allowed = (permissions: readonly Permission[]) => hasPermission(permissions, 'write') && (!ceiling || ceiling.includes('write'));
    return { userId: member.user_id, role: member.role, tools: memberTools(member.role, group), groupId: member.group_id, personal: Boolean(member.personal),
      workspaceOwner: member.role === 'owner', owns, messages: owns || allowed(workspaceSessionPermissions(member.role)),
      granted: !owns && allowed(grantedPermissions(member.grants_json)) };
  });
}

export async function sessionBuildCachesFor(env: Env, row: Pick<SessionRow, 'id' | 'workspace_id' | 'owner_id'>, connectorId: string,
  senderId?: string | null): Promise<SessionBuildCaches> {
  const { buildCaches: mode } = await connectorHostConfig(env, connectorId);
  if (mode === 'off') return { caches: [] };
  const caches = await workspaceBuildCaches(env.DB, row.workspace_id);
  if (!caches.length) return { caches: [] };
  const people = await sessionSenders(env, row);
  const owner = people.find(person => person.owns);
  if (!owner) return { caches: [] };
  const granted = people.filter(person => person.granted);
  const outsider: BuildCacheSender = { role: null, tools: [], groupId: null, personal: false, workspaceOwner: false, owns: false };
  const senders: BuildCacheSenders = senderId === undefined ? { kind: 'unknown', possible: people.filter(person => person.messages || person.granted) }
    : senderId === null ? { kind: 'none' }
    : { kind: 'message', sender: people.find(person => person.userId === senderId) ?? outsider, granted };
  return sessionBuildCaches(owner, caches, mode, senders);
}

export function registerConnectorBuildCaches(app: Hono<AppEnv>): void {
  app.post('/api/connectors/self/build-caches', async c => {
    const connector = await authenticateConnector(c);
    const { sessionId, senderId } = await body(c, z.strictObject({ sessionId: z.string(), senderId: z.string().min(1).max(256).nullable().optional() }),
      { maxBytes: 1024, message: 'Name the session and, for a message\'s command, its sender.' });
    const row = await c.env.DB.query<SessionRow>('SELECT * FROM sessions WHERE id = ?').bind(identifier(sessionId, 'sessionId')).first();
    if (!row) fail(404, 'not_found', 'Session not found.');
    await requireCallbackScope(c, row, connector.id);
    return c.json(await sessionBuildCachesFor(c.env, row, connector.id, senderId));
  });
}

const cacheInput = z.strictObject({ env: z.string().max(64), writerGroups: z.array(z.string().max(128)).max(buildCacheLimits.writerGroups).optional() });

function parsedCache(name: string, input: unknown): BuildCache {
  try { return parseBuildCache(name, input); }
  catch (error) { return fail(400, 'invalid_build_cache', error instanceof Error ? error.message : 'Invalid build cache.'); }
}

export function registerBuildCaches(app: Hono<AppEnv>): void {
  app.get('/api/workspaces/:id/build-caches', async c => {
    const workspaceId = identifier(c.req.param('id'));
    const member = await requireMember(c.env, workspaceId, c.get('auth').userId);
    return c.json({ caches: await workspaceBuildCaches(c.env.DB, workspaceId), admin: member.role === 'owner' || member.role === 'admin',
      limits: { caches: buildCacheLimits.caches, writerGroups: buildCacheLimits.writerGroups } });
  });

  app.put('/api/workspaces/:id/build-caches/:name', async c => {
    const workspaceId = identifier(c.req.param('id'));
    const actor = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    let name: string;
    try { name = parseBuildCacheName(c.req.param('name')); }
    catch (error) { return fail(400, 'invalid_build_cache', error instanceof Error ? error.message : 'Invalid build cache.'); }
    const cache = parsedCache(name, await body(c, cacheInput, { maxBytes: 8 * 1024, message: 'A build cache has env and, optionally, writerGroups.' }));
    if (cache.writerGroups.length) {
      const known = await c.env.DB.query<{ id: string }>(`SELECT id FROM workspace_tool_groups WHERE workspace_id = ? AND id IN (${cache.writerGroups.map(() => '?').join(', ')})`)
        .bind(workspaceId, ...cache.writerGroups).all();
      const missing = cache.writerGroups.find(group => !known.some(row => row.id === group));
      if (missing) fail(400, 'invalid_build_cache', `${missing} isn't a tool group of this workspace.`);
    }
    const existing = await c.env.DB.query<{ name: string }>('SELECT name FROM workspace_build_caches WHERE workspace_id = ? AND name = ?').bind(workspaceId, name).first();
    const clash = await c.env.DB.query<{ name: string }>('SELECT name FROM workspace_build_caches WHERE workspace_id = ? AND env = ? AND name <> ?')
      .bind(workspaceId, cache.env, name).first();
    if (clash) fail(409, 'env_taken', `The build cache ${clash.name} already uses ${cache.env}.`);
    const at = now();
    const saved = await c.env.DB.query<{ name: string }>(`INSERT INTO workspace_build_caches (workspace_id, name, env, writer_groups_json, created_by, created_at, updated_by, updated_at)
      SELECT ?,?,?,?,?,?,?,? WHERE ${workspaceAdminSQL}
        AND (EXISTS (SELECT 1 FROM workspace_build_caches WHERE workspace_id = ? AND name = ?) OR (SELECT COUNT(*) FROM workspace_build_caches WHERE workspace_id = ?) < ?)
      ON CONFLICT (workspace_id, name) DO UPDATE SET env = excluded.env, writer_groups_json = excluded.writer_groups_json,
        updated_by = excluded.updated_by, updated_at = excluded.updated_at
      RETURNING name`).bind(workspaceId, name, cache.env, JSON.stringify(cache.writerGroups), actor, at, actor, at, workspaceId, actor,
      workspaceId, name, workspaceId, buildCacheLimits.caches).first().catch((error: unknown) => {
      if (error instanceof Error && /UNIQUE|unique|duplicate/.test(error.message)) fail(409, 'env_taken', `Another build cache already uses ${cache.env}.`);
      throw error;
    });
    if (!saved) {
      const admin = await c.env.DB.query<{ found: number }>(`SELECT 1 AS found WHERE ${workspaceAdminSQL}`).bind(workspaceId, actor).first();
      if (!admin) fail(403, 'forbidden', 'Workspace administrator access is required.');
      fail(409, 'build_cache_limit', `A workspace has at most ${buildCacheLimits.caches} build caches.`);
    }
    await auditStatement(c.env, actor, existing ? 'workspace.build_cache.updated' : 'workspace.build_cache.created', workspaceId, null,
      { name, env: cache.env, writerGroups: cache.writerGroups }).run();
    return c.json({ caches: await workspaceBuildCaches(c.env.DB, workspaceId), admin: true,
      limits: { caches: buildCacheLimits.caches, writerGroups: buildCacheLimits.writerGroups } }, existing ? 200 : 201);
  });

  app.delete('/api/workspaces/:id/build-caches/:name', async c => {
    const workspaceId = identifier(c.req.param('id'));
    const actor = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    let name: string;
    try { name = parseBuildCacheName(c.req.param('name')); }
    catch { return fail(404, 'not_found', 'Build cache not found.'); }
    const removed = await c.env.DB.query<{ name: string }>(`DELETE FROM workspace_build_caches WHERE workspace_id = ? AND name = ? AND ${workspaceAdminSQL} RETURNING name`)
      .bind(workspaceId, name, workspaceId, actor).first();
    if (!removed) fail(404, 'not_found', 'Build cache not found.');
    await auditStatement(c.env, actor, 'workspace.build_cache.deleted', workspaceId, null, { name }).run();
    return c.json({ caches: await workspaceBuildCaches(c.env.DB, workspaceId), admin: true,
      limits: { caches: buildCacheLimits.caches, writerGroups: buildCacheLimits.writerGroups } });
  });
}
