import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { COMPACTION_FAILURES, MODEL_FAILURE_CAUSES, type EntryView, type SessionView } from '../../../packages/shared/src/types.js';
import type { SessionLink, SharedSession, SharedSessionView } from '../../../packages/shared/src/sharing.js';
import { sha256 } from '../../../packages/shared/src/crypto.js';
import { redactSecrets } from '../../../packages/shared/src/redaction.js';
import { briefEntry, type ToolOutput } from '../../../packages/shared/src/transcript-display.js';
import type { AppContext, Env, SessionRow, AppEnv } from './types.js';
import {
  auditStatement, decryptToken, encryptToken, requireConnectorSession, requireSession, requireSessionManager, sessionAccess,
} from './authority/index.js';
import { getUser } from './db.js';
import { appOrigin, fail, identifier, now, randomToken } from './http.js';
import { ownerViewRequest, runnerJSON } from './runner.js';

const SHARE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const INVALID_LINK = 'This share link doesn\'t work. It may have been turned off.';

interface LinkRow { token_hash: string; token_ciphertext: string; created_at: string }

const linkIdentity = (sessionId: string) => `session-link:${sessionId}`;

const linkUrl = (env: Env, token: string) => `${appOrigin(env)}/#/shared/${token}`;

function currentLink(env: Env, sessionId: string): Promise<LinkRow | null> {
  return env.DB.query<LinkRow>('SELECT token_hash, token_ciphertext, created_at FROM session_links WHERE session_id = ?').bind(sessionId).first();
}

export async function isLinkShared(env: Env, sessionId: string): Promise<boolean> {
  return !!await env.DB.query('SELECT 1 FROM session_links WHERE session_id = ?').bind(sessionId).first();
}

async function presentLink(env: Env, sessionId: string, link: LinkRow): Promise<SessionLink> {
  let token: string;
  try {
    token = await decryptToken(env, linkIdentity(sessionId), link.token_ciphertext);
  } catch (error) {
    if (error instanceof HTTPException && error.status === 503) throw error;
    token = '';
  }
  if (!SHARE_TOKEN.test(token) || await sha256(token) !== link.token_hash) {
    fail(500, 'link_unavailable', 'The share link could not be read. Turn link sharing off and on again to get a new link.');
  }
  return { url: linkUrl(env, token), createdAt: link.created_at };
}

async function linkedSession(env: Env, token: string | undefined): Promise<SessionRow | null> {
  if (!token || !SHARE_TOKEN.test(token)) return null;
  const link = await env.DB.query<{ session_id: string; owner_id: string }>(`SELECT l.session_id, s.owner_id FROM session_links l
    JOIN sessions s ON s.id = l.session_id WHERE l.token_hash = ?`).bind(await sha256(token)).first();
  if (!link) return null;
  return (await sessionAccess(env, link.session_id, link.owner_id))?.row ?? null;
}

async function requireLinkedSession(c: AppContext, token: string | undefined): Promise<SessionRow> {
  const row = await linkedSession(c.env, token);
  if (!row) fail(404, 'not_found', INVALID_LINK);
  return row;
}

export function entryError(error: NonNullable<EntryView['error']>): NonNullable<EntryView['error']> {
  return {
    ...(error.provider !== undefined ? { provider: error.provider } : {}),
    ...(error.modelId !== undefined ? { modelId: error.modelId } : {}),
    ...(error.status !== undefined ? { status: error.status } : {}),
    ...(error.compaction !== undefined && COMPACTION_FAILURES.includes(error.compaction) ? { compaction: error.compaction } : {}),
    ...(error.cause !== undefined && MODEL_FAILURE_CAUSES.includes(error.cause) ? { cause: error.cause } : {}),
    ...(error.compacting === true ? { compacting: true as const } : {}),
  };
}

const label = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= limit;

function sharedToolFields({ toolCalls, toolResult }: EntryView): Pick<EntryView, 'toolCalls' | 'toolResult'> {
  const calls = Array.isArray(toolCalls) && toolCalls.length <= 256
    && toolCalls.every(call => !!call && typeof call === 'object' && label(call.id, 256) && label(call.name, 128))
    ? toolCalls.map(call => ({ id: call.id, name: call.name })) : [];
  const result = toolResult && typeof toolResult === 'object' ? {
    ...(label(toolResult.callId, 256) ? { callId: toolResult.callId } : {}),
    ...(label(toolResult.tool, 128) ? { tool: toolResult.tool } : {}),
    ...(toolResult.error === true ? { error: true as const } : {}),
  } : undefined;
  return { ...(calls.length ? { toolCalls: calls } : {}), ...(result && Object.keys(result).length ? { toolResult: result } : {}) };
}

function sharedEntry(entry: EntryView): EntryView {
  const { id, kind, role, text, error, durationMs } = entry;
  return { id, kind, role, text: redactSecrets(text), ...sharedToolFields(entry),
    ...(error ? { error: entryError(error) } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}) };
}

export function sharedView(view: SessionView, toolOutput: ToolOutput = 'full'): SharedSessionView {
  const conversations = Array.isArray(view.conversations) ? view.conversations : [];
  const shared = new Set(conversations.filter(conversation => !!conversation && typeof conversation === 'object' && conversation.mode === 'write')
    .map(conversation => conversation.id));
  const entries = (Array.isArray(view.entries) ? view.entries : [])
    .filter(entry => !!entry && typeof entry === 'object' && typeof entry.conversationId === 'string' && shared.has(entry.conversationId))
    .map(sharedEntry)
    .map(entry => toolOutput === 'brief' ? briefEntry(entry) : entry);
  return { entries, busy: view.busy === true };
}

export function registerSharedSessions(app: Hono<AppEnv>): void {
  app.get('/api/shared', async c => {
    const row = await requireLinkedSession(c, c.req.header('x-share-token'));
    const owner = await getUser(c.env, row.owner_id);
    if (!owner) fail(404, 'not_found', INVALID_LINK);
    const session: SharedSession = { title: row.title, status: row.status, createdAt: row.created_at, ownerName: owner.display_name };
    return c.json({ session });
  });
  app.get('/api/shared/view', async c => {
    const token = c.req.header('x-share-token');
    const row = await requireLinkedSession(c, token);
    const result = await runnerJSON<{ view: SessionView }>(await ownerViewRequest(c, row));
    if (!result?.view || result.view.sessionId !== row.id || result.view.owner?.id !== row.owner_id) fail(502, 'invalid_runner_response', 'The runner returned an inconsistent session binding.');
    const fresh = await linkedSession(c.env, token);
    if (!fresh || fresh.id !== row.id) fail(404, 'not_found', INVALID_LINK);
    if (fresh.connector_id) await requireConnectorSession(c.env, fresh.connector_id, fresh);
    return c.json({ view: sharedView(result.view, fresh.tool_output === 'brief' ? 'brief' : 'full') });
  });
}

async function requireOwner(c: AppContext, permission: 'read' | 'manage', message: string): Promise<SessionRow> {
  const { row } = await requireSession(c, identifier(c.req.param('id')), permission);
  if (row.owner_id !== c.get('auth').userId) fail(403, 'owner_required', message);
  return row;
}

export function registerSessionLinks(app: Hono<AppEnv>): void {
  app.get('/api/sessions/:id/link', async c => {
    const row = await requireOwner(c, 'read', 'Only the session owner can see its share link.');
    const link = await currentLink(c.env, row.id);
    return c.json({ link: link ? await presentLink(c.env, row.id, link) : null });
  });
  app.put('/api/sessions/:id/link', async c => {
    const row = await requireOwner(c, 'manage', 'Only the session owner can share it by link.');
    const existing = await currentLink(c.env, row.id);
    if (existing) return c.json({ link: await presentLink(c.env, row.id, existing) });
    const token = randomToken();
    const createdAt = now();
    const ciphertext = await encryptToken(c.env, linkIdentity(row.id), token);
    const created = await c.env.DB.query(`INSERT INTO session_links (session_id, token_hash, token_ciphertext, created_at)
      SELECT id, ?, ?, ? FROM sessions WHERE id = ? AND owner_id = ? AND policy_version = ? AND status <> 'archived'
        AND EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = sessions.workspace_id AND user_id = sessions.owner_id)
      ON CONFLICT (session_id) DO NOTHING RETURNING session_id`)
      .bind(await sha256(token), ciphertext, createdAt, row.id, row.owner_id, row.policy_version).first();
    if (!created) {
      const raced = await currentLink(c.env, row.id);
      if (raced) return c.json({ link: await presentLink(c.env, row.id, raced) });
      fail(409, 'policy_changed', 'Session membership or status changed; reload and retry.');
    }
    await auditStatement(c.env, row.owner_id, 'session.link.created', row.workspace_id, row.id).run();
    return c.json({ link: { url: linkUrl(c.env, token), createdAt } satisfies SessionLink }, 201);
  });
  app.delete('/api/sessions/:id/link', async c => {
    const { row } = await requireSessionManager(c, identifier(c.req.param('id')), 'read',
      'Only the session owner, or the workspace\'s owner or an admin, can turn off its share link.');
    const removed = await c.env.DB.query('DELETE FROM session_links WHERE session_id = ? RETURNING session_id').bind(row.id).first();
    if (removed) await auditStatement(c.env, c.get('auth').userId, 'session.link.revoked', row.workspace_id, row.id).run();
    return c.json({ ok: true });
  });
}
