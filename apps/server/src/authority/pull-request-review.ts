import { hasPermission } from '../../../../packages/shared/src/policy.js';
import { redactPatch } from '../../../../packages/shared/src/pull-request-review.js';
import { redactSecrets } from '../../../../packages/shared/src/redaction.js';
import {
  pullRequestReviewLimits, type PullRequestCommitView, type PullRequestFileStatus, type PullRequestFileView, type PullRequestReview,
} from '../../../../packages/shared/src/types.js';
import type { AppContext, SessionRow } from '../types.js';
import { fail, identifier } from '../http.js';
import { requireSession } from './access.js';
import { githubGet, ownerGitHub, pinnedGitHubRepository, readIssue, verifyPin } from './github-broker.js';
import { githubPullRequest } from './pull-request-states.js';
import { recheckAccess, type GitHubAccess } from './repositories.js';

const perPage = 100;
const filesPerPage = 30;
const filePageBytes = 12 * 1024 * 1024;
const messageCharacters = 4000;
const encoder = new TextEncoder();

const statuses: Record<string, PullRequestFileStatus> = {
  added: 'added', removed: 'removed', modified: 'modified', renamed: 'renamed', copied: 'copied', changed: 'modified', unchanged: 'modified',
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(502, 'invalid_github_response', 'GitHub returned an unexpected response.');
  return value as Record<string, unknown>;
}
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const count = (value: unknown): number => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0;

async function listing(github: GitHubAccess, path: string, limit: number, size = perPage, bytes?: number): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  for (let page = 1; items.length < limit; page++) {
    const { value } = await githubGet(github, `${path}?per_page=${size}&page=${page}`, bytes);
    if (!Array.isArray(value)) fail(502, 'invalid_github_response', 'GitHub returned an unexpected response.');
    items.push(...value.map(record));
    if (value.length < size) break;
  }
  return items.slice(0, limit);
}

function fileViews(items: Record<string, unknown>[]): PullRequestFileView[] {
  let held = 0;
  return items.flatMap((item): PullRequestFileView[] => {
    const path = string(item.filename);
    if (!path) return [];
    const previousPath = string(item.previous_filename);
    const view: PullRequestFileView = { path, ...(previousPath && previousPath !== path ? { previousPath } : {}),
      status: statuses[string(item.status)] ?? 'modified', additions: count(item.additions), deletions: count(item.deletions) };
    const patch = string(item.patch);
    if (!patch) return [view];
    const size = encoder.encode(patch).length;
    if (size > pullRequestReviewLimits.patchBytes || held + size > pullRequestReviewLimits.totalPatchBytes) return [{ ...view, truncated: true }];
    held += size;
    const shown = redactPatch(patch);
    return [{ ...view, patch: shown, ...(shown !== patch ? { redacted: true as const } : {}) }];
  });
}

function commitViews(items: Record<string, unknown>[]): PullRequestCommitView[] {
  return items.flatMap((item): PullRequestCommitView[] => {
    const sha = string(item.sha);
    if (!/^[0-9a-f]{40}$/.test(sha)) return [];
    const commit = item.commit && typeof item.commit === 'object' ? item.commit as Record<string, unknown> : {};
    const author = commit.author && typeof commit.author === 'object' ? commit.author as Record<string, unknown> : {};
    const account = item.author && typeof item.author === 'object' ? string((item.author as Record<string, unknown>).login) : '';
    return [{ sha, message: redactSecrets(string(commit.message)).slice(0, messageCharacters), author: account || string(author.name) || null, date: string(author.date) }];
  });
}


export async function sessionPullRequestReview(c: AppContext): Promise<Response> {
  const sessionId = identifier(c.req.param('id'));
  const authorize = async (): Promise<SessionRow> => {
    const access = await requireSession(c, sessionId, 'read');
    if (!hasPermission(access.permissions, 'write')) fail(403, 'forbidden', 'Session write permission is required.');
    return access.row;
  };
  const row = await authorize();
  const url = row.pull_request_url ? row.pull_request_url : row.branch_pull_request_url;
  if (!url) fail(404, 'no_pull_request', 'This session has no pull request yet.');
  const pull = githubPullRequest(url);
  if (!pull) fail(409, 'pull_request_unsupported', 'Only github.com pull requests can be reviewed here. Open this one where it is hosted.');
  const pin = await pinnedGitHubRepository(c, row, pull.fullName);
  const github = await ownerGitHub(c.env, row.owner_id);
  await verifyPin(c.env, github, pin);
  const base = `/repos/${pin.fullName}/pulls/${pull.number}`;
  let details: Record<string, unknown> | undefined;
  const [view, files, commits] = await Promise.all([
    readIssue(github, pin.fullName, pull.number, { pullDetails: value => { details = value; }, prepare: redactSecrets, diffHunks: false }),
    listing(github, `${base}/files`, pullRequestReviewLimits.files, filesPerPage, filePageBytes),
    listing(github, `${base}/commits`, pullRequestReviewLimits.commits),
  ]);
  if (!view.pullRequest || !details) fail(404, 'no_pull_request', 'GitHub has no such pull request in this repository.');
  await recheckAccess(c.env, { provider: 'github', github });
  const checked = await authorize();
  if (checked.policy_version !== row.policy_version || checked.owner_id !== row.owner_id) fail(403, 'permission_revoked', 'Session authority changed.');
  const changedFiles = Math.max(count(details.changed_files), files.length);
  const commitCount = Math.max(count(details.commits), commits.length);
  const omitted = { ...(changedFiles > files.length ? { files: changedFiles - files.length } : {}), ...(commitCount > commits.length ? { commits: commitCount - commits.length } : {}) };
  const review: PullRequestReview = {
    pull: { ...view, title: redactSecrets(view.title) }, additions: count(details.additions), deletions: count(details.deletions), changedFiles,
    commits: commitViews(commits), files: fileViews(files), ...(Object.keys(omitted).length ? { omitted } : {}),
  };
  c.header('Cache-Control', 'no-store');
  return c.json({ review });
}
