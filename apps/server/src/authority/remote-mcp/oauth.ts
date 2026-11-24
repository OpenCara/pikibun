import { createHash } from 'node:crypto';
import type { RemoteMcpTransport } from '../../../../../packages/shared/src/remote-mcp.js';
import { MCP_CLIENT, MCP_PROTOCOL_VERSION, RemoteMcpError } from './client.js';

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 64 * 1024;
const TOKEN = /^[\x21-\x7e]{1,16384}$/;
const SCOPE = /^[\x21\x23-\x5b\x5d-\x7e]+(?: [\x21\x23-\x5b\x5d-\x7e]+)*$/;
const authMethods = ['none', 'client_secret_basic', 'client_secret_post'] as const;

type Json = Record<string, unknown>;
type AuthMethod = typeof authMethods[number];

export class RemoteMcpOAuthError extends RemoteMcpError {
  constructor(message: string, readonly code?: string) { super(message); }
}

export interface McpAuthorizationServer {
  issuer?: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  authMethods?: string[];
  resource: string;
  scope?: string;
}

export interface McpOAuthClient {
  issuer?: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  authMethod: AuthMethod;
  redirectUri: string;
  resource: string;
  scope?: string;
}

export interface McpOAuthSecret { client: McpOAuthClient; accessToken: string; refreshToken?: string; expiresAt?: number }

export function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash ? url.href : undefined;
  } catch { return undefined; }
}

export function challengeParams(header: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const match of header.slice(0, 4096).matchAll(/([A-Za-z_][A-Za-z0-9_-]*)=(?:"((?:[^"\\]|\\.)*)"|([^\s,"]+))/g)) {
    const name = match[1]!.toLowerCase();
    if (!(name in params)) params[name] = match[2] !== undefined ? match[2].replace(/\\(.)/g, '$1') : match[3]!;
  }
  return params;
}

function remaining(deadline: number): number {
  const left = deadline - Date.now();
  if (left <= 0) throw new RemoteMcpOAuthError('Its sign-in took longer than Pikibun waits');
  return left;
}

function object(body: string): Json | null {
  try {
    const value = JSON.parse(body) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
  } catch { return null; }
}

async function getJson(transport: RemoteMcpTransport, url: string, deadline: number): Promise<Json | null> {
  const response = await transport({ url, method: 'GET', headers: { Accept: 'application/json', 'MCP-Protocol-Version': MCP_PROTOCOL_VERSION },
    body: '', timeoutMs: remaining(deadline), maxBytes: MAX_BYTES });
  return response.status === 200 ? object(response.body) : null;
}

function scopeOf(value: unknown): string | undefined {
  const scope = Array.isArray(value) ? value.filter(item => typeof item === 'string').join(' ') : value;
  return typeof scope === 'string' && scope.length <= 1024 && SCOPE.test(scope) ? scope : undefined;
}

export function coversResource(declared: string, mcpUrl: string): boolean {
  const resource = new URL(declared);
  const target = new URL(mcpUrl);
  if (resource.origin !== target.origin || resource.search) return false;
  const path = resource.pathname.replace(/\/+$/, '');
  return !path || target.pathname === path || target.pathname === `${path}/` || target.pathname.startsWith(`${path}/`);
}

const sameIssuer = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

function wellKnown(url: URL, name: string): string[] {
  const path = url.pathname.replace(/\/+$/, '');
  return path ? [`${url.origin}/.well-known/${name}${path}`, `${url.origin}/.well-known/${name}`] : [`${url.origin}/.well-known/${name}`];
}

function authorizationServerUrls(issuer: URL): string[] {
  const path = issuer.pathname.replace(/\/+$/, '');
  const origin = issuer.origin;
  return path
    ? [`${origin}/.well-known/oauth-authorization-server${path}`, `${origin}/.well-known/openid-configuration${path}`,
      `${origin}${path}/.well-known/openid-configuration`, `${origin}${path}/.well-known/oauth-authorization-server`]
    : [`${origin}/.well-known/oauth-authorization-server`, `${origin}/.well-known/openid-configuration`];
}

export async function discoverOAuth(transport: RemoteMcpTransport, mcpUrl: string): Promise<McpAuthorizationServer> {
  const deadline = Date.now() + TIMEOUT_MS;
  const probe = await transport({
    url: mcpUrl, method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: MCP_CLIENT } }),
    timeoutMs: remaining(deadline), maxBytes: MAX_BYTES, expectId: 1,
  });
  const challenge = probe.status === 401 ? challengeParams(probe.headers['www-authenticate'] ?? '') : {};
  const mcp = new URL(mcpUrl);
  const candidates = [...new Set([httpsUrl(challenge.resource_metadata), ...wellKnown(mcp, 'oauth-protected-resource')].filter((url): url is string => !!url))];
  let protectedResource: Json | null = null;
  for (const url of candidates) {
    const found = await getJson(transport, url, deadline);
    if (found && Array.isArray(found.authorization_servers) && found.authorization_servers.length) { protectedResource = found; break; }
  }
  const issuer = protectedResource ? httpsUrl((protectedResource.authorization_servers as unknown[])[0]) : mcp.origin;
  if (!issuer) throw new RemoteMcpOAuthError('Its protected resource metadata names no https:// authorization server');
  const declared = httpsUrl(protectedResource?.resource);
  const resource = declared && coversResource(declared, mcpUrl) ? declared : mcpUrl;
  const scope = scopeOf(challenge.scope) ?? scopeOf(protectedResource?.scopes_supported);
  let metadata: Json | null = null;
  for (const url of authorizationServerUrls(new URL(issuer))) {
    const found = await getJson(transport, url, deadline);
    if (found && typeof found.issuer === 'string' && sameIssuer(found.issuer, issuer) && httpsUrl(found.authorization_endpoint) && httpsUrl(found.token_endpoint)) {
      metadata = found;
      break;
    }
  }
  if (!metadata) {
    if (protectedResource || probe.status !== 401) {
      throw new RemoteMcpOAuthError(protectedResource ? `Its authorization server ${issuer} publishes no OAuth metadata` : 'It publishes no OAuth sign-in: choose a token, a username and password or a header with Change sign-in instead');
    }
    const origin = new URL(issuer).origin;
    return { authorizationEndpoint: `${origin}/authorize`, tokenEndpoint: `${origin}/token`, registrationEndpoint: `${origin}/register`, resource, ...(scope ? { scope } : {}) };
  }
  const challenges = metadata.code_challenge_methods_supported;
  if (Array.isArray(challenges) && !challenges.includes('S256')) throw new RemoteMcpOAuthError('Its authorization server doesn\'t offer PKCE with S256, which Pikibun needs');
  const registrationEndpoint = httpsUrl(metadata.registration_endpoint);
  const methods = Array.isArray(metadata.token_endpoint_auth_methods_supported) ? metadata.token_endpoint_auth_methods_supported.filter(item => typeof item === 'string') : undefined;
  return {
    issuer: metadata.issuer as string,
    authorizationEndpoint: httpsUrl(metadata.authorization_endpoint)!, tokenEndpoint: httpsUrl(metadata.token_endpoint)!,
    ...(registrationEndpoint ? { registrationEndpoint } : {}), ...(methods ? { authMethods: methods } : {}), resource, ...(scope ? { scope } : {}),
  };
}

export async function registerClient(transport: RemoteMcpTransport, server: McpAuthorizationServer, redirectUri: string): Promise<McpOAuthClient> {
  if (!server.registrationEndpoint) {
    throw new RemoteMcpOAuthError('Its authorization server doesn\'t let Pikibun register itself (no dynamic client registration), so Pikibun can\'t sign in to it with OAuth: choose a token, a username and password or a header with Change sign-in instead');
  }
  const wanted: AuthMethod = !server.authMethods || server.authMethods.includes('none') ? 'none'
    : server.authMethods.includes('client_secret_post') ? 'client_secret_post' : 'client_secret_basic';
  const response = await transport({
    url: server.registrationEndpoint, method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_name: 'Pikibun', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      token_endpoint_auth_method: wanted, ...(server.scope ? { scope: server.scope } : {}) }),
    timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES,
  });
  const answer = response.status === 200 || response.status === 201 ? object(response.body) : null;
  if (!answer || typeof answer.client_id !== 'string' || !TOKEN.test(answer.client_id)) {
    throw new RemoteMcpOAuthError(`Its authorization server refused to register Pikibun (HTTP ${response.status})`);
  }
  const secret = typeof answer.client_secret === 'string' && TOKEN.test(answer.client_secret) ? answer.client_secret : undefined;
  const declared = authMethods.find(method => method === answer.token_endpoint_auth_method);
  const authMethod: AuthMethod = secret ? (declared && declared !== 'none' ? declared : wanted === 'none' ? 'client_secret_basic' : wanted) : 'none';
  return {
    ...(server.issuer ? { issuer: server.issuer } : {}), authorizationEndpoint: server.authorizationEndpoint, tokenEndpoint: server.tokenEndpoint,
    clientId: answer.client_id, ...(secret ? { clientSecret: secret } : {}), authMethod, redirectUri, resource: server.resource, ...(server.scope ? { scope: server.scope } : {}),
  };
}

export function codeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function authorizationUrl(client: McpOAuthClient, state: string, verifier: string): string {
  const url = new URL(client.authorizationEndpoint);
  for (const [name, value] of Object.entries({
    response_type: 'code', client_id: client.clientId, redirect_uri: client.redirectUri, state, code_challenge: codeChallenge(verifier),
    code_challenge_method: 'S256', resource: client.resource, ...(client.scope ? { scope: client.scope } : {}),
  })) url.searchParams.set(name, value);
  return url.href;
}

export async function tokenRequest(transport: RemoteMcpTransport, client: McpOAuthClient, grant: Record<string, string>,
  previous?: McpOAuthSecret): Promise<McpOAuthSecret> {
  const form = new URLSearchParams({ ...grant, resource: client.resource });
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  if (client.authMethod === 'client_secret_basic' && client.clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`).toString('base64')}`;
  } else {
    form.set('client_id', client.clientId);
    if (client.authMethod === 'client_secret_post' && client.clientSecret) form.set('client_secret', client.clientSecret);
  }
  const response = await transport({ url: client.tokenEndpoint, method: 'POST', headers, body: form.toString(), timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES });
  const answer = object(response.body);
  const refreshing = grant.grant_type === 'refresh_token';
  if (response.status !== 200 || !answer || typeof answer.access_token !== 'string' || !TOKEN.test(answer.access_token)) {
    const code = typeof answer?.error === 'string' && /^[\x20-\x7e]{1,64}$/.test(answer.error) ? answer.error : undefined;
    throw new RemoteMcpOAuthError(`Its authorization server refused to ${refreshing ? 'renew the sign-in' : 'finish the sign-in'} (${code ?? `HTTP ${response.status}`})`, code);
  }
  if (typeof answer.token_type === 'string' && answer.token_type.toLowerCase() !== 'bearer') {
    throw new RemoteMcpOAuthError(`Its authorization server gave a ${answer.token_type.slice(0, 32)} token, and Pikibun sends bearer tokens only`);
  }
  const refreshToken = typeof answer.refresh_token === 'string' && TOKEN.test(answer.refresh_token) ? answer.refresh_token : previous?.refreshToken;
  const lifetime = typeof answer.expires_in === 'number' ? answer.expires_in : typeof answer.expires_in === 'string' ? Number(answer.expires_in) : NaN;
  return { client, accessToken: answer.access_token, ...(refreshToken ? { refreshToken } : {}),
    ...(Number.isFinite(lifetime) && lifetime > 0 ? { expiresAt: Date.now() + Math.min(lifetime, 365 * 86400) * 1000 } : {}) };
}

export function parseOAuthSecret(value: string): McpOAuthSecret {
  const parsed = object(value) as Partial<McpOAuthSecret> | null;
  const client = parsed?.client as Partial<McpOAuthClient> | undefined;
  if (!parsed || !client || typeof parsed.accessToken !== 'string' || typeof client.clientId !== 'string' || !httpsUrl(client.tokenEndpoint)
    || !authMethods.includes(client.authMethod as AuthMethod) || typeof client.resource !== 'string') {
    throw new RemoteMcpOAuthError('Pikibun couldn\'t read the sign-in it keeps for it: an owner or admin signs in again');
  }
  return parsed as McpOAuthSecret;
}
