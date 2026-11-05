import type { Hono } from 'hono';
import type { ConnectorCapabilities } from '../../../packages/shared/src/connector.js';
import { base64Bytes, fileUploadLimits, formatBytes, parseUploadChunk, type UploadResult } from '../../../packages/shared/src/file-uploads.js';
import { signToken, verifyToken } from '../../../packages/shared/src/crypto.js';
import type { RunnerTicket } from '../../../packages/shared/src/types.js';
import type { Database } from './db/types.js';
import {
  auditStatement, authorizeConnectorTicket, connectorPermissions, type ConnectorRow, requireMember, requireRunnerAccess, requireSession,
} from './authority/index.js';
import { fail, id, identifier, jsonObject, now } from './http.js';
import { connectorPath } from './connector-transport.js';
import { runnerJSON, runnerRequest } from './runner.js';
import type { AppContext, Env, SessionRow, WorkerEnv } from './types.js';

/**
 * Files attached to messages (packages/shared/src/file-uploads.ts). The browser uploads each into the session's
 * worktree before it sends the message, a chunk per request: through here and the session's host, or, in the desktop
 * app on the host's own computer, straight to that host with a grant from here (`/uploads/direct`), so the file's bytes
 * never leave that computer. Either way this checks the uploader's access to the session and the workspace's limit on
 * one file, which its owners and admins set (`/api/workspaces/:id/attachments`).
 */
export interface AttachmentSettings {
  /** The largest file, in bytes, a message here may carry. */
  maxFileBytes: number;
}

/** Owner/admin authority, re-checked inside the write, on insert and on update alike (binds workspace id, user id). */
const adminSql = `EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND role IN ('owner','admin'))`;

function settingsOf(row: { max_file_bytes: number | string } | null | undefined): AttachmentSettings {
  const value = Number(row?.max_file_bytes ?? fileUploadLimits.defaultBytes);
  return { maxFileBytes: Number.isSafeInteger(value) ? Math.min(Math.max(value, fileUploadLimits.minBytes), fileUploadLimits.maxBytes) : fileUploadLimits.defaultBytes };
}

/** The workspace's attachment settings; the defaults until an owner or admin saves some. */
export async function workspaceAttachmentSettings(db: Database, workspaceId: string): Promise<AttachmentSettings> {
  return settingsOf(await db.query<{ max_file_bytes: number }>('SELECT max_file_bytes FROM workspace_attachment_settings WHERE workspace_id = ?')
    .bind(workspaceId).first());
}

/** Whether the session's host takes uploads (and, with `direct`, from the desktop app beside it); the configured external runner is trusted to. */
async function hostUploads(env: Env, row: SessionRow, direct = false): Promise<boolean> {
  if (!row.connector_id) return !direct;
  const host = await env.DB.query<{ capabilities_json: string }>('SELECT capabilities_json FROM connectors WHERE id = ?').bind(row.connector_id).first();
  try {
    const capabilities = JSON.parse(host?.capabilities_json ?? '{}') as ConnectorCapabilities;
    return capabilities.fileUploads === true && (!direct || capabilities.directUploads === true);
  } catch { return false; }
}

async function requireUploads(env: Env, row: SessionRow, direct = false): Promise<void> {
  if (!await hostUploads(env, row, direct)) {
    fail(409, 'uploads_unsupported', direct ? 'This session\'s host doesn\'t take files from the desktop app directly.'
      : 'This session\'s host can\'t take attached files yet. Its owner can update the pikibun connector there.');
  }
}

/** The key direct-upload grants are signed with: the server's own, derived from SESSION_SECRET for this one purpose. */
async function grantSecret(env: Env): Promise<string> {
  const secret = env.SESSION_SECRET;
  if (!secret || secret.length < 32) fail(503, 'uploads_unavailable', 'Direct uploads are not configured on this server.');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const derived = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('pikibun direct upload grants v1')));
  return Buffer.from(derived).toString('base64url');
}

/** A direct upload's grant, as this server signs it and the host hands it back to be checked. */
interface DirectGrant {
  purpose: 'direct-upload';
  ticket: RunnerTicket;
  /** The whole file's size, which the host checks the chunk declares. */
  size: number;
  iat: number;
  exp: number;
}

/** What the browser declares of a chunk it will hand the desktop app: the hash of its exact request body, and the file's size. */
function directInput(input: Record<string, unknown>): { bodyHash: string; size: number } {
  const keys = Object.keys(input).sort().join(',');
  if (keys !== 'bodyHash,size' || typeof input.bodyHash !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.bodyHash)
    || !Number.isSafeInteger(input.size) || (input.size as number) < 0) fail(400, 'invalid_input', 'Expected bodyHash and size.');
  return { bodyHash: input.bodyHash as string, size: input.size as number };
}

function requireWithinLimit(size: number, settings: AttachmentSettings): void {
  if (size > settings.maxFileBytes) {
    fail(413, 'file_too_large', `A file may be at most ${formatBytes(settings.maxFileBytes)} in this workspace.`);
  }
}

export function registerFileUploads(app: Hono<WorkerEnv>): void {
  // Every member may see the limit, which their chat boxes apply; owners and admins change it.
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

  /**
   * One chunk of a file attached to a message, to the session's host, which writes the file into the worktree's
   * attachments directory once the last chunk is in. It takes `write`, as the agent could write any file there.
   */
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

  /**
   * A grant for the desktop app on the session's host's computer to hand that host one chunk itself: the request as the
   * relay would carry it, without its body, which the browser keeps, and this server's signature over it. The host
   * has this server check the grant (`/api/connectors/self/uploads/verify`), and the actor's access again, before it
   * takes the chunk.
   */
  app.post('/api/sessions/:id/uploads/direct', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'write');
    if (!row.connector_id) fail(409, 'uploads_unsupported', 'This session\'s host doesn\'t take files from the desktop app directly.');
    await requireUploads(c.env, row, true);
    const { bodyHash, size } = directInput(await jsonObject(c, 1024));
    requireWithinLimit(size, await workspaceAttachmentSettings(c.env.DB, row.workspace_id));
    const actorId = c.get('auth').userId;
    const current = await requireRunnerAccess(c, actorId, row, 'upload');
    const issuedAt = Math.floor(Date.now() / 1000);
    const ticket: RunnerTicket = { aud: 'runner', sessionId: current.id, actorId, ownerId: current.owner_id, connectorId: current.connector_id!, action: 'upload',
      policyVersion: current.policy_version, iat: issuedAt, exp: issuedAt + 60, jti: id(), bodyHash };
    await authorizeConnectorTicket(c.env, ticket);
    const grant: DirectGrant = { purpose: 'direct-upload', ticket, size, iat: issuedAt, exp: ticket.exp };
    c.header('Cache-Control', 'no-store');
    return c.json({ connectorId: current.connector_id, grant: await signToken(grant, await grantSecret(c.env)) });
  });
}

/** The host's answer to a chunk, checked before it reaches the browser: bytes received so far, and the path once complete. */
function checkedResult(value: UploadResult | null, received: number, size: number): UploadResult {
  const path = value?.path;
  if (!value || value.received !== received || (path !== undefined && (typeof path !== 'string' || path.length > 1024
    || !/^attachments\/[^/\x00-\x1f\x7f]+$/.test(path) || received !== size)) || (received === size && path === undefined)) {
    fail(502, 'invalid_runner_response', 'The runner returned an invalid upload response.');
  }
  return path === undefined ? { received } : { received, path };
}

/**
 * The host's check of a direct-upload grant a desktop app handed it: this server signed it, for an upload by this
 * host, it hasn't expired, and its actor may still upload to the session, within the workspace's limit. Answers the
 * grant's ticket and size, which the host then holds the chunk to.
 */
export async function verifyDirectUpload(c: AppContext, connector: ConnectorRow): Promise<Response> {
  const input = await jsonObject(c, 32 * 1024);
  if (Object.keys(input).join(',') !== 'grant' || typeof input.grant !== 'string') fail(400, 'invalid_input', 'Expected a grant.');
  const grant = await verifyToken<DirectGrant>(input.grant, await grantSecret(c.env));
  const ticket = grant?.ticket;
  if (!grant || grant.purpose !== 'direct-upload' || !ticket || typeof ticket !== 'object' || ticket.aud !== 'runner' || ticket.action !== 'upload'
    || ticket.connectorId !== connector.id || ticket.exp !== grant.exp || ticket.exp * 1000 <= Date.now()
    || !Number.isSafeInteger(grant.size) || grant.size < 0 || !Object.hasOwn(connectorPermissions, ticket.action)) {
    fail(403, 'invalid_grant', 'The upload grant is invalid or has expired.');
  }
  const row = await authorizeConnectorTicket(c.env, ticket, connector.connection_hash ?? undefined);
  requireWithinLimit(grant.size, await workspaceAttachmentSettings(c.env.DB, row.workspace_id));
  return c.json({ ticket, size: grant.size, path: connectorPath('upload', ticket.sessionId) });
}
