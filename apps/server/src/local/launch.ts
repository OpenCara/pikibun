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

// A Pikibun server on its owner's computer: SQLite and backups in its state directory. For one person (the default) it
// listens on 127.0.0.1 only and admits only the GitHub account that claims it with the sign-in link it prints (auth.ts).
// Shared (state.shared), it is a full multi-user server at a public HTTPS origin behind its owner's TLS proxy or tunnel,
// with the sign-ins, sign-up policy and administrators they chose, from the same data.

export const LOCAL_ORIGIN_HOST = '127.0.0.1';
export const githubCallbackPath = '/api/auth/github/callback';

/**
 * The client built for the web: `web/` beside the bundle (the published CLI stages the NSH build there), else the
 * repository's `dist/client` (`pnpm build`) when running from source: the first that holds Native Shell's web build.
 */
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
  /** The built web app; defaultStaticDir() when omitted. */
  staticDir?: string;
  /** Tests and development only: settings added to the server's (test mode, say). */
  extraEnv?: Record<string, string>;
  /** Releases the state's lease (state.ts openLocalState): called once the server has closed, or failed to start. */
  release?: () => Promise<void>;
  /** `shared` serves others at state.shared's public origin; `local` (the default) its owner alone. */
  mode?: LocalServerMode;
}

export type LocalServerMode = 'local' | 'shared';

export interface LocalServer {
  readonly mode: LocalServerMode;
  /** What people open: http://127.0.0.1:PORT, or the shared server's public origin. */
  readonly origin: string;
  /** Where it listens, for the proxy or tunnel in front of a shared server: http://127.0.0.1:PORT or http://0.0.0.0:PORT. */
  readonly address: string;
  readonly env: Env;
  /**
   * Whose host this computer becomes: the GitHub account that claimed it, or shared, the first administrator in the
   * order listed who has an account. Null while there is none.
   */
  owner(): Promise<{ id: string } | null>;
  /** The owner's sign-in link while the server is unclaimed: whoever opens it first becomes its owner. Null once claimed, and always when shared. */
  claimUrl(): Promise<string | null>;
  /** Shared with password sign-in only: creates the listed administrator `password:<username>`, as `--create-admin` does. */
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
  // Absolute, so the database and storage URLs below name it whatever the working directory.
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
  // Shared for the first time: before it serves anyone, whoever claimed it for themselves (its first GitHub user) is
  // pinned as its owner, for when it runs for them alone again; claimed by nobody yet, nobody is pinned. Later shared
  // starts change nothing: by then its first GitHub user may be a teammate.
  if (shared && !state.sharedOnce) {
    const first = await withData(state, stateDir, staticDir, firstGitHubUser);
    state = await recordLocalOwnership(stateDir, state, { ...(first && !state.owner ? { owner: first } : {}), sharedOnce: true });
  }
  // Once its data has served others, running for its owner alone admits only the owner pinned then (see pinnedOwner).
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

/**
 * The owner to admit alone where the data has served others: the one pinned when it was first shared, else (shared
 * before anyone claimed it) the first of its GitHub administrators with an account, pinned now. Never shared, nothing is
 * pinned: its first GitHub user is its owner, as ever.
 */
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

/** Reads the data before anything serves it, with the server's own migrations applied. */
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

/** What to register at https://github.com/settings/applications/new for a local server on any port. */
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
