import type { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { compile } from '@earendil-works/pi-schema';
import { sha256 } from '../../../../../packages/shared/src/crypto.js';
import { z } from 'zod';
import { hasPermission } from '../../../../../packages/shared/src/policy.js';
import { extensionSwitchOn } from '../../../../../packages/shared/src/piki-extensions.js';
import {
  isRemoteMcpSignInAs, REMOTE_MCP_ALL_TOOLS, REMOTE_MCP_EXTENSION, REMOTE_MCP_SESSION_TOOLS, remoteMcpAppLink, remoteMcpHeaders, remoteMcpLimits, remoteMcpSessionTools, remoteMcpToolKey, remoteMcpToolName, remoteMcpUrl,
  validRemoteMcpPrefix, type McpServerSharer, type RemoteMcpServerSummary, type RemoteMcpSignInAs, type RemoteMcpTool, type WorkspaceMcpServer,
} from '../../../../../packages/shared/src/remote-mcp.js';
import type { BrokeredToolDefinition } from '../../../../../packages/shared/src/tool-definitions.js';
import type { AppContext, AppEnv, Env, SessionRow } from '../../types.js';
import { appOrigin, fail, id, identifier, now, randomToken, requireOrigin, text, userIdentifier } from '../../http.js';
import { body, fields } from '../../schemas.js';
import { requireMember, sessionAccess, workspaceAdminSQL, workspaceManagerRolesSQL } from '../access.js';
import { auditStatement } from '../audit.js';
import { privateResponse } from '../auth.js';
import { workspaceExtensions } from '../extension-policy.js';
import { requireCallbackScope } from '../hosts.js';
import { requireAdmission } from '../run-admissions.js';
import { requireToolCall } from '../tool-checks.js';
import { assertVaultConfigured, decryptToken, encryptToken } from '../vault.js';
import { callRemoteMcpTool } from './client.js';
import {
  broughtConnection, connectionAppBegin, connectionAppCallback, connectionAppFinish, connectionCredentials, connectionWebCallback, registerMcpConnections,
  sharedConnection, viewerConnections, type ConnectionRow,
} from './connections.js';
import {
  APP_BEGIN_PATH, APP_CALLBACK_PATH, APP_EXPIRED, appPage, appRedirectUri, callbackCode, callbackState, discover, discoveredDetail, exchangeCode, failure,
  oauthRedirectUri, parsedList, parsedTools, signInClient, STATE, STATE_TTL, stateCookie, transport, withCredentials,
  type Credentials, type OAuthKeeper, type SignInOwner,
} from './credentials.js';
import { authorizationUrl, clientMetadataDocument, clientMetadataDocumentUrl, MCP_CLIENT_METADATA_PATH, parseOAuthSecret, type McpOAuthClient, type McpOAuthSecret } from './oauth.js';

interface ServerRow {
  id: string; workspace_id: string; prefix: string; name: string; url: string; headers_ciphertext: string | null; header_names_json: string;
  read_only_tools_json: string; off_tools_json: string | null; tools_json: string; enabled: number | string; discovered_at: string | null; error: string | null; updated_at: string;
  oauth_ciphertext: string | null; oauth_by: string | null; oauth_at: string | null;
  tools_over_limit: number | string | null; tools_unusable: number | string | null; sign_in_as: RemoteMcpSignInAs; shared_connection_id: string | null;
}

const activeShareSQL = (server: string) => `(${server}.shared_connection_id IS NULL OR EXISTS (SELECT 1 FROM mcp_connections sc
  JOIN workspace_members sm ON sm.user_id = sc.user_id AND sm.workspace_id = ${server}.workspace_id AND sm.role IN (${workspaceManagerRolesSQL})
  WHERE sc.id = ${server}.shared_connection_id))`;

async function sharers(env: Env, workspaceId: string, viewer: string): Promise<Map<string, McpServerSharer>> {
  const rows = await env.DB.query<{ id: string; user_id: string; display_name: string; member: number | string | null }>(`SELECT c.id, c.user_id, u.display_name,
      (SELECT 1 FROM workspace_members m WHERE m.workspace_id = s.workspace_id AND m.user_id = c.user_id AND m.role IN (${workspaceManagerRolesSQL})) AS member
    FROM workspace_mcp_servers s JOIN mcp_connections c ON c.id = s.shared_connection_id JOIN users u ON u.id = c.user_id
    WHERE s.workspace_id = ?`).bind(workspaceId).all();
  return new Map(rows.map(row => [row.id, { userId: row.user_id, name: row.display_name, mine: row.user_id === viewer, active: Number(row.member) === 1 }]));
}

function notShared(row: ServerRow): void {
  if (row.shared_connection_id) {
    fail(409, 'mcp_server_shared', 'This server calls with the connection a member shared with this workspace: its address and sign-in are theirs, changed in their profile.'
      + ' Remove it here, or they stop sharing it, to use another sign-in.');
  }
}

const callBody = fields({ sessionId: z.unknown(), actorId: z.unknown(), admissionId: z.unknown(), callId: z.unknown(), arguments: z.unknown() },
  'Unexpected remote MCP call field.');
const addBody = fields({ name: z.unknown(), prefix: z.unknown(), url: z.unknown(), headers: z.unknown(), readOnlyTools: z.unknown(), signInAs: z.unknown() },
  'Only name, prefix, url, headers, readOnlyTools and signInAs are accepted.', { code: 'invalid_mcp_server' });
const changeBody = fields({ name: z.unknown(), url: z.unknown(), headers: z.unknown(), readOnlyTools: z.unknown(), offTools: z.unknown(), enabled: z.unknown(), signInAs: z.unknown(), refresh: z.unknown() },
  'Change name, url, headers, readOnlyTools, offTools, enabled or signInAs, or set refresh to true.', { code: 'invalid_mcp_server', some: true });

const changeBytes = 64 * 1024 + 4 * remoteMcpLimits.tools * 132;

const finishBody = fields({ code: z.unknown() }, 'Only code is accepted.');

const secretContext = (serverId: string) => `remote-mcp:${serverId}`;
const oauthContext = (serverId: string) => `remote-mcp-oauth:${serverId}`;
const stateContext = (serverId: string) => `remote-mcp-oauth-state:${serverId}`;
const appSecretContext = (signInId: string) => `remote-mcp-oauth-app:${signInId}`;

function view(row: ServerRow, mine?: { row: ConnectionRow; using: boolean }, sharedBy?: Map<string, McpServerSharer>): WorkspaceMcpServer {
  const sharer = row.shared_connection_id ? sharedBy?.get(row.shared_connection_id) : undefined;
  const readOnlyTools = parsedList(row.read_only_tools_json);
  const offTools = parsedList(row.off_tools_json ?? '[]');
  const readOnly = new Set(readOnlyTools);
  const off = new Set(offTools);
  const tools = parsedTools(row.tools_json).flatMap(tool => {
    const toolName = remoteMcpToolName(row.prefix, tool.name);
    return toolName ? [{ ...tool, toolName, readOnly: readOnly.has(tool.name), off: off.has(tool.name) }] : [];
  });
  const leftOut = { overLimit: Number(row.tools_over_limit) || 0, unusable: Number(row.tools_unusable) || 0 };
  return { id: row.id, name: row.name, prefix: row.prefix, url: row.url, enabled: Number(row.enabled) === 1, signInAs: row.sign_in_as ?? 'workspace',
    headerNames: parsedList(row.header_names_json),
    ...(row.oauth_ciphertext && row.oauth_at ? { oauth: { signedInAt: row.oauth_at } } : {}),
    ...(mine ? { connection: { id: mine.row.id, name: mine.row.name, using: mine.using, signedIn: !!(mine.row.oauth_ciphertext || mine.row.headers_ciphertext),
      ...(mine.row.error ? { error: mine.row.error } : {}) } } : {}),
    ...(sharer ? { sharedBy: sharer } : {}),
    readOnlyTools, offTools, tools,
    ...(leftOut.overLimit || leftOut.unusable ? { toolsLeftOut: leftOut } : {}), ...(row.discovered_at ? { discoveredAt: row.discovered_at } : {}), ...(row.error ? { error: row.error } : {}), updatedAt: row.updated_at };
}

function serverKeeper(env: Env, serverId: string): OAuthKeeper {
  return {
    context: oauthContext(serverId),
    owner: 'workspace',
    read: async () => (await env.DB.query<{ oauth_ciphertext: string | null }>('SELECT oauth_ciphertext FROM workspace_mcp_servers WHERE id = ?')
      .bind(serverId).first())?.oauth_ciphertext ?? null,
    swap: async (next, current) => !!await env.DB.query('UPDATE workspace_mcp_servers SET oauth_ciphertext = ? WHERE id = ? AND oauth_ciphertext = ? RETURNING id')
      .bind(next, serverId, current).first(),
  };
}

async function headersOf(env: Env, row: Pick<ServerRow, 'id' | 'headers_ciphertext'>): Promise<Record<string, string>> {
  if (!row.headers_ciphertext) return {};
  return JSON.parse(await decryptToken(env, secretContext(row.id), row.headers_ciphertext)) as Record<string, string>;
}

function workspaceCredentials(env: Env, serverId: string, headers: Record<string, string>, oauth: string | null): Credentials {
  return { headers, oauth: oauth ? { keeper: serverKeeper(env, serverId), ciphertext: oauth } : null };
}

const hasSignIn = (credentials: Credentials) => !!credentials.oauth || Object.keys(credentials.headers).length > 0;

interface Chosen { credentials: Credentials; owner: SignInOwner; connection?: string }

async function sharedCredentials(env: Env, row: ServerRow): Promise<Chosen | null> {
  const connection = row.shared_connection_id ? await sharedConnection(env, row.workspace_id, row.shared_connection_id) : null;
  return connection ? { credentials: await connectionCredentials(env, connection, 'sharer'), owner: 'sharer', connection: connection.id } : null;
}

async function chooseCredentials(env: Env, row: ServerRow, userId: string): Promise<Chosen | null> {
  if (row.shared_connection_id) return sharedCredentials(env, row);
  const shared = (): Promise<Chosen> => headersOf(env, row).then(headers => ({ credentials: workspaceCredentials(env, row.id, headers, row.oauth_ciphertext), owner: 'workspace' }));
  if (row.sign_in_as === 'workspace') return shared();
  const connection = await broughtConnection(env, row.workspace_id, row.url, userId);
  if (connection) return { credentials: await connectionCredentials(env, connection), owner: 'member', connection: connection.id };
  return row.sign_in_as === 'members-then-workspace' ? shared() : null;
}

async function keepSignIn(env: Env, row: ServerRow, actor: string, url: string, secret: McpOAuthSecret, detail: Record<string, unknown> = {}): Promise<boolean> {
  const ciphertext = await encryptToken(env, oauthContext(row.id), JSON.stringify(secret));
  const at = now();
  const signedIn = await env.DB.query(`UPDATE workspace_mcp_servers SET oauth_ciphertext = ?, oauth_by = ?, oauth_at = ?, updated_by = ?, updated_at = ?
    WHERE id = ? AND url = ? AND ${workspaceAdminSQL} RETURNING id`)
    .bind(ciphertext, actor, at, actor, at, row.id, url, row.workspace_id, actor).first();
  if (!signedIn) return false;
  const found = await discover(env, row.url, workspaceCredentials(env, row.id, await headersOf(env, row), ciphertext));
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

async function noteError(env: Env, serverId: string, error: string): Promise<void> {
  await env.DB.query('UPDATE workspace_mcp_servers SET error = ? WHERE id = ?').bind(error.slice(0, 500), serverId).run();
}

function settingsPage(c: AppContext, workspaceId: string): Response {
  return c.redirect(`${appOrigin(c.env)}/#/settings/workspaces/${encodeURIComponent(workspaceId)}`, 302);
}

function toolList(value: unknown, field: 'readOnlyTools' | 'offTools', limit: number = remoteMcpLimits.tools): string[] {
  if (!Array.isArray(value) || value.length > limit || value.some(item => typeof item !== 'string' || !item || item.length > 128)) {
    fail(400, 'invalid_mcp_server', `${field} must list at most ${limit} tool names.`);
  }
  return [...new Set(value as string[])];
}

const readOnlyList = (value: unknown) => toolList(value, 'readOnlyTools');

const sentToolList = (value: unknown, field: 'readOnlyTools' | 'offTools') => value === undefined ? undefined : toolList(value, field, 2 * remoteMcpLimits.tools);

function nameOf(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > remoteMcpLimits.name || /[\r\n\0]/.test(value)) {
    fail(400, 'invalid_mcp_server', `name must be one line of at most ${remoteMcpLimits.name} characters.`);
  }
  return value.trim();
}

function signInAsOf(value: unknown): RemoteMcpSignInAs {
  if (!isRemoteMcpSignInAs(value)) fail(400, 'invalid_mcp_server', 'signInAs must be workspace, members or members-then-workspace.');
  return value;
}

function checked<T>(make: () => T): T {
  try { return make(); } catch (error) { return fail(400, 'invalid_mcp_server', error instanceof Error ? error.message : 'Invalid remote MCP server.'); }
}

async function serverRow(env: Env, workspaceId: string, serverId: string): Promise<ServerRow> {
  return await env.DB.query<ServerRow>('SELECT * FROM workspace_mcp_servers WHERE id = ? AND workspace_id = ?').bind(serverId, workspaceId).first()
    ?? fail(404, 'not_found', 'Remote MCP server not found.');
}

async function serverView(env: Env, workspaceId: string, serverId: string, viewer: string): Promise<WorkspaceMcpServer> {
  const row = await serverRow(env, workspaceId, serverId);
  return view(row, (await viewerConnections(env, workspaceId, viewer)).get(row.url), await sharers(env, workspaceId, viewer));
}

export async function workspaceRemoteTools(env: Env, workspaceId: string, all = false): Promise<{ tools: BrokeredToolDefinition[]; servers: RemoteMcpServerSummary[] }> {
  const limit = all ? REMOTE_MCP_ALL_TOOLS : REMOTE_MCP_SESSION_TOOLS;
  const rows = await env.DB.query<ServerRow>(`SELECT * FROM workspace_mcp_servers s WHERE s.workspace_id = ? AND s.enabled = 1 AND ${activeShareSQL('s')}
    ORDER BY s.created_at, s.prefix`).bind(workspaceId).all();
  const shared = remoteMcpSessionTools(rows.map(row => ({ name: row.name, prefix: row.prefix, readOnlyTools: parsedList(row.read_only_tools_json),
    offTools: parsedList(row.off_tools_json ?? '[]'), tools: parsedTools(row.tools_json) })), limit);
  return {
    tools: shared.definitions,
    servers: rows.flatMap((row, index) => shared.offered[index] ? [{ prefix: row.prefix, name: row.name }] : []),
  };
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
    if (parsedList(server.off_tools_json ?? '[]').includes(tool.name)) {
      fail(404, 'mcp_tool_not_found', `${toolName} is turned off in this workspace: its owners and admins turn it on again on the settings page. Nothing ran.`);
    }
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
  const chosen = await chooseCredentials(c.env, server, actorId);
  if (!chosen && server.shared_connection_id) {
    fail(403, 'mcp_share_ended', `${server.name} calls with the connection a member shared with this workspace, and they are no longer one of its owners or admins. Nothing ran.`);
  }
  if (!chosen) {
    fail(403, 'mcp_connection_required', `${server.name} signs in with each member's own account, and the requester brought none to this workspace: they connect it under`
      + ' Settings → Profile → Connected accounts, then use it in this workspace. Nothing ran.');
  }
  const used = chosen.connection ? { connection: chosen.connection } : {};
  let result;
  try {
    result = await withCredentials(c.env, chosen.credentials, headers => callRemoteMcpTool(transport(c.env), server.url, headers, tool.name, args as Record<string, unknown>));
  } catch (error) {
    await auditStatement(c.env, actorId, 'workspace.mcp.called', row.workspace_id, sessionId, { server: server.id, tool: tool.name, write, ...used, failed: true }).run();
    return fail(502, 'mcp_call_failed', `${server.name}: ${failure(error, !!chosen.credentials.oauth, chosen.owner)}`);
  }
  await authorize();
  await auditStatement(c.env, actorId, 'workspace.mcp.called', row.workspace_id, sessionId,
    { server: server.id, tool: tool.name, write, ...used, ...(result.isError ? { isError: true } : {}) }).run();
  return c.json({ server: server.name, tool: tool.name, ...result });
}

export function registerRemoteMcp(app: Hono<AppEnv>): void {
  registerMcpConnections(app);

  app.get('/api/workspaces/:id/mcp-servers', async c => {
    const workspaceId = identifier(c.req.param('id'));
    const actor = c.get('auth').userId;
    const member = await requireMember(c.env, workspaceId, actor);
    const rows = await c.env.DB.query<ServerRow>('SELECT * FROM workspace_mcp_servers WHERE workspace_id = ? ORDER BY created_at, prefix').bind(workspaceId).all();
    const mine = await viewerConnections(c.env, workspaceId, actor);
    const sharedBy = await sharers(c.env, workspaceId, actor);
    return c.json({ servers: rows.map(row => view(row, mine.get(row.url), sharedBy)), admin: member.role === 'owner' || member.role === 'admin' });
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
    const signInAs = input.signInAs === undefined ? 'workspace' : signInAsOf(input.signInAs);
    const serverId = id(); const at = now();
    const found = await discover(c.env, url, workspaceCredentials(c.env, serverId, headers, null));
    const ciphertext = Object.keys(headers).length ? await encryptToken(c.env, secretContext(serverId), JSON.stringify(headers)) : null;
    const saved = await c.env.DB.query<{ id: string }>(`INSERT INTO workspace_mcp_servers (id, workspace_id, prefix, name, url, headers_ciphertext, header_names_json,
        read_only_tools_json, tools_json, tools_over_limit, tools_unusable, enabled, sign_in_as, discovered_at, error, created_by, updated_by, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ? WHERE ${workspaceAdminSQL}
        AND (SELECT COUNT(*) FROM workspace_mcp_servers WHERE workspace_id = ?) < ?
        AND NOT EXISTS (SELECT 1 FROM workspace_mcp_servers WHERE workspace_id = ? AND prefix = ?)
      RETURNING id`)
      .bind(serverId, workspaceId, prefix, name, url, ciphertext, JSON.stringify(Object.keys(headers)), JSON.stringify(readOnlyTools), JSON.stringify(found.tools),
        found.leftOut.overLimit, found.leftOut.unusable, signInAs, found.error ? null : at, found.error, actor, actor, at, at, workspaceId, actor, workspaceId,
        remoteMcpLimits.servers, workspaceId, prefix).first();
    if (!saved) {
      await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
      if (await c.env.DB.query('SELECT 1 FROM workspace_mcp_servers WHERE workspace_id = ? AND prefix = ?').bind(workspaceId, prefix).first()) {
        fail(409, 'mcp_prefix_taken', `Another remote MCP server of this workspace already uses the prefix ${prefix}.`);
      }
      fail(409, 'mcp_server_limit', `A workspace has at most ${remoteMcpLimits.servers} remote MCP servers.`);
    }
    await auditStatement(c.env, actor, 'workspace.mcp.added', workspaceId, null,
      { server: serverId, name, prefix, url, headers: Object.keys(headers), readOnlyTools, ...(signInAs !== 'workspace' ? { signInAs } : {}), ...discoveredDetail(found) }).run();
    return c.json({ server: await serverView(c.env, workspaceId, serverId, actor) }, 201);
  });

  app.patch('/api/workspaces/:id/mcp-servers/:serverId', async c => {
    const workspaceId = identifier(c.req.param('id')); const actor = c.get('auth').userId;
    const serverId = identifier(c.req.param('serverId'), 'serverId');
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    const input = await body(c, changeBody, { maxBytes: changeBytes });
    const keys = Object.keys(input).filter(name => input[name as keyof typeof input] !== undefined);
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') fail(400, 'invalid_mcp_server', 'enabled must be true or false.');
    if (input.refresh !== undefined && input.refresh !== true) fail(400, 'invalid_mcp_server', 'refresh must be true.');
    const row = await serverRow(c.env, workspaceId, serverId);
    if (input.url !== undefined || input.headers !== undefined || input.signInAs !== undefined) notShared(row);
    const name = input.name === undefined ? row.name : nameOf(input.name);
    const url = input.url === undefined ? row.url : checked(() => remoteMcpUrl(input.url));
    if (url !== row.url && input.headers === undefined) {
      fail(400, 'mcp_headers_required', 'Give this server\'s headers again with its new address, or an empty set to send none: Pikibun never sends the headers it keeps for one address to another.');
    }
    const headers = input.headers === undefined ? await headersOf(c.env, row) : input.headers === null ? {} : checked(() => remoteMcpHeaders(input.headers));
    const sentReadOnly = sentToolList(input.readOnlyTools, 'readOnlyTools');
    const sentOff = sentToolList(input.offTools, 'offTools');
    const enabled = input.enabled === undefined ? Number(row.enabled) === 1 : input.enabled as boolean;
    const signInAs = input.signInAs === undefined ? row.sign_in_as : signInAsOf(input.signInAs);
    const moved = url !== row.url;
    const replaced = input.headers !== undefined && Object.keys(headers).some(name => name.toLowerCase() === 'authorization');
    const signOut = moved || replaced;
    const reach = input.refresh === true || input.url !== undefined || input.headers !== undefined || (input.signInAs !== undefined && signInAs !== row.sign_in_as);
    let lister = workspaceCredentials(c.env, serverId, headers, signOut ? null : row.oauth_ciphertext);
    let listedBy: SignInOwner = 'workspace';
    if (reach && row.shared_connection_id) {
      const sharer = await sharedCredentials(c.env, row)
        ?? fail(409, 'mcp_share_ended', 'The member who shared this server\'s connection is no longer an owner or admin of this workspace, so its tools can\'t be listed: remove it.');
      lister = sharer.credentials; listedBy = 'sharer';
    } else if (reach && signInAs !== 'workspace' && !hasSignIn(lister)) {
      const own = await broughtConnection(c.env, workspaceId, url, actor);
      if (own) { lister = await connectionCredentials(c.env, own); listedBy = 'member'; }
    }
    const found = reach ? await discover(c.env, url, lister, listedBy) : undefined;
    const listed = new Set((found && !found.error ? found.tools : parsedTools(row.tools_json)).map(tool => tool.name));
    const readOnlyTools = sentReadOnly?.filter(item => listed.has(item)) ?? parsedList(row.read_only_tools_json);
    const offTools = sentOff?.filter(item => listed.has(item)) ?? parsedList(row.off_tools_json ?? '[]');
    const at = now();
    const ciphertext = input.headers === undefined ? row.headers_ciphertext
      : Object.keys(headers).length ? await encryptToken(c.env, secretContext(serverId), JSON.stringify(headers)) : null;
    const saved = await c.env.DB.query<{ id: string }>(`UPDATE workspace_mcp_servers SET name = ?, url = ?, headers_ciphertext = ?, header_names_json = ?,
        read_only_tools_json = ?, off_tools_json = ?, tools_json = ?, tools_over_limit = ?, tools_unusable = ?, enabled = ?, sign_in_as = ?, discovered_at = ?, error = ?, updated_by = ?, updated_at = ?,
        oauth_ciphertext = CASE WHEN ? = 1 THEN NULL ELSE oauth_ciphertext END, oauth_by = CASE WHEN ? = 1 THEN NULL ELSE oauth_by END,
        oauth_at = CASE WHEN ? = 1 THEN NULL ELSE oauth_at END
      WHERE id = ? AND workspace_id = ? AND ${workspaceAdminSQL} RETURNING id`)
      .bind(name, url, ciphertext, JSON.stringify(Object.keys(headers)), JSON.stringify(readOnlyTools), JSON.stringify(offTools),
        found && !found.error ? JSON.stringify(found.tools) : row.tools_json,
        found && !found.error ? found.leftOut.overLimit : Number(row.tools_over_limit) || 0, found && !found.error ? found.leftOut.unusable : Number(row.tools_unusable) || 0,
        enabled ? 1 : 0, signInAs,
        found ? (found.error ? row.discovered_at : at) : row.discovered_at, found ? found.error : row.error, actor, at, signOut ? 1 : 0, signOut ? 1 : 0, signOut ? 1 : 0,
        serverId, workspaceId, workspaceId, actor).first();
    if (!saved) {
      await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
      fail(404, 'not_found', 'Remote MCP server not found.');
    }
    await auditStatement(c.env, actor, 'workspace.mcp.updated', workspaceId, null, {
      server: serverId, changed: keys.filter(item => item !== 'refresh'), ...(input.url !== undefined ? { url } : {}), ...(input.headers !== undefined ? { headers: Object.keys(headers) } : {}),
      ...(input.readOnlyTools !== undefined ? { readOnlyTools } : {}), ...(input.offTools !== undefined ? { offTools } : {}), ...(input.enabled !== undefined ? { enabled } : {}),
      ...(input.signInAs !== undefined ? { signInAs } : {}), ...(signOut && row.oauth_ciphertext ? { signedOut: true } : {}),
      ...(found ? { ...discoveredDetail(found), ...(listedBy === 'member' ? { listedWithOwnConnection: true } : {}) } : {}),
    }).run();
    return c.json({ server: await serverView(c.env, workspaceId, serverId, actor) });
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
    notShared(row);
    let client: McpOAuthClient;
    try { client = await signInClient(c.env, row.url, oauthRedirectUri(c.env)); }
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
    const stateHash = await sha256(state);
    const saved = await c.env.DB.query<{ server_id: string; user_id: string; url: string; verifier: string; client_ciphertext: string; expires_at: number | string }>(
      'DELETE FROM mcp_oauth_states WHERE state_hash = ? RETURNING server_id, user_id, url, verifier, client_ciphertext, expires_at').bind(stateHash).first();
    if (!saved) {
      const personal = await connectionWebCallback(c, stateHash, actor);
      if (personal) return personal;
    }
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
    try { secret = await exchangeCode(c.env, client, answer.code, saved.verifier); }
    catch (failed) { return declined(failure(failed)); }
    if (!await keepSignIn(c.env, row, actor, saved.url, secret)) return declined('the server or your role changed while signing in');
    return settingsPage(c, row.workspace_id);
  });

  app.post('/api/workspaces/:id/mcp-servers/:serverId/oauth/app', async c => {
    const workspaceId = identifier(c.req.param('id')); const actor = c.get('auth').userId;
    const serverId = identifier(c.req.param('serverId'), 'serverId');
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    await assertVaultConfigured(c.env);
    const row = await serverRow(c.env, workspaceId, serverId);
    notShared(row);
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
    const codeHash = await sha256(code);
    const saved = await c.env.DB.query<{ id: string; server_id: string; user_id: string; url: string; secret_ciphertext: string | null; expires_at: number | string }>(
      'DELETE FROM mcp_oauth_app_sign_ins WHERE finish_hash = ? RETURNING id, server_id, user_id, url, secret_ciphertext, expires_at').bind(codeHash).first();
    if (!saved) return await connectionAppFinish(c, codeHash, actor) ?? expired();
    if (!saved.secret_ciphertext || Number(saved.expires_at) < Date.now()) return expired();
    if (saved.user_id !== actor) fail(403, 'not_your_sign_in', 'This code finishes a sign-in someone else started: only their Pikibun app can use it. Nothing was kept.');
    const row = await c.env.DB.query<ServerRow>('SELECT * FROM workspace_mcp_servers WHERE id = ?').bind(saved.server_id).first()
      ?? fail(404, 'not_found', 'Remote MCP server not found.');
    await requireMember(c.env, row.workspace_id, actor, ['owner', 'admin']);
    if (row.url !== saved.url) fail(409, 'mcp_server_changed', 'Its address changed while signing in: sign in to it again.');
    let secret: McpOAuthSecret;
    try { secret = parseOAuthSecret(await decryptToken(c.env, appSecretContext(saved.id), saved.secret_ciphertext)); }
    catch { return expired(); }
    if (!await keepSignIn(c.env, row, actor, saved.url, secret, { via: 'app' })) fail(409, 'mcp_server_changed', 'The server or your role changed while signing in.');
    return c.json({ workspaceId: row.workspace_id, server: await serverView(c.env, row.workspace_id, row.id, actor) });
  });

  app.delete('/api/workspaces/:id/mcp-servers/:serverId/oauth', async c => {
    const workspaceId = identifier(c.req.param('id')); const actor = c.get('auth').userId;
    const serverId = identifier(c.req.param('serverId'), 'serverId');
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    const row = await serverRow(c.env, workspaceId, serverId);
    notShared(row);
    const at = now();
    await c.env.DB.batch([
      c.env.DB.query(`UPDATE workspace_mcp_servers SET oauth_ciphertext = NULL, oauth_by = NULL, oauth_at = NULL, updated_by = ?, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND ${workspaceAdminSQL} RETURNING id`).bind(actor, at, serverId, workspaceId, workspaceId, actor),
      auditStatement(c.env, actor, 'workspace.mcp.signed_out', workspaceId, null, { server: serverId, prefix: row.prefix }),
    ]);
    return c.json({ server: await serverView(c.env, workspaceId, serverId, actor) });
  });
}

interface AppSignInRow {
  id: string; server_id: string; user_id: string; url: string; verifier: string | null; client_ciphertext: string | null; expires_at: number | string;
}

export function registerRemoteMcpAppPages(app: Hono<AppEnv>): void {
  app.get(MCP_CLIENT_METADATA_PATH, c => {
    const origin = appOrigin(c.env);
    if (!clientMetadataDocumentUrl(origin)) fail(404, 'not_found', 'This Pikibun server, not served over https://, has no OAuth client metadata document.');
    c.header('Cache-Control', 'public, max-age=300');
    return c.json(clientMetadataDocument(origin, [oauthRedirectUri(c.env), appRedirectUri(c.env)]));
  });
  app.get(APP_BEGIN_PATH, privateResponse, async c => {
    requireOrigin(c);
    const tokens = c.req.queries('token');
    const token = tokens?.length === 1 ? tokens[0]! : '';
    const expired = () => appPage(c, 'This sign-in link has expired', APP_EXPIRED, undefined, 400);
    if (!STATE.test(token)) return expired();
    const tokenHash = await sha256(token);
    const saved = await c.env.DB.query<AppSignInRow>(
      'UPDATE mcp_oauth_app_sign_ins SET begin_hash = NULL WHERE begin_hash = ? RETURNING id, server_id, user_id, url, verifier, client_ciphertext, expires_at')
      .bind(tokenHash).first();
    if (!saved) return await connectionAppBegin(c, tokenHash) ?? expired();
    if (Number(saved.expires_at) < Date.now()) return expired();
    const row = await c.env.DB.query<ServerRow>('SELECT * FROM workspace_mcp_servers WHERE id = ?').bind(saved.server_id).first();
    if (!row || row.url !== saved.url) return appPage(c, 'Signing in failed', 'The server was removed or moved to another address meanwhile. Start again in the Pikibun app.', undefined, 400);
    try { await requireMember(c.env, row.workspace_id, saved.user_id, ['owner', 'admin']); }
    catch { return appPage(c, 'Signing in failed', 'Only an owner or admin of its workspace signs in to it.', undefined, 400); }
    await assertVaultConfigured(c.env);
    let client: McpOAuthClient;
    try { client = await signInClient(c.env, row.url, appRedirectUri(c.env)); }
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
    const stateHash = await sha256(state);
    const saved = await c.env.DB.query<AppSignInRow>(
      'UPDATE mcp_oauth_app_sign_ins SET state_hash = NULL WHERE state_hash = ? RETURNING id, server_id, user_id, url, verifier, client_ciphertext, expires_at')
      .bind(stateHash).first();
    if (!saved) return await connectionAppCallback(c, stateHash) ?? expired();
    if (!saved.verifier || !saved.client_ciphertext || Number(saved.expires_at) < Date.now()) return expired();
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
    try { secret = await exchangeCode(c.env, client, answer.code, saved.verifier); }
    catch (failed) { return declined(failure(failed), row.id); }
    const finish = randomToken();
    const kept = await c.env.DB.query(`UPDATE mcp_oauth_app_sign_ins SET finish_hash = ?, secret_ciphertext = ?, verifier = NULL, client_ciphertext = NULL, expires_at = ?
      WHERE id = ? RETURNING id`)
      .bind(await sha256(finish), await encryptToken(c.env, appSecretContext(saved.id), JSON.stringify(secret)), Date.now() + STATE_TTL, saved.id).first();
    if (!kept) return expired();
    return appPage(c, 'Almost signed in', `Go back to the Pikibun app to finish signing in to ${row.name}.`,
      { link: remoteMcpAppLink(appOrigin(c.env), finish), code: finish });
  });
}
