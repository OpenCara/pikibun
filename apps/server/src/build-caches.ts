import type { Hono } from 'hono';
import { z } from 'zod';
import {
  buildCacheLimits, parseBuildCache, parseBuildCacheName, sessionBuildCaches, type BuildCache, type BuildCacheWriter, type SessionBuildCaches, type StoredBuildCache,
} from '../../../packages/shared/src/build-caches.js';
import { canonicalGroupTools, memberTools } from '../../../packages/shared/src/tool-groups.js';
import type { WorkspaceRole } from '../../../packages/shared/src/types.js';
import type { Database } from './db/types.js';
import { auditStatement, authenticateConnector, isPersonalWorkspace, requireCallbackScope, requireMember, workspaceAdminSQL } from './authority/index.js';
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

type WriterRow = { role: WorkspaceRole; group_id: string | null; tools_json: string | null };

export async function buildCacheWriter(env: Env, workspaceId: string, userId: string): Promise<BuildCacheWriter> {
  const row = await env.DB.query<WriterRow>(`SELECT m.role, g.id AS group_id, g.tools_json FROM workspace_members m
    LEFT JOIN workspace_member_tool_groups a ON a.workspace_id = m.workspace_id AND a.user_id = m.user_id
    LEFT JOIN workspace_tool_groups g ON g.id = a.group_id AND g.workspace_id = m.workspace_id
    WHERE m.workspace_id = ? AND m.user_id = ?`).bind(workspaceId, userId).first();
  if (!row) return { role: null, tools: [], groupId: null, personal: false, workspaceOwner: false };
  let tools: unknown = [];
  if (row.tools_json !== null) { try { tools = JSON.parse(row.tools_json); } catch { tools = []; } }
  const group = row.group_id !== null ? { tools: Array.isArray(tools) ? canonicalGroupTools(tools) : [] } : null;
  return { role: row.role, tools: memberTools(row.role, group), groupId: row.group_id, personal: await isPersonalWorkspace(env, workspaceId, userId),
    workspaceOwner: row.role === 'owner' };
}

export async function sessionBuildCachesFor(env: Env, row: Pick<SessionRow, 'workspace_id' | 'owner_id'>, connectorId: string): Promise<SessionBuildCaches> {
  const { buildCaches: mode } = await connectorHostConfig(env, connectorId);
  if (mode === 'off') return { caches: [] };
  const caches = await workspaceBuildCaches(env.DB, row.workspace_id);
  if (!caches.length) return { caches: [] };
  return sessionBuildCaches(await buildCacheWriter(env, row.workspace_id, row.owner_id), caches, mode);
}

export function registerConnectorBuildCaches(app: Hono<AppEnv>): void {
  app.post('/api/connectors/self/build-caches', async c => {
    const connector = await authenticateConnector(c);
    const { sessionId } = await body(c, z.strictObject({ sessionId: z.string() }), { maxBytes: 1024, message: 'Name the session.' });
    const row = await c.env.DB.query<SessionRow>('SELECT * FROM sessions WHERE id = ?').bind(identifier(sessionId, 'sessionId')).first();
    if (!row) fail(404, 'not_found', 'Session not found.');
    await requireCallbackScope(c, row, connector.id);
    return c.json(await sessionBuildCachesFor(c.env, row, connector.id));
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
