import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import type { AssistantMessage, Context, Usage } from '@earendil-works/pi-ai';
import type { UsageState } from '@earendil-works/pi-durable';
import { app } from '../apps/server/src/index.js';
import type { ConnectorRelayEnvelope } from '../apps/server/src/connector-transport.js';
import { sessionNamings } from '../apps/server/src/session-titles.js';
import type { Env } from '../apps/server/src/types.js';
import { addTitleUsage, titleRequestInput, writeTitle, type TitleModels } from '../apps/runner/src/session/titles.js';
import type { ConnectorCredentials, ConnectorPairing } from '../packages/shared/src/connector.js';
import { sha256 } from '../packages/shared/src/crypto.js';
import { cleanTitle, fallbackTitle, namesSession, sessionTitleLimits, sessionTitleRequest } from '../packages/shared/src/session-titles.js';
import type { ModelDefinition, SessionRecord, Workspace } from '../packages/shared/src/types.js';
import { fakeHub, testDatabase } from './helpers/control-plane.js';

test('the fallback title is the first message on one line, cut at a word near 50 characters', () => {
  assert.equal(fallbackTitle('  fix:\n\n the flaky   login test  '), 'fix: the flaky login test');
  assert.equal(fallbackTitle('1. replace host setting button on the left sidebar to server switch'), '1. replace host setting button on the left…');
  assert.equal(fallbackTitle('x'.repeat(80)), `${'x'.repeat(50)}…`);
  assert.equal(fallbackTitle('修'.repeat(60)), `${'修'.repeat(50)}…`);
  assert.equal(fallbackTitle('tab\there\u0000and\u007fthere'), 'tab here and there');
  assert.equal(fallbackTitle(' \n '), '');
});

test('only a message with text that is not a slash command names a session', () => {
  for (const content of ['fix the login test', ' /usr/bin is missing', '/ alone', 'see /compact']) assert.ok(namesSession(content), content);
  for (const content of ['', ' \n ', '/compact', '/name Login fix', '/pr-flow:status now']) assert.ok(!namesSession(content), content);
});

test('a model\'s reply is cleaned to its title: no labels, quotes, marks or final period', () => {
  for (const [reply, title] of [
    ['Fix flaky login test', 'Fix flaky login test'], ['"Fix flaky login test."', 'Fix flaky login test'], ['**Title:** Fix login', 'Fix login'],
    ['# Server switch in the sidebar', 'Server switch in the sidebar'], ['\n\n  «Réparer la connexion»。\nmore', 'Réparer la connexion'],
    ['Title: `"Nested quotes"`', 'Nested quotes'], ['「ログイン修正」', 'ログイン修正'], ['...', ''], ['', ''],
  ] as const) assert.equal(cleanTitle(reply), title, reply);
  assert.ok(cleanTitle('word '.repeat(30)).length <= sessionTitleLimits.length + 1);
});

test('the title request asks for six words and carries at most the start of the message', () => {
  const request = sessionTitleRequest(`  ${'a'.repeat(5000)}  `);
  assert.match(request.system, /at most six words/);
  assert.ok(request.message.includes(`<message>\n${'a'.repeat(sessionTitleLimits.prompt)}\n</message>`));
  assert.ok(!request.message.includes('a'.repeat(sessionTitleLimits.prompt + 1)));
  assert.deepEqual(titleRequestInput(request), request);
  for (const invalid of [null, [], {}, { system: '', message: 'm' }, { system: 's', message: ' ' }, { system: 's', message: 'm', model: 'x' },
    { system: 's'.repeat(sessionTitleLimits.system + 1), message: 'm' }, { system: 's', message: 'm'.repeat(sessionTitleLimits.message + 1) }, { system: 1, message: 'm' }]) {
    assert.equal(titleRequestInput(invalid), undefined, JSON.stringify(invalid).slice(0, 60));
  }
});

const usage = (input: number, output: number, cost: number): Usage => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
  cost: { input: cost, output: cost, cacheRead: 0, cacheWrite: 0, total: 2 * cost } });

function fakeModels(reply: Partial<AssistantMessage> | Error, reasoning = false) {
  const calls: { model: string; context: Context; options: Record<string, unknown> }[] = [];
  const models: TitleModels = {
    getModel: ((provider: string, id: string) => (provider === 'p' && id === 'm' ? { provider, id, reasoning } : undefined)) as never,
    completeSimple: (async (model: { id: string }, context: Context, options: Record<string, unknown>) => {
      calls.push({ model: model.id, context, options });
      if (reply instanceof Error) throw reply;
      return { role: 'assistant', content: [], stopReason: 'stop', provider: 'p', model: 'm', ...reply } as AssistantMessage;
    }) as never,
  };
  return { models, calls };
}

test('the host asks the session\'s model once, without reasoning or a cache, and returns its text with its usage', async () => {
  const request = sessionTitleRequest('Fix the flaky login test');
  const { models, calls } = fakeModels({ content: [{ type: 'text', text: 'Fix flaky ' }, { type: 'text', text: 'login test' }], usage: usage(10, 5, 0.01) });
  const reply = await writeTitle(models, { provider: 'p', modelId: 'm' }, request, new AbortController().signal);
  assert.deepEqual(reply, { text: 'Fix flaky login test', usage: { key: 'p/m', usage: usage(10, 5, 0.01) } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.context.systemPrompt, request.system);
  assert.deepEqual(calls[0]!.context.messages.map(message => message.content), [request.message]);
  assert.deepEqual([calls[0]!.options.maxRetries, calls[0]!.options.cacheRetention, calls[0]!.options.reasoning], [0, 'none', undefined]);
  const thinking = fakeModels({ content: [{ type: 'text', text: 'x' }] }, true);
  await writeTitle(thinking.models, { provider: 'p', modelId: 'm' }, request, new AbortController().signal);
  assert.equal(thinking.calls[0]!.options.reasoning, undefined, 'a reasoning model is asked with reasoning off');
  const failed = fakeModels({ content: [{ type: 'text', text: 'partial' }], stopReason: 'error', usage: usage(3, 0, 0.001) });
  assert.deepEqual(await writeTitle(failed.models, { provider: 'p', modelId: 'm' }, request, new AbortController().signal),
    { text: '', usage: { key: 'p/m', usage: usage(3, 0, 0.001) } }, 'a failed answer names nothing, and still counts');
  assert.deepEqual(await writeTitle(models, { provider: 'p', modelId: 'gone' }, request, new AbortController().signal), { text: '' });
  assert.equal(calls.length, 1, 'a model the host no longer has is not asked');
});

test('a title\'s usage adds to the conversation\'s usage of its model', () => {
  const totals: UsageState['models'] = {};
  addTitleUsage(totals, 'p/m', usage(10, 5, 0.01));
  addTitleUsage(totals, 'p/m', { ...usage(1, 1, 0.5), reasoning: 4 });
  addTitleUsage(totals, 'p/m', { ...usage(1, 3, 0), imageOutput: 2 });
  addTitleUsage(totals, 'p/m', { ...usage(0, 2, 0), imageOutput: 1 });
  addTitleUsage(totals, 'q/n', usage(2, 2, 0));
  assert.deepEqual(totals['p/m'], { ...usage(12, 11, 0.51), reasoning: 4, imageOutput: 3 });
  assert.deepEqual(totals['q/n'], usage(2, 2, 0));
});

const origin = 'http://localhost:8787';
const testSecret = 'session-titles-test-secret-not-for-deployment';
const manifest = (titles: boolean) => ({
  models: [{ provider: 'local-native', modelId: 'local/model-v1', name: 'Local model' }],
  capabilities: { platform: 'linux', sandbox: true, productionShell: false, approvalFree: true, plainGit: true, hostConfig: true, ...(titles ? { sessionTitles: true } : {}) },
});
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  return body as T;
}

type TitleAnswer = (body: { system: string; message: string }, sessionId: string) => Response | Promise<Response>;

async function fixture(t: TestContext, { titles = true }: { titles?: boolean } = {}) {
  const { db, sqlite } = await testDatabase();
  t.after(() => db.close());
  const asked: { sessionId: string; actorId: string; body: { system: string; message: string } }[] = [];
  let answer: TitleAnswer = () => Response.json({ text: 'Fix flaky login test.' });
  let submissions = 0;
  const env: Env = { DB: db, APP_ORIGIN: origin, TEST_AUTH_ENABLED: 'true', TEST_AUTH_SECRET: testSecret,
    TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(), VAULT_KEY: Buffer.alloc(32, 9).toString('base64url'),
    CONNECTOR_HUB: fakeHub({ rpc: async (_id, envelope: ConnectorRelayEnvelope) => {
      const { ticket, body, path } = envelope.request;
      if (ticket.action === 'create') return Response.json({ ok: true }, { status: 201 });
      if (ticket.action === 'submit') return Response.json({ submissionId: `sub-${++submissions}`, conversationId: '0', status: 'queued' });
      if (ticket.action === 'title') {
        assert.equal(path, `/v1/sessions/${ticket.sessionId}/title`);
        const parsed = JSON.parse(body) as { system: string; message: string };
        asked.push({ sessionId: ticket.sessionId, actorId: ticket.actorId, body: parsed });
        return answer(parsed, ticket.sessionId);
      }
      return Response.json({ error: 'Unsupported test relay request' }, { status: 503 });
    } }) };
  const request = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => Promise.resolve(app.request(path, { method,
    headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) }, env));
  const login = await request('POST', '/api/auth/test', { id: 'alice', displayName: 'alice', gitName: 'alice', gitEmail: 'alice@example.test' }, { Authorization: `Bearer ${testSecret}` });
  const { user } = await json<{ user: { id: string } }>(login);
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const { csrfToken } = await json<{ csrfToken: string }>(await request('GET', '/api/auth/csrf', undefined, { Cookie: cookie }));
  const alice = (method: string, path: string, body?: unknown) => request(method, path, body, { Cookie: cookie, 'X-CSRF-Token': csrfToken });
  const personal = (await json<{ workspaces: Workspace[] }>(await alice('GET', '/api/workspaces'))).workspaces.find(item => item.personal)!;
  const { pairing } = await json<{ pairing: ConnectorPairing }>(await alice('POST', '/api/connectors/pairings', { name: 'Local Pi', workspaceId: personal.id }), 201);
  const { credentials } = await json<{ credentials: ConnectorCredentials }>(await request('POST', `/api/connectors/pairings/${pairing.id}/claim`, { code: pairing.code, ...manifest(titles) }), 201);
  sqlite.prepare('UPDATE connectors SET connection_hash = ? WHERE id = ?').run(await sha256(b64(randomBytes(32))), credentials.connectorId);
  const { models } = await json<{ models: ModelDefinition[] }>(await alice('GET', `/api/workspaces/${personal.id}/models`));
  const start = async (body: Record<string, unknown>) =>
    (await json<{ session: SessionRecord }>(await alice('POST', '/api/sessions', { workspaceId: personal.id, modelId: models[0]!.id, ...body }), 201)).session;
  let requests = 0;
  const submit = async (sessionId: string, content: string) => {
    await json(await alice('POST', `/api/sessions/${sessionId}/submit`, { content, requestId: `request-${++requests}` }), 202);
    await sessionNamings();
  };
  const title = async (sessionId: string) => (await json<{ session: SessionRecord }>(await alice('GET', `/api/sessions/${sessionId}`))).session.title;
  const audit = (sessionId: string) => sqlite.prepare("SELECT actor_id FROM audit WHERE session_id = ? AND action = 'session.titled'").all(sessionId) as { actor_id: string }[];
  return { alice, user, workspaceId: personal.id, start, submit, title, asked, audit, models, answer: (next: TitleAnswer) => { answer = next; } };
}

const message = 'fix the flaky login test in CI: it fails on every second run with a timeout';

test('a person\'s first message names the session with the host\'s model, and later messages leave its title alone', async t => {
  const f = await fixture(t);
  const session = await f.start({ title: fallbackTitle(message), generateTitle: true });
  assert.equal(session.title, 'fix the flaky login test in CI: it fails on every…');
  await f.submit(session.id, message);
  assert.equal(await f.title(session.id), 'Fix flaky login test');
  assert.equal(f.asked.length, 1);
  assert.deepEqual(f.asked[0]!.body, sessionTitleRequest(message));
  assert.equal(f.asked[0]!.actorId, f.user.id, 'the host is asked for the person who wrote the message');
  assert.deepEqual(f.audit(session.id).map(event => event.actor_id), [f.user.id], 'the audit log says who sent the message that named it, not the title');
  await f.submit(session.id, 'and now the logout test');
  assert.equal(f.asked.length, 1, 'only the first message names it');
  assert.equal(await f.title(session.id), 'Fix flaky login test');
});

test('a session started without a message takes its first message as its fallback at once, and keeps it when naming fails', async t => {
  const f = await fixture(t);
  const session = await f.start({ title: f.models[0]!.name, generateTitle: true });
  f.answer(() => Response.json({ error: 'model failed' }, { status: 503 }));
  await f.submit(session.id, 'investigate errors:\n  TypeError in the session panel');
  assert.equal(await f.title(session.id), 'investigate errors: TypeError in the session panel');
  assert.equal(f.asked.length, 1);
  const empty = await f.start({ title: 'Local model', generateTitle: true });
  f.answer(() => Response.json({ text: '' }));
  await f.submit(empty.id, 'fix:');
  assert.equal(await f.title(empty.id), 'fix:', 'an empty answer leaves the fallback');
  await f.submit(empty.id, 'the login test');
  assert.equal(f.asked.length, 2, 'no retry follows a failure');
  const later = await f.start({ title: 'Local model', generateTitle: true });
  f.answer(() => Response.json({ text: 'Login test fix' }));
  await f.submit(later.id, '/compact');
  assert.equal(await f.title(later.id), 'Local model', 'a slash command names nothing');
  await f.submit(later.id, 'fix the login test');
  assert.equal(await f.title(later.id), 'Login test fix', 'the first message with words names it');
  assert.equal(f.asked.length, 3);
});

test('a rename while the model works wins over its title', async t => {
  const f = await fixture(t);
  const session = await f.start({ title: fallbackTitle(message), generateTitle: true });
  f.answer(async () => {
    await json(await f.alice('PATCH', `/api/sessions/${session.id}`, { title: 'Login flake' }));
    return Response.json({ text: 'Fix flaky login test' });
  });
  await f.submit(session.id, message);
  assert.equal(await f.title(session.id), 'Login flake');
  assert.deepEqual(f.audit(session.id), []);
  const renamedFirst = await f.start({ title: 'Local model', generateTitle: true });
  await json(await f.alice('PATCH', `/api/sessions/${renamedFirst.id}`, { title: 'My own title' }));
  await f.submit(renamedFirst.id, message);
  assert.equal(await f.title(renamedFirst.id), 'My own title', 'a session renamed before its first message keeps its name');
  assert.equal(f.asked.length, 1);
});

test('a session started with a title of its own keeps it, and a host without titles keeps the fallback', async t => {
  const f = await fixture(t);
  const explicit = await f.start({ title: 'Release checklist' });
  await f.submit(explicit.id, message);
  assert.equal(await f.title(explicit.id), 'Release checklist');
  assert.equal(f.asked.length, 0);
  assert.equal((await f.alice('POST', '/api/sessions', { workspaceId: f.workspaceId, modelId: f.models[0]!.id, title: 'x', generateTitle: 'yes' })).status, 400);
  const old = await fixture(t, { titles: false });
  const session = await old.start({ title: 'Local model', generateTitle: true });
  await old.submit(session.id, message);
  assert.equal(await old.title(session.id), fallbackTitle(message));
  assert.equal(old.asked.length, 0, 'a host whose connector predates titles is not asked');
});
