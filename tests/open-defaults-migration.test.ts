import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { defaultGitHubReach } from '../packages/shared/src/github-reach.js';
import { defaultNetworkPolicy } from '../packages/shared/src/network.js';

const migrations = new URL('../apps/server/migrations/sqlite/', import.meta.url);
const migration = '0083_open_defaults.sql';

test('the open defaults are for what nobody chose yet: shared workspaces from before keep Off and their own repositories, as rows; private ones and choices stay as they are', () => {
  assert.deepEqual(defaultNetworkPolicy, { mode: 'open', domains: [], packageRegistries: true });
  assert.deepEqual(defaultGitHubReach, { anyRepository: true });
  const files = readdirSync(migrations).filter(name => name.endsWith('.sql')).sort();
  assert.ok(files.includes(migration));
  assert.ok(readdirSync(new URL('../apps/server/migrations/postgres/', import.meta.url)).includes('0076_open_defaults.sql'), 'Postgres has the same migration');
  const sqlite = new DatabaseSync(':memory:');
  for (const file of files.filter(name => name < migration)) sqlite.exec(readFileSync(new URL(file, migrations), 'utf8'));
  sqlite.exec('PRAGMA foreign_keys = OFF');
  const insert = (table: string, values: Record<string, string | number>) => {
    const required = (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string; notnull: number; dflt_value: unknown; pk: number }[])
      .filter(column => (column.notnull || column.pk) && column.dflt_value === null && !(column.name in values)).map(column => column.name);
    const row = { ...Object.fromEntries(required.map(name => [name, 'x'])), ...values };
    sqlite.prepare(`INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`).run(...Object.values(row));
  };
  for (const id of ['team', 'chosen', 'private']) insert('workspaces', { id, owner_id: 'ada' });
  insert('personal_workspaces', { user_id: 'ada', workspace_id: 'private' });
  for (const [workspace_id, user_id, role] of [['team', 'ada', 'owner'], ['team', 'bob', 'member'], ['chosen', 'ada', 'owner'], ['chosen', 'bob', 'member'], ['private', 'ada', 'owner']]) {
    insert('workspace_members', { workspace_id: workspace_id!, user_id: user_id!, role: role! });
  }
  insert('workspace_network_policies', { workspace_id: 'chosen', mode: 'allowlist', domains_json: '["docs.example.com"]', package_registries: 0, updated_by: 'bob', updated_at: '2026-01-01T00:00:00.000Z' });
  insert('member_github_reach', { workspace_id: 'chosen', user_id: 'bob', any_repository: 1, updated_at: '2026-01-01T00:00:00.000Z' });

  sqlite.exec(readFileSync(new URL(migration, migrations), 'utf8'));

  const policies = sqlite.prepare('SELECT workspace_id, mode, domains_json, package_registries, updated_by FROM workspace_network_policies ORDER BY workspace_id').all().map(row => ({ ...row }));
  assert.deepEqual(policies, [
    { workspace_id: 'chosen', mode: 'allowlist', domains_json: '["docs.example.com"]', package_registries: 0, updated_by: 'bob' },
    { workspace_id: 'team', mode: 'off', domains_json: '[]', package_registries: 1, updated_by: 'ada' },
  ]);
  const reach = sqlite.prepare('SELECT workspace_id, user_id, any_repository FROM member_github_reach ORDER BY workspace_id, user_id').all().map(row => ({ ...row }));
  assert.deepEqual(reach, [
    { workspace_id: 'chosen', user_id: 'ada', any_repository: 0 },
    { workspace_id: 'chosen', user_id: 'bob', any_repository: 1 },
    { workspace_id: 'team', user_id: 'ada', any_repository: 0 },
    { workspace_id: 'team', user_id: 'bob', any_repository: 0 },
  ]);
  const stamp = sqlite.prepare("SELECT updated_at FROM workspace_network_policies WHERE workspace_id = 'team'").get() as { updated_at: string };
  assert.match(stamp.updated_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
});
