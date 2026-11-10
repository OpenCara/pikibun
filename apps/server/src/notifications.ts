import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Hono } from 'hono';
import type { AppContext, Env, SessionRow, AppEnv } from './types.js';
import { decryptToken, encryptToken, sessionAccess } from './authority/index.js';
import { appOrigin, fail, identifier, jsonObject, now, randomToken, text } from './http.js';
import { allowedPushEndpoint, encryptPushPayload, generateVapidKeys, validP256Point, vapidAuthorization, type VapidKeys } from './web-push.js';
import {
  defaultNotificationPreferences, NOTIFICATION_FEED_RETENTION_MS, notificationPath, type NotificationConfig, type NotificationDevice, type NotificationFeed,
  type NotificationKind, type NotificationPayload, type NotificationPreferences, type PikibunNotification,
} from '../../../packages/shared/src/notifications.js';
import type { SessionActivity } from '../../../packages/shared/src/types.js';

/**
 * Notifications (docs/notifications.md). When a host reports that a session's agent started waiting for an approval,
 * or finished or failed the work it was doing, the session's owner and whoever sent it its latest message (while they
 * can still read the session) are notified, as each of them chose (NotificationPreferences):
 *
 * - in their notification feed, which open web pages and desktop windows poll and show as system notifications;
 * - through Web Push, to each browser they turned notifications on in.
 *
 * A device belongs to the sign-in that registered it (`auth_token_hash`): signing out, the sign-in expiring, or signing
 * an app out from the web stops its notifications. Push endpoints are the client's to give, so the server sends Web
 * Push only to the browsers' own push services (web-push.ts allowedPushEndpoint).
 */

/** A person's devices beyond this many: the oldest registrations go. */
const MAX_DEVICES = 20;
const FEED_LIMIT = 50;
/** Who sent a session its latest message is only worth notifying while that message can still be the one at work. */
const SENDER_WINDOW_MS = 24 * 60 * 60 * 1000;
const PUSH_TIMEOUT_MS = 10_000;
const MAX_CONCURRENT_PUSHES = 16;
const VAPID_KEY_NAME = 'web-push-vapid';
const VAPID_VAULT_IDENTITY = 'server:web-push';

/** The notification an activity change brings, if any: only a change the agent made, not one a host merely restated. */
export function activityNotification(previous: SessionActivity | null | undefined, next: SessionActivity): Exclude<NotificationKind, 'test'> | null {
  if (previous === next) return null;
  if (next === 'waiting') return 'approval';
  // Done or failed after the agent worked (or waited on a card): what it was doing ended. A host that comes back and
  // reports a session it had settled before (from idle or nothing) tells nothing new.
  if (previous !== 'working' && previous !== 'waiting') return null;
  if (next === 'done') return 'finished';
  if (next === 'failed') return 'failed';
  return null;
}

const preferenceOf: Record<Exclude<NotificationKind, 'test'>, keyof NotificationPreferences> = { approval: 'approvals', finished: 'finished', failed: 'failed' };

/** What a notification says: the session's title and workspace where the person shows them, else only what happened. */
export function notificationText(kind: NotificationKind, details: boolean, session?: { title: string; workspace: string }): { title: string; body: string } {
  if (kind === 'test') return { title: 'Pikibun', body: 'Notifications work on this device.' };
  const event = { approval: 'Waiting for an approval', finished: 'Finished', failed: 'Stopped on an error' }[kind];
  if (!details || !session) {
    return { title: 'Pikibun', body: { approval: 'A session is waiting for an approval.', finished: 'A session finished.', failed: 'A session stopped on an error.' }[kind] };
  }
  return { title: oneLine(session.title, 120) || 'Untitled session', body: `${event} · ${oneLine(session.workspace, 80)}` };
}

const oneLine = (value: string, max: number) => {
  const line = value.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** Notification ids sort by when they were made, so the feed's cursor is the last id a page has seen. */
function notificationId(at: number): string {
  return `${feedTime(at)}-${randomToken().slice(0, 12)}`;
}
const feedTime = (at: number) => Math.max(0, Math.floor(at)).toString(36).padStart(10, '0');
const FEED_CURSOR = /^[0-9a-z]{10}-[A-Za-z0-9_-]{0,12}$/;

export async function notificationPreferences(env: Env, userId: string): Promise<NotificationPreferences> {
  const row = await env.DB.query<{ approvals: number; finished: number; failed: number; details: number }>(
    'SELECT approvals, finished, failed, details FROM notification_preferences WHERE user_id = ?').bind(userId).first();
  if (!row) return { ...defaultNotificationPreferences };
  return { approvals: Number(row.approvals) === 1, finished: Number(row.finished) === 1, failed: Number(row.failed) === 1, details: Number(row.details) === 1 };
}

// The server's Web Push key pair, made once and kept with its private half sealed by the vault; per database, since a
// process may serve several in tests.
const vapidCache = new WeakMap<object, Promise<VapidKeys | null>>();

/** The VAPID keys, or null where the server can't keep them (no usable VAULT_KEY), and so sends no Web Push. */
export function webPushKeys(env: Env): Promise<VapidKeys | null> {
  let keys = vapidCache.get(env.DB);
  if (!keys) {
    keys = loadVapidKeys(env).catch(() => null);
    vapidCache.set(env.DB, keys);
    // A failure isn't kept: the vault may be configured by the next request.
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
    // Two servers starting at once make one pair between them.
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

interface DeviceRow { id: string; user_id: string; endpoint: string; p256dh: string; auth: string }

/** The devices of `userIds` whose sign-ins are still valid. */
async function liveDevices(env: Env, userIds: readonly string[]): Promise<DeviceRow[]> {
  if (!userIds.length) return [];
  return env.DB.query<DeviceRow>(`SELECT d.id, d.user_id, d.endpoint, d.p256dh, d.auth FROM notification_devices d
    JOIN auth_sessions a ON a.token_hash = d.auth_token_hash AND a.user_id = d.user_id
    WHERE d.kind = 'web' AND d.user_id IN (SELECT value FROM json_each(?)) AND a.expires_at > ?`).bind(JSON.stringify([...new Set(userIds)]), Date.now()).all();
}

// Pushes still on their way, so tests (and a server shutting down) can wait for them: activity reports don't.
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

export interface DeliveryCount { web: number }

/**
 * Records `notification` in each person's feed and pushes it to their devices. Pushes go on in the background unless
 * `wait`; what comes back counts the devices a push service accepted it for.
 */
async function notify(env: Env, items: { userId: string; notification: PikibunNotification }[], options: { wait?: boolean } = {}): Promise<DeliveryCount> {
  if (!items.length) return { web: 0 };
  const cutoff = new Date(Date.now() - NOTIFICATION_FEED_RETENTION_MS).toISOString();
  await env.DB.batch(items.flatMap(({ userId, notification: n }) => [
    env.DB.query('DELETE FROM notifications WHERE user_id = ? AND created_at < ?').bind(userId, cutoff),
    env.DB.query('INSERT INTO notifications (id, user_id, session_id, kind, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(n.id, userId, n.sessionId ?? null, n.kind, n.title, n.body, n.createdAt),
  ]));
  const delivery = deliver(env, items);
  if (options.wait) return delivery;
  background(delivery);
  return { web: 0 };
}

async function deliver(env: Env, items: { userId: string; notification: PikibunNotification }[]): Promise<DeliveryCount> {
  const devices = await liveDevices(env, items.map(item => item.userId));
  if (!devices.length) return { web: 0 };
  let origin: string;
  try { origin = appOrigin(env); } catch { return { web: 0 }; }
  const payloadFor = (notification: PikibunNotification): NotificationPayload => ({ ...notification, origin, path: notificationPath(notification) });
  const forUser = new Map(items.map(item => [item.userId, item.notification]));
  return { web: await sendWebPushes(env, devices.map(device => ({ device, payload: payloadFor(forUser.get(device.user_id)!) }))) };
}

async function forgetDevices(env: Env, ids: string[]): Promise<void> {
  if (ids.length) await env.DB.query('DELETE FROM notification_devices WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(ids)).run();
}

/** Web Push to each browser; a push service that no longer knows a subscription (404, 410) has it removed. */
async function sendWebPushes(env: Env, pushes: { device: DeviceRow; payload: NotificationPayload }[]): Promise<number> {
  const keys = await webPushKeys(env);
  if (!keys) return 0;
  const contact = webPushContact(env);
  const gone: string[] = [];
  const results = await Promise.allSettled(pushes.map(({ device, payload }) => withPushSlot(async () => {
    if (!allowedPushEndpoint(device.endpoint)) { gone.push(device.id); return false; }
    const body = encryptPushPayload(new TextEncoder().encode(JSON.stringify(payload)), device.p256dh, device.auth);
    const response = await fetch(device.endpoint, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(PUSH_TIMEOUT_MS), body,
      headers: {
        Authorization: vapidAuthorization(device.endpoint, contact, keys), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
        // An approval waits for someone; a result can wait a little and is stale after a few hours.
        TTL: payload.kind === 'approval' ? '86400' : '14400', Urgency: payload.kind === 'approval' ? 'high' : 'normal',
        // A newer notification about the same session replaces one the browser hasn't fetched yet.
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

/**
 * A host reported `activity` for `row`, whose activity was `previous`: notifies the people it concerns, if it is a
 * change worth telling (activityNotification). Pushes go on in the background; the report doesn't wait for them.
 */
export async function notifySessionActivity(env: Env, row: Pick<SessionRow, 'id' | 'title' | 'owner_id' | 'workspace_id'>, previous: SessionActivity | null | undefined,
  activity: SessionActivity): Promise<void> {
  const kind = activityNotification(previous, activity);
  if (!kind) return;
  const sender = await env.DB.query<{ actor_id: string }>(`SELECT actor_id FROM run_admissions WHERE session_id = ? AND mode = 'write' AND created_at > ?
    ORDER BY created_at DESC LIMIT 1`).bind(row.id, new Date(Date.now() - SENDER_WINDOW_MS).toISOString()).first('actor_id');
  const candidates = [...new Set([row.owner_id, ...(sender ? [sender] : [])])];
  const workspace = await env.DB.query<{ name: string }>('SELECT name FROM workspaces WHERE id = ?').bind(row.workspace_id).first('name');
  const items: { userId: string; notification: PikibunNotification }[] = [];
  const at = Date.now();
  for (const userId of candidates) {
    // Only people who can still read the session hear about it, as its title is in the notification.
    if (!await sessionAccess(env, row.id, userId)) continue;
    const preferences = await notificationPreferences(env, userId);
    if (!preferences[preferenceOf[kind]]) continue;
    const { title, body } = notificationText(kind, preferences.details, { title: row.title, workspace: workspace ?? '' });
    items.push({ userId, notification: { id: notificationId(at), kind, title, body, sessionId: row.id, createdAt: new Date(at).toISOString() } });
  }
  await notify(env, items);
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
  const rows = await c.env.DB.query<{ id: string; name: string | null; created_at: string; auth_token_hash: string }>(
    `SELECT d.id, d.name, d.created_at, d.auth_token_hash FROM notification_devices d
    JOIN auth_sessions a ON a.token_hash = d.auth_token_hash AND a.user_id = d.user_id
    WHERE d.kind = 'web' AND d.user_id = ? AND a.expires_at > ? ORDER BY d.created_at DESC, d.id`).bind(auth.userId, Date.now()).all();
  return rows.map(row => ({ id: row.id, kind: 'web', name: row.name, createdAt: row.created_at, current: row.auth_token_hash === auth.tokenHash }));
}

function deviceInput(input: Record<string, unknown>): { endpoint: string; p256dh: string; auth: string; name: string | null } {
  if (input.kind !== 'web') fail(400, 'invalid_input', 'Invalid device kind.');
  if (Object.keys(input).some(key => !['kind', 'endpoint', 'keys', 'name'].includes(key))) fail(400, 'invalid_input', 'Invalid device.');
  const name = input.name === undefined || input.name === null ? null : oneLine(text(input.name, 'name', 100), 100) || null;
  const endpoint = text(input.endpoint, 'endpoint', 1024);
  if (!allowedPushEndpoint(endpoint)) fail(400, 'unsupported_push_service', 'This browser\'s push service isn\'t one Pikibun sends to.');
  const keys = input.keys as Record<string, unknown> | undefined;
  const p256dh = typeof keys?.p256dh === 'string' ? keys.p256dh.replace(/=+$/, '') : '';
  const auth = typeof keys?.auth === 'string' ? keys.auth.replace(/=+$/, '') : '';
  if (!validP256Point(p256dh) || !/^[A-Za-z0-9_-]{22}$/.test(auth)) fail(400, 'invalid_input', 'Invalid subscription keys.');
  return { endpoint, p256dh, auth, name };
}

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

  // Registering a device again (the page loads, the app starts) moves it to this sign-in, and to this person: a browser
  // or phone gets the notifications of whoever signed in on it last.
  app.post('/api/notifications/devices', async c => {
    const auth = c.get('auth');
    const device = deviceInput(await jsonObject(c, 4096));
    if (!await webPushKeys(c.env)) fail(503, 'web_push_unavailable', 'This server can\'t send Web Push: it needs a VAULT_KEY.');
    await c.env.DB.query(`INSERT INTO notification_devices (id, user_id, auth_token_hash, kind, endpoint, p256dh, auth, name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, auth_token_hash = excluded.auth_token_hash, kind = excluded.kind,
        p256dh = excluded.p256dh, auth = excluded.auth, name = excluded.name, created_at = excluded.created_at`)
      .bind(randomToken().slice(0, 24), auth.userId, auth.tokenHash, 'web', device.endpoint, device.p256dh, device.auth, device.name, now()).run();
    // The oldest go beyond MAX_DEVICES.
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

  // A notification to every device of the person who asks, to check that they arrive.
  app.post('/api/notifications/test', async c => {
    const userId = c.get('auth').userId;
    const at = Date.now();
    const notification: PikibunNotification = { id: notificationId(at), kind: 'test', ...notificationText('test', true), createdAt: new Date(at).toISOString() };
    const delivered = await notify(c.env, [{ userId, notification }], { wait: true });
    return c.json({ notification, delivered });
  });

  // The notifications after `after`, for open pages and windows to show. Without `after`: none, and the cursor to start
  // from, so a page that opens doesn't show what came before it.
  app.get('/api/notifications/feed', async c => {
    const userId = c.get('auth').userId;
    const after = c.req.query('after');
    if (after === undefined) {
      // After their latest notification; with none, after now.
      const latest = await c.env.DB.query<{ id: string }>('SELECT id FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 1').bind(userId).first('id');
      const feed: NotificationFeed = { notifications: [], cursor: latest ?? `${feedTime(Date.now())}-` };
      return c.json(feed);
    }
    if (!FEED_CURSOR.test(after)) fail(400, 'invalid_input', 'Invalid cursor.');
    const rows = await c.env.DB.query<{ id: string; kind: NotificationKind; title: string; body: string; session_id: string | null; created_at: string }>(
      `SELECT id, kind, title, body, session_id, created_at FROM notifications WHERE user_id = ? AND id > ? ORDER BY id LIMIT ?`)
      .bind(userId, after, FEED_LIMIT).all();
    const notifications = rows.map(row => ({ id: row.id, kind: row.kind, title: row.title, body: row.body, ...(row.session_id ? { sessionId: row.session_id } : {}),
      createdAt: row.created_at }));
    const feed: NotificationFeed = { notifications, cursor: notifications.at(-1)?.id ?? after };
    return c.json(feed);
  });
}

/**
 * For the activity report, which must not fail because a notification did: logs nothing either, since what went wrong
 * may name a session.
 */
export function notifySessionActivityQuietly(env: Env, row: Pick<SessionRow, 'id' | 'title' | 'owner_id' | 'workspace_id'>, previous: SessionActivity | null | undefined,
  activity: SessionActivity): Promise<void> {
  return notifySessionActivity(env, row, previous, activity).catch(() => {});
}
