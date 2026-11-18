import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const migrations = new URL('../apps/server/migrations/sqlite/', import.meta.url);
const migration = '0076_workspace_schedules.sql';

test('schedules move to their workspace: one that woke its session still does, one that ran in a new session becomes the workspace\'s, made from it', () => {
  const files = readdirSync(migrations).filter(name => name.endsWith('.sql')).sort();
  assert.ok(files.includes(migration));
  assert.ok(readdirSync(new URL('../apps/server/migrations/postgres/', import.meta.url)).includes('0069_workspace_schedules.sql'), 'Postgres has the same migration');
  const sqlite = new DatabaseSync(':memory:');
  for (const file of files.filter(name => name < migration)) sqlite.exec(readFileSync(new URL(file, migrations), 'utf8'));
  sqlite.exec('PRAGMA foreign_keys = OFF');
  const required = (sqlite.prepare('PRAGMA table_info(sessions)').all() as { name: string; notnull: number; dflt_value: unknown; pk: number }[])
    .filter(column => (column.notnull || column.pk) && column.dflt_value === null && !['id', 'status', 'workspace_id', 'owner_id'].includes(column.name)).map(column => column.name);
  const session = sqlite.prepare(`INSERT INTO sessions (id, status, workspace_id, owner_id, next_scheduled_at, ${required.join(', ')})
    VALUES (?, ?, 'workspace', 'owner', ?, ${required.map(() => "'x'").join(', ')})`);
  session.run('open', 'ready', '2030-01-01T08:00:00.000Z');
  session.run('archived', 'archived', null);
  const schedule = sqlite.prepare(`INSERT INTO session_schedules (id, session_id, created_by, name, cron, time_zone, content, access, run_in, one_shot, model_id,
      thinking_level, enabled, next_run_at, last_session_id, created_at, updated_at)
    VALUES (?, ?, 'owner', ?, '0 9 * * *', 'UTC', 'Do it', 'auto', ?, ?, ?, ?, 1, ?, ?, '2029-01-01T00:00:00.000Z', '2029-01-01T00:00:00.000Z')`);
  schedule.run('wakes', 'open', 'Wakes', 'session', 1, null, null, '2030-01-01T09:00:00.000Z', null);
  schedule.run('child', 'open', 'Child', 'child', 0, 'model', 'high', '2030-01-01T08:00:00.000Z', 'started');
  schedule.run('archived-child', 'archived', 'Archived child', 'child', 1, null, null, '2030-01-01T09:00:00.000Z', null);
  sqlite.exec(readFileSync(new URL(migration, migrations), 'utf8'));
  const rows = sqlite.prepare(`SELECT id, workspace_id, session_id, origin_session_id, owner_id, created_by, one_shot, model_id, thinking_level, enabled, next_run_at,
    last_session_id FROM schedules ORDER BY id`).all().map(row => ({ ...row }));
  assert.deepEqual(rows, [
    { id: 'archived-child', workspace_id: 'workspace', session_id: null, origin_session_id: 'archived', owner_id: 'owner', created_by: 'owner', one_shot: 1, model_id: null,
      thinking_level: null, enabled: 0, next_run_at: null, last_session_id: null },
    { id: 'child', workspace_id: 'workspace', session_id: null, origin_session_id: 'open', owner_id: 'owner', created_by: 'owner', one_shot: 0, model_id: 'model',
      thinking_level: 'high', enabled: 1, next_run_at: '2030-01-01T08:00:00.000Z', last_session_id: 'started' },
    { id: 'wakes', workspace_id: 'workspace', session_id: 'open', origin_session_id: null, owner_id: 'owner', created_by: 'owner', one_shot: 1, model_id: null,
      thinking_level: null, enabled: 1, next_run_at: '2030-01-01T09:00:00.000Z', last_session_id: null },
  ], 'one whose session was archived, which ran nothing, stays paused');
  assert.equal((sqlite.prepare("SELECT next_scheduled_at FROM sessions WHERE id = 'open'").get() as { next_scheduled_at: string }).next_scheduled_at,
    '2030-01-01T09:00:00.000Z', 'the session shows when it next wakes, not when a run in a new session is due');
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'session_schedules'").get() as { n: number }).n, 0);
});
