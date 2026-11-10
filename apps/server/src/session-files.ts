import type { Hono } from 'hono';
import { hostCapabilities } from './authority/index.js';
import type { ConnectorCapabilities } from '../../../packages/shared/src/connector.js';
import { redactSecrets } from '../../../packages/shared/src/redaction.js';
import { checkBrowseResult, InvalidBrowseResult, type BrowseResult } from '../../../packages/shared/src/file-browser.js';
import type { SessionFiles } from '../../../packages/shared/src/types.js';
import { checkEntryImage, entryImageRequest } from '../../../packages/shared/src/entry-images.js';
import { requireSession } from './authority/index.js';
import { fail, identifier } from './http.js';
import { runnerJSON, runnerRequest } from './runner.js';
import type { Env, SessionRow, AppEnv } from './types.js';

/**
 * A worktree path as the file browser asks for it: relative, with no empty, `.` or `..` segment; the worktree's root is
 * `.`. The host checks it again, symlinks included, before reading anything.
 */
export function worktreePath(value: string | undefined): string {
  const path = (value ?? '').replace(/^\.\/+/, '').replace(/\/+$/, '') || '.';
  if (path.length > 1024 || path.startsWith('/') || path.includes('\\') || /[\x00-\x1f\x7f]/.test(path)
    || (path !== '.' && path.split('/').some(part => part === '' || part === '.' || part === '..'))) {
    fail(400, 'invalid_path', 'Expected a path relative to the session worktree.');
  }
  return path;
}

/** Whether the session's host browses files; the configured external runner is trusted to. */
async function fileBrowserSupported(env: Env, row: SessionRow): Promise<boolean> {
  if (!row.connector_id) return true;
  return (await hostCapabilities(env, row.connector_id))?.fileBrowser === true;
}

/**
 * The host's answer, checked by the same rules as the runner that read it (checkBrowseResult) before it reaches a
 * browser, as the host isn't trusted to have run them; anything else is an invalid runner response.
 */
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
    // Like the transcript: what looks like a secret is hidden from everyone who views it.
    const text = redactSecrets(result.text);
    return { path, ...result, text, ...(text !== result.text ? { redacted: true } : {}) };
  }
  return { path, ...result };
}

export function registerSessionFiles(app: Hono<AppEnv>): void {
  /**
   * The session panel's file browser: one path of the session's worktree on its host, read-only. It takes `write`, as a
   * collaborator could already have the agent read any file there; viewers and share links see only the conversation.
   */
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

  /**
   * One image of the transcript (entry-images.ts), as a thumbnail or whole, from the session's host. The transcript
   * lists each image an entry has; the image itself takes `write`, as the file browser does: the images came from
   * collaborators' messages and from files the agent read. Viewers and share links see the `[image <type>]` line only.
   * Hosts that list images answer this; the entry naming none means there is nothing to ask a host for.
   */
  app.get('/api/sessions/:id/images', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'write');
    const index = c.req.query('index') ?? '';
    const request = entryImageRequest({ entryId: c.req.query('entry'), index: /^\d{1,3}$/.test(index) ? Number(index) : -1, size: c.req.query('size') ?? 'thumbnail' });
    if (!request) fail(400, 'invalid_image', 'Expected a transcript entry, the index of one of its images, and a size (thumbnail or full).');
    const result = await runnerJSON<{ image?: unknown }>(await runnerRequest(c, row, 'image', '', request));
    // The host isn't trusted to have kept to the limits: anything else is an invalid runner response.
    const image = checkEntryImage(result?.image, request.size);
    if (!image) fail(502, 'invalid_runner_response', 'The runner returned an invalid image.');
    c.header('Cache-Control', 'no-store');
    return c.json({ image });
  });
}
