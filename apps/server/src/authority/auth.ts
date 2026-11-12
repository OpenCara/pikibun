import type { Hono, MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { constantTimeEqual, sha256 } from '../../../../packages/shared/src/crypto.js';
import { validateUserEnv } from '../../../../packages/shared/src/policy.js';
import type { NativeSignIn, SignedInDevice } from '../../../../packages/shared/src/types.js';
import { isInstanceAdmin } from './admin.js';
import { getUser, userProfile } from '../db.js';
import type { Database, Query, SqlValue } from '../db/types.js';
import { appOrigin, fail, id, identifier, jsonObject, localMode, localOwnerQuery, now, passwordAuthEnabled, randomToken, requireOrigin, signupMode, testMode, text } from '../http.js';
import type { AppContext, AuthIdentity, Env, UserRow, AppEnv } from '../types.js';
import { assertVaultConfigured, encryptToken } from './vault.js';
import { joinRequestStatement, requireInvitedWorkspace } from './invites.js';
import { forgetDeadGitHubToken } from './github-sign-in.js';

const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const NATIVE_SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
const STATE_TTL = 10 * 60 * 1000;
const NATIVE_CODE_TTL = 2 * 60 * 1000;
const OPAQUE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const CALLBACK_PATH = '/api/auth/github/callback';
const NATIVE_CALLBACK = 'pikibun://auth';
const NATIVE_PAGE_PATH = '/api/auth/native/done';

interface NativeRequest { challenge: string; state: string; callback: 'scheme' | 'page' }
const VERIFIER = /^[A-Za-z0-9_-]{43,128}$/;
const APP_STATE = /^[A-Za-z0-9_-]{16,128}$/;
const PROFILE_FIELDS: Record<string, true> = { displayName: true, gitName: true, gitEmail: true, env: true };
export const SUSPENDED = 'This account is suspended. Ask the administrator of this Pikibun server to restore it.';

function cookies(env: Env) {
  const secure = new URL(appOrigin(env)).protocol === 'https:';
  return {
    auth: secure ? '__Host-auth' : 'test-auth',
    state: secure ? '__Host-oauth-state' : 'test-oauth-state',
    claim: secure ? '__Host-local-claim' : 'local-claim',
    options: { secure, httpOnly: true, sameSite: 'Lax' as const, path: '/' },
  };
}

function expireCookie(c: AppContext, kind: 'auth' | 'state' | 'claim'): void {
  const config = cookies(c.env);
  setCookie(c, config[kind], '', { ...config.options, maxAge: 0, expires: new Date(0) });
}

export async function dbResult<T>(operation: Promise<T>): Promise<T> {
  try { return await operation; }
  catch { fail(503, 'auth_unavailable', 'Authentication storage is temporarily unavailable.'); }
}

export const authenticate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const authorization = c.req.header('authorization');
  const bearer = authorization === undefined ? undefined : /^Bearer +(.*)$/i.exec(authorization)?.[1];
  const client = bearer === undefined ? 'browser' : 'native';
  const token = bearer ?? getCookie(c, cookies(c.env).auth);
  if (!token || !OPAQUE_TOKEN.test(token)) fail(401, 'unauthorized', 'Authentication is required.');
  const tokenHash = await sha256(token);
  const session = await dbResult(c.env.DB.query<{ user_id: string; csrf_token: string; expires_at: number; auth_kind: string; client: string; method: string | null }>(`SELECT s.user_id, s.csrf_token, s.expires_at, s.client, s.method, u.auth_kind
    FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND u.suspended_at IS NULL`)
    .bind(tokenHash).first());
  if (!session || session.client !== client || session.expires_at <= Date.now() || !Number.isSafeInteger(session.expires_at) ||
      !OPAQUE_TOKEN.test(session.csrf_token) ||
      (session.auth_kind !== 'github' && session.auth_kind !== 'test' && session.auth_kind !== 'password') ||
      (session.auth_kind === 'test' && (!testMode(c.env) || !session.user_id.startsWith('test:'))) ||
      (session.auth_kind === 'github' && session.user_id.startsWith('test:')) ||
      (session.auth_kind !== 'password' && session.user_id.startsWith('password:')) ||
      (session.auth_kind === 'password' && (!passwordAuthEnabled(c.env) || !session.user_id.startsWith('password:'))) ||
      (session.method !== null && (session.method !== 'password' || !passwordAuthEnabled(c.env)))) {
    if (client === 'browser') expireCookie(c, 'auth');
    fail(401, 'unauthorized', 'Authentication is required.');
  }
  if (localMode(c.env) && session.auth_kind !== 'test' && (await localOwner(c.env))?.id !== session.user_id) {
    if (client === 'browser') expireCookie(c, 'auth');
    fail(401, 'unauthorized', 'Authentication is required.');
  }
  c.set('auth', { userId: session.user_id, tokenHash, csrfToken: session.csrf_token, client });
  await next();
};

function requireTestBearer(c: AppContext): void {
  if (!testMode(c.env)) fail(404, 'not_found', 'Not found.');
  const authorization = c.req.header('authorization');
  const expected = `Bearer ${c.env.TEST_AUTH_SECRET!}`;
  if (!authorization || authorization.length !== expected.length || !constantTimeEqual(authorization, expected)) {
    fail(401, 'unauthorized', 'Valid test authorization is required.');
  }
}

export const csrfGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    requireOrigin(c);
    if (c.req.method === 'POST' && c.req.path === '/api/auth/test') {
      requireTestBearer(c);
    } else {
      const auth: AuthIdentity | undefined = c.get('auth');
      if (!auth) fail(401, 'unauthorized', 'Authentication is required.');
      if (auth.client === 'browser') {
        const token = c.req.header('x-csrf-token');
        if (!token || !OPAQUE_TOKEN.test(token) || !constantTimeEqual(token, auth.csrfToken)) {
          fail(403, 'invalid_csrf', 'A valid CSRF token is required.');
        }
      }
    }
  }
  await next();
};

export const privateResponse: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  c.header('Referrer-Policy', 'no-referrer');
  await next();
};

export function safeText(value: unknown, field: string, max: number): string {
  const result = text(value, field, max);
  if (!result.trim() || /[\u0000-\u001f\u007f]/.test(result)) fail(400, 'invalid_input', `Invalid ${field}.`);
  return result;
}

function profileInput(body: Record<string, unknown>, allowId = false) {
  for (const key of Object.keys(body)) {
    if (!Object.hasOwn(PROFILE_FIELDS, key) && !(allowId && key === 'id')) {
      fail(400, 'invalid_profile', 'Only editable profile fields are accepted.');
    }
  }
  const result: { displayName?: string; gitName?: string; gitEmail?: string; env?: Record<string, string> } = {};
  if ('displayName' in body) result.displayName = safeText(body.displayName, 'displayName', 200);
  if ('gitName' in body) result.gitName = safeText(body.gitName, 'gitName', 200);
  if ('gitEmail' in body) {
    result.gitEmail = safeText(body.gitEmail, 'gitEmail', 254);
    if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(result.gitEmail)) fail(400, 'invalid_profile', 'Invalid gitEmail.');
  }
  if ('env' in body) {
    try { result.env = validateUserEnv(body.env); }
    catch { fail(400, 'invalid_profile', 'Invalid personal environment values.'); }
  }
  return result;
}

async function currentUser(c: AppContext): Promise<UserRow> {
  const user = await dbResult(getUser(c.env, c.get('auth').userId));
  if (!user) fail(401, 'unauthorized', 'Authentication is required.');
  return user;
}

export function usernameRequired(env: Env, user: UserRow): boolean {
  return user.auth_kind === 'github' && !user.username && !localMode(env);
}

export function ownProfile(env: Env, user: UserRow) {
  return { ...userProfile(user), ...(isInstanceAdmin(env, user.id) ? { instanceAdmin: true as const } : {}),
    ...(user.auth_kind === 'password' ? { passwordSignIn: true as const } : {}),
    ...(user.has_password ? { hasPassword: true as const } : {}),
    ...(usernameRequired(env, user) ? { usernameRequired: true as const } : {}) };
}

export async function newSession(env: Env, userId: string, kind: 'github' | 'test' | 'password', native?: { deviceName: string | null }) {
  const issuedAt = Date.now();
  let expiresAt = issuedAt + (native ? NATIVE_SESSION_TTL : SESSION_TTL);
  if (kind === 'test') {
    if (!testMode(env)) fail(404, 'not_found', 'Not found.');
    expiresAt = Math.min(expiresAt, Date.parse(env.TEST_AUTH_EXPIRES_AT!));
  }
  const token = randomToken();
  const csrfToken = randomToken();
  const tokenHash = await sha256(token);
  const columns = '(token_hash, user_id, csrf_token, expires_at, created_at, client, device_id, device_name, method)';
  const sql = `INSERT INTO auth_sessions ${columns} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const values: SqlValue[] = [tokenHash, userId, csrfToken, expiresAt, new Date(issuedAt).toISOString(),
    native ? 'native' : 'browser', native ? id() : null, native?.deviceName ?? null, kind === 'password' ? 'password' : null];
  return {
    token, expiresAt,
    sql, values, statement: env.DB.query(sql).bind(...values),
    statementWhere: (condition: string, ...conditionValues: SqlValue[]) =>
      env.DB.query(`INSERT INTO auth_sessions ${columns} SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${condition}`).bind(...values, ...conditionValues),
  };
}

export function sessionCookie(c: AppContext, session: { token: string; expiresAt: number }): void {
  const config = cookies(c.env);
  setCookie(c, config.auth, session.token, {
    ...config.options, expires: new Date(session.expiresAt),
    maxAge: Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000)),
  });
}

interface GitHubConfig { clientId: string; clientSecret: string; redirectUri: string }
interface GitHubSignIn { user: UserRow; tokenStatement: Query<Record<string, SqlValue>> }

function githubConfig(env: Env): GitHubConfig {
  const origin = appOrigin(env);
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET ||
      env.GITHUB_CLIENT_ID.length > 256 || env.GITHUB_CLIENT_SECRET.length > 4096 ||
      /\s/.test(env.GITHUB_CLIENT_ID) || /\s/.test(env.GITHUB_CLIENT_SECRET)) {
    fail(503, 'github_unavailable', 'GitHub authentication is not configured.');
  }
  return { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET, redirectUri: origin + CALLBACK_PATH };
}

async function githubRequest(url: string, init: RequestInit): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    return { status: response.status, body: undefined };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > 131_072) {
      await reader.cancel();
      throw new Error('GitHub response too large.');
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { status: response.status, body: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown };
}

async function githubJson(url: string, init: RequestInit): Promise<unknown> {
  try {
    const result = await githubRequest(url, init);
    if (result.body === undefined) throw new Error('GitHub request failed.');
    return result.body;
  } catch {
    fail(502, 'github_error', 'GitHub authentication could not be completed.');
  }
}

export async function resetGitHubToken(env: Env, userId: string, token: string, ciphertext: string): Promise<boolean> {
  const { GITHUB_CLIENT_ID: clientId, GITHUB_CLIENT_SECRET: clientSecret } = env;
  if (!clientId || !clientSecret) return false;
  const request = (method: 'PATCH' | 'DELETE' | 'POST', accessToken: string) => githubRequest(`https://api.github.com/applications/${encodeURIComponent(clientId)}/token`, {
    method, body: JSON.stringify({ access_token: accessToken }),
    headers: { Accept: 'application/vnd.github+json', Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`, 'Content-Type': 'application/json',
      'User-Agent': 'pikibun', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  const dead = async (settledIfAlive: boolean): Promise<boolean> => {
    let status: number;
    try {
      status = (await githubRequest('https://api.github.com/user', { headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
        'User-Agent': 'pikibun', 'X-GitHub-Api-Version': '2022-11-28' } })).status;
    } catch { return false; }
    if (status === 200) return settledIfAlive;
    if (status !== 401) return false;
    await forgetDeadGitHubToken(env, userId, ciphertext, 'token reset');
    return true;
  };
  let replacement: string;
  try {
    const reset = await request('PATCH', token);
    if (reset.status === 404) return await dead(true);
    const issued = record(reset.body) ? reset.body.token : undefined;
    if (reset.status !== 200 || typeof issued !== 'string' || !issued || issued.length > 16_384 || /[^\x21-\x7e]/.test(issued)) return false;
    replacement = issued;
  } catch {
    try {
      if ((await request('POST', token)).status === 404) return await dead(false);
    } catch { }
    return false;
  }
  const stored = await env.DB.query('UPDATE github_tokens SET ciphertext = ?, updated_at = ? WHERE user_id = ? AND ciphertext = ? RETURNING user_id')
    .bind(await encryptToken(env, userId, replacement), now(), userId, ciphertext).first();
  if (!stored) await request('DELETE', replacement).catch(() => undefined);
  return true;
}

export async function revokeGitHubToken(env: Env, token: string): Promise<boolean> {
  const { GITHUB_CLIENT_ID: clientId, GITHUB_CLIENT_SECRET: clientSecret } = env;
  if (!clientId || !clientSecret) return false;
  try {
    const revoked = await githubRequest(`https://api.github.com/applications/${encodeURIComponent(clientId)}/token`, {
      method: 'DELETE', body: JSON.stringify({ access_token: token }),
      headers: { Accept: 'application/vnd.github+json', Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`, 'Content-Type': 'application/json',
        'User-Agent': 'pikibun', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    return revoked.status === 204 || revoked.status === 404;
  } catch {
    return false;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function githubStart(c: AppContext, native?: NativeRequest) {
  return c.redirect(await githubAuthorization(c, native));
}

async function githubAuthorization(c: AppContext, native?: NativeRequest, inviteTokenHash?: string): Promise<string> {
  requireOrigin(c);
  await assertVaultConfigured(c.env);
  const config = githubConfig(c.env);
  const state = randomToken();
  const verifier = randomToken();
  const expiresAt = Date.now() + STATE_TTL;
  await dbResult(c.env.DB.query(`INSERT INTO oauth_states
    (state_hash, verifier, expires_at, created_at, native_challenge, native_state, native_callback, invite_token_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(await sha256(state), verifier, expiresAt, now(), native?.challenge ?? null, native?.state ?? null,
      native?.callback === 'page' ? 'page' : null, inviteTokenHash ?? null).run());
  const cookieConfig = cookies(c.env);
  setCookie(c, cookieConfig.state, state, { ...cookieConfig.options, maxAge: STATE_TTL / 1000, expires: new Date(expiresAt) });
  const authorization = new URL('https://github.com/login/oauth/authorize');
  authorization.search = new URLSearchParams({
    client_id: config.clientId, redirect_uri: config.redirectUri, scope: 'read:user user:email repo workflow',
    state, code_challenge: await sha256(verifier), code_challenge_method: 'S256',
  }).toString();
  return authorization.toString();
}

async function githubInviteStart(c: AppContext) {
  requireOrigin(c);
  const body = await jsonObject(c, 1024);
  if (Object.keys(body).some(key => key !== 'inviteToken')) fail(400, 'invalid_input', 'Only inviteToken is accepted.');
  await requireInvitedWorkspace(c.env, body.inviteToken);
  return c.json({ url: await githubAuthorization(c, undefined, await sha256(body.inviteToken as string)) });
}

class SignupRefusal extends Error {
  constructor(readonly code: 'signup_closed' | 'invite_required' | 'too_many_pending', message: string) { super(message); }
}
class JoinRequestRefused extends Error {}

async function githubSignup(c: AppContext, githubId: string, inviteTokenHash: string | null, native: boolean): Promise<{ workspaceId: string; tokenHash: string } | null> {
  if (localMode(c.env)) return null;
  if (await dbResult(c.env.DB.query('SELECT 1 FROM users WHERE github_id = ?').bind(githubId).first())) return null;
  const invite = inviteTokenHash === null ? null : await dbResult(c.env.DB.query<{ workspace_id: string }>(
    'SELECT workspace_id FROM workspace_invite_links WHERE token_hash = ?').bind(inviteTokenHash).first());
  const mode = signupMode(c.env, 'github');
  if (!isInstanceAdmin(c.env, `github:${githubId}`)) {
    if (mode === 'off') throw new SignupRefusal('signup_closed', 'This Pikibun doesn\'t take new accounts. Ask its operator to add you.');
    if (mode === 'invite' && !invite) {
      throw new SignupRefusal('invite_required', inviteTokenHash !== null ? 'That invite link was turned off or replaced. Ask for the current one.'
        : native ? 'New accounts need an invite link. Open the link a workspace owner or admin shared in a browser to create your account, then sign in here.'
          : 'New accounts need an invite link. Ask a workspace owner or admin for theirs, and sign in from it.');
    }
  }
  return invite && inviteTokenHash ? { workspaceId: invite.workspace_id, tokenHash: inviteTokenHash } : null;
}

function nativeStart(c: AppContext) {
  const challenges = c.req.queries('challenge');
  const states = c.req.queries('state');
  const callbacks = c.req.queries('callback');
  const challenge = challenges?.length === 1 ? challenges[0] : undefined;
  const state = states?.length === 1 ? states[0] : undefined;
  if (!challenge || !OPAQUE_TOKEN.test(challenge) || !state || !APP_STATE.test(state)) fail(400, 'invalid_native_request', 'Invalid native sign-in request.');
  if (callbacks !== undefined && (callbacks.length !== 1 || callbacks[0] !== 'page')) fail(400, 'invalid_native_request', 'Invalid native sign-in request.');
  const claims = c.req.queries('claim');
  if (claims !== undefined) {
    if (!localMode(c.env) || claims.length !== 1) fail(400, 'invalid_native_request', 'Invalid native sign-in request.');
    keepLocalClaim(c, claims[0]);
  }
  return githubStart(c, { challenge, state, callback: callbacks ? 'page' : 'scheme' });
}

function nativeCallback(c: AppContext, native: NativeRequest, params: Record<string, string>): string {
  const query = new URLSearchParams({ ...params, state: native.state }).toString();
  return native.callback === 'page' ? `${appOrigin(c.env)}${NATIVE_PAGE_PATH}?${query}` : `${NATIVE_CALLBACK}?${query}`;
}

function nativeReturn(c: AppContext, native: NativeRequest, params: Record<string, string>): Response {
  const link = nativeCallback(c, native, params);
  if (native.callback === 'page') return c.redirect(link);
  const href = link.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const [title, detail] = params.error === undefined
    ? ['Return to Pikibun', 'You signed in with GitHub. Open Pikibun to finish: this link works for two minutes.']
    : ['Sign-in did not complete', 'Open Pikibun to see why, and try again from there.'];
  return c.html('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">'
    + `<meta name="color-scheme" content="light dark"><meta http-equiv="refresh" content="0;url=${href}"><title>Pikibun</title>`
    + '<main style="font:16px/1.5 system-ui,sans-serif;text-align:center;max-width:28em;margin:25vh auto 0;padding:0 16px">'
    + `<h1 style="font-size:24px;font-weight:400">${title}</h1><p>${detail}</p>`
    + `<p style="margin:24px 0"><a id="open-app" href="${href}" style="display:inline-block;padding:10px 22px;border-radius:8px;`
    + 'background:#1f6feb;color:#fff;text-decoration:none;font-weight:500">Open Pikibun</a></p>'
    + '<p style="font-size:13px;opacity:.7">If your browser asks, let it open Pikibun. Then you can close this tab.</p></main></html>');
}

async function nativeFailure(c: AppContext, error: unknown, native: NativeRequest): Promise<Response> {
  if (!(error instanceof HTTPException)) throw error;
  const body = await error.getResponse().json().catch(() => null) as { code?: unknown } | null;
  return nativeReturn(c, native, { error: typeof body?.code === 'string' ? body.code : 'sign_in_failed' });
}

function nativeDone(c: AppContext) {
  return c.html('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Pikibun</title>'
    + '<p style="font:16px system-ui,sans-serif;text-align:center;margin-top:30vh">You can return to Pikibun.</p>');
}

async function githubUser(c: AppContext, config: GitHubConfig, code: string, verifier: string, inviteTokenHash: string | null = null, native = false): Promise<GitHubSignIn> {
  const exchange = await githubJson('https://github.com/login/oauth/access_token', {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret,
      redirect_uri: config.redirectUri, code, code_verifier: verifier }),
  });
  if (!record(exchange) || exchange.error !== undefined || typeof exchange.access_token !== 'string' ||
      !exchange.access_token || exchange.access_token.length > 16_384 || /[^\x21-\x7e]/.test(exchange.access_token) ||
      typeof exchange.token_type !== 'string' || exchange.token_type.toLowerCase() !== 'bearer') {
    fail(502, 'github_error', 'GitHub authentication could not be completed.');
  }
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${exchange.access_token}`,
    'User-Agent': 'pikibun', 'X-GitHub-Api-Version': '2022-11-28' };
  const identity = await githubJson('https://api.github.com/user', { headers });
  const emails = await githubJson('https://api.github.com/user/emails?per_page=100', { headers });
  if (!record(identity) || typeof identity.id !== 'number' || !Number.isSafeInteger(identity.id) || identity.id <= 0 ||
      typeof identity.login !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(identity.login) || !Array.isArray(emails)) {
    fail(502, 'github_error', 'GitHub authentication could not be completed.');
  }
  const verified = emails.filter((entry): entry is Record<string, unknown> => record(entry) && entry.verified === true &&
    typeof entry.email === 'string' && entry.email.length <= 254 && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(entry.email) &&
    !/[\u0000-\u001f\u007f]/.test(entry.email));
  const email = (verified.find((entry) => entry.primary === true) ?? verified[0])?.email;
  if (typeof email !== 'string') fail(403, 'verified_email_required', 'A verified GitHub email address is required.');
  const displayName = typeof identity.name === 'string' && identity.name.trim() && identity.name.length <= 200 &&
    !/[\u0000-\u001f\u007f]/.test(identity.name) ? identity.name : identity.login;
  const githubId = String(identity.id);
  const verifiedEmail: string = email;
  const login: string = identity.login;
  if (localMode(c.env)) await admitLocalOwner(c, githubId);
  const invited = await githubSignup(c, githubId, inviteTokenHash, native);
  const upsert = (db: Pick<Database, 'query'>) => db.query<UserRow>(`INSERT INTO users
    (id, github_id, github_login, display_name, git_name, git_email, env_json, auth_kind, created_at)
    VALUES (?, ?, ?, ?, ?, ?, '{}', 'github', ?)
    ON CONFLICT(github_id) DO UPDATE SET github_login = excluded.github_login
    WHERE users.auth_kind = 'github' AND users.id NOT LIKE 'test:%'
    RETURNING *`).bind(`github:${githubId}`, githubId, login, displayName, displayName, verifiedEmail, now());
  let user: UserRow | null;
  if (!invited) {
    user = await dbResult(upsert(c.env.DB).first());
  } else {
    try {
      user = await c.env.DB.transaction(async tx => {
        const created = await upsert(tx).first();
        if (!created) return null;
        const filed = await joinRequestStatement(tx, invited.workspaceId, invited.tokenHash, created.id).run();
        if (filed.changes !== 1) throw new JoinRequestRefused();
        await tx.query('INSERT INTO audit (id, workspace_id, session_id, actor_id, action, detail_json, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?)')
          .bind(id(), invited.workspaceId, created.id, 'workspace.join.request', JSON.stringify({ userId: created.id }), now()).run();
        return created;
      });
    } catch (error) {
      if (error instanceof JoinRequestRefused) throw new SignupRefusal('too_many_pending', 'This workspace has too many people waiting to join, or its invite link was just turned off. Ask an owner or admin.');
      fail(503, 'auth_unavailable', 'Authentication storage is temporarily unavailable.');
    }
  }
  if (!user || user.auth_kind !== 'github' || user.id.startsWith('test:')) {
    fail(409, 'identity_conflict', 'GitHub identity cannot be used for this account.');
  }
  if (localMode(c.env)) await settleLocalClaim(c.env, user.id);
  if (user.suspended_at) fail(403, 'account_suspended', SUSPENDED);
  const ciphertext = await encryptToken(c.env, user.id, exchange.access_token);
  return { user, tokenStatement: c.env.DB.query(`INSERT INTO github_tokens (user_id, ciphertext, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`)
    .bind(user.id, ciphertext, now()) };
}

export async function localOwner(env: Env): Promise<{ id: string; github_id: string } | null> {
  const owner = localOwnerQuery(env);
  return await dbResult(env.DB.query<{ id: string; github_id: string }>(owner.sql).bind(...owner.params).first()) ?? null;
}

async function admitLocalOwner(c: AppContext, githubId: string): Promise<void> {
  const owner = await localOwner(c.env);
  if (owner) {
    if (owner.github_id !== githubId) fail(403, 'local_server_owner_only', 'This Pikibun runs on its owner\'s computer, and only the GitHub account that set it up can sign in.');
    return;
  }
  const claim = getCookie(c, cookies(c.env).claim);
  if (!claim || !OPAQUE_TOKEN.test(claim) || !constantTimeEqual(claim, c.env.LOCAL_CLAIM_SECRET!)) {
    fail(403, 'local_server_unclaimed', 'Nobody has set up this Pikibun yet. Sign in with the link it printed when it started (or from the Pikibun app), which makes your GitHub account its owner.');
  }
}

async function settleLocalClaim(env: Env, userId: string): Promise<void> {
  const owner = await localOwner(env);
  if (owner?.id === userId) return;
  await dbResult(env.DB.query(`DELETE FROM users WHERE id = ? AND auth_kind = 'github'
    AND NOT EXISTS (SELECT 1 FROM github_tokens WHERE user_id = ?) AND NOT EXISTS (SELECT 1 FROM auth_sessions WHERE user_id = ?)`)
    .bind(userId, userId, userId).run());
  fail(403, 'local_server_owner_only', 'This Pikibun runs on its owner\'s computer, and only the GitHub account that set it up can sign in.');
}

function keepLocalClaim(c: AppContext, token: string | undefined): void {
  if (!token || !OPAQUE_TOKEN.test(token) || !constantTimeEqual(token, c.env.LOCAL_CLAIM_SECRET!)) fail(403, 'invalid_claim', 'This sign-in link is not valid for this Pikibun.');
  const config = cookies(c.env);
  setCookie(c, config.claim, token, { ...config.options, maxAge: STATE_TTL / 1000, expires: new Date(Date.now() + STATE_TTL) });
}

async function localClaim(c: AppContext) {
  if (!localMode(c.env)) fail(404, 'not_found', 'Not found.');
  const tokens = c.req.queries('token');
  keepLocalClaim(c, tokens?.length === 1 ? tokens[0] : undefined);
  return githubStart(c);
}

async function githubCallback(c: AppContext) {
  await assertVaultConfigured(c.env);
  const config = githubConfig(c.env);
  const states = c.req.queries('state');
  const cookieState = getCookie(c, cookies(c.env).state);
  const state = states?.length === 1 ? states[0] : undefined;
  if (!state || !cookieState || !OPAQUE_TOKEN.test(state) || !OPAQUE_TOKEN.test(cookieState) ||
      !constantTimeEqual(state, cookieState)) {
    fail(400, 'invalid_oauth_state', 'Invalid or expired OAuth state.');
  }
  const saved = await dbResult(c.env.DB.query<{ verifier: string; expires_at: number; native_challenge: string | null; native_state: string | null; native_callback: string | null; invite_token_hash: string | null }>(
    'DELETE FROM oauth_states WHERE state_hash = ? RETURNING verifier, expires_at, native_challenge, native_state, native_callback, invite_token_hash')
    .bind(await sha256(state)).first());
  expireCookie(c, 'state');
  if (!saved || !Number.isSafeInteger(saved.expires_at) || saved.expires_at <= Date.now() || !OPAQUE_TOKEN.test(saved.verifier)) {
    fail(400, 'invalid_oauth_state', 'Invalid or expired OAuth state.');
  }
  const native: NativeRequest | undefined = saved.native_challenge !== null && saved.native_state !== null
    ? { challenge: saved.native_challenge, state: saved.native_state, callback: saved.native_callback === 'page' ? 'page' : 'scheme' } : undefined;
  let signedIn: GitHubSignIn;
  try {
    const codes = c.req.queries('code');
    const code = codes?.length === 1 ? codes[0] : undefined;
    if (c.req.query('error') !== undefined || !code || code.length > 2048 || /[\u0000-\u0020\u007f]/.test(code)) {
      fail(400, 'oauth_denied', 'GitHub authorization was not completed.');
    }
    signedIn = await githubUser(c, config, code, saved.verifier, saved.invite_token_hash, !!native);
  } catch (error) {
    if (error instanceof SignupRefusal) {
      return native ? nativeReturn(c, native, { error: error.code })
        : c.redirect(`${appOrigin(c.env)}/?${new URLSearchParams({ error: error.message }).toString()}`);
    }
    if (native) return nativeFailure(c, error, native);
    throw error;
  }
  const { user, tokenStatement } = signedIn;
  if (localMode(c.env)) expireCookie(c, 'claim');
  if (native) {
    const code = randomToken();
    try {
      await dbResult(c.env.DB.batch([
        tokenStatement,
        c.env.DB.query('DELETE FROM native_auth_codes WHERE expires_at <= ?').bind(Date.now()),
        c.env.DB.query('INSERT INTO native_auth_codes (code_hash, user_id, challenge, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
          .bind(await sha256(code), user.id, native.challenge, Date.now() + NATIVE_CODE_TTL, now()),
      ]));
    } catch (error) {
      return nativeFailure(c, error, native);
    }
    return nativeReturn(c, native, { code });
  }
  const session = await newSession(c.env, user.id, 'github');
  await dbResult(c.env.DB.batch([tokenStatement, session.statement]));
  sessionCookie(c, session);
  return c.redirect(appOrigin(c.env) + '/');
}

async function nativeToken(c: AppContext) {
  const body = await jsonObject(c, 4096);
  if (Object.keys(body).some(key => !['code', 'verifier', 'deviceName'].includes(key))) fail(400, 'invalid_input', 'Only code, verifier and deviceName are accepted.');
  const { code, verifier } = body;
  if (typeof code !== 'string' || !OPAQUE_TOKEN.test(code) || typeof verifier !== 'string' || !VERIFIER.test(verifier)) {
    fail(400, 'invalid_grant', 'The sign-in has expired or was already used. Sign in again.');
  }
  const deviceName = body.deviceName === undefined || body.deviceName === null ? null : safeText(body.deviceName, 'deviceName', 100);
  const saved = await dbResult(c.env.DB.query<{ user_id: string; challenge: string; expires_at: number }>(
    'DELETE FROM native_auth_codes WHERE code_hash = ? RETURNING user_id, challenge, expires_at').bind(await sha256(code)).first());
  if (!saved || !Number.isSafeInteger(saved.expires_at) || saved.expires_at <= Date.now() || !constantTimeEqual(await sha256(verifier), saved.challenge)) {
    fail(400, 'invalid_grant', 'The sign-in has expired or was already used. Sign in again.');
  }
  const user = await dbResult(getUser(c.env, saved.user_id));
  if (!user || user.auth_kind !== 'github' || user.id.startsWith('test:')) fail(401, 'unauthorized', 'Authentication is required.');
  if (user.suspended_at) fail(403, 'account_suspended', SUSPENDED);
  const session = await newSession(c.env, user.id, 'github', { deviceName });
  await dbResult(session.statement.run());
  return c.json({ token: session.token, expiresAt: new Date(session.expiresAt).toISOString(), user: userProfile(user) } satisfies NativeSignIn);
}

async function testLogin(c: AppContext) {
  requireTestBearer(c);
  const body = await jsonObject(c, 131_072);
  const { githubLogin: requestedGithubLogin, client, deviceName, ...profileBody } = body;
  if (client !== undefined && client !== 'browser' && client !== 'native') fail(400, 'invalid_input', 'Invalid test client.');
  if (client !== 'native' && deviceName !== undefined && deviceName !== null) fail(400, 'invalid_input', 'Only native test sessions have a device name.');
  const native = client === 'native' ? { deviceName: deviceName === undefined || deviceName === null ? null : safeText(deviceName, 'deviceName', 100) } : undefined;
  const profile = profileInput(profileBody, true);
  if (requestedGithubLogin !== undefined &&
      (typeof requestedGithubLogin !== 'string' ||
       !/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(requestedGithubLogin))) {
    fail(400, 'invalid_profile', 'Invalid test githubLogin.');
  }
  const suppliedId = body.id;
  const stableId = suppliedId === undefined ? id() : identifier(
    typeof suppliedId === 'string' && suppliedId.startsWith('test:') ? suppliedId.slice(5) : suppliedId,
  );
  const userId = `test:${stableId}`;
  const existing = await dbResult(getUser(c.env, userId));
  if (existing && (existing.auth_kind !== 'test' || existing.github_id !== null || existing.github_connected)) {
    fail(409, 'identity_conflict', 'Test identity cannot be used for this account.');
  }
  if (existing?.suspended_at) fail(403, 'account_suspended', SUSPENDED);
  const displayName = profile.displayName ?? existing?.display_name ?? stableId;
  const gitName = profile.gitName ?? existing?.git_name ?? displayName;
  const gitEmail = profile.gitEmail ?? existing?.git_email ?? 'test@example.test';
  const environment = profile.env ? JSON.stringify(profile.env) : existing?.env_json ?? '{}';
  const githubLogin = requestedGithubLogin ?? existing?.github_login ?? null;
  const session = await newSession(c.env, userId, 'test', native);
  await dbResult(c.env.DB.batch([
    c.env.DB.query(`INSERT INTO users
      (id, github_id, github_login, display_name, git_name, git_email, env_json, auth_kind, created_at)
      VALUES (?, NULL, ?, ?, ?, ?, ?, 'test', ?)
      ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, git_name = excluded.git_name,
        git_email = excluded.git_email, env_json = excluded.env_json, github_login = excluded.github_login
      WHERE users.auth_kind = 'test' AND users.github_id IS NULL`)
      .bind(userId, githubLogin, displayName, gitName, gitEmail, environment, now()),
    session.statement,
  ]));
  const user = await dbResult(getUser(c.env, userId));
  if (!user || user.auth_kind !== 'test' || user.github_id !== null || user.github_connected) {
    fail(409, 'identity_conflict', 'Test identity cannot be used for this account.');
  }
  if (!testMode(c.env)) fail(404, 'not_found', 'Not found.');
  if (native) return c.json({ user: userProfile(user), token: session.token, expiresAt: new Date(session.expiresAt).toISOString() } satisfies NativeSignIn);
  sessionCookie(c, session);
  return c.json({ user: userProfile(user) });
}

export function registerAuth(app: Hono<AppEnv>): void {
  app.get('/api/auth/github', privateResponse, c => githubStart(c));
  app.post('/api/auth/github/start', privateResponse, githubInviteStart);
  app.get(CALLBACK_PATH, privateResponse, githubCallback);
  app.get('/api/auth/local/claim', privateResponse, localClaim);
  app.get('/api/auth/native/start', privateResponse, nativeStart);
  app.get(NATIVE_PAGE_PATH, privateResponse, nativeDone);
  app.post('/api/auth/native/token', privateResponse, nativeToken);
  app.post('/api/auth/test', privateResponse, csrfGuard, testLogin);
  app.get('/api/auth/csrf', privateResponse, authenticate, (c) => c.json({ csrfToken: c.get('auth').csrfToken }));
  app.get('/api/me', privateResponse, authenticate, async (c) => c.json({ user: ownProfile(c.env, await currentUser(c)) }));
  app.patch('/api/me', privateResponse, authenticate, csrfGuard, async (c) => {
    const profile = profileInput(await jsonObject(c, 131_072));
    const assignments: string[] = [];
    const values: string[] = [];
    for (const [key, column] of [['displayName', 'display_name'], ['gitName', 'git_name'], ['gitEmail', 'git_email']] as const) {
      if (profile[key] !== undefined) { assignments.push(`${column} = ?`); values.push(profile[key]); }
    }
    if (profile.env !== undefined) { assignments.push('env_json = ?'); values.push(JSON.stringify(profile.env)); }
    if (!assignments.length) fail(400, 'invalid_profile', 'Provide at least one editable profile field.');
    await dbResult(c.env.DB.query(`UPDATE users SET ${assignments.join(', ')} WHERE id = ?`)
      .bind(...values, c.get('auth').userId).run());
    return c.json({ user: ownProfile(c.env, await currentUser(c)) });
  });
  app.post('/api/auth/logout', privateResponse, authenticate, csrfGuard, async (c) => {
    await dbResult(c.env.DB.query('DELETE FROM auth_sessions WHERE token_hash = ?').bind(c.get('auth').tokenHash).run());
    if (c.get('auth').client === 'browser') expireCookie(c, 'auth');
    return c.json({ ok: true });
  });
  app.get('/api/me/devices', privateResponse, authenticate, async (c) => {
    const auth = c.get('auth');
    const rows = await dbResult(c.env.DB.query<{ device_id: string; device_name: string | null; created_at: string; expires_at: number; token_hash: string }>(
      `SELECT device_id, device_name, created_at, expires_at, token_hash FROM auth_sessions
      WHERE user_id = ? AND client = 'native' AND device_id IS NOT NULL AND expires_at > ? ORDER BY created_at DESC`)
      .bind(auth.userId, Date.now()).all());
    const devices: SignedInDevice[] = rows.map(row => ({ id: row.device_id, name: row.device_name, createdAt: row.created_at,
      expiresAt: new Date(Number(row.expires_at)).toISOString(), current: row.token_hash === auth.tokenHash }));
    return c.json({ devices });
  });
  app.delete('/api/me/devices/:id', privateResponse, authenticate, csrfGuard, async (c) => {
    const removed = await dbResult(c.env.DB.query(`DELETE FROM auth_sessions WHERE device_id = ? AND user_id = ? AND client = 'native' RETURNING device_id`)
      .bind(identifier(c.req.param('id'), 'deviceId'), c.get('auth').userId).first());
    if (!removed) fail(404, 'not_found', 'Device not found.');
    return c.json({ ok: true });
  });
}
