import { createReadStream, readdirSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
  '.bin': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
};

/** Native Shell and Vite both name their bundled assets by their content. */
const hashedName = /(?:\.[0-9a-f]{10}|-[A-Za-z0-9_-]{8,})\.[a-z0-9]+$/;
export type WebClient = 'web' | 'nsh';

/** Native Shell's web runtime, at the top of every NSH web build (nsh.<hash>.wasm); a React build has none. */
const nshRuntime = /^nsh\.[0-9a-f]{10}\.wasm$/;

/**
 * Which client a build directory holds: `web` for a React build, `nsh` for a Native Shell one, or for a directory that
 * isn't there (nothing is served from it, and NSH is the client Pikibun builds).
 */
export function detectWebClient(root: string): WebClient {
  let names: string[];
  try { names = readdirSync(root); } catch { return 'nsh'; }
  if (names.some(name => nshRuntime.test(name))) return 'nsh';
  return names.includes('index.html') ? 'web' : 'nsh';
}

/**
 * The page's policy, as Native Shell 0.4's web runtime needs it to start:
 * - it compiles WebAssembly: 'wasm-unsafe-eval', not 'unsafe-eval', so JavaScript `eval` stays off;
 * - it builds the app's `nsh` modules as `blob:` URLs and maps them with an inline `<script type="importmap">` it inserts,
 *   whose content changes with every load, so no hash can allow it: 'unsafe-inline' does (and a hash or nonce in the
 *   list would turn 'unsafe-inline' off again). The runtime sets no nonce on it (longbridge/nsh: to report).
 * Scripts still come only from this server and the runtime's own blobs; requests go only to this server.
 */
export function pageContentSecurityPolicy(client: WebClient = 'web'): string {
  if (client === 'web') return [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com", "img-src 'self' data: blob: https://avatars.githubusercontent.com",
    "connect-src 'self'", "object-src 'none'", "base-uri 'self'", "frame-ancestors 'none'", "form-action 'self'",
  ].join('; ');
  return [
    "default-src 'self'",
    "script-src 'self' blob: 'unsafe-inline' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://avatars.githubusercontent.com",
    "font-src 'self' data:",
    // The runtime reads its own blobs (a pasted image, a picked photo) with fetch.
    "connect-src 'self' blob: data:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; ');
}

/**
 * Serves a built client: existing files as they are, other paths as index.html. Only the NSH preview gets its
 * relative-URL base and relaxed runtime policy; the production React/Electron client keeps a strict script policy.
 * The caller limits this to GET/HEAD requests outside /api/.
 */
export function createStaticHandler(root: string, client: WebClient = 'web'): (request: Request) => Promise<Response> {
  const base = resolve(root);
  const index = join(base, 'index.html');
  async function file(path: string, request: Request): Promise<Response | null> {
    let info;
    try { info = await stat(path); } catch { return null; }
    if (!info.isFile()) return null;
    const headers = {
      'Content-Type': contentTypes[extname(path).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': String(info.size),
      'Last-Modified': info.mtime.toUTCString(),
      'Cache-Control': hashedName.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache',
    };
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
    return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>, { status: 200, headers });
  }
  async function page(request: Request): Promise<Response> {
    let html: string;
    try { html = await readFile(index, 'utf8'); } catch {
      return Response.json({ error: 'The web app is not built: run `pnpm build`.', code: 'not_found' }, { status: 404 });
    }
    if (client === 'nsh' && !/<base\s/i.test(html)) html = html.replace(/<head>/i, '<head>\n<base href="/">');
    return new Response(request.method === 'HEAD' ? null : html, {
      status: 200,
      headers: { 'Content-Type': contentTypes['.html']!, 'Cache-Control': 'no-cache', 'Content-Security-Policy': pageContentSecurityPolicy(client) },
    });
  }
  return async request => {
    let pathname: string;
    try { pathname = decodeURIComponent(new URL(request.url).pathname); } catch { pathname = '/'; }
    if (!pathname.includes('\0') && pathname !== '/') {
      const path = resolve(base, `.${pathname}`);
      if (path.startsWith(base + sep) && path !== index) {
        const response = await file(path, request);
        if (response) return response;
      }
    }
    return page(request);
  };
}
