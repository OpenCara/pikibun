import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { acquireRunnerLease, RunnerLeaseBusyError } from '../../../runner/src/lease.js';

export const defaultLocalStateDir = (): string => join(homedir(), '.local', 'share', 'pikibun', 'server');
export const DEFAULT_LOCAL_PORT = 7878;
const STATE_FILE = 'server.json';
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const CLIENT_ID = /^[A-Za-z0-9._-]{1,100}$/;
const CLIENT_SECRET = /^[A-Za-z0-9._-]{1,200}$/;

export class LocalStateError extends Error {}

export interface GitHubOAuthApp { clientId: string; clientSecret: string }

export interface SharedConfig {
  origin: string;
  listen: 'loopback' | 'all';
  trustProxy: boolean;
  signup: 'open' | 'invite' | 'off';
  passwordAuth: boolean;
  admins: string[];
  github?: GitHubOAuthApp;
}

export interface LocalState {
  version: 1;
  sessionSecret: string;
  vaultKey: string;
  claimSecret: string;
  port: number;
  github?: GitHubOAuthApp;
  shared?: SharedConfig;
  owner?: string;
  sharedOnce?: true;
}

const secret = () => randomBytes(32).toString('base64url');

export function validGitHubApp(value: unknown): value is GitHubOAuthApp {
  if (!value || typeof value !== 'object') return false;
  const app = value as Record<string, unknown>;
  return typeof app.clientId === 'string' && CLIENT_ID.test(app.clientId) && typeof app.clientSecret === 'string' && CLIENT_SECRET.test(app.clientSecret);
}

export function validPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1024 && value <= 65535;
}

const OWNER_ID = /^github:[1-9][0-9]{0,19}$/;
const ADMIN_ID = /^(?:github:[1-9][0-9]{0,19}|password:[a-z0-9][a-z0-9_-]{2,38})$/;
const SIGNUPS: readonly SharedConfig['signup'][] = ['open', 'invite', 'off'];

export function sharedOrigin(input: string): { ok: true; origin: string } | { ok: false; error: string } {
  let url: URL;
  try { url = new URL(input.trim()); } catch { return { ok: false, error: 'Enter the public address people open, such as https://pikibun.example.com.' }; }
  if (url.protocol !== 'https:') return { ok: false, error: 'Shared, Pikibun needs a public HTTPS address: put a TLS proxy or tunnel (Caddy, Tailscale Serve, Cloudflare Tunnel) in front of it.' };
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return { ok: false, error: 'Enter only the origin, without a path, such as https://pikibun.example.com.' };
  return { ok: true, origin: url.origin };
}

export function sharedConfigError(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'The sharing settings are missing.';
  const config = value as Record<string, unknown>;
  const allowed = ['origin', 'listen', 'trustProxy', 'signup', 'passwordAuth', 'admins', 'github'];
  if (Object.keys(config).some(key => !allowed.includes(key))) return 'The sharing settings have unknown fields.';
  if (typeof config.origin !== 'string') return 'Enter the public HTTPS address people open.';
  const origin = sharedOrigin(config.origin);
  if (!origin.ok) return origin.error;
  if (origin.origin !== config.origin) return 'Enter only the origin, without a path, such as https://pikibun.example.com.';
  if (config.listen !== 'loopback' && config.listen !== 'all') return 'Choose where Pikibun listens: this computer only, or every network interface.';
  if (typeof config.trustProxy !== 'boolean' || typeof config.passwordAuth !== 'boolean') return 'The sharing settings are damaged.';
  if (!SIGNUPS.includes(config.signup as SharedConfig['signup'])) return 'Choose who may create an account: anyone, invite links only, or nobody new.';
  if (!Array.isArray(config.admins) || config.admins.length < 1 || config.admins.length > 20) return 'Name at least one administrator (at most 20).';
  if (config.admins.some(item => typeof item !== 'string' || !ADMIN_ID.test(item))) return 'Administrators are user IDs such as github:12345 or password:alice.';
  if (new Set(config.admins).size !== config.admins.length) return 'An administrator is listed twice.';
  if (config.github !== undefined && !validGitHubApp(config.github)) return 'That is not a GitHub OAuth app client ID and secret.';
  if (config.github === undefined && config.passwordAuth !== true) return 'Shared, people need a way to sign in: add a GitHub OAuth app for the public address, or turn on usernames and passwords.';
  if (config.passwordAuth !== true && (config.admins as string[]).some(item => item.startsWith('password:'))) return 'Password administrators need usernames and passwords turned on.';
  return undefined;
}

function copyShared(config: SharedConfig): SharedConfig {
  return { origin: config.origin, listen: config.listen, trustProxy: config.trustProxy, signup: config.signup, passwordAuth: config.passwordAuth,
    admins: [...config.admins], ...(config.github ? { github: { clientId: config.github.clientId, clientSecret: config.github.clientSecret } } : {}) };
}

function parseState(value: unknown): LocalState {
  const state = value as Partial<LocalState> | null;
  if (!state || typeof state !== 'object' || state.version !== 1 || ![state.sessionSecret, state.vaultKey, state.claimSecret].every(item => typeof item === 'string' && SECRET.test(item))
    || !validPort(state.port) || (state.github !== undefined && !validGitHubApp(state.github)) || (state.shared !== undefined && sharedConfigError(state.shared) !== undefined)
    || (state.owner !== undefined && (typeof state.owner !== 'string' || !OWNER_ID.test(state.owner))) || (state.sharedOnce !== undefined && state.sharedOnce !== true)) {
    throw new LocalStateError('The local server state is damaged or from another version.');
  }
  return { version: 1, sessionSecret: state.sessionSecret!, vaultKey: state.vaultKey!, claimSecret: state.claimSecret!, port: state.port!,
    ...(state.github ? { github: { clientId: state.github.clientId, clientSecret: state.github.clientSecret } } : {}),
    ...(state.shared ? { shared: copyShared(state.shared) } : {}), ...(state.owner ? { owner: state.owner } : {}),
    ...(state.sharedOnce ? { sharedOnce: true as const } : {}) };
}

export async function privateStateDirectory(directory: string): Promise<string> {
  const path = resolve(directory);
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700
    || (process.getuid && stat.uid !== process.getuid()) || await realpath(path) !== path) {
    throw new LocalStateError(`${path} must be a directory of yours, not a symlink, that only you can open (mode 0700).`);
  }
  return path;
}

async function readState(directory: string): Promise<LocalState | undefined> {
  let file;
  try { file = await open(join(directory, STATE_FILE), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new LocalStateError('The local server state could not be opened safely.');
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > 16384 || (process.getuid && stat.uid !== process.getuid())) {
      throw new LocalStateError('The local server state must be a file of yours that only you can read (mode 0600).');
    }
    let value: unknown;
    try { value = JSON.parse(await file.readFile('utf8')); } catch { throw new LocalStateError('The local server state is damaged.'); }
    return parseState(value);
  } finally { await file.close(); }
}

async function writeState(directory: string, state: LocalState): Promise<void> {
  const temporary = join(directory, `.server-${randomUUID()}.tmp`);
  const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(`${JSON.stringify(state, null, 2)}\n`);
    await file.sync();
  } finally { await file.close(); }
  try { await rename(temporary, join(directory, STATE_FILE)); } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

async function lease(directory: string): Promise<() => Promise<void>> {
  try { return await acquireRunnerLease(directory, () => {}); }
  catch (error) {
    if (error instanceof RunnerLeaseBusyError) throw new LocalStateError('Pikibun is already running with this state directory, for example `pikibun serve` in a terminal or the Pikibun app. Stop it there first.');
    throw new LocalStateError('The local server state could not be locked: this needs flock (Linux, util-linux) or lockf (macOS).');
  }
}

export interface LocalStateChanges {
  github?: GitHubOAuthApp;
  port?: number;
  shared?: SharedConfig;
}

function changed(state: LocalState | undefined, changes: LocalStateChanges): LocalState {
  if (changes.github !== undefined && !validGitHubApp(changes.github)) throw new LocalStateError('That is not a GitHub OAuth app client ID and secret.');
  if (changes.port !== undefined && !validPort(changes.port)) throw new LocalStateError('The port must be a number from 1024 to 65535.');
  const base: LocalState = state ?? { version: 1, sessionSecret: secret(), vaultKey: secret(), claimSecret: secret(), port: DEFAULT_LOCAL_PORT };
  let shared = base.shared;
  if (changes.shared) {
    const github = changes.shared.github ?? base.shared?.github;
    const candidate: Record<string, unknown> = { ...changes.shared };
    delete candidate.github;
    if (github) candidate.github = github;
    const error = sharedConfigError(candidate);
    if (error) throw new LocalStateError(error);
    shared = copyShared(candidate as unknown as SharedConfig);
  }
  return { ...base, ...(changes.github ? { github: { ...changes.github } } : {}), ...(changes.port ? { port: changes.port } : {}), ...(shared ? { shared } : {}) };
}

export async function peekLocalState(directory: string): Promise<LocalState | undefined> {
  return readState(await privateStateDirectory(directory));
}

export async function openLocalState(directory: string, changes: LocalStateChanges = {}): Promise<{ state: LocalState; release(): Promise<void> }> {
  const path = await privateStateDirectory(directory);
  const release = await lease(path);
  try {
    const saved = await readState(path);
    const state = changed(saved, changes);
    if (!saved || JSON.stringify(state) !== JSON.stringify(saved)) await writeState(path, state);
    return { state, release };
  } catch (error) {
    await release();
    throw error;
  }
}

export async function recordLocalOwnership(directory: string, state: LocalState, changes: { owner?: string; sharedOnce?: true }): Promise<LocalState> {
  if (changes.owner !== undefined && !OWNER_ID.test(changes.owner)) throw new LocalStateError('The owner must be a GitHub user ID such as github:12345.');
  const next: LocalState = { ...state, ...(changes.owner ? { owner: changes.owner } : {}), ...(changes.sharedOnce ? { sharedOnce: true as const } : {}) };
  await writeState(await privateStateDirectory(directory), next);
  return next;
}

export async function loadLocalState(directory: string, changes: LocalStateChanges = {}): Promise<LocalState> {
  const { state, release } = await openLocalState(directory, changes);
  await release();
  return state;
}
