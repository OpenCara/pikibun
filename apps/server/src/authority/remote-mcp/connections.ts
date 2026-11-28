import type { Hono } from 'hono';
import { z } from 'zod';
import { sha256 } from '../../../../../packages/shared/src/crypto.js';
import { workspaceManagerRoles } from '../../../../../packages/shared/src/policy.js';
import {
  remoteMcpAppLink, remoteMcpHeaders, remoteMcpLimits, remoteMcpSharedPrefix, remoteMcpUrl, type McpConnection, type McpConnectionShare,
} from '../../../../../packages/shared/src/remote-mcp.js';
import type { AppContext, AppEnv, Env } from '../../types.js';
import { appOrigin, fail, id, identifier, now, randomToken, requireOrigin } from '../../http.js';
import { body, fields } from '../../schemas.js';
import { requireMember, workspaceManagerRolesSQL } from '../access.js';
import { auditStatement } from '../audit.js';
import { assertVaultConfigured, decryptToken, encryptToken } from '../vault.js';
import {
  APP_EXPIRED, appPage, appRedirectUri, callbackCode, discover, discoveredDetail, exchangeCode, failure, oauthRedirectUri, setStateCookie, signInClient, STATE_TTL,
  type Credentials, type Discovered, type OAuthKeeper, type SignInOwner,
} from './credentials.js';
import { authorizationUrl, parseOAuthSecret, type McpOAuthClient, type McpOAuthSecret } from './oauth.js';

export interface ConnectionRow {
  id: string; user_id: string; name: string; url: string; headers_ciphertext: string | null; header_names_json: string;
  oauth_ciphertext: string | null; oauth_at: string | null; error: string | null; created_at: string; updated_at: string;
}

interface SignInRow {
  id: string; connection_id: string; user_id: string; url: string; verifier: string | null; client_ciphertext: string | null;
  secret_ciphertext: string | null; expires_at: number | string;
}

const headersContext = (connectionId: string) => `mcp-connection:${connectionId}`;
const oauthContext = (connectionId: string) => `mcp-connection-oauth:${connectionId}`;
const stateContext = (connectionId: string) => `mcp-connection-oauth-state:${connectionId}`;
const appSecretContext = (signInId: string) => `mcp-connection-oauth-app:${signInId}`;
const parsedNames = (json: string): string[] => { try { const value = JSON.parse(json); return Array.isArray(value) ? value.filter(item => typeof item === 'string') : []; } catch { return []; } };
const notDeleted = (workspace: string) => `NOT EXISTS (SELECT 1 FROM deleted_workspaces dw WHERE dw.workspace_id = ${workspace})`;

const addBody = fields({ name: z.unknown(), url: z.unknown(), headers: z.unknown() }, 'Only name, url and headers are accepted.', { code: 'invalid_mcp_connection' });
const changeBody = fields({ name: z.unknown(), headers: z.unknown(), refresh: z.unknown() },
  'Change name or headers, or set refresh to true.', { code: 'invalid_mcp_connection', some: true });

export function connectionKeeper(env: Env, connectionId: string, owner: SignInOwner = 'member'): OAuthKeeper {
  return {
    context: oauthContext(connectionId),
    owner,
    read: async () => (await env.DB.query<{ oauth_ciphertext: string | null }>('SELECT oauth_ciphertext FROM mcp_connections WHERE id = ?')
      .bind(connectionId).first())?.oauth_ciphertext ?? null,
    swap: async (next, current) => !!await env.DB.query('UPDATE mcp_connections SET oauth_ciphertext = ? WHERE id = ? AND oauth_ciphertext = ? RETURNING id')
      .bind(next, connectionId, current).first(),
  };
}

export async function connectionCredentials(env: Env, row: Pick<ConnectionRow, 'id' | 'headers_ciphertext' | 'oauth_ciphertext'>,
  owner: SignInOwner = 'member'): Promise<Credentials> {
  const headers = row.headers_ciphertext ? JSON.parse(await decryptToken(env, headersContext(row.id), row.headers_ciphertext)) as Record<string, string> : {};
  return { headers, oauth: row.oauth_ciphertext ? { keeper: connectionKeeper(env, row.id, owner), ciphertext: row.oauth_ciphertext } : null };
}

export const shareLiveSQL = (server: string, connection: string, member: string) => `(${server}.share_status = 'accepted'
  AND (${member}.role IN (${workspaceManagerRolesSQL})
    OR (${server}.accepted_by IS NOT NULL AND ${server}.accepted_by <> ${connection}.user_id AND ${member}.created_at <= ${server}.accepted_at)))`;

export async function sharedConnection(env: Env, workspaceId: string, connectionId: string, pending = false): Promise<ConnectionRow | null> {
  return await env.DB.query<ConnectionRow>(`SELECT c.* FROM mcp_connections c
      JOIN workspace_mcp_servers s ON s.workspace_id = ? AND s.shared_connection_id = c.id
      JOIN workspace_members m ON m.workspace_id = s.workspace_id AND m.user_id = c.user_id
    WHERE c.id = ? AND (${shareLiveSQL('s', 'c', 'm')}${pending ? " OR s.share_status = 'pending'" : ''})`).bind(workspaceId, connectionId).first() ?? null;
}

export async function broughtConnection(env: Env, workspaceId: string, url: string, userId: string): Promise<ConnectionRow | null> {
  return await env.DB.query<ConnectionRow>(`SELECT c.* FROM mcp_connections c
      JOIN mcp_connection_workspaces w ON w.connection_id = c.id AND w.workspace_id = ?
      JOIN workspace_members m ON m.workspace_id = w.workspace_id AND m.user_id = c.user_id
    WHERE c.user_id = ? AND c.url = ?`).bind(workspaceId, userId, url).first() ?? null;
}

export async function viewerConnections(env: Env, workspaceId: string, userId: string): Promise<Map<string, { row: ConnectionRow; using: boolean }>> {
  const rows = await env.DB.query<ConnectionRow & { brought: number | string | null }>(`SELECT c.*,
      (SELECT 1 FROM mcp_connection_workspaces w WHERE w.connection_id = c.id AND w.workspace_id = ?) AS brought
    FROM mcp_connections c WHERE c.user_id = ? AND c.url IN (SELECT url FROM workspace_mcp_servers WHERE workspace_id = ?)`)
    .bind(workspaceId, userId, workspaceId).all();
  return new Map(rows.map(row => [row.url, { row, using: Number(row.brought) === 1 }]));
}

function nameOf(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > remoteMcpLimits.name || /[\r\n\0]/.test(value)) {
    fail(400, 'invalid_mcp_connection', `name must be one line of at most ${remoteMcpLimits.name} characters.`);
  }
  return value.trim();
}

function checked<T>(make: () => T): T {
  try { return make(); } catch (error) { return fail(400, 'invalid_mcp_connection', error instanceof Error ? error.message : 'Invalid connection.'); }
}

async function ownRow(env: Env, userId: string, connectionId: string): Promise<ConnectionRow> {
  return await env.DB.query<ConnectionRow>('SELECT * FROM mcp_connections WHERE id = ? AND user_id = ?').bind(connectionId, userId).first()
    ?? fail(404, 'not_found', 'Connection not found.');
}

async function views(env: Env, userId: string, rows: ConnectionRow[]): Promise<McpConnection[]> {
  if (!rows.length) return [];
  const brought = await env.DB.query<{ connection_id: string; id: string; name: string }>(`SELECT w.connection_id, ws.id, ws.name
      FROM mcp_connection_workspaces w JOIN mcp_connections c ON c.id = w.connection_id
      JOIN workspaces ws ON ws.id = w.workspace_id JOIN workspace_members m ON m.workspace_id = ws.id AND m.user_id = c.user_id
    WHERE c.user_id = ? AND ${notDeleted('ws.id')} ORDER BY ws.name, ws.id`).bind(userId).all();
  const offered = await env.DB.query<{ url: string; id: string; name: string }>(`SELECT DISTINCT s.url, ws.id, ws.name
      FROM workspace_mcp_servers s JOIN workspaces ws ON ws.id = s.workspace_id JOIN workspace_members m ON m.workspace_id = ws.id AND m.user_id = ?
    WHERE s.sign_in_as <> 'workspace' AND ${notDeleted('ws.id')} ORDER BY ws.name, ws.id`).bind(userId).all();
  const memberOf = await env.DB.query<{ id: string; name: string; role: string }>(`SELECT ws.id, ws.name, m.role
      FROM workspaces ws JOIN workspace_members m ON m.workspace_id = ws.id AND m.user_id = ?
    WHERE ${notDeleted('ws.id')} ORDER BY ws.name, ws.id`).bind(userId).all();
  const servers = await env.DB.query<{ id: string; workspace_id: string; prefix: string; url: string; shared_connection_id: string | null }>(`SELECT s.id, s.workspace_id,
      s.prefix, s.url, s.shared_connection_id
    FROM workspace_mcp_servers s JOIN workspace_members m ON m.workspace_id = s.workspace_id AND m.user_id = ?`)
    .bind(userId).all();
  const shared = await env.DB.query<{ id: string; workspace_id: string; name: string; prefix: string; shared_connection_id: string; share_status: string }>(`SELECT s.id,
      s.workspace_id, ws.name, s.prefix, s.shared_connection_id, s.share_status
    FROM workspace_mcp_servers s JOIN mcp_connections c ON c.id = s.shared_connection_id JOIN workspaces ws ON ws.id = s.workspace_id
    WHERE c.user_id = ? AND ${notDeleted('ws.id')} ORDER BY ws.name, ws.id`).bind(userId).all();
  const sharedView = (server: typeof shared[number], workspace: { id: string; name: string }): McpConnectionShare => ({
    id: workspace.id, name: workspace.name, shared: true, ...(server.share_status === 'pending' ? { pending: true } : {}), server: { id: server.id, prefix: server.prefix },
  });
  const sharesOf = (row: ConnectionRow): McpConnectionShare[] => {
    const mine = shared.filter(item => item.shared_connection_id === row.id);
    const listed: McpConnectionShare[] = memberOf.map(workspace => {
      const server = mine.find(item => item.workspace_id === workspace.id);
      if (server) return sharedView(server, workspace);
      const there = servers.filter(item => item.workspace_id === workspace.id);
      const unavailable = there.some(item => item.url === row.url) ? 'It already has a remote MCP server at this address.'
        : there.length >= remoteMcpLimits.servers ? `It already has the ${remoteMcpLimits.servers} remote MCP servers a workspace can have.` : undefined;
      const needsApproval = !(workspaceManagerRoles as readonly string[]).includes(workspace.role);
      return { id: workspace.id, name: workspace.name, shared: false, ...(needsApproval ? { needsApproval: true } : {}), ...(unavailable ? { unavailable } : {}) };
    });
    for (const server of mine) {
      if (!listed.some(item => item.id === server.workspace_id)) listed.push(sharedView(server, { id: server.workspace_id, name: server.name }));
    }
    return listed;
  };
  return rows.map(row => {
    const workspaces = brought.filter(item => item.connection_id === row.id).map(item => ({ id: item.id, name: item.name }));
    const offeredIn = offered.filter(item => item.url === row.url && !workspaces.some(used => used.id === item.id))
      .filter((item, index, all) => all.findIndex(other => other.id === item.id) === index).map(item => ({ id: item.id, name: item.name }));
    return {
      id: row.id, name: row.name, url: row.url, headerNames: parsedNames(row.header_names_json),
      ...(row.oauth_ciphertext && row.oauth_at ? { oauth: { signedInAt: row.oauth_at } } : {}),
      ...(row.error ? { error: row.error } : {}), workspaces, offeredIn, shares: sharesOf(row), createdAt: row.created_at, updatedAt: row.updated_at,
    };
  });
}

async function viewOf(env: Env, userId: string, connectionId: string): Promise<McpConnection> {
  return (await views(env, userId, [await ownRow(env, userId, connectionId)]))[0]!;
}

async function noteError(env: Env, connectionId: string, error: string | null): Promise<void> {
  await env.DB.query('UPDATE mcp_connections SET error = ? WHERE id = ?').bind(error === null ? null : error.slice(0, 500), connectionId).run();
}

async function listTools(env: Env, row: ConnectionRow): Promise<Discovered> {
  return discover(env, row.url, await connectionCredentials(env, row), 'member');
}

async function listForWorkspaces(env: Env, row: ConnectionRow, found: Discovered, workspaceId?: string): Promise<void> {
  if (found.error) return;
  const at = now();
  await env.DB.query(`UPDATE workspace_mcp_servers SET tools_json = ?, tools_over_limit = ?, tools_unusable = ?, discovered_at = ?, error = NULL
    WHERE url = ? AND sign_in_as <> 'workspace' AND (tools_json = '[]' OR error IS NOT NULL)
      AND workspace_id IN (SELECT w.workspace_id FROM mcp_connection_workspaces w JOIN workspace_members m ON m.workspace_id = w.workspace_id AND m.user_id = ?
        WHERE w.connection_id = ?)${workspaceId === undefined ? '' : ' AND workspace_id = ?'}`)
    .bind(JSON.stringify(found.tools), found.leftOut.overLimit, found.leftOut.unusable, at, row.url, row.user_id, row.id, ...(workspaceId === undefined ? [] : [workspaceId])).run();
}

async function listForShares(env: Env, connectionId: string, found: Discovered): Promise<void> {
  if (found.error) {
    await env.DB.query('UPDATE workspace_mcp_servers SET error = ? WHERE shared_connection_id = ?').bind(found.error.slice(0, 500), connectionId).run();
    return;
  }
  await env.DB.query(`UPDATE workspace_mcp_servers SET tools_json = ?, tools_over_limit = ?, tools_unusable = ?, discovered_at = ?, error = NULL
    WHERE shared_connection_id = ?`)
    .bind(JSON.stringify(found.tools), found.leftOut.overLimit, found.leftOut.unusable, now(), connectionId).run();
}

async function checkConnection(env: Env, connectionId: string): Promise<Discovered> {
  const row = await env.DB.query<ConnectionRow>('SELECT * FROM mcp_connections WHERE id = ?').bind(connectionId).first();
  if (!row) return { tools: [], leftOut: { overLimit: 0, unusable: 0 }, error: 'Connection not found' };
  const found = await listTools(env, row);
  await noteError(env, row.id, found.error);
  await listForWorkspaces(env, row, found);
  await listForShares(env, row.id, found);
  return found;
}

function profilePage(c: AppContext): Response {
  return c.redirect(`${appOrigin(c.env)}/#/settings/profile`, 302);
}

async function keepSignIn(env: Env, connectionId: string, userId: string, url: string, secret: McpOAuthSecret, detail: Record<string, unknown> = {}): Promise<boolean> {
  const at = now();
  const kept = await env.DB.query(`UPDATE mcp_connections SET oauth_ciphertext = ?, oauth_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND url = ? RETURNING id`)
    .bind(await encryptToken(env, oauthContext(connectionId), JSON.stringify(secret)), at, at, connectionId, userId, url).first();
  if (!kept) return false;
  const found = await checkConnection(env, connectionId);
  await auditStatement(env, userId, 'user.mcp_connection.signed_in', null, null, { connection: connectionId, ...detail, ...(found.error ? { error: found.error } : {}) }).run();
  return true;
}

export async function connectionWebCallback(c: AppContext, stateHash: string, actor: string): Promise<Response | null> {
  const saved = await c.env.DB.query<SignInRow>(`DELETE FROM mcp_connection_sign_ins WHERE state_hash = ? AND app = 0
    RETURNING id, connection_id, user_id, url, verifier, client_ciphertext, secret_ciphertext, expires_at`).bind(stateHash).first();
  if (!saved) return null;
  if (saved.user_id !== actor || Number(saved.expires_at) < Date.now() || !saved.verifier || !saved.client_ciphertext) {
    fail(400, 'invalid_oauth_state', 'Invalid or expired OAuth state: start the sign-in again from your profile.');
  }
  const row = await c.env.DB.query<ConnectionRow>('SELECT * FROM mcp_connections WHERE id = ? AND user_id = ?').bind(saved.connection_id, actor).first()
    ?? fail(404, 'not_found', 'Connection not found.');
  const declined = async (reason: string) => { await noteError(c.env, row.id, `Signing in failed: ${reason}`); return profilePage(c); };
  if (row.url !== saved.url) return declined('its address changed while signing in');
  let client: McpOAuthClient;
  try { client = JSON.parse(await decryptToken(c.env, stateContext(row.id), saved.client_ciphertext)) as McpOAuthClient; }
  catch { return declined('Pikibun couldn\'t read the sign-in it started: start it again'); }
  const answer = callbackCode(c, client);
  if ('reason' in answer) return declined(answer.reason);
  let secret: McpOAuthSecret;
  try { secret = await exchangeCode(c.env, client, answer.code, saved.verifier); }
  catch (failed) { return declined(failure(failed, false, 'member')); }
  if (!await keepSignIn(c.env, row.id, actor, saved.url, secret)) return declined('the connection changed while signing in');
  return profilePage(c);
}

export async function connectionAppBegin(c: AppContext, tokenHash: string): Promise<Response | null> {
  const saved = await c.env.DB.query<SignInRow>(`UPDATE mcp_connection_sign_ins SET begin_hash = NULL WHERE begin_hash = ? AND app = 1
    RETURNING id, connection_id, user_id, url, verifier, client_ciphertext, secret_ciphertext, expires_at`).bind(tokenHash).first();
  if (!saved) return null;
  if (Number(saved.expires_at) < Date.now()) return appPage(c, 'This sign-in link has expired', APP_EXPIRED, undefined, 400);
  const row = await c.env.DB.query<ConnectionRow>('SELECT * FROM mcp_connections WHERE id = ? AND user_id = ?').bind(saved.connection_id, saved.user_id).first();
  if (!row || row.url !== saved.url) return appPage(c, 'Signing in failed', 'The connection was removed or moved to another address meanwhile. Start again in the Pikibun app.', undefined, 400);
  await assertVaultConfigured(c.env);
  let client: McpOAuthClient;
  try { client = await signInClient(c.env, row.url, appRedirectUri(c.env)); }
  catch (error) {
    const reason = `Signing in failed: ${failure(error, false, 'member')}`;
    await noteError(c.env, row.id, reason);
    return appPage(c, 'Signing in failed', `${reason}.`, undefined, 400);
  }
  const state = randomToken(); const verifier = randomToken();
  await c.env.DB.query('UPDATE mcp_connection_sign_ins SET state_hash = ?, verifier = ?, client_ciphertext = ? WHERE id = ?')
    .bind(await sha256(state), verifier, await encryptToken(c.env, stateContext(row.id), JSON.stringify(client)), saved.id).run();
  setStateCookie(c, state, Number(saved.expires_at), true);
  return c.redirect(authorizationUrl(client, state, verifier), 302);
}

export async function connectionAppCallback(c: AppContext, stateHash: string): Promise<Response | null> {
  const saved = await c.env.DB.query<SignInRow>(`UPDATE mcp_connection_sign_ins SET state_hash = NULL WHERE state_hash = ? AND app = 1
    RETURNING id, connection_id, user_id, url, verifier, client_ciphertext, secret_ciphertext, expires_at`).bind(stateHash).first();
  if (!saved) return null;
  const expired = () => appPage(c, 'This sign-in has expired', APP_EXPIRED, undefined, 400);
  if (!saved.verifier || !saved.client_ciphertext || Number(saved.expires_at) < Date.now()) return expired();
  const declined = async (reason: string, connectionId?: string) => {
    await c.env.DB.query('DELETE FROM mcp_connection_sign_ins WHERE id = ?').bind(saved.id).run();
    if (connectionId) await noteError(c.env, connectionId, `Signing in failed: ${reason}`);
    return appPage(c, 'Signing in failed', `Signing in failed: ${reason}. Start again in the Pikibun app.`, undefined, 400);
  };
  const row = await c.env.DB.query<ConnectionRow>('SELECT * FROM mcp_connections WHERE id = ? AND user_id = ?').bind(saved.connection_id, saved.user_id).first();
  if (!row) return declined('the connection was removed meanwhile');
  if (row.url !== saved.url) return declined('its address changed while signing in', row.id);
  let client: McpOAuthClient;
  try { client = JSON.parse(await decryptToken(c.env, stateContext(row.id), saved.client_ciphertext)) as McpOAuthClient; }
  catch { return declined('Pikibun couldn\'t read the sign-in it started', row.id); }
  const answer = callbackCode(c, client);
  if ('reason' in answer) return declined(answer.reason, row.id);
  let secret: McpOAuthSecret;
  try { secret = await exchangeCode(c.env, client, answer.code, saved.verifier); }
  catch (failed) { return declined(failure(failed, false, 'member'), row.id); }
  const finish = randomToken();
  const kept = await c.env.DB.query(`UPDATE mcp_connection_sign_ins SET finish_hash = ?, secret_ciphertext = ?, verifier = NULL, client_ciphertext = NULL, expires_at = ?
    WHERE id = ? RETURNING id`)
    .bind(await sha256(finish), await encryptToken(c.env, appSecretContext(saved.id), JSON.stringify(secret)), Date.now() + STATE_TTL, saved.id).first();
  if (!kept) return expired();
  return appPage(c, 'Almost signed in', `Go back to the Pikibun app to finish signing in to ${row.name}.`,
    { link: remoteMcpAppLink(appOrigin(c.env), finish), code: finish });
}

export async function connectionAppFinish(c: AppContext, codeHash: string, actor: string): Promise<Response | null> {
  const saved = await c.env.DB.query<SignInRow>(`DELETE FROM mcp_connection_sign_ins WHERE finish_hash = ? AND app = 1
    RETURNING id, connection_id, user_id, url, verifier, client_ciphertext, secret_ciphertext, expires_at`).bind(codeHash).first();
  if (!saved) return null;
  const expired: () => never = () => fail(400, 'invalid_grant', APP_EXPIRED);
  if (!saved.secret_ciphertext || Number(saved.expires_at) < Date.now()) return expired();
  if (saved.user_id !== actor) fail(403, 'not_your_sign_in', 'This code finishes a sign-in someone else started: only their Pikibun app can use it. Nothing was kept.');
  const row = await ownRow(c.env, actor, saved.connection_id);
  if (row.url !== saved.url) fail(409, 'mcp_connection_changed', 'Its address changed while signing in: sign in to it again.');
  let secret: McpOAuthSecret;
  try { secret = parseOAuthSecret(await decryptToken(c.env, appSecretContext(saved.id), saved.secret_ciphertext)); }
  catch { return expired(); }
  if (!await keepSignIn(c.env, row.id, actor, saved.url, secret, { via: 'app' })) fail(409, 'mcp_connection_changed', 'The connection changed while signing in.');
  return c.json({ connection: await viewOf(c.env, actor, row.id) });
}

export function registerMcpConnections(app: Hono<AppEnv>): void {
  app.get('/api/mcp-connections', async c => {
    const actor = c.get('auth').userId;
    const rows = await c.env.DB.query<ConnectionRow>('SELECT * FROM mcp_connections WHERE user_id = ? ORDER BY created_at, id').bind(actor).all();
    return c.json({ connections: await views(c.env, actor, rows) });
  });

  app.post('/api/mcp-connections', async c => {
    const actor = c.get('auth').userId;
    const input = await body(c, addBody, { maxBytes: 64 * 1024 });
    const name = nameOf(input.name);
    const url = checked(() => remoteMcpUrl(input.url));
    const headers = input.headers === undefined || input.headers === null ? {} : checked(() => remoteMcpHeaders(input.headers));
    await assertVaultConfigured(c.env);
    const connectionId = id(); const at = now();
    const ciphertext = Object.keys(headers).length ? await encryptToken(c.env, headersContext(connectionId), JSON.stringify(headers)) : null;
    const saved = await c.env.DB.query<{ id: string }>(`INSERT INTO mcp_connections (id, user_id, name, url, headers_ciphertext, header_names_json, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM mcp_connections WHERE user_id = ?) < ?
        AND NOT EXISTS (SELECT 1 FROM mcp_connections WHERE user_id = ? AND url = ?)
      RETURNING id`)
      .bind(connectionId, actor, name, url, ciphertext, JSON.stringify(Object.keys(headers)), at, at, actor, remoteMcpLimits.connections, actor, url).first();
    if (!saved) {
      if (await c.env.DB.query('SELECT 1 FROM mcp_connections WHERE user_id = ? AND url = ?').bind(actor, url).first()) {
        fail(409, 'mcp_connection_exists', 'You already have a connection to this address: change its sign-in instead.');
      }
      fail(409, 'mcp_connection_limit', `You can keep at most ${remoteMcpLimits.connections} remote MCP connections.`);
    }
    const found = await checkConnection(c.env, connectionId);
    await auditStatement(c.env, actor, 'user.mcp_connection.added', null, null,
      { connection: connectionId, name, url, headers: Object.keys(headers), ...(found.error ? { error: found.error } : {}) }).run();
    return c.json({ connection: await viewOf(c.env, actor, connectionId) }, 201);
  });

  app.patch('/api/mcp-connections/:connectionId', async c => {
    const actor = c.get('auth').userId;
    const connectionId = identifier(c.req.param('connectionId'), 'connectionId');
    const input = await body(c, changeBody, { maxBytes: 64 * 1024 });
    if (input.refresh !== undefined && input.refresh !== true) fail(400, 'invalid_mcp_connection', 'refresh must be true.');
    const row = await ownRow(c.env, actor, connectionId);
    const name = input.name === undefined ? row.name : nameOf(input.name);
    const headers = input.headers === undefined ? null : input.headers === null ? {} : checked(() => remoteMcpHeaders(input.headers));
    const signOut = headers !== null && Object.keys(headers).some(header => header.toLowerCase() === 'authorization');
    const ciphertext = headers === null ? row.headers_ciphertext
      : Object.keys(headers).length ? await encryptToken(c.env, headersContext(connectionId), JSON.stringify(headers)) : null;
    const at = now();
    await c.env.DB.query(`UPDATE mcp_connections SET name = ?, headers_ciphertext = ?, header_names_json = ?, updated_at = ?,
        oauth_ciphertext = CASE WHEN ? = 1 THEN NULL ELSE oauth_ciphertext END, oauth_at = CASE WHEN ? = 1 THEN NULL ELSE oauth_at END
      WHERE id = ? AND user_id = ?`)
      .bind(name, ciphertext, headers === null ? row.header_names_json : JSON.stringify(Object.keys(headers)), at, signOut ? 1 : 0, signOut ? 1 : 0, connectionId, actor).run();
    const found = headers !== null || input.refresh === true ? await checkConnection(c.env, connectionId) : undefined;
    await auditStatement(c.env, actor, 'user.mcp_connection.updated', null, null, {
      connection: connectionId, changed: Object.keys(input).filter(key => key !== 'refresh' && input[key as keyof typeof input] !== undefined),
      ...(headers !== null ? { headers: Object.keys(headers) } : {}), ...(signOut && row.oauth_ciphertext ? { signedOut: true } : {}),
      ...(found?.error ? { error: found.error } : {}),
    }).run();
    return c.json({ connection: await viewOf(c.env, actor, connectionId) });
  });

  app.delete('/api/mcp-connections/:connectionId', async c => {
    const actor = c.get('auth').userId;
    const connectionId = identifier(c.req.param('connectionId'), 'connectionId');
    const row = await ownRow(c.env, actor, connectionId);
    await c.env.DB.batch([
      c.env.DB.query('DELETE FROM mcp_connections WHERE id = ? AND user_id = ?').bind(connectionId, actor),
      auditStatement(c.env, actor, 'user.mcp_connection.removed', null, null, { connection: connectionId, url: row.url }),
    ]);
    return c.json({ ok: true });
  });

  app.put('/api/mcp-connections/:connectionId/workspaces/:workspaceId', async c => {
    const actor = c.get('auth').userId;
    const connectionId = identifier(c.req.param('connectionId'), 'connectionId');
    const workspaceId = identifier(c.req.param('workspaceId'), 'workspaceId');
    const row = await ownRow(c.env, actor, connectionId);
    await requireMember(c.env, workspaceId, actor);
    if (!await c.env.DB.query('SELECT 1 FROM workspace_mcp_servers WHERE workspace_id = ? AND url = ? AND shared_connection_id IS NULL').bind(workspaceId, row.url).first()) {
      fail(409, 'mcp_server_not_in_workspace', 'This workspace has no remote MCP server at this connection\'s address.');
    }
    const added = await c.env.DB.query('INSERT INTO mcp_connection_workspaces (connection_id, workspace_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING RETURNING connection_id')
      .bind(connectionId, workspaceId, now()).first();
    if (added) {
      await auditStatement(c.env, actor, 'workspace.mcp.connection_brought', workspaceId, null, { connection: connectionId, url: row.url }).run();
      await listForWorkspaces(c.env, row, await listTools(c.env, row), workspaceId);
    }
    return c.json({ connection: await viewOf(c.env, actor, connectionId) });
  });

  app.delete('/api/mcp-connections/:connectionId/workspaces/:workspaceId', async c => {
    const actor = c.get('auth').userId;
    const connectionId = identifier(c.req.param('connectionId'), 'connectionId');
    const workspaceId = identifier(c.req.param('workspaceId'), 'workspaceId');
    const row = await ownRow(c.env, actor, connectionId);
    const removed = await c.env.DB.query('DELETE FROM mcp_connection_workspaces WHERE connection_id = ? AND workspace_id = ? RETURNING connection_id')
      .bind(connectionId, workspaceId).first();
    if (removed) await auditStatement(c.env, actor, 'workspace.mcp.connection_withdrawn', workspaceId, null, { connection: connectionId, url: row.url }).run();
    return c.json({ connection: await viewOf(c.env, actor, connectionId) });
  });

  app.put('/api/mcp-connections/:connectionId/shares/:workspaceId', async c => {
    const actor = c.get('auth').userId;
    const connectionId = identifier(c.req.param('connectionId'), 'connectionId');
    const workspaceId = identifier(c.req.param('workspaceId'), 'workspaceId');
    const row = await ownRow(c.env, actor, connectionId);
    const member = await requireMember(c.env, workspaceId, actor);
    const pending = !(workspaceManagerRoles as readonly string[]).includes(member.role);
    if (await c.env.DB.query('SELECT 1 FROM workspace_mcp_servers WHERE workspace_id = ? AND shared_connection_id = ?').bind(workspaceId, connectionId).first()) {
      return c.json({ connection: await viewOf(c.env, actor, connectionId) });
    }
    const there = await c.env.DB.query<{ prefix: string; url: string }>('SELECT prefix, url FROM workspace_mcp_servers WHERE workspace_id = ?').bind(workspaceId).all();
    if (there.some(item => item.url === row.url)) {
      fail(409, 'mcp_server_at_address', 'This workspace already has a remote MCP server at this connection\'s address.');
    }
    if (there.length >= remoteMcpLimits.servers) fail(409, 'mcp_server_limit', `A workspace has at most ${remoteMcpLimits.servers} remote MCP servers.`);
    const prefix = remoteMcpSharedPrefix(row.name, there.map(item => item.prefix));
    const found = await listTools(c.env, row);
    await noteError(c.env, row.id, found.error);
    const serverId = id(); const at = now();
    const saved = await c.env.DB.query<{ id: string }>(`INSERT INTO workspace_mcp_servers (id, workspace_id, prefix, name, url, headers_ciphertext, header_names_json,
        read_only_tools_json, tools_json, tools_over_limit, tools_unusable, enabled, sign_in_as, shared_connection_id, share_status, accepted_by, accepted_at,
        discovered_at, error, created_by, updated_by, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, NULL, '[]', '[]', ?, ?, ?, 1, 'workspace', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND (? = 1 OR role IN (${workspaceManagerRolesSQL})))
        AND (SELECT COUNT(*) FROM workspace_mcp_servers WHERE workspace_id = ?) < ?
        AND NOT EXISTS (SELECT 1 FROM workspace_mcp_servers WHERE workspace_id = ? AND (prefix = ? OR url = ? OR shared_connection_id = ?))
        AND EXISTS (SELECT 1 FROM mcp_connections WHERE id = ? AND user_id = ? AND url = ?)
      RETURNING id`)
      .bind(serverId, workspaceId, prefix, row.name, row.url, JSON.stringify(found.tools), found.leftOut.overLimit, found.leftOut.unusable, connectionId,
        pending ? 'pending' : 'accepted', pending ? null : actor, pending ? null : at,
        found.error ? null : at, found.error, actor, actor, at, at, workspaceId, actor, pending ? 1 : 0, workspaceId, remoteMcpLimits.servers,
        workspaceId, prefix, row.url, connectionId, connectionId, actor, row.url).first();
    if (!saved) fail(409, 'mcp_connection_share_conflict', 'The workspace, your role in it or the connection changed meanwhile: look again and retry.');
    await auditStatement(c.env, actor, pending ? 'workspace.mcp.connection_share_requested' : 'workspace.mcp.connection_shared', workspaceId, null,
      { connection: connectionId, server: serverId, prefix, url: row.url, ...discoveredDetail(found) }).run();
    return c.json({ connection: await viewOf(c.env, actor, connectionId) });
  });

  app.delete('/api/mcp-connections/:connectionId/shares/:workspaceId', async c => {
    const actor = c.get('auth').userId;
    const connectionId = identifier(c.req.param('connectionId'), 'connectionId');
    const workspaceId = identifier(c.req.param('workspaceId'), 'workspaceId');
    const row = await ownRow(c.env, actor, connectionId);
    const removed = await c.env.DB.query<{ id: string }>('DELETE FROM workspace_mcp_servers WHERE workspace_id = ? AND shared_connection_id = ? RETURNING id')
      .bind(workspaceId, connectionId).first();
    if (removed) {
      await auditStatement(c.env, actor, 'workspace.mcp.connection_unshared', workspaceId, null, { connection: connectionId, server: removed.id, url: row.url }).run();
    }
    return c.json({ connection: await viewOf(c.env, actor, connectionId) });
  });

  app.get('/api/mcp-connections/:connectionId/oauth/start', async c => {
    requireOrigin(c);
    const actor = c.get('auth').userId;
    const connectionId = identifier(c.req.param('connectionId'), 'connectionId');
    await assertVaultConfigured(c.env);
    const row = await ownRow(c.env, actor, connectionId);
    let client: McpOAuthClient;
    try { client = await signInClient(c.env, row.url, oauthRedirectUri(c.env)); }
    catch (error) {
      await noteError(c.env, connectionId, `Signing in failed: ${failure(error, false, 'member')}`);
      return profilePage(c);
    }
    const state = randomToken(); const verifier = randomToken();
    const expiresAt = Date.now() + STATE_TTL;
    await c.env.DB.batch([
      c.env.DB.query('DELETE FROM mcp_connection_sign_ins WHERE expires_at < ? OR (user_id = ? AND connection_id = ?)').bind(Date.now(), actor, connectionId),
      c.env.DB.query(`INSERT INTO mcp_connection_sign_ins (id, connection_id, user_id, url, app, state_hash, verifier, client_ciphertext, expires_at, created_at)
        VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`)
        .bind(id(), connectionId, actor, row.url, await sha256(state), verifier, await encryptToken(c.env, stateContext(connectionId), JSON.stringify(client)), expiresAt, now()),
    ]);
    setStateCookie(c, state, expiresAt);
    return c.redirect(authorizationUrl(client, state, verifier), 302);
  });

  app.post('/api/mcp-connections/:connectionId/oauth/app', async c => {
    const actor = c.get('auth').userId;
    const connectionId = identifier(c.req.param('connectionId'), 'connectionId');
    await assertVaultConfigured(c.env);
    const row = await ownRow(c.env, actor, connectionId);
    const begin = randomToken();
    const expiresAt = Date.now() + STATE_TTL;
    await c.env.DB.batch([
      c.env.DB.query('DELETE FROM mcp_connection_sign_ins WHERE expires_at < ? OR (user_id = ? AND connection_id = ?)').bind(Date.now(), actor, connectionId),
      c.env.DB.query(`INSERT INTO mcp_connection_sign_ins (id, connection_id, user_id, url, app, begin_hash, expires_at, created_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)`)
        .bind(id(), connectionId, actor, row.url, await sha256(begin), expiresAt, now()),
    ]);
    return c.json({ url: `${appOrigin(c.env)}/api/mcp-servers/oauth/app/begin?${new URLSearchParams({ token: begin }).toString()}`, expiresAt: new Date(expiresAt).toISOString() }, 201);
  });

  app.delete('/api/mcp-connections/:connectionId/oauth', async c => {
    const actor = c.get('auth').userId;
    const connectionId = identifier(c.req.param('connectionId'), 'connectionId');
    await ownRow(c.env, actor, connectionId);
    await c.env.DB.batch([
      c.env.DB.query('UPDATE mcp_connections SET oauth_ciphertext = NULL, oauth_at = NULL, updated_at = ? WHERE id = ? AND user_id = ?').bind(now(), connectionId, actor),
      auditStatement(c.env, actor, 'user.mcp_connection.signed_out', null, null, { connection: connectionId }),
    ]);
    return c.json({ connection: await viewOf(c.env, actor, connectionId) });
  });
}
