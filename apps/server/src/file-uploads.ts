import { workspaceAdminSQL } from './authority/index.js';
import type { Hono } from 'hono';
import { hostCapabilities } from './authority/index.js';
import { base64Bytes, fileUploadLimits, formatBytes, parseUploadChunk, type UploadResult } from '../../../packages/shared/src/file-uploads.js';
import type { Database } from './db/types.js';
import { auditStatement, requireMember, requireSession } from './authority/index.js';
import { fail, identifier, jsonObject, now } from './http.js';
import { runnerJSON, runnerRequest } from './runner.js';
import type { Env, SessionRow, AppEnv } from './types.js';

export interface AttachmentSettings {
  maxFileBytes: number;
}

const adminSql = workspaceAdminSQL;

function settingsOf(row: { max_file_bytes: number | string } | null | undefined): AttachmentSettings {
  const value = Number(row?.max_file_bytes ?? fileUploadLimits.defaultBytes);
  return { maxFileBytes: Number.isSafeInteger(value) ? Math.min(Math.max(value, fileUploadLimits.minBytes), fileUploadLimits.maxBytes) : fileUploadLimits.defaultBytes };
}

export async function workspaceAttachmentSettings(db: Database, workspaceId: string): Promise<AttachmentSettings> {
  return settingsOf(await db.query<{ max_file_bytes: number }>('SELECT max_file_bytes FROM workspace_attachment_settings WHERE workspace_id = ?')
    .bind(workspaceId).first());
}

async function hostUploads(env: Env, row: SessionRow): Promise<boolean> {
  if (!row.connector_id) return true;
  return (await hostCapabilities(env, row.connector_id))?.fileUploads === true;
}

async function requireUploads(env: Env, row: SessionRow): Promise<void> {
  if (!await hostUploads(env, row)) {
    fail(409, 'uploads_unsupported', 'This session\'s host can\'t take attached files yet. Its owner can update the pikibun connector there.');
  }
}

function requireWithinLimit(size: number, settings: AttachmentSettings): void {
  if (size > settings.maxFileBytes) {
    fail(413, 'file_too_large', `A file may be at most ${formatBytes(settings.maxFileBytes)} in this workspace.`);
  }
}

export function registerFileUploads(app: Hono<AppEnv>): void {
  app.get('/api/workspaces/:id/attachments', async c => {
    const workspaceId = identifier(c.req.param('id'));
    await requireMember(c.env, workspaceId, c.get('auth').userId);
    return c.json({ settings: await workspaceAttachmentSettings(c.env.DB, workspaceId), limits: { min: fileUploadLimits.minBytes, max: fileUploadLimits.maxBytes } });
  });
  app.put('/api/workspaces/:id/attachments', async c => {
    const workspaceId = identifier(c.req.param('id'));
    const actor = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    const input = await jsonObject(c, 1024);
    const value = input.maxFileBytes;
    if (Object.keys(input).some(key => key !== 'maxFileBytes') || !Number.isSafeInteger(value)
      || (value as number) < fileUploadLimits.minBytes || (value as number) > fileUploadLimits.maxBytes) {
      fail(400, 'invalid_input', `Set maxFileBytes to a whole number of bytes from ${fileUploadLimits.minBytes} to ${fileUploadLimits.maxBytes}.`);
    }
    const saved = await c.env.DB.query<{ max_file_bytes: number }>(`INSERT INTO workspace_attachment_settings (workspace_id, max_file_bytes, updated_by, updated_at)
      SELECT ?,?,?,? WHERE ${adminSql}
      ON CONFLICT (workspace_id) DO UPDATE SET max_file_bytes = excluded.max_file_bytes, updated_by = excluded.updated_by, updated_at = excluded.updated_at WHERE ${adminSql}
      RETURNING max_file_bytes`).bind(workspaceId, value as number, actor, now(), workspaceId, actor, workspaceId, actor).first();
    if (!saved) fail(403, 'forbidden', 'Workspace administrator access is required.');
    await auditStatement(c.env, actor, 'workspace.attachments.updated', workspaceId, null, { maxFileBytes: value }).run();
    return c.json({ settings: settingsOf(saved) });
  });

  app.post('/api/sessions/:id/uploads', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'write');
    await requireUploads(c.env, row);
    const input = await jsonObject(c, Math.ceil(fileUploadLimits.chunkBytes / 3) * 4 + 4096);
    const settings = await workspaceAttachmentSettings(c.env.DB, row.workspace_id);
    if (Number.isSafeInteger(input.size)) requireWithinLimit(input.size as number, settings);
    const chunk = parseUploadChunk(input, settings.maxFileBytes);
    if ('error' in chunk) fail(400, 'invalid_upload', chunk.error);
    const result = await runnerJSON<UploadResult>(await runnerRequest(c, row, 'upload', '', chunk), 4096);
    c.header('Cache-Control', 'no-store');
    return c.json(checkedResult(result, chunk.offset + base64Bytes(chunk.data), chunk.size));
  });
}

function checkedResult(value: UploadResult | null, received: number, size: number): UploadResult {
  const path = value?.path;
  if (!value || value.received !== received || (path !== undefined && (typeof path !== 'string' || path.length > 1024
    || !/^attachments\/[^/\x00-\x1f\x7f]+$/.test(path) || received !== size)) || (received === size && path === undefined)) {
    fail(502, 'invalid_runner_response', 'The runner returned an invalid upload response.');
  }
  return path === undefined ? { received } : { received, path };
}
