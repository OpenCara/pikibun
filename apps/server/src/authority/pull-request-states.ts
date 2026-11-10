import type { PullRequestState } from '../../../../packages/shared/src/types.js';
import { boundedJson } from './github-broker.js';
import { now } from '../http.js';
import type { Env } from '../types.js';
import { decryptToken } from './vault.js';

const githubApi = 'https://api.github.com';
const remoteTimeout = 20000;
const pageBytes = 4 * 1024 * 1024;
const perPage = 100;
const maxPages = 5;
const freshMs = 2 * 60_000;
const archivedFreshMs = 30 * 60_000;
const sweepLimit = 25;
const neverStale = '9999-12-31T00:00:00.000Z';

export function githubPullRequest(url: string): { fullName: string; number: number } | undefined {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return undefined; }
  if (parsed.protocol !== 'https:' || parsed.host !== 'github.com') return undefined;
  const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d{1,9})\/?$/.exec(parsed.pathname);
  if (!match) return undefined;
  return { fullName: `${match[1]}/${match[2]}`, number: Number(match[3]) };
}

const failedConclusions = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure']);
const failedStatuses = new Set(['failure', 'error']);

export interface PullRequestFacts {
  state: string;
  merged: boolean;
  draft: boolean;
  reviews: { author: string | null; state: string }[];
  checkRuns: { status: string; conclusion: string | null }[];
  statuses: { state: string }[];
}

export function pullRequestState(facts: PullRequestFacts): PullRequestState {
  if (facts.merged) return 'merged';
  if (facts.state === 'closed') return 'closed';
  if (facts.draft) return 'draft';
  const decisions = new Map<string, string>();
  for (const review of facts.reviews) {
    if (review.author && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) decisions.set(review.author, review.state);
  }
  if ([...decisions.values()].includes('CHANGES_REQUESTED')) return 'changes_requested';
  if (facts.checkRuns.some(run => run.status === 'completed' && failedConclusions.has(run.conclusion ?? ''))) return 'failing';
  if (facts.statuses.some(status => failedStatuses.has(status.state))) return 'failing';
  return 'open';
}

class ReadError extends Error {}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ReadError('unexpected GitHub response');
  return value as Record<string, unknown>;
}
const string = (value: unknown): string => typeof value === 'string' ? value : '';

async function githubGet(token: string, path: string): Promise<unknown> {
  const response = await fetch(`${githubApi}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(remoteTimeout), headers: {
    Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'OpenCara-Agent-Workspace',
  } });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new ReadError(`GitHub answered ${response.status}`);
  }
  return boundedJson(response, pageBytes);
}

async function pages(token: string, path: string, key?: string): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const body = await githubGet(token, `${path}${path.includes('?') ? '&' : '?'}per_page=${perPage}&page=${page}`);
    const list = key === undefined ? body : object(body)[key];
    if (!Array.isArray(list)) throw new ReadError('unexpected GitHub response');
    items.push(...list.map(object));
    if (list.length < perPage) break;
  }
  return items;
}

export async function readPullRequestState(token: string, fullName: string, number: number): Promise<PullRequestState> {
  const base = `/repos/${fullName}`;
  const details = object(await githubGet(token, `${base}/pulls/${number}`));
  const facts: PullRequestFacts = { state: string(details.state), merged: details.merged === true, draft: details.draft === true, reviews: [], checkRuns: [], statuses: [] };
  if (facts.merged || facts.state === 'closed' || facts.draft) return pullRequestState(facts);
  const sha = string(object(details.head).sha);
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new ReadError('unexpected GitHub pull request');
  const [reviews, runs, status] = await Promise.all([
    pages(token, `${base}/pulls/${number}/reviews`),
    pages(token, `${base}/commits/${sha}/check-runs?filter=latest`, 'check_runs'),
    githubGet(token, `${base}/commits/${sha}/status?per_page=${perPage}`),
  ]);
  const statuses = object(status).statuses;
  facts.reviews = reviews.map(review => {
    const user = review.user && typeof review.user === 'object' ? (review.user as Record<string, unknown>).login : null;
    return { author: typeof user === 'string' ? user : null, state: string(review.state) };
  });
  facts.checkRuns = runs.map(run => ({ status: string(run.status), conclusion: typeof run.conclusion === 'string' ? run.conclusion : null }));
  facts.statuses = Array.isArray(statuses) ? statuses.map(item => ({ state: string(object(item).state) })) : [];
  return pullRequestState(facts);
}

export async function findBranchPullRequest(token: string, fullName: string, branch: string, since: string): Promise<{ url: string; number: number } | undefined> {
  const owner = fullName.split('/')[0]!;
  const list = await githubGet(token, `/repos/${fullName}/pulls?state=all&sort=created&direction=desc&per_page=10&head=${encodeURIComponent(`${owner}:${branch}`)}`);
  if (!Array.isArray(list)) throw new ReadError('unexpected GitHub response');
  const sinceMs = Date.parse(since);
  for (const item of list.map(object)) {
    const number = item.number;
    const url = string(item.html_url);
    const created = Date.parse(string(item.created_at));
    if (!Number.isSafeInteger(number) || !(created >= sinceMs)) continue;
    const pull = githubPullRequest(url);
    if (pull && pull.fullName.toLowerCase() === fullName.toLowerCase() && pull.number === number) return { url, number: number as number };
  }
  return undefined;
}

interface StaleRow { id: string; pull_request_url: string; owner_id: string; ciphertext: string }
interface StaleBranchRow { session_id: string; repository: string; branch: string; pull_request_url: string | null; owner_id: string; created_at: string; ciphertext: string }

export async function refreshPullRequestStates(env: Env, limit = sweepLimit): Promise<void> {
  const at = Date.now();
  const rows = await env.DB.query<StaleRow>(`SELECT pc.id, pc.pull_request_url, s.owner_id, t.ciphertext FROM push_credentials pc
    INNER JOIN sessions s ON s.id = pc.session_id
    INNER JOIN users u ON u.id = s.owner_id
    INNER JOIN github_tokens t ON t.user_id = s.owner_id
    WHERE pc.pull_request_url LIKE 'https://github.com/%' AND u.auth_kind = 'github' AND u.suspended_at IS NULL
      AND pc.id = (SELECT pr.id FROM push_credentials pr WHERE pr.session_id = pc.session_id AND pr.pull_request_url IS NOT NULL
        ORDER BY pr.completed_at DESC, pr.created_at DESC, pr.id DESC LIMIT 1)
      AND (pc.pull_request_state IS NULL OR pc.pull_request_state NOT IN ('merged', 'closed'))
      AND (pc.pull_request_checked_at IS NULL OR pc.pull_request_checked_at < CASE WHEN s.status = 'archived' THEN ? ELSE ? END)
    ORDER BY (pc.pull_request_checked_at IS NOT NULL), pc.pull_request_checked_at, pc.id LIMIT ?`)
    .bind(new Date(at - archivedFreshMs).toISOString(), new Date(at - freshMs).toISOString(), limit).all();
  for (const row of rows) {
    const pull = githubPullRequest(row.pull_request_url);
    let state: PullRequestState | null = null;
    if (pull) {
      try {
        state = await readPullRequestState(await decryptToken(env, row.owner_id, row.ciphertext), pull.fullName, pull.number);
      } catch { }
    }
    await env.DB.query('UPDATE push_credentials SET pull_request_state = COALESCE(?, pull_request_state), pull_request_checked_at = ? WHERE id = ?')
      .bind(state, pull ? now() : neverStale, row.id).run();
  }
  await refreshBranchPullRequests(env, at, limit);
}

async function refreshBranchPullRequests(env: Env, at: number, limit: number): Promise<void> {
  const rows = await env.DB.query<StaleBranchRow>(`SELECT b.session_id, b.repository, b.branch, b.pull_request_url, s.owner_id, s.created_at, t.ciphertext
    FROM session_branches b
    INNER JOIN sessions s ON s.id = b.session_id
    INNER JOIN users u ON u.id = s.owner_id
    INNER JOIN github_tokens t ON t.user_id = s.owner_id
    WHERE u.auth_kind = 'github' AND u.suspended_at IS NULL
      AND (b.pull_request_state IS NULL OR b.pull_request_state NOT IN ('merged', 'closed'))
      AND (b.pull_request_url IS NOT NULL OR s.status <> 'archived')
      AND (b.pull_request_checked_at IS NULL OR b.pull_request_checked_at < CASE WHEN s.status = 'archived' THEN ? ELSE ? END)
    ORDER BY (b.pull_request_checked_at IS NOT NULL), b.pull_request_checked_at, b.session_id, b.repository, b.branch LIMIT ?`)
    .bind(new Date(at - archivedFreshMs).toISOString(), new Date(at - freshMs).toISOString(), limit).all();
  for (const row of rows) {
    let found: { url: string; number: number } | undefined;
    let state: PullRequestState | null = null;
    try {
      const token = await decryptToken(env, row.owner_id, row.ciphertext);
      found = await findBranchPullRequest(token, row.repository, row.branch, row.created_at);
      if (found) state = await readPullRequestState(token, row.repository, found.number);
    } catch { }
    const checkedAt = now();
    if (found && found.url !== row.pull_request_url) {
      await env.DB.query(`UPDATE session_branches SET pull_request_url = ?, pull_request_state = ?, pull_request_found_at = ?, pull_request_checked_at = ?
        WHERE session_id = ? AND repository = ? AND branch = ?`).bind(found.url, state, checkedAt, checkedAt, row.session_id, row.repository, row.branch).run();
    } else {
      await env.DB.query(`UPDATE session_branches SET pull_request_state = COALESCE(?, pull_request_state), pull_request_checked_at = ?
        WHERE session_id = ? AND repository = ? AND branch = ?`).bind(state, checkedAt, row.session_id, row.repository, row.branch).run();
    }
  }
}
