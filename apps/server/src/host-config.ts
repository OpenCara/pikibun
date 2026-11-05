import type { Hono } from 'hono';
import { builtinExtensionNames, defaultHostConfig, hostConfigLimits, normalizeBuiltinExtensionNames, ownerOnlyHostConfig, parseBuiltinExtensions, parseHostCompaction,
  parseHostConfigChange, parseRequiredExtensions, type HostConfig, type RepositoryCacheMode } from '../../../packages/shared/src/host-config.js';
import { isPikiExtensionSource } from '../../../packages/shared/src/host-extensions.js';
import { defaultHostBrowserConfig, parseHostBrowserConfig } from '../../../packages/shared/src/browser.js';
import { pikiExtension } from '../../../packages/shared/src/piki-extensions.js';
import type { Env, WorkerEnv } from './types.js';
import { auditStatement, managedConnector } from './authority/index.js';
import { fail, jsonObject, now } from './http.js';

/*
 * How a host runs its sessions (HostConfig): its command time limit, whether sandboxed commands get its GPU, whether
 * pushes in its owner's sessions may use its Git credentials, its repository cache, whether its owner's sessions may
 * run directly on it, without the sandbox, when its long conversations are summarized (compaction), and which of Pi's
 * built-in extensions its sessions run (builtinExtensions), the extensions it requires of every session on it
 * (requiredExtensions), and where the browser tool's Chromium comes from (browser). Its owner sets them here, as do its
 * admins, except the ones that decide whose credentials the host uses, what runs on it unsandboxed, what every session on
 * it must run, and which of its files sessions get. Connectors read them back (`/api/connectors/self/config`)
 * instead of taking connect options.
 */

interface ConfigRow { command_timeout_seconds: number; gpu: number; git_credentials: number; repository_cache: RepositoryCacheMode; host_sessions: number; compaction_json: string;
  builtin_extensions_json: string; required_extensions_json: string; browser_json: string }

/** The configuration of `connectorId`; the defaults until its owner or an admin changes one. */
export async function connectorHostConfig(env: Env, connectorId: string): Promise<HostConfig> {
  const row = await env.DB.query<ConfigRow>(`SELECT command_timeout_seconds, gpu, git_credentials, repository_cache, host_sessions, compaction_json,
    builtin_extensions_json, required_extensions_json, browser_json FROM connector_configs WHERE connector_id = ?`).bind(connectorId).first();
  if (!row) return { ...defaultHostConfig, builtinExtensions: [], requiredExtensions: [], browser: { ...defaultHostBrowserConfig } };
  return { commandTimeoutSeconds: Number(row.command_timeout_seconds), gpu: Number(row.gpu) === 1,
    gitCredentials: Number(row.git_credentials) === 1, repositoryCache: row.repository_cache, hostSessions: Number(row.host_sessions) === 1,
    compaction: storedCompaction(row.compaction_json), builtinExtensions: storedBuiltinExtensions(row.builtin_extensions_json),
    requiredExtensions: storedRequiredExtensions(row.required_extensions_json), browser: storedBrowser(row.browser_json) };
}

/** The saved browser setting; one that no longer reads as valid (a database edited by hand, say) looks for one, as by default. */
function storedBrowser(json: string): HostConfig['browser'] {
  try { return parseHostBrowserConfig(JSON.parse(json)); }
  catch { return { ...defaultHostBrowserConfig }; }
}

/** The saved built-in extensions, those this control plane still ships; one that no longer reads as valid is none. */
function storedBuiltinExtensions(json: string): HostConfig['builtinExtensions'] {
  try {
    const names: unknown = JSON.parse(json);
    return Array.isArray(names) ? parseBuiltinExtensions(normalizeBuiltinExtensionNames(names).filter(name => (builtinExtensionNames as readonly unknown[]).includes(name))) : [];
  } catch { return []; }
}

/**
 * The saved required extensions. Each one that still reads as valid stays required, even when another doesn't (a
 * database edited by hand, say): they guard the host's sessions, so none is dropped for another's sake.
 */
function storedRequiredExtensions(json: string): HostConfig['requiredExtensions'] {
  let items: unknown;
  try { items = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(items)) return [];
  return items.flatMap(item => { try { return parseRequiredExtensions([item]); } catch { return []; } }).slice(0, hostConfigLimits.requiredExtensions);
}

/** The saved compaction setting; one that no longer reads as valid (a database edited by hand, say) is none. */
function storedCompaction(json: string): HostConfig['compaction'] {
  try { return parseHostCompaction(JSON.parse(json)); }
  catch { return {}; }
}

/** Each setting's column; the only names `upsert` puts in its SQL. */
const columns: Readonly<Record<keyof HostConfig, string>> = Object.freeze({ commandTimeoutSeconds: 'command_timeout_seconds', gpu: 'gpu',
  gitCredentials: 'git_credentials', repositoryCache: 'repository_cache', hostSessions: 'host_sessions', compaction: 'compaction_json',
  builtinExtensions: 'builtin_extensions_json', requiredExtensions: 'required_extensions_json', browser: 'browser_json' });

/**
 * Saves a change of `settings`. A host with no configuration yet gets a whole one: the change over what it had (the
 * defaults). A host with one gets only those settings, so a concurrent change of another setting stays: an admin's
 * write, which never names the owner's settings, never touches them.
 */
function upsert(settings: readonly (keyof HostConfig)[]): string {
  return `INSERT INTO connector_configs (connector_id, command_timeout_seconds, gpu, git_credentials, repository_cache, host_sessions, compaction_json,
    builtin_extensions_json, required_extensions_json, browser_json, updated_by, updated_at)
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM connectors WHERE id = ? AND revoked_at IS NULL AND removed_at IS NULL)
  ON CONFLICT (connector_id) DO UPDATE SET ${settings.map(key => `${columns[key]} = excluded.${columns[key]}, `).join('')}
    updated_by = excluded.updated_by, updated_at = excluded.updated_at
  RETURNING connector_id`;
}

export function registerHostConfig(app: Hono<WorkerEnv>): void {
  // The settings to change, as the host's page sends what its user changed; the rest keep their values. Compaction is
  // one setting, sent whole. Applying them is the connector's: it reads them within a minute.
  app.patch('/api/connectors/:id/config', async c => {
    const actorId = c.get('auth').userId;
    const row = await managedConnector(c);
    if (row.revoked_at) fail(409, 'connector_revoked', 'Connector is revoked.');
    let change: Partial<HostConfig>;
    // Room for compaction counts of the most models, with the longest names a host advertises (about 67 KB).
    try { change = parseHostConfigChange(await jsonObject(c, 131_072)); }
    catch (error) { return fail(400, 'invalid_host_config', error instanceof Error ? error.message : 'Invalid host configuration.'); }
    // A Pikibun extension it requires is one this control plane knows: a misspelt one would hold every session.
    const unknown = change.requiredExtensions?.find(item => isPikiExtensionSource(item.source) && !pikiExtension(item.source));
    if (unknown) return fail(400, 'invalid_host_config', `${unknown.source} is not one of Pikibun's extensions.`);
    // A session-tool extension only lets a workspace turn its tools off: requiring it of a host means nothing.
    const sessionTools = change.requiredExtensions?.find(item => pikiExtension(item.source)?.sessionTools !== undefined);
    if (sessionTools) return fail(400, 'invalid_host_config', `${sessionTools.source} offers tools every session has unless its workspace turns them off; a host can't require it.`);
    const current = await connectorHostConfig(c.env, row.id);
    let settings = Object.keys(change) as (keyof HostConfig)[];
    if (row.role !== 'owner') {
      // An admin may name one of the owner's settings only as it is: changing it is the owner's.
      if (settings.some(key => ownerOnlyHostConfig.includes(key) && JSON.stringify(change[key]) !== JSON.stringify(current[key]))) {
        fail(403, 'host_owner_required', 'Only the host\'s owner decides whether it uses its Git credentials, keeps a repository cache, runs sessions without the sandbox, requires extensions of every session on it or where its browser comes from.');
      }
      settings = settings.filter(key => !ownerOnlyHostConfig.includes(key));
      if (!settings.length) return c.json({ config: current });
    }
    const config: HostConfig = { ...current, ...Object.fromEntries(settings.map(key => [key, change[key]])) };
    const saved = await c.env.DB.query(upsert(settings))
      .bind(row.id, config.commandTimeoutSeconds, config.gpu ? 1 : 0, config.gitCredentials ? 1 : 0, config.repositoryCache, config.hostSessions ? 1 : 0,
        JSON.stringify(config.compaction), JSON.stringify(config.builtinExtensions), JSON.stringify(config.requiredExtensions), JSON.stringify(config.browser),
        actorId, now(), row.id).first();
    if (!saved) fail(409, 'connector_revoked', 'Connector is revoked.');
    const effective = await connectorHostConfig(c.env, row.id);
    await auditStatement(c.env, actorId, 'host.config.updated', null, null, { connectorId: row.id, ...effective }).run();
    return c.json({ config: effective });
  });
}
