import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
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

/** `nsh package --target web` names files by their content (`nsh.4bda023b65.wasm`): those never change. */
const hashedName = /\.[0-9a-f]{10}\.[a-z0-9]+$/;

/**
 * The page's policy. Native Shell's loader is inline in index.html, so it is allowed by hash and no other inline script
 * runs, and its runtime compiles WebAssembly ('wasm-unsafe-eval', not 'unsafe-eval': JavaScript `eval` stays off).
 */
export function pageContentSecurityPolicy(html: string): string {
  const hashes = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(match => `'sha256-${createHash('sha256').update(match[1] ?? '').digest('base64')}'`);
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval' ${hashes.join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://avatars.githubusercontent.com",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; ');
}

/**
 * Serves the client (apps/nsh, built for the web into `root` by `pnpm build`): an existing file as it is, anything
 * else as `index.html`, whose routes live in the URL's fragment (`/#/s/<id>`). The page gets `<base href="/">`, as
 * Native Shell's site uses relative URLs, and the policy above. The caller limits this to GET/HEAD requests outside
 * `/api/`.
 */
export function createStaticHandler(root: string): (request: Request) => Promise<Response> {
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
    if (!/<base\s/i.test(html)) html = html.replace(/<head>/i, '<head>\n<base href="/">');
    return new Response(request.method === 'HEAD' ? null : html, {
      status: 200,
      headers: { 'Content-Type': contentTypes['.html']!, 'Cache-Control': 'no-cache', 'Content-Security-Policy': pageContentSecurityPolicy(html) },
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
