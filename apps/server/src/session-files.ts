import type { Hono } from 'hono';
import { hostCapabilities } from './authority/index.js';
import { redactSecrets } from '../../../packages/shared/src/redaction.js';
import { checkBrowseResult, InvalidBrowseResult, type BrowseResult } from '../../../packages/shared/src/file-browser.js';
import type { SessionFiles } from '../../../packages/shared/src/types.js';
import { checkEntryImage, entryImageRequest } from '../../../packages/shared/src/entry-images.js';
import { requireSession } from './authority/index.js';
import { fail, identifier } from './http.js';
import { runnerJSON, runnerRequest } from './runner.js';
import type { Env, SessionRow, AppEnv } from './types.js';

export function worktreePath(value: string | undefined): string {
  const path = (value ?? '').replace(/^\.\/+/, '').replace(/\/+$/, '') || '.';
  if (path.length > 1024 || path.startsWith('/') || path.includes('\\') || /[\x00-\x1f\x7f]/.test(path)
    || (path !== '.' && path.split('/').some(part => part === '' || part === '.' || part === '..'))) {
    fail(400, 'invalid_path', 'Expected a path relative to the session worktree.');
  }
  return path;
}

async function fileBrowserSupported(env: Env, row: SessionRow): Promise<boolean> {
  if (!row.connector_id) return true;
  return (await hostCapabilities(env, row.connector_id))?.fileBrowser === true;
}

function checkedFiles(value: unknown, path: string): SessionFiles {
  const files = value as Record<string, unknown> | null;
  let result: BrowseResult;
  try {
    if (!files || typeof files !== 'object' || files.path !== path) throw new InvalidBrowseResult();
    result = checkBrowseResult(files);
  } catch (error) {
    if (error instanceof InvalidBrowseResult) fail(502, 'invalid_runner_response', 'The runner returned an invalid file listing.');
    throw error;
  }
  if (result.type === 'file' && result.text !== undefined) {
    const text = redactSecrets(result.text);
    return { path, ...result, text, ...(text !== result.text ? { redacted: true } : {}) };
  }
  return { path, ...result };
}

export function registerSessionFiles(app: Hono<AppEnv>): void {
  app.get('/api/sessions/:id/files', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'write');
    const path = worktreePath(c.req.query('path'));
    if (!await fileBrowserSupported(c.env, row)) {
      fail(409, 'files_unsupported', 'This session\'s host can\'t show its files yet. Its owner can update the pikibun connector there.');
    }
    const result = await runnerJSON<{ files?: unknown }>(await runnerRequest(c, row, 'files', '', { path }));
    c.header('Cache-Control', 'no-store');
    return c.json({ files: checkedFiles(result?.files, path) });
  });

  app.get('/api/sessions/:id/images', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'write');
    const index = c.req.query('index') ?? '';
    const request = entryImageRequest({ entryId: c.req.query('entry'), index: /^\d{1,3}$/.test(index) ? Number(index) : -1, size: c.req.query('size') ?? 'thumbnail' });
    if (!request) fail(400, 'invalid_image', 'Expected a transcript entry, the index of one of its images, and a size (thumbnail or full).');
    const result = await runnerJSON<{ image?: unknown }>(await runnerRequest(c, row, 'image', '', request));
    const image = checkEntryImage(result?.image, request.size);
    if (!image) fail(502, 'invalid_runner_response', 'The runner returned an invalid image.');
    c.header('Cache-Control', 'no-store');
    return c.json({ image });
  });
}
