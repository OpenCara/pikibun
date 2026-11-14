import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import type { Hono } from 'hono';
import { isInstanceAdmin } from './admin.js';
import { authenticate, csrfGuard, dbResult, deviceNameFrom, newSession, ownProfile, privateResponse, safeText, sessionCookie, SUSPENDED } from './auth.js';
import { sha256 } from '../../../../packages/shared/src/crypto.js';
import { auditAfterChange } from './audit.js';
import { getUser } from '../db.js';
import { ConstraintError, type Database, type Query } from '../db/types.js';
import { fail, id, jsonObject, localMode, now, PASSWORD_USERNAME, passwordAuthEnabled, requireOrigin, signupMode, testMode } from '../http.js';
import { joinRequestStatement, requireInvitedWorkspace } from './invites.js';
import type { AppContext, Env, UserRow, AppEnv } from '../types.js';
import type { NativeSignIn } from '../../../../packages/shared/src/types.js';

const PASSWORD_MIN = 12;
const PASSWORD_MAX = 256;
const RAW_PASSWORD_MAX = PASSWORD_MAX * 4;
const SCRYPT = { N: 32768, r: 8, p: 1, keyLength: 32, saltLength: 16 } as const;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const FREE_FAILURES = 5;
const FIRST_LOCK_MS = 30_000;
const MAX_LOCK_MS = 15 * 60_000;
const HASH_CONCURRENCY = 4;
const HASH_QUEUE = 64;
const FIELDS = ['username', 'password', 'displayName', 'inviteToken'] as const;
export const RECENT_SIGN_IN_MS = 15 * 60_000;

const INCORRECT = 'The username or password is incorrect.';

function scrypt(password: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCallback(password, salt, keyLength, options, (error, key) => error ? reject(error) : resolve(key)));
}

let hashing = 0;
const waiting: (() => void)[] = [];

async function bounded<T>(work: () => Promise<T>): Promise<T> {
  if (hashing >= HASH_CONCURRENCY) {
    if (waiting.length >= HASH_QUEUE) fail(429, 'sign_in_busy', 'Too many sign-ins at once. Try again in a moment.');
    await new Promise<void>(resolve => waiting.push(resolve));
  } else {
    hashing++;
  }
  try {
    return await work();
  } finally {
    const next = waiting.shift();
    if (next) next(); else hashing--;
  }
}

function normalized(password: string): string {
  return password.normalize('NFKC');
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT.saltLength);
  const key = await bounded(() => scrypt(normalized(password), salt, SCRYPT.keyLength, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT_MAXMEM }));
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  if (![N, r, p].every(Number.isSafeInteger) || N < 2 || N > 1 << 17 || (N & (N - 1)) !== 0 || r < 1 || r > 16 || p < 1 || p > 4) return false;
  const salt = Buffer.from(parts[4]!, 'base64url');
  const expected = Buffer.from(parts[5]!, 'base64url');
  if (salt.length < 16 || expected.length < 16 || expected.length > 64) return false;
  const key = await bounded(() => scrypt(normalized(password), salt, expected.length, { N, r, p, maxmem: Math.max(SCRYPT_MAXMEM, 256 * N * r) }));
  return timingSafeEqual(key, expected);
}

export function onceSucceeded<T>(make: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => pending ??= make().catch(error => { pending = undefined; throw error; });
}

const decoyHash = onceSucceeded(() => hashPassword(randomBytes(32).toString('base64url')));
async function decoyVerify(password: string): Promise<void> {
  await verifyPassword(password, await decoyHash());
}

function requireEnabled(env: Env): void {
  if (!passwordAuthEnabled(env)) fail(404, 'not_found', 'Not found.');
}

function input(body: Record<string, unknown>, fields: readonly string[]): void {
  if (Object.keys(body).some(key => !fields.includes(key))) fail(400, 'invalid_input', `Only ${fields.join(', ')} are accepted.`);
}

export function passwordUsername(value: unknown): string {
  if (typeof value !== 'string') fail(400, 'invalid_username', 'Enter a username.');
  const result = value.trim().toLowerCase();
  if (!PASSWORD_USERNAME.test(result)) {
    fail(400, 'invalid_username', 'Usernames are 3 to 39 letters, digits, - and _, starting with a letter or digit.');
  }
  return result;
}

export function newPassword(value: unknown, name: string): string {
  if (typeof value !== 'string') fail(400, 'invalid_password', 'Enter a password.');
  if (value.length > RAW_PASSWORD_MAX) fail(400, 'invalid_password', `Use a password of at most ${PASSWORD_MAX} characters.`);
  const password = normalized(value);
  const length = [...password].length;
  if (length < PASSWORD_MIN) fail(400, 'weak_password', `Use a password of at least ${PASSWORD_MIN} characters.`);
  if (length > PASSWORD_MAX) fail(400, 'invalid_password', `Use a password of at most ${PASSWORD_MAX} characters.`);
  if (password.trim().toLowerCase() === name) fail(400, 'weak_password', 'Use a password other than your username.');
  return password;
}

function typedPassword(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > RAW_PASSWORD_MAX) fail(401, 'invalid_credentials', INCORRECT);
  return value;
}

interface CredentialRow { user_id: string; password_hash: string; failed_attempts: number; locked_until: number | null }

function lockedFor(row: Pick<CredentialRow, 'locked_until'>): number {
  const until = row.locked_until === null ? 0 : Number(row.locked_until);
  return until > Date.now() ? until - Date.now() : 0;
}

function failLocked(ms: number): never {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  fail(429, 'sign_in_locked', `Too many failed sign-ins. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
}

async function recordFailure(env: Env, userId: string): Promise<void> {
  const row = await dbResult(env.DB.query<{ failed_attempts: number }>(
    'UPDATE password_credentials SET failed_attempts = failed_attempts + 1 WHERE user_id = ? RETURNING failed_attempts').bind(userId).first());
  const failures = Number(row?.failed_attempts ?? 0);
  if (failures < FREE_FAILURES) return;
  const pause = Math.min(MAX_LOCK_MS, FIRST_LOCK_MS * 2 ** Math.min(failures - FREE_FAILURES, 16));
  await dbResult(env.DB.query('UPDATE password_credentials SET locked_until = ? WHERE user_id = ?').bind(Date.now() + pause, userId).run());
}

export function operatorPasswordResetStatements(db: Pick<Database, 'query'>, userId: string, hash: string, at: string): Query<never>[] {
  return [
    db.query<never>('UPDATE password_credentials SET password_hash = ?, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE user_id = ?').bind(hash, at, userId),
    db.query<never>('DELETE FROM auth_sessions WHERE user_id = ?').bind(userId),
  ];
}

export function operatorFirstPasswordStatement(db: Pick<Database, 'query'>, userId: string, hash: string, at: string): Query<never> {
  return db.query<never>(`INSERT INTO password_credentials (user_id, password_hash, failed_attempts, locked_until, created_at, updated_at)
    SELECT ?, ?, 0, NULL, ?, ? WHERE EXISTS (SELECT 1 FROM users WHERE id = ? AND auth_kind = 'password')`).bind(userId, hash, at, at, userId);
}

export function passwordAccountStatements(db: Pick<Database, 'query'>, name: string, displayName: string, hash: string) {
  const userId = `password:${name}`;
  const created = now();
  return [
    db.query(`INSERT INTO users (id, username, github_id, github_login, display_name, git_name, git_email, env_json, auth_kind, created_at)
      VALUES (?, ?, NULL, NULL, ?, ?, ?, '{}', 'password', ?)`).bind(userId, name, displayName, displayName, `${name}@users.pikibun.invalid`, created),
    db.query('INSERT INTO password_credentials (user_id, password_hash, failed_attempts, locked_until, created_at, updated_at) VALUES (?, ?, 0, NULL, ?, ?)')
      .bind(userId, hash, created, created),
  ];
}

class SignupRefused extends Error {}

async function signUp(c: AppContext) {
  requireEnabled(c.env);
  requireOrigin(c);
  const mode = signupMode(c.env, 'password');
  if (mode === 'off') fail(403, 'signup_closed', 'This server doesn\'t take new accounts. Ask its operator for one.');
  const body = await jsonObject(c, 4096);
  input(body, FIELDS);
  if (mode === 'invite' && (body.inviteToken === undefined || body.inviteToken === null)) {
    fail(403, 'invite_required', 'New accounts need an invite link. Ask a workspace owner or admin for theirs, and open it to sign up.');
  }
  const invited = body.inviteToken === undefined || body.inviteToken === null ? null
    : { workspace: await requireInvitedWorkspace(c.env, body.inviteToken), tokenHash: await sha256(body.inviteToken as string) };
  const name = passwordUsername(body.username);
  const userId = `password:${name}`;
  const password = newPassword(body.password, name);
  const displayName = body.displayName === undefined || body.displayName === '' ? name : safeText(body.displayName, 'displayName', 200);
  if (isInstanceAdmin(c.env, userId)) {
    fail(409, 'username_reserved', 'This username is reserved for an administrator of this server, whose operator creates it.');
  }
  const hash = await hashPassword(password);
  const session = await newSession(c.env, userId, 'password');
  try {
    await c.env.DB.transaction(async tx => {
      for (const statement of passwordAccountStatements(tx, name, displayName, hash)) await statement.run();
      if (invited) {
        const filed = await joinRequestStatement(tx, invited.workspace.id, invited.tokenHash, userId).run();
        if (filed.changes !== 1) throw new SignupRefused();
        await tx.query('INSERT INTO audit (id, workspace_id, session_id, actor_id, action, detail_json, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?)')
          .bind(id(), invited.workspace.id, userId, 'workspace.join.request', JSON.stringify({ userId }), now()).run();
      }
      await tx.query('INSERT INTO audit (id, workspace_id, session_id, actor_id, action, detail_json, created_at) VALUES (?, NULL, NULL, ?, ?, ?, ?)')
        .bind(id(), userId, 'account.password.signed_up', JSON.stringify(invited ? { workspaceId: invited.workspace.id } : {}), now()).run();
      await tx.query(session.sql).bind(...session.values).run();
    });
  } catch (error) {
    if (error instanceof ConstraintError) fail(409, 'username_taken', 'That username is taken. Choose another.');
    if (error instanceof SignupRefused) {
      fail(409, 'too_many_pending', 'This workspace has too many people waiting to join, or its invite link was just turned off. Ask an owner or admin.');
    }
    fail(503, 'auth_unavailable', 'Authentication storage is temporarily unavailable.');
  }
  sessionCookie(c, session);
  const user = await dbResult(getUser(c.env, userId));
  return c.json({ user: ownProfile(c.env, user!) }, 201);
}

export const USERNAME_MATCH = 'WHERE u.id = ? OR u.username = ? ORDER BY CASE WHEN u.id = ? THEN 0 ELSE 1 END LIMIT 1';
export function usernameMatch(name: string): string[] {
  return [`password:${name}`, name, `password:${name}`];
}

function signsInWithPassword(row: { user_id: string; auth_kind: UserRow['auth_kind'] }): boolean {
  return row.auth_kind === 'password' ? row.user_id.startsWith('password:') : row.auth_kind === 'github';
}

async function passwordSignIn(c: AppContext, body: Record<string, unknown>, native?: { deviceName: string | null }) {
  const typed = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
  const password = typedPassword(body.password);
  const row = PASSWORD_USERNAME.test(typed) ? await dbResult(c.env.DB.query<CredentialRow & { auth_kind: UserRow['auth_kind']; suspended_at: string | null }>(
    `SELECT p.user_id, p.password_hash, p.failed_attempts, p.locked_until, u.auth_kind, u.suspended_at
    FROM users u JOIN password_credentials p ON p.user_id = u.id ${USERNAME_MATCH}`).bind(...usernameMatch(typed)).first()) : null;
  if (!row || !signsInWithPassword(row)) {
    await decoyVerify(password);
    fail(401, 'invalid_credentials', INCORRECT);
  }
  const locked = lockedFor(row);
  if (locked) failLocked(locked);
  if (!await verifyPassword(password, row.password_hash)) {
    await recordFailure(c.env, row.user_id);
    fail(401, 'invalid_credentials', INCORRECT);
  }
  if (row.suspended_at) fail(403, 'account_suspended', SUSPENDED);
  const session = await newSession(c.env, row.user_id, 'password', native);
  const [cleared, created] = await dbResult(c.env.DB.batch([
    c.env.DB.query('UPDATE password_credentials SET failed_attempts = 0, locked_until = NULL WHERE user_id = ? AND password_hash = ?')
      .bind(row.user_id, row.password_hash),
    session.statementWhere('EXISTS (SELECT 1 FROM password_credentials WHERE user_id = ? AND password_hash = ?)', row.user_id, row.password_hash),
  ]));
  if (cleared!.changes !== 1 || created!.changes !== 1) fail(401, 'invalid_credentials', INCORRECT);
  const user = await dbResult(getUser(c.env, row.user_id));
  if (!user) fail(401, 'unauthorized', 'Authentication is required.');
  return { session, user };
}

async function signIn(c: AppContext) {
  requireEnabled(c.env);
  requireOrigin(c);
  const body = await jsonObject(c, 4096);
  input(body, ['username', 'password']);
  const { session, user } = await passwordSignIn(c, body);
  sessionCookie(c, session);
  return c.json({ user: ownProfile(c.env, user) });
}

async function nativeSignIn(c: AppContext) {
  requireEnabled(c.env);
  const body = await jsonObject(c, 4096);
  input(body, ['username', 'password', 'deviceName']);
  const deviceName = deviceNameFrom(body.deviceName);
  const { session, user } = await passwordSignIn(c, body, { deviceName });
  return c.json({ token: session.token, expiresAt: new Date(session.expiresAt).toISOString(), user: ownProfile(c.env, user) } satisfies NativeSignIn);
}

function accountUsername(user: UserRow): string | null {
  return user.username ?? (user.auth_kind === 'password' && user.id.startsWith('password:') ? user.id.slice('password:'.length) : null);
}

async function signedInUser(c: AppContext): Promise<UserRow> {
  const user = await dbResult(getUser(c.env, c.get('auth').userId));
  if (!user) fail(401, 'unauthorized', 'Authentication is required.');
  return user;
}

async function recentGitHubSignIn(env: Env, user: UserRow, tokenHash: string): Promise<boolean> {
  if (localMode(env) || (user.auth_kind !== 'github' && !(user.auth_kind === 'test' && testMode(env)))) return false;
  const session = await dbResult(env.DB.query<{ created_at: string; method: string | null; via: string | null }>(
    'SELECT created_at, method, via FROM auth_sessions WHERE token_hash = ? AND user_id = ?').bind(tokenHash, user.id).first());
  const signedInAt = session ? Date.parse(session.created_at) : NaN;
  return !!session && session.method === null && session.via === null && Number.isFinite(signedInAt) && Date.now() - signedInAt <= RECENT_SIGN_IN_MS;
}

export async function requireRecentOwner(c: AppContext, current: unknown): Promise<'password' | 'github'> {
  const user = await signedInUser(c);
  const typed = current !== undefined && current !== null && current !== '';
  if (typed) {
    if (!passwordAuthEnabled(c.env)) fail(400, 'password_auth_off', 'This server doesn\'t take passwords now. Sign in with GitHub again instead.');
    const row = await credential(c.env, user.id);
    if (!row) fail(400, 'invalid_input', 'This account has no password yet, so there is no current one to enter.');
    const locked = lockedFor(row);
    if (locked) failLocked(locked);
    if (typeof current !== 'string' || current.length > RAW_PASSWORD_MAX || !await verifyPassword(current, row.password_hash)) {
      await recordFailure(c.env, user.id);
      fail(403, 'invalid_credentials', 'The current password is incorrect.');
    }
    return 'password';
  }
  if (user.auth_kind === 'password') fail(403, 'current_password_required', 'Enter your password.');
  if (!await recentGitHubSignIn(c.env, user, c.get('auth').tokenHash)) {
    fail(403, 'recent_sign_in_required', user.has_password && passwordAuthEnabled(c.env)
      ? 'Enter your password, or sign in with GitHub again: this needs a GitHub sign-in from the last 15 minutes.' : RECENT_SIGN_IN_REQUIRED);
  }
  return 'github';
}

const RECENT_SIGN_IN_REQUIRED = 'For your safety, this needs a GitHub sign-in from the last 15 minutes. Sign in with GitHub again, then try once more.';
const CURRENT_OR_RECENT_SIGN_IN = 'Enter your current password. Forgot it? Sign in with GitHub again, and within 15 minutes you can set a new one without it.';

function credential(env: Env, userId: string) {
  return dbResult(env.DB.query<CredentialRow>('SELECT user_id, password_hash, failed_attempts, locked_until FROM password_credentials WHERE user_id = ?')
    .bind(userId).first());
}

async function requireOwner(c: AppContext, user: UserRow, row: CredentialRow | null, current: unknown): Promise<void> {
  const typed = current !== undefined && current !== null && current !== '';
  if (typed || user.auth_kind === 'password') {
    if (!row) fail(400, 'invalid_input', 'This account has no password yet, so there is no current one to enter.');
    const locked = lockedFor(row);
    if (locked) failLocked(locked);
    if (typeof current !== 'string' || current.length > RAW_PASSWORD_MAX || !await verifyPassword(current, row.password_hash)) {
      await recordFailure(c.env, user.id);
      fail(403, 'invalid_credentials', 'The current password is incorrect.');
    }
    return;
  }
  if (!await recentGitHubSignIn(c.env, user, c.get('auth').tokenHash)) {
    fail(403, 'recent_sign_in_required', row ? CURRENT_OR_RECENT_SIGN_IN : RECENT_SIGN_IN_REQUIRED);
  }
}

async function setPassword(c: AppContext) {
  requireEnabled(c.env);
  const auth = c.get('auth');
  const body = await jsonObject(c, 4096);
  input(body, ['currentPassword', 'newPassword']);
  const user = await signedInUser(c);
  const row = await credential(c.env, auth.userId);
  if (!row && user.auth_kind === 'password') fail(404, 'no_password', 'This account has no password. Ask the server\'s operator to set one.');
  const username = accountUsername(user);
  if (!username) fail(409, 'username_required', 'Choose your username first: you sign in with it and your password.');
  const password = newPassword(body.newPassword, username);
  await requireOwner(c, user, row, body.currentPassword);
  const hash = await hashPassword(password);
  const timestamp = now();
  if (!row) {
    const [created] = await dbResult(c.env.DB.batch([
      c.env.DB.query(`INSERT INTO password_credentials (user_id, password_hash, failed_attempts, locked_until, created_at, updated_at)
        SELECT ?, ?, 0, NULL, ?, ? WHERE EXISTS (SELECT 1 FROM auth_sessions WHERE token_hash = ? AND user_id = ?)
        AND NOT EXISTS (SELECT 1 FROM password_credentials WHERE user_id = ?)`)
        .bind(auth.userId, hash, timestamp, timestamp, auth.tokenHash, auth.userId, auth.userId),
      auditAfterChange(c.env, auth.userId, 'account.password.set', null, {}),
    ]));
    if (created!.changes !== 1) fail(409, 'password_changed', 'A password was set meanwhile, or this browser was signed out. Reload and try again.');
  } else {
    const [changed] = await dbResult(c.env.DB.batch([
      c.env.DB.query(`UPDATE password_credentials SET password_hash = ?, failed_attempts = 0, locked_until = NULL, updated_at = ?
        WHERE user_id = ? AND password_hash = ? AND EXISTS (SELECT 1 FROM auth_sessions WHERE token_hash = ? AND user_id = ?)`)
        .bind(hash, timestamp, auth.userId, row.password_hash, auth.tokenHash, auth.userId),
      auditAfterChange(c.env, auth.userId, 'account.password.changed', null, {}),
      c.env.DB.query(`DELETE FROM auth_sessions WHERE user_id = ? AND token_hash <> ?
        AND EXISTS (SELECT 1 FROM password_credentials WHERE user_id = ? AND password_hash = ?)`).bind(auth.userId, auth.tokenHash, auth.userId, hash),
    ]));
    if (changed!.changes !== 1) fail(409, 'password_changed', 'Your password was changed or reset meanwhile, or this browser was signed out. Sign in again.');
  }
  return c.json({ ok: true, user: ownProfile(c.env, await signedInUser(c)) });
}

async function removePassword(c: AppContext) {
  const auth = c.get('auth');
  const body = await jsonObject(c, 4096);
  input(body, ['currentPassword']);
  const user = await signedInUser(c);
  if (user.auth_kind === 'password') fail(409, 'password_required', 'A password account signs in only with its password. Change it instead.');
  const row = await credential(c.env, auth.userId);
  if (!row) fail(404, 'no_password', 'This account has no password.');
  await requireOwner(c, user, row, body.currentPassword);
  const [removed] = await dbResult(c.env.DB.batch([
    c.env.DB.query(`DELETE FROM password_credentials WHERE user_id = ? AND password_hash = ?
      AND EXISTS (SELECT 1 FROM auth_sessions WHERE token_hash = ? AND user_id = ?)`).bind(auth.userId, row.password_hash, auth.tokenHash, auth.userId),
    auditAfterChange(c.env, auth.userId, 'account.password.removed', null, {}),
    c.env.DB.query(`DELETE FROM auth_sessions WHERE user_id = ? AND method = 'password' AND token_hash <> ?
      AND NOT EXISTS (SELECT 1 FROM password_credentials WHERE user_id = ?)`).bind(auth.userId, auth.tokenHash, auth.userId),
  ]));
  if (removed!.changes !== 1) fail(409, 'password_changed', 'Your password was changed meanwhile, or this browser was signed out. Reload and try again.');
  return c.json({ ok: true, user: ownProfile(c.env, await signedInUser(c)) });
}

class UsernameRefused extends Error {}

async function chooseUsername(c: AppContext) {
  const auth = c.get('auth');
  const body = await jsonObject(c, 4096);
  input(body, ['username', 'password']);
  const user = await signedInUser(c);
  if (accountUsername(user)) fail(409, 'username_set', 'Your username is set already, and can\'t be changed.');
  const name = passwordUsername(body.username);
  if (isInstanceAdmin(c.env, `password:${name}`)) {
    fail(409, 'username_reserved', 'This username is reserved for an administrator of this server. Choose another.');
  }
  let hash: string | null = null;
  if (body.password !== undefined && body.password !== null && body.password !== '') {
    if (!passwordAuthEnabled(c.env)) fail(400, 'password_auth_off', 'This server doesn\'t offer sign-in with a username and password.');
    const password = newPassword(body.password, name);
    if (!await recentGitHubSignIn(c.env, user, auth.tokenHash)) fail(403, 'recent_sign_in_required', RECENT_SIGN_IN_REQUIRED);
    hash = await hashPassword(password);
  }
  const timestamp = now();
  try {
    await c.env.DB.transaction(async tx => {
      const chosen = await tx.query(`UPDATE users SET username = ? WHERE id = ? AND username IS NULL
        AND EXISTS (SELECT 1 FROM auth_sessions WHERE token_hash = ? AND user_id = ?)`).bind(name, auth.userId, auth.tokenHash, auth.userId).run();
      if (chosen.changes !== 1) throw new UsernameRefused();
      await tx.query('INSERT INTO audit (id, workspace_id, session_id, actor_id, action, detail_json, created_at) VALUES (?, NULL, NULL, ?, ?, ?, ?)')
        .bind(id(), auth.userId, 'account.username.chosen', JSON.stringify({ username: name }), timestamp).run();
      if (hash) {
        await tx.query(`INSERT INTO password_credentials (user_id, password_hash, failed_attempts, locked_until, created_at, updated_at)
          VALUES (?, ?, 0, NULL, ?, ?)`).bind(auth.userId, hash, timestamp, timestamp).run();
        await tx.query('INSERT INTO audit (id, workspace_id, session_id, actor_id, action, detail_json, created_at) VALUES (?, NULL, NULL, ?, ?, ?, ?)')
          .bind(id(), auth.userId, 'account.password.set', '{}', timestamp).run();
      }
    });
  } catch (error) {
    if (error instanceof ConstraintError) fail(409, 'username_taken', 'That username is taken. Choose another.');
    if (error instanceof UsernameRefused) fail(409, 'username_set', 'Your username was set meanwhile, or this browser was signed out. Reload the page.');
    fail(503, 'auth_unavailable', 'Authentication storage is temporarily unavailable.');
  }
  return c.json({ user: ownProfile(c.env, await signedInUser(c)) });
}

export function registerPasswordAuth(app: Hono<AppEnv>): void {
  app.post('/api/auth/password/signup', privateResponse, signUp);
  app.post('/api/auth/password/login', privateResponse, signIn);
  app.post('/api/auth/native/password', privateResponse, nativeSignIn);
  app.post('/api/me/password', privateResponse, authenticate, csrfGuard, setPassword);
  app.delete('/api/me/password', privateResponse, authenticate, csrfGuard, removePassword);
  app.post('/api/me/username', privateResponse, authenticate, csrfGuard, chooseUsername);
}
