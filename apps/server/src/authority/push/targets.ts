import { HTTPException } from 'hono/http-exception';
import type { GitProvider, SessionRepository } from '../../../../../packages/shared/src/repositories.js';
import { gitProviderNames, repositoryRemote } from '../../../../../packages/shared/src/repositories.js';
import { fail } from '../../http.js';
import { boundedRepositoryBody, verifyRepository, type RepositoryAccess } from '../repositories.js';
import { basic, gitProviderAdapters, plainAuthorization, plainPushAllowed } from '../git/providers.js';

export interface PushTarget { canPush: boolean; defaultBranch: string; remote: string; azureProjectId?: string }
export interface PullRequestInput { head: string; base: string; title: string; body: string; draft?: boolean }
export interface OpenedPullRequest { url: string; number: number; created: boolean; draft: boolean }

const jsonBytes = 512 * 1024;
const remoteTimeout = 20_000;
const userAgent = 'OpenCara-Agent-Workspace';
const sha1 = /^[0-9a-f]{40}$/;
type Headers = Record<string, string>;
interface Api { provider: GitProvider; base: string; web: string; headers: Headers }

const label = (provider: GitProvider): string => gitProviderNames[provider];
function unavailable(provider: GitProvider): never {
  return fail(502, 'git_provider_unavailable', `${label(provider)} could not complete the push request.`);
}
function permissionRequired(provider: GitProvider): never {
  return fail(403, 'push_permission_required', `The session owner cannot push to this ${label(provider)} repository.`);
}
function unverifiable(provider: GitProvider, detail: string): never {
  return fail(409, 'push_permission_unverifiable', `${label(provider)} push permission could not be verified: ${detail}`);
}
function noForge(): never {
  return fail(422, 'pull_request_unsupported', `A ${label('git')} has no pull requests; push the branch without one.`);
}

function provider(pin: SessionRepository): GitProvider { return 'provider' in pin ? pin.provider : 'github'; }
function host(pin: SessionRepository): string { return 'provider' in pin ? pin.host : 'github.com'; }
function plainAccount(credentialHost: string, pin: SessionRepository): void {
  if (provider(pin) !== 'git' || credentialHost !== host(pin)) fail(409, 'repository_identity_changed', 'The repository host changed.');
}

function api(access: RepositoryAccess, pin: SessionRepository): Api {
  if (access.provider !== provider(pin)) fail(409, 'repository_identity_changed', 'The repository provider changed.');
  if (access.provider === 'github') {
    return { provider: 'github', base: 'https://api.github.com', web: 'github.com', headers: {
      Authorization: `Bearer ${access.github.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } };
  }
  const credential = access.account.credential;
  if (credential.host !== host(pin)) fail(409, 'repository_identity_changed', 'The repository host changed.');
  const origin = `https://${credential.host}`;
  switch (access.provider) {
    case 'github-enterprise': return { provider: access.provider, base: `${origin}/api/v3`, web: credential.host,
      headers: { Authorization: `Bearer ${credential.token}`, Accept: 'application/vnd.github+json' } };
    case 'gitlab': return { provider: access.provider, base: `${origin}/api/v4`, web: credential.host, headers: { Authorization: `Bearer ${credential.token}` } };
    case 'gitea': return { provider: access.provider, base: `${origin}/api/v1`, web: credential.host, headers: { Authorization: `token ${credential.token}` } };
    case 'bitbucket': return { provider: access.provider, base: 'https://api.bitbucket.org/2.0', web: 'bitbucket.org',
      headers: { Authorization: credential.username ? basic(credential.username, credential.token) : `Bearer ${credential.token}` } };
    case 'azure-devops': {
      const organization = pin.fullName.split('/')[0]!;
      if (organization.toLowerCase() !== credential.organization.toLowerCase()) permissionRequired(access.provider);
      return { provider: access.provider, base: `https://dev.azure.com/${organization}`, web: 'dev.azure.com', headers: { Authorization: basic('', credential.token) } };
    }
    case 'git': return noForge();
  }
}

export function ownerGitAuthorization(access: RepositoryAccess): string {
  if (access.provider === 'github') return basic('x-access-token', access.github.token);
  const { token, username } = access.account.credential;
  switch (access.provider) {
    case 'github-enterprise': return basic('x-access-token', token);
    case 'gitlab': case 'gitea': return basic('oauth2', token);
    case 'bitbucket': return basic(username ? 'x-bitbucket-api-token-auth' : 'x-token-auth', token);
    case 'azure-devops': return basic('', token);
    case 'git': return plainAuthorization(access.account.credential);
  }
}

async function call(target: Api, url: string, init: { method?: string; body?: unknown; errorBody?: boolean } = {}): Promise<{ status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(url, { method: init.method ?? 'GET', redirect: 'manual', signal: AbortSignal.timeout(remoteTimeout),
      headers: { Accept: 'application/json', ...target.headers, 'User-Agent': userAgent, ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
  } catch { return unavailable(target.provider); }
  if (init.errorBody && response.status >= 400 && response.status < 500) {
    try {
      const bytes = await boundedRepositoryBody(response, jsonBytes);
      return { status: response.status, body: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
    } catch {
      await response.body?.cancel().catch(() => {});
      return { status: response.status, body: undefined };
    }
  }
  if (response.status < 200 || response.status >= 300 || response.status === 204) {
    await response.body?.cancel().catch(() => {});
    return { status: response.status, body: undefined };
  }
  let bytes: Uint8Array;
  try { bytes = await boundedRepositoryBody(response, jsonBytes); } catch { return unavailable(target.provider); }
  try { return { status: response.status, body: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }; }
  catch { return unavailable(target.provider); }
}
function object(target: Api, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) unavailable(target.provider);
  return value as Record<string, unknown>;
}
function array(target: Api, value: unknown): unknown[] {
  if (!Array.isArray(value)) unavailable(target.provider);
  return value;
}
async function read(target: Api, url: string): Promise<Record<string, unknown>> {
  const result = await call(target, url);
  if (result.status === 200) return object(target, result.body);
  if ([401, 403, 404].includes(result.status)) permissionRequired(target.provider);
  return unavailable(target.provider);
}

function azureSegment(segment: string): string {
  let hex = '';
  for (let index = 0; index < segment.length; index++) {
    const unit = segment.charCodeAt(index);
    hex += (unit & 0xff).toString(16).padStart(2, '0') + (unit >> 8).toString(16).padStart(2, '0');
  }
  return hex;
}
function azureBranchToken(projectId: string, repositoryId: string, branch: string, kind: 'heads' | 'tags' = 'heads'): string {
  return `repoV2/${projectId}/${repositoryId}/refs/${kind}/${branch.split('/').map(azureSegment).join('/')}`;
}

async function existingBranch(target: Api, url: string): Promise<Record<string, unknown> | null> {
  const result = await call(target, url);
  if (result.status === 200) return object(target, result.body);
  if (result.status === 404) return null;
  if (result.status === 401 || result.status === 403) permissionRequired(target.provider);
  return unavailable(target.provider);
}

async function ownerCanPush(target: Api, pin: SessionRepository, branch: string): Promise<{ canPush: boolean; azureProjectId?: string }> {
  const id = encodeURIComponent(String(pin.repositoryId));
  const branchPath = branch.split('/').map(encodeURIComponent).join('/');
  switch (target.provider) {
    case 'github':
    case 'github-enterprise': {
      const repository = target.provider === 'github'
        ? await read(target, `${target.base}/repos/${pin.fullName}`)
        : await read(target, `${target.base}/repositories/${id}`);
      if (object(target, repository.permissions).push !== true) return { canPush: false };
      const existing = await existingBranch(target, `${target.base}/repos/${pin.fullName}/branches/${branchPath}`);
      if (existing?.protected === true) fail(403, 'protected_branch', 'Protected branches are not pushed through push identities; open a pull request instead.');
      return { canPush: true };
    }
    case 'gitea': {
      if (object(target, (await read(target, `${target.base}/repositories/${id}`)).permissions).push !== true) return { canPush: false };
      const existing = await existingBranch(target, `${target.base}/repos/${pin.fullName}/branches/${branchPath}`);
      return { canPush: existing === null || existing.user_can_push === true };
    }
    case 'gitlab': {
      const permissions = object(target, (await read(target, `${target.base}/projects/${id}`)).permissions);
      const level = (value: unknown): number => {
        const item = value && typeof value === 'object' ? (value as Record<string, unknown>).access_level : undefined;
        return typeof item === 'number' ? item : 0;
      };
      if (Math.max(level(permissions.project_access), level(permissions.group_access)) < 30) return { canPush: false };
      const existing = await existingBranch(target, `${target.base}/projects/${id}/repository/branches/${encodeURIComponent(branch)}`);
      return { canPush: existing === null || existing.can_push === true };
    }
    case 'bitbucket': {
      if (!target.headers.Authorization!.startsWith('Basic ')) unverifiable(target.provider, 'connect an Atlassian API token with your account email in Settings → Profile.');
      const query = encodeURIComponent(`repository.full_name="${pin.fullName}"`);
      const values = array(target, (await read(target, `${target.base}/user/permissions/repositories?q=${query}`)).values);
      const permission = values.length === 1 ? object(target, values[0]).permission : undefined;
      return { canPush: permission === 'write' || permission === 'admin' };
    }
    case 'azure-devops': {
      const repository = await read(target, `${target.base}/_apis/git/repositories/${id}?api-version=7.1`);
      const projectId = object(target, repository.project).id;
      if (typeof projectId !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(projectId)) unavailable(target.provider);
      const tokens = encodeURIComponent(azureBranchToken(projectId, String(pin.repositoryId), branch));
      const result = await call(target, `${target.base}/_apis/permissions/2e9eb7ed-3c0a-47d4-87c1-0ffdd275fd87/4?tokens=${tokens}&api-version=7.1`);
      if (result.status !== 200) unverifiable(target.provider, 'the connected token cannot read repository permissions.');
      const value = array(target, object(target, result.body).value);
      return { canPush: value[0] === true, azureProjectId: projectId };
    }
    case 'git': return noForge();
  }
}

async function ownerCanTag(target: Api, pin: SessionRepository, tag: string): Promise<{ canPush: boolean; azureProjectId?: string }> {
  const id = encodeURIComponent(String(pin.repositoryId));
  switch (target.provider) {
    case 'github':
    case 'github-enterprise': {
      const repository = target.provider === 'github'
        ? await read(target, `${target.base}/repos/${pin.fullName}`)
        : await read(target, `${target.base}/repositories/${id}`);
      return { canPush: object(target, repository.permissions).push === true };
    }
    case 'gitea':
      return { canPush: object(target, (await read(target, `${target.base}/repositories/${id}`)).permissions).push === true };
    case 'gitlab': {
      const permissions = object(target, (await read(target, `${target.base}/projects/${id}`)).permissions);
      const level = (value: unknown): number => {
        const item = value && typeof value === 'object' ? (value as Record<string, unknown>).access_level : undefined;
        return typeof item === 'number' ? item : 0;
      };
      return { canPush: Math.max(level(permissions.project_access), level(permissions.group_access)) >= 30 };
    }
    case 'bitbucket':
      return ownerCanPush(target, pin, tag);
    case 'azure-devops': {
      const repository = await read(target, `${target.base}/_apis/git/repositories/${id}?api-version=7.1`);
      const projectId = object(target, repository.project).id;
      if (typeof projectId !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(projectId)) unavailable(target.provider);
      const tokens = encodeURIComponent(azureBranchToken(projectId, String(pin.repositoryId), tag, 'tags'));
      const result = await call(target, `${target.base}/_apis/permissions/2e9eb7ed-3c0a-47d4-87c1-0ffdd275fd87/32?tokens=${tokens}&api-version=7.1`);
      if (result.status !== 200) unverifiable(target.provider, 'the connected token cannot read repository permissions.');
      const value = array(target, object(target, result.body).value);
      return { canPush: value[0] === true, azureProjectId: projectId };
    }
    case 'git': return noForge();
  }
}

export async function pushTarget(access: RepositoryAccess, pin: SessionRepository, branch: string, tag?: string): Promise<PushTarget> {
  if (access.provider === 'git') {
    plainAccount(access.account.credential.host, pin);
    const metadata = await verifyRepository(access, { repositoryId: String(pin.repositoryId), fullName: pin.fullName });
    return { canPush: await plainPushAllowed(access.account.credential, pin.fullName), defaultBranch: metadata.defaultBranch, remote: repositoryRemote(pin) };
  }
  const target = api(access, pin);
  const metadata = await verifyRepository(access, { repositoryId: String(pin.repositoryId), fullName: pin.fullName });
  const permission = tag === undefined ? await ownerCanPush(target, pin, branch) : await ownerCanTag(target, pin, tag);
  return { canPush: permission.canPush, defaultBranch: metadata.defaultBranch, remote: repositoryRemote(pin),
    ...(permission.azureProjectId ? { azureProjectId: permission.azureProjectId } : {}) };
}

export async function branchTip(access: RepositoryAccess, pin: SessionRepository, branch: string): Promise<string | null> {
  if (access.provider === 'github') {
    const target = api(access, pin);
    const result = await call(target, `${target.base}/repos/${pin.fullName}/commits/${encodeURIComponent(branch)}`);
    if (result.status === 404 || result.status === 422) return null;
    if (result.status !== 200) return unavailable(target.provider);
    const sha = object(target, result.body).sha;
    if (typeof sha !== 'string' || !sha1.test(sha)) unavailable(target.provider);
    return sha;
  }
  if (access.provider === 'git') plainAccount(access.account.credential.host, pin);
  else api(access, pin);
  try {
    return await gitProviderAdapters[access.provider].commit(access.account.credential, { id: String(pin.repositoryId), fullName: pin.fullName }, branch);
  } catch (error) {
    if (error instanceof HTTPException && error.status === 403) return null;
    throw error;
  }
}

function webURL(target: Api, value: unknown): string {
  let url: URL;
  try { url = new URL(typeof value === 'string' ? value : ''); } catch { return unavailable(target.provider); }
  if (url.protocol !== 'https:' || url.host !== target.web || url.username || url.password) unavailable(target.provider);
  return url.href;
}
function positive(target: Api, value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) unavailable(target.provider);
  return value;
}

const draftPrefix = /^\s*(?:\[(?:draft|wip)\]|\((?:draft|wip)\)|(?:draft|wip)\s*:)\s*/i;
export function withoutDraftPrefix(title: string): string {
  let rest = title;
  while (draftPrefix.test(rest)) rest = rest.replace(draftPrefix, '');
  return rest.trim() ? rest : title;
}
function withDraftPrefix(title: string, prefix: string): string {
  return draftPrefix.test(title) ? title : `${prefix} ${title}`;
}

export async function openPullRequest(access: RepositoryAccess, pin: SessionRepository, input: PullRequestInput, azureProjectId?: string): Promise<OpenedPullRequest> {
  const target = api(access, pin);
  const id = encodeURIComponent(String(pin.repositoryId));
  const created = async (url: string, body: unknown, conflict: readonly number[]): Promise<unknown | null> => {
    const result = await call(target, url, { method: 'POST', body });
    if (result.status === 200 || result.status === 201) return result.body;
    if (conflict.includes(result.status)) return null;
    if ([401, 403, 404].includes(result.status)) permissionRequired(target.provider);
    return unavailable(target.provider);
  };
  const existing = async (url: string, pick: (body: unknown) => unknown): Promise<unknown> => {
    const result = await call(target, url);
    if (result.status !== 200) unavailable(target.provider);
    const item = pick(result.body);
    if (item === undefined) unavailable(target.provider);
    return item;
  };
  const changed = async (url: string, method: 'PATCH' | 'PUT' | 'POST', body: unknown): Promise<unknown> => {
    const result = await call(target, url, { method, body });
    if (result.status >= 200 && result.status < 300) return result.body;
    if ([401, 403, 404].includes(result.status)) permissionRequired(target.provider);
    return unavailable(target.provider);
  };
  const ready = input.draft === false;
  const leftDraft = (answer: unknown, isDraft: (item: Record<string, unknown>) => boolean): void => {
    if (answer && typeof answer === 'object' && !Array.isArray(answer) && isDraft(answer as Record<string, unknown>)) {
      fail(409, 'pull_request_still_draft', `${label(target.provider)} still marks the pull request as a draft; make it ready for review there.`);
    }
  };
  switch (target.provider) {
    case 'github':
    case 'github-enterprise': {
      const parse = (value: unknown) => {
        const item = object(target, value);
        return { url: webURL(target, item.html_url), number: positive(target, item.number), draft: item.draft === true, node: item.node_id };
      };
      const creation = await call(target, `${target.base}/repos/${pin.fullName}/pulls`, { method: 'POST', errorBody: true,
        body: { title: input.title, head: input.head, base: input.base, body: input.body, ...(input.draft ? { draft: true } : {}) } });
      if (creation.status === 200 || creation.status === 201) { const { node: _node, ...pull } = parse(creation.body); return { ...pull, created: true }; }
      if ([401, 403, 404].includes(creation.status)) permissionRequired(target.provider);
      if (creation.status !== 422) unavailable(target.provider);
      const refusal = JSON.stringify(creation.body ?? '').toLowerCase();
      if (input.draft && /draft pull requests? (?:are|is) not supported|draft.*not (?:supported|available|enabled)/.test(refusal)) {
        fail(422, 'draft_unsupported', 'GitHub refused a draft pull request for this repository; open it without draft: true.');
      }
      const owner = pin.fullName.split('/')[0]!;
      const found = await existing(`${target.base}/repos/${pin.fullName}/pulls?state=open&head=${encodeURIComponent(`${owner}:${input.head}`)}&base=${encodeURIComponent(input.base)}`,
        body => array(target, body)[0] ?? null);
      if (found === null) unavailable(target.provider);
      const { node, ...open } = parse(found);
      if (!ready || !open.draft) return { ...open, created: false };
      if (typeof node !== 'string' || !/^[A-Za-z0-9_=-]{1,200}$/.test(node)) unavailable(target.provider);
      await changed(`${target.base}/repos/${pin.fullName}/pulls/${open.number}`, 'PATCH', { title: input.title, body: input.body });
      const graphql = target.provider === 'github' ? `${target.base}/graphql` : target.base.replace(/\/v3$/, '/graphql');
      const answer = object(target, await changed(graphql, 'POST', {
        query: 'mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }', variables: { id: node } }));
      const marked = answer.data && typeof answer.data === 'object' ? (answer.data as Record<string, unknown>).markPullRequestReadyForReview : undefined;
      const pull = marked && typeof marked === 'object' ? (marked as Record<string, unknown>).pullRequest : undefined;
      if (!pull || typeof pull !== 'object' || (pull as Record<string, unknown>).isDraft !== false) {
        if (Array.isArray(answer.errors) && answer.errors.length) permissionRequired(target.provider);
        unavailable(target.provider);
      }
      return { ...open, created: false, draft: false };
    }
    case 'gitlab': {
      const isDraft = (item: Record<string, unknown>) => item.draft === true || item.work_in_progress === true
        || (typeof item.title === 'string' && draftPrefix.test(item.title));
      const parse = (value: unknown) => {
        const item = object(target, value);
        return { url: webURL(target, item.web_url), number: positive(target, item.iid), draft: isDraft(item) };
      };
      const made = await created(`${target.base}/projects/${id}/merge_requests`,
        { source_branch: input.head, target_branch: input.base, title: input.draft ? withDraftPrefix(input.title, 'Draft:') : input.title, description: input.body }, [409]);
      if (made !== null) return { ...parse(made), created: true };
      const open = parse(await existing(`${target.base}/projects/${id}/merge_requests?state=opened&source_branch=${encodeURIComponent(input.head)}&target_branch=${encodeURIComponent(input.base)}`,
        body => array(target, body)[0]));
      if (!ready || !open.draft) return { ...open, created: false };
      leftDraft(await changed(`${target.base}/projects/${id}/merge_requests/${open.number}`, 'PUT', { title: withoutDraftPrefix(input.title), description: input.body }), isDraft);
      return { ...open, created: false, draft: false };
    }
    case 'gitea': {
      const isDraft = (item: Record<string, unknown>) => item.draft === true || (typeof item.title === 'string' && draftPrefix.test(item.title));
      const parse = (value: unknown) => {
        const item = object(target, value);
        return { url: webURL(target, item.html_url), number: positive(target, item.number), draft: isDraft(item) };
      };
      const made = await created(`${target.base}/repos/${pin.fullName}/pulls`, { head: input.head, base: input.base,
        title: input.draft ? withDraftPrefix(input.title, 'WIP:') : input.title, body: input.body }, [409, 422]);
      if (made !== null) return { ...parse(made), created: true };
      const open = parse(await existing(`${target.base}/repos/${pin.fullName}/pulls/${encodeURIComponent(input.base)}/${encodeURIComponent(input.head)}`, body => body));
      if (!ready || !open.draft) return { ...open, created: false };
      leftDraft(await changed(`${target.base}/repos/${pin.fullName}/pulls/${open.number}`, 'PATCH', { title: withoutDraftPrefix(input.title), body: input.body }), isDraft);
      return { ...open, created: false, draft: false };
    }
    case 'bitbucket': {
      const parse = (value: unknown) => {
        const item = object(target, value);
        return { url: webURL(target, object(target, object(target, item.links).html).href), number: positive(target, item.id), draft: item.draft === true };
      };
      const made = await created(`${target.base}/repositories/${pin.fullName}/pullrequests`, { title: input.title, description: input.body,
        source: { branch: { name: input.head } }, destination: { branch: { name: input.base } }, ...(input.draft ? { draft: true } : {}) }, [400, 409]);
      if (made !== null) return { ...parse(made), created: true };
      const query = encodeURIComponent(`source.branch.name="${input.head}" AND destination.branch.name="${input.base}" AND state="OPEN"`);
      const open = parse(await existing(`${target.base}/repositories/${pin.fullName}/pullrequests?q=${query}`, body => array(target, object(target, body).values)[0]));
      if (!ready || !open.draft) return { ...open, created: false };
      leftDraft(await changed(`${target.base}/repositories/${pin.fullName}/pullrequests/${open.number}`, 'PUT', { title: input.title, description: input.body, draft: false }),
        item => item.draft === true);
      return { ...open, created: false, draft: false };
    }
    case 'azure-devops': {
      const [organization, project, repository] = pin.fullName.split('/') as [string, string, string];
      const projectPath = encodeURIComponent(azureProjectId ?? project);
      const parse = (value: unknown) => {
        const item = object(target, value);
        const number = positive(target, item.pullRequestId);
        return { url: `https://dev.azure.com/${organization}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repository)}/pullrequest/${number}`, number,
          draft: item.isDraft === true };
      };
      const base = `${target.base}/${projectPath}/_apis/git/repositories/${id}/pullrequests`;
      const made = await created(`${base}?api-version=7.1`, { sourceRefName: `refs/heads/${input.head}`, targetRefName: `refs/heads/${input.base}`,
        title: input.title, description: input.body, ...(input.draft ? { isDraft: true } : {}) }, [409]);
      if (made !== null) return { ...parse(made), created: true };
      const open = parse(await existing(`${base}?searchCriteria.sourceRefName=${encodeURIComponent(`refs/heads/${input.head}`)}` +
        `&searchCriteria.targetRefName=${encodeURIComponent(`refs/heads/${input.base}`)}&searchCriteria.status=active&api-version=7.1`,
        body => array(target, object(target, body).value)[0]));
      if (!ready || !open.draft) return { ...open, created: false };
      leftDraft(await changed(`${base}/${open.number}?api-version=7.1`, 'PATCH', { title: input.title, description: input.body, isDraft: false }),
        item => item.isDraft === true);
      return { ...open, created: false, draft: false };
    }
    case 'git': return noForge();
  }
}
