import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { adminUserId } from './authority/index.js';
import { ConnectorHubRegistry } from './connector-hub.js';
import { openDatabase } from './db/index.js';
import { LOCAL_OWNER_ID, PASSWORD_USERNAME } from './http.js';
import { openStorage } from './storage/index.js';
import type { Env } from './types.js';
import { webBuild } from './static.js';

export interface ServerConfig {
  env: Env;
  host: string;
  port: number;
  trustProxy: boolean;
  staticDir: string;
  preview?: { origin: string; staticDir: string };
  databaseUrl: string;
  storageUrl: string | null;
}

export class ConfigurationError extends Error {}

function flag(processEnv: NodeJS.ProcessEnv, name: string): boolean {
  const value = processEnv[name] || 'false';
  if (value !== 'true' && value !== 'false') throw new ConfigurationError(`${name} must be "true" or "false".`);
  return value === 'true';
}

export const defaultDatabaseUrl = 'sqlite:///data/pikibun.sqlite';
const stringVars = [
  'APP_ORIGIN', 'RUNNER_URL', 'RUNNER_EVENT_TRANSPORT', 'RUNNER_SHARED_SECRET', 'SESSION_SECRET', 'VAULT_KEY',
  'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'TEST_AUTH_ENABLED', 'TEST_AUTH_SECRET', 'TEST_AUTH_EXPIRES_AT',
  'GITHUB_APP_ID', 'GITHUB_APP_SLUG', 'GITHUB_APP_PRIVATE_KEY', 'OIDC_SIGNING_KEY', 'ADMIN_USER_IDS', 'GIT_DIRECT', 'SANDBOX_GITHUB_API',
  'LOCAL_MODE', 'LOCAL_CLAIM_SECRET', 'LOCAL_OWNER_ID', 'LOCAL_OWNER_NAME', 'PASSWORD_AUTH', 'SIGNUP',
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'NOTION_CLIENT_ID', 'NOTION_CLIENT_SECRET', 'DROPBOX_CLIENT_ID', 'DROPBOX_CLIENT_SECRET',
  'MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_TENANT', 'TENCENT_DOCS_CLIENT_ID', 'TENCENT_DOCS_CLIENT_SECRET',
  'WEB_PUSH_CONTACT', 'PIKIBUN_VERSION',
] as const;
const LOOPBACK = ['127.0.0.1', '::1', 'localhost'];
const CLIENT_BUILD = 'dist/client';
const CLIENT_BUILD_BEFORE_RENAME = 'dist/preview';

function clientBuildDirectory(configured: string | undefined): string {
  const directory = resolve(configured || CLIENT_BUILD);
  const namesMovedBuild = directory === resolve(CLIENT_BUILD_BEFORE_RENAME) && (!existsSync(directory) || existsSync(resolve(CLIENT_BUILD)));
  return namesMovedBuild ? resolve(CLIENT_BUILD) : directory;
}

export async function loadConfig(processEnv: NodeJS.ProcessEnv = process.env): Promise<ServerConfig> {
  const env = { APP_ORIGIN: '' } as Env;
  for (const name of stringVars) {
    const value = processEnv[name];
    if (value !== undefined && value !== '') env[name] = value;
  }
  if (!env.APP_ORIGIN) throw new ConfigurationError('APP_ORIGIN is required (the public https origin of this server).');
  try {
    const origin = new URL(env.APP_ORIGIN);
    if (origin.origin !== env.APP_ORIGIN) throw new Error();
  } catch {
    throw new ConfigurationError('APP_ORIGIN must be an origin such as https://pikibun.example.com (no path, credentials or trailing slash).');
  }
  if (!env.SESSION_SECRET) throw new ConfigurationError('SESSION_SECRET is required: set it to a random string of at least 32 characters.');
  if (env.SESSION_SECRET.length < 32) throw new ConfigurationError('SESSION_SECRET must be at least 32 characters long.');
  if (!env.VAULT_KEY) throw new ConfigurationError('VAULT_KEY is required: set it to a base64url-encoded random 32-byte key.');
  if (!/^(?:[A-Za-z0-9+/]{43}=?|[A-Za-z0-9_-]{43}=?)$/.test(env.VAULT_KEY)) throw new ConfigurationError('VAULT_KEY must be a base64url-encoded 32-byte key.');
  if (env.ADMIN_USER_IDS && env.ADMIN_USER_IDS.split(',').some(item => !adminUserId(env, item.trim()))) {
    throw new ConfigurationError('ADMIN_USER_IDS must list user IDs such as github:12345 or password:alice, separated by commas.');
  }
  if (env.PASSWORD_AUTH !== undefined) {
    if (!['true', 'false'].includes(env.PASSWORD_AUTH)) throw new ConfigurationError('PASSWORD_AUTH must be "true" or "false".');
    if (env.PASSWORD_AUTH === 'true' && env.LOCAL_MODE === 'true') throw new ConfigurationError('PASSWORD_AUTH is for shared servers: a LOCAL_MODE server admits only its owner, who signs in with its LOCAL_CLAIM_SECRET.');
  }
  if (env.SIGNUP !== undefined && !['open', 'invite', 'off'].includes(env.SIGNUP)) {
    throw new ConfigurationError('SIGNUP must be "open", "invite" or "off" (unset: GitHub sign-ups are open and password sign-ups need an invite).');
  }
  const listenHost = processEnv.HOST || (env.LOCAL_MODE === 'true' ? '127.0.0.1' : '0.0.0.0');
  if (env.LOCAL_MODE !== undefined) {
    if (!['true', 'false'].includes(env.LOCAL_MODE)) throw new ConfigurationError('LOCAL_MODE must be "true" or "false".');
    if (env.LOCAL_MODE === 'true') {
      if (!env.LOCAL_CLAIM_SECRET || !/^[A-Za-z0-9_-]{43}$/.test(env.LOCAL_CLAIM_SECRET)) throw new ConfigurationError('LOCAL_MODE needs LOCAL_CLAIM_SECRET, a base64url-encoded random 32-byte value.');
      if (!LOOPBACK.includes(new URL(env.APP_ORIGIN).hostname.replace(/^\[|\]$/g, ''))) throw new ConfigurationError('LOCAL_MODE needs APP_ORIGIN on this machine, such as http://127.0.0.1:8787.');
      if (!LOOPBACK.includes(listenHost)) throw new ConfigurationError('LOCAL_MODE listens on loopback only: leave HOST unset or set it to 127.0.0.1.');
      if (env.LOCAL_OWNER_ID !== undefined && !LOCAL_OWNER_ID.test(env.LOCAL_OWNER_ID)) throw new ConfigurationError('LOCAL_OWNER_ID must be a user ID such as github:12345 or password:alice.');
      if (env.LOCAL_OWNER_NAME !== undefined && !PASSWORD_USERNAME.test(env.LOCAL_OWNER_NAME)) throw new ConfigurationError('LOCAL_OWNER_NAME must be a username: 3 to 39 lowercase letters, digits, - and _.');
    }
  }
  const staticDir = clientBuildDirectory(processEnv.STATIC_DIR);
  if (processEnv.STATIC_CLIENT && processEnv.STATIC_CLIENT !== 'nsh') {
    throw new ConfigurationError('STATIC_CLIENT: the React web client was removed. Remove STATIC_CLIENT, and STATIC_DIR if it names dist/web, to serve the Native Shell client.');
  }
  if (webBuild(staticDir) === 'other') {
    throw new ConfigurationError(`STATIC_DIR (${staticDir}) holds a web page that isn't the Native Shell client, such as the removed React client's. Point STATIC_DIR at the NSH build (pnpm build writes it to dist/client), or leave it unset.`);
  }
  let preview: ServerConfig['preview'];
  if (processEnv.PREVIEW_ORIGIN) {
    const previewDir = clientBuildDirectory(processEnv.PREVIEW_STATIC_DIR);
    try {
      const origin = new URL(processEnv.PREVIEW_ORIGIN);
      if (origin.origin !== processEnv.PREVIEW_ORIGIN || origin.protocol !== 'https:' || origin.origin === env.APP_ORIGIN || env.LOCAL_MODE === 'true') throw new Error();
      preview = { origin: origin.origin, staticDir: previewDir };
    } catch {
      throw new ConfigurationError('PREVIEW_ORIGIN must be a distinct https origin (no path or trailing slash), on a shared server.');
    }
    if (webBuild(previewDir) === 'other') {
      throw new ConfigurationError(`PREVIEW_STATIC_DIR (${previewDir}) holds a web page that isn't the Native Shell client. Point it at the NSH build (dist/client).`);
    }
  } else if (processEnv.PREVIEW_STATIC_DIR) {
    throw new ConfigurationError('PREVIEW_STATIC_DIR requires PREVIEW_ORIGIN.');
  }
  const port = Number(processEnv.PORT ?? '8787');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigurationError('PORT must be a TCP port number.');
  const trustProxyValue = processEnv.TRUST_PROXY ?? 'false';
  if (!['true', 'false'].includes(trustProxyValue)) throw new ConfigurationError('TRUST_PROXY must be "true" or "false".');
  const workspaceDatabases = flag(processEnv, 'WORKSPACE_DATABASES');
  const workspaceDatabasePrivateHosts = flag(processEnv, 'WORKSPACE_DATABASE_PRIVATE_HOSTS');
  const databaseUrl = processEnv.DATABASE_URL || defaultDatabaseUrl;
  const storageUrl = processEnv.STORAGE_URL || null;
  if (storageUrl) env.BUCKET = openStorage(storageUrl, processEnv);
  env.DB = await openDatabase(databaseUrl);
  if (workspaceDatabases) {
    const { PostgresWorkspaceDatabases } = await import('./workspace-databases/postgres.js');
    env.WORKSPACE_DATABASES = new PostgresWorkspaceDatabases({ privateHosts: workspaceDatabasePrivateHosts });
  }
  env.CONNECTOR_HUB = new ConnectorHubRegistry(env);
  return {
    env, port, databaseUrl, storageUrl,
    host: listenHost,
    trustProxy: trustProxyValue === 'true',
    staticDir,
    ...(preview ? { preview } : {}),
  };
}
