import type { Hono, MiddlewareHandler } from 'hono';
import { sha256 } from '../../../../packages/shared/src/crypto.js';
import type { AppSignInCode, AppSignInCodeState, NativeSignIn } from '../../../../packages/shared/src/types.js';
import { getUser } from '../db.js';
import { appOrigin, fail, id, identifier, jsonObject, localMode, now, passwordAuthEnabled, randomToken } from '../http.js';
import type { AppContext, AppEnv } from '../types.js';
import { auditAfterChange } from './audit.js';
import { authenticate, csrfGuard, dbResult, localOwner, newSession, ownProfile, privateResponse, safeText, SUSPENDED } from './auth.js';
import { requireRecentOwner } from './password-auth.js';

const CODE_TTL = 10 * 60 * 1000;
const MAX_WAITING = 5;
const CODE = /^[A-Za-z0-9_-]{43}$/;
export const APP_CODE_LINK = 'pikibun://auth/code';
const EXPIRED = 'This sign-in code has expired or was already used. Make a new one under Settings → Profile → Signed-in apps.';

function only(body: Record<string, unknown>, fields: string[]): void {
  if (Object.keys(body).some(key => !fields.includes(key))) fail(400, 'invalid_input', `Only ${fields.join(' and ')} ${fields.length === 1 ? 'is' : 'are'} accepted.`);
}

async function makeCode(c: AppContext) {
  const auth = c.get('auth');
  const body = await jsonObject(c, 4096);
  only(body, ['currentPassword']);
  const proof = await requireRecentOwner(c, body.currentPassword);
  const source = await dbResult(c.env.DB.query<{ method: string | null }>('SELECT method FROM auth_sessions WHERE token_hash = ? AND user_id = ?')
    .bind(auth.tokenHash, auth.userId).first());
  if (!source) fail(401, 'unauthorized', 'Authentication is required.');
  const method = proof === 'password' || source.method === 'password' ? 'password' : null;
  const code = randomToken();
  const codeId = id();
  const expiresAt = Date.now() + CODE_TTL;
  const [, created] = await dbResult(c.env.DB.batch([
    c.env.DB.query('DELETE FROM app_sign_in_codes WHERE expires_at <= ?').bind(Date.now()),
    c.env.DB.query(`INSERT INTO app_sign_in_codes (id, code_hash, user_id, session_hash, method, expires_at, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM app_sign_in_codes WHERE user_id = ? AND used_at IS NULL) < ?
      AND EXISTS (SELECT 1 FROM auth_sessions WHERE token_hash = ? AND user_id = ?)`)
      .bind(codeId, await sha256(code), auth.userId, auth.tokenHash, method, expiresAt, now(), auth.userId, MAX_WAITING, auth.tokenHash, auth.userId),
    auditAfterChange(c.env, auth.userId, 'account.app_code.created', null, { codeId }),
  ]));
  if (created!.changes !== 1) {
    fail(429, 'too_many_codes', `You have ${MAX_WAITING} sign-in codes waiting. Use or cancel one, or wait 10 minutes for them to expire.`);
  }
  const link = `${APP_CODE_LINK}?${new URLSearchParams({ server: appOrigin(c.env), code }).toString()}`;
  return c.json({ id: codeId, code, link, expiresAt: new Date(expiresAt).toISOString() } satisfies AppSignInCode, 201);
}

async function codeState(c: AppContext) {
  const auth = c.get('auth');
  const row = await dbResult(c.env.DB.query<{ id: string; expires_at: number; used_at: string | null; device_name: string | null }>(
    'SELECT id, expires_at, used_at, device_name FROM app_sign_in_codes WHERE id = ? AND user_id = ? AND expires_at > ?')
    .bind(identifier(c.req.param('id'), 'codeId'), auth.userId, Date.now()).first());
  if (!row) fail(404, 'not_found', 'This sign-in code has expired or was cancelled.');
  return c.json({ id: row.id, status: row.used_at === null ? 'pending' : 'used', expiresAt: new Date(Number(row.expires_at)).toISOString(),
    deviceName: row.device_name } satisfies AppSignInCodeState);
}

async function cancelCode(c: AppContext) {
  const auth = c.get('auth');
  const removed = await dbResult(c.env.DB.query('DELETE FROM app_sign_in_codes WHERE id = ? AND user_id = ? AND used_at IS NULL RETURNING id')
    .bind(identifier(c.req.param('id'), 'codeId'), auth.userId).first());
  if (!removed) fail(404, 'not_found', 'This sign-in code was used, has expired or was cancelled.');
  return c.json({ ok: true });
}

async function signInWithCode(c: AppContext) {
  const body = await jsonObject(c, 4096);
  only(body, ['code', 'deviceName']);
  if (typeof body.code !== 'string' || !CODE.test(body.code)) fail(400, 'invalid_grant', EXPIRED);
  const deviceName = body.deviceName === undefined || body.deviceName === null ? null : safeText(body.deviceName, 'deviceName', 100);
  const found = await dbResult(c.env.DB.query<{ id: string; user_id: string; session_hash: string; method: string | null }>(
    'SELECT id, user_id, session_hash, method FROM app_sign_in_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?')
    .bind(await sha256(body.code), Date.now()).first());
  if (!found) fail(400, 'invalid_grant', EXPIRED);
  const user = await dbResult(getUser(c.env, found.user_id));
  if (!user || !['github', 'password', 'test'].includes(user.auth_kind)) fail(400, 'invalid_grant', EXPIRED);
  if (user.suspended_at) fail(403, 'account_suspended', SUSPENDED);
  const method = found.method === 'password' || user.auth_kind === 'password' ? 'password' : null;
  if (method === 'password' && !passwordAuthEnabled(c.env)) fail(400, 'invalid_grant', EXPIRED);
  if (localMode(c.env) && user.auth_kind !== 'test' && (await localOwner(c.env))?.id !== user.id) fail(400, 'invalid_grant', EXPIRED);
  const kind = user.auth_kind === 'test' ? 'test' : method === 'password' ? 'password' : 'github';
  const session = await newSession(c.env, user.id, kind, { deviceName }, { via: 'code', method });
  const at = Date.now();
  const [claimed, created] = await dbResult(c.env.DB.batch([
    c.env.DB.query(`UPDATE app_sign_in_codes SET used_at = ?, device_name = ? WHERE id = ? AND user_id = ? AND used_at IS NULL AND expires_at > ?
      AND EXISTS (SELECT 1 FROM auth_sessions WHERE token_hash = ? AND user_id = ? AND expires_at > ?)`)
      .bind(now(), deviceName, found.id, user.id, at, found.session_hash, user.id, at),
    session.statementWhere('changes() = 1'),
    auditAfterChange(c.env, user.id, 'account.app_code.used', null, { codeId: found.id, deviceName }),
  ]));
  if (claimed!.changes !== 1 || created!.changes !== 1) fail(400, 'invalid_grant', EXPIRED);
  return c.json({ token: session.token, expiresAt: new Date(session.expiresAt).toISOString(), user: ownProfile(c.env, user) } satisfies NativeSignIn);
}

const notLocal: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (localMode(c.env)) fail(404, 'not_found', 'A Pikibun on its owner\'s computer signs apps in with its sign-in link, not with codes.');
  await next();
};

export function registerAppCodes(app: Hono<AppEnv>): void {
  app.post('/api/auth/native/code', privateResponse, notLocal, signInWithCode);
  app.post('/api/me/app-codes', privateResponse, notLocal, authenticate, csrfGuard, makeCode);
  app.get('/api/me/app-codes/:id', privateResponse, notLocal, authenticate, codeState);
  app.delete('/api/me/app-codes/:id', privateResponse, notLocal, authenticate, csrfGuard, cancelCode);
}
