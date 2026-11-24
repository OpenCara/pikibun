import type { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { compile } from '@earendil-works/pi-schema';
import { constantTimeEqual, sha256 } from '../../../../../packages/shared/src/crypto.js';
import { z } from 'zod';
import { hasPermission } from '../../../../../packages/shared/src/policy.js';
import { extensionSwitchOn } from '../../../../../packages/shared/src/piki-extensions.js';
import {
  REMOTE_MCP_EXTENSION, remoteMcpDefinitions, remoteMcpHeaders, remoteMcpLimits, remoteMcpToolKey, remoteMcpToolName, remoteMcpUrl, validRemoteMcpPrefix,
  type RemoteMcpServerSummary, type RemoteMcpTool, type RemoteMcpTransport, type WorkspaceMcpServer,
} from '../../../../../packages/shared/src/remote-mcp.js';
import type { BrokeredToolDefinition } from '../../../../../packages/shared/src/tool-definitions.js';
import type { AppContext, AppEnv, Env, SessionRow } from '../../types.js';
import { appOrigin, fail, id, identifier, now, randomToken, requireOrigin, text, userIdentifier } from '../../http.js';
import { body, fields } from '../../schemas.js';
import { requireMember, sessionAccess, workspaceAdminSQL } from '../access.js';
import { auditStatement } from '../audit.js';
import { workspaceExtensions } from '../extension-policy.js';
import { requireCallbackScope } from '../hosts.js';
import { requireAdmission } from '../run-admissions.js';
import { requireToolCall } from '../tool-checks.js';
import { assertVaultConfigured, decryptToken, encryptToken } from '../vault.js';
import { callRemoteMcpTool, discoverRemoteMcpTools, RemoteMcpError, RemoteMcpUnauthorized } from './client.js';
import {
  authorizationUrl, discoverOAuth, parseOAuthSecret, registerClient, RemoteMcpOAuthError, tokenRequest, type McpOAuthClient, type McpOAuthSecret,
} from './oauth.js';
import { publicHttpsTransport, RemoteMcpRefused } from './transport.js';

interface ServerRow {
  id: string; workspace_id: string; prefix: string; name: string; url: string; headers_ciphertext: string | null; header_names_json: string;
  read_only_tools_json: string; tools_json: string; enabled: number | string; discovered_at: string | null; error: string | null; updated_at: string;
  oauth_ciphertext: string | null; oauth_by: string | null; oauth_at: string | null;
}

const STATE_TTL = 10 * 60 * 1000;
const STATE = /^[A-Za-z0-9_-]{43}$/;
const RENEW_BEFORE_MS = 60_000;

const refusingTransport: RemoteMcpTransport = async () => { throw new RemoteMcpRefused('This Pikibun server reaches no remote MCP servers in tests'); };
let productionTransport: RemoteMcpTransport | undefined;

function transport(env: Env): RemoteMcpTransport {
  if (env.REMOTE_MCP_TRANSPORT) return env.REMOTE_MCP_TRANSPORT;
  if (env.TEST_AUTH_ENABLED === 'true') return refusingTransport;
  return productionTransport ??= publicHttpsTransport();
}

const callBody = fields({ sessionId: z.unknown(), actorId: z.unknown(), admissionId: z.unknown(), callId: z.unknown(), arguments: z.unknown() },
  'Unexpected remote MCP call field.');
const addBody = fields({ name: z.unknown(), prefix: z.unknown(), url: z.unknown(), headers: z.unknown(), readOnlyTools: z.unknown() },
  'Only name, prefix, url, headers and readOnlyTools are accepted.', { code: 'invalid_mcp_server' });
const changeBody = fields({ name: z.unknown(), url: z.unknown(), headers: z.unknown(), readOnlyTools: z.unknown(), enabled: z.unknown(), refresh: z.unknown() },
  'Change name, url, headers, readOnlyTools or enabled, or set refresh to true.', { code: 'invalid_mcp_server', some: true });

const secretContext = (serverId: string) => `remote-mcp:${serverId}`;
const oauthContext = (serverId: string) => `remote-mcp-oauth:${serverId}`;
const stateContext = (serverId: string) => `remote-mcp-oauth-state:${serverId}`;
const parsedList = (json: string): string[] => { try { const value = JSON.parse(json); return Array.isArray(value) ? value.filter(item => typeof item === 'string') : []; } catch { return []; } };
const parsedTools = (json: string): RemoteMcpTool[] => { try { const value = JSON.parse(json); return Array.isArray(value) ? value as RemoteMcpTool[] : []; } catch { return []; } };

function view(row: ServerRow): WorkspaceMcpServer {
  const readOnlyTools = parsedList(row.read_only_tools_json);
  const tools = parsedTools(row.tools_json).flatMap(tool => {
    const toolName = remoteMcpToolName(row.prefix, tool.name);
    return toolName ? [{ ...tool, toolName, readOnly: readOnlyTools.includes(tool.name) }] : [];
  });
  return { id: row.id, name: row.name, prefix: row.prefix, url: row.url, enabled: Number(row.enabled) === 1, headerNames: parsedList(row.header_names_json),
    ...(row.oauth_ciphertext && row.oauth_at ? { oauth: { signedInAt: row.oauth_at } } : {}), readOnlyTools, tools, ...(row.discovered_at ? { discoveredAt: row.discovered_at } : {}), ...(row.error ? { error: row.error } : {}), updatedAt: row.updated_at };
}

function failure(error: unknown, signedIn = false): string {
  if (error instanceof RemoteMcpUnauthorized && error.status === 401) {
    return signedIn ? 'The server refused its sign-in (HTTP 401): an owner or admin signs in to it again'
      : /^\s*Bearer\b/i.test(error.challenge) ? 'The server needs a sign-in (HTTP 401): an owner or admin signs in to it with Sign in, or gives it an Authorization header'
      : error.message;
  }
  if (error instanceof RemoteMcpError || error instanceof RemoteMcpRefused) return error.message.slice(0, 500);
  return `It couldn't be reached: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`;
}

async function headersOf(env: Env, row: Pick<ServerRow, 'id' | 'headers_ciphertext'>): Promise<Record<string, string>> {
  if (!row.headers_ciphertext) return {};
  return JSON.parse(await decryptToken(env, secretContext(row.id), row.headers_ciphertext)) as Record<string, string>;
}

interface SignIn { secret: McpOAuthSecret; ciphertext: string }

async function signInOf(env: Env, serverId: string, ciphertext: string): Promise<SignIn> {
  let plain: string;
  try { plain = await decryptToken(env, oauthContext(serverId), ciphertext); }
  catch { throw new RemoteMcpOAuthError('Pikibun couldn\'t read the sign-in it keeps for it: an owner or admin signs in again'); }
  return { secret: parseOAuthSecret(plain), ciphertext };
}

async function keptSignIn(env: Env, serverId: string): Promise<string | null> {
  return (await env.DB.query<{ oauth_ciphertext: string | null }>('SELECT oauth_ciphertext FROM workspace_mcp_servers WHERE id = ?').bind(serverId).first())?.oauth_ciphertext ?? null;
}

async function renew(env: Env, serverId: string, current: SignIn): Promise<SignIn> {
  const expired = new RemoteMcpOAuthError('Its sign-in expired: an owner or admin signs in to it again');
  if (!current.secret.refreshToken) throw expired;
  let next: McpOAuthSecret;
  try {
    next = await tokenRequest(transport(env), current.secret.client, { grant_type: 'refresh_token', refresh_token: current.secret.refreshToken }, current.secret);
  } catch (error) {
    const latest = await keptSignIn(env, serverId);
    if (latest && latest !== current.ciphertext) return signInOf(env, serverId, latest);
    if (error instanceof RemoteMcpOAuthError && (error.code === 'invalid_grant' || error.code === 'invalid_client')) throw expired;
    throw error;
  }
  const ciphertext = await encryptToken(env, oauthContext(serverId), JSON.stringify(next));
  const saved = await env.DB.query('UPDATE workspace_mcp_servers SET oauth_ciphertext = ? WHERE id = ? AND oauth_ciphertext = ? RETURNING id')
    .bind(ciphertext, serverId, current.ciphertext).first();
  if (saved) return { secret: next, ciphertext };
  const latest = await keptSignIn(env, serverId);
  if (!latest) throw new RemoteMcpOAuthError('Its sign-in was removed: an owner or admin signs in to it again');
  return signInOf(env, serverId, latest);
}

function bearer(headers: Record<string, string>, token: string): Record<string, string> {
  const kept = Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'authorization'));
  return { ...kept, Authorization: `Bearer ${token}` };
}

async function withCredentials<T>(env: Env, serverId: string, headers: Record<string, string>, oauth: string | null,
  run: (headers: Record<string, string>) => Promise<T>): Promise<T> {
  if (!oauth) return run(headers);
  let signIn = await signInOf(env, serverId, oauth);
  let renewed = false;
  if (signIn.secret.expiresAt !== undefined && signIn.secret.expiresAt < Date.now() + RENEW_BEFORE_MS) {
    signIn = await renew(env, serverId, signIn);
    renewed = true;
  }
  try { return await run(bearer(headers, signIn.secret.accessToken)); }
  catch (error) {
    if (renewed || !(error instanceof RemoteMcpUnauthorized) || error.status !== 401 || !signIn.secret.refreshToken) throw error;
    signIn = await renew(env, serverId, signIn);
    return run(bearer(headers, signIn.secret.accessToken));
  }
}

async function discover(env: Env, serverId: string, url: string, headers: Record<string, string>, oauth: string | null): Promise<{ tools: RemoteMcpTool[]; error: string | null }> {
  try { return { tools: await withCredentials(env, serverId, headers, oauth, sent => discoverRemoteMcpTools(transport(env), url, sent)), error: null }; }
  catch (error) { return { tools: [], error: failure(error, !!oauth) }; }
}

function oauthRedirectUri(env: Env): string {
  return `${appOrigin(env)}/api/mcp-servers/oauth/callback`;
}

function stateCookie(env: Env) {
  const secure = new URL(appOrigin(env)).protocol === 'https:';
  return { name: secure ? '__Host-mcp-oauth' : 'test-mcp-oauth', options: { secure, httpOnly: true, sameSite: 'Lax' as const, path: '/' } };
}

async function noteError(env: Env, serverId: string, error: string): Promise<void> {
  await env.DB.query('UPDATE workspace_mcp_servers SET error = ? WHERE id = ?').bind(error.slice(0, 500), serverId).run();
}

function settingsPage(c: AppContext, workspaceId: string): Response {
  return c.redirect(`${appOrigin(c.env)}/#/settings/workspaces/${encodeURIComponent(workspaceId)}`, 302);
}

function readOnlyList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > remoteMcpLimits.tools || value.some(item => typeof item !== 'string' || !item || item.length > 128)) {
    fail(400, 'invalid_mcp_server', `readOnlyTools must list at most ${remoteMcpLimits.tools} tool names.`);
  }
  return [...new Set(value as string[])];
}

function nameOf(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > remoteMcpLimits.name || /[\r\n\0]/.test(value)) {
    fail(400, 'invalid_mcp_server', `name must be one line of at most ${remoteMcpLimits.name} characters.`);
  }
  return value.trim();
}

function checked<T>(make: () => T): T {
  try { return make(); } catch (error) { return fail(400, 'invalid_mcp_server', error instanceof Error ? error.message : 'Invalid remote MCP server.'); }
}

async function serverRow(env: Env, workspaceId: string, serverId: string): Promise<ServerRow> {
  return await env.DB.query<ServerRow>('SELECT * FROM workspace_mcp_servers WHERE id = ? AND workspace_id = ?').bind(serverId, workspaceId).first()
    ?? fail(404, 'not_found', 'Remote MCP server not found.');
}

export async function workspaceRemoteTools(env: Env, workspaceId: string): Promise<{ tools: BrokeredToolDefinition[]; servers: RemoteMcpServerSummary[] }> {
  const rows = await env.DB.query<ServerRow>('SELECT * FROM workspace_mcp_servers WHERE workspace_id = ? AND enabled = 1 ORDER BY created_at, prefix')
    .bind(workspaceId).all();
  const definitions: BrokeredToolDefinition[] = [];
  const servers: RemoteMcpServerSummary[] = [];
  for (const row of rows) {
    let offered = false;
    for (const definition of remoteMcpDefinitions({ name: row.name, prefix: row.prefix, readOnlyTools: parsedList(row.read_only_tools_json), tools: parsedTools(row.tools_json) })) {
      if (definitions.length < 64 && !definitions.some(other => other.name === definition.name)) { definitions.push(definition); offered = true; }
    }
    if (offered) servers.push({ prefix: row.prefix, name: row.name });
  }
  return { tools: definitions, servers };
}

export async function remoteMcpCall(c: AppContext, connectorId: string): Promise<Response> {
  const prefix = c.req.param('prefix');
  const key = c.req.param('key');
  if (!validRemoteMcpPrefix(prefix) || !key || !/^[0-9a-f]{16}$/.test(key)) fail(404, 'not_found', 'No such remote MCP tool.');
  const input = await body(c, callBody, { maxBytes: 256 * 1024 });
  const sessionId = identifier(input.sessionId, 'sessionId');
  const actorId = userIdentifier(input.actorId, 'actorId');
  const admissionId = text(input.admissionId, 'admissionId', 128);
  identifier(input.callId, 'callId');
  const args = input.arguments ?? {};
  if (!args || typeof args !== 'object' || Array.isArray(args)) fail(400, 'invalid_input', 'arguments must be an object.');
  const authorize = async (): Promise<{ row: SessionRow; server: ServerRow; tool: RemoteMcpTool; toolName: string; write: boolean }> => {
    const access = await sessionAccess(c.env, sessionId, actorId);
    if (!access || access.row.status === 'archived' || !hasPermission(access.permissions, 'write')) {
      fail(403, 'permission_revoked', 'The requester can no longer write to this session.');
    }
    await requireCallbackScope(c, access.row, connectorId);
    const admission = await requireAdmission(c.env, { admissionId, sessionId, actorId }, { code: 'mcp_call_not_admitted',
      message: 'Remote MCP tools need a message from the requester sent within the last hour, or whose run is still going.' });
    if (!extensionSwitchOn(REMOTE_MCP_EXTENSION, await workspaceExtensions(c.env, access.row.workspace_id))) {
      fail(403, 'mcp_tools_off', `Remote MCP tools are turned off in this workspace (${REMOTE_MCP_EXTENSION}). Nothing ran.`);
    }
    const server = await c.env.DB.query<ServerRow>('SELECT * FROM workspace_mcp_servers WHERE workspace_id = ? AND prefix = ? AND enabled = 1')
      .bind(access.row.workspace_id, prefix).first();
    const readOnlyTools = server ? parsedList(server.read_only_tools_json) : [];
    const tool = server ? parsedTools(server.tools_json).find(item => remoteMcpToolKey(item.name) === key) : undefined;
    const toolName = server && tool ? remoteMcpToolName(server.prefix, tool.name) : undefined;
    if (!server || !tool || !toolName) fail(404, 'mcp_tool_not_found', 'This workspace has no such remote MCP tool now, or its server is turned off.');
    const write = !readOnlyTools.includes(tool.name);
    if (write && admission.access === 'read') {
      fail(403, 'mcp_tool_writes', `${toolName} may change things, which a Read-only message doesn't do: its workspace's owners mark the tools that only read. Nothing ran.`);
    }
    await requireToolCall(c.env, access.row, actorId, toolName);
    return { row: access.row, server, tool, toolName, write };
  };
  const { row, server, tool, toolName, write } = await authorize();
  const validator = compile(tool.inputSchema, { unresolvedRefs: 'reject' });
  const errors = validator.errors(args);
  if (errors.length) {
    fail(400, 'invalid_arguments', `${toolName}: ${errors.slice(0, 3).map(error => `${error.path || 'arguments'} ${error.message}`).join('; ').slice(0, 500)}. Nothing ran.`);
  }
  let result;
  try {
    result = await withCredentials(c.env, server.id, await headersOf(c.env, server), server.oauth_ciphertext,
      headers => callRemoteMcpTool(transport(c.env), server.url, headers, tool.name, args as Record<string, unknown>));
  } catch (error) {
    await auditStatement(c.env, actorId, 'workspace.mcp.called', row.workspace_id, sessionId, { server: server.id, tool: tool.name, write, failed: true }).run();
    return fail(502, 'mcp_call_failed', `${server.name}: ${failure(error, !!server.oauth_ciphertext)}`);
  }
  await authorize();
  await auditStatement(c.env, actorId, 'workspace.mcp.called', row.workspace_id, sessionId,
    { server: server.id, tool: tool.name, write, ...(result.isError ? { isError: true } : {}) }).run();
  return c.json({ server: server.name, tool: tool.name, ...result });
}

export function registerRemoteMcp(app: Hono<AppEnv>): void {
  app.get('/api/workspaces/:id/mcp-servers', async c => {
    const workspaceId = identifier(c.req.param('id'));
    const member = await requireMember(c.env, workspaceId, c.get('auth').userId);
    const rows = await c.env.DB.query<ServerRow>('SELECT * FROM workspace_mcp_servers WHERE workspace_id = ? ORDER BY created_at, prefix').bind(workspaceId).all();
    return c.json({ servers: rows.map(view), admin: member.role === 'owner' || member.role === 'admin' });
  });

  app.post('/api/workspaces/:id/mcp-servers', async c => {
    const workspaceId = identifier(c.req.param('id')); const actor = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    const input = await body(c, addBody, { maxBytes: 64 * 1024 });
    const name = nameOf(input.name);
    if (!validRemoteMcpPrefix(input.prefix)) fail(400, 'invalid_mcp_server', 'prefix must be a lowercase letter then up to 15 lowercase letters or digits: it starts each of its tools\' names.');
    const prefix = input.prefix as string;
    const url = checked(() => remoteMcpUrl(input.url));
    const headers = input.headers === undefined ? {} : checked(() => remoteMcpHeaders(input.headers));
    const readOnlyTools = input.readOnlyTools === undefined ? [] : readOnlyList(input.readOnlyTools);
    const serverId = id(); const at = now();
    const found = await discover(c.env, serverId, url, headers, null);
    const ciphertext = Object.keys(headers).length ? await encryptToken(c.env, secretContext(serverId), JSON.stringify(headers)) : null;
    const saved = await c.env.DB.query<{ id: string }>(`INSERT INTO workspace_mcp_servers (id, workspace_id, prefix, name, url, headers_ciphertext, header_names_json,
        read_only_tools_json, tools_json, enabled, discovered_at, error, created_by, updated_by, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ? WHERE ${workspaceAdminSQL}
        AND (SELECT COUNT(*) FROM workspace_mcp_servers WHERE workspace_id = ?) < ?
        AND NOT EXISTS (SELECT 1 FROM workspace_mcp_servers WHERE workspace_id = ? AND prefix = ?)
      RETURNING id`)
      .bind(serverId, workspaceId, prefix, name, url, ciphertext, JSON.stringify(Object.keys(headers)), JSON.stringify(readOnlyTools), JSON.stringify(found.tools),
        found.error ? null : at, found.error, actor, actor, at, at, workspaceId, actor, workspaceId, remoteMcpLimits.servers, workspaceId, prefix).first();
    if (!saved) {
      await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
      if (await c.env.DB.query('SELECT 1 FROM workspace_mcp_servers WHERE workspace_id = ? AND prefix = ?').bind(workspaceId, prefix).first()) {
        fail(409, 'mcp_prefix_taken', `Another remote MCP server of this workspace already uses the prefix ${prefix}.`);
      }
      fail(409, 'mcp_server_limit', `A workspace has at most ${remoteMcpLimits.servers} remote MCP servers.`);
    }
    await auditStatement(c.env, actor, 'workspace.mcp.added', workspaceId, null,
      { server: serverId, name, prefix, url, headers: Object.keys(headers), readOnlyTools, tools: found.tools.length, ...(found.error ? { error: found.error } : {}) }).run();
    return c.json({ server: view(await serverRow(c.env, workspaceId, serverId)) }, 201);
  });

  app.patch('/api/workspaces/:id/mcp-servers/:serverId', async c => {
    const workspaceId = identifier(c.req.param('id')); const actor = c.get('auth').userId;
    const serverId = identifier(c.req.param('serverId'), 'serverId');
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    const input = await body(c, changeBody, { maxBytes: 64 * 1024 });
    const keys = Object.keys(input).filter(name => input[name as keyof typeof input] !== undefined);
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') fail(400, 'invalid_mcp_server', 'enabled must be true or false.');
    if (input.refresh !== undefined && input.refresh !== true) fail(400, 'invalid_mcp_server', 'refresh must be true.');
    const row = await serverRow(c.env, workspaceId, serverId);
    const name = input.name === undefined ? row.name : nameOf(input.name);
    const url = input.url === undefined ? row.url : checked(() => remoteMcpUrl(input.url));
    if (url !== row.url && input.headers === undefined) {
      fail(400, 'mcp_headers_required', 'Give this server\'s headers again with its new address, or an empty set to send none: Pikibun never sends the headers it keeps for one address to another.');
    }
    const headers = input.headers === undefined ? await headersOf(c.env, row) : input.headers === null ? {} : checked(() => remoteMcpHeaders(input.headers));
    const readOnlyTools = input.readOnlyTools === undefined ? parsedList(row.read_only_tools_json) : readOnlyList(input.readOnlyTools);
    const enabled = input.enabled === undefined ? Number(row.enabled) === 1 : input.enabled as boolean;
    const moved = url !== row.url;
    const reach = input.refresh === true || input.url !== undefined || input.headers !== undefined;
    const found = reach ? await discover(c.env, serverId, url, headers, moved ? null : row.oauth_ciphertext) : undefined;
    const at = now();
    const ciphertext = input.headers === undefined ? row.headers_ciphertext
      : Object.keys(headers).length ? await encryptToken(c.env, secretContext(serverId), JSON.stringify(headers)) : null;
    const saved = await c.env.DB.query<{ id: string }>(`UPDATE workspace_mcp_servers SET name = ?, url = ?, headers_ciphertext = ?, header_names_json = ?,
        read_only_tools_json = ?, tools_json = ?, enabled = ?, discovered_at = ?, error = ?, updated_by = ?, updated_at = ?,
        oauth_ciphertext = CASE WHEN ? = 1 THEN NULL ELSE oauth_ciphertext END, oauth_by = CASE WHEN ? = 1 THEN NULL ELSE oauth_by END,
        oauth_at = CASE WHEN ? = 1 THEN NULL ELSE oauth_at END
      WHERE id = ? AND workspace_id = ? AND ${workspaceAdminSQL} RETURNING id`)
      .bind(name, url, ciphertext, JSON.stringify(Object.keys(headers)), JSON.stringify(readOnlyTools),
        found && !found.error ? JSON.stringify(found.tools) : row.tools_json, enabled ? 1 : 0,
        found ? (found.error ? row.discovered_at : at) : row.discovered_at, found ? found.error : row.error, actor, at, moved ? 1 : 0, moved ? 1 : 0, moved ? 1 : 0,
        serverId, workspaceId, workspaceId, actor).first();
    if (!saved) {
      await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
      fail(404, 'not_found', 'Remote MCP server not found.');
    }
    await auditStatement(c.env, actor, 'workspace.mcp.updated', workspaceId, null, {
      server: serverId, changed: keys.filter(item => item !== 'refresh'), ...(input.url !== undefined ? { url } : {}), ...(input.headers !== undefined ? { headers: Object.keys(headers) } : {}),
      ...(input.readOnlyTools !== undefined ? { readOnlyTools } : {}), ...(input.enabled !== undefined ? { enabled } : {}),
      ...(moved && row.oauth_ciphertext ? { signedOut: true } : {}),
      ...(found ? { tools: found.tools.length, ...(found.error ? { error: found.error } : {}) } : {}),
    }).run();
    return c.json({ server: view(await serverRow(c.env, workspaceId, serverId)) });
  });

  app.delete('/api/workspaces/:id/mcp-servers/:serverId', async c => {
    const workspaceId = identifier(c.req.param('id')); const actor = c.get('auth').userId;
    const serverId = identifier(c.req.param('serverId'), 'serverId');
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    const row = await serverRow(c.env, workspaceId, serverId);
    await c.env.DB.batch([
      c.env.DB.query(`DELETE FROM workspace_mcp_servers WHERE id = ? AND workspace_id = ? AND ${workspaceAdminSQL}`).bind(serverId, workspaceId, workspaceId, actor),
      auditStatement(c.env, actor, 'workspace.mcp.removed', workspaceId, null, { server: serverId, prefix: row.prefix }),
    ]);
    return c.json({ ok: true });
  });

  app.get('/api/workspaces/:id/mcp-servers/:serverId/oauth/start', async c => {
    requireOrigin(c);
    const workspaceId = identifier(c.req.param('id')); const actor = c.get('auth').userId;
    const serverId = identifier(c.req.param('serverId'), 'serverId');
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    await assertVaultConfigured(c.env);
    const row = await serverRow(c.env, workspaceId, serverId);
    let client: McpOAuthClient;
    try { client = await registerClient(transport(c.env), await discoverOAuth(transport(c.env), row.url), oauthRedirectUri(c.env)); }
    catch (error) {
      await noteError(c.env, serverId, `Signing in failed: ${failure(error)}`);
      return settingsPage(c, workspaceId);
    }
    const state = randomToken(); const verifier = randomToken();
    const expiresAt = Date.now() + STATE_TTL;
    await c.env.DB.batch([
      c.env.DB.query('DELETE FROM mcp_oauth_states WHERE expires_at < ? OR user_id = ?').bind(Date.now(), actor),
      c.env.DB.query(`INSERT INTO mcp_oauth_states (state_hash, server_id, user_id, url, verifier, client_ciphertext, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(await sha256(state), serverId, actor, row.url, verifier, await encryptToken(c.env, stateContext(serverId), JSON.stringify(client)), expiresAt, now()),
    ]);
    const cookie = stateCookie(c.env);
    setCookie(c, cookie.name, state, { ...cookie.options, maxAge: STATE_TTL / 1000, expires: new Date(expiresAt) });
    return c.redirect(authorizationUrl(client, state, verifier), 302);
  });

  app.get('/api/mcp-servers/oauth/callback', async c => {
    const actor = c.get('auth').userId;
    const cookie = stateCookie(c.env);
    const cookieState = getCookie(c, cookie.name);
    setCookie(c, cookie.name, '', { ...cookie.options, maxAge: 0, expires: new Date(0) });
    const states = c.req.queries('state');
    const state = states?.length === 1 ? states[0]! : '';
    if (!STATE.test(state) || !cookieState || !STATE.test(cookieState) || !constantTimeEqual(state, cookieState)) {
      fail(400, 'invalid_oauth_state', 'Invalid or expired OAuth state: start the sign-in again from the workspace\'s settings.');
    }
    const saved = await c.env.DB.query<{ server_id: string; user_id: string; url: string; verifier: string; client_ciphertext: string; expires_at: number | string }>(
      'DELETE FROM mcp_oauth_states WHERE state_hash = ? RETURNING server_id, user_id, url, verifier, client_ciphertext, expires_at').bind(await sha256(state)).first();
    if (!saved || saved.user_id !== actor || Number(saved.expires_at) < Date.now()) {
      fail(400, 'invalid_oauth_state', 'Invalid or expired OAuth state: start the sign-in again from the workspace\'s settings.');
    }
    const row = await c.env.DB.query<ServerRow>('SELECT * FROM workspace_mcp_servers WHERE id = ?').bind(saved.server_id).first()
      ?? fail(404, 'not_found', 'Remote MCP server not found.');
    await requireMember(c.env, row.workspace_id, actor, ['owner', 'admin']);
    const declined = async (reason: string) => { await noteError(c.env, row.id, `Signing in failed: ${reason}`); return settingsPage(c, row.workspace_id); };
    if (row.url !== saved.url) return declined('its address changed while signing in');
    const error = c.req.query('error');
    if (error !== undefined) {
      return declined(error === 'access_denied' ? 'the sign-in was declined' : `its authorization server answered ${/^[\x20-\x7e]{1,64}$/.test(error) ? error : 'an error'}`);
    }
    const codes = c.req.queries('code');
    const code = codes?.length === 1 ? codes[0]! : '';
    if (!/^[\x21-\x7e]{1,4096}$/.test(code)) return declined('its authorization server sent no code');
    let client: McpOAuthClient;
    try { client = JSON.parse(await decryptToken(c.env, stateContext(row.id), saved.client_ciphertext)) as McpOAuthClient; }
    catch { return declined('Pikibun couldn\'t read the sign-in it started: start it again'); }
    const issuer = c.req.query('iss');
    if (issuer !== undefined && issuer !== client.issuer) return declined('the answer came from another authorization server');
    let secret: McpOAuthSecret;
    try {
      secret = await tokenRequest(transport(c.env), client, { grant_type: 'authorization_code', code, redirect_uri: client.redirectUri, code_verifier: saved.verifier });
    } catch (failed) { return declined(failure(failed)); }
    const ciphertext = await encryptToken(c.env, oauthContext(row.id), JSON.stringify(secret));
    const at = now();
    const signedIn = await c.env.DB.query(`UPDATE workspace_mcp_servers SET oauth_ciphertext = ?, oauth_by = ?, oauth_at = ?, updated_by = ?, updated_at = ?
      WHERE id = ? AND url = ? AND ${workspaceAdminSQL} RETURNING id`)
      .bind(ciphertext, actor, at, actor, at, row.id, saved.url, row.workspace_id, actor).first();
    if (!signedIn) return declined('the server or your role changed while signing in');
    const found = await discover(c.env, row.id, row.url, await headersOf(c.env, row), ciphertext);
    await c.env.DB.batch([
      c.env.DB.query('UPDATE workspace_mcp_servers SET tools_json = CASE WHEN ? = 1 THEN ? ELSE tools_json END, discovered_at = CASE WHEN ? = 1 THEN ? ELSE discovered_at END, error = ? WHERE id = ?')
        .bind(found.error ? 0 : 1, JSON.stringify(found.tools), found.error ? 0 : 1, at, found.error, row.id),
      auditStatement(c.env, actor, 'workspace.mcp.signed_in', row.workspace_id, null,
        { server: row.id, prefix: row.prefix, tools: found.tools.length, ...(found.error ? { error: found.error } : {}) }),
    ]);
    return settingsPage(c, row.workspace_id);
  });

  app.delete('/api/workspaces/:id/mcp-servers/:serverId/oauth', async c => {
    const workspaceId = identifier(c.req.param('id')); const actor = c.get('auth').userId;
    const serverId = identifier(c.req.param('serverId'), 'serverId');
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    const row = await serverRow(c.env, workspaceId, serverId);
    const at = now();
    await c.env.DB.batch([
      c.env.DB.query(`UPDATE workspace_mcp_servers SET oauth_ciphertext = NULL, oauth_by = NULL, oauth_at = NULL, updated_by = ?, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND ${workspaceAdminSQL} RETURNING id`).bind(actor, at, serverId, workspaceId, workspaceId, actor),
      auditStatement(c.env, actor, 'workspace.mcp.signed_out', workspaceId, null, { server: serverId, prefix: row.prefix }),
    ]);
    return c.json({ server: view(await serverRow(c.env, workspaceId, serverId)) });
  });
}
