import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { HTTPException } from 'hono/http-exception';
import { app } from '../apps/server/src/index.js';
import { ADMISSION_RENEWAL_MAX_SECONDS, requireAdmission } from '../apps/server/src/authority/run-admissions.js';
import type { Env } from '../apps/server/src/types.js';
import { seedAgentVersion, testDatabase } from './helpers/control-plane.js';

const origin = 'http://localhost:8787';
const testSecret = 'run-admissions-test-secret-not-for-deployment';
const refusal = { code: 'tool_not_admitted', message: 'This tool needs a message that is still admitted.' };

async function fixture(t: TestContext) {
  const { db, sqlite } = await testDatabase();
  t.after(() => db.close());
  const env: Env = { DB: db, APP_ORIGIN: origin, TEST_AUTH_ENABLED: 'true', TEST_AUTH_SECRET: testSecret,
    TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(), RUNNER_SHARED_SECRET: 'run-admissions-internal-secret-0123456789',
    VAULT_KEY: Buffer.alloc(32, 7).toString('base64url'), RUNNER_URL: 'https://runner.example.test' };
  async function client(name: string) {
    const login = await app.request('/api/auth/test', { method: 'POST', headers: { Origin: origin, Authorization: `Bearer ${testSecret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: name, displayName: name, gitName: name, gitEmail: `${name}@example.test` }) }, env);
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const user = (await login.json() as { user: { id: string } }).user;
    const csrf = (await (await app.request('/api/auth/csrf', { headers: { Cookie: cookie } }, env)).json() as { csrfToken: string }).csrfToken;
    return { user, async request(method: string, path: string, body?: unknown) {
      return app.request(path, { method, headers: { Cookie: cookie, Origin: origin, 'x-csrf-token': csrf,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
    } };
  }
  const owner = await client('admission-owner');
  const other = await client('admission-other');
  const workspace = (await (await owner.request('POST', '/api/workspaces', { name: 'admissions' })).json() as { workspace: { id: string } }).workspace;
  const model = (await (await owner.request('POST', `/api/workspaces/${workspace.id}/models`, { name: 'faux', provider: 'faux', modelId: 'faux-1' })).json() as { model: { id: string } }).model;
  const agent = seedAgentVersion(sqlite, { authorId: owner.user.id, modelId: model.id, tools: ['identity'] });
  for (const id of ['session-a', 'session-b']) {
    sqlite.prepare("INSERT INTO sessions (id,workspace_id,owner_id,agent_version_id,title,status,created_at,visibility,repository_mode) VALUES (?,?,?,?,?,?,?,'workspace','clone')")
      .run(id, workspace.id, owner.user.id, agent.id, id, 'ready', '2026-01-01T00:00:00.000Z');
  }
  const admit = (options: { sessionId?: string; actorId?: string; mode?: string; access?: string | null; expiresIn?: number; createdAt?: string } = {}) => {
    const admissionId = randomBytes(32).toString('base64url');
    sqlite.prepare('INSERT INTO run_admissions (id,session_id,actor_id,mode,access,auto_merge,request_id,content_hash,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(admissionId, options.sessionId ?? 'session-a', options.actorId ?? owner.user.id, options.mode ?? 'write', options.access ?? null, 0, `request-${admissionId}`,
        'h'.repeat(43), Math.floor(Date.now() / 1000) + (options.expiresIn ?? 3600), options.createdAt ?? new Date().toISOString());
    return admissionId;
  };
  const refused = async (call: Promise<unknown>) => {
    await assert.rejects(call, (error: unknown) => {
      assert.ok(error instanceof HTTPException);
      assert.equal(error.status, 403);
      return true;
    });
    const response = await call.then(() => undefined, (error: HTTPException) => error.getResponse());
    assert.deepEqual(await response!.json(), { error: refusal.message, code: refusal.code });
  };
  return { env, sqlite, owner, other, admit, refused };
}

test('requireAdmission returns the admission of the session and sender it was issued to, and refuses any other with the caller\'s own code', async t => {
  const f = await fixture(t);
  const ownerId = f.owner.user.id;
  const admissionId = f.admit();
  const call = { admissionId, sessionId: 'session-a', actorId: ownerId };
  const admission = await requireAdmission(f.env, call, refusal);
  assert.deepEqual({ ...admission, expires_at: 0 }, { id: admissionId, session_id: 'session-a', actor_id: ownerId, mode: 'write', access: null,
    request_id: `request-${admissionId}`, expires_at: 0 });
  assert.equal((await requireAdmission(f.env, call, refusal, { acting: true })).id, admissionId);

  await f.refused(requireAdmission(f.env, { ...call, admissionId: 'x'.repeat(43) }, refusal));
  await f.refused(requireAdmission(f.env, { ...call, sessionId: 'session-b' }, refusal));
  await f.refused(requireAdmission(f.env, { ...call, actorId: f.other.user.id }, refusal));
  await f.refused(requireAdmission(f.env, { ...call, admissionId: f.admit({ mode: 'ask' }) }, refusal));
});

test('requireAdmission lets a Read-only message through unless the caller acts, and reports its access', async t => {
  const f = await fixture(t);
  const call = { admissionId: f.admit({ access: 'read' }), sessionId: 'session-a', actorId: f.owner.user.id };
  assert.equal((await requireAdmission(f.env, call, refusal)).access, 'read');
  assert.equal((await requireAdmission(f.env, call, refusal, { acting: false })).access, 'read');
  await f.refused(requireAdmission(f.env, call, refusal, { acting: true }));
  const auto = { ...call, admissionId: f.admit({ access: 'auto' }) };
  assert.equal((await requireAdmission(f.env, auto, refusal, { acting: true })).access, 'auto');
});

test('requireAdmission ends with the hour, unless the message\'s run is still going, and ends for good at the renewal limit', async t => {
  const f = await fixture(t);
  const ownerId = f.owner.user.id;
  const call = { admissionId: f.admit({ expiresIn: -60 }), sessionId: 'session-a', actorId: ownerId };
  await f.refused(requireAdmission(f.env, call, refusal));
  f.sqlite.prepare("UPDATE sessions SET activity = 'working', activity_ended_at = NULL WHERE id = 'session-a'").run();
  assert.equal((await requireAdmission(f.env, call, refusal)).id, call.admissionId, 'the run it started is still going');
  const newer = f.admit({ createdAt: new Date(Date.now() + 1000).toISOString() });
  await f.refused(requireAdmission(f.env, call, refusal));
  assert.equal((await requireAdmission(f.env, { ...call, admissionId: newer }, refusal)).id, newer, 'a later message took the run over');
  f.sqlite.prepare("UPDATE sessions SET activity = 'working', activity_ended_at = NULL WHERE id = 'session-b'").run();
  const old = f.admit({ sessionId: 'session-b', expiresIn: 3600 - ADMISSION_RENEWAL_MAX_SECONDS });
  await f.refused(requireAdmission(f.env, { admissionId: old, sessionId: 'session-b', actorId: ownerId }, refusal));
});
