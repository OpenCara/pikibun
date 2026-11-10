import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { instanceAdmins, localOwner } from '../authority/index.js';
import { loadConfig } from '../config.js';
import { InstanceLockedError } from '../db/index.js';
import { PasswordCommandError, runPasswordCommand } from '../password-accounts-cli.js';
import { startServer } from '../serve.js';
import { webBuild } from '../static.js';
import type { Env } from '../types.js';
import { recordLocalOwnership, type LocalState } from './state.js';

export const LOCAL_ORIGIN_HOST = '127.0.0.1';
export const githubCallbackPath = '/api/auth/github/callback';

export function defaultStaticDir(): string | undefined {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth++) {
    for (const candidate of [join(directory, 'web'), join(directory, 'dist', 'client')]) {
      if (webBuild(candidate) === 'nsh') return candidate;
    }
    directory = dirname(directory);
  }
  return undefined;
}

export interface LocalServerOptions {
  stateDir: string;
  state: LocalState;
  staticDir?: string;
  extraEnv?: Record<string, string>;
  release?: () => Promise<void>;
  mode?: LocalServerMode;
}

export type LocalServerMode = 'local' | 'shared';

export interface LocalServer {
  readonly mode: LocalServerMode;
  readonly origin: string;
  readonly address: string;
  readonly env: Env;
  owner(): Promise<{ id: string } | null>;
  claimUrl(): Promise<string | null>;
  createAdmin(username: string, password: string): Promise<string>;
  close(): Promise<void>;
}

export class LocalServerError extends Error {}

export async function startLocalServer(options: LocalServerOptions): Promise<LocalServer> {
  try { return await start(options); }
  catch (error) { await options.release?.(); throw error; }
}

async function start(options: LocalServerOptions): Promise<LocalServer> {
  let { state } = options;
  const stateDir = resolve(options.stateDir);
  const staticDir = options.staticDir ?? defaultStaticDir();
  if (!staticDir) throw new LocalServerError('The Pikibun web app is missing from this installation. Reinstall it, or run `pnpm build` in a source checkout.');
  const backups = join(stateDir, 'backups');
  await mkdir(backups, { recursive: true, mode: 0o700 });
  const mode = options.mode ?? 'local';
  const shared = mode === 'shared' ? state.shared : undefined;
  if (mode === 'shared' && !shared) throw new LocalServerError('Set up sharing first: its public HTTPS address, sign-in and administrators.');
  const listenHost = shared?.listen === 'all' ? '0.0.0.0' : LOCAL_ORIGIN_HOST;
  const origin = shared ? shared.origin : `http://${LOCAL_ORIGIN_HOST}:${state.port}`;
  const common: Record<string, string> = {
    APP_ORIGIN: origin, HOST: listenHost, PORT: String(state.port),
    DATABASE_URL: `sqlite://${join(stateDir, 'pikibun.sqlite')}`, STORAGE_URL: pathToFileURL(backups).href, STATIC_DIR: staticDir,
    SESSION_SECRET: state.sessionSecret, VAULT_KEY: state.vaultKey,
  };
  if (shared && !state.sharedOnce) {
    const first = await withData(state, stateDir, staticDir, firstGitHubUser);
    state = await recordLocalOwnership(stateDir, state, { ...(first && !state.owner ? { owner: first } : {}), sharedOnce: true });
  }
  const owner = shared ? undefined : await pinnedOwner(state, stateDir, staticDir);
  const settings: Record<string, string> = shared ? {
    ...common, TRUST_PROXY: String(shared.trustProxy), LOCAL_MODE: 'false', SIGNUP: shared.signup, PASSWORD_AUTH: String(shared.passwordAuth),
    ADMIN_USER_IDS: shared.admins.join(','),
    ...(shared.github ? { GITHUB_CLIENT_ID: shared.github.clientId, GITHUB_CLIENT_SECRET: shared.github.clientSecret } : {}),
    ...options.extraEnv,
  } : {
    ...common, TRUST_PROXY: 'false', LOCAL_MODE: 'true', LOCAL_CLAIM_SECRET: state.claimSecret, ...(owner ? { LOCAL_OWNER_ID: owner } : {}),
    ...(state.github ? { GITHUB_CLIENT_ID: state.github.clientId, GITHUB_CLIENT_SECRET: state.github.clientSecret } : {}),
    ...options.extraEnv,
  };
  const config = await loadConfig(settings);
  let server;
  try { server = await startServer(config); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE' || error instanceof InstanceLockedError) {
      throw new LocalServerError(`Port ${state.port} is in use: another Pikibun may already be running here. Stop it, or choose another port with --port.`);
    }
    throw error;
  }
  const { env } = config;
  const admins = [...instanceAdmins(env)];
  return {
    mode, origin, env, address: `http://${listenHost}:${state.port}`,
    async owner() {
      if (!shared) return localOwner(env);
      if (!admins.length) return null;
      const rows = await env.DB.query<{ id: string }>(`SELECT id FROM users WHERE id IN (${admins.map(() => '?').join(',')})`).bind(...admins).all();
      const existing = new Set(rows.map(row => row.id));
      const first = admins.find(id => existing.has(id));
      return first ? { id: first } : null;
    },
    async claimUrl() {
      if (shared) return null;
      return await localOwner(env) ? null : `${origin}/api/auth/local/claim?token=${state.claimSecret}`;
    },
    async createAdmin(username, password) {
      if (!shared) throw new LocalServerError('Administrator accounts are for a shared Pikibun: for yourself alone, you sign in with GitHub.');
      try {
        await runPasswordCommand(env.DB, settings, { kind: 'create-admin', username }, async () => password);
        return `Created the administrator password:${username.toLowerCase()}: sign in at ${origin} with the username ${username.toLowerCase()}.`;
      }
      catch (error) {
        if (error instanceof PasswordCommandError) throw new LocalServerError(error.message.replace(/^./, first => first.toUpperCase()).replace(/ADMIN_USER_IDS/g, 'the administrators').replace(/--reset-password \S+/, 'reset its password'));
        throw error;
      }
    },
    async close() {
      try { await server.close(); } finally { await options.release?.(); }
    },
  };
}

async function firstGitHubUser(env: Env): Promise<string | undefined> {
  return (await env.DB.query<{ id: string }>(`SELECT id FROM users WHERE auth_kind = 'github' AND github_id IS NOT NULL ORDER BY created_at, id LIMIT 1`).first())?.id;
}

async function pinnedOwner(state: LocalState, stateDir: string, staticDir: string): Promise<string | undefined> {
  if (state.owner) return state.owner;
  if (!state.shared && !state.sharedOnce) return undefined;
  const admins = (state.shared?.admins ?? []).filter(id => id.startsWith('github:'));
  const owner = await withData(state, stateDir, staticDir, async env => {
    const rows = admins.length ? await env.DB.query<{ id: string }>(`SELECT id FROM users WHERE auth_kind = 'github' AND id IN (${admins.map(() => '?').join(',')})`).bind(...admins).all() : [];
    const admin = admins.find(id => rows.some(row => row.id === id));
    if (admin) return admin;
    if (!await firstGitHubUser(env)) return undefined;
    throw new LocalServerError('This Pikibun has served others: share it again and sign in as one of its GitHub administrators first, so it knows whose it is when it runs for you alone.');
  });
  if (owner) await recordLocalOwnership(stateDir, state, { owner });
  return owner;
}

async function withData<T>(state: LocalState, stateDir: string, staticDir: string, read: (env: Env) => Promise<T>): Promise<T> {
  const config = await loadConfig({ APP_ORIGIN: `http://${LOCAL_ORIGIN_HOST}:${state.port}`, SESSION_SECRET: state.sessionSecret, VAULT_KEY: state.vaultKey,
    DATABASE_URL: `sqlite://${join(stateDir, 'pikibun.sqlite')}`, STATIC_DIR: staticDir });
  try {
    await config.env.DB.migrate();
    return await read(config.env);
  } finally {
    await config.env.CONNECTOR_HUB?.close?.();
    await config.env.DB.close?.();
  }
}

export function githubOAuthAppInstructions(): string {
  return `Pikibun signs you in with GitHub through an OAuth app of your own. Register one once at
  https://github.com/settings/applications/new
with
  Application name:            Pikibun on my computer (any name)
  Homepage URL:                http://${LOCAL_ORIGIN_HOST}
  Authorization callback URL:  http://${LOCAL_ORIGIN_HOST}${githubCallbackPath}
(GitHub accepts that callback on any port of ${LOCAL_ORIGIN_HOST}.) Then generate a client secret and give Pikibun the
client ID and secret.
`;
}
