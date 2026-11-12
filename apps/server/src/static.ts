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

const hashedName = /(?:\.[0-9a-f]{10}|-[A-Za-z0-9_-]{8,})\.[a-z0-9]+$/;

const nshRuntime = /^nsh\.[0-9a-f]{10}\.wasm$/;

export function webBuild(root: string): 'nsh' | 'other' | 'none' {
  let names: string[];
  try { names = readdirSync(root); } catch { return 'none'; }
  if (!names.includes('index.html')) return 'none';
  return names.some(name => nshRuntime.test(name)) ? 'nsh' : 'other';
}

export function pageContentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "script-src 'self' blob: 'unsafe-inline' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://avatars.githubusercontent.com",
    "font-src 'self' data:",
    "connect-src 'self' blob: data:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; ');
}

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
    if (!/<base\s[^>]*\bhref\s*=/i.test(html)) html = html.replace(/<head>/i, '<head>\n<base href="/">');
    return new Response(request.method === 'HEAD' ? null : html, {
      status: 200,
      headers: { 'Content-Type': contentTypes['.html']!, 'Cache-Control': 'no-cache', 'Content-Security-Policy': pageContentSecurityPolicy() },
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
