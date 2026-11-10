import type { Hono } from 'hono';
import type { Database } from './db/types.js';
import type { AppEnv } from './types.js';
import { auditStatement, requireMember } from './authority/index.js';
import { fail, identifier, jsonObject, now } from './http.js';
import { toolOutputs, type ToolOutput } from '../../../packages/shared/src/transcript-display.js';

export interface TranscriptSettings {
  paging: boolean;
  toolOutput: ToolOutput;
}

const adminSql = `EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND role IN ('owner','admin'))`;

interface SettingsRow { paging: number; tool_output: string }

function settingsOf(row: SettingsRow | null | undefined): TranscriptSettings {
  return { paging: row?.paging === 1, toolOutput: row?.tool_output === 'brief' ? 'brief' : 'full' };
}

export async function workspaceTranscriptSettings(db: Database, workspaceId: string): Promise<TranscriptSettings> {
  const row = await db.query<SettingsRow>('SELECT paging, tool_output FROM workspace_transcript_settings WHERE workspace_id = ?').bind(workspaceId).first();
  return settingsOf(row);
}

export async function newSessionToolOutput(db: Database, workspaceId: string): Promise<ToolOutput> {
  return (await workspaceTranscriptSettings(db, workspaceId)).toolOutput;
}

export function registerTranscriptSettings(app: Hono<AppEnv>): void {
  app.get('/api/workspaces/:id/transcripts', async c => {
    const workspaceId = identifier(c.req.param('id'));
    await requireMember(c.env, workspaceId, c.get('auth').userId);
    return c.json({ settings: await workspaceTranscriptSettings(c.env.DB, workspaceId) });
  });
  app.put('/api/workspaces/:id/transcripts', async c => {
    const workspaceId = identifier(c.req.param('id'));
    const actor = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    const input = await jsonObject(c, 1024);
    const keys = Object.keys(input);
    if (!keys.length || keys.some(key => key !== 'paging' && key !== 'toolOutput')
      || ('paging' in input && typeof input.paging !== 'boolean')
      || ('toolOutput' in input && !toolOutputs.includes(input.toolOutput as ToolOutput))) {
      fail(400, 'invalid_input', 'Set paging to true or false, toolOutput to full or brief, or both.');
    }
    const paging = typeof input.paging === 'boolean' ? input.paging : undefined;
    const toolOutput = 'toolOutput' in input ? input.toolOutput as ToolOutput : undefined;
    const updates = [...(paging !== undefined ? ['paging = excluded.paging'] : []), ...(toolOutput !== undefined ? ['tool_output = excluded.tool_output'] : []),
      'updated_by = excluded.updated_by', 'updated_at = excluded.updated_at'];
    const saved = await c.env.DB.query<SettingsRow>(`INSERT INTO workspace_transcript_settings (workspace_id, paging, tool_output, updated_by, updated_at)
      SELECT ?,?,?,?,? WHERE ${adminSql}
      ON CONFLICT (workspace_id) DO UPDATE SET ${updates.join(', ')} WHERE ${adminSql}
      RETURNING paging, tool_output`).bind(workspaceId, paging ? 1 : 0, toolOutput ?? 'full', actor, now(), workspaceId, actor, workspaceId, actor).first();
    if (!saved) fail(403, 'forbidden', 'Workspace administrator access is required.');
    const settings = settingsOf(saved);
    await auditStatement(c.env, actor, 'workspace.transcripts.updated', workspaceId, null,
      { ...(paging !== undefined ? { paging } : {}), ...(toolOutput !== undefined ? { toolOutput } : {}) }).run();
    return c.json({ settings });
  });
}
