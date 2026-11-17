import { HTTPException } from 'hono/http-exception';
import { cleanTitle, fallbackTitle, namesSession, sessionTitleRequest } from '../../../packages/shared/src/session-titles.js';
import { auditStatement, hostCapabilities } from './authority/index.js';
import { errorText, serverLog } from './log.js';
import { keepPortable } from './portable-sessions.js';
import { runnerJSON, runnerRequest } from './runner.js';
import type { AppContext, SessionRow } from './types.js';

const namings = new Set<Promise<void>>();

export function nameSessionLater(c: AppContext, row: SessionRow, content: string): void {
  if (!row.title_fallback || !namesSession(content)) return;
  const naming: Promise<void> = nameSession(c, row, content)
    .catch(error => { if (!(error instanceof HTTPException)) serverLog(c.env)(`naming session ${row.id} failed: ${errorText(error)}`); })
    .finally(() => { namings.delete(naming); });
  namings.add(naming);
}

export async function sessionNamings(): Promise<void> {
  while (namings.size) await Promise.all([...namings]);
}

export async function nameSession(c: AppContext, row: SessionRow, content: string): Promise<void> {
  if (!namesSession(content)) return;
  const fallback = fallbackTitle(content);
  const claimed = await c.env.DB.query<SessionRow>(`UPDATE sessions SET title = ?, title_fallback = NULL
    WHERE id = ? AND title_fallback IS NOT NULL AND title = title_fallback AND status <> 'archived'
    RETURNING *`).bind(fallback, row.id).first();
  if (!claimed) {
    await c.env.DB.query('UPDATE sessions SET title_fallback = NULL WHERE id = ? AND title_fallback IS NOT NULL').bind(row.id).run();
    return;
  }
  if (claimed.title !== row.title) await keepPortable(c, claimed);
  if (!claimed.connector_id || (await hostCapabilities(c.env, claimed.connector_id))?.sessionTitles !== true) return;
  const reply = await runnerJSON<{ text?: unknown }>(await runnerRequest(c, claimed, 'title', '', sessionTitleRequest(content)), 64 * 1024);
  const title = typeof reply?.text === 'string' ? cleanTitle(reply.text) : '';
  if (!title || title === fallback) return;
  const named = await c.env.DB.query<SessionRow>(`UPDATE sessions SET title = ?
    WHERE id = ? AND title = ? AND status <> 'archived'
    RETURNING *`).bind(title, row.id, fallback).first();
  if (!named) return;
  await auditStatement(c.env, c.get('auth').userId, 'session.titled', named.workspace_id, named.id).run();
  await keepPortable(c, named);
}
