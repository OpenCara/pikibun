import { azurePullRequestUrl } from '../../../../packages/shared/src/pull-requests.js';
import { redactPatch } from '../../../../packages/shared/src/pull-request-review.js';
import { redactSecrets } from '../../../../packages/shared/src/redaction.js';
import {
  pullRequestReviewLimits, type GitHubCommentView, type GitHubIssueView, type GitHubPullRequestView, type GitHubReviewCommentView, type GitHubReviewView,
  type PullRequestCommitView, type PullRequestFileStatus, type PullRequestFileView, type PullRequestReview, type PullRequestState,
} from '../../../../packages/shared/src/types.js';
import { fail } from '../http.js';
import { basic } from './git/providers.js';
import type { GitCredential } from './git/types.js';
import { unifiedPatch, type UnifiedPatch } from './line-diff.js';

export interface AzureRepositoryApi { credential: GitCredential; fullName: string; repositoryId: string }

const origin = 'https://dev.azure.com';
const remoteTimeout = 20_000;
const jsonBytes = 4 * 1024 * 1024;
const fetchedBlobBytes = 8 * 1024 * 1024;
const blobReads = 6;
const listItems = 100;
const bodyCharacters = 16000;
const messageCharacters = 4000;
const changeEntries = 1000;
const commitPages = 20;
const buildPolicy = '0609b952-1397-4640-95ec-e00a01b2c241';
const sha1 = /^[0-9a-f]{40}$/;
const encoder = new TextEncoder();

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(502, 'invalid_azure_devops_response', 'Azure DevOps returned an unexpected response.');
  return value as Record<string, unknown>;
};
const optionalRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown): Record<string, unknown>[] => {
  if (!Array.isArray(value)) return fail(502, 'invalid_azure_devops_response', 'Azure DevOps returned an unexpected response.');
  return value.map(record);
};
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const nullableString = (value: unknown): string | null => typeof value === 'string' ? value : null;
const integer = (value: unknown): number | null => Number.isSafeInteger(value) ? value as number : null;
const person = (value: unknown): string | null => {
  const item = optionalRecord(value);
  return nullableString(item.displayName) ?? nullableString(item.uniqueName);
};
const branchName = (ref: unknown): string => string(ref).replace(/^refs\/heads\//, '');
function clip(value: unknown): string {
  const body = redactSecrets(string(value));
  return body.length <= bodyCharacters ? body : `${body.slice(0, bodyCharacters)}\n… ${body.length - bodyCharacters} more characters`;
}

function locate(api: AzureRepositoryApi): { project: string; repository: string } {
  const [organization, project] = api.fullName.split('/') as [string, string, string];
  if (organization.toLowerCase() !== api.credential.organization.toLowerCase()) {
    fail(403, 'azure_devops_access_denied', 'The session owner\'s Azure DevOps account is for another organization.');
  }
  const projectBase = `${origin}/${encodeURIComponent(organization)}/${encodeURIComponent(project)}/_apis`;
  return { project: projectBase, repository: `${projectBase}/git/repositories/${encodeURIComponent(api.repositoryId)}` };
}

async function bounded(response: Response, limit: number): Promise<Uint8Array | null> {
  const length = response.headers.get('content-length');
  if (length !== null && /^\d+$/.test(length) && Number(length) > limit) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(item.value);
    }
  } catch {
    return fail(502, 'azure_devops_unavailable', 'Azure DevOps could not complete the request.');
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  return bytes;
}

async function get(api: AzureRepositoryApi, url: string, accept: string, limit: number, next?: (token: string | null) => void): Promise<Uint8Array | null> {
  let response: Response;
  try {
    response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(remoteTimeout),
      headers: { Accept: accept, Authorization: basic('', api.credential.token), 'User-Agent': 'OpenCara-Agent-Workspace' } });
  } catch { return fail(502, 'azure_devops_unavailable', 'Azure DevOps could not complete the request.'); }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    if ([203, 302, 401, 403].includes(response.status)) {
      fail(403, 'azure_devops_access_denied', 'Azure DevOps refused the session owner\'s access token; it needs Code (Read) on this repository.');
    }
    if (response.status === 404) fail(404, 'no_pull_request', 'Azure DevOps has no such pull request in this repository.');
    if (response.status === 429) fail(429, 'azure_devops_rate_limited', 'Azure DevOps is limiting the session owner\'s requests. Try again later.');
    fail(502, 'azure_devops_unavailable', 'Azure DevOps could not complete the request.');
  }
  next?.(response.headers.get('x-ms-continuationtoken'));
  return bounded(response, limit);
}

async function json(api: AzureRepositoryApi, url: string, next?: (token: string | null) => void): Promise<Record<string, unknown>> {
  const bytes = await get(api, url, 'application/json', jsonBytes, next);
  if (!bytes) return fail(502, 'azure_devops_response_too_large', 'Azure DevOps returned more than Pikibun reads.');
  try { return record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
  catch { return fail(502, 'invalid_azure_devops_response', 'Azure DevOps returned an unexpected response.'); }
}

const versioned = (url: string) => `${url}${url.includes('?') ? '&' : '?'}api-version=7.1`;

async function pullRequestDetails(api: AzureRepositoryApi, number: number): Promise<Record<string, unknown>> {
  const pull = await json(api, versioned(`${locate(api).repository}/pullrequests/${number}`));
  if (integer(pull.pullRequestId) !== number) fail(502, 'invalid_azure_devops_response', 'Azure DevOps returned an unexpected pull request.');
  const repository = optionalRecord(pull.repository);
  if (string(repository.id).toLowerCase() !== api.repositoryId.toLowerCase()) fail(404, 'no_pull_request', 'Azure DevOps has no such pull request in this repository.');
  return pull;
}

type Check = GitHubPullRequestView['checks'][number];

const statusChecks: Record<string, { status: string; conclusion: string | null }> = {
  succeeded: { status: 'completed', conclusion: 'success' },
  failed: { status: 'completed', conclusion: 'failure' },
  error: { status: 'completed', conclusion: 'error' },
  notApplicable: { status: 'completed', conclusion: 'skipped' },
  pending: { status: 'pending', conclusion: null },
};
const policyChecks: Record<string, { status: string; conclusion: string | null }> = {
  approved: { status: 'completed', conclusion: 'success' },
  rejected: { status: 'completed', conclusion: 'failure' },
  broken: { status: 'completed', conclusion: 'error' },
  notApplicable: { status: 'completed', conclusion: 'skipped' },
  running: { status: 'in_progress', conclusion: null },
  queued: { status: 'queued', conclusion: null },
};
const passed = (check: Check) => check.status === 'completed' && ['success', 'neutral', 'skipped'].includes(check.conclusion ?? '');

async function checks(api: AzureRepositoryApi, pull: Record<string, unknown>, number: number): Promise<Check[]> {
  const where = locate(api);
  const statuses = list((await json(api, versioned(`${where.repository}/pullRequests/${number}/statuses`))).value);
  const latest = new Map<string, Record<string, unknown>>();
  for (const status of statuses) {
    const context = optionalRecord(status.context);
    const key = `${string(context.genre)}/${string(context.name)}`;
    const seen = latest.get(key);
    if (!seen || (integer(status.id) ?? 0) > (integer(seen.id) ?? 0)) latest.set(key, status);
  }
  const found: Check[] = [...latest.entries()].map(([key, status]) => ({
    name: key.replace(/^\//, '').slice(0, 200), ...(statusChecks[string(status.state)] ?? { status: 'queued', conclusion: null }),
  }));
  const projectId = string(optionalRecord(optionalRecord(pull.repository).project).id);
  if (/^[0-9a-fA-F-]{36}$/.test(projectId)) {
    try {
      const artifact = encodeURIComponent(`vstfs:///CodeReview/CodeReviewId/${projectId}/${number}`);
      const evaluations = list((await json(api, `${where.project}/policy/evaluations?artifactId=${artifact}&api-version=7.1-preview.1`)).value);
      for (const evaluation of evaluations) {
        const configuration = optionalRecord(evaluation.configuration);
        if (string(optionalRecord(configuration.type).id).toLowerCase() !== buildPolicy || configuration.isEnabled === false) continue;
        const name = string(optionalRecord(configuration.settings).displayName) || string(optionalRecord(configuration.type).displayName) || 'Build';
        found.push({ name: name.slice(0, 200), ...(policyChecks[string(evaluation.status)] ?? { status: 'queued', conclusion: null }) });
      }
    } catch { }
  }
  return [...found.filter(check => !passed(check)), ...found.filter(passed)].slice(0, listItems);
}

const votes = (pull: Record<string, unknown>) => (Array.isArray(pull.reviewers) ? pull.reviewers : [])
  .map(item => integer(optionalRecord(item).vote) ?? 0);

export async function readAzurePullRequestState(api: AzureRepositoryApi, number: number): Promise<PullRequestState> {
  const pull = await pullRequestDetails(api, number);
  const status = string(pull.status);
  if (status === 'completed') return 'merged';
  if (status === 'abandoned') return 'closed';
  if (pull.isDraft === true) return 'draft';
  if (votes(pull).some(vote => vote < 0)) return 'changes_requested';
  if ((await checks(api, pull, number)).some(check => check.status === 'completed' && !passed(check))) return 'failing';
  return 'open';
}

export async function findAzureBranchPullRequest(api: AzureRepositoryApi, branch: string, since: string): Promise<{ url: string; number: number } | undefined> {
  const ref = `refs/heads/${branch}`;
  const sinceMs = Date.parse(since);
  const search = async (status: string) => list((await json(api, versioned(`${locate(api).repository}/pullrequests?searchCriteria.sourceRefName=${encodeURIComponent(ref)}`
    + `&searchCriteria.status=${status}&$top=10`))).value);
  const pick = (found: Record<string, unknown>[], accept: (created: number, item: Record<string, unknown>) => boolean) => {
    let best: { number: number; created: number } | undefined;
    for (const item of found) {
      const number = integer(item.pullRequestId);
      const created = Date.parse(string(item.creationDate));
      if (number === null || number <= 0 || !accept(created, item) || string(item.sourceRefName) !== ref || item.forkSource) continue;
      if (string(optionalRecord(item.repository).id).toLowerCase() !== api.repositoryId.toLowerCase()) continue;
      if (!best || created > best.created || (created === best.created && number > best.number)) best = { number, created };
    }
    return best && { url: azurePullRequestUrl(api.fullName, best.number), number: best.number };
  };
  const recent = await search('all');
  const found = pick(recent, (created, item) => created >= sinceMs || string(item.status) === 'active');
  if (found || recent.length < 10) return found;
  return pick(await search('active'), (_created, item) => string(item.status) === 'active');
}

const reviewVotes: Record<number, string> = { 10: 'APPROVED', 5: 'APPROVED', [-5]: 'CHANGES_REQUESTED', [-10]: 'REJECTED' };

interface Change { path: string; previousPath?: string; status: PullRequestFileStatus; before?: string; after?: string }

function changes(entries: Record<string, unknown>[]): Change[] {
  return entries.flatMap((entry): Change[] => {
    const item = optionalRecord(entry.item);
    if (item.isFolder === true || item.gitObjectType === 'tree') return [];
    const path = string(item.path).replace(/^\//, '');
    if (!path) return [];
    const kinds = string(entry.changeType).split(',').map(kind => kind.trim());
    const object = (value: unknown) => typeof value === 'string' && sha1.test(value) ? value : undefined;
    const previousPath = string(entry.originalPath ?? entry.sourceServerItem).replace(/^\//, '');
    if (kinds.includes('delete')) return [{ path, status: 'removed', before: object(item.originalObjectId) ?? object(item.objectId) }];
    if (kinds.includes('add')) return [{ path, status: 'added', after: object(item.objectId) }];
    const renamed = kinds.includes('rename') && previousPath && previousPath !== path;
    return [{ path, ...(renamed ? { previousPath } : {}), status: renamed ? 'renamed' : 'modified', before: object(item.originalObjectId), after: object(item.objectId) }];
  });
}

export type AzureFileDiff = (before: string, after: string) => UnifiedPatch;

async function fileViews(api: AzureRepositoryApi, found: Change[], difference: AzureFileDiff): Promise<PullRequestFileView[]> {
  let fetched = 0;
  const blob = async (id: string | undefined): Promise<string | null | undefined> => {
    if (!id) return '';
    if (fetched >= fetchedBlobBytes) return undefined;
    const bytes = await get(api, `${locate(api).repository}/blobs/${id}?$format=octetstream&api-version=7.1`, 'application/octet-stream', pullRequestReviewLimits.patchBytes);
    if (!bytes) return undefined;
    fetched += bytes.byteLength;
    if (bytes.subarray(0, 8000).includes(0)) return null;
    return new TextDecoder('utf-8').decode(bytes);
  };
  const read = async (id: string | undefined): Promise<string | null | undefined> => {
    try { return await blob(id); } catch { return undefined; }
  };
  const contents: ({ before: string; after: string } | 'binary' | 'unread' | 'same')[] = new Array(found.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(blobReads, found.length) }, async () => {
    while (next < found.length) {
      const index = next++;
      const change = found[index]!;
      if (change.before && change.before === change.after) { contents[index] = 'same'; continue; }
      const [before, after] = [await read(change.before), await read(change.after)];
      contents[index] = before === undefined || after === undefined ? 'unread' : before === null || after === null ? 'binary' : { before, after };
    }
  }));
  let held = 0;
  return found.map((change, index): PullRequestFileView => {
    const view: PullRequestFileView = { path: change.path, ...(change.previousPath ? { previousPath: change.previousPath } : {}), status: change.status, additions: 0, deletions: 0 };
    const content = contents[index]!;
    if (content === 'unread') return { ...view, truncated: true };
    if (typeof content === 'string') return view;
    let diff: UnifiedPatch;
    try { diff = difference(content.before, content.after); } catch { return { ...view, truncated: true }; }
    const counted = { ...view, additions: diff.additions, deletions: diff.deletions };
    if (diff.truncated) return { ...counted, truncated: true };
    if (!diff.patch) return counted;
    const size = encoder.encode(diff.patch).length;
    if (size > pullRequestReviewLimits.patchBytes || held + size > pullRequestReviewLimits.totalPatchBytes) return { ...counted, truncated: true };
    held += size;
    const shown = redactPatch(diff.patch);
    return { ...counted, patch: shown, ...(shown !== diff.patch ? { redacted: true as const } : {}) };
  });
}

async function commitListing(api: AzureRepositoryApi, number: number): Promise<{ items: Record<string, unknown>[]; total: number }> {
  const items: Record<string, unknown>[] = [];
  let total = 0;
  const cursor: { token: string | null } = { token: null };
  for (let page = 0; page < commitPages; page++) {
    const continuation = cursor.token ? `&continuationToken=${encodeURIComponent(cursor.token)}` : '';
    cursor.token = null;
    const value = list((await json(api, versioned(`${locate(api).repository}/pullRequests/${number}/commits?$top=${listItems}${continuation}`),
      token => { cursor.token = token; })).value);
    total += value.length;
    items.push(...value.slice(0, Math.max(pullRequestReviewLimits.commits - items.length, 0)));
    if (!cursor.token || !value.length) break;
  }
  return { items, total };
}

function newest<T extends { createdAt: string }>(items: T[]): { items: T[]; omitted: number } {
  const sorted = [...items].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { items: sorted.slice(-listItems), omitted: Math.max(sorted.length - listItems, 0) };
}

export async function readAzurePullRequestReview(api: AzureRepositoryApi, number: number, difference: AzureFileDiff = unifiedPatch): Promise<PullRequestReview> {
  const where = locate(api);
  const url = azurePullRequestUrl(api.fullName, number);
  const pull = await pullRequestDetails(api, number);
  const [commitList, iterations, threads, found] = await Promise.all([
    commitListing(api, number),
    json(api, versioned(`${where.repository}/pullRequests/${number}/iterations`)),
    json(api, versioned(`${where.repository}/pullRequests/${number}/threads`)),
    checks(api, pull, number),
  ]);
  const iteration = Math.max(0, ...list(iterations.value).map(item => integer(item.id) ?? 0));
  const changed = iteration
    ? await json(api, versioned(`${where.repository}/pullRequests/${number}/iterations/${iteration}/changes?$top=${changeEntries}`))
    : { changeEntries: [] };
  const allChanges = changes(list(changed.changeEntries));
  const more = integer(changed.nextTop) ?? 0;
  const files = await fileViews(api, allChanges.slice(0, pullRequestReviewLimits.files), difference);
  const commits = commitList.items.flatMap((item): PullRequestCommitView[] => {
    const sha = string(item.commitId);
    if (!sha1.test(sha)) return [];
    const author = optionalRecord(item.author);
    return [{ sha, message: redactSecrets(string(item.comment)).slice(0, messageCharacters), author: nullableString(author.name), date: string(author.date) }];
  }).reverse();
  const conversation: GitHubCommentView[] = [];
  const reviewComments: GitHubReviewCommentView[] = [];
  const ids = new Map<string, number>();
  for (const thread of list(threads.value)) {
    const threadId = integer(thread.id);
    if (threadId === null || thread.isDeleted === true) continue;
    const context = optionalRecord(thread.threadContext);
    const path = string(context.filePath).replace(/^\//, '');
    const right = integer(optionalRecord(context.rightFileStart).line);
    const left = integer(optionalRecord(context.leftFileStart).line);
    for (const comment of Array.isArray(thread.comments) ? thread.comments.map(optionalRecord) : []) {
      const commentId = integer(comment.id);
      if (commentId === null || comment.isDeleted === true || (comment.commentType !== undefined && comment.commentType !== 'text')) continue;
      const id = ids.size + 1;
      ids.set(`${threadId}/${commentId}`, id);
      const parent = ids.get(`${threadId}/${integer(comment.parentCommentId)}`) ?? null;
      const common = { id, author: person(comment.author), createdAt: string(comment.publishedDate), body: clip(comment.content), url: `${url}?discussionId=${threadId}` };
      if (path) {
        reviewComments.push({ ...common, inReplyTo: parent, path, line: right ?? left, originalLine: left ?? right, commit: '', diffHunk: '' });
      } else conversation.push(common);
    }
  }
  const comments = newest(conversation);
  const inline = newest(reviewComments);
  const reviewers = Array.isArray(pull.reviewers) ? pull.reviewers.map(optionalRecord) : [];
  const reviews = reviewers.flatMap((reviewer, index): GitHubReviewView[] => {
    const state = reviewVotes[integer(reviewer.vote) ?? 0];
    return state ? [{ id: index + 1, author: person(reviewer), state, submittedAt: null, commit: null, body: '', url }] : [];
  });
  const status = string(pull.status);
  const mergeStatus = string(pull.mergeStatus);
  const labels = Array.isArray(pull.labels) ? pull.labels.map(label => string(optionalRecord(label).name)).filter(Boolean) : [];
  const omitted = { ...(comments.omitted ? { comments: comments.omitted } : {}), ...(inline.omitted ? { reviewComments: inline.omitted } : {}) };
  const view: GitHubIssueView = {
    repository: api.fullName, number, url, title: redactSecrets(string(pull.title)), state: status === 'active' ? 'open' : 'closed', author: person(pull.createdBy),
    createdAt: string(pull.creationDate), body: clip(pull.description), labels, comments: comments.items,
    pullRequest: {
      draft: pull.isDraft === true, merged: status === 'completed',
      mergeable: mergeStatus === 'succeeded' ? true : ['conflicts', 'failure', 'rejectedByPolicy'].includes(mergeStatus) ? false : null, mergeableState: mergeStatus,
      head: { ref: branchName(pull.sourceRefName), sha: string(optionalRecord(pull.lastMergeSourceCommit).commitId), repository: api.fullName },
      base: { ref: branchName(pull.targetRefName), sha: string(optionalRecord(pull.lastMergeTargetCommit).commitId) },
      reviews, reviewComments: inline.items, checks: found,
    },
    ...(Object.keys(omitted).length ? { omitted } : {}),
  };
  const fileCount = allChanges.length + more;
  const omittedCounts = { ...(fileCount > files.length ? { files: fileCount - files.length } : {}),
    ...(commitList.total > commitList.items.length ? { commits: commitList.total - commitList.items.length } : {}) };
  return {
    pull: view, additions: files.reduce((sum, file) => sum + file.additions, 0), deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    changedFiles: fileCount, commits, files, ...(Object.keys(omittedCounts).length ? { omitted: omittedCounts } : {}),
  };
}
