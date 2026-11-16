import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app } from '../apps/server/src/index.js';
import type { Env } from '../apps/server/src/types.js';
import { portableKeyFor } from '../apps/server/src/portable-sessions.js';
import { IdentityBusy, IdentityStore } from '../apps/runner/src/identity.js';
import { reportedTitle, RunnerService } from '../apps/runner/src/server.js';
import { PortableLeases } from '../apps/runner/src/portable-lease.js';
import { WORK_MARKER } from '../apps/runner/src/session.js';
import { RunnerError } from '../apps/runner/src/protocol.js';
import { sha256 } from '../packages/shared/src/crypto.js';
import {
  canonicalJson, parseSigned, publicKeyOf, signStatement, verifiedSigned, verifyStatement, type IdentityStatement, type PortableSettings,
} from '../packages/shared/src/identity.js';
import type { RunnerAction, RunnerBinding, RunnerTicket, SessionRecord } from '../packages/shared/src/types.js';
import { fakeHub, testDatabase } from './helpers/control-plane.js';

const SECRET = 'portable-sessions-test-secret-not-for-deployment-1234';
const origin = 'http://localhost:8787';
const testSecret = 'portable-sessions-auth-secret-not-for-deployment';

async function temporary(t: TestContext, prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function keyPair() {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
  return { privateKey: pair.privateKey, publicKey: await publicKeyOf(pair.publicKey) };
}

const issuedAt = '2026-11-16T00:00:00.000Z';

test('identity statements are canonical, signed with Ed25519, and refuse anything changed or added', async () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, { f: 2, e: 3 }], c: null } }), '{"a":{"c":null,"d":[1,{"e":3,"f":2}]},"b":1}');
  const key = await keyPair();
  const statement: IdentityStatement = { kind: 'delegation', key: key.publicKey, server: 'https://pikibun.example', connector: 'host-1', issuedAt };
  const signed = await signStatement(key.privateKey, statement);
  assert.equal(await verifyStatement(signed), true);
  assert.deepEqual(await verifiedSigned(JSON.parse(JSON.stringify(signed)), 'delegation'), signed);
  assert.equal(await verifyStatement({ ...signed, statement: { ...signed.statement, connector: 'host-2' } }), false);
  const other = await keyPair();
  assert.equal(await verifyStatement({ ...signed, statement: { ...signed.statement, key: other.publicKey } }), false);
  await assert.rejects(verifiedSigned({ ...signed, statement: { ...signed.statement, server: 'https://elsewhere.example' } }, 'delegation'), /Invalid signature/);
  assert.throws(() => parseSigned({ ...signed, extra: true }, 'delegation'));
  assert.throws(() => parseSigned({ ...signed, statement: { ...signed.statement, extra: 1 } }, 'delegation'));
  assert.throws(() => parseSigned(signed, 'session'));
  assert.throws(() => parseSigned({ ...signed, statement: { ...signed.statement, server: 'https://pikibun.example/path' } }, 'delegation'));
  await assert.rejects(signStatement(key.privateKey, { kind: 'settings', key: key.publicKey, version: 1, settings: { name: 'x', theme: 'dark' } as never, issuedAt }));
  const rotation = await signStatement(key.privateKey, { kind: 'rotation', key: key.publicKey, next: other.publicKey, issuedAt });
  assert.equal(await verifyStatement(rotation), true);
  await assert.rejects(signStatement(key.privateKey, { kind: 'rotation', key: key.publicKey, next: key.publicKey, issuedAt }));
});

test('an identity is made once, privately, and signs delegations, marks and settings with its key', async t => {
  const root = await temporary(t, 'identity-');
  const store = new IdentityStore(join(root, 'identity'));
  const [first, again] = await Promise.all([store.key(), new IdentityStore(join(root, 'identity')).key()]);
  assert.equal(first.publicKey, again.publicKey, 'two connections starting at once share one key');
  if (process.platform !== 'win32') {
    assert.equal((await stat(join(root, 'identity', 'key.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(join(root, 'identity'))).mode & 0o777, 0o700);
  }
  const delegation = await store.delegation('https://a.example', 'host-a');
  assert.deepEqual(await store.delegation('https://a.example', 'host-a'), delegation, 'a delegation is kept, not signed again');
  assert.equal((await store.delegation('https://b.example', 'host-a')).statement.server, 'https://b.example');
  assert.equal(await verifyStatement(delegation), true);

  const session = join(root, 'session');
  await writeFile(join(root, 'placeholder'), '');
  await (await import('node:fs/promises')).mkdir(session);
  const entry = await store.mark('session-1', session);
  assert.equal(entry.mark.statement.key, first.publicKey);
  assert.deepEqual((await store.entries()).map(item => [item.sessionId, item.directory]), [['session-1', session]]);
  await assert.rejects(store.mark('session-1', root), /already portable from another folder/);
  await assert.rejects(store.mark('session-2', 'relative/path'), /Invalid session storage/);

  const settings = await store.signSettings(1, { name: 'Mine', paging: true });
  assert.equal(settings.statement.version, 1);
  assert.equal((await store.signSettings(1, { name: 'Ignored' })).statement.settings.name, 'Mine', 'an older or equal version keeps what was signed');

  const { previous, next, rotation } = await store.rotate();
  assert.equal(previous, first.publicKey);
  assert.equal(rotation.statement.next, next);
  assert.equal(await verifyStatement(rotation), true);
  assert.equal((await store.entry('session-1'))!.mark.statement.key, next, 'rotation signs every mark again');
  assert.equal((await store.settings())!.statement.key, next);
  assert.equal((await store.settings())!.statement.version, 2);
  assert.equal((await store.delegation('https://a.example', 'host-a')).statement.key, next);
  assert.equal((await store.key()).rotations.length, 1);

  const sealed = await store.exportKey('a long passphrase');
  assert.ok(!sealed.includes(next) && !sealed.includes('privateKey'));
  const elsewhere = new IdentityStore(join(root, 'elsewhere'));
  await assert.rejects(elsewhere.importKey(sealed, 'the wrong passphrase'), /Wrong passphrase/);
  assert.equal(await elsewhere.importKey(sealed, 'a long passphrase'), next);
  assert.equal(await elsewhere.publicKey(), next);
  const third = new IdentityStore(join(root, 'third'));
  await third.key();
  await assert.rejects(third.importKey(sealed, 'a long passphrase'), /already has an identity/);
  assert.equal(await third.importKey(sealed, 'a long passphrase', { replace: true }), next);
  await assert.rejects(store.exportKey('short'), /at least 12/);

  const reset = await store.reset();
  assert.equal(reset.previous, next);
  assert.notEqual(reset.next, next);
  assert.equal((await store.entry('session-1'))!.mark.statement.key, reset.next);
  assert.equal((await store.key()).rotations.length, 0, 'a reset carries no signature from the old key');
});

test('one attach at a time holds a session, across processes; a lock its holder left behind is taken over', async t => {
  const root = await temporary(t, 'identity-lock-');
  const store = new IdentityStore(root);
  await store.key();
  const release = Promise.withResolvers<void>();
  const holding = store.withLock('session-1', () => release.promise);
  await assert.rejects(store.withLock('session-1', async () => {}), IdentityBusy);
  release.resolve();
  await holding;
  await writeFile(join(root, 'sessions', 'session-1.lock'), String(process.ppid));
  await assert.rejects(new IdentityStore(root).withLock('session-1', async () => {}), /Another Pikibun on this computer/);
  await writeFile(join(root, 'sessions', 'session-1.lock'), '2147483646');
  assert.equal(await new IdentityStore(root).withLock('session-1', async () => 'taken'), 'taken');
  await writeFile(join(root, 'sessions', 'session-1.lock'), '');
  await assert.rejects(new IdentityStore(root).withLock('session-1', async () => {}), IdentityBusy, 'a lock file just made and not yet readable is held');
  const old = new Date(Date.now() - 120_000);
  await utimes(join(root, 'sessions', 'session-1.lock'), old, old);
  assert.equal(await new IdentityStore(root).withLock('session-1', async () => 'taken'), 'taken', 'one left unreadable for long is taken over');
  await assert.rejects(new IdentityStore(join(root, 'key.json')).withLock('session-1', async () => {}), (error: Error) => !(error instanceof IdentityBusy),
    'a lock that can\'t be made at all says why, rather than that it is busy');

  const leases = new PortableLeases();
  t.after(() => leases.close());
  const session = join(root, 'session-folder');
  await mkdir(session);
  await writeFile(join(session, 'open.lock'), '');
  assert.equal(await leases.holder(session), 'other');
  await assert.rejects(leases.acquire(session), /open on another/);
  await utimes(join(session, 'open.lock'), old, old);
  await leases.acquire(session);
  assert.equal(await leases.holder(session), 'self');
});

test('a host reports a title it can show whatever was typed', () => {
  assert.equal(reportedTitle('Fix\tthe\nbuild\u001b[31m '), 'Fix the build [31m');
  assert.equal(reportedTitle('   '), 'Untitled session');
  assert.equal(reportedTitle('x'.repeat(300)).length, 200);
  assert.equal(reportedTitle(undefined), 'Untitled session');
});

test('pikibun identity shows the key and its sessions, and exports, imports and rotates it', async t => {
  const root = await temporary(t, 'identity-cli-');
  const { identityMain } = await import('../apps/runner/src/identity-cli.js');
  const run = async (...args: string[]) => {
    let output = '';
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => { output += chunk; return true; }) as typeof process.stdout.write;
    try { await identityMain(args); } finally { process.stdout.write = write; }
    return output;
  };
  process.env.PIKIBUN_IDENTITY_PASSPHRASE = 'correct horse battery staple';
  t.after(() => { delete process.env.PIKIBUN_IDENTITY_PASSPHRASE; });
  const shown = await run('show', '--identity-dir', join(root, 'one'));
  const key = /^Identity ([A-Za-z0-9_-]{43})$/m.exec(shown)?.[1];
  assert.ok(key, shown);
  assert.match(shown, /No portable sessions on this computer yet/);
  await run('export', '--identity-dir', join(root, 'one'), '--out', join(root, 'exported'));
  assert.match(await run('import', join(root, 'exported'), '--identity-dir', join(root, 'two')), new RegExp(`now uses identity ${key}`));
  assert.match(await run('rotate', '--identity-dir', join(root, 'two')), new RegExp(`Rotated ${key} to`));
  await assert.rejects(run('import', join(root, 'exported'), '--identity-dir', join(root, 'two')), /already has an identity/);
  await assert.rejects(run('export', '--identity-dir', join(root, 'one'), '--out', join(root, 'exported')), /EEXIST/, 'an export never overwrites a file');
  await assert.rejects(run('nonsense', '--identity-dir', join(root, 'one')), /Unknown identity command/);
});

function runnerBinding(id: string, connector: string, owner: string, portable = true): RunnerBinding {
  const route = { connectorId: connector, connectorOwnerId: owner };
  const workspaceId = `private-${connector}`;
  const name = owner.split(':')[1]!;
  return {
    session: { id, workspaceId, ownerId: owner, agentVersionId: `version-${connector}`, title: 'Portable', policyVersion: 1, status: 'ready',
      createdAt: '2026-01-01T00:00:00Z', ...route, ...(portable ? { portable: true as const } : {}) },
    owner: { id: owner, githubId: null, githubLogin: name, displayName: name, gitName: name, gitEmail: `${name}@example.test`, env: {}, githubConnected: false },
    agent: { id: `version-${connector}`, agentId: 'agent', authorId: owner, workspaceId, version: 1, name: 'Agent', description: '', instructions: 'Use tools.',
      tools: ['read', 'write'], modelId: `model-${connector}`, createdAt: '2026-01-01T00:00:00Z' },
    model: { id: `model-${connector}`, workspaceId, name: 'Faux', provider: 'faux', modelId: 'faux-1', ...route },
  };
}

async function runnerTicket(binding: RunnerBinding, action: RunnerAction): Promise<RunnerTicket> {
  const now = Math.floor(Date.now() / 1000);
  return { aud: 'runner', sessionId: binding.session.id, actorId: binding.owner.id, ownerId: binding.owner.id, action, policyVersion: 1,
    iat: now, exp: now + 60, jti: randomUUID(), bodyHash: await sha256(''), connectorId: binding.session.connectorId! };
}

async function hosts(t: TestContext) {
  const root = await temporary(t, 'portable-hosts-');
  const store = new IdentityStore(join(root, 'identity'));
  const detached: Record<'a' | 'b', string[]> = { a: [], b: [] };
  const make = async (name: 'a' | 'b') => {
    const service = new RunnerService({ dataDir: join(root, name), sharedSecret: SECRET, controlPlaneUrl: 'http://127.0.0.1:8787', allowFaux: true,
      connectorId: `connector-${name}`, unsandboxed: true, authorize: async request => ({ allowed: true, ownerId: request.ownerId, policyVersion: 1 }),
      portable: { store, detached: async sessionId => { detached[name].push(sessionId); } } });
    await service.initialize();
    t.after(() => service.close());
    return service;
  };
  return { root, store, detached, a: await make('a'), b: await make('b') };
}

const status = (code: number) => (error: unknown) => error instanceof RunnerError && error.status === code;

test('a portable session made on one pairing is attached to another, and back, keeping its folder, title and schedules', async t => {
  const f = await hosts(t);
  const onA = runnerBinding('session-1', 'connector-a', 'test:alice');
  const opened = await f.a.provision(onA, await runnerTicket(onA, 'create'));
  const directory = join(f.root, 'a', 'sessions', 'session-1');
  assert.equal(opened.directory, directory);
  assert.deepEqual((await f.store.entries()).map(entry => [entry.sessionId, entry.directory]), [['session-1', directory]]);
  assert.deepEqual((await f.a.portableSessions()).map(report => [report.id, report.attached, report.title]), [['session-1', true, 'Portable']]);
  assert.deepEqual(await f.b.portableSessions().then(reports => reports.map(report => report.attached)), [false]);

  const schedule = { name: 'Nightly', cron: '0 3 * * *', timeZone: 'UTC', content: 'Check the build', access: 'auto', runIn: 'session', oneShot: true, enabled: true };
  await f.a.keep(opened, await runnerTicket(onA, 'portable'), { title: 'Renamed', schedules: [schedule] });
  assert.equal((await f.a.portableSessions())[0]!.title, 'Renamed');
  await assert.rejects(f.a.keep(opened, await runnerTicket(onA, 'portable'), { title: 'x', schedules: [], extra: 1 }), status(400));

  const onB = runnerBinding('session-1', 'connector-b', 'password:alice');
  await writeFile(join(directory, WORK_MARKER), '');
  await assert.rejects(f.b.attach({ binding: onB }, await runnerTicket(onB, 'attach')), /working/);
  await rm(join(directory, WORK_MARKER));
  await assert.rejects(f.b.attach({ binding: { ...onB, session: { ...onB.session, hostEnvironment: true } } }, await runnerTicket(onB, 'attach')), /doesn't match/);
  await assert.rejects(f.b.attach({ binding: runnerBinding('session-1', 'connector-b', 'password:alice', false) }, await runnerTicket(onB, 'attach')), status(400));
  await assert.rejects(f.b.attach({ binding: onB, extra: true }, await runnerTicket(onB, 'attach')), status(400));

  const attached = await f.b.attach({ binding: onB }, await runnerTicket(onB, 'attach'));
  assert.equal((attached.session as SessionRecord).connectorId, 'connector-b');
  assert.deepEqual(attached.kept, { title: 'Renamed', schedules: [schedule] });
  const there = await f.b.get('session-1');
  assert.equal(there.directory, directory, 'the folder stays where it was made');
  assert.equal(there.binding.owner.id, 'password:alice');
  assert.equal(JSON.parse(await readFile(join(directory, 'binding.json'), 'utf8')).session.connectorId, 'connector-b');

  await assert.rejects(f.a.get('session-1'), status(410));
  assert.deepEqual(f.detached.a, ['session-1'], 'the pairing it left tells its server');
  await assert.rejects(f.a.get('session-1'), status(410));
  assert.deepEqual(f.detached.a, ['session-1'], 'once');
  assert.deepEqual((await f.a.portableSessions()).map(report => report.attached), [false]);
  assert.deepEqual((await f.b.portableSessions()).map(report => report.attached), [true]);

  const back = await f.a.attach({ binding: onA }, await runnerTicket(onA, 'attach'));
  assert.equal((back.session as SessionRecord).connectorId, 'connector-a');
  assert.equal((await f.a.get('session-1')).binding.owner.id, 'test:alice');
  await assert.rejects(f.b.get('session-1'), status(410));
  assert.deepEqual(f.detached.b, ['session-1']);
});

test('an existing session of this pairing becomes portable, and only sessions of this identity are attached', async t => {
  const f = await hosts(t);
  const plain = runnerBinding('session-2', 'connector-a', 'test:alice', false);
  await f.a.provision(plain, await runnerTicket(plain, 'create'));
  assert.deepEqual(await f.store.entries(), []);
  const onB = runnerBinding('session-2', 'connector-b', 'password:alice');
  await assert.rejects(f.b.attach({ binding: onB }, await runnerTicket(onB, 'attach')), status(404), 'a session that isn\'t portable stays where it is');

  const portable = runnerBinding('session-2', 'connector-a', 'test:alice');
  await f.a.attach({ binding: portable }, await runnerTicket(portable, 'attach'));
  assert.deepEqual((await f.store.entries()).map(entry => entry.sessionId), ['session-2']);
  assert.equal((await f.a.get('session-2')).binding.session.portable, true);
  const someoneElse = runnerBinding('session-2', 'connector-a', 'test:mallory');
  await assert.rejects(f.a.attach({ binding: someoneElse }, await runnerTicket(someoneElse, 'attach')), status(403), 'on the same server it keeps its owner');

  await f.store.rotate();
  await f.b.attach({ binding: onB }, await runnerTicket(onB, 'attach'));
  assert.equal((await f.b.get('session-2')).binding.session.connectorId, 'connector-b', 'a rotated identity still attaches its sessions');

  const renamed = runnerBinding('session-3', 'connector-a', 'test:alice');
  await f.a.attach({ binding: renamed, sourceSessionId: 'session-2' }, await runnerTicket(renamed, 'attach'));
  assert.equal((await f.a.get('session-3')).directory, join(f.root, 'a', 'sessions', 'session-2'), 'under a new ID on another server, the folder stays');
  assert.deepEqual((await f.store.entries()).map(entry => entry.sessionId), ['session-3']);
  await assert.rejects(f.b.get('session-2'), error => status(410)(error) || status(404)(error));
  for (let wait = 0; wait < 50 && !f.detached.b.includes('session-2'); wait++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(f.detached.b.includes('session-2'), 'the connection that had it open lets go of it and tells its server');
  await f.b.attach({ binding: onB, sourceSessionId: 'session-3' }, await runnerTicket(onB, 'attach'));

  const stranger = new IdentityStore(join(f.root, 'stranger'));
  const entry = await f.store.entry('session-2');
  const foreign = await signStatement((await stranger.key()).privateKey, { kind: 'session', key: await stranger.publicKey(), session: 'session-2', issuedAt });
  await writeFile(join(f.store.root, 'sessions', 'session-2.json'), JSON.stringify({ version: 1, directory: entry!.directory, mark: foreign }));
  await assert.rejects(f.a.attach({ binding: portable }, await runnerTicket(portable, 'attach')), /another identity/);
  assert.deepEqual(await f.a.portableSessions(), [], 'a host reports only its own identity\'s sessions');
  const missing = runnerBinding('missing', 'connector-b', 'password:alice');
  await assert.rejects(f.b.attach({ binding: missing }, await runnerTicket(missing, 'attach')), status(404));
  await assert.rejects(f.b.attach({ binding: missing, sourceSessionId: 'nothing' }, await runnerTicket(missing, 'attach')), status(404));
});

test('a session moved under a new ID whose old entry was left behind is finished by trying again', async t => {
  const f = await hosts(t);
  const made = runnerBinding('session-x', 'connector-a', 'test:alice');
  await f.a.provision(made, await runnerTicket(made, 'create'));
  const folder = (await f.store.entry('session-x'))!.directory;
  const moved = runnerBinding('session-y', 'connector-b', 'password:alice');
  await f.b.attach({ binding: moved, sourceSessionId: 'session-x' }, await runnerTicket(moved, 'attach'));
  await f.store.mark('session-x', folder);
  await f.b.close();
  const again = new RunnerService({ ...f.b.config });
  await again.initialize();
  t.after(() => again.close());
  await again.attach({ binding: moved, sourceSessionId: 'session-x' }, await runnerTicket(moved, 'attach'));
  assert.deepEqual((await f.store.entries()).map(entry => entry.sessionId), ['session-y']);
  assert.equal((await again.get('session-y')).directory, folder);
});

interface Client { user: { id: string }; request(method: string, path: string, body?: unknown): Response | Promise<Response> }

async function json<T>(response: Response, expected = 200): Promise<T> {
  const body = await response.json();
  assert.equal(response.status, expected, JSON.stringify(body));
  return body as T;
}

const bearer = 'b'.repeat(43);
const connection = 'c'.repeat(43);

async function server(t: TestContext, rpc: (action: string, body: string) => Response | Promise<Response>) {
  const { db, sqlite } = await testDatabase();
  t.after(() => db.close());
  const env: Env = { DB: db, APP_ORIGIN: origin, TEST_AUTH_ENABLED: 'true', TEST_AUTH_SECRET: testSecret,
    TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(), VAULT_KEY: Buffer.alloc(32, 7).toString('base64url'),
    CONNECTOR_HUB: fakeHub({ rpc: (_connector, envelope) => rpc(envelope.request.ticket.action, envelope.request.body) }) };
  const request = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => app.request(path, { method,
    headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) }, env);
  const response = await request('POST', '/api/auth/test', { id: 'alice', displayName: 'Alice', gitName: 'Alice', gitEmail: 'alice@example.test' },
    { Authorization: `Bearer ${testSecret}` });
  const { user } = await json<{ user: { id: string } }>(response);
  const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
  const { csrfToken } = await json<{ csrfToken: string }>(await request('GET', '/api/auth/csrf', undefined, { Cookie: cookie }));
  const alice: Client = { user, request: (method, path, body) => request(method, path, body, { Cookie: cookie, 'X-CSRF-Token': csrfToken }) };
  await json(await alice.request('GET', '/api/workspaces'));
  const workspaceId = (sqlite.prepare('SELECT workspace_id FROM personal_workspaces WHERE user_id = ?').get(user.id) as { workspace_id: string }).workspace_id;
  const capabilities = { platform: 'linux', sandbox: true, productionShell: false, plainGit: true, hostConfig: true, ownerHostSessions: true, portableSessions: true,
    sessionBranches: true, schedules: true };
  const pair = async (connectorId: string, credential: string, current: string, model: string) => {
    sqlite.prepare(`INSERT INTO connectors (id, owner_id, name, credential_hash, connection_hash, models_json, capabilities_json, created_at)
      VALUES (?, ?, 'Alice''s Mac', ?, ?, '[{"provider":"faux","modelId":"faux-v1","name":"Model"}]', ?, '2026-01-01')`)
      .run(connectorId, user.id, await sha256(credential), await sha256(current), JSON.stringify(capabilities));
    sqlite.prepare("INSERT INTO connector_workspaces (connector_id, workspace_id, created_at) VALUES (?, ?, '2026-01-01')").run(connectorId, workspaceId);
    sqlite.prepare(`INSERT INTO models (id, workspace_id, name, provider, model_id, connector_id, connector_owner_id, created_at)
      VALUES (?, ?, 'Model', 'faux', 'faux-v1', ?, ?, '2026-01-01')`).run(model, workspaceId, connectorId, user.id);
    return (path: string, body: unknown) => request('POST', path, body, { Authorization: `Bearer ${credential}`, 'X-Connection-Token': current });
  };
  const host = await pair('host', bearer, connection, 'model');
  return { env, sqlite, alice, host, workspaceId, pair };
}

async function identityReport(key: Awaited<ReturnType<typeof keyPair>>, sessions: { id: string; title: string; attached: boolean }[], extra: Record<string, unknown> = {},
  connector = 'host') {
  return {
    delegation: await signStatement(key.privateKey, { kind: 'delegation', key: key.publicKey, server: origin, connector, issuedAt }),
    rotations: [],
    settings: null,
    sessions: await Promise.all(sessions.map(async session => ({ ...session, createdAt: '2026-01-01T00:00:00.000Z', hostEnvironment: true, working: false,
      model: { provider: 'faux', modelId: 'faux-v1' }, mark: await signStatement(key.privateKey, { kind: 'session', key: key.publicKey, session: session.id, issuedAt }) }))),
    ...extra,
  };
}

test('a server lists the portable sessions its owner\'s host reports, brings one here, and archives it when the host takes it away', async t => {
  const calls: { action: string; body: { binding: RunnerBinding; sourceSessionId?: string } & Record<string, unknown> }[] = [];
  const kept = { title: 'From the other server', schedules: [{ name: 'Nightly', cron: '0 3 * * *', timeZone: 'UTC', content: 'Check the build', access: 'auto', runIn: 'session',
    oneShot: true, enabled: true }] };
  const f = await server(t, (action, body) => {
    calls.push({ action, body: JSON.parse(body) });
    return Response.json(action === 'attach' ? { session: JSON.parse(body).binding.session, kept } : { kept: true });
  });
  const key = await keyPair();
  const sessionId = randomUUID();
  const stranger = await keyPair();
  const report = await identityReport(key, [{ id: sessionId, title: 'Elsewhere', attached: false }]);
  report.sessions.push({ ...report.sessions[0]!, id: randomUUID(), mark: await signStatement(stranger.privateKey, { kind: 'session', key: stranger.publicKey,
    session: 'other', issuedAt }) });
  assert.deepEqual(await json(await f.host('/api/connectors/self/identity', report)), {});
  const odd = await identityReport(key, [{ id: randomUUID(), title: 'ok', attached: false }]);
  odd.sessions[0]!.title = '\u0007';
  const oddReport = { ...report, sessions: [...report.sessions, odd.sessions[0]!] };
  assert.deepEqual(await json(await f.host('/api/connectors/self/identity', oddReport)), {}, 'one session it can\'t take doesn\'t refuse the rest');
  await json(await f.host('/api/connectors/self/identity', { ...report, sessions: undefined }), 400);
  const forged = await identityReport(key, []);
  await json(await f.host('/api/connectors/self/identity', { ...forged, delegation: { ...forged.delegation, statement: { ...forged.delegation.statement, connector: 'other-host' } } }), 400);
  const elsewhere = await signStatement(key.privateKey, { kind: 'delegation', key: key.publicKey, server: 'https://another.example', connector: 'host', issuedAt });
  await json(await f.host('/api/connectors/self/identity', { ...forged, delegation: elsewhere }), 403);

  const { sessions } = await json<{ sessions: { id: string; title: string; attachedElsewhere: boolean; modelId?: string; hostName: string }[] }>(
    await f.alice.request('GET', '/api/portable-sessions'));
  assert.deepEqual(sessions.map(item => [item.id, item.title, item.attachedElsewhere, item.modelId, item.hostName]),
    [[sessionId, 'Elsewhere', true, 'model', 'Alice\'s Mac']], 'a mark by another key is not offered');

  const attached = await json<{ session: SessionRecord; schedules: number }>(await f.alice.request('POST', `/api/portable-sessions/${sessionId}/attach`, { connectorId: 'host' }), 201);
  assert.equal(attached.session.id, sessionId);
  assert.equal(attached.session.portable, true);
  assert.equal(attached.session.workspaceId, f.workspaceId);
  assert.equal(attached.session.status, 'ready');
  assert.equal(attached.schedules, 1, 'its schedules come with it');
  assert.equal(calls[0]!.action, 'attach');
  assert.equal(calls[0]!.body.binding.session.portable, true);
  assert.equal(calls[0]!.body.binding.session.hostEnvironment, true);
  assert.equal(calls[0]!.body.binding.session.connectorId, 'host');
  assert.equal(calls[0]!.body.sourceSessionId, undefined);
  assert.equal((f.sqlite.prepare('SELECT portable_key FROM sessions WHERE id = ?').get(sessionId) as { portable_key: string }).portable_key, key.publicKey);
  assert.deepEqual(await json(await f.alice.request('GET', '/api/portable-sessions')), { sessions: [] }, 'attached here, it is no longer offered');
  await json(await f.alice.request('POST', `/api/portable-sessions/${sessionId}/attach`, { connectorId: 'host' }), 409);

  await json(await f.alice.request('PATCH', `/api/sessions/${sessionId}`, { title: 'Renamed here' }));
  const keptCall = calls.at(-1)!;
  assert.equal(keptCall.action, 'portable');
  assert.deepEqual(keptCall.body, { title: 'Renamed here', schedules: kept.schedules.map(schedule => ({ ...schedule })) });

  await json(await f.host('/api/connectors/self/portable/detached', { sessionId }));
  const archived = f.sqlite.prepare('SELECT status, detached_at FROM sessions WHERE id = ?').get(sessionId) as { status: string; detached_at: string | null };
  assert.equal(archived.status, 'archived');
  assert.ok(archived.detached_at);
  const view = await json<{ session: SessionRecord }>(await f.alice.request('GET', `/api/sessions/${sessionId}`));
  assert.equal(view.session.detached, true);
  assert.equal((f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'session.detached' AND session_id = ?").get(sessionId) as { n: number }).n, 1);

  await json(await f.host('/api/connectors/self/identity', await identityReport(key, [{ id: sessionId, title: 'Back again', attached: false }])));
  const returned = await json<{ session: SessionRecord }>(await f.alice.request('POST', `/api/portable-sessions/${sessionId}/attach`, { connectorId: 'host' }));
  assert.equal(returned.session.status, 'ready');
  assert.equal(returned.session.title, 'Back again');
  assert.equal(returned.session.detached, undefined);
  assert.equal((f.sqlite.prepare('SELECT COUNT(*) AS n FROM session_schedules WHERE session_id = ?').get(sessionId) as { n: number }).n, 1, 'schedules it kept here aren\'t doubled');

  const paired = await f.pair('host-again', 'd'.repeat(43), 'e'.repeat(43), 'model-again');
  await json(await paired('/api/connectors/self/identity', await identityReport(key, [{ id: sessionId, title: 'Paired again', attached: false }], {}, 'host-again')));
  const offered = await json<{ sessions: { id: string; connectorId: string; existing?: boolean }[] }>(await f.alice.request('GET', '/api/portable-sessions'));
  assert.deepEqual(offered.sessions.map(item => [item.id, item.connectorId, item.existing]), [[sessionId, 'host-again', true]]);
  const moved = await json<{ session: SessionRecord }>(await f.alice.request('POST', `/api/portable-sessions/${sessionId}/attach`, { connectorId: 'host-again' }), 201);
  assert.notEqual(moved.session.id, sessionId, 'a host paired again gets the session under a new ID here');
  assert.equal(moved.session.connectorId, 'host-again');
  assert.equal(calls.at(-1)!.body.sourceSessionId, sessionId);
  assert.equal(calls.at(-1)!.body.binding.session.id, moved.session.id);
  const old = f.sqlite.prepare('SELECT status, detached_at FROM sessions WHERE id = ?').get(sessionId) as { status: string; detached_at: string | null };
  assert.equal(old.status, 'archived');
  assert.ok(old.detached_at);
});

test('an attach the host refuses leaves nothing behind, and only the host\'s owner brings its sessions', async t => {
  const f = await server(t, () => Response.json({ error: 'This session is working. Stop it, or wait for it to finish, where it is attached now' }, { status: 409 }));
  const key = await keyPair();
  const sessionId = randomUUID();
  await json(await f.host('/api/connectors/self/identity', await identityReport(key, [{ id: sessionId, title: 'Busy', attached: false }])));
  const refused = await json<{ error: string }>(await f.alice.request('POST', `/api/portable-sessions/${sessionId}/attach`, { connectorId: 'host' }), 409);
  assert.match(refused.error, /working/);
  assert.equal(f.sqlite.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId), undefined);
  await json(await f.alice.request('POST', `/api/portable-sessions/${randomUUID()}/attach`, { connectorId: 'host' }), 404);
  await json(await f.alice.request('POST', `/api/portable-sessions/${sessionId}/attach`, { connectorId: 'host', modelId: 'missing' }), 404);
});

test('existing private sessions on the host become portable, and new ones are portable from the start', async t => {
  const f = await server(t, action => Response.json(action === 'attach' ? { session: {}, kept: { schedules: [] } } : { kept: true }));
  const key = await keyPair();
  f.sqlite.prepare("INSERT INTO agents (id, author_id, created_at) VALUES ('agent', ?, '2026-01-01')").run(f.alice.user.id);
  f.sqlite.prepare(`INSERT INTO agent_versions (id, agent_id, author_id, workspace_id, version, name, description, instructions, tools_json, model_id, created_at)
    VALUES ('version', 'agent', ?, ?, 1, 'Agent', '', '', '[]', 'model', '2026-01-01')`).run(f.alice.user.id, f.workspaceId);
  const insert = f.sqlite.prepare(`INSERT INTO sessions (id, workspace_id, owner_id, agent_version_id, title, policy_version, status, created_at, connector_id,
    connector_owner_id, repositories_json, visibility, repository_mode, host_environment) VALUES (?, ?, ?, 'version', ?, 1, ?, '2026-01-01', 'host', ?, '[]', 'private', 'clone', 1)`);
  insert.run('ready-one', f.workspaceId, f.alice.user.id, 'Ready', 'ready', f.alice.user.id);
  insert.run('archived-one', f.workspaceId, f.alice.user.id, 'Archived', 'archived', f.alice.user.id);
  await json(await f.alice.request('POST', '/api/connectors/host/portable'), 409);
  await json(await f.host('/api/connectors/self/identity', await identityReport(key, [])));
  const result = await json<{ converted: string[]; skipped: unknown[] }>(await f.alice.request('POST', '/api/connectors/host/portable'));
  assert.deepEqual(result, { converted: ['ready-one'], skipped: [] });
  assert.equal((f.sqlite.prepare("SELECT portable_key FROM sessions WHERE id = 'ready-one'").get() as { portable_key: string }).portable_key, key.publicKey);
  assert.equal((f.sqlite.prepare("SELECT portable_key FROM sessions WHERE id = 'archived-one'").get() as { portable_key: string | null }).portable_key, null);

  const row = { workspace_id: f.workspaceId, owner_id: f.alice.user.id, connector_id: 'host', connector_owner_id: f.alice.user.id, host_environment: 1 };
  assert.equal(await portableKeyFor(f.env, row, false), key.publicKey);
  assert.equal(await portableKeyFor(f.env, { ...row, host_environment: 0 }, true), key.publicKey, 'a sandboxed session with no sources is portable too');
  assert.equal(await portableKeyFor(f.env, { ...row, host_environment: 0 }, false), null);
  assert.equal(await portableKeyFor(f.env, { ...row, connector_owner_id: 'test:someone' }, false), null);
  f.sqlite.prepare("INSERT INTO workspaces (id, name, owner_id, created_at) VALUES ('team', 'Team', ?, '2026-01-01')").run(f.alice.user.id);
  assert.equal(await portableKeyFor(f.env, { ...row, workspace_id: 'team' }, false), null, 'only the private workspace\'s sessions');

  const next = await keyPair();
  const stray = await keyPair();
  const strayRotation = await signStatement(stray.privateKey, { kind: 'rotation', key: stray.publicKey, next: next.publicKey, issuedAt });
  await json(await f.host('/api/connectors/self/identity', await identityReport(next, [], { rotations: [strayRotation] })));
  const keyOf = () => (f.sqlite.prepare("SELECT portable_key FROM sessions WHERE id = 'ready-one'").get() as { portable_key: string }).portable_key;
  assert.equal(keyOf(), key.publicKey, 'a rotation that doesn\'t start from a key of these sessions changes nothing');
  const rotation = await signStatement(key.privateKey, { kind: 'rotation', key: key.publicKey, next: stray.publicKey, issuedAt });
  await json(await f.host('/api/connectors/self/identity', await identityReport(next, [], { rotations: [rotation] })));
  assert.equal(keyOf(), key.publicKey, 'nor does a chain that doesn\'t end at the key the host signs with');
  await json(await f.host('/api/connectors/self/identity', await identityReport(next, [], { rotations: [rotation, strayRotation] })));
  assert.equal(keyOf(), next.publicKey, 'a whole chain moves the sessions to the new key');
});

test('making sessions portable goes on past the ones its host refuses', async t => {
  const f = await server(t, (action, body) => {
    const id = (JSON.parse(body) as { binding?: RunnerBinding }).binding?.session.id ?? '';
    if (action === 'attach' && id.startsWith('stuck-')) return Response.json({ error: 'This session has no conversation yet to attach' }, { status: 409 });
    return Response.json(action === 'attach' ? { session: {}, kept: { schedules: [] } } : { kept: true });
  });
  const key = await keyPair();
  await json(await f.host('/api/connectors/self/identity', await identityReport(key, [])));
  f.sqlite.prepare("INSERT INTO agents (id, author_id, created_at) VALUES ('agent', ?, '2026-01-01')").run(f.alice.user.id);
  f.sqlite.prepare(`INSERT INTO agent_versions (id, agent_id, author_id, workspace_id, version, name, description, instructions, tools_json, model_id, created_at)
    VALUES ('version', 'agent', ?, ?, 1, 'Agent', '', '', '[]', 'model', '2026-01-01')`).run(f.alice.user.id, f.workspaceId);
  const insert = f.sqlite.prepare(`INSERT INTO sessions (id, workspace_id, owner_id, agent_version_id, title, policy_version, status, created_at, connector_id,
    connector_owner_id, repositories_json, visibility, repository_mode, host_environment) VALUES (?, ?, ?, 'version', 'Session', 1, 'ready', ?, 'host', ?, '[]', 'private', 'clone', 1)`);
  for (let index = 0; index < 50; index++) insert.run(`stuck-${String(index).padStart(2, '0')}`, f.workspaceId, f.alice.user.id, '2026-01-01T00:00:00.000Z', f.alice.user.id);
  insert.run('later', f.workspaceId, f.alice.user.id, '2026-02-01T00:00:00.000Z', f.alice.user.id);
  const first = await json<{ converted: string[]; skipped: unknown[]; next?: { createdAt: string; id: string } }>(await f.alice.request('POST', '/api/connectors/host/portable', {}));
  assert.deepEqual([first.converted, first.skipped.length], [[], 50]);
  assert.deepEqual(first.next, { createdAt: '2026-01-01T00:00:00.000Z', id: 'stuck-49' });
  const second = await json<{ converted: string[]; next?: unknown }>(await f.alice.request('POST', '/api/connectors/host/portable', { after: first.next }));
  assert.deepEqual(second, { converted: ['later'], skipped: [] });
});

test('the private workspace\'s settings travel signed by the identity, and a server can\'t forge them', async t => {
  const first = await server(t, () => Response.json({}));
  const key = await keyPair();
  await json(await first.alice.request('PATCH', `/api/workspaces/${first.workspaceId}`, { name: 'My corner' }));
  await json(await first.alice.request('PUT', `/api/workspaces/${first.workspaceId}/transcripts`, { paging: true, toolOutput: 'brief' }));
  const answer = await json<{ sign?: { version: number; settings: PortableSettings } }>(await first.host('/api/connectors/self/identity', await identityReport(key, [])));
  assert.deepEqual(answer.sign, { version: 2, settings: { name: 'My corner', paging: true, toolOutput: 'brief' } });
  const signed = await signStatement(key.privateKey, { kind: 'settings', key: key.publicKey, version: answer.sign!.version, settings: answer.sign!.settings, issuedAt });
  const other = await keyPair();
  await json(await first.host('/api/connectors/self/identity/settings', { settings: await signStatement(other.privateKey, { ...signed.statement, key: other.publicKey }) }), 403);
  await json(await first.host('/api/connectors/self/identity/settings', { settings: signed }));
  assert.deepEqual(await json(await first.host('/api/connectors/self/identity', await identityReport(key, []))), {}, 'nothing left to sign');

  const second = await server(t, () => Response.json({}));
  const tampered = { ...signed, statement: { ...signed.statement, settings: { name: 'Forged' } } };
  await json(await second.host('/api/connectors/self/identity', await identityReport(key, [], { settings: tampered })));
  assert.equal((second.sqlite.prepare('SELECT name FROM workspaces WHERE id = ?').get(second.workspaceId) as { name: string }).name, 'Private');
  await json(await second.host('/api/connectors/self/identity', await identityReport(key, [], { settings: signed })));
  assert.equal((second.sqlite.prepare('SELECT name FROM workspaces WHERE id = ?').get(second.workspaceId) as { name: string }).name, 'My corner');
  const transcripts = second.sqlite.prepare('SELECT paging, tool_output FROM workspace_transcript_settings WHERE workspace_id = ?').get(second.workspaceId) as { paging: number; tool_output: string };
  assert.deepEqual({ ...transcripts }, { paging: 1, tool_output: 'brief' });
  await json(await second.alice.request('PATCH', `/api/workspaces/${second.workspaceId}`, { name: 'Renamed later' }));
  await json(await second.host('/api/connectors/self/identity', await identityReport(key, [], { settings: signed })));
  assert.equal((second.sqlite.prepare('SELECT name FROM workspaces WHERE id = ?').get(second.workspaceId) as { name: string }).name, 'Renamed later',
    'a version already applied isn\'t applied again');
  const elsewhere = await signStatement(key.privateKey, { kind: 'settings', key: key.publicKey, version: 3, settings: { name: 'From elsewhere' }, issuedAt });
  const asked = await json<{ sign?: { version: number; settings: PortableSettings } }>(
    await second.host('/api/connectors/self/identity', await identityReport(key, [], { settings: elsewhere })));
  assert.equal((second.sqlite.prepare('SELECT name FROM workspaces WHERE id = ?').get(second.workspaceId) as { name: string }).name, 'Renamed later',
    'a change made here and not signed yet isn\'t overwritten by one of the same version from elsewhere');
  assert.deepEqual([asked.sign?.version, asked.sign?.settings.name], [4, 'Renamed later'], 'it is signed as the newer one instead');
  assert.equal(JSON.parse(canonicalJson(signed.statement)).kind, 'settings');
});
