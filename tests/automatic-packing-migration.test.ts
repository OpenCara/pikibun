import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { automaticPackingDays } from '../packages/shared/src/packing.js';

const migrations = new URL('../apps/server/migrations/sqlite/', import.meta.url);
const migration = '0064_automatic_packing.sql';

test('sessions archived before automatic packing get their week from when it arrives; packed and open ones none', () => {
  const files = readdirSync(migrations).filter(name => name.endsWith('.sql')).sort();
  assert.ok(files.includes(migration));
  assert.ok(readdirSync(new URL('../apps/server/migrations/postgres/', import.meta.url)).includes('0057_automatic_packing.sql'), 'Postgres has the same migration');
  const sqlite = new DatabaseSync(':memory:');
  for (const file of files.filter(name => name < migration)) sqlite.exec(readFileSync(new URL(file, migrations), 'utf8'));
  sqlite.exec('PRAGMA foreign_keys = OFF');
  const required = (sqlite.prepare('PRAGMA table_info(sessions)').all() as { name: string; notnull: number; dflt_value: unknown; pk: number }[])
    .filter(column => (column.notnull || column.pk) && column.dflt_value === null && !['id', 'status'].includes(column.name)).map(column => column.name);
  const insert = sqlite.prepare(`INSERT INTO sessions (id, status, packed_at, ${required.join(', ')}) VALUES (?, ?, ?, ${required.map(() => "'x'").join(', ')})`);
  insert.run('archived', 'archived', null);
  insert.run('packed', 'archived', '2026-01-01T00:00:00.000Z');
  insert.run('open', 'ready', null);
  const before = Date.now();
  sqlite.exec(readFileSync(new URL(migration, migrations), 'utf8'));
  const due = (id: string) => (sqlite.prepare('SELECT pack_due_at FROM sessions WHERE id = ?').get(id) as { pack_due_at: string | null }).pack_due_at;
  const week = automaticPackingDays * 24 * 3600_000;
  assert.match(due('archived')!, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.ok(Math.abs(Date.parse(due('archived')!) - (before + week)) < 60_000);
  assert.equal(due('packed'), null);
  assert.equal(due('open'), null);
  assert.deepEqual({ ...sqlite.prepare("SELECT COUNT(*) AS n FROM workspace_packing_settings").get() }, { n: 0 }, 'no row: automatic packing on');
});
