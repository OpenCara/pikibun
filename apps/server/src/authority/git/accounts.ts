import type { Hono } from 'hono';
import type { GitAccount, GitProvider, ProviderRepository, ProviderRepositoryList, TokenGitProvider } from '../../../../../packages/shared/src/repositories.js';
import { gitProviderHosts, gitProviderNames, gitProviders, plainRepositoryPath, repositoryLimits, validGitHost, validRepositoryId, validRepositoryName } from '../../../../../packages/shared/src/repositories.js';
import type { Env, GitCredentialRow, AppEnv } from '../../types.js';
import { auditAfterChange, auditStatement } from '../audit.js';
import { revokeGitHubToken } from '../auth.js';
import { getUser } from '../../db.js';
import { ConstraintError } from '../../db/types.js';
import { fail, id, identifier, jsonObject, localMode, now, testMode } from '../../http.js';
import { decryptToken, encryptToken } from '../vault.js';
import { githubRepositories, validRepositoryRef } from '../repositories.js';
import { gitProviderAdapters, plainRepositoryId } from './providers.js';
import type { GitCredential } from './types.js';

export interface LoadedCredential {
  credential: GitCredential;
  ciphertext: string;
  userId: string;
  workspaceId?: string;
}

const accountLimit = 20;
const organizationPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,48}[A-Za-z0-9])?$/;

export function tokenProvider(value: unknown): value is TokenGitProvider {
  return typeof value === 'string' && value !== 'github' && (gitProviders as readonly string[]).includes(value);
}

export function validProviderHost(provider: GitProvider, host: unknown): host is string {
  const fixed = gitProviderHosts[provider].fixed;
  if (fixed) return host === fixed;
  return validGitHost(host) && host !== 'github.com' && !host.endsWith('.github.com');
}

export function gitHost(provider: GitProvider, value: unknown): string {
  const name = gitProviderNames[provider];
  const hosts = gitProviderHosts[provider];
  if (value === undefined || value === null || value === '') {
    const fallback = hosts.fixed ?? hosts.default;
    if (!fallback) fail(400, 'invalid_git_host', `${name} requires the server host name.`);
    return fallback;
  }
  if (typeof value !== 'string' || value.length > 300) fail(400, 'invalid_git_host', `Use the ${name} server host name.`);
  const host = value.trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/+$/, '');
  if (hosts.fixed && host !== hosts.fixed) fail(400, 'invalid_git_host', `${name} always uses ${hosts.fixed}.`);
  if (!validProviderHost(provider, host)) fail(400, 'invalid_git_host', `Use a public HTTPS host name for ${name}, such as git.example.com.`);
  return host;
}

export function credentialOrganization(provider: GitProvider, fullName: string): string {
  return provider === 'azure-devops' ? fullName.split('/')[0]!.toLowerCase() : '';
}

export function gitAccountRequired(provider: GitProvider, host: string, fullName: string): never {
  return fail(409, 'git_account_required', `Connect ${gitProviderNames[provider]} (${host}) in Settings → Profile to use ${fullName}.`);
}

async function loaded(env: Env, row: GitCredentialRow): Promise<LoadedCredential> {
  const token = await decryptToken(env, row.user_id, row.ciphertext);
  return { ciphertext: row.ciphertext, userId: row.user_id, credential: {
    id: row.id, provider: row.provider, host: row.host, organization: row.organization, username: row.username, token,
  } };
}

export async function loadCredential(env: Env, userId: string, provider: TokenGitProvider, host: string, organization: string): Promise<LoadedCredential | null> {
  const row = await env.DB.query<GitCredentialRow>('SELECT * FROM git_credentials WHERE user_id = ? AND provider = ? AND host = ? AND organization = ?')
    .bind(userId, provider, host, organization).first();
  return row ? loaded(env, row) : null;
}

export async function recheckCredential(env: Env, access: LoadedCredential): Promise<void> {
  if (access.workspaceId !== undefined) {
    const current = await env.DB.query<{ ciphertext: string }>('SELECT ciphertext FROM workspace_connections WHERE id = ? AND workspace_id = ?')
      .bind(access.credential.id, access.workspaceId).first();
    if (current?.ciphertext !== access.ciphertext) fail(403, 'workspace_connection_changed', 'The workspace connection changed; retry with the current one.');
    return;
  }
  const row = await env.DB.query<{ ciphertext: string }>('SELECT ciphertext FROM git_credentials WHERE id = ? AND user_id = ?')
    .bind(access.credential.id, access.userId).first();
  if (row?.ciphertext !== access.ciphertext) fail(403, 'git_access_changed', 'Git account access changed; retry with the current connection.');
}

export function providerRepository(provider: GitProvider, value: unknown): ProviderRepository {
  const item = value as Partial<ProviderRepository> | null;
  if (!item || typeof item !== 'object' || !validRepositoryId(item.id) || !validRepositoryName(provider, item.fullName) ||
      !validRepositoryRef(item.defaultBranch) || typeof item.private !== 'boolean') {
    fail(502, 'invalid_git_response', `${gitProviderNames[provider]} returned invalid repository metadata.`);
  }
  return { id: item.id, fullName: item.fullName, defaultBranch: item.defaultBranch, private: item.private };
}

function publicAccount(row: Pick<GitCredentialRow, 'id' | 'provider' | 'host' | 'organization' | 'login' | 'created_at'>): GitAccount {
  return { id: row.id, provider: row.provider, host: row.host, organization: row.organization, login: row.login, createdAt: row.created_at };
}

export function accountInput(input: Record<string, unknown>) {
  if (Object.keys(input).some(key => !['provider', 'host', 'organization', 'username', 'token'].includes(key))) {
    fail(400, 'invalid_git_account', 'Only provider, host, organization, username and token are accepted.');
  }
  if (!tokenProvider(input.provider)) fail(400, 'invalid_git_provider', 'Choose a supported Git provider; GitHub.com uses the sign-in connection.');
  const provider = input.provider;
  const name = gitProviderNames[provider];
  const host = gitHost(provider, input.host);
  let organization = '';
  if (provider === 'azure-devops') {
    if (typeof input.organization !== 'string' || !organizationPattern.test(input.organization.trim())) {
      fail(400, 'invalid_git_organization', 'Azure DevOps requires the organization name from dev.azure.com/<organization>.');
    }
    organization = input.organization.trim().toLowerCase();
  } else if (input.organization !== undefined && input.organization !== '') {
    fail(400, 'invalid_git_organization', `${name} accounts do not take an organization.`);
  }
  let username: string | null = null;
  const takesUsername = provider === 'bitbucket' || provider === 'git';
  if (provider === 'git' && (typeof input.username !== 'string' || !input.username.trim())) {
    fail(400, 'invalid_git_username', 'Enter the user name for this Git server.');
  }
  if (takesUsername && input.username !== undefined && input.username !== '') {
    if (typeof input.username !== 'string' || !/^[^\s:\x00-\x1f\x7f]{1,254}$/.test(input.username.trim())) {
      fail(400, 'invalid_git_username', provider === 'git' ? 'Use the user name you sign in to the Git server with, without colons or spaces.'
        : 'Use your Atlassian account email or username.');
    }
    username = input.username.trim();
  } else if (!takesUsername && input.username !== undefined && input.username !== '') {
    fail(400, 'invalid_git_username', `${name} accounts do not take a username.`);
  }
  const token = typeof input.token === 'string' ? input.token.trim() : '';
  if (!/^[\x21-\x7e]{1,4096}$/.test(token)) {
    fail(400, 'invalid_git_token', provider === 'git' ? 'Paste the password or access token for this Git server.' : `Paste a ${name} personal access token.`);
  }
  return { provider, host, organization, username, token };
}

async function githubTokenOwner(token: string): Promise<{ id: string; login: string }> {
  let response: Response;
  try {
    response = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'pikibun' },
      redirect: 'manual', signal: AbortSignal.timeout(15_000),
    });
  } catch {
    fail(502, 'git_provider_unavailable', 'GitHub could not be reached to check the token. Try again.');
  }
  if (response.status === 401) {
    await response.body?.cancel().catch(() => {});
    fail(400, 'invalid_git_token', 'GitHub didn\'t accept this token. Paste a personal access token that hasn\'t expired or been revoked.');
  }
  let identity: unknown = null;
  if (response.ok) {
    try { identity = await response.json(); } catch { }
  } else {
    await response.body?.cancel().catch(() => {});
  }
  const { id: githubId, login } = (identity && typeof identity === 'object' ? identity : {}) as { id?: unknown; login?: unknown };
  if (typeof githubId !== 'number' || !Number.isSafeInteger(githubId) || githubId <= 0 || typeof login !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(login)) {
    fail(502, 'invalid_git_response', 'GitHub could not check the token. Try again.');
  }
  return { id: String(githubId), login };
}

export function registerGitAccounts(app: Hono<AppEnv>): void {
  app.get('/api/git/accounts', async c => {
    const userId = c.get('auth').userId;
    const user = await getUser(c.env, userId);
    if (!user) fail(404, 'not_found', 'User not found.');
    const rows = await c.env.DB.query<Pick<GitCredentialRow, 'id' | 'provider' | 'host' | 'organization' | 'login' | 'created_at'>>(`SELECT id, provider, host, organization, login, created_at FROM git_credentials
      WHERE user_id = ? ORDER BY provider, host, organization, id`).bind(userId)
      .all();
    const github: GitAccount[] = user.auth_kind !== 'test' && user.github_id && user.github_connected
      ? [{ id: 'github', provider: 'github', host: 'github.com', organization: '', login: user.github_login ?? '', createdAt: null }] : [];
    return c.json({ accounts: [...github, ...rows.map(publicAccount)] });
  });

  app.post('/api/git/accounts', async c => {
    const userId = c.get('auth').userId;
    const input = accountInput(await jsonObject(c, 32768));
    const user = await getUser(c.env, userId);
    if (!user) fail(404, 'not_found', 'User not found.');
    if (user.auth_kind === 'test' && !testMode(c.env)) fail(403, 'test_mode_disabled', 'Synthetic users cannot connect Git accounts.');
    const credential: GitCredential = { id: id(), ...input };
    const { login } = await gitProviderAdapters[input.provider].verify(credential);
    if (typeof login !== 'string' || !login || login.length > 200 || /[\x00-\x1f\x7f]/.test(login)) {
      fail(502, 'invalid_git_response', `${gitProviderNames[input.provider]} returned an invalid account name.`);
    }
    const ciphertext = await encryptToken(c.env, userId, input.token);
    const timestamp = now();
    const row = await c.env.DB.query<Pick<GitCredentialRow, 'id' | 'provider' | 'host' | 'organization' | 'login' | 'created_at'>>(`INSERT INTO git_credentials
      (id, user_id, provider, host, organization, username, login, ciphertext, created_at, updated_at)
      SELECT ?,?,?,?,?,?,?,?,?,?
      WHERE EXISTS (SELECT 1 FROM users WHERE id = ? AND (auth_kind IN ('github', 'password') OR (? = 1 AND auth_kind = 'test')))
        AND ((SELECT COUNT(*) FROM git_credentials WHERE user_id = ?) < ? OR EXISTS (SELECT 1 FROM git_credentials
          WHERE user_id = ? AND provider = ? AND host = ? AND organization = ?))
      ON CONFLICT (user_id, provider, host, organization) DO UPDATE SET username = excluded.username, login = excluded.login,
        ciphertext = excluded.ciphertext, updated_at = excluded.updated_at
      RETURNING id, provider, host, organization, login, created_at`)
      .bind(credential.id, userId, input.provider, input.host, input.organization, input.username, login, ciphertext, timestamp, timestamp,
        userId, testMode(c.env) ? 1 : 0, userId, accountLimit, userId, input.provider, input.host, input.organization)
      .first();
    if (!row) fail(409, 'git_account_limit', `Remove a connected Git account first; at most ${accountLimit} can be connected.`);
    await auditStatement(c.env, userId, 'git.account.connected', null, null,
      { accountId: row.id, provider: row.provider, host: row.host, organization: row.organization }).run();
    return c.json({ account: publicAccount(row) }, 201);
  });

  app.put('/api/git/accounts/github', async c => {
    const userId = c.get('auth').userId;
    if (!localMode(c.env)) fail(400, 'invalid_git_provider', 'GitHub.com uses the sign-in connection here: sign in with GitHub.');
    const input = await jsonObject(c, 32768);
    if (Object.keys(input).some(key => key !== 'token')) fail(400, 'invalid_git_account', 'Only token is accepted.');
    const token = typeof input.token === 'string' ? input.token.trim() : '';
    if (!/^[\x21-\x7e]{1,4096}$/.test(token)) fail(400, 'invalid_git_token', 'Paste a GitHub personal access token.');
    const user = await getUser(c.env, userId);
    if (!user || (user.auth_kind !== 'password' && user.auth_kind !== 'github')) fail(403, 'github_not_connected', 'Synthetic users cannot connect GitHub.');
    const owner = await githubTokenOwner(token);
    if (user.auth_kind === 'github' && user.github_id !== owner.id) {
      fail(409, 'github_account_mismatch', `This token is @${owner.login}'s. This Pikibun's owner signed in with ${user.github_login ? `@${user.github_login}` : 'another GitHub account'}: paste a token of that account.`);
    }
    const ciphertext = await encryptToken(c.env, userId, token);
    const timestamp = now();
    let stored = false;
    try {
      const [claimed] = await c.env.DB.batch([
        c.env.DB.query(`UPDATE users SET github_id = ?, github_login = ? WHERE id = ? AND (auth_kind = 'password' OR (auth_kind = 'github' AND github_id = ?))`)
          .bind(owner.id, owner.login, userId, owner.id),
        c.env.DB.query(`INSERT INTO github_tokens (user_id, ciphertext, updated_at) SELECT ?, ?, ? WHERE changes() = 1
          ON CONFLICT(user_id) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`).bind(userId, ciphertext, timestamp),
        auditAfterChange(c.env, userId, 'git.account.connected', null, { accountId: 'github', provider: 'github', host: 'github.com', organization: '' }),
      ]);
      stored = claimed!.changes === 1;
    } catch (error) {
      if (!(error instanceof ConstraintError)) throw error;
      fail(409, 'github_account_taken', `Another account on this Pikibun is @${owner.login} on GitHub already.`);
    }
    if (!stored) fail(409, 'github_account_mismatch', 'Your account changed meanwhile. Reload and try again.');
    return c.json({ account: { id: 'github', provider: 'github', host: 'github.com', organization: '', login: owner.login, createdAt: null } satisfies GitAccount }, 201);
  });

  app.delete('/api/git/accounts/:id', async c => {
    const userId = c.get('auth').userId;
    if (c.req.param('id') === 'github') {
      const [deleted] = await c.env.DB.batch<{ ciphertext: string }>([
        c.env.DB.query<{ ciphertext: string }>(`DELETE FROM github_tokens WHERE user_id = ?
          AND EXISTS (SELECT 1 FROM users WHERE id = ? AND auth_kind IN ('github', 'password')) RETURNING ciphertext`).bind(userId, userId),
        auditAfterChange(c.env, userId, 'git.account.removed', null, { accountId: 'github', provider: 'github', host: 'github.com', organization: '' }),
        c.env.DB.query<{ ciphertext: string }>(`UPDATE users SET github_id = NULL, github_login = NULL WHERE id = ? AND auth_kind = 'password'
          AND changes() = 1 AND NOT EXISTS (SELECT 1 FROM github_tokens WHERE user_id = ?)`).bind(userId, userId),
      ]);
      const ciphertext = deleted.results[0]?.ciphertext;
      if (!ciphertext) fail(404, 'not_found', 'Git account not found.');
      if (localMode(c.env)) return c.body(null, 204);
      let revoked = false;
      try { revoked = await revokeGitHubToken(c.env, await decryptToken(c.env, userId, ciphertext)); } catch { }
      if (!revoked) console.error(`pikibun: the GitHub sign-in token of ${userId} left the vault, but GitHub could not be asked to revoke it`);
      return c.body(null, 204);
    }
    const removed = await c.env.DB.query<Pick<GitCredentialRow, 'id' | 'provider' | 'host' | 'organization'>>('DELETE FROM git_credentials WHERE id = ? AND user_id = ? RETURNING id, provider, host, organization')
      .bind(identifier(c.req.param('id')), userId).first();
    if (!removed) fail(404, 'not_found', 'Git account not found.');
    await auditStatement(c.env, userId, 'git.account.removed', null, null,
      { accountId: removed.id, provider: removed.provider, host: removed.host, organization: removed.organization }).run();
    return c.body(null, 204);
  });

  app.get('/api/git/accounts/:id/repositories', async c => {
    const userId = c.get('auth').userId;
    const accountId = c.req.param('id');
    const path = c.req.query('path');
    if (path !== undefined && accountId === 'github') fail(400, 'invalid_repository', 'Only Git server accounts look repositories up by path.');
    if (accountId === 'github') return c.json(await githubRepositories(c.env, userId));
    const row = await c.env.DB.query<GitCredentialRow>('SELECT * FROM git_credentials WHERE id = ? AND user_id = ?')
      .bind(identifier(accountId), userId).first();
    if (!row) fail(404, 'not_found', 'Git account not found.');
    const access = await loaded(c.env, row);
    if (path !== undefined) {
      if (row.provider !== 'git') fail(400, 'invalid_repository', 'Only Git server accounts look repositories up by path.');
      const fullName = plainRepositoryPath(row.host, path) ?? fail(400, 'invalid_repository',
        `Enter the repository's clone URL on ${row.host}, or its path there, such as team/project.git.`);
      const repository = providerRepository('git', await gitProviderAdapters.git.repository(access.credential,
        { id: await plainRepositoryId(fullName), fullName }));
      await recheckCredential(c.env, access);
      return c.json({ repositories: [repository], truncated: false } satisfies ProviderRepositoryList);
    }
    const result = await gitProviderAdapters[row.provider].list(access.credential);
    if (!Array.isArray(result?.repositories) || result.repositories.length > repositoryLimits.pickerRepositories) {
      fail(502, 'invalid_git_response', `${gitProviderNames[row.provider]} returned invalid repository metadata.`);
    }
    const repositories = result.repositories.map(item => providerRepository(row.provider, item));
    await recheckCredential(c.env, access);
    return c.json({ repositories, truncated: result.truncated === true } satisfies ProviderRepositoryList);
  });
}
