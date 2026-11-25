import type { Hono } from 'hono';
import { signToken, verifyToken } from '../../../packages/shared/src/crypto.js';
import { checkMediaRange, mediaLimits, mediaType, parseByteRange, type MediaRange } from '../../../packages/shared/src/media.js';
import { hostCapabilities, requireSession } from './authority/index.js';
import { z } from 'zod';
import { fail, identifier } from './http.js';
import { body } from './schemas.js';
import { runnerJSON, runnerRequest } from './runner.js';
import { worktreePath } from './session-files.js';
import type { AppContext, AppEnv, Env, SessionRow } from './types.js';

interface MediaClaims {
  aud: 'media';
  sessionId: string;
  userId: string;
  path: string;
  iat: number;
  exp: number;
}

const mediaLinkBody = z.strictObject({ path: z.string() });
const TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function mediaSecret(env: Env): string {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) fail(503, 'media_unavailable', 'This server can\'t sign media links.');
  return `pikibun media link:${env.SESSION_SECRET}`;
}

export async function mediaToken(env: Env, claims: Omit<MediaClaims, 'aud' | 'iat' | 'exp'>, now = Date.now()): Promise<{ token: string; expiresAt: number }> {
  const iat = Math.floor(now / 1000);
  const exp = iat + mediaLimits.linkSeconds;
  return { token: await signToken({ aud: 'media', ...claims, iat, exp } satisfies MediaClaims, mediaSecret(env)), expiresAt: exp * 1000 };
}

async function mediaClaims(env: Env, token: string): Promise<MediaClaims | null> {
  if (!TOKEN.test(token)) return null;
  const claims = await verifyToken<Partial<MediaClaims>>(token, mediaSecret(env));
  if (!claims || claims.aud !== 'media' || typeof claims.sessionId !== 'string' || typeof claims.userId !== 'string'
    || typeof claims.path !== 'string' || !mediaType(claims.path)) return null;
  return claims as MediaClaims;
}

async function requireMediaHost(env: Env, row: SessionRow): Promise<void> {
  if (row.connector_id && (await hostCapabilities(env, row.connector_id))?.mediaFiles !== true) {
    fail(409, 'media_unsupported', 'This session\'s host can\'t show media files yet. Its owner can update the pikibun connector there.');
  }
}

async function readRange(c: AppContext, row: SessionRow, path: string, offset: number, length: number): Promise<{ size: number; bytes: Uint8Array<ArrayBuffer> }> {
  const request = { path, offset, length };
  const result = await runnerJSON<{ range?: unknown }>(await runnerRequest(c, row, 'files', '', request), Math.ceil(mediaLimits.chunkBytes / 3) * 4 + 4096);
  const range: MediaRange | undefined = checkMediaRange(result?.range, request);
  if (!range) fail(502, 'invalid_runner_response', 'The runner returned an invalid part of the file.');
  return { size: range.size, bytes: new Uint8Array(Buffer.from(range.data, 'base64')) };
}

function mediaHeaders(mimeType: string, length: number): Record<string, string> {
  return {
    'Content-Type': mimeType, 'Content-Length': String(length), 'Accept-Ranges': 'bytes', 'Content-Disposition': 'inline',
    'Cache-Control': 'private, no-store', 'Cross-Origin-Resource-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'none'; sandbox",
  };
}

export function registerMediaLinks(app: Hono<AppEnv>): void {
  app.get('/api/media/:token', async c => {
    const claims = await mediaClaims(c.env, c.req.param('token'));
    if (!claims) fail(404, 'not_found', 'This media link has expired or isn\'t valid. Show the message again to get a new one.');
    const user = await c.env.DB.query<{ suspended_at: number | null }>('SELECT suspended_at FROM users WHERE id = ?').bind(claims.userId).first();
    if (!user || user.suspended_at !== null) fail(404, 'not_found', 'This media link has expired or isn\'t valid.');
    c.set('auth', { userId: claims.userId, tokenHash: 'media', csrfToken: '', client: 'native' });
    const { row } = await requireSession(c, identifier(claims.sessionId), 'write');
    await requireMediaHost(c.env, row);
    const { mimeType } = mediaType(claims.path)!;
    const header = c.req.header('range');
    const first = await readRange(c, row, claims.path, 0, mediaLimits.chunkBytes);
    const size = first.size;
    const range = parseByteRange(header, size);
    if (range === 'unsatisfiable') {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store' } });
    }
    if (range) {
      const part = range.start === 0 ? first.bytes.subarray(0, range.end + 1) : (await readRange(c, row, claims.path, range.start, range.end - range.start + 1)).bytes;
      if (part.length !== range.end - range.start + 1) fail(409, 'media_changed', 'The file changed while it was read. Try again.');
      return new Response(part, { status: 206, headers: { ...mediaHeaders(mimeType, part.length), 'Content-Range': `bytes ${range.start}-${range.end}/${size}` } });
    }
    if (c.req.method === 'HEAD') return new Response(null, { status: 200, headers: mediaHeaders(mimeType, size) });
    let offset = first.bytes.length;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (first.bytes.length) controller.enqueue(first.bytes);
        if (offset >= size) controller.close();
      },
      async pull(controller) {
        try {
          const next = await readRange(c, row, claims.path, offset, Math.min(mediaLimits.chunkBytes, size - offset));
          if (next.size !== size || !next.bytes.length) throw new Error('The file changed while it was read.');
          controller.enqueue(next.bytes);
          offset += next.bytes.length;
          if (offset >= size) controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    }, { highWaterMark: 0 });
    return new Response(stream, { status: 200, headers: mediaHeaders(mimeType, size) });
  });
}

export function registerMediaLinkIssuing(app: Hono<AppEnv>): void {
  app.post('/api/sessions/:id/media', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'write');
    const input = await body(c, mediaLinkBody, { maxBytes: 4096, message: 'Expected the path of a file in the session worktree.' });
    const path = worktreePath(input.path);
    const type = mediaType(path);
    if (path === '.' || !type) fail(400, 'invalid_media', 'Only images (PNG, JPEG, GIF, WebP), videos (MP4, MOV, WebM, Ogg) and audio (MP3, M4A, AAC, WAV, Ogg, Opus, FLAC) can be shown.');
    await requireMediaHost(c.env, row);
    const { token, expiresAt } = await mediaToken(c.env, { sessionId: row.id, userId: c.get('auth').userId, path });
    c.header('Cache-Control', 'no-store');
    return c.json({ media: { url: `/api/media/${token}`, path, kind: type.kind, mimeType: type.mimeType, expiresAt } });
  });
}
