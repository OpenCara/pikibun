import type { Hono } from 'hono';
import { hasPermission } from '../../../packages/shared/src/policy.js';
import type { ConnectorCapabilities } from '../../../packages/shared/src/connector.js';
import { legacyWebSearchProviders, webLimits, webSearchCount, webSearchKey, webSearchProviderNames, webSearchProviders, webSearchQuery, workspaceWebSearchProviders,
  type WebSearchHit, type WebSearchProvider, type WebSearchResult, type WorkspaceWebSearch, type WorkspaceWebSearchProvider } from '../../../packages/shared/src/web.js';
import type { AppContext, Env, SessionRow, WorkerEnv } from './types.js';
import { auditStatement, requireMember, sessionAccess } from './db.js';
import { fail, identifier, jsonObject, now, text, userIdentifier } from './http.js';
import { requireCallbackScope } from './connectors.js';
import { requireToolCall } from './approval-reviews.js';
import { boundedJson } from './github-broker.js';
import { workspaceNetworkPolicy } from './network.js';
import { assertVaultConfigured, decryptToken, encryptToken } from './vault.js';

/*
 * The agent's web_search tool: the control plane searches for a tool call of a write message the requester sent within
 * the last hour, where the session's workspace turned web search on under its network access, with the provider the
 * workspace's owners and admins chose and their API key (workspace_web_search), else the one the server's operator
 * configured (WEB_SEARCH). Keys never leave the server; hosts and sandboxes see only results.
 */

const SEARCH_TIMEOUT_MS = 20_000;
/** One provider answer; even 20 results with long snippets stay far below this. */
const RESPONSE_BYTES = 2 * 1024 * 1024;

export interface WebSearchBackend {
  name: WebSearchProvider;
  search: (query: string, count: number) => Promise<WebSearchHit[]>;
}

/** A provider's search with its key (and, for SearXNG, its instance), or undefined when either is missing. */
function searchBackend(name: WebSearchProvider, key: string | undefined, url?: string): WebSearchBackend | undefined {
  switch (name) {
    case 'brave': return key ? { name, search: (query, count) => brave(key, query, count) } : undefined;
    case 'tavily': return key ? { name, search: (query, count) => tavily(key, query, count) } : undefined;
    case 'exa': return key ? { name, search: (query, count) => exa(key, query, count) } : undefined;
    case 'serper': return key ? { name, search: (query, count) => serper(key, query, count) } : undefined;
    case 'searxng': {
      const base = searxngBase(url);
      return base ? { name, search: (query, count) => searxng(base, key, query, count) } : undefined;
    }
  }
}

/**
 * The search provider the operator configured: WEB_SEARCH names it (`brave`, `tavily`, `exa`, `serper` or `searxng`;
 * unset or `off`: none), WEB_SEARCH_API_KEY holds its key, and WEB_SEARCH_URL a SearXNG instance's origin, with its JSON
 * output on. Anything incomplete counts as none; loadConfig refuses it at start-up. Workspaces may choose their own.
 */
export function webSearchProvider(env: Env): WebSearchBackend | undefined {
  const name = env.WEB_SEARCH?.trim().toLowerCase();
  if (!name || name === 'off' || !webSearchProviders.includes(name as WebSearchProvider)) return undefined;
  return searchBackend(name as WebSearchProvider, env.WEB_SEARCH_API_KEY?.trim() || undefined, env.WEB_SEARCH_URL);
}

interface WorkspaceSearchRow { provider: WorkspaceWebSearchProvider; key_ciphertext: string; updated_by: string; updated_at: string }

/** The vault's associated data for a workspace's search key: it decrypts only as that workspace's. */
const keyContext = (workspaceId: string) => `workspace-web-search:${workspaceId}`;
const adminSql = `EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND role IN ('owner','admin'))`;

async function workspaceSearchRow(env: Env, workspaceId: string): Promise<WorkspaceSearchRow | null> {
  return env.DB.query<WorkspaceSearchRow>('SELECT provider, key_ciphertext, updated_by, updated_at FROM workspace_web_search WHERE workspace_id = ?')
    .bind(workspaceId).first();
}

/** The provider a workspace's searches use: its own, where its owners and admins chose one, else the server's. */
export async function workspaceSearchBackend(env: Env, workspaceId: string): Promise<WebSearchBackend | undefined> {
  const row = await workspaceSearchRow(env, workspaceId);
  if (!row) return webSearchProvider(env);
  return searchBackend(row.provider, await decryptToken(env, keyContext(workspaceId), row.key_ciphertext));
}

/** The name of the provider a workspace's searches use, for its settings pages, without decrypting its key. */
export async function workspaceSearchProviderName(env: Env, workspaceId: string): Promise<WebSearchProvider | null> {
  return (await workspaceSearchRow(env, workspaceId))?.provider ?? webSearchProvider(env)?.name ?? null;
}

async function workspaceWebSearch(env: Env, workspaceId: string): Promise<WorkspaceWebSearch> {
  const row = await workspaceSearchRow(env, workspaceId);
  return { provider: row?.provider ?? null, updatedBy: row?.updated_by ?? null, updatedAt: row?.updated_at ?? null, serverProvider: webSearchProvider(env)?.name ?? null };
}

/**
 * A workspace's search provider. Every member sees which provider it is, never its key; owners and admins choose one with
 * its API key, which the vault keeps, or go back to the server's.
 */
export function registerWorkspaceWebSearch(app: Hono<WorkerEnv>): void {
  app.get('/api/workspaces/:id/web-search', async c => {
    const workspaceId = identifier(c.req.param('id'));
    await requireMember(c.env, workspaceId, c.get('auth').userId);
    return c.json({ settings: await workspaceWebSearch(c.env, workspaceId) });
  });
  app.put('/api/workspaces/:id/web-search', async c => {
    const workspaceId = identifier(c.req.param('id')); const actor = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    const input = await jsonObject(c, 4096);
    if (Object.keys(input).some(key => key !== 'provider' && key !== 'apiKey')) fail(400, 'invalid_input', 'Send provider and apiKey.');
    if (!workspaceWebSearchProviders.includes(input.provider as WorkspaceWebSearchProvider)) {
      fail(400, 'invalid_input', `Choose one of ${workspaceWebSearchProviders.map(name => webSearchProviderNames[name]).join(', ')}.`);
    }
    const provider = input.provider as WorkspaceWebSearchProvider;
    let key: string;
    try { key = webSearchKey(input.apiKey); }
    catch (error) { fail(400, 'invalid_input', error instanceof Error ? error.message : 'Invalid API key.'); }
    await assertVaultConfigured(c.env);
    const ciphertext = await encryptToken(c.env, keyContext(workspaceId), key);
    const saved = await c.env.DB.query<{ workspace_id: string }>(`INSERT INTO workspace_web_search (workspace_id, provider, key_ciphertext, updated_by, updated_at)
      SELECT ?,?,?,?,? WHERE ${adminSql}
      ON CONFLICT (workspace_id) DO UPDATE SET provider = excluded.provider, key_ciphertext = excluded.key_ciphertext,
        updated_by = excluded.updated_by, updated_at = excluded.updated_at WHERE ${adminSql}
      RETURNING workspace_id`).bind(workspaceId, provider, ciphertext, actor, now(), workspaceId, actor, workspaceId, actor).first();
    if (!saved) fail(403, 'forbidden', 'Workspace administrator access is required.');
    await auditStatement(c.env, actor, 'workspace.web_search.updated', workspaceId, null, { provider }).run();
    return c.json({ settings: await workspaceWebSearch(c.env, workspaceId) });
  });
  // Back to the server's provider, if it has one; the key is deleted.
  app.delete('/api/workspaces/:id/web-search', async c => {
    const workspaceId = identifier(c.req.param('id')); const actor = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    const removed = await c.env.DB.query<{ provider: string }>(`DELETE FROM workspace_web_search WHERE workspace_id = ? AND ${adminSql} RETURNING provider`)
      .bind(workspaceId, workspaceId, actor).first();
    if (removed) await auditStatement(c.env, actor, 'workspace.web_search.removed', workspaceId, null, { provider: removed.provider }).run();
    return c.json({ settings: await workspaceWebSearch(c.env, workspaceId) });
  });
}

/** Whether the connector that asks understands every provider's name in a result; older ones knew only legacyWebSearchProviders. */
async function connectorKnowsProvider(env: Env, connectorId: string | null, provider: WebSearchProvider): Promise<boolean> {
  if (!connectorId || legacyWebSearchProviders.includes(provider)) return true;
  const host = await env.DB.query<{ capabilities_json: string }>('SELECT capabilities_json FROM connectors WHERE id = ?').bind(connectorId).first();
  try { return (JSON.parse(host?.capabilities_json ?? '{}') as ConnectorCapabilities).webSearchProviders === true; }
  catch { return false; }
}

/** The WEB_SEARCH settings' problem, for loadConfig, or undefined when they are complete (or off). */
export function webSearchConfigurationError(env: Pick<Env, 'WEB_SEARCH' | 'WEB_SEARCH_API_KEY' | 'WEB_SEARCH_URL'>): string | undefined {
  const name = env.WEB_SEARCH?.trim().toLowerCase();
  if (!name || name === 'off') return undefined;
  if (!webSearchProviders.includes(name as WebSearchProvider)) return `WEB_SEARCH must be "off", ${webSearchProviders.map(provider => `"${provider}"`).join(', ')}.`;
  if (name === 'searxng') return searxngBase(env.WEB_SEARCH_URL) ? undefined : 'WEB_SEARCH=searxng needs WEB_SEARCH_URL, the origin of a SearXNG instance such as https://search.example.com.';
  return env.WEB_SEARCH_API_KEY?.trim() ? undefined : `WEB_SEARCH=${name} needs WEB_SEARCH_API_KEY, the provider's API key.`;
}

function searxngBase(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value.trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return undefined;
    return url.href.replace(/\/+$/, '');
  } catch { return undefined; }
}

/** Plain text of a provider's snippet or title: markup and entities out, whitespace collapsed, within `limit`. */
function plain(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  // Cut down first, and a tag never runs past the next `<`: a provider's field costs time in proportion to the limit.
  const textValue = value.slice(0, limit * 4).replace(/<[^<>]*>/g, '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|#39);/gi, (_match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith('#x')) return safeCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith('#')) return safeCodePoint(Number.parseInt(lower.slice(1), 10));
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[lower] ?? '';
  }).replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return textValue.length > limit ? `${textValue.slice(0, limit - 1)}…` : textValue;
}

function safeCodePoint(code: number): string {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : '';
}

/** A result's URL, only when it is http(s) and within the limit; anything else drops the result. */
function resultUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > webLimits.urlLength) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch { return undefined; }
}

function hits(items: unknown, count: number, fields: { title: string; url: string; snippet: string; published?: string }): WebSearchHit[] {
  if (!Array.isArray(items)) return [];
  const results: WebSearchHit[] = [];
  for (const item of items) {
    if (results.length >= count) break;
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const url = resultUrl(record[fields.url]);
    if (!url) continue;
    const published = fields.published ? plain(record[fields.published], 100) : '';
    results.push({ title: plain(record[fields.title], webLimits.titleLength) || url, url, snippet: plain(record[fields.snippet], webLimits.snippetLength),
      ...(published ? { published } : {}) });
  }
  return results;
}

async function providerJson(provider: WebSearchProvider, url: string, init: RequestInit): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
  } catch {
    fail(502, 'web_search_unavailable', `The search provider (${provider}) could not be reached. Try again later.`);
  }
  if (response.status === 429) {
    await response.body?.cancel().catch(() => {});
    fail(429, 'web_search_rate_limited', `The search provider (${provider}) is rate limiting searches. Try again later.`);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    fail(502, 'web_search_failed', `The search provider (${provider}) refused the search (HTTP ${response.status}).`);
  }
  let value: unknown;
  try { value = await boundedJson(response, RESPONSE_BYTES); }
  catch { fail(502, 'web_search_failed', `The search provider (${provider}) sent an answer Pikibun could not read.`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(502, 'web_search_failed', `The search provider (${provider}) sent an answer Pikibun could not read.`);
  return value as Record<string, unknown>;
}

async function brave(key: string, query: string, count: number): Promise<WebSearchHit[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q: query, count: String(count) })}`;
  const value = await providerJson('brave', url, { headers: { Accept: 'application/json', 'X-Subscription-Token': key } });
  const web = value.web && typeof value.web === 'object' ? (value.web as Record<string, unknown>).results : undefined;
  return hits(web, count, { title: 'title', url: 'url', snippet: 'description', published: 'age' });
}

async function tavily(key: string, query: string, count: number): Promise<WebSearchHit[]> {
  const value = await providerJson('tavily', 'https://api.tavily.com/search', {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, max_results: count, search_depth: 'basic' }),
  });
  return hits(value.results, count, { title: 'title', url: 'url', snippet: 'content', published: 'published_date' });
}

async function exa(key: string, query: string, count: number): Promise<WebSearchHit[]> {
  const value = await providerJson('exa', 'https://api.exa.ai/search', {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ query, numResults: count, contents: { text: { maxCharacters: webLimits.snippetLength } } }),
  });
  return hits(value.results, count, { title: 'title', url: 'url', snippet: 'text', published: 'publishedDate' });
}

async function serper(key: string, query: string, count: number): Promise<WebSearchHit[]> {
  const value = await providerJson('serper', 'https://google.serper.dev/search', {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-API-KEY': key },
    body: JSON.stringify({ q: query, num: count }),
  });
  return hits(value.organic, count, { title: 'title', url: 'link', snippet: 'snippet', published: 'date' });
}

async function searxng(base: string, key: string | undefined, query: string, count: number): Promise<WebSearchHit[]> {
  const value = await providerJson('searxng', `${base}/search?${new URLSearchParams({ q: query, format: 'json' })}`, {
    headers: { Accept: 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
  });
  return hits(value.results, count, { title: 'title', url: 'url', snippet: 'content', published: 'publishedDate' });
}

/**
 * Searches the web for a web_search call of a write message the requester sent within the last hour, where the
 * session's workspace turned web search on. Each search is audited, with its query.
 */
export async function webSearch(c: AppContext, connectorId: string | null): Promise<Response> {
  const input = await jsonObject(c, 4096);
  if (Object.keys(input).some(key => !['sessionId', 'actorId', 'admissionId', 'callId', 'query', 'count'].includes(key))) {
    fail(400, 'invalid_input', 'Unexpected web search field.');
  }
  const sessionId = identifier(input.sessionId, 'sessionId');
  const actorId = userIdentifier(input.actorId, 'actorId');
  const admissionId = text(input.admissionId, 'admissionId', 128);
  const callId = identifier(input.callId, 'callId');
  let query: string; let count: number;
  try { query = webSearchQuery(input.query); count = webSearchCount(input.count); }
  catch (error) { fail(400, 'invalid_input', error instanceof Error ? error.message : 'Invalid web search.'); }
  // Every authority check, repeated after the search and before its results leave the control plane.
  const authorize = async (): Promise<SessionRow> => {
    const access = await sessionAccess(c.env, sessionId, actorId);
    if (!access || access.row.status === 'archived' || !hasPermission(access.permissions, 'write')) {
      fail(403, 'permission_revoked', 'The requester can no longer write to this session.');
    }
    await requireCallbackScope(c, access.row, connectorId);
    const admission = await c.env.DB.query<{ id: string; session_id: string; actor_id: string; mode: string; access: string | null; expires_at: number }>(
      'SELECT id, session_id, actor_id, mode, access, expires_at FROM run_admissions WHERE id = ?').bind(admissionId).first();
    if (!admission || admission.session_id !== sessionId || admission.actor_id !== actorId || admission.mode !== 'write'
      || admission.expires_at <= Math.floor(Date.now() / 1000)) {
      fail(403, 'web_search_not_admitted', 'Web searches need a write message from the requester sent within the last hour.');
    }
    // A one-call grant covers only the search its owner saw: this requester, message and query.
    await requireToolCall(c.env, access.row, 'web_search', { id: callId, requestedBy: actorId, admission, target: query });
    if (!(await workspaceNetworkPolicy(c.env.DB, access.row.workspace_id)).webSearch) {
      fail(403, 'web_search_off', 'Web search is off in this workspace. Its owners and admins turn it on under Settings → Workspaces → the workspace → Network access.');
    }
    return access.row;
  };
  const session = await authorize();
  const provider = await workspaceSearchBackend(c.env, session.workspace_id);
  if (!provider) {
    fail(503, 'web_search_unconfigured', 'This workspace has no web search provider. Its owners and admins choose one under Settings → Workspaces → the workspace → Network access.');
  }
  if (!(await connectorKnowsProvider(c.env, connectorId, provider.name))) {
    fail(409, 'web_search_connector_outdated', `This host's connector predates ${webSearchProviderNames[provider.name]}, the workspace's search provider: its owner updates the connector to search with it.`);
  }
  const results = await provider.search(query, count);
  const row = await authorize();
  await auditStatement(c.env, actorId, 'web.search', row.workspace_id, sessionId, { provider: provider.name, query, results: results.length }).run();
  return c.json({ query, provider: provider.name, results } satisfies WebSearchResult, 200, { 'Cache-Control': 'private, no-store' });
}
