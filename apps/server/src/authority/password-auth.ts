import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import type { Hono } from 'hono';
import { isInstanceAdmin } from './admin.js';
import { authenticate, csrfGuard, dbResult, newSession, ownProfile, privateResponse, safeText, sessionCookie, SUSPENDED } from './auth.js';
import { sha256 } from '../../../../packages/shared/src/crypto.js';
import { auditAfterChange } from './audit.js';
import { getUser } from '../db.js';
import { ConstraintError, type Database } from '../db/types.js';
import { fail, id, jsonObject, now, PASSWORD_USERNAME, passwordAuthEnabled, requireOrigin, signupMode, testMode } from '../http.js';
import { joinRequestStatement, requireInvitedWorkspace } from './invites.js';
import type { AppContext, Env, UserRow, AppEnv } from '../types.js';
import type { NativeSignIn } from '../../../../packages/shared/src/types.js';

/**
 * Username and password accounts, for servers whose operator sets PASSWORD_AUTH=true: people sign up as
 * `password:<username>` and sign in with that username. Who may sign up is SIGNUP's choice (http.ts signupMode): by
 * default only someone holding a workspace's invite link, whose request to join that workspace is filed with the account.
 * The operator creates accounts from the command line as well (password-accounts-cli.ts). They are full accounts that
 * sign in with a cookie like GitHub's, but hold no GitHub token: github.com repositories need a GitHub sign-in, and other
 * providers work through personal access tokens under Settings → Profile → Connected accounts. Native apps sign in with
 * them too (POST /api/auth/native/password), for a bearer token instead of the cookie.
 *
 * Usernames are one namespace for every account (users.username). A GitHub account chooses its own once, right after
 * signing up (POST /api/me/username), optionally with a password; it can then sign in with either, and set, change or
 * remove that password under Settings → Password. Its GitHub sign-in stays the stronger proof: one from the last few
 * minutes stands in for the current password, so a forgotten one is replaced without the operator, while a stolen
 * browser session that is older can't add or replace a password to keep its way in.
 */

const PASSWORD_MIN = 12;
const PASSWORD_MAX = 256;
/** The longest password accepted as typed (UTF-16 code units), before NFKC: room for composing characters. */
const RAW_PASSWORD_MAX = PASSWORD_MAX * 4;
/** scrypt with 32 MiB per hash (N=2^15, r=8): about 50-100 ms of one CPU, and too costly to try offline at scale. */
const SCRYPT = { N: 32768, r: 8, p: 1, keyLength: 32, saltLength: 16 } as const;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
/** Failed sign-ins in a row before the account pauses, and how long the pause grows to. */
const FREE_FAILURES = 5;
const FIRST_LOCK_MS = 30_000;
const MAX_LOCK_MS = 15 * 60_000;
/** Hashes running at once, and waiting: a flood of sign-ins gets 429s instead of starving the server's thread pool. */
const HASH_CONCURRENCY = 4;
const HASH_QUEUE = 64;
const FIELDS = ['username', 'password', 'displayName', 'inviteToken'] as const;
/** How recent a GitHub sign-in stands in for a GitHub account's current password: to set its first, a forgotten one, or remove it. */
export const RECENT_SIGN_IN_MS = 15 * 60_000;

const INCORRECT = 'The username or password is incorrect.';

function scrypt(password: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCallback(password, salt, keyLength, options, (error, key) => error ? reject(error) : resolve(key)));
}

let hashing = 0;
const waiting: (() => void)[] = [];

/** Runs one scrypt through the bounded queue. */
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
    // The slot passes straight to the next waiter, so the count only drops when nobody waits.
    const next = waiting.shift();
    if (next) next(); else hashing--;
  }
}

/** Passwords compare as Unicode NFKC, so the same password typed on another keyboard or system still matches. */
function normalized(password: string): string {
  return password.normalize('NFKC');
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT.saltLength);
  const key = await bounded(() => scrypt(normalized(password), salt, SCRYPT.keyLength, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT_MAXMEM }));
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** Whether `password` matches a stored hash. Stored parameters are bounded, so a corrupted row can't exhaust memory. */
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

/** `make`'s result, made once it succeeds: a failure (a busy server, say) is forgotten, so the next call makes it again. */
export function onceSucceeded<T>(make: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => pending ??= make().catch(error => { pending = undefined; throw error; });
}

/** Spends a hash's time on a sign-in with no account, so its answer doesn't say the username is free. */
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

/** A typed username: case and surrounding spaces don't matter. */
export function passwordUsername(value: unknown): string {
  if (typeof value !== 'string') fail(400, 'invalid_username', 'Enter a username.');
  const result = value.trim().toLowerCase();
  if (!PASSWORD_USERNAME.test(result)) {
    fail(400, 'invalid_username', 'Usernames are 3 to 39 letters, digits, - and _, starting with a letter or digit.');
  }
  return result;
}

/**
 * A new password: long enough, and not the username, both judged as it is hashed (NFKC), so a fullwidth copy of the
 * username or combining characters that compose into fewer don't pass. Any characters are allowed, spaces too.
 */
export function newPassword(value: unknown, name: string): string {
  if (typeof value !== 'string') fail(400, 'invalid_password', 'Enter a password.');
  // Bounded before normalizing, which can lengthen text.
  if (value.length > RAW_PASSWORD_MAX) fail(400, 'invalid_password', `Use a password of at most ${PASSWORD_MAX} characters.`);
  const password = normalized(value);
  const length = [...password].length;
  if (length < PASSWORD_MIN) fail(400, 'weak_password', `Use a password of at least ${PASSWORD_MIN} characters.`);
  if (length > PASSWORD_MAX) fail(400, 'invalid_password', `Use a password of at most ${PASSWORD_MAX} characters.`);
  if (password.trim().toLowerCase() === name) fail(400, 'weak_password', 'Use a password other than your username.');
  return password;
}

/** A password typed to sign in, bounded before it is hashed. */
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

/** Counts a failed sign-in; from the sixth in a row the account pauses, 30 seconds at first and doubling to 15 minutes. */
async function recordFailure(env: Env, userId: string): Promise<void> {
  const row = await dbResult(env.DB.query<{ failed_attempts: number }>(
    'UPDATE password_credentials SET failed_attempts = failed_attempts + 1 WHERE user_id = ? RETURNING failed_attempts').bind(userId).first());
  const failures = Number(row?.failed_attempts ?? 0);
  if (failures < FREE_FAILURES) return;
  const pause = Math.min(MAX_LOCK_MS, FIRST_LOCK_MS * 2 ** Math.min(failures - FREE_FAILURES, 16));
  await dbResult(env.DB.query('UPDATE password_credentials SET locked_until = ? WHERE user_id = ?').bind(Date.now() + pause, userId).run());
}

/**
 * The statements that create a password account, in order: its user (with a placeholder Git email that can't be
 * delivered to; its owner sets their own under Profile) and its credential. A taken username fails with ConstraintError.
 */
export function passwordAccountStatements(db: Pick<Database, 'query'>, name: string, displayName: string, hash: string) {
  const userId = `password:${name}`;
  const created = now();
  return [
    // The username is the GitHub accounts' namespace too: one that took it fails here as well.
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
  // Signing up through an invite link files a request to join its workspace with the account, in any mode.
  if (mode === 'invite' && (body.inviteToken === undefined || body.inviteToken === null)) {
    fail(403, 'invite_required', 'New accounts need an invite link. Ask a workspace owner or admin for theirs, and open it to sign up.');
  }
  const invited = body.inviteToken === undefined || body.inviteToken === null ? null
    : { workspace: await requireInvitedWorkspace(c.env, body.inviteToken), tokenHash: await sha256(body.inviteToken as string) };
  const name = passwordUsername(body.username);
  const userId = `password:${name}`;
  const password = newPassword(body.password, name);
  const displayName = body.displayName === undefined || body.displayName === '' ? name : safeText(body.displayName, 'displayName', 200);
  // An operator may list an account in ADMIN_USER_IDS before it exists: only they can create it then (see adminUserId).
  if (isInstanceAdmin(c.env, userId)) {
    fail(409, 'username_reserved', 'This username is reserved for an administrator of this server, whose operator creates it.');
  }
  const hash = await hashPassword(password);
  const session = await newSession(c.env, userId, 'password');
  try {
    await c.env.DB.transaction(async tx => {
      for (const statement of passwordAccountStatements(tx, name, displayName, hash)) await statement.run();
      if (invited) {
        // The account exists only with its request: a full queue or a link turned off meanwhile creates neither.
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

/**
 * The account a username names, with `usernameMatch`'s values: the one that chose it, or the password account whose ID it
 * is, where a row predates the username column's backfill (an older dump, say). The migration gives them the same name,
 * and usernames are unique, so they are the same account; the password account wins if they ever weren't.
 */
export const USERNAME_MATCH = 'WHERE u.id = ? OR u.username = ? ORDER BY CASE WHEN u.id = ? THEN 0 ELSE 1 END LIMIT 1';
export function usernameMatch(name: string): string[] {
  return [`password:${name}`, name, `password:${name}`];
}

/** Whether an account with a password may sign in with it: a password account, or a GitHub account that set one. */
function signsInWithPassword(row: { user_id: string; auth_kind: UserRow['auth_kind'] }): boolean {
  return row.auth_kind === 'password' ? row.user_id.startsWith('password:') : row.auth_kind === 'github';
}

/**
 * Checks a typed username and password and starts a sign-in for its account: a browser's (cookie) or, with `native`, a
 * native app's bearer session listed under its device name. Every wrong guess gets the same answer.
 */
async function passwordSignIn(c: AppContext, body: Record<string, unknown>, native?: { deviceName: string | null }) {
  // A malformed username can't name an account, so it gets the same answer as a wrong password.
  const typed = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
  const password = typedPassword(body.password);
  // By username, whichever kind of account took it: a password account's is the name in its ID, a GitHub account's its own.
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
  // Only a correct password says the account is suspended.
  if (row.suspended_at) fail(403, 'account_suspended', SUSPENDED);
  const session = await newSession(c.env, row.user_id, 'password', native);
  // Only while the password checked above is still the account's: a reset or change that landed while it was being
  // hashed signs the account out everywhere, and this sign-in must not outlive it.
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

/**
 * A native app's sign-in with a username and password: a bearer token in the answer, as /api/auth/native/token gives for
 * GitHub, never a cookie. Like that route it has no origin check: it sets nothing a browser would send by itself, and a
 * page of another site can't post its JSON without a CORS preflight the server never grants.
 */
async function nativeSignIn(c: AppContext) {
  requireEnabled(c.env);
  const body = await jsonObject(c, 4096);
  input(body, ['username', 'password', 'deviceName']);
  const deviceName = body.deviceName === undefined || body.deviceName === null ? null : safeText(body.deviceName, 'deviceName', 100);
  const { session, user } = await passwordSignIn(c, body, { deviceName });
  return c.json({ token: session.token, expiresAt: new Date(session.expiresAt).toISOString(), user: ownProfile(c.env, user) } satisfies NativeSignIn);
}

/** The account's username: the one it chose, or a password account's from its ID (see USERNAME_MATCH). */
function accountUsername(user: UserRow): string | null {
  return user.username ?? (user.auth_kind === 'password' && user.id.startsWith('password:') ? user.id.slice('password:'.length) : null);
}

async function signedInUser(c: AppContext): Promise<UserRow> {
  const user = await dbResult(getUser(c.env, c.get('auth').userId));
  if (!user) fail(401, 'unauthorized', 'Authentication is required.');
  return user;
}

/**
 * Whether this browser or app signed in to a GitHub account with GitHub itself, in the last RECENT_SIGN_IN_MS: proof of
 * the account's owner that stands in for its current password. A password account has no such proof, nor does a sign-in
 * made with the password; a test account's test sign-in counts, in test mode only, where it exists at all.
 */
async function recentGitHubSignIn(env: Env, user: UserRow, tokenHash: string): Promise<boolean> {
  if (user.auth_kind !== 'github' && !(user.auth_kind === 'test' && testMode(env))) return false;
  const session = await dbResult(env.DB.query<{ created_at: string; method: string | null }>(
    'SELECT created_at, method FROM auth_sessions WHERE token_hash = ? AND user_id = ?').bind(tokenHash, user.id).first());
  const signedInAt = session ? Date.parse(session.created_at) : NaN;
  return !!session && session.method === null && Number.isFinite(signedInAt) && Date.now() - signedInAt <= RECENT_SIGN_IN_MS;
}

const RECENT_SIGN_IN_REQUIRED = 'For your safety, this needs a GitHub sign-in from the last 15 minutes. Sign in with GitHub again, then try once more.';
const CURRENT_OR_RECENT_SIGN_IN = 'Enter your current password. Forgot it? Sign in with GitHub again, and within 15 minutes you can set a new one without it.';

function credential(env: Env, userId: string) {
  return dbResult(env.DB.query<CredentialRow>('SELECT user_id, password_hash, failed_attempts, locked_until FROM password_credentials WHERE user_id = ?')
    .bind(userId).first());
}

/**
 * Checks what stands for the account's owner before its password changes or goes: the current password when one is typed
 * (and always for a password account, which has nothing else), or else a recent GitHub sign-in. A wrong password counts
 * as a failed sign-in, so a stolen browser session can't guess its way to the password either. Failed sign-ins lock only
 * the password: a recent GitHub sign-in still replaces or removes it, so nobody who knows the username can keep its owner
 * from getting rid of a password by locking it.
 */
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

/**
 * Sets the signed-in account's password. A password account changes its own with its current password. A GitHub account
 * sets its first one, or changes it with the current one or a recent GitHub sign-in, once it has a username to sign in
 * with. Replacing a password signs out every other browser and app signed in as the account.
 */
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
    // The first password, while this browser is still signed in and nothing set one meanwhile.
    const [created] = await dbResult(c.env.DB.batch([
      c.env.DB.query(`INSERT INTO password_credentials (user_id, password_hash, failed_attempts, locked_until, created_at, updated_at)
        SELECT ?, ?, 0, NULL, ?, ? WHERE EXISTS (SELECT 1 FROM auth_sessions WHERE token_hash = ? AND user_id = ?)
        AND NOT EXISTS (SELECT 1 FROM password_credentials WHERE user_id = ?)`)
        .bind(auth.userId, hash, timestamp, timestamp, auth.tokenHash, auth.userId, auth.userId),
      auditAfterChange(c.env, auth.userId, 'account.password.set', null, {}),
    ]));
    if (created!.changes !== 1) fail(409, 'password_changed', 'A password was set meanwhile, or this browser was signed out. Reload and try again.');
  } else {
    // Only from the password checked above, and while this browser is still signed in: a reset, another change or a
    // sign-out that landed while hashing wins, rather than being overwritten.
    const [changed] = await dbResult(c.env.DB.batch([
      c.env.DB.query(`UPDATE password_credentials SET password_hash = ?, failed_attempts = 0, locked_until = NULL, updated_at = ?
        WHERE user_id = ? AND password_hash = ? AND EXISTS (SELECT 1 FROM auth_sessions WHERE token_hash = ? AND user_id = ?)`)
        .bind(hash, timestamp, auth.userId, row.password_hash, auth.tokenHash, auth.userId),
      auditAfterChange(c.env, auth.userId, 'account.password.changed', null, {}),
      // The new hash is salted, so it is there only if this change landed.
      c.env.DB.query(`DELETE FROM auth_sessions WHERE user_id = ? AND token_hash <> ?
        AND EXISTS (SELECT 1 FROM password_credentials WHERE user_id = ? AND password_hash = ?)`).bind(auth.userId, auth.tokenHash, auth.userId, hash),
    ]));
    if (changed!.changes !== 1) fail(409, 'password_changed', 'Your password was changed or reset meanwhile, or this browser was signed out. Sign in again.');
  }
  return c.json({ ok: true, user: ownProfile(c.env, await signedInUser(c)) });
}

/**
 * Removes a GitHub account's password, with the current one or a recent GitHub sign-in: it signs in with GitHub only
 * again, and every browser and app that signed in with the password, other than this one, is signed out. Allowed with
 * PASSWORD_AUTH off as well, so nobody has to keep a password the server no longer takes. A password account has no
 * other way in, so it can't.
 */
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

/**
 * A GitHub account chooses its username, once: the web app asks for it right after signing up, before anything else.
 * With PASSWORD_AUTH on it may set a password in the same step, to sign in with the username later; that takes a recent
 * GitHub sign-in, as setting one later does. The username can't be changed afterwards, so nobody else can take up a name
 * teammates know someone by.
 */
async function chooseUsername(c: AppContext) {
  const auth = c.get('auth');
  const body = await jsonObject(c, 4096);
  input(body, ['username', 'password']);
  const user = await signedInUser(c);
  if (accountUsername(user)) fail(409, 'username_set', 'Your username is set already, and can\'t be changed.');
  const name = passwordUsername(body.username);
  // ADMIN_USER_IDS may list password:<name> before its operator creates it: the name is theirs.
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
      // Only once, and only while this browser is still signed in.
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
    // The username is taken (by any account), or a password was set meanwhile.
    if (error instanceof ConstraintError) fail(409, 'username_taken', 'That username is taken. Choose another.');
    if (error instanceof UsernameRefused) fail(409, 'username_set', 'Your username was set meanwhile, or this browser was signed out. Reload the page.');
    fail(503, 'auth_unavailable', 'Authentication storage is temporarily unavailable.');
  }
  return c.json({ user: ownProfile(c.env, await signedInUser(c)) });
}

// Register before the /api/* authenticate + csrfGuard stack, like registerAuth: sign-up and sign-in have no session yet.
export function registerPasswordAuth(app: Hono<AppEnv>): void {
  app.post('/api/auth/password/signup', privateResponse, signUp);
  app.post('/api/auth/password/login', privateResponse, signIn);
  app.post('/api/auth/native/password', privateResponse, nativeSignIn);
  app.post('/api/me/password', privateResponse, authenticate, csrfGuard, setPassword);
  app.delete('/api/me/password', privateResponse, authenticate, csrfGuard, removePassword);
  app.post('/api/me/username', privateResponse, authenticate, csrfGuard, chooseUsername);
}
