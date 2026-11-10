import type { Hono } from 'hono';
import { builtinExtensionNames, defaultHostConfig, hostConfigLimits, normalizeBuiltinExtensionNames, ownerOnlyHostConfig, parseBuiltinExtensions, parseHostCompaction,
  parseHostConfigChange, parseRequiredExtensions, type HostConfig, type RepositoryCacheMode } from '../../../packages/shared/src/host-config.js';
import { isPikiExtensionSource } from '../../../packages/shared/src/host-extensions.js';
import { defaultHostBrowserConfig, parseHostBrowserConfig } from '../../../packages/shared/src/browser.js';
import { defaultHostTunnelConfig, parseHostTunnelConfig } from '../../../packages/shared/src/tunnel.js';
import { pikiExtension } from '../../../packages/shared/src/piki-extensions.js';
import type { Env, AppEnv } from './types.js';
import { auditStatement, managedConnector } from './authority/index.js';
import { fail, jsonObject, now } from './http.js';

interface ConfigRow { command_timeout_seconds: number; gpu: number; git_credentials: number; repository_cache: RepositoryCacheMode; host_sessions: number; compaction_json: string;
  builtin_extensions_json: string; required_extensions_json: string; browser_json: string; service_lifetime_seconds: number; tunnel_json: string }

export async function connectorHostConfig(env: Env, connectorId: string): Promise<HostConfig> {
  const row = await env.DB.query<ConfigRow>(`SELECT command_timeout_seconds, gpu, git_credentials, repository_cache, host_sessions, compaction_json,
    builtin_extensions_json, required_extensions_json, browser_json, service_lifetime_seconds, tunnel_json FROM connector_configs WHERE connector_id = ?`).bind(connectorId).first();
  if (!row) return { ...defaultHostConfig, builtinExtensions: [], requiredExtensions: [], browser: { ...defaultHostBrowserConfig }, tunnel: { ...defaultHostTunnelConfig } };
  return { commandTimeoutSeconds: Number(row.command_timeout_seconds), gpu: Number(row.gpu) === 1,
    gitCredentials: Number(row.git_credentials) === 1, repositoryCache: row.repository_cache, hostSessions: Number(row.host_sessions) === 1,
    compaction: storedCompaction(row.compaction_json), builtinExtensions: storedBuiltinExtensions(row.builtin_extensions_json),
    requiredExtensions: storedRequiredExtensions(row.required_extensions_json), browser: storedBrowser(row.browser_json),
    serviceLifetimeSeconds: storedLifetime(row.service_lifetime_seconds), tunnel: storedTunnel(row.tunnel_json) };
}

function storedLifetime(value: number | string): number {
  const seconds = Number(value);
  const { min, max } = hostConfigLimits.serviceLifetimeSeconds;
  return Number.isSafeInteger(seconds) && seconds >= min && seconds <= max ? seconds : defaultHostConfig.serviceLifetimeSeconds;
}

function storedTunnel(json: string): HostConfig['tunnel'] {
  try { return parseHostTunnelConfig(JSON.parse(json)); }
  catch { return { ...defaultHostTunnelConfig }; }
}

function storedBrowser(json: string): HostConfig['browser'] {
  try { return parseHostBrowserConfig(JSON.parse(json)); }
  catch { return { ...defaultHostBrowserConfig }; }
}

function storedBuiltinExtensions(json: string): HostConfig['builtinExtensions'] {
  try {
    const names: unknown = JSON.parse(json);
    return Array.isArray(names) ? parseBuiltinExtensions(normalizeBuiltinExtensionNames(names).filter(name => (builtinExtensionNames as readonly unknown[]).includes(name))) : [];
  } catch { return []; }
}

function storedRequiredExtensions(json: string): HostConfig['requiredExtensions'] {
  let items: unknown;
  try { items = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(items)) return [];
  return items.flatMap(item => { try { return parseRequiredExtensions([item]); } catch { return []; } }).slice(0, hostConfigLimits.requiredExtensions);
}

function storedCompaction(json: string): HostConfig['compaction'] {
  try { return parseHostCompaction(JSON.parse(json)); }
  catch { return {}; }
}

const columns: Readonly<Record<keyof HostConfig, string>> = Object.freeze({ commandTimeoutSeconds: 'command_timeout_seconds', gpu: 'gpu',
  gitCredentials: 'git_credentials', repositoryCache: 'repository_cache', hostSessions: 'host_sessions', compaction: 'compaction_json',
  builtinExtensions: 'builtin_extensions_json', requiredExtensions: 'required_extensions_json', browser: 'browser_json',
  serviceLifetimeSeconds: 'service_lifetime_seconds', tunnel: 'tunnel_json' });

function upsert(settings: readonly (keyof HostConfig)[]): string {
  return `INSERT INTO connector_configs (connector_id, command_timeout_seconds, gpu, git_credentials, repository_cache, host_sessions, compaction_json,
    builtin_extensions_json, required_extensions_json, browser_json, service_lifetime_seconds, tunnel_json, updated_by, updated_at)
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM connectors WHERE id = ? AND revoked_at IS NULL AND removed_at IS NULL)
  ON CONFLICT (connector_id) DO UPDATE SET ${settings.map(key => `${columns[key]} = excluded.${columns[key]}, `).join('')}
    updated_by = excluded.updated_by, updated_at = excluded.updated_at
  RETURNING connector_id`;
}

export function registerHostConfig(app: Hono<AppEnv>): void {
  app.patch('/api/connectors/:id/config', async c => {
    const actorId = c.get('auth').userId;
    const row = await managedConnector(c);
    if (row.revoked_at) fail(409, 'connector_revoked', 'Connector is revoked.');
    let change: Partial<HostConfig>;
    try { change = parseHostConfigChange(await jsonObject(c, 131_072)); }
    catch (error) { return fail(400, 'invalid_host_config', error instanceof Error ? error.message : 'Invalid host configuration.'); }
    const unknown = change.requiredExtensions?.find(item => isPikiExtensionSource(item.source) && !pikiExtension(item.source));
    if (unknown) return fail(400, 'invalid_host_config', `${unknown.source} is not one of Pikibun's extensions.`);
    const sessionTools = change.requiredExtensions?.find(item => pikiExtension(item.source)?.sessionTools !== undefined);
    if (sessionTools) return fail(400, 'invalid_host_config', `${sessionTools.source} offers tools every session has unless its workspace turns them off; a host can't require it.`);
    const current = await connectorHostConfig(c.env, row.id);
    let settings = Object.keys(change) as (keyof HostConfig)[];
    if (row.role !== 'owner') {
      if (settings.some(key => ownerOnlyHostConfig.includes(key) && JSON.stringify(change[key]) !== JSON.stringify(current[key]))) {
        fail(403, 'host_owner_required', 'Only the host\'s owner decides whether it uses its Git credentials, keeps a repository cache, runs sessions without the sandbox, requires extensions of every session on it, where its browser comes from or whether its sessions may put servers online through tunnels.');
      }
      settings = settings.filter(key => !ownerOnlyHostConfig.includes(key));
      if (!settings.length) return c.json({ config: current });
    }
    const config: HostConfig = { ...current, ...Object.fromEntries(settings.map(key => [key, change[key]])) };
    const saved = await c.env.DB.query(upsert(settings))
      .bind(row.id, config.commandTimeoutSeconds, config.gpu ? 1 : 0, config.gitCredentials ? 1 : 0, config.repositoryCache, config.hostSessions ? 1 : 0,
        JSON.stringify(config.compaction), JSON.stringify(config.builtinExtensions), JSON.stringify(config.requiredExtensions), JSON.stringify(config.browser),
        config.serviceLifetimeSeconds, JSON.stringify(config.tunnel), actorId, now(), row.id).first();
    if (!saved) fail(409, 'connector_revoked', 'Connector is revoked.');
    const effective = await connectorHostConfig(c.env, row.id);
    await auditStatement(c.env, actorId, 'host.config.updated', null, null, { connectorId: row.id, ...effective }).run();
    return c.json({ config: effective });
  });
}
