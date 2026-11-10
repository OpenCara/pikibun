import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify, type ECDH } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { app } from '../apps/server/src/index.js';
import { activityNotification, notificationText, settleNotificationDeliveries } from '../apps/server/src/notifications.js';
import type { Env } from '../apps/server/src/types.js';
import { allowedPushEndpoint, encryptPushPayload, generateVapidKeys, vapidAuthorization } from '../apps/server/src/web-push.js';
import type { ConnectorCredentials, ConnectorPairing } from '../packages/shared/src/connector.js';
import { sha256 } from '../packages/shared/src/crypto.js';
import type { NotificationConfig, NotificationDevice, NotificationFeed, NotificationPayload } from '../packages/shared/src/notifications.js';
import type { ModelDefinition, SessionActivity, SessionRecord } from '../packages/shared/src/types.js';
import { fakeHub, testDatabase } from './helpers/control-plane.js';

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

test('Web Push messages are encrypted as RFC 8291 says, to its own test vector', () => {
  const body = encryptPushPayload(new TextEncoder().encode('When I grow up, I want to be a watermelon'),
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', 'BTBZMqHH6r4Tts7J_aSIgg',
    { salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'), serverPrivateKey: Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url') });
  assert.equal(b64(body), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6c'
    + 'VPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
  const browser = subscriber();
  const message = JSON.stringify({ title: 'Ünïcode ✓', body: 'x'.repeat(2000) });
  const one = encryptPushPayload(new TextEncoder().encode(message), browser.p256dh, browser.auth);
  const two = encryptPushPayload(new TextEncoder().encode(message), browser.p256dh, browser.auth);
  assert.notEqual(b64(one), b64(two));
  assert.equal(browser.decrypt(one), message);
  assert.throws(() => encryptPushPayload(new Uint8Array(4000), browser.p256dh, browser.auth), /too large/);
});

test('VAPID authorizations are ES256 JWTs for the push service, signed by the server\'s key', () => {
  const keys = generateVapidKeys();
  assert.equal(Buffer.from(keys.publicKey, 'base64url').length, 65);
  const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', 'https://pikibun.example', keys, 1_000_000);
  const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)!;
  assert.ok(match);
  assert.equal(match[4], keys.publicKey);
  assert.deepEqual(JSON.parse(Buffer.from(match[1]!, 'base64url').toString()), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(JSON.parse(Buffer.from(match[2]!, 'base64url').toString()), { aud: 'https://fcm.googleapis.com', exp: 1_000_000 + 12 * 3600, sub: 'https://pikibun.example' });
  const point = Buffer.from(keys.publicKey, 'base64url');
  const publicKey = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: b64(point.subarray(1, 33)), y: b64(point.subarray(33)) } });
  assert.ok(verify('sha256', Buffer.from(`${match[1]}.${match[2]}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(match[3]!, 'base64url')));
});

test('the server pushes only to the browsers\' own push services', () => {
  for (const endpoint of ['https://fcm.googleapis.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/abc', 'https://web.push.apple.com/QAbc',
    'https://wns2-par02p.notify.windows.com/w/?token=abc']) assert.equal(allowedPushEndpoint(endpoint), true, endpoint);
  for (const endpoint of ['http://fcm.googleapis.com/fcm/send/abc', 'https://fcm.googleapis.com.evil.test/x', 'https://evilpush.apple.com.test/x', 'https://127.0.0.1/x',
    'https://user:pass@fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'https://notapush.apple.comx/', 'not a url']) assert.equal(allowedPushEndpoint(endpoint), false, endpoint);
});

test('only changes the agent made notify: waiting for an approval, and finishing or failing what it worked on', () => {
  const cases: [SessionActivity | null, SessionActivity, string | null][] = [
    ['working', 'waiting', 'approval'], ['idle', 'waiting', 'approval'], [null, 'waiting', 'approval'], ['waiting', 'waiting', null],
    ['working', 'done', 'finished'], ['waiting', 'done', 'finished'], ['working', 'failed', 'failed'], ['waiting', 'failed', 'failed'],
    [null, 'done', null], ['idle', 'done', null], ['done', 'failed', null], ['failed', 'done', null],
    ['working', 'idle', null], ['done', 'working', null], ['working', 'working', null],
  ];
  for (const [previous, next, kind] of cases) assert.equal(activityNotification(previous, next), kind, `${previous} → ${next}`);
  assert.deepEqual(notificationText('approval', true, { title: '  Fix\nthe   build ', workspace: 'Team' }), { title: 'Fix the build', body: 'Waiting for an approval · Team' });
  assert.deepEqual(notificationText('finished', false, { title: 'Secret plan', workspace: 'Team' }), { title: 'Pikibun', body: 'A session finished.' });
  assert.equal(notificationText('failed', true, { title: '', workspace: 'Team' }).title, 'Untitled session');
});

function subscriber(endpoint = `https://fcm.googleapis.com/fcm/send/${randomBytes(8).toString('hex')}`) {
  const ecdh: ECDH = createECDH('prime256v1');
  ecdh.generateKeys();
  const authSecret = randomBytes(16);
  return {
    endpoint, p256dh: b64(ecdh.getPublicKey()), auth: b64(authSecret),
    decrypt(body: Uint8Array): string {
      const bytes = Buffer.from(body);
      const salt = bytes.subarray(0, 16);
      const keyLength = bytes[20]!;
      const serverPublic = bytes.subarray(21, 21 + keyLength);
      const shared = ecdh.computeSecret(serverPublic);
      const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), serverPublic]), 32));
      const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
      const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
      const record = bytes.subarray(21 + keyLength);
      const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
      decipher.setAuthTag(record.subarray(record.length - 16));
      const plain = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
      assert.equal(plain.at(-1), 2, 'the last record');
      return plain.subarray(0, -1).toString('utf8');
    },
  };
}

const origin = 'http://localhost:8787';
const testSecret = 'notifications-test-secret-not-for-deployment';
const manifest = {
  models: [{ provider: 'local-native', modelId: 'local/model-v1', name: 'Local model' }],
  capabilities: { platform: 'linux', sandbox: true, productionShell: false, plainGit: true },
};
type ApiRequest = (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<Response>;
interface Client { user: { id: string }; cookie: string; request: ApiRequest }
interface Push { url: string; headers: Headers; body: Uint8Array }

async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  return body as T;
}

async function fixture(t: TestContext) {
  const { db, sqlite } = await testDatabase();
  t.after(() => db.close());
  const env: Env = { DB: db, APP_ORIGIN: origin, TEST_AUTH_ENABLED: 'true', TEST_AUTH_SECRET: testSecret,
    TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(), VAULT_KEY: Buffer.alloc(32, 9).toString('base64url'),
    CONNECTOR_HUB: fakeHub({ rpc: (_id, envelope) => envelope.request.ticket.action === 'create' ? Response.json({ ok: true }, { status: 201 })
      : Response.json({ error: 'Unsupported test relay request' }, { status: 503 }) }) };
  const request = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => Promise.resolve(app.request(path, { method,
    headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) }, env));
  async function client(name: string): Promise<Client> {
    const response = await request('POST', '/api/auth/test', { id: name, displayName: name, gitName: name, gitEmail: `${name}@example.test` },
      { Authorization: `Bearer ${testSecret}` });
    const { user } = await json<{ user: { id: string } }>(response);
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const { csrfToken } = await json<{ csrfToken: string }>(await request('GET', '/api/auth/csrf', undefined, { Cookie: cookie }));
    return { user, cookie, request: (method, path, body, headers = {}) => request(method, path, body, { Cookie: cookie, 'X-CSRF-Token': csrfToken, ...headers }) };
  }
  const pushes: Push[] = [];
  let answer = (_url: string): Response => new Response(null, { status: 201 });
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    pushes.push({ url, headers: new Headers(init?.headers), body: typeof init?.body === 'string' ? new TextEncoder().encode(init.body) : new Uint8Array(init?.body as Uint8Array) });
    return answer(url);
  };

  const alice = await client('alice'); const bob = await client('bob'); const carol = await client('carol');
  const { workspace } = await json<{ workspace: { id: string } }>(await alice.request('POST', '/api/workspaces', { name: 'Team' }), 201);
  for (const member of [bob, carol]) await json(await alice.request('POST', `/api/workspaces/${workspace.id}/members`, { userId: member.user.id, role: 'member' }));
  const { pairing } = await json<{ pairing: ConnectorPairing }>(await alice.request('POST', '/api/connectors/pairings', { name: 'Local Pi', workspaceId: workspace.id }), 201);
  const { credentials } = await json<{ credentials: ConnectorCredentials }>(await request('POST', `/api/connectors/pairings/${pairing.id}/claim`, { code: pairing.code, ...manifest }), 201);
  const connectionToken = b64(randomBytes(32));
  sqlite.prepare('UPDATE connectors SET connection_hash = ? WHERE id = ?').run(await sha256(connectionToken), credentials.connectorId);
  const { models } = await json<{ models: ModelDefinition[] }>(await alice.request('GET', `/api/workspaces/${workspace.id}/models`));
  const { session } = await json<{ session: SessionRecord }>(await alice.request('POST', '/api/sessions', { workspaceId: workspace.id, modelId: models[0]!.id, title: 'Fix the build', visibility: 'private' }), 201);
  await json(await alice.request('POST', `/api/sessions/${session.id}/grants`, { userId: bob.user.id, role: 'collaborator' }));

  const report = (activity: SessionActivity) => request('POST', '/api/connectors/self/activity', { sessionId: session.id, activity },
    { Authorization: `Bearer ${credentials.token}`, 'X-Connection-Token': connectionToken });
  async function reportAll(...activities: SessionActivity[]) {
    for (const activity of activities) await json(await report(activity));
    await settleNotificationDeliveries();
  }
  async function cursor(client: Client) { return (await json<NotificationFeed>(await client.request('GET', '/api/notifications/feed'))).cursor; }
  async function feed(client: Client, after: string) { return json<NotificationFeed>(await client.request('GET', `/api/notifications/feed?after=${encodeURIComponent(after)}`)); }
  let sentAt = Date.now() - 60_000;
  function sent(sender: Client) {
    sentAt += 1000;
    sqlite.prepare(`INSERT INTO run_admissions (id, session_id, actor_id, mode, request_id, content_hash, expires_at, created_at)
      VALUES (?, ?, ?, 'write', ?, ?, ?, ?)`).run(b64(randomBytes(32)).slice(0, 43), session.id, sender.user.id, b64(randomBytes(8)), 'h'.repeat(43),
      Math.floor(Date.now() / 1000) + 3600, new Date(sentAt).toISOString());
  }
  return { env, sqlite, request, alice, bob, carol, session, workspace, pushes, report, reportAll, cursor, feed, sent, setAnswer(next: typeof answer) { answer = next; } };
}

test('an approval to wait for, a finish and a failure reach the session\'s owner and its latest sender, on every device', async t => {
  const f = await fixture(t);
  const browser = subscriber();
  const { device } = await json<{ device: NotificationDevice }>(await f.alice.request('POST', '/api/notifications/devices',
    { kind: 'web', endpoint: browser.endpoint, keys: { p256dh: browser.p256dh, auth: browser.auth }, name: 'Firefox on Linux' }), 201);
  assert.deepEqual({ kind: device.kind, name: device.name, current: device.current }, { kind: 'web', name: 'Firefox on Linux', current: true });
  const config = await json<NotificationConfig>(await f.alice.request('GET', '/api/notifications/config'));
  assert.equal(config.devices.length, 1);
  assert.ok(config.webPushKey && Buffer.from(config.webPushKey, 'base64url').length === 65);
  assert.deepEqual(config.preferences, { approvals: true, finished: true, failed: true, details: true });
  assert.equal((await json<NotificationConfig>(await f.alice.request('GET', '/api/notifications/config'))).webPushKey, config.webPushKey);

  const [aliceFrom, bobFrom, carolFrom] = [await f.cursor(f.alice), await f.cursor(f.bob), await f.cursor(f.carol)];
  f.sent(f.bob);
  f.sent(f.carol);
  await f.reportAll('working', 'waiting');

  const aliceFeed = await f.feed(f.alice, aliceFrom);
  assert.deepEqual(aliceFeed.notifications.map(n => [n.kind, n.title, n.body, n.sessionId]), [['approval', 'Fix the build', 'Waiting for an approval · Team', f.session.id]]);
  assert.equal(aliceFeed.cursor, aliceFeed.notifications[0]!.id);
  assert.deepEqual((await f.feed(f.alice, aliceFeed.cursor)).notifications, [], 'nothing twice');
  assert.deepEqual((await f.feed(f.carol, carolFrom)).notifications, []);
  assert.deepEqual((await f.feed(f.bob, bobFrom)).notifications, []);

  const web = f.pushes.find(push => push.url === browser.endpoint)!;
  assert.equal(web.headers.get('content-encoding'), 'aes128gcm');
  assert.equal(web.headers.get('urgency'), 'high');
  assert.match(web.headers.get('authorization')!, new RegExp(`^vapid t=.+, k=${config.webPushKey}$`));
  const payload = JSON.parse(browser.decrypt(web.body)) as NotificationPayload;
  assert.deepEqual({ kind: payload.kind, title: payload.title, sessionId: payload.sessionId, origin: payload.origin, path: payload.path },
    { kind: 'approval', title: 'Fix the build', sessionId: f.session.id, origin, path: `/#/s/${f.session.id}` });

  f.sent(f.bob);
  f.pushes.length = 0;
  await f.reportAll('working', 'done');
  assert.deepEqual((await f.feed(f.alice, aliceFeed.cursor)).notifications.map(n => n.kind), ['finished']);
  assert.deepEqual((await f.feed(f.bob, bobFrom)).notifications.map(n => [n.kind, n.body]), [['finished', 'Finished · Team']]);
  assert.equal(f.pushes.length, 1, 'Bob has no devices');
  await f.reportAll('working', 'failed');
  assert.deepEqual((await f.feed(f.bob, bobFrom)).notifications.map(n => n.kind), ['finished', 'failed']);
});

test('reports that change nothing, or only restate a settled session, notify nobody', async t => {
  const f = await fixture(t);
  const from = await f.cursor(f.alice);
  await f.reportAll('done', 'idle', 'done', 'working', 'working', 'idle');
  assert.deepEqual((await f.feed(f.alice, from)).notifications, []);
  await f.reportAll('waiting', 'waiting');
  assert.deepEqual((await f.feed(f.alice, from)).notifications.map(n => n.kind), ['approval']);
});

test('each person chooses which notifications they get, and whether they name the session', async t => {
  const f = await fixture(t);
  await json(await f.alice.request('PUT', '/api/notifications/preferences', { finished: false, details: false }));
  for (const bad of [{}, { finished: 'no' }, { sound: true }]) {
    assert.equal((await f.alice.request('PUT', '/api/notifications/preferences', bad)).status, 400, JSON.stringify(bad));
  }
  assert.deepEqual((await json<NotificationConfig>(await f.alice.request('GET', '/api/notifications/config'))).preferences,
    { approvals: true, finished: false, failed: true, details: false });
  const from = await f.cursor(f.alice);
  await f.reportAll('working', 'done', 'working', 'failed');
  assert.deepEqual((await f.feed(f.alice, from)).notifications.map(n => [n.kind, n.title, n.body]), [['failed', 'Pikibun', 'A session stopped on an error.']]);
});

test('devices are checked, belong to their sign-in, and go when the push service forgets them', async t => {
  const f = await fixture(t);
  const register = (client: Client, body: unknown) => client.request('POST', '/api/notifications/devices', body);
  const browser = subscriber();
  const valid = { kind: 'web', endpoint: browser.endpoint, keys: { p256dh: browser.p256dh, auth: browser.auth } };
  for (const [body, code] of [
    [{ ...valid, endpoint: 'https://internal.example.test/push' }, 'unsupported_push_service'],
    [{ ...valid, endpoint: 'http://fcm.googleapis.com/fcm/send/x' }, 'unsupported_push_service'],
    [{ ...valid, keys: { p256dh: b64(randomBytes(65)), auth: browser.auth } }, 'invalid_input'],
    [{ ...valid, keys: { p256dh: browser.p256dh, auth: 'short' } }, 'invalid_input'],
    [{ kind: 'expo', token: 'https://exp.host/evil' }, 'invalid_input'],
    [{ kind: 'apns', token: 'abc' }, 'invalid_input'],
    [{ ...valid, extra: 1 }, 'invalid_input'],
  ] as const) {
    const response = await register(f.alice, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json() as { code: string }).code, code, JSON.stringify(body));
  }
  const { device } = await json<{ device: NotificationDevice }>(await register(f.alice, valid), 201);
  assert.equal((await f.bob.request('DELETE', `/api/notifications/devices/${device.id}`)).status, 404);
  const moved = await json<{ device: NotificationDevice }>(await register(f.bob, valid), 201);
  assert.equal(moved.device.id, device.id);
  assert.deepEqual((await json<NotificationConfig>(await f.alice.request('GET', '/api/notifications/config'))).devices, []);
  await json(await f.bob.request('DELETE', `/api/notifications/devices/${device.id}`));
  assert.deepEqual((await json<NotificationConfig>(await f.bob.request('GET', '/api/notifications/config'))).devices, []);

  await json(await register(f.alice, valid), 201);
  const tested = await json<{ delivered: { web: number } }>(await f.alice.request('POST', '/api/notifications/test'));
  assert.deepEqual(tested.delivered, { web: 1 });
  f.setAnswer(() => new Response(null, { status: 410 }));
  assert.deepEqual((await json<{ delivered: { web: number } }>(await f.alice.request('POST', '/api/notifications/test'))).delivered, { web: 0 });
  assert.deepEqual((await json<NotificationConfig>(await f.alice.request('GET', '/api/notifications/config'))).devices, []);

  f.setAnswer(() => new Response(null, { status: 201 }));
  await json(await register(f.alice, valid), 201);
  await json(await f.alice.request('POST', '/api/auth/logout'));
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM notification_devices').get()!.n, 0);
  f.pushes.length = 0;
  await f.reportAll('working', 'waiting');
  assert.deepEqual(f.pushes, [], 'nothing pushed to a signed-out browser');
});

test('the feed starts where a page opens and keeps a day of notifications', async t => {
  const f = await fixture(t);
  const start = await f.cursor(f.alice);
  assert.match(start, /^[0-9a-z]{10}-$/);
  assert.equal((await f.alice.request('GET', '/api/notifications/feed?after=../../etc')).status, 400);
  await f.reportAll('working', 'waiting');
  const later = await f.cursor(f.alice);
  assert.deepEqual((await f.feed(f.alice, later)).notifications, [], 'a page opened after it sees nothing old');
  f.sqlite.prepare('UPDATE notifications SET created_at = ?').run(new Date(Date.now() - 2 * 86400000).toISOString());
  await f.reportAll('working', 'done');
  assert.deepEqual((await f.feed(f.alice, start)).notifications.map(n => n.kind), ['finished']);
});
