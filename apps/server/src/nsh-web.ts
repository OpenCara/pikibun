import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';

/**
 * The NSH client (apps/nsh) as a web app, beside the React one: `pnpm build:nsh-web` writes its static site to
 * `dist/nsh/Pikibun`, and the server serves it under /nsh/ when it is there. Served from the API's own origin, it signs
 * in with the browser session the web app uses (cookies and CSRF tokens) and makes only same-origin requests.
 */
export const NSH_WEB_PATH = '/nsh/';

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

/** `nsh package --target web` names files by their content (`nsh.4bda023b65.wasm`): those never change. */
const hashedName = /\.[0-9a-f]{10}\.[a-z0-9]+$/;

/**
 * The page's policy: the React app's, with what NSH's runtime needs on top. Its loader is inline (allowed by hash, so
 * no other inline script runs) and it compiles WebAssembly ('wasm-unsafe-eval', not 'unsafe-eval': JavaScript `eval`
 * stays off).
 */
export function nshContentSecurityPolicy(html: string): string {
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
 * Serves `root` (the packaged site) under /nsh/: a file as it is, anything else as its index.html. Resolves null for
 * other paths, and while no NSH build is there, so the React app's handler answers them.
 */
export function createNshWebHandler(root: string): (request: Request) => Promise<Response | null> {
  const base = resolve(root);
  const index = join(base, 'index.html');
  return async request => {
    let url: URL;
    let pathname: string;
    try {
      url = new URL(request.url);
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
    if (pathname !== NSH_WEB_PATH.slice(0, -1) && !pathname.startsWith(NSH_WEB_PATH)) return null;
    let indexInfo;
    try { indexInfo = await stat(index); } catch { return null; }
    if (!indexInfo.isFile()) return null;
    if (!pathname.startsWith(NSH_WEB_PATH)) return new Response(null, { status: 308, headers: { Location: `${NSH_WEB_PATH}${url.search}` } });
    const relative = pathname.slice(NSH_WEB_PATH.length);
    if (relative && !relative.includes('\0')) {
      const path = resolve(base, relative);
      if (path.startsWith(base + sep) && path !== index) {
        let info;
        try { info = await stat(path); } catch { info = null; }
        if (info?.isFile()) {
          const headers = {
            'Content-Type': contentTypes[extname(path).toLowerCase()] ?? 'application/octet-stream',
            'Content-Length': String(info.size),
            'Last-Modified': info.mtime.toUTCString(),
            'Cache-Control': hashedName.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache',
          };
          if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
          return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>, { status: 200, headers });
        }
      }
    }
    const html = await readFile(index, 'utf8');
    return new Response(request.method === 'HEAD' ? null : html, {
      status: 200,
      headers: { 'Content-Type': contentTypes['.html']!, 'Cache-Control': 'no-cache', 'Content-Security-Policy': nshContentSecurityPolicy(html) },
    });
  };
}
