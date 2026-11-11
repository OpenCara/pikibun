import { API_CREDENTIAL_CACHE_SECONDS, credentialedApiHosts, credentialedApiProviders, type ApiAccessKind, type ApiCredential, type ApiCredentialGrant,
  type CredentialedApiProvider } from '../../../../packages/shared/src/network.js';
import { HTTPException } from 'hono/http-exception';
import type { AppContext, Env, RepositoryRow, SessionRow } from '../types.js';
import { sessionAccess } from './access.js';
import { fail, identifier, jsonObject } from '../http.js';
import { authenticateConnector, requireConnectorSession, type ConnectorRow } from './hosts.js';
import { recheckAccess, repositoryAccess, verifyRepository, type RepositoryAccess } from './repositories.js';
import { credentialOrganization, loadCredential, recheckCredential, type LoadedCredential } from './git/accounts.js';
import { mintGitHubApiReadTokens } from './push/mint.js';

export function sandboxGitHubApiMode(env: Env): 'on' | 'own-hosts' | 'off' {
  const value = env.SANDBOX_GITHUB_API?.trim().toLowerCase();
  return value === 'off' || value === 'own-hosts' ? value : 'on';
}

function servedBy(provider: CredentialedApiProvider, repository: Pick<RepositoryRow, 'provider' | 'host'>): boolean {
  if (provider === 'github') return repository.provider === 'github';
  if (provider === 'gitlab') return repository.provider === 'gitlab' && repository.host === 'gitlab.com';
  return repository.provider === 'azure-devops' && repository.host === 'dev.azure.com';
}

export function sessionApis(env: Env, session: SessionRow, repositories: Pick<RepositoryRow, 'provider' | 'host'>[]): { host: string; provider: CredentialedApiProvider }[] {
  if (sandboxGitHubApiMode(env) === 'off' || session.repository_mode !== 'clone') return [];
  return credentialedApiHosts.flatMap(host => {
    const provider = credentialedApiProviders[host]!;
    return repositories.some(repository => servedBy(provider, repository)) ? [{ host, provider }] : [];
  });
}

const OWN_CREDENTIAL_SECONDS = 3600;

export async function apiCredential(c: AppContext, connector: ConnectorRow | null): Promise<Response> {
  const input = await jsonObject(c, 4096);
  if (Object.keys(input).some(key => key !== 'sessionId' && key !== 'host' && key !== 'access')) fail(400, 'invalid_api_request', 'Only the session, host and access are accepted.');
  const sessionId = identifier(input.sessionId, 'sessionId');
  if (typeof input.host !== 'string' || !credentialedApiHosts.includes(input.host)) fail(400, 'invalid_api_request', 'Not a credentialed API host.');
  if (input.access !== undefined && input.access !== 'read' && input.access !== 'write') fail(400, 'invalid_api_request', 'Access is read or write.');
  const host = input.host;
  const access: ApiAccessKind = input.access === 'write' ? 'write' : 'read';
  const provider = credentialedApiProviders[host]!;
  const name = provider === 'github' ? 'GitHub' : provider === 'gitlab' ? 'GitLab' : 'Azure DevOps';
  const noStore = { 'Cache-Control': 'private, no-store' };
  const unavailable = (reason: string) => c.json({ available: false, reason, cacheSeconds: API_CREDENTIAL_CACHE_SECONDS } satisfies ApiCredentialGrant, 200, noStore);

  const original = await c.env.DB.query<SessionRow>('SELECT * FROM sessions WHERE id = ?').bind(sessionId).first();
  if (!original) fail(404, 'not_found', 'Session not found.');
  const authorize = async () => {
    const fresh = await sessionAccess(c.env, sessionId, original.owner_id);
    if (!fresh || fresh.row.status === 'archived' || fresh.row.owner_id !== original.owner_id || fresh.row.workspace_id !== original.workspace_id) {
      fail(403, 'repository_authority_changed', 'Session repository access is no longer authorized.');
    }
    if (connector) {
      const current = await authenticateConnector(c);
      if (current.id !== connector.id || current.connection_hash !== connector.connection_hash) fail(401, 'stale_connection', 'The connector connection changed.');
      await requireConnectorSession(c.env, connector.id, fresh.row, connector.connection_hash!);
    } else if (fresh.row.connector_id) fail(403, 'connector_scope_required', 'Use the connector-scoped API credential route.');
  };
  await authorize();

  const mode = sandboxGitHubApiMode(c.env);
  if (mode === 'off') return unavailable(`${name} API access from sessions is off on this Pikibun server`);
  if (original.repository_mode !== 'clone') return unavailable(`Only sessions that clone their repositories read the ${name} API through Pikibun`);
  const ownHost = connector === null || (connector.owner_id === original.owner_id && original.connector_owner_id === original.owner_id);
  if (mode === 'own-hosts' && !ownHost) return unavailable(`This Pikibun server gives ${name} API credentials only to session owners' own hosts`);
  const ownCredential = access === 'write' || provider !== 'github';
  if (ownCredential && !ownHost) {
    return unavailable(access === 'write'
      ? 'Writes through the API act as the session owner, so Pikibun allows them only on the session owner\'s own hosts; on this one, use github_comment, github_issue, github_merge and git_push'
      : `Pikibun reads the ${name} API with the session owner's personal access token, which can't be limited to the workspace's repositories, so only on the session owner's own hosts`);
  }

  const bindings = (await c.env.DB.query<RepositoryRow>('SELECT * FROM workspace_repositories WHERE workspace_id = ? ORDER BY id')
    .bind(original.workspace_id).all()).filter(repository => servedBy(provider, repository));
  if (!bindings.length) return unavailable(`This workspace has no ${provider === 'github' ? 'github.com' : provider === 'gitlab' ? 'gitlab.com' : 'Azure DevOps'} repositories`);
  const expiresAt = () => new Date(Date.now() + OWN_CREDENTIAL_SECONDS * 1000).toISOString();
  const answer = async (credentials: ApiCredential[]) => {
    await authorize();
    return c.json({ available: true, cacheSeconds: API_CREDENTIAL_CACHE_SECONDS, credentials } satisfies ApiCredentialGrant, 200, noStore);
  };

  if (provider !== 'github') {
    const organizations = [...new Set(bindings.map(binding => credentialOrganization(binding.provider, binding.full_name)))].slice(0, 20);
    const loaded: { organization: string; account: LoadedCredential }[] = [];
    for (const organization of organizations) {
      const account = await loadCredential(c.env, original.owner_id, provider, host, organization);
      if (account) loaded.push({ organization, account });
    }
    if (!loaded.length) return unavailable(`The session owner has no ${provider === 'gitlab' ? 'GitLab (gitlab.com)' : 'Azure DevOps'} account in Pikibun (Settings → Profile → Git accounts)`);
    for (const item of loaded) await recheckCredential(c.env, item.account);
    return answer(loaded.map(({ organization, account }) => ({
      account: provider === 'azure-devops' ? organization : 'gitlab.com',
      authorization: provider === 'azure-devops' ? `Basic ${Buffer.from(`:${account.credential.token}`).toString('base64')}` : `Bearer ${account.credential.token}`,
      repositories: [], expiresAt: expiresAt(),
    })));
  }

  let owner: RepositoryAccess;
  try { owner = await repositoryAccess(c.env, original.owner_id, 'github', 'github.com', bindings[0]!.full_name); }
  catch { return unavailable('The session owner has no GitHub connection, which reaching the GitHub API with the workspace\'s repositories needs'); }
  const readable: { fullName: string; repositoryId: string }[] = [];
  let limited = false;
  for (const binding of bindings.slice(0, 100)) {
    try {
      await verifyRepository(owner, { repositoryId: binding.repository_id, fullName: binding.full_name });
      readable.push({ fullName: binding.full_name, repositoryId: binding.repository_id });
    } catch (error) {
      if (error instanceof HTTPException && error.status === 429) { limited = true; break; }
    }
  }
  if (!readable.length) {
    return unavailable(limited ? 'The session owner\'s GitHub rate limit is used up, so Pikibun can\'t check their access to this workspace\'s repositories now; try again after it resets'
      : 'The session owner can read none of this workspace\'s github.com repositories');
  }
  await recheckAccess(c.env, owner);
  await authorize();
  if (access === 'write') {
    if (owner.provider !== 'github') return unavailable('The session owner has no GitHub connection');
    return answer([{ account: 'session-owner', authorization: `Bearer ${owner.github.token}`, repositories: readable.map(item => item.fullName), expiresAt: expiresAt() }]);
  }
  let minted: Awaited<ReturnType<typeof mintGitHubApiReadTokens>>;
  try { minted = await mintGitHubApiReadTokens(c.env, { workspaceId: original.workspace_id, repositories: readable }); }
  catch { return unavailable('GitHub did not issue a token for the workspace\'s GitHub App; try again later'); }
  if (!minted) return unavailable('Reading the GitHub API from sessions needs a GitHub App: the workspace\'s, under Push access, or this server\'s (GITHUB_APP_ID)');
  if (!minted.tokens.length) return unavailable(`The GitHub App is not installed on ${minted.notInstalled.slice(0, 3).join(', ')}${minted.notInstalled.length > 3 ? ' and others' : ''}`);
  return answer(minted.tokens.map(item => ({ account: item.account, authorization: `Bearer ${item.token}`, repositories: item.repositories,
    expiresAt: new Date(item.expiresAt * 1000).toISOString() })));
}
