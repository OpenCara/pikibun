import assert from 'node:assert/strict';
import test from 'node:test';
import { HTTPException } from 'hono/http-exception';
import { forgetGitHubReads, recallRead, rememberRead } from '../apps/server/src/authority/github-reads.js';
import { readPullRequestState } from '../apps/server/src/authority/pull-request-states.js';
import { verifyRepository } from '../apps/server/src/authority/repositories.js';
import { GH_WATCH_INTERVAL_SECONDS, ghSpec, watchInterval } from '../apps/runner/src/extensions/piki/gh.js';

const sha = 'c'.repeat(40);
const api = 'https://api.github.com/repos/acme/app';

function github(t: test.TestContext, routes: Record<string, (tag: string | null) => Response>) {
  const calls: { url: string; tag: string | null; authorization: string | null }[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, tag: headers.get('if-none-match'), authorization: headers.get('authorization') });
    const route = routes[url];
    assert.ok(route, `unexpected GitHub call ${url}`);
    return route(headers.get('if-none-match'));
  });
  t.after(forgetGitHubReads);
  return calls;
}

const tagged = (etag: string, body: unknown) => (tag: string | null) => tag === etag ? new Response(null, { status: 304, headers: { etag } })
  : Response.json(body, { headers: { etag } });

test('a read GitHub answers 304 for is answered from the remembered body, which costs none of the rate limit', async t => {
  const calls = github(t, {
    [`${api}/pulls/5`]: tagged('"p1"', { state: 'open', merged: false, draft: false, head: { sha } }),
    [`${api}/pulls/5/reviews?per_page=100&page=1`]: tagged('W/"r1"', [{ user: { login: 'reviewer' }, state: 'APPROVED' }]),
    [`${api}/commits/${sha}/check-runs?filter=latest&per_page=100&page=1`]: tagged('"c1"', { check_runs: [{ status: 'completed', conclusion: 'failure' }] }),
    [`${api}/commits/${sha}/status?per_page=100`]: tagged('"s1"', { statuses: [] }),
  });
  assert.equal(await readPullRequestState('gho_one', 'acme/app', 5), 'failing');
  assert.deepEqual(calls.map(call => call.tag), [null, null, null, null]);
  assert.equal(await readPullRequestState('gho_one', 'acme/app', 5), 'failing');
  assert.deepEqual(calls.slice(4).map(call => call.tag).toSorted(), ['"c1"', '"p1"', '"s1"', 'W/"r1"']);

  await readPullRequestState('gho_two', 'acme/app', 5);
  assert.deepEqual(calls.slice(8).map(call => call.tag), [null, null, null, null], 'another token never gets the first one\'s answers');
});

test('a changed or refused read replaces or forgets what was remembered', async t => {
  let answer: (tag: string | null) => Response = tagged('"a"', { id: 7, full_name: 'acme/app', default_branch: 'main', private: true });
  const calls = github(t, { [api]: tag => answer(tag) });
  const access = { provider: 'github' as const, github: { token: 'gho_owner', ciphertext: 'x', userId: 'u', githubId: '1' } };
  const expected = { repositoryId: '7', fullName: 'acme/app' };
  assert.equal((await verifyRepository(access, expected)).defaultBranch, 'main');
  assert.equal((await verifyRepository(access, expected)).defaultBranch, 'main');
  assert.deepEqual(calls.map(call => call.tag), [null, '"a"']);

  answer = tagged('"b"', { id: 7, full_name: 'acme/app', default_branch: 'trunk', private: true });
  assert.equal((await verifyRepository(access, expected)).defaultBranch, 'trunk');
  assert.equal(recallRead('gho_owner', api)?.etag, '"b"');

  answer = () => Response.json({ message: 'API rate limit exceeded' }, { status: 403, headers: { 'x-ratelimit-remaining': '0' } });
  await assert.rejects(verifyRepository(access, expected), (error: unknown) => error instanceof HTTPException && error.status === 429);
  assert.equal(recallRead('gho_owner', api), undefined);
  answer = () => Response.json({ message: 'You have exceeded a secondary rate limit' }, { status: 403, headers: { 'retry-after': '60' } });
  await assert.rejects(verifyRepository(access, expected), (error: unknown) => error instanceof HTTPException && error.status === 429);
  answer = () => Response.json({ message: 'Not Found' }, { status: 404 });
  await assert.rejects(verifyRepository(access, expected), (error: unknown) => error instanceof HTTPException && error.status === 403);
});

test('only well-formed tags and bounded bodies are remembered, the least recently used going first', t => {
  t.after(forgetGitHubReads);
  const response = (etag: string | null) => new Response(null, { headers: etag ? { etag } : {} });
  rememberRead('t', 'https://api.github.com/a', response(null), new Uint8Array(1));
  rememberRead('t', 'https://api.github.com/b', response('unquoted'), new Uint8Array(1));
  rememberRead('t', 'https://api.github.com/c', response('"big"'), new Uint8Array(4 * 1024 * 1024 + 1));
  for (const path of ['a', 'b', 'c']) assert.equal(recallRead('t', `https://api.github.com/${path}`), undefined, path);
  for (let index = 0; index < 1001; index++) rememberRead('t', `https://api.github.com/${index}`, response(`"${index}"`), new Uint8Array(1));
  assert.equal(recallRead('t', 'https://api.github.com/0'), undefined);
  assert.equal(recallRead('t', 'https://api.github.com/1000')?.etag, '"1000"');
});

test('gh watches read again every 30 seconds unless they name their own interval', () => {
  const interval = ['--interval', String(GH_WATCH_INTERVAL_SECONDS)];
  assert.equal(GH_WATCH_INTERVAL_SECONDS, 30);
  assert.deepEqual(watchInterval(['run', 'watch', '42', '--repo', 'acme/app']), ['run', 'watch', '42', '--repo', 'acme/app', ...interval]);
  assert.deepEqual(watchInterval(['pr', 'checks', '5', '--watch']), ['pr', 'checks', '5', '--watch', ...interval]);
  assert.deepEqual(watchInterval(['run', 'watch', '42', '--', 'x']), ['run', 'watch', '42', ...interval, '--', 'x']);
  for (const args of [['pr', 'checks', '5'], ['run', 'view', '42'], ['run', 'watch', '42', '-i', '5'], ['run', 'watch', '42', '--interval=60'],
    ['pr', 'checks', '5', '--watch', '--interval', '15']]) {
    assert.deepEqual(watchInterval(args), args, args.join(' '));
  }
  assert.equal(ghSpec.prepare, watchInterval);
  assert.match(ghSpec.description, /every 30 seconds unless it names its own --interval/);
});
