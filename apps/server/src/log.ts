import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { routePath } from 'hono/route';
import type { AppEnv, Env } from './types.js';

export type ServerLog = (line: string) => void;

export const stderrLog: ServerLog = line => { console.error(`pikibun: ${line}`); };

export const plainText = (text: string, limit = 300) => text.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, limit);

export function serverLog(env: Pick<Env, 'LOG'> | undefined): ServerLog {
  return env?.LOG ?? stderrLog;
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return plainText(`${error.name}: ${error.message}`, 500);
  return plainText(String(error), 500);
}

export function errorStack(error: unknown): string {
  if (!(error instanceof Error) || typeof error.stack !== 'string') return errorText(error);
  return error.stack.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, ' ').slice(0, 4000);
}

const ERROR_BODY_BYTES = 65536;
const ERROR_BODY_MS = 1000;

async function boundedText(response: Response): Promise<string | undefined> {
  const declared = response.headers.get('content-length');
  if (declared !== null && !(Number(declared) <= ERROR_BODY_BYTES)) return undefined;
  const reader = response.clone().body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'late'>(resolve => { timer = setTimeout(() => resolve('late'), ERROR_BODY_MS); });
  try {
    while (true) {
      const next = await Promise.race([reader.read(), late]);
      if (next === 'late') return undefined;
      if (next.done) break;
      size += next.value.byteLength;
      if (size > ERROR_BODY_BYTES) return undefined;
      chunks.push(next.value);
    }
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

export async function errorBody(response: Response): Promise<{ code?: string; error?: string }> {
  if (!response.headers.get('content-type')?.includes('application/json')) return {};
  try {
    const text = await boundedText(response);
    if (text === undefined) return {};
    const body = JSON.parse(text) as { code?: unknown; error?: unknown };
    return {
      ...(typeof body.code === 'string' && /^[a-z0-9_]{1,64}$/.test(body.code) ? { code: body.code } : {}),
      ...(typeof body.error === 'string' && body.error ? { error: plainText(body.error) } : {}),
    };
  } catch {
    return {};
  }
}

export async function failureDetail(error: unknown): Promise<string> {
  if (error instanceof HTTPException) {
    const body = await errorBody(error.res ?? error.getResponse());
    return [body.code, body.error].filter(Boolean).join(': ') || `HTTP ${error.status}`;
  }
  return errorText(error);
}

function sessionOf(route: string, param: (name: string) => string | undefined): string | undefined {
  const name = /^\/api\/sessions\/:([A-Za-z]+)/.exec(route)?.[1];
  const value = name ? param(name) : undefined;
  return value && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
}

export const failedRequests: MiddlewareHandler<AppEnv> = async (c, next) => {
  const started = Date.now();
  await next();
  const status = c.res.status;
  if (status < 500) return;
  let route = c.req.path.startsWith('/api/') ? '' : c.req.path;
  try { route = routePath(c) || route; } catch { }
  if (route === '*' || route === '/*' || route === '/api/*') route = c.req.path.startsWith('/api/') ? '/api/*' : route;
  const session = sessionOf(route, name => { try { return c.req.param(name); } catch { return undefined; } });
  const body = await errorBody(c.res);
  const parts = [`${c.req.method} ${plainText(route, 200)} ${status}`, body.code ?? '', `${Date.now() - started}ms`, session ? `session=${session}` : ''].filter(Boolean);
  const log = serverLog(c.env);
  log(`${parts.join(' ')}${body.error ? `: ${body.error}` : ''}`);
  if (c.error && !(c.error instanceof HTTPException)) log(`${c.req.method} ${plainText(route, 200)} failed unexpectedly: ${errorStack(c.error)}`);
};
