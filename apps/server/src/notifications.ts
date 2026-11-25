import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext, Env, SessionRow, AppEnv } from './types.js';
import { decryptToken, encryptToken, sessionAccess } from './authority/index.js';
import { appOrigin, fail, identifier, jsonObject, now, randomToken, text } from './http.js';
import { body as requestBody, fields } from './schemas.js';
import { allowedPushEndpoint, encryptPushPayload, generateVapidKeys, validP256Point, vapidAuthorization, type VapidKeys } from './web-push.js';
import {
  defaultNotificationPreferences, MAX_HANDLED_NOTIFICATIONS, NOTIFICATION_FEED_POLL_MS, NOTIFICATION_FEED_RETENTION_MS, notificationPath, PHONE_PUSH_WAIT_MS,
  type FeedNotification, type NotificationConfig, type NotificationDelivery, type NotificationDevice, type NotificationDeviceKind, type NotificationFeed,
  type NotificationKind, type NotificationPayload, type NotificationPreferences, type PikibunNotification,
} from '../../../packages/shared/src/notifications.js';
import type { SessionActivity } from '../../../packages/shared/src/types.js';

const MAX_DEVICES = 20;
const FEED_LIMIT = 50;
const SENDER_WINDOW_MS = 24 * 60 * 60 * 1000;
const PUSH_TIMEOUT_MS = 10_000;
const MAX_CONCURRENT_PUSHES = 16;
const VAPID_KEY_NAME = 'web-push-vapid';
const VAPID_VAULT_IDENTITY = 'server:web-push';
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_TOKEN = /^Expo(?:nent)?PushToken\[[A-Za-z0-9_-]{10,200}\]$/;
const EXPO_BATCH = 100;
const FEED_LISTENING_MS = 3 * NOTIFICATION_FEED_POLL_MS;
const PHONE_PUSH_RETRY_MS = 60_000;
const PHONE_PUSH_GIVE_UP_MS = 60 * 60_000;

export function activityNotification(previous: SessionActivity | null | undefined, next: SessionActivity): Exclude<NotificationKind, 'test'> | null {
  if (previous === next) return null;
  if (next === 'waiting') return 'approval';
  if (previous !== 'working' && previous !== 'waiting') return null;
  if (next === 'done') return 'finished';
  if (next === 'failed') return 'failed';
  return null;
}

const preferenceOf: Record<Exclude<NotificationKind, 'test'>, keyof NotificationPreferences> = { approval: 'approvals', finished: 'finished', failed: 'failed' };

export function notificationText(kind: NotificationKind, details: boolean, session?: { title: string; workspace: string }): { title: string; body: string } {
  if (kind === 'test') return { title: 'Pikibun', body: 'Notifications work on this device.' };
  const event = { approval: 'Waiting for you', finished: 'Finished', failed: 'Stopped on an error' }[kind];
  if (!details || !session) {
    return { title: 'Pikibun', body: { approval: 'A session is waiting for you.', finished: 'A session finished.', failed: 'A session stopped on an error.' }[kind] };
  }
  return { title: oneLine(session.title, 120) || 'Untitled session', body: `${event} · ${oneLine(session.workspace, 80)}` };
}

const oneLine = (value: string, max: number) => {
  const line = value.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

function notificationId(at: number): string {
  return `${feedTime(at)}-${randomToken().slice(0, 12)}`;
}
const feedTime = (at: number) => Math.max(0, Math.floor(at)).toString(36).padStart(10, '0');
const FEED_CURSOR = /^[0-9a-z]{10}-[A-Za-z0-9_-]{0,12}$/;
const NOTIFICATION_ID = /^[0-9a-z]{10}-[A-Za-z0-9_-]{12}$/;

export async function notificationPreferences(env: Env, userId: string): Promise<NotificationPreferences> {
  const row = await env.DB.query<{ approvals: number; finished: number; failed: number; details: number }>(
    'SELECT approvals, finished, failed, details FROM notification_preferences WHERE user_id = ?').bind(userId).first();
  if (!row) return { ...defaultNotificationPreferences };
  return { approvals: Number(row.approvals) === 1, finished: Number(row.finished) === 1, failed: Number(row.failed) === 1, details: Number(row.details) === 1 };
}

const vapidCache = new WeakMap<object, Promise<VapidKeys | null>>();

export function webPushKeys(env: Env): Promise<VapidKeys | null> {
  let keys = vapidCache.get(env.DB);
  if (!keys) {
    keys = loadVapidKeys(env).catch(() => null);
    vapidCache.set(env.DB, keys);
    void keys.then(value => { if (!value) vapidCache.delete(env.DB); });
  }
  return keys;
}

async function loadVapidKeys(env: Env): Promise<VapidKeys> {
  const read = () => env.DB.query<{ value: string }>('SELECT value FROM server_keys WHERE name = ?').bind(VAPID_KEY_NAME).first('value');
  let stored = await read();
  if (!stored) {
    const fresh = generateVapidKeys();
    const sealed = JSON.stringify({ publicKey: fresh.publicKey, privateKey: await encryptToken(env, VAPID_VAULT_IDENTITY, fresh.privateKey) });
    await env.DB.query('INSERT INTO server_keys (name, value, created_at) VALUES (?, ?, ?) ON CONFLICT (name) DO NOTHING').bind(VAPID_KEY_NAME, sealed, now()).run();
    stored = await read();
  }
  const parsed = JSON.parse(stored!) as { publicKey: string; privateKey: string };
  return { publicKey: parsed.publicKey, privateKey: await decryptToken(env, VAPID_VAULT_IDENTITY, parsed.privateKey) };
}

function webPushContact(env: Env): string {
  const configured = env.WEB_PUSH_CONTACT?.trim();
  if (configured && /^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/.test(configured)) return configured;
  return env.APP_ORIGIN.startsWith('https://') ? env.APP_ORIGIN : 'mailto:webpush@localhost';
}

interface DeviceRow { id: string; user_id: string; kind: NotificationDeviceKind; endpoint: string; p256dh: string | null; auth: string | null }
interface Push { device: DeviceRow; payload: NotificationPayload }
interface Notified { userId: string; notification: PikibunNotification }

async function liveDevices(env: Env, userIds: readonly string[]): Promise<DeviceRow[]> {
  if (!userIds.length) return [];
  return env.DB.query<DeviceRow>(`SELECT d.id, d.user_id, d.kind, d.endpoint, d.p256dh, d.auth FROM notification_devices d
    JOIN auth_sessions a ON a.token_hash = d.auth_token_hash AND a.user_id = d.user_id
    WHERE d.user_id IN (SELECT value FROM json_each(?)) AND a.expires_at > ?`).bind(JSON.stringify([...new Set(userIds)]), Date.now()).all();
}

const feedReads = new WeakMap<object, Map<string, number>>();
function heardFeed(env: Env, userId: string): void {
  let reads = feedReads.get(env.DB);
  if (!reads) feedReads.set(env.DB, reads = new Map());
  reads.set(userId, Date.now());
}
function readsFeed(env: Env, userId: string, at: number): boolean {
  const last = feedReads.get(env.DB)?.get(userId);
  return last !== undefined && at - last < FEED_LISTENING_MS;
}

const inFlight = new Set<Promise<unknown>>();
export async function settleNotificationDeliveries(withinMs = Infinity): Promise<void> {
  const deadline = Date.now() + withinMs;
  while (inFlight.size && Date.now() < deadline) {
    const settled = Promise.allSettled([...inFlight]);
    await (Number.isFinite(deadline) ? Promise.race([settled, sleep(deadline - Date.now(), undefined, { ref: false })]) : settled);
  }
}

let activePushes = 0;
const waitingPushes: (() => void)[] = [];
async function withPushSlot<T>(send: () => Promise<T>): Promise<T> {
  if (activePushes < MAX_CONCURRENT_PUSHES) activePushes++;
  else await new Promise<void>(resolve => { waitingPushes.push(resolve); });
  try { return await send(); } finally {
    const next = waitingPushes.shift();
    if (next) next();
    else activePushes--;
  }
}
function background(work: Promise<unknown>): void {
  const tracked = work.catch(() => {}).finally(() => inFlight.delete(tracked));
  inFlight.add(tracked);
}

async function notify(env: Env, items: Notified[], options: { everywhere?: boolean; forwarded?: boolean } = {}): Promise<NotificationDelivery> {
  if (!items.length) return { web: 0, expo: 0 };
  const at = Date.now();
  const devices = await liveDevices(env, items.map(item => item.userId));
  const has = (userId: string, kind: NotificationDeviceKind) => devices.some(device => device.user_id === userId && device.kind === kind);
  const waits = (userId: string) => !options.everywhere && has(userId, 'expo') && (has(userId, 'web') || readsFeed(env, userId, at));
  const cutoff = new Date(at - NOTIFICATION_FEED_RETENTION_MS).toISOString();
  await env.DB.batch(items.flatMap(({ userId, notification: n }) => [
    env.DB.query('DELETE FROM notifications WHERE user_id = ? AND created_at < ?').bind(userId, cutoff),
    env.DB.query(`INSERT INTO notifications (id, user_id, session_id, forwarded_session_id, kind, title, body, created_at, push_at, pushed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(n.id, userId, options.forwarded ? null : n.sessionId ?? null, options.forwarded ? n.sessionId ?? null : null, n.kind, n.title, n.body, n.createdAt,
        !has(userId, 'expo') || options.everywhere ? null : new Date(at + (waits(userId) ? PHONE_PUSH_WAIT_MS : PHONE_PUSH_RETRY_MS)).toISOString(), null),
  ]));
  const delivery = deliver(env, items, devices.filter(device => device.kind === 'web' || !waits(device.user_id)), at);
  if (options.everywhere) return delivery;
  background(delivery);
  return { web: 0, expo: 0 };
}

function payloadsFrom(env: Env): ((notification: PikibunNotification) => NotificationPayload) | null {
  let origin: string;
  try { origin = appOrigin(env); } catch { return null; }
  return notification => ({ ...notification, origin, path: notificationPath(notification) });
}

async function deliver(env: Env, items: Notified[], devices: DeviceRow[], at: number): Promise<NotificationDelivery> {
  const payloadFor = devices.length ? payloadsFrom(env) : null;
  if (!payloadFor) return { web: 0, expo: 0 };
  const forUser = new Map(items.map(item => [item.userId, item.notification]));
  const pushes = devices.map(device => ({ device, payload: payloadFor(forUser.get(device.user_id)!) }));
  const [web, expo] = await Promise.all([
    sendWebPushes(env, pushes.filter(push => push.device.kind === 'web')),
    sendPhonePushes(env, pushes.filter(push => push.device.kind === 'expo'), at),
  ]);
  return { web, expo };
}

async function sendPhonePushes(env: Env, pushes: Push[], at: number): Promise<number> {
  if (!pushes.length) return 0;
  const { accepted, unanswered } = await sendExpoPushes(env, pushes);
  const answered = [...new Set(pushes.map(push => push.payload.id))].filter(id => !unanswered.has(id));
  if (answered.length) {
    await env.DB.query('UPDATE notifications SET push_at = NULL, pushed_at = ? WHERE id IN (SELECT value FROM json_each(?)) AND handled_at IS NULL')
      .bind(new Date(at).toISOString(), JSON.stringify(answered)).run();
  }
  return accepted;
}

interface DueRow { id: string; user_id: string; kind: NotificationKind; title: string; body: string; session_id: string | null; forwarded_session_id: string | null; created_at: string }

async function sendDuePhonePushes(env: Env, at: number): Promise<number> {
  const due = new Date(at).toISOString();
  await env.DB.batch([
    env.DB.query('UPDATE notifications SET push_at = NULL WHERE push_at IS NOT NULL AND push_at <= ? AND created_at < ?').bind(due, new Date(at - PHONE_PUSH_GIVE_UP_MS).toISOString()),
    env.DB.query(`UPDATE notifications SET push_at = NULL, handled_at = ? WHERE push_at IS NOT NULL AND push_at <= ? AND kind = 'approval' AND (
      (session_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = notifications.session_id AND s.activity = 'waiting'))
      OR (forwarded_session_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM forwarded_sessions f
        WHERE f.session_id = notifications.forwarded_session_id AND f.user_id = notifications.user_id AND f.activity = 'waiting')))`).bind(due, due),
  ]);
  const rows = await env.DB.query<DueRow>(`UPDATE notifications SET push_at = ? WHERE push_at IS NOT NULL AND push_at <= ?
    RETURNING id, user_id, kind, title, body, session_id, forwarded_session_id, created_at`).bind(new Date(at + PHONE_PUSH_RETRY_MS).toISOString(), due).all();
  if (!rows.length) return 0;
  const payloadFor = payloadsFrom(env);
  if (!payloadFor) return 0;
  const devices = (await liveDevices(env, rows.map(row => row.user_id))).filter(device => device.kind === 'expo');
  const pushes = rows.flatMap(row => {
    const sessionId = row.session_id ?? row.forwarded_session_id;
    const payload = payloadFor({ id: row.id, kind: row.kind, title: row.title, body: row.body, ...(sessionId ? { sessionId } : {}), createdAt: row.created_at });
    return devices.filter(device => device.user_id === row.user_id).map(device => ({ device, payload }));
  });
  const nobody = rows.filter(row => !devices.some(device => device.user_id === row.user_id)).map(row => row.id);
  if (nobody.length) await env.DB.query('UPDATE notifications SET push_at = NULL WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(nobody)).run();
  return sendPhonePushes(env, pushes, at);
}

export function runPhonePushes(env: Env, at = Date.now()): Promise<number> {
  const work = sendDuePhonePushes(env, at);
  background(work);
  return work;
}

async function forgetDevices(env: Env, ids: string[]): Promise<void> {
  if (ids.length) await env.DB.query('DELETE FROM notification_devices WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(ids)).run();
}

async function sendWebPushes(env: Env, pushes: Push[]): Promise<number> {
  if (!pushes.length) return 0;
  const keys = await webPushKeys(env);
  if (!keys) return 0;
  const contact = webPushContact(env);
  const gone: string[] = [];
  const results = await Promise.allSettled(pushes.map(({ device, payload }) => withPushSlot(async () => {
    if (!allowedPushEndpoint(device.endpoint) || !device.p256dh || !device.auth) { gone.push(device.id); return false; }
    const body = encryptPushPayload(new TextEncoder().encode(JSON.stringify(payload)), device.p256dh, device.auth);
    const response = await fetch(device.endpoint, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(PUSH_TIMEOUT_MS), body,
      headers: {
        Authorization: vapidAuthorization(device.endpoint, contact, keys), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
        TTL: payload.kind === 'approval' ? '86400' : '14400', Urgency: payload.kind === 'approval' ? 'high' : 'normal',
        ...(payload.sessionId ? { Topic: createHash('sha256').update(payload.sessionId).digest('base64url').slice(0, 32) } : {}),
      },
    });
    await response.body?.cancel().catch(() => {});
    if (response.status === 404 || response.status === 410) gone.push(device.id);
    return response.ok;
  })));
  await forgetDevices(env, gone);
  return results.filter(result => result.status === 'fulfilled' && result.value).length;
}

async function sendExpoPushes(env: Env, pushes: Push[]): Promise<{ accepted: number; unanswered: Set<string> }> {
  const batches: Push[][] = [];
  for (let start = 0; start < pushes.length; start += EXPO_BATCH) batches.push(pushes.slice(start, start + EXPO_BATCH));
  const gone: string[] = [];
  const unanswered = new Set<string>();
  const lost = (batch: Push[]) => {
    for (const { payload } of batch) unanswered.add(payload.id);
    return 0;
  };
  const sent = await Promise.all(batches.map(batch => withPushSlot(async () => {
    try {
      const response = await fetch(EXPO_PUSH_URL, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(env.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${env.EXPO_ACCESS_TOKEN}` } : {}) },
        body: JSON.stringify(batch.map(({ device, payload }) => ({
          to: device.endpoint, title: payload.title, body: payload.body, data: payload, sound: 'default',
          priority: payload.kind === 'approval' ? 'high' : 'default', ttl: payload.kind === 'approval' ? 86400 : 14400,
          ...(payload.sessionId ? { threadId: payload.sessionId } : {}),
        }))),
      });
      if (!response.ok) { await response.body?.cancel().catch(() => {}); return lost(batch); }
      const tickets = (await response.json() as { data?: unknown }).data;
      if (!Array.isArray(tickets)) return lost(batch);
      let accepted = 0;
      batch.forEach(({ device, payload }, index) => {
        const ticket = tickets[index] as { status?: unknown; details?: { error?: unknown } } | null | undefined;
        if (ticket?.status === 'ok') accepted++;
        else if (ticket?.details?.error === 'DeviceNotRegistered') gone.push(device.id);
        else if (ticket?.details?.error !== 'MessageTooBig') unanswered.add(payload.id);
      });
      return accepted;
    } catch {
      return lost(batch);
    }
  })));
  await forgetDevices(env, gone);
  return { accepted: sent.reduce((total, accepted) => total + accepted, 0), unanswered };
}

export async function notifySessionActivity(env: Env, row: Pick<SessionRow, 'id' | 'title' | 'owner_id' | 'workspace_id'>, previous: SessionActivity | null | undefined,
  activity: SessionActivity, forwarded = false): Promise<void> {
  const kind = activityNotification(previous, activity);
  if (!kind) return;
  const sender = forwarded ? null : await env.DB.query<{ actor_id: string }>(`SELECT actor_id FROM run_admissions WHERE session_id = ? AND mode = 'write' AND created_at > ?
    ORDER BY created_at DESC LIMIT 1`).bind(row.id, new Date(Date.now() - SENDER_WINDOW_MS).toISOString()).first('actor_id');
  const candidates = [...new Set([row.owner_id, ...(sender ? [sender] : [])])];
  const workspace = await env.DB.query<{ name: string }>('SELECT name FROM workspaces WHERE id = ?').bind(row.workspace_id).first('name');
  const items: Notified[] = [];
  const at = Date.now();
  for (const userId of candidates) {
    if (!forwarded && !await sessionAccess(env, row.id, userId)) continue;
    const preferences = await notificationPreferences(env, userId);
    if (!preferences[preferenceOf[kind]]) continue;
    const { title, body } = notificationText(kind, preferences.details, { title: row.title, workspace: workspace ?? '' });
    items.push({ userId, notification: { id: notificationId(at), kind, title, body, sessionId: row.id, createdAt: new Date(at).toISOString() } });
  }
  await notify(env, items, { forwarded });
}

function preferencesInput(input: Record<string, unknown>, current: NotificationPreferences): NotificationPreferences {
  const keys = Object.keys(defaultNotificationPreferences) as (keyof NotificationPreferences)[];
  if (!Object.keys(input).length || Object.keys(input).some(key => !(keys as string[]).includes(key))) fail(400, 'invalid_input', 'Invalid notification preferences.');
  const next = { ...current };
  for (const key of keys) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'boolean') fail(400, 'invalid_input', `Invalid ${key}.`);
    next[key] = input[key];
  }
  return next;
}

async function devicesOf(c: AppContext): Promise<NotificationDevice[]> {
  const auth = c.get('auth');
  const rows = await c.env.DB.query<{ id: string; kind: NotificationDeviceKind; name: string | null; created_at: string; auth_token_hash: string }>(
    `SELECT d.id, d.kind, d.name, d.created_at, d.auth_token_hash FROM notification_devices d
    JOIN auth_sessions a ON a.token_hash = d.auth_token_hash AND a.user_id = d.user_id
    WHERE d.user_id = ? AND a.expires_at > ? ORDER BY d.created_at DESC, d.id`).bind(auth.userId, Date.now()).all();
  return rows.map(row => ({ id: row.id, kind: row.kind, name: row.name, createdAt: row.created_at, current: row.auth_token_hash === auth.tokenHash }));
}

interface DeviceInput { kind: NotificationDeviceKind; endpoint: string; p256dh: string | null; auth: string | null; name: string | null }

function deviceInput(input: Record<string, unknown>): DeviceInput {
  if (input.kind !== 'web' && input.kind !== 'expo') fail(400, 'invalid_input', 'Invalid device kind.');
  if (Object.keys(input).some(key => !(input.kind === 'web' ? ['kind', 'endpoint', 'keys', 'name'] : ['kind', 'token', 'name']).includes(key))) fail(400, 'invalid_input', 'Invalid device.');
  const name = input.name === undefined || input.name === null ? null : oneLine(text(input.name, 'name', 100), 100) || null;
  if (input.kind === 'expo') {
    const token = text(input.token, 'token', 256);
    if (!EXPO_TOKEN.test(token)) fail(400, 'invalid_input', 'Invalid push token.');
    return { kind: 'expo', endpoint: token, p256dh: null, auth: null, name };
  }
  const endpoint = text(input.endpoint, 'endpoint', 1024);
  if (!allowedPushEndpoint(endpoint)) fail(400, 'unsupported_push_service', 'This browser\'s push service isn\'t one Pikibun sends to.');
  const keys = input.keys as Record<string, unknown> | undefined;
  const p256dh = typeof keys?.p256dh === 'string' ? keys.p256dh.replace(/=+$/, '') : '';
  const auth = typeof keys?.auth === 'string' ? keys.auth.replace(/=+$/, '') : '';
  if (!validP256Point(p256dh) || !/^[A-Za-z0-9_-]{22}$/.test(auth)) fail(400, 'invalid_input', 'Invalid subscription keys.');
  return { kind: 'web', endpoint, p256dh, auth, name };
}

const handledBody = fields({
  ids: z.array(z.string().regex(NOTIFICATION_ID, 'Invalid notification.'), { error: 'Invalid notifications.' }).min(1, 'Invalid notifications.')
    .max(MAX_HANDLED_NOTIFICATIONS, 'Too many notifications.'),
}, 'Only ids is accepted.', { required: ['ids'] });

export function registerNotifications(app: Hono<AppEnv>): void {
  app.get('/api/notifications/config', async c => {
    const userId = c.get('auth').userId;
    const keys = await webPushKeys(c.env);
    const config: NotificationConfig = { preferences: await notificationPreferences(c.env, userId), webPushKey: keys?.publicKey ?? null, devices: await devicesOf(c) };
    return c.json(config);
  });

  app.put('/api/notifications/preferences', async c => {
    const userId = c.get('auth').userId;
    const next = preferencesInput(await jsonObject(c, 1024), await notificationPreferences(c.env, userId));
    await c.env.DB.query(`INSERT INTO notification_preferences (user_id, approvals, finished, failed, details, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id) DO UPDATE SET approvals = excluded.approvals, finished = excluded.finished, failed = excluded.failed,
      details = excluded.details, updated_at = excluded.updated_at`)
      .bind(userId, Number(next.approvals), Number(next.finished), Number(next.failed), Number(next.details), now()).run();
    return c.json({ preferences: next });
  });

  app.post('/api/notifications/devices', async c => {
    const auth = c.get('auth');
    const device = deviceInput(await jsonObject(c, 4096));
    if (device.kind === 'web' && !await webPushKeys(c.env)) fail(503, 'web_push_unavailable', 'This server can\'t send Web Push: it needs a VAULT_KEY.');
    await c.env.DB.query(`INSERT INTO notification_devices (id, user_id, auth_token_hash, kind, endpoint, p256dh, auth, name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, auth_token_hash = excluded.auth_token_hash, kind = excluded.kind,
        p256dh = excluded.p256dh, auth = excluded.auth, name = excluded.name, created_at = excluded.created_at`)
      .bind(randomToken().slice(0, 24), auth.userId, auth.tokenHash, device.kind, device.endpoint, device.p256dh, device.auth, device.name, now()).run();
    if (device.kind === 'expo') {
      await c.env.DB.query('DELETE FROM notification_devices WHERE kind = ? AND auth_token_hash = ? AND endpoint <> ?').bind('expo', auth.tokenHash, device.endpoint).run();
    }
    await c.env.DB.query(`DELETE FROM notification_devices WHERE user_id = ? AND id NOT IN (
      SELECT id FROM notification_devices WHERE user_id = ? ORDER BY created_at DESC, id LIMIT ?)`).bind(auth.userId, auth.userId, MAX_DEVICES).run();
    const id = await c.env.DB.query<{ id: string }>('SELECT id FROM notification_devices WHERE endpoint = ? AND user_id = ?').bind(device.endpoint, auth.userId).first('id');
    const registered = (await devicesOf(c)).find(item => item.id === id);
    if (!registered) fail(409, 'device_unavailable', 'The device could not be registered.');
    return c.json({ device: registered }, 201);
  });

  app.delete('/api/notifications/devices/:id', async c => {
    const removed = await c.env.DB.query('DELETE FROM notification_devices WHERE id = ? AND user_id = ? RETURNING id')
      .bind(identifier(c.req.param('id'), 'deviceId'), c.get('auth').userId).first();
    if (!removed) fail(404, 'not_found', 'Device not found.');
    return c.json({ ok: true });
  });

  app.post('/api/notifications/test', async c => {
    const userId = c.get('auth').userId;
    const at = Date.now();
    const notification: PikibunNotification = { id: notificationId(at), kind: 'test', ...notificationText('test', true), createdAt: new Date(at).toISOString() };
    const delivered = await notify(c.env, [{ userId, notification }], { everywhere: true });
    return c.json({ notification, delivered });
  });

  app.post('/api/notifications/handled', async c => {
    const { ids } = await requestBody(c, handledBody, { maxBytes: 4096 });
    const taken = await c.env.DB.query<{ id: string }>(`UPDATE notifications SET handled_at = ?, push_at = NULL
      WHERE user_id = ? AND id IN (SELECT value FROM json_each(?)) AND handled_at IS NULL AND pushed_at IS NULL RETURNING id`)
      .bind(now(), c.get('auth').userId, JSON.stringify([...new Set(ids)])).all();
    return c.json({ handled: taken.map(row => row.id) });
  });

  app.get('/api/notifications/feed', async c => {
    const userId = c.get('auth').userId;
    heardFeed(c.env, userId);
    const after = c.req.query('after');
    if (after === undefined) {
      const latest = await c.env.DB.query<{ id: string }>('SELECT id FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 1').bind(userId).first('id');
      const feed: NotificationFeed = { notifications: [], cursor: latest ?? `${feedTime(Date.now())}-` };
      return c.json(feed);
    }
    if (!FEED_CURSOR.test(after)) fail(400, 'invalid_input', 'Invalid cursor.');
    const rows = await c.env.DB.query<{ id: string; kind: NotificationKind; title: string; body: string; session_id: string | null; created_at: string; pushed_at: string | null }>(
      `SELECT id, kind, title, body, COALESCE(session_id, forwarded_session_id) AS session_id, created_at, pushed_at FROM notifications WHERE user_id = ? AND id > ? ORDER BY id LIMIT ?`)
      .bind(userId, after, FEED_LIMIT).all();
    const notifications = rows.map((row): FeedNotification => ({ id: row.id, kind: row.kind, title: row.title, body: row.body, ...(row.session_id ? { sessionId: row.session_id } : {}),
      createdAt: row.created_at, ...(row.pushed_at ? { pushed: true } : {}) }));
    const feed: NotificationFeed = { notifications, cursor: notifications.at(-1)?.id ?? after };
    return c.json(feed);
  });
}

export function notifySessionActivityQuietly(env: Env, row: Pick<SessionRow, 'id' | 'title' | 'owner_id' | 'workspace_id'>, previous: SessionActivity | null | undefined,
  activity: SessionActivity): Promise<void> {
  return notifySessionActivity(env, row, previous, activity).catch(() => {});
}
