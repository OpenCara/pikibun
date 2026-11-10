import type { AddressInfo } from 'node:net';
import { createAdaptorServer } from '@hono/node-server';
import type { ServerConfig } from './config.js';
import { rejectUpgrade } from './connector-hub.js';
import { connectorError } from './connector-transport.js';
import { authenticateConnectorSocket, refreshPullRequestStates, settlePushCredentials } from './authority/index.js';
import type { Database } from './db/types.js';
import { lockInstance, type InstanceLock } from './db/index.js';
import { settleNotificationDeliveries } from './notifications.js';
import { requestUrl, trustForwardedHeaders } from './forwarded.js';
import { app } from './index.js';
import { createStaticHandler } from './static.js';
import { runAutomaticBackups } from './automatic-backups.js';
import { runScheduledPrompts } from './scheduled-prompts.js';
import { runCrossSessionNotifications } from './cross-session.js';

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  if ('code' in error && typeof error.code === 'string') return error.code;
  if ('cause' in error) return errorCode(error.cause);
  return undefined;
}

const NOTIFICATION_DRAIN_MS = 15_000;
const transientDatabaseCodes = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', '57P03'];

async function whenReachable<T>(provider: Database['provider'], work: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + Number(process.env.DATABASE_WAIT_SECONDS || 60) * 1000;
  for (let attempt = 1; ; attempt++) {
    try { return await work(); } catch (error) {
      const code = errorCode(error);
      if (!code || !transientDatabaseCodes.includes(code) || Date.now() >= deadline) throw error;
      if (attempt === 1) console.error(`pikibun: waiting for the ${provider} database (${code})`);
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, Math.min(5000, 500 * attempt));
      await promise;
    }
  }
}

export function migrateWhenReachable(db: Pick<Database, 'migrate' | 'provider'>): Promise<void> {
  return whenReachable(db.provider, () => db.migrate());
}

async function lockThenMigrate(db: Database): Promise<InstanceLock> {
  const lock = await whenReachable(db.provider, () => lockInstance(db));
  try {
    await migrateWhenReachable(db);
    return lock;
  } catch (error) {
    await lock.release();
    throw error;
  }
}

function sweep(name: string, ms: number, run: () => Promise<unknown>): NodeJS.Timeout {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void run()
      .catch(error => { console.error(`pikibun: ${name} failed:`, error instanceof Error ? error.message : error); })
      .finally(() => { busy = false; });
  }, ms);
  timer.unref();
  return timer;
}

export interface RunningServer {
  address: AddressInfo;
  close(): Promise<void>;
}

export async function startServer(config: ServerConfig): Promise<RunningServer> {
  const { env, host, port, trustProxy, staticDir, preview } = config;
  const previewEnv = preview ? { ...env, APP_ORIGIN: preview.origin } : undefined;
  const environment = (url: string) => preview && new URL(url).origin === preview.origin ? previewEnv! : env;
  const hub = env.CONNECTOR_HUB!;
  let instanceLock: InstanceLock;
  try { instanceLock = await lockThenMigrate(env.DB); } catch (error) {
    await hub.close();
    await env.DB.close();
    throw error;
  }

  const timers = [
    sweep('push credential settling', 5 * 60_000, () => settlePushCredentials(env).catch(() => {})),
    sweep('pull request states', 30_000, () => refreshPullRequestStates(env)),
    sweep('automatic backups', 60_000, async () => { if (env.WORKSPACE_DATABASES) await runAutomaticBackups(env); }),
    sweep('scheduled prompts', 30_000, () => runScheduledPrompts(env)),
    sweep('cross-session notifications', 15_000, () => runCrossSessionNotifications(env)),
  ];

  const serveStatic = createStaticHandler(staticDir);
  const servePreview = preview ? createStaticHandler(preview.staticDir) : undefined;
  app.notFound(async c => {
    if ((c.req.method !== 'GET' && c.req.method !== 'HEAD') || c.req.path.startsWith('/api/')) {
      return c.json({ error: 'Not found.', code: 'not_found' }, 404);
    }
    const handler = servePreview && new URL(c.req.url).origin === preview!.origin ? servePreview : serveStatic;
    const served = await handler(c.req.raw);
    const response = c.newResponse(served.body, served);
    const policy = served.headers.get('Content-Security-Policy');
    if (policy) response.headers.set('Content-Security-Policy', policy);
    return response;
  });

  const server = createAdaptorServer({
    overrideGlobalObjects: false,
    fetch: trustProxy ? trustForwardedHeaders(request => app.fetch(request, environment(request.url)))
      : request => app.fetch(request, environment(request.url)),
  });

  server.on('upgrade', (request, socket, head) => {
    socket.on('error', () => {});
    void (async () => {
      let url: URL;
      try { url = requestUrl(request, trustProxy); } catch { await rejectUpgrade(socket, Response.json({ error: 'Invalid request.', code: 'invalid_request' }, { status: 400 })); return; }
      if (url.pathname !== '/api/connectors/socket' || url.search) {
        await rejectUpgrade(socket, Response.json({ error: 'Not found.', code: 'not_found' }, { status: 404 }));
        return;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (Array.isArray(value)) for (const item of value) headers.append(name, item);
        else if (typeof value === 'string') headers.append(name, value);
      }
      const { connectorId, credentialHash } = await authenticateConnectorSocket(environment(url.href), headers, url);
      await hub.connect(request, socket, head, connectorId, credentialHash);
    })().catch(error => rejectUpgrade(socket, connectorError(error)));
  });

  const listening = Promise.withResolvers<void>();
  server.once('error', listening.reject);
  server.listen(port, host, () => listening.resolve());
  try { await listening.promise; } catch (error) {
    for (const timer of timers) clearInterval(timer);
    await hub.close();
    await instanceLock.release();
    await env.DB.close();
    throw error;
  }
  server.off('error', listening.reject);

  let closing: Promise<void> | undefined;
  return {
    address: server.address() as AddressInfo,
    close() {
      closing ??= (async () => {
        for (const timer of timers) clearInterval(timer);
        const closed = new Promise<void>(resolve => server.close(() => resolve()));
        if ('closeAllConnections' in server) server.closeAllConnections();
        await hub.close();
        await closed;
        await settleNotificationDeliveries(NOTIFICATION_DRAIN_MS);
        await instanceLock.release();
        await env.DB.close();
      })();
      return closing;
    },
  };
}
