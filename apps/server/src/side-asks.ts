import { redactSecrets } from '../../../packages/shared/src/redaction.js';
import type { SideAskSummary } from '../../../packages/shared/src/types.js';
import { errorText, serverLog } from './log.js';
import { now } from './http.js';
import type { AppContext, Env } from './types.js';

export const SIDE_ASKS_LISTED = 3;
export const SIDE_ASK_PREVIEW = 120;
const SIDE_ASK_QUERY_SESSIONS = 100;

export function sideAskPreview(content: unknown, images: number): string {
  const line = redactSecrets(typeof content === 'string' ? content : '').split(/\r?\n/)
    .map(part => part.replace(/\s+/g, ' ').trim()).find(Boolean) ?? '';
  const characters = Array.from(line);
  const preview = characters.length > SIDE_ASK_PREVIEW ? `${characters.slice(0, SIDE_ASK_PREVIEW - 1).join('').trimEnd()}\u2026` : line;
  return preview || (images > 1 ? `${images} images` : images === 1 ? 'An image' : 'Side ask');
}

export async function recordSideAsk(c: AppContext, sessionId: string, conversationId: string, content: unknown, images: number): Promise<void> {
  const actorId = c.get('auth').userId;
  try {
    await c.env.DB.batch([
      c.env.DB.query(`INSERT INTO side_asks (session_id, actor_id, conversation_id, preview, created_at) VALUES (?,?,?,?,?)
        ON CONFLICT (session_id, conversation_id) DO NOTHING`).bind(sessionId, actorId, conversationId, sideAskPreview(content, images), now()),
      c.env.DB.query(`DELETE FROM side_asks WHERE session_id = ? AND actor_id = ? AND conversation_id NOT IN (
        SELECT conversation_id FROM side_asks WHERE session_id = ? AND actor_id = ? ORDER BY created_at DESC, conversation_id DESC LIMIT ?)`)
        .bind(sessionId, actorId, sessionId, actorId, SIDE_ASKS_LISTED),
    ]);
  } catch (error) {
    serverLog(c.env)(`could not list the side ask ${conversationId} of session ${sessionId}: ${errorText(error)}`);
  }
}

export async function sideAsksOf(env: Env, actorId: string, sessionIds: ReadonlySet<string>): Promise<Map<string, SideAskSummary[]>> {
  const listed = new Map<string, SideAskSummary[]>();
  const ids = [...sessionIds];
  for (let start = 0; start < ids.length; start += SIDE_ASK_QUERY_SESSIONS) {
    const chunk = ids.slice(start, start + SIDE_ASK_QUERY_SESSIONS);
    const rows = await env.DB.query<{ session_id: string; conversation_id: string; preview: string; created_at: string }>(
      `SELECT session_id, conversation_id, preview, created_at FROM side_asks WHERE actor_id = ? AND session_id IN (${chunk.map(() => '?').join(',')})
        ORDER BY created_at DESC, conversation_id DESC`).bind(actorId, ...chunk).all();
    for (const row of rows) {
      const list = listed.get(row.session_id) ?? [];
      if (list.length >= SIDE_ASKS_LISTED) continue;
      list.push({ conversationId: row.conversation_id, preview: row.preview, createdAt: row.created_at });
      listed.set(row.session_id, list);
    }
  }
  return listed;
}
