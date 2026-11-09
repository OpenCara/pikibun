import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { HTTPException } from 'hono/http-exception';
import { parseOperation } from '../apps/server/src/authority/operations.js';
import { openPullRequest, withoutDraftPrefix } from '../apps/server/src/authority/push/targets.js';
import type { RepositoryAccess } from '../apps/server/src/authority/repositories.js';
import { validateOperation } from '../apps/runner/src/protocol.js';
import { pullRequestLine, pushSummary } from '../apps/runner/src/push.js';
import type { GitHubSessionRepository, ProviderSessionRepository } from '../packages/shared/src/repositories.js';

/*
 * Draft pull requests through git_push (PullRequestRequest.draft): opened as drafts, and an open draft marked ready for
 * review, on each forge the broker opens pull requests on.
 */

interface Call { method: string; url: string; body: unknown }
type Route = (call: Call) => Response | undefined;

/** Answers the forge's API from `route`; anything it doesn't answer fails the test. */
function forge(t: TestContext, route: Route): Call[] {
  const calls: Call[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { method: init?.method ?? 'GET', url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const answer = route(call);
    if (!answer) throw new Error(`unexpected ${call.method} ${call.url}`);
    return answer;
  });
  return calls;
}
async function failure(promise: Promise<unknown>): Promise<{ status: number; code: string }> {
  try { await promise; } catch (error) {
    assert.ok(error instanceof HTTPException, String(error));
    return { status: error.status, code: (await error.getResponse().json() as { code: string }).code };
  }
  return assert.fail('expected the call to fail');
}

const github: RepositoryAccess = { provider: 'github', github: { token: 'owner-token', ciphertext: 'c', userId: 'u1', githubId: '1' } };
const githubPin: GitHubSessionRepository = { bindingId: 'b1', repositoryId: 101, fullName: 'owner/repo', ref: 'main', commit: 'a'.repeat(40), path: 'owner/repo' };
const pull = (number: number, draft: boolean) => ({ number, html_url: `https://github.com/owner/repo/pull/${number}`, draft, node_id: `PR_kw${number}` });

test('GitHub: draft: true opens a draft; an open one is left as it is, never turned back into a draft', async t => {
  let open: ReturnType<typeof pull> | undefined;
  const calls = forge(t, call => {
    if (call.method === 'POST' && call.url === 'https://api.github.com/repos/owner/repo/pulls') {
      if (open) return Response.json({ message: 'A pull request already exists' }, { status: 422 });
      open = pull(7, (call.body as { draft?: boolean }).draft === true);
      return Response.json(open, { status: 201 });
    }
    if (call.method === 'GET' && call.url.startsWith('https://api.github.com/repos/owner/repo/pulls?state=open')) return Response.json(open ? [open] : []);
    return undefined;
  });
  const input = { head: 'pikibun/session', base: 'main', title: 'Fix the parser', body: 'Work in progress' };
  assert.deepEqual(await openPullRequest(github, githubPin, { ...input, draft: true }),
    { url: 'https://github.com/owner/repo/pull/7', number: 7, created: true, draft: true });
  assert.deepEqual(calls[0]!.body, { title: 'Fix the parser', head: 'pikibun/session', base: 'main', body: 'Work in progress', draft: true });
  // Pushed again as a draft: found, untouched.
  assert.deepEqual(await openPullRequest(github, githubPin, { ...input, draft: true }),
    { url: 'https://github.com/owner/repo/pull/7', number: 7, created: false, draft: true });
  // A ready one stays ready.
  open = pull(7, false);
  assert.deepEqual(await openPullRequest(github, githubPin, { ...input, draft: true }),
    { url: 'https://github.com/owner/repo/pull/7', number: 7, created: false, draft: false });
  assert.ok(!calls.some(call => call.method === 'PATCH' || call.url.endsWith('/graphql')));
  // Without draft, a new one is opened as before: no draft key at all.
  open = undefined;
  await openPullRequest(github, githubPin, input);
  assert.deepEqual(calls.at(-1)!.body, { title: 'Fix the parser', head: 'pikibun/session', base: 'main', body: 'Work in progress' });
});

test('GitHub: draft: false marks the open draft ready for review, with the approved title and body, through GraphQL', async t => {
  let draft = true;
  let graphqlAnswer: unknown = { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } };
  const calls = forge(t, call => {
    if (call.method === 'POST' && call.url === 'https://api.github.com/repos/owner/repo/pulls') return Response.json({}, { status: 422 });
    if (call.method === 'GET' && call.url.startsWith('https://api.github.com/repos/owner/repo/pulls?state=open')) return Response.json([pull(7, draft)]);
    if (call.method === 'PATCH' && call.url === 'https://api.github.com/repos/owner/repo/pulls/7') return Response.json(pull(7, draft));
    if (call.method === 'POST' && call.url === 'https://api.github.com/graphql') return Response.json(graphqlAnswer);
    return undefined;
  });
  const input = { head: 'pikibun/session', base: 'main', title: 'Fix the parser', body: 'Done: handles empty input.', draft: false };
  assert.deepEqual(await openPullRequest(github, githubPin, input), { url: 'https://github.com/owner/repo/pull/7', number: 7, created: false, draft: false });
  assert.deepEqual(calls.find(call => call.method === 'PATCH')!.body, { title: 'Fix the parser', body: 'Done: handles empty input.' });
  const mutation = calls.find(call => call.url.endsWith('/graphql'))!.body as { query: string; variables: { id: string } };
  assert.match(mutation.query, /markPullRequestReadyForReview/);
  assert.deepEqual(mutation.variables, { id: 'PR_kw7' });

  // Already ready: nothing to change.
  draft = false;
  const before = calls.length;
  assert.equal((await openPullRequest(github, githubPin, input)).draft, false);
  assert.ok(!calls.slice(before).some(call => call.method === 'PATCH' || call.url.endsWith('/graphql')));

  // GraphQL refuses with 200 and errors: the owner can't, so it fails as a permission, never as marked.
  draft = true;
  graphqlAnswer = { errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible' }] };
  assert.deepEqual(await failure(openPullRequest(github, githubPin, input)), { status: 403, code: 'push_permission_required' });
  graphqlAnswer = { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: true } } } };
  assert.deepEqual(await failure(openPullRequest(github, githubPin, input)), { status: 502, code: 'git_provider_unavailable' });
});

test('GitHub: a draft the repository refuses says so, by GitHub\'s message; another 422 with none open is GitHub failing, as before', async t => {
  let refusal = { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', message: 'Draft pull requests are not supported in this repository.' }] };
  const calls = forge(t, call => {
    if (call.method === 'POST' && call.url === 'https://api.github.com/repos/owner/repo/pulls') return Response.json(refusal, { status: 422 });
    if (call.method === 'GET' && call.url.startsWith('https://api.github.com/repos/owner/repo/pulls?state=open')) return Response.json([]);
    return undefined;
  });
  const input = { head: 'pikibun/session', base: 'main', title: 'T', body: '' };
  assert.deepEqual(await failure(openPullRequest(github, githubPin, { ...input, draft: true })), { status: 422, code: 'draft_unsupported' });
  assert.ok(!calls.some(call => call.method === 'GET'), 'no lookup: GitHub said why');
  assert.deepEqual(await failure(openPullRequest(github, githubPin, input)), { status: 502, code: 'git_provider_unavailable' }, 'without a draft, as before');
  refusal = { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', message: 'No commits between main and pikibun/session' }] };
  assert.deepEqual(await failure(openPullRequest(github, githubPin, { ...input, draft: true })), { status: 502, code: 'git_provider_unavailable' },
    'a draft refused for another reason isn\'t called unsupported');
});

test('GitHub Enterprise marks drafts ready through its own GraphQL endpoint', async t => {
  const access: RepositoryAccess = { provider: 'github-enterprise', account: { ciphertext: 'c', userId: 'u1',
    credential: { id: 'a', provider: 'github-enterprise', host: 'git.corp.example', organization: '', username: '', token: 'ghe-token' } } };
  const pin: ProviderSessionRepository = { bindingId: 'b2', provider: 'github-enterprise', host: 'git.corp.example', repositoryId: '9', fullName: 'team/app',
    ref: 'main', commit: 'a'.repeat(40), path: 'git.corp.example/team/app' };
  const item = { number: 3, html_url: 'https://git.corp.example/team/app/pull/3', draft: true, node_id: 'PR_3' };
  const calls = forge(t, call => {
    if (call.method === 'POST' && call.url.endsWith('/api/v3/repos/team/app/pulls')) return Response.json({}, { status: 422 });
    if (call.method === 'GET' && call.url.includes('/api/v3/repos/team/app/pulls?state=open')) return Response.json([item]);
    if (call.method === 'PATCH' && call.url.endsWith('/api/v3/repos/team/app/pulls/3')) return Response.json(item);
    if (call.method === 'POST' && call.url === 'https://git.corp.example/api/graphql') {
      return Response.json({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } });
    }
    return undefined;
  });
  assert.equal((await openPullRequest(access, pin, { head: 'x', base: 'main', title: 'T', body: '', draft: false })).draft, false);
  assert.ok(calls.some(call => call.url === 'https://git.corp.example/api/graphql'));
});

test('GitLab marks drafts by title: Draft: to open one, removed (with the approved title) to make it ready', async t => {
  const access: RepositoryAccess = { provider: 'gitlab', account: { ciphertext: 'c', userId: 'u1',
    credential: { id: 'a', provider: 'gitlab', host: 'gitlab.com', organization: '', username: '', token: 'glpat' } } };
  const pin: ProviderSessionRepository = { bindingId: 'b3', provider: 'gitlab', host: 'gitlab.com', repositoryId: '301', fullName: 'group/project',
    ref: 'main', commit: 'a'.repeat(40), path: 'gitlab.com/group/project' };
  let open: Record<string, unknown> | undefined;
  const calls = forge(t, call => {
    const base = 'https://gitlab.com/api/v4/projects/301/merge_requests';
    if (call.method === 'POST' && call.url === base) {
      if (open) return Response.json({}, { status: 409 });
      const title = (call.body as { title: string }).title;
      open = { iid: 4, web_url: 'https://gitlab.com/group/project/-/merge_requests/4', title, draft: title.startsWith('Draft:') };
      return Response.json(open, { status: 201 });
    }
    if (call.method === 'GET' && call.url.startsWith(`${base}?state=opened`)) return Response.json(open ? [open] : []);
    if (call.method === 'PUT' && call.url === `${base}/4`) {
      const title = (call.body as { title: string }).title;
      open = { ...open, title, draft: title.startsWith('Draft:') };
      return Response.json(open);
    }
    return undefined;
  });
  assert.deepEqual(await openPullRequest(access, pin, { head: 'pikibun/s', base: 'main', title: 'Fix it', body: 'b', draft: true }),
    { url: 'https://gitlab.com/group/project/-/merge_requests/4', number: 4, created: true, draft: true });
  assert.equal((calls[0]!.body as { title: string }).title, 'Draft: Fix it');
  assert.deepEqual(await openPullRequest(access, pin, { head: 'pikibun/s', base: 'main', title: 'Fix the parser', body: 'Finished.', draft: false }),
    { url: 'https://gitlab.com/group/project/-/merge_requests/4', number: 4, created: false, draft: false });
  assert.deepEqual(calls.find(call => call.method === 'PUT')!.body, { title: 'Fix the parser', description: 'Finished.' });
});

test('a forge that still says draft after being made ready fails, rather than the session taking it for ready', async t => {
  const access: RepositoryAccess = { provider: 'gitea', account: { ciphertext: 'c', userId: 'u1',
    credential: { id: 'a', provider: 'gitea', host: 'git.acme.dev', organization: '', username: '', token: 't' } } };
  const pin: ProviderSessionRepository = { bindingId: 'b5', provider: 'gitea', host: 'git.acme.dev', repositoryId: '42', fullName: 'acme/tools',
    ref: 'main', commit: 'a'.repeat(40), path: 'git.acme.dev/acme/tools' };
  // A Gitea whose work-in-progress prefix is its own ("[Do not merge]"): taking ours off leaves it a draft.
  const item = { number: 5, html_url: 'https://git.acme.dev/acme/tools/pulls/5', title: '[Do not merge] T', draft: true };
  const calls = forge(t, call => {
    if (call.method === 'POST' && call.url === 'https://git.acme.dev/api/v1/repos/acme/tools/pulls') return Response.json({}, { status: 409 });
    if (call.method === 'GET' && call.url === 'https://git.acme.dev/api/v1/repos/acme/tools/pulls/main/s') return Response.json(item);
    if (call.method === 'PATCH' && call.url === 'https://git.acme.dev/api/v1/repos/acme/tools/pulls/5') return Response.json(item, { status: 201 });
    return undefined;
  });
  assert.deepEqual(await failure(openPullRequest(access, pin, { head: 's', base: 'main', title: 'T', body: 'B', draft: false })),
    { status: 409, code: 'pull_request_still_draft' });
  assert.deepEqual(calls.find(call => call.method === 'PATCH')!.body, { title: 'T', body: 'B' });
});

test('Azure DevOps opens drafts with isDraft and makes them ready with a PATCH', async t => {
  const access: RepositoryAccess = { provider: 'azure-devops', account: { ciphertext: 'c', userId: 'u1',
    credential: { id: 'a', provider: 'azure-devops', host: 'dev.azure.com', organization: 'contoso', username: '', token: 'pat' } } };
  const repositoryId = '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e';
  const pin: ProviderSessionRepository = { bindingId: 'b4', provider: 'azure-devops', host: 'dev.azure.com', repositoryId, fullName: 'contoso/Project/repo',
    ref: 'main', commit: 'a'.repeat(40), path: 'dev.azure.com/contoso/Project/repo' };
  let draft: boolean | undefined;
  const calls = forge(t, call => {
    const base = `https://dev.azure.com/contoso/Project/_apis/git/repositories/${repositoryId}/pullrequests`;
    if (call.method === 'POST' && call.url === `${base}?api-version=7.1`) {
      if (draft !== undefined) return Response.json({}, { status: 409 });
      draft = (call.body as { isDraft?: boolean }).isDraft === true;
      return Response.json({ pullRequestId: 12, isDraft: draft }, { status: 201 });
    }
    if (call.method === 'GET' && call.url.startsWith(`${base}?searchCriteria`)) return Response.json({ value: [{ pullRequestId: 12, isDraft: draft }] });
    if (call.method === 'PATCH' && call.url === `${base}/12?api-version=7.1`) { draft = false; return Response.json({ pullRequestId: 12, isDraft: false }); }
    return undefined;
  });
  assert.equal((await openPullRequest(access, pin, { head: 's', base: 'main', title: 'T', body: '', draft: true })).draft, true);
  assert.equal((calls[0]!.body as { isDraft?: boolean }).isDraft, true);
  assert.equal((await openPullRequest(access, pin, { head: 's', base: 'main', title: 'T2', body: 'B2', draft: false })).draft, false);
  assert.deepEqual(calls.find(call => call.method === 'PATCH')!.body, { title: 'T2', description: 'B2', isDraft: false });
});

test('draft prefixes come off titles, all of them, but never leave a title empty', () => {
  assert.equal(withoutDraftPrefix('Draft: Fix it'), 'Fix it');
  assert.equal(withoutDraftPrefix('[WIP] draft: Fix it'), 'Fix it');
  assert.equal(withoutDraftPrefix('(Draft) Fix it'), 'Fix it');
  assert.equal(withoutDraftPrefix('Drafting the docs'), 'Drafting the docs');
  assert.equal(withoutDraftPrefix('Draft:'), 'Draft:');
});

test('a push operation takes draft as a boolean, in canonical order, on both sides', () => {
  const operation = { kind: 'git.push', repository: 'owner/repo', directory: 'app', branch: 'pikibun/s', commit: 'a'.repeat(40),
    pullRequest: { title: 'Fix', body: '', draft: true } };
  assert.deepEqual(parseOperation(operation), operation);
  assert.deepEqual(JSON.stringify(parseOperation({ ...operation, pullRequest: { draft: false, base: 'main', body: 'b', title: 'Fix' } })),
    JSON.stringify({ ...operation, pullRequest: { title: 'Fix', body: 'b', base: 'main', draft: false } }), 'title, body, base, draft');
  assert.deepEqual(validateOperation(operation), operation);
  for (const draft of ['yes', 1, null]) {
    assert.throws(() => parseOperation({ ...operation, pullRequest: { title: 'Fix', body: '', draft } }), JSON.stringify(draft));
    assert.throws(() => validateOperation({ ...operation, pullRequest: { title: 'Fix', body: '', draft } }), /Invalid operation/, JSON.stringify(draft));
  }
});

test('the push summary says whether the pull request is a draft only when the push asked', () => {
  const pushed = { outcome: 'pushed' as const, branch: 'pikibun/s', tip: 'c'.repeat(40), previous: 'b'.repeat(40), base: 'a'.repeat(40),
    commits: [{ original: 'c'.repeat(40), rewritten: 'c'.repeat(40), subject: 'Fix' }] };
  const url = 'https://github.com/owner/repo/pull/7';
  assert.equal(pullRequestLine({ url, number: 7, created: true }), `Pull request #7 opened: ${url}`);
  assert.equal(pullRequestLine({ url, number: 7, created: true, draft: true }), `Pull request #7 opened, a draft: ${url}`);
  assert.equal(pullRequestLine({ url, number: 7, created: false, draft: false }), `Pull request #7 already open, ready for review: ${url}`);
  assert.match(pushSummary(pushed as never, { url, number: 7, created: false, draft: false }), /already open, ready for review/);
});
