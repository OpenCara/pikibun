import type { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { compile } from '@earendil-works/pi-schema';
import { constantTimeEqual, sha256 } from '../../../../../packages/shared/src/crypto.js';
import { z } from 'zod';
import { hasPermission } from '../../../../../packages/shared/src/policy.js';
import { extensionSwitchOn } from '../../../../../packages/shared/src/piki-extensions.js';
import {
  REMOTE_MCP_EXTENSION, remoteMcpAppLink, remoteMcpDefinitions, remoteMcpHeaders, remoteMcpLimits, remoteMcpToolKey, remoteMcpToolName, remoteMcpUrl, validRemoteMcpPrefix,
  type RemoteMcpServerSummary, type RemoteMcpTool, type RemoteMcpToolsLeftOut, type RemoteMcpTransport, type WorkspaceMcpServer,
} from '../../../../../packages/shared/src/remote-mcp.js';
import type { BrokeredToolDefinition } from '../../../../../packages/shared/src/tool-definitions.js';
import type { AppContext, AppEnv, Env, SessionRow } from '../../types.js';
import { appOrigin, fail, id, identifier, now, randomToken, requireOrigin, text, userIdentifier } from '../../http.js';
import { body, fields } from '../../schemas.js';
import { requireMember, sessionAccess, workspaceAdminSQL } from '../access.js';
import { auditStatement } from '../audit.js';
import { privateResponse } from '../auth.js';
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
  tools_over_limit: number | string | null; tools_unusable: number | string | null;
}

const STATE_TTL = 10 * 60 * 1000;
const STATE = /^[A-Za-z0-9_-]{43}$/;
const APP_BEGIN_PATH = '/api/mcp-servers/oauth/app/begin';
const APP_CALLBACK_PATH = '/api/mcp-servers/oauth/app/callback';
const APP_EXPIRED = 'This sign-in has expired or was already used. Start it again with Sign in in the Pikibun app.';
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

const finishBody = fields({ code: z.unknown() }, 'Only code is accepted.');

const secretContext = (serverId: string) => `remote-mcp:${serverId}`;
const oauthContext = (serverId: string) => `remote-mcp-oauth:${serverId}`;
const stateContext = (serverId: string) => `remote-mcp-oauth-state:${serverId}`;
const appSecretContext = (signInId: string) => `remote-mcp-oauth-app:${signInId}`;
const parsedList = (json: string): string[] => { try { const value = JSON.parse(json); return Array.isArray(value) ? value.filter(item => typeof item === 'string') : []; } catch { return []; } };
const parsedTools = (json: string): RemoteMcpTool[] => { try { const value = JSON.parse(json); return Array.isArray(value) ? value as RemoteMcpTool[] : []; } catch { return []; } };

function view(row: ServerRow): WorkspaceMcpServer {
  const readOnlyTools = parsedList(row.read_only_tools_json);
  const tools = parsedTools(row.tools_json).flatMap(tool => {
    const toolName = remoteMcpToolName(row.prefix, tool.name);
    return toolName ? [{ ...tool, toolName, readOnly: readOnlyTools.includes(tool.name) }] : [];
  });
  const leftOut = { overLimit: Number(row.tools_over_limit) || 0, unusable: Number(row.tools_unusable) || 0 };
  return { id: row.id, name: row.name, prefix: row.prefix, url: row.url, enabled: Number(row.enabled) === 1, headerNames: parsedList(row.header_names_json),
    ...(row.oauth_ciphertext && row.oauth_at ? { oauth: { signedInAt: row.oauth_at } } : {}), readOnlyTools, tools,
    ...(leftOut.overLimit || leftOut.unusable ? { toolsLeftOut: leftOut } : {}), ...(row.discovered_at ? { discoveredAt: row.discovered_at } : {}), ...(row.error ? { error: row.error } : {}), updatedAt: row.updated_at };
}

function failure(error: unknown, signedIn = false): string {
  if (error instanceof RemoteMcpUnauthorized && error.status === 401) {
    return signedIn ? 'The server refused its sign-in (HTTP 401): an owner or admin signs in to it again'
      : /^\s*Bearer\b/i.test(error.challenge) ? 'The server needs a sign-in (HTTP 401): an owner or admin signs in to it with Sign in, or gives it a token, a username and password or a header with Change sign-in'
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

interface Discovered { tools: RemoteMcpTool[]; leftOut: RemoteMcpToolsLeftOut; error: string | null }

async function discover(env: Env, serverId: string, url: string, headers: Record<string, string>, oauth: string | null): Promise<Discovered> {
  try { return { ...await withCredentials(env, serverId, headers, oauth, sent => discoverRemoteMcpTools(transport(env), url, sent)), error: null }; }
  catch (error) { return { tools: [], leftOut: { overLimit: 0, unusable: 0 }, error: failure(error, !!oauth) }; }
}

function discoveredDetail(found: Discovered): Record<string, unknown> {
  return { tools: found.tools.length, ...(found.leftOut.overLimit ? { toolsOverLimit: found.leftOut.overLimit } : {}),
    ...(found.leftOut.unusable ? { toolsUnusable: found.leftOut.unusable } : {}), ...(found.error ? { error: found.error } : {}) };
}

function oauthRedirectUri(env: Env): string {
  return `${appOrigin(env)}/api/mcp-servers/oauth/callback`;
}

function appRedirectUri(env: Env): string {
  return `${appOrigin(env)}${APP_CALLBACK_PATH}`;
}

function stateCookie(env: Env, app = false) {
  const secure = new URL(appOrigin(env)).protocol === 'https:';
  const name = `${secure ? '__Host-' : 'test-'}mcp-oauth${app ? '-app' : ''}`;
  return { name, options: { secure, httpOnly: true, sameSite: 'Lax' as const, path: '/' } };
}

function callbackState(c: AppContext, app: boolean): string | null {
  const cookie = stateCookie(c.env, app);
  const cookieState = getCookie(c, cookie.name);
  setCookie(c, cookie.name, '', { ...cookie.options, maxAge: 0, expires: new Date(0) });
  const states = c.req.queries('state');
  const state = states?.length === 1 ? states[0]! : '';
  return STATE.test(state) && cookieState && STATE.test(cookieState) && constantTimeEqual(state, cookieState) ? state : null;
}

function callbackCode(c: AppContext, client: McpOAuthClient): { code: string } | { reason: string } {
  const error = c.req.query('error');
  if (error !== undefined) {
    return { reason: error === 'access_denied' ? 'the sign-in was declined' : `its authorization server answered ${/^[\x20-\x7e]{1,64}$/.test(error) ? error : 'an error'}` };
  }
  const codes = c.req.queries('code');
  const code = codes?.length === 1 ? codes[0]! : '';
  if (!/^[\x21-\x7e]{1,4096}$/.test(code)) return { reason: 'its authorization server sent no code' };
  const issuer = c.req.query('iss');
  if (issuer !== undefined && issuer !== client.issuer) return { reason: 'the answer came from another authorization server' };
  return { code };
}

async function keepSignIn(env: Env, row: ServerRow, actor: string, url: string, secret: McpOAuthSecret, detail: Record<string, unknown> = {}): Promise<boolean> {
  const ciphertext = await encryptToken(env, oauthContext(row.id), JSON.stringify(secret));
  const at = now();
  const signedIn = await env.DB.query(`UPDATE workspace_mcp_servers SET oauth_ciphertext = ?, oauth_by = ?, oauth_at = ?, updated_by = ?, updated_at = ?
    WHERE id = ? AND url = ? AND ${workspaceAdminSQL} RETURNING id`)
    .bind(ciphertext, actor, at, actor, at, row.id, url, row.workspace_id, actor).first();
  if (!signedIn) return false;
  const found = await discover(env, row.id, row.url, await headersOf(env, row), ciphertext);
  await env.DB.batch([
    env.DB.query(`UPDATE workspace_mcp_servers SET tools_json = CASE WHEN ? = 1 THEN ? ELSE tools_json END, discovered_at = CASE WHEN ? = 1 THEN ? ELSE discovered_at END,
        tools_over_limit = CASE WHEN ? = 1 THEN ? ELSE tools_over_limit END, tools_unusable = CASE WHEN ? = 1 THEN ? ELSE tools_unusable END, error = ? WHERE id = ?`)
      .bind(found.error ? 0 : 1, JSON.stringify(found.tools), found.error ? 0 : 1, at, found.error ? 0 : 1, found.leftOut.overLimit, found.error ? 0 : 1, found.leftOut.unusable,
        found.error, row.id),
    auditStatement(env, actor, 'workspace.mcp.signed_in', row.workspace_id, null,
      { server: row.id, prefix: row.prefix, ...detail, ...discoveredDetail(found) }),
  ]);
  return true;
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[ch]!);

function appPage(c: AppContext, title: string, message: string, finish?: { link: string; code: string }, status: 200 | 400 = 200): Response {
  const style = 'font:16px system-ui,sans-serif;max-width:32em;margin:20vh auto 0;padding:0 1em;line-height:1.5';
  const body = finish
    ? `<p><a href="${escapeHtml(finish.link)}" style="display:inline-block;padding:.6em 1.2em;border-radius:6px;background:#2563eb;color:#fff;text-decoration:none">Open Pikibun</a></p>`
      + `<p>Or paste this code where the app asks for it:</p><p><code style="font-size:14px;word-break:break-all;user-select:all">${escapeHtml(finish.code)}</code></p>`
      + '<p style="color:#666;font-size:14px">It works once, for 10 minutes, and only in the Pikibun app of whoever started this sign-in. Show it to nobody.</p>'
    : '';
  return c.html('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Pikibun</title>'
    + `<main style="${style}"><h1 style="font-size:20px">${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${body}</main>`, status);
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
        read_only_tools_json, tools_json, tools_over_limit, tools_unusable, enabled, discovered_at, error, created_by, updated_by, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ? WHERE ${workspaceAdminSQL}
        AND (SELECT COUNT(*) FROM workspace_mcp_servers WHERE workspace_id = ?) < ?
        AND NOT EXISTS (SELECT 1 FROM workspace_mcp_servers WHERE workspace_id = ? AND prefix = ?)
      RETURNING id`)
      .bind(serverId, workspaceId, prefix, name, url, ciphertext, JSON.stringify(Object.keys(headers)), JSON.stringify(readOnlyTools), JSON.stringify(found.tools),
        found.leftOut.overLimit, found.leftOut.unusable, found.error ? null : at, found.error, actor, actor, at, at, workspaceId, actor, workspaceId, remoteMcpLimits.servers, workspaceId, prefix).first();
    if (!saved) {
      await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
      if (await c.env.DB.query('SELECT 1 FROM workspace_mcp_servers WHERE workspace_id = ? AND prefix = ?').bind(workspaceId, prefix).first()) {
        fail(409, 'mcp_prefix_taken', `Another remote MCP server of this workspace already uses the prefix ${prefix}.`);
      }
      fail(409, 'mcp_server_limit', `A workspace has at most ${remoteMcpLimits.servers} remote MCP servers.`);
    }
    await auditStatement(c.env, actor, 'workspace.mcp.added', workspaceId, null,
      { server: serverId, name, prefix, url, headers: Object.keys(headers), readOnlyTools, ...discoveredDetail(found) }).run();
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
    const replaced = input.headers !== undefined && Object.keys(headers).some(name => name.toLowerCase() === 'authorization');
    const signOut = moved || replaced;
    const reach = input.refresh === true || input.url !== undefined || input.headers !== undefined;
    const found = reach ? await discover(c.env, serverId, url, headers, signOut ? null : row.oauth_ciphertext) : undefined;
    const at = now();
    const ciphertext = input.headers === undefined ? row.headers_ciphertext
      : Object.keys(headers).length ? await encryptToken(c.env, secretContext(serverId), JSON.stringify(headers)) : null;
    const saved = await c.env.DB.query<{ id: string }>(`UPDATE workspace_mcp_servers SET name = ?, url = ?, headers_ciphertext = ?, header_names_json = ?,
        read_only_tools_json = ?, tools_json = ?, tools_over_limit = ?, tools_unusable = ?, enabled = ?, discovered_at = ?, error = ?, updated_by = ?, updated_at = ?,
        oauth_ciphertext = CASE WHEN ? = 1 THEN NULL ELSE oauth_ciphertext END, oauth_by = CASE WHEN ? = 1 THEN NULL ELSE oauth_by END,
        oauth_at = CASE WHEN ? = 1 THEN NULL ELSE oauth_at END
      WHERE id = ? AND workspace_id = ? AND ${workspaceAdminSQL} RETURNING id`)
      .bind(name, url, ciphertext, JSON.stringify(Object.keys(headers)), JSON.stringify(readOnlyTools),
        found && !found.error ? JSON.stringify(found.tools) : row.tools_json,
        found && !found.error ? found.leftOut.overLimit : Number(row.tools_over_limit) || 0, found && !found.error ? found.leftOut.unusable : Number(row.tools_unusable) || 0,
        enabled ? 1 : 0,
        found ? (found.error ? row.discovered_at : at) : row.discovered_at, found ? found.error : row.error, actor, at, signOut ? 1 : 0, signOut ? 1 : 0, signOut ? 1 : 0,
        serverId, workspaceId, workspaceId, actor).first();
    if (!saved) {
      await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
      fail(404, 'not_found', 'Remote MCP server not found.');
    }
    await auditStatement(c.env, actor, 'workspace.mcp.updated', workspaceId, null, {
      server: serverId, changed: keys.filter(item => item !== 'refresh'), ...(input.url !== undefined ? { url } : {}), ...(input.headers !== undefined ? { headers: Object.keys(headers) } : {}),
      ...(input.readOnlyTools !== undefined ? { readOnlyTools } : {}), ...(input.enabled !== undefined ? { enabled } : {}),
      ...(signOut && row.oauth_ciphertext ? { signedOut: true } : {}),
      ...(found ? discoveredDetail(found) : {}),
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
    const state = callbackState(c, false);
    if (!state) fail(400, 'invalid_oauth_state', 'Invalid or expired OAuth state: start the sign-in again from the workspace\'s settings.');
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
    let client: McpOAuthClient;
    try { client = JSON.parse(await decryptToken(c.env, stateContext(row.id), saved.client_ciphertext)) as McpOAuthClient; }
    catch { return declined('Pikibun couldn\'t read the sign-in it started: start it again'); }
    const answer = callbackCode(c, client);
    if ('reason' in answer) return declined(answer.reason);
    let secret: McpOAuthSecret;
    try {
      secret = await tokenRequest(transport(c.env), client, { grant_type: 'authorization_code', code: answer.code, redirect_uri: client.redirectUri, code_verifier: saved.verifier });
    } catch (failed) { return declined(failure(failed)); }
    if (!await keepSignIn(c.env, row, actor, saved.url, secret)) return declined('the server or your role changed while signing in');
    return settingsPage(c, row.workspace_id);
  });

  app.post('/api/workspaces/:id/mcp-servers/:serverId/oauth/app', async c => {
    const workspaceId = identifier(c.req.param('id')); const actor = c.get('auth').userId;
    const serverId = identifier(c.req.param('serverId'), 'serverId');
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    await assertVaultConfigured(c.env);
    const row = await serverRow(c.env, workspaceId, serverId);
    const begin = randomToken();
    const expiresAt = Date.now() + STATE_TTL;
    await c.env.DB.batch([
      c.env.DB.query('DELETE FROM mcp_oauth_app_sign_ins WHERE expires_at < ? OR user_id = ?').bind(Date.now(), actor),
      c.env.DB.query(`INSERT INTO mcp_oauth_app_sign_ins (id, server_id, user_id, url, begin_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(id(), serverId, actor, row.url, await sha256(begin), expiresAt, now()),
    ]);
    return c.json({ url: `${appOrigin(c.env)}${APP_BEGIN_PATH}?${new URLSearchParams({ token: begin }).toString()}`, expiresAt: new Date(expiresAt).toISOString() }, 201);
  });

  app.post('/api/mcp-servers/oauth/app/finish', async c => {
    const actor = c.get('auth').userId;
    const input = await body(c, finishBody, { maxBytes: 1024 });
    const expired: () => never = () => fail(400, 'invalid_grant', APP_EXPIRED);
    const code = typeof input.code === 'string' && STATE.test(input.code) ? input.code : expired();
    const saved = await c.env.DB.query<{ id: string; server_id: string; user_id: string; url: string; secret_ciphertext: string | null; expires_at: number | string }>(
      'DELETE FROM mcp_oauth_app_sign_ins WHERE finish_hash = ? RETURNING id, server_id, user_id, url, secret_ciphertext, expires_at').bind(await sha256(code)).first();
    if (!saved || !saved.secret_ciphertext || Number(saved.expires_at) < Date.now()) return expired();
    if (saved.user_id !== actor) fail(403, 'not_your_sign_in', 'This code finishes a sign-in someone else started: only their Pikibun app can use it. Nothing was kept.');
    const row = await c.env.DB.query<ServerRow>('SELECT * FROM workspace_mcp_servers WHERE id = ?').bind(saved.server_id).first()
      ?? fail(404, 'not_found', 'Remote MCP server not found.');
    await requireMember(c.env, row.workspace_id, actor, ['owner', 'admin']);
    if (row.url !== saved.url) fail(409, 'mcp_server_changed', 'Its address changed while signing in: sign in to it again.');
    let secret: McpOAuthSecret;
    try { secret = parseOAuthSecret(await decryptToken(c.env, appSecretContext(saved.id), saved.secret_ciphertext)); }
    catch { return expired(); }
    if (!await keepSignIn(c.env, row, actor, saved.url, secret, { via: 'app' })) fail(409, 'mcp_server_changed', 'The server or your role changed while signing in.');
    return c.json({ workspaceId: row.workspace_id, server: view(await serverRow(c.env, row.workspace_id, row.id)) });
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

interface AppSignInRow {
  id: string; server_id: string; user_id: string; url: string; verifier: string | null; client_ciphertext: string | null; expires_at: number | string;
}

export function registerRemoteMcpAppPages(app: Hono<AppEnv>): void {
  app.get(APP_BEGIN_PATH, privateResponse, async c => {
    requireOrigin(c);
    const tokens = c.req.queries('token');
    const token = tokens?.length === 1 ? tokens[0]! : '';
    const expired = () => appPage(c, 'This sign-in link has expired', APP_EXPIRED, undefined, 400);
    if (!STATE.test(token)) return expired();
    const saved = await c.env.DB.query<AppSignInRow>(
      'UPDATE mcp_oauth_app_sign_ins SET begin_hash = NULL WHERE begin_hash = ? RETURNING id, server_id, user_id, url, verifier, client_ciphertext, expires_at')
      .bind(await sha256(token)).first();
    if (!saved || Number(saved.expires_at) < Date.now()) return expired();
    const row = await c.env.DB.query<ServerRow>('SELECT * FROM workspace_mcp_servers WHERE id = ?').bind(saved.server_id).first();
    if (!row || row.url !== saved.url) return appPage(c, 'Signing in failed', 'The server was removed or moved to another address meanwhile. Start again in the Pikibun app.', undefined, 400);
    try { await requireMember(c.env, row.workspace_id, saved.user_id, ['owner', 'admin']); }
    catch { return appPage(c, 'Signing in failed', 'Only an owner or admin of its workspace signs in to it.', undefined, 400); }
    await assertVaultConfigured(c.env);
    let client: McpOAuthClient;
    try { client = await registerClient(transport(c.env), await discoverOAuth(transport(c.env), row.url), appRedirectUri(c.env)); }
    catch (error) {
      const reason = `Signing in failed: ${failure(error)}`;
      await noteError(c.env, row.id, reason);
      return appPage(c, 'Signing in failed', `${reason}.`, undefined, 400);
    }
    const state = randomToken(); const verifier = randomToken();
    await c.env.DB.query('UPDATE mcp_oauth_app_sign_ins SET state_hash = ?, verifier = ?, client_ciphertext = ? WHERE id = ?')
      .bind(await sha256(state), verifier, await encryptToken(c.env, stateContext(row.id), JSON.stringify(client)), saved.id).run();
    const cookie = stateCookie(c.env, true);
    setCookie(c, cookie.name, state, { ...cookie.options, maxAge: STATE_TTL / 1000, expires: new Date(Number(saved.expires_at)) });
    return c.redirect(authorizationUrl(client, state, verifier), 302);
  });

  app.get(APP_CALLBACK_PATH, privateResponse, async c => {
    const state = callbackState(c, true);
    const expired = () => appPage(c, 'This sign-in has expired', APP_EXPIRED, undefined, 400);
    if (!state) return expired();
    const saved = await c.env.DB.query<AppSignInRow>(
      'UPDATE mcp_oauth_app_sign_ins SET state_hash = NULL WHERE state_hash = ? RETURNING id, server_id, user_id, url, verifier, client_ciphertext, expires_at')
      .bind(await sha256(state)).first();
    if (!saved || !saved.verifier || !saved.client_ciphertext || Number(saved.expires_at) < Date.now()) return expired();
    const declined = async (reason: string, serverId?: string) => {
      await c.env.DB.query('DELETE FROM mcp_oauth_app_sign_ins WHERE id = ?').bind(saved.id).run();
      if (serverId) await noteError(c.env, serverId, `Signing in failed: ${reason}`);
      return appPage(c, 'Signing in failed', `Signing in failed: ${reason}. Start again in the Pikibun app.`, undefined, 400);
    };
    const row = await c.env.DB.query<ServerRow>('SELECT * FROM workspace_mcp_servers WHERE id = ?').bind(saved.server_id).first();
    if (!row) return declined('the server was removed meanwhile');
    if (row.url !== saved.url) return declined('its address changed while signing in', row.id);
    let client: McpOAuthClient;
    try { client = JSON.parse(await decryptToken(c.env, stateContext(row.id), saved.client_ciphertext)) as McpOAuthClient; }
    catch { return declined('Pikibun couldn\'t read the sign-in it started', row.id); }
    const answer = callbackCode(c, client);
    if ('reason' in answer) return declined(answer.reason, row.id);
    let secret: McpOAuthSecret;
    try {
      secret = await tokenRequest(transport(c.env), client, { grant_type: 'authorization_code', code: answer.code, redirect_uri: client.redirectUri, code_verifier: saved.verifier });
    } catch (failed) { return declined(failure(failed), row.id); }
    const finish = randomToken();
    const kept = await c.env.DB.query(`UPDATE mcp_oauth_app_sign_ins SET finish_hash = ?, secret_ciphertext = ?, verifier = NULL, client_ciphertext = NULL, expires_at = ?
      WHERE id = ? RETURNING id`)
      .bind(await sha256(finish), await encryptToken(c.env, appSecretContext(saved.id), JSON.stringify(secret)), Date.now() + STATE_TTL, saved.id).first();
    if (!kept) return expired();
    return appPage(c, 'Almost signed in', `Go back to the Pikibun app to finish signing in to ${row.name}.`,
      { link: remoteMcpAppLink(appOrigin(c.env), finish), code: finish });
  });
}
