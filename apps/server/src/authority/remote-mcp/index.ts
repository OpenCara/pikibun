import type { Hono } from 'hono';
import { compile } from '@earendil-works/pi-schema';
import { z } from 'zod';
import { hasPermission } from '../../../../../packages/shared/src/policy.js';
import { extensionSwitchOn } from '../../../../../packages/shared/src/piki-extensions.js';
import {
  REMOTE_MCP_EXTENSION, remoteMcpDefinitions, remoteMcpHeaders, remoteMcpLimits, remoteMcpToolKey, remoteMcpToolName, remoteMcpUrl, validRemoteMcpPrefix,
  type RemoteMcpServerSummary, type RemoteMcpTool, type RemoteMcpTransport, type WorkspaceMcpServer,
} from '../../../../../packages/shared/src/remote-mcp.js';
import type { BrokeredToolDefinition } from '../../../../../packages/shared/src/tool-definitions.js';
import type { AppContext, AppEnv, Env, SessionRow } from '../../types.js';
import { fail, id, identifier, now, text, userIdentifier } from '../../http.js';
import { body, fields } from '../../schemas.js';
import { requireMember, sessionAccess, workspaceAdminSQL } from '../access.js';
import { auditStatement } from '../audit.js';
import { workspaceExtensions } from '../extension-policy.js';
import { requireCallbackScope } from '../hosts.js';
import { admissionExpired } from '../run-admissions.js';
import { requireToolCall } from '../tool-checks.js';
import { decryptToken, encryptToken } from '../vault.js';
import { callRemoteMcpTool, discoverRemoteMcpTools, RemoteMcpError } from './client.js';
import { publicHttpsTransport, RemoteMcpRefused } from './transport.js';

interface ServerRow {
  id: string; workspace_id: string; prefix: string; name: string; url: string; headers_ciphertext: string | null; header_names_json: string;
  read_only_tools_json: string; tools_json: string; enabled: number | string; discovered_at: string | null; error: string | null; updated_at: string;
}

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
const parsedList = (json: string): string[] => { try { const value = JSON.parse(json); return Array.isArray(value) ? value.filter(item => typeof item === 'string') : []; } catch { return []; } };
const parsedTools = (json: string): RemoteMcpTool[] => { try { const value = JSON.parse(json); return Array.isArray(value) ? value as RemoteMcpTool[] : []; } catch { return []; } };

function view(row: ServerRow): WorkspaceMcpServer {
  const readOnlyTools = parsedList(row.read_only_tools_json);
  const tools = parsedTools(row.tools_json).flatMap(tool => {
    const toolName = remoteMcpToolName(row.prefix, tool.name);
    return toolName ? [{ ...tool, toolName, readOnly: readOnlyTools.includes(tool.name) }] : [];
  });
  return { id: row.id, name: row.name, prefix: row.prefix, url: row.url, enabled: Number(row.enabled) === 1, headerNames: parsedList(row.header_names_json),
    readOnlyTools, tools, ...(row.discovered_at ? { discoveredAt: row.discovered_at } : {}), ...(row.error ? { error: row.error } : {}), updatedAt: row.updated_at };
}

function failure(error: unknown): string {
  if (error instanceof RemoteMcpError || error instanceof RemoteMcpRefused) return error.message.slice(0, 500);
  return `It couldn't be reached: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`;
}

async function headersOf(env: Env, row: Pick<ServerRow, 'id' | 'headers_ciphertext'>): Promise<Record<string, string>> {
  if (!row.headers_ciphertext) return {};
  return JSON.parse(await decryptToken(env, secretContext(row.id), row.headers_ciphertext)) as Record<string, string>;
}

async function discover(env: Env, url: string, headers: Record<string, string>): Promise<{ tools: RemoteMcpTool[]; error: string | null }> {
  try { return { tools: await discoverRemoteMcpTools(transport(env), url, headers), error: null }; }
  catch (error) { return { tools: [], error: failure(error) }; }
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
    const admission = await c.env.DB.query<{ id: string; session_id: string; actor_id: string; mode: string; access: string | null; expires_at: number }>(
      'SELECT id, session_id, actor_id, mode, access, expires_at FROM run_admissions WHERE id = ?').bind(admissionId).first();
    if (!admission || admission.session_id !== sessionId || admission.actor_id !== actorId || admission.mode !== 'write'
      || await admissionExpired(c.env, admissionId, admission)) {
      fail(403, 'mcp_call_not_admitted', 'Remote MCP tools need a message from the requester sent within the last hour, or whose run is still going.');
    }
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
  const headers = await headersOf(c.env, server);
  let result;
  try { result = await callRemoteMcpTool(transport(c.env), server.url, headers, tool.name, args as Record<string, unknown>); }
  catch (error) {
    await auditStatement(c.env, actorId, 'workspace.mcp.called', row.workspace_id, sessionId, { server: server.id, tool: tool.name, write, failed: true }).run();
    return fail(502, 'mcp_call_failed', `${server.name}: ${failure(error)}`);
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
    const found = await discover(c.env, url, headers);
    const serverId = id(); const at = now();
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
    const reach = input.refresh === true || input.url !== undefined || input.headers !== undefined;
    const found = reach ? await discover(c.env, url, headers) : undefined;
    const at = now();
    const ciphertext = input.headers === undefined ? row.headers_ciphertext
      : Object.keys(headers).length ? await encryptToken(c.env, secretContext(serverId), JSON.stringify(headers)) : null;
    const saved = await c.env.DB.query<{ id: string }>(`UPDATE workspace_mcp_servers SET name = ?, url = ?, headers_ciphertext = ?, header_names_json = ?,
        read_only_tools_json = ?, tools_json = ?, enabled = ?, discovered_at = ?, error = ?, updated_by = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ? AND ${workspaceAdminSQL} RETURNING id`)
      .bind(name, url, ciphertext, JSON.stringify(Object.keys(headers)), JSON.stringify(readOnlyTools),
        found && !found.error ? JSON.stringify(found.tools) : row.tools_json, enabled ? 1 : 0,
        found ? (found.error ? row.discovered_at : at) : row.discovered_at, found ? found.error : row.error, actor, at, serverId, workspaceId, workspaceId, actor).first();
    if (!saved) {
      await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
      fail(404, 'not_found', 'Remote MCP server not found.');
    }
    await auditStatement(c.env, actor, 'workspace.mcp.updated', workspaceId, null, {
      server: serverId, changed: keys.filter(item => item !== 'refresh'), ...(input.url !== undefined ? { url } : {}), ...(input.headers !== undefined ? { headers: Object.keys(headers) } : {}),
      ...(input.readOnlyTools !== undefined ? { readOnlyTools } : {}), ...(input.enabled !== undefined ? { enabled } : {}),
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
}
