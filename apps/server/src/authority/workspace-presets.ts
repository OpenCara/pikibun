import type { Hono } from 'hono';
import { z } from 'zod';
import { defaultExtensionIntegrity, defaultWorkspaceExtensions, extensionLimits, extensionPackageKey } from '../../../../packages/shared/src/host-extensions.js';
import { packageRegistryDomains } from '../../../../packages/shared/src/network.js';
import { defaultWorkspacePreset, isWorkspacePreset, workspacePreset, workspacePresets, type WorkspacePreset } from '../../../../packages/shared/src/workspace-presets.js';
import type { Database, Query } from '../db/types.js';
import type { AppEnv, Env } from '../types.js';
import { fail, identifier, now } from '../http.js';
import { body } from '../schemas.js';
import { requireMember, workspaceAdminSQL } from './access.js';
import { auditStatement } from './audit.js';
import { sessionToolSources, workspaceExtensions } from './extension-policy.js';
import { memberGitHubReach } from './github-reach.js';
import { workspaceNetworkPolicy } from './network.js';

export function presetInput(value: unknown): WorkspacePreset {
  if (value === undefined) return defaultWorkspacePreset;
  if (!isWorkspacePreset(value)) fail(400, 'invalid_input', `preset is one of ${workspacePresets.join(', ')}.`);
  return value;
}

export function presetExtensionEnabled(preset: WorkspacePreset, source: string): boolean {
  return workspacePreset(preset).extensions.includes(source);
}

export function newWorkspacePresetStatements(db: Pick<Database, 'query'>, workspaceId: string, ownerId: string, at: string, preset: WorkspacePreset): Query<never>[] {
  if (preset === defaultWorkspacePreset) return [];
  const chosen = workspacePreset(preset);
  return [
    db.query<never>(`INSERT INTO workspace_network_policies (workspace_id, mode, domains_json, package_registries, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(workspaceId, chosen.network.mode, JSON.stringify(chosen.network.domains), chosen.network.packageRegistries ? 1 : 0, ownerId, at),
    db.query<never>('INSERT INTO member_github_reach (workspace_id, user_id, any_repository, updated_at) VALUES (?, ?, ?, ?)')
      .bind(workspaceId, ownerId, chosen.githubReach ? 1 : 0, at),
  ];
}

function applyStatements(env: Env, workspaceId: string, actorId: string, at: string, preset: WorkspacePreset): Query<never>[] {
  const chosen = workspacePreset(preset);
  const db = env.DB;
  const kept = chosen.extensions.map(extensionPackageKey);
  const turnOff = preset === 'open' ? []
    : preset === 'balanced' ? [db.query<never>(`UPDATE workspace_extensions SET enabled = 0, updated_by = ?, updated_at = ?
        WHERE workspace_id = ? AND enabled = 1 AND (source LIKE 'npm:%' OR source LIKE 'git:%') AND ${workspaceAdminSQL}`).bind(actorId, at, workspaceId, workspaceId, actorId)]
    : [db.query<never>(`UPDATE workspace_extensions SET enabled = 0, updated_by = ?, updated_at = ?
        WHERE workspace_id = ? AND enabled = 1 AND package_key NOT IN (${kept.map(() => '?').join(', ')}) AND ${workspaceAdminSQL}`)
      .bind(actorId, at, workspaceId, ...kept, workspaceId, actorId)];
  return [
    db.query<never>(`INSERT INTO workspace_network_policies (workspace_id, mode, domains_json, package_registries, updated_by, updated_at)
      SELECT ?, ?, ?, ?, ?, ? WHERE ${workspaceAdminSQL}
      ON CONFLICT (workspace_id) DO UPDATE SET mode = excluded.mode, domains_json = excluded.domains_json,
        package_registries = excluded.package_registries, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .bind(workspaceId, chosen.network.mode, JSON.stringify(chosen.network.domains), chosen.network.packageRegistries ? 1 : 0, actorId, at, workspaceId, actorId),
    db.query<never>(`INSERT INTO member_github_reach (workspace_id, user_id, any_repository, updated_at)
      SELECT ?, ?, ?, ? WHERE ${workspaceAdminSQL}
      ON CONFLICT (workspace_id, user_id) DO UPDATE SET any_repository = excluded.any_repository, updated_at = excluded.updated_at`)
      .bind(workspaceId, actorId, chosen.githubReach ? 1 : 0, at, workspaceId, actorId),
    ...turnOff,
    ...defaultWorkspaceExtensions.filter(source => chosen.extensions.includes(source)).map(source => db.query<never>(`INSERT INTO workspace_extensions
        (workspace_id, package_key, source, position, enabled, tools_mode, settings_json, integrity, updated_by, updated_at)
      SELECT ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM workspace_extensions WHERE workspace_id = ?), 1, 'automatic', '{}', ?, ?, ? WHERE ${workspaceAdminSQL}
      ON CONFLICT (workspace_id, package_key) DO UPDATE SET enabled = 1,
        integrity = CASE WHEN workspace_extensions.source = excluded.source THEN COALESCE(workspace_extensions.integrity, excluded.integrity) ELSE workspace_extensions.integrity END,
        updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .bind(workspaceId, extensionPackageKey(source), source, workspaceId, defaultExtensionIntegrity[source] ?? null, actorId, at, workspaceId, actorId)),
    auditStatement(env, actorId, 'workspace.preset.applied', workspaceId, null, { preset, network: chosen.network.mode, githubReach: chosen.githubReach, extensions: [...chosen.extensions] }),
  ];
}

export function registerWorkspacePresets(app: Hono<AppEnv>): void {
  app.post('/api/workspaces/:id/preset', async c => {
    const workspaceId = identifier(c.req.param('id'));
    const actorId = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actorId, ['owner', 'admin']);
    const { preset } = await body(c, z.strictObject({ preset: z.enum(workspacePresets) }), { maxBytes: 1024, message: `preset is one of ${workspacePresets.join(', ')}.` });
    const listed = await c.env.DB.query<{ package_key: string }>('SELECT package_key FROM workspace_extensions WHERE workspace_id = ?').bind(workspaceId).all();
    const taking = (key: string) => !sessionToolSources.includes(key);
    const has = new Set(listed.map(row => row.package_key));
    const added = workspacePreset(preset).extensions.map(extensionPackageKey).filter(key => taking(key) && !has.has(key));
    if (added.length && [...has].filter(taking).length + added.length > extensionLimits.workspace) {
      fail(409, 'extension_limit', `This workspace has ${[...has].filter(taking).length} of its ${extensionLimits.workspace} extensions, and this preset adds ${added.join(', ')}. Remove ${added.length === 1 ? 'one' : 'some'} first.`);
    }
    await c.env.DB.batch(applyStatements(c.env, workspaceId, actorId, now(), preset));
    await requireMember(c.env, workspaceId, actorId, ['owner', 'admin']);
    return c.json({ preset, policy: await workspaceNetworkPolicy(c.env.DB, workspaceId), packageRegistryDomains,
      githubReach: await memberGitHubReach(c.env.DB, workspaceId, actorId), extensions: await workspaceExtensions(c.env, workspaceId) });
  });
}
