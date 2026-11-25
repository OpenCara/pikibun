import { getCookie, setCookie } from 'hono/cookie';
import { constantTimeEqual } from '../../../../../packages/shared/src/crypto.js';
import type { RemoteMcpTool, RemoteMcpToolsLeftOut, RemoteMcpTransport } from '../../../../../packages/shared/src/remote-mcp.js';
import type { AppContext, Env } from '../../types.js';
import { appOrigin } from '../../http.js';
import { decryptToken, encryptToken } from '../vault.js';
import { discoverRemoteMcpTools, RemoteMcpError, RemoteMcpUnauthorized } from './client.js';
import { clientMetadataDocumentUrl, discoverOAuth, parseOAuthSecret, registerClient, RemoteMcpOAuthError, tokenRequest, type McpOAuthClient, type McpOAuthSecret } from './oauth.js';
import { publicHttpsTransport, RemoteMcpRefused } from './transport.js';

export const STATE_TTL = 10 * 60 * 1000;
export const STATE = /^[A-Za-z0-9_-]{43}$/;
export const APP_BEGIN_PATH = '/api/mcp-servers/oauth/app/begin';
export const APP_CALLBACK_PATH = '/api/mcp-servers/oauth/app/callback';
export const APP_EXPIRED = 'This sign-in has expired or was already used. Start it again with Sign in in the Pikibun app.';
const RENEW_BEFORE_MS = 60_000;

const refusingTransport: RemoteMcpTransport = async () => { throw new RemoteMcpRefused('This Pikibun server reaches no remote MCP servers in tests'); };
let productionTransport: RemoteMcpTransport | undefined;

export function transport(env: Env): RemoteMcpTransport {
  if (env.REMOTE_MCP_TRANSPORT) return env.REMOTE_MCP_TRANSPORT;
  if (env.TEST_AUTH_ENABLED === 'true') return refusingTransport;
  return productionTransport ??= publicHttpsTransport();
}

export const parsedList = (json: string): string[] => { try { const value = JSON.parse(json); return Array.isArray(value) ? value.filter(item => typeof item === 'string') : []; } catch { return []; } };
export const parsedTools = (json: string): RemoteMcpTool[] => { try { const value = JSON.parse(json); return Array.isArray(value) ? value as RemoteMcpTool[] : []; } catch { return []; } };

export type SignInOwner = 'workspace' | 'member';

const again: Record<SignInOwner, string> = {
  workspace: 'an owner or admin signs in to it again',
  member: 'sign in to it again under Settings → Profile → Connected accounts',
};

export function failure(error: unknown, signedIn = false, owner: SignInOwner = 'workspace'): string {
  if (error instanceof RemoteMcpUnauthorized && error.status === 401) {
    if (signedIn) return `The server refused its sign-in (HTTP 401): ${again[owner]}`;
    if (!/^\s*Bearer\b/i.test(error.challenge)) return error.message;
    return owner === 'workspace'
      ? 'The server needs a sign-in (HTTP 401): an owner or admin signs in to it with Sign in, or gives it a token, a username and password or a header with Change sign-in'
      : 'The server needs a sign-in (HTTP 401): sign in to it with Sign in, or give it a token, a username and password or a header with Change sign-in';
  }
  if (error instanceof RemoteMcpError || error instanceof RemoteMcpRefused) return error.message.slice(0, 500);
  return `It couldn't be reached: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`;
}

export interface OAuthKeeper {
  context: string;
  owner: SignInOwner;
  read(): Promise<string | null>;
  swap(next: string, current: string): Promise<boolean>;
}

export interface KeptSignIn { keeper: OAuthKeeper; ciphertext: string }
export interface Credentials { headers: Record<string, string>; oauth: KeptSignIn | null }

interface SignIn { secret: McpOAuthSecret; ciphertext: string }

async function signInOf(env: Env, keeper: OAuthKeeper, ciphertext: string): Promise<SignIn> {
  const unreadable = () => new RemoteMcpOAuthError(`Pikibun couldn't read the sign-in it keeps for it: ${again[keeper.owner]}`);
  let plain: string;
  try { plain = await decryptToken(env, keeper.context, ciphertext); } catch { throw unreadable(); }
  try { return { secret: parseOAuthSecret(plain), ciphertext }; } catch { throw unreadable(); }
}

async function renew(env: Env, keeper: OAuthKeeper, current: SignIn): Promise<SignIn> {
  const expired = new RemoteMcpOAuthError(`Its sign-in expired: ${again[keeper.owner]}`);
  if (!current.secret.refreshToken) throw expired;
  let next: McpOAuthSecret;
  try {
    next = await tokenRequest(transport(env), current.secret.client, { grant_type: 'refresh_token', refresh_token: current.secret.refreshToken }, current.secret);
  } catch (error) {
    const latest = await keeper.read();
    if (latest && latest !== current.ciphertext) return signInOf(env, keeper, latest);
    if (error instanceof RemoteMcpOAuthError && (error.code === 'invalid_grant' || error.code === 'invalid_client')) throw expired;
    throw error;
  }
  const ciphertext = await encryptToken(env, keeper.context, JSON.stringify(next));
  if (await keeper.swap(ciphertext, current.ciphertext)) return { secret: next, ciphertext };
  const latest = await keeper.read();
  if (!latest) throw new RemoteMcpOAuthError(`Its sign-in was removed: ${again[keeper.owner]}`);
  return signInOf(env, keeper, latest);
}

function bearer(headers: Record<string, string>, token: string): Record<string, string> {
  const kept = Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'authorization'));
  return { ...kept, Authorization: `Bearer ${token}` };
}

export async function withCredentials<T>(env: Env, credentials: Credentials, run: (headers: Record<string, string>) => Promise<T>): Promise<T> {
  const { headers, oauth } = credentials;
  if (!oauth) return run(headers);
  let signIn = await signInOf(env, oauth.keeper, oauth.ciphertext);
  let renewed = false;
  if (signIn.secret.expiresAt !== undefined && signIn.secret.expiresAt < Date.now() + RENEW_BEFORE_MS) {
    signIn = await renew(env, oauth.keeper, signIn);
    renewed = true;
  }
  try { return await run(bearer(headers, signIn.secret.accessToken)); }
  catch (error) {
    if (renewed || !(error instanceof RemoteMcpUnauthorized) || error.status !== 401 || !signIn.secret.refreshToken) throw error;
    signIn = await renew(env, oauth.keeper, signIn);
    return run(bearer(headers, signIn.secret.accessToken));
  }
}

export interface Discovered { tools: RemoteMcpTool[]; leftOut: RemoteMcpToolsLeftOut; error: string | null }

export async function discover(env: Env, url: string, credentials: Credentials, owner: SignInOwner = 'workspace'): Promise<Discovered> {
  try { return { ...await withCredentials(env, credentials, sent => discoverRemoteMcpTools(transport(env), url, sent)), error: null }; }
  catch (error) { return { tools: [], leftOut: { overLimit: 0, unusable: 0 }, error: failure(error, !!credentials.oauth, owner) }; }
}

export function discoveredDetail(found: Discovered): Record<string, unknown> {
  return { tools: found.tools.length, ...(found.leftOut.overLimit ? { toolsOverLimit: found.leftOut.overLimit } : {}),
    ...(found.leftOut.unusable ? { toolsUnusable: found.leftOut.unusable } : {}), ...(found.error ? { error: found.error } : {}) };
}

export function oauthRedirectUri(env: Env): string {
  return `${appOrigin(env)}/api/mcp-servers/oauth/callback`;
}

export function appRedirectUri(env: Env): string {
  return `${appOrigin(env)}${APP_CALLBACK_PATH}`;
}

export async function signInClient(env: Env, url: string, redirectUri: string): Promise<McpOAuthClient> {
  return registerClient(transport(env), await discoverOAuth(transport(env), url), redirectUri, clientMetadataDocumentUrl(appOrigin(env)));
}

export async function exchangeCode(env: Env, client: McpOAuthClient, code: string, verifier: string): Promise<McpOAuthSecret> {
  return tokenRequest(transport(env), client, { grant_type: 'authorization_code', code, redirect_uri: client.redirectUri, code_verifier: verifier });
}

export function stateCookie(env: Env, app = false) {
  const secure = new URL(appOrigin(env)).protocol === 'https:';
  const name = `${secure ? '__Host-' : 'test-'}mcp-oauth${app ? '-app' : ''}`;
  return { name, options: { secure, httpOnly: true, sameSite: 'Lax' as const, path: '/' } };
}

export function setStateCookie(c: AppContext, state: string, expiresAt: number, app = false): void {
  const cookie = stateCookie(c.env, app);
  setCookie(c, cookie.name, state, { ...cookie.options, maxAge: Math.max(1, Math.round((expiresAt - Date.now()) / 1000)), expires: new Date(expiresAt) });
}

export function callbackState(c: AppContext, app: boolean): string | null {
  const cookie = stateCookie(c.env, app);
  const cookieState = getCookie(c, cookie.name);
  setCookie(c, cookie.name, '', { ...cookie.options, maxAge: 0, expires: new Date(0) });
  const states = c.req.queries('state');
  const state = states?.length === 1 ? states[0]! : '';
  return STATE.test(state) && cookieState && STATE.test(cookieState) && constantTimeEqual(state, cookieState) ? state : null;
}

export function callbackCode(c: AppContext, client: McpOAuthClient): { code: string } | { reason: string } {
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

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[ch]!);

export function appPage(c: AppContext, title: string, message: string, finish?: { link: string; code: string }, status: 200 | 400 = 200): Response {
  const style = 'font:16px system-ui,sans-serif;max-width:32em;margin:20vh auto 0;padding:0 1em;line-height:1.5';
  const body = finish
    ? `<p><a href="${escapeHtml(finish.link)}" style="display:inline-block;padding:.6em 1.2em;border-radius:6px;background:#2563eb;color:#fff;text-decoration:none">Open Pikibun</a></p>`
      + `<p>Or paste this code where the app asks for it:</p><p><code style="font-size:14px;word-break:break-all;user-select:all">${escapeHtml(finish.code)}</code></p>`
      + '<p style="color:#666;font-size:14px">It works once, for 10 minutes, and only in the Pikibun app of whoever started this sign-in. Show it to nobody.</p>'
    : '';
  return c.html('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Pikibun</title>'
    + `<main style="${style}"><h1 style="font-size:20px">${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${body}</main>`, status);
}
