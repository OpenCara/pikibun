import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { withSessionToolsListed, type WorkspaceExtension } from '../packages/shared/src/host-extensions.js';
import { documentKindsOff, sessionToolsOff } from '../packages/shared/src/piki-extensions.js';

const migrations = new URL('../apps/server/migrations/sqlite/', import.meta.url);
const migration = '0058_session_tool_extensions.sql';

const kept = ['piki:browser', 'piki:dotnet', 'piki:git', 'piki:go', 'piki:host-shell', 'piki:make', 'piki:node', 'piki:python', 'piki:rust',
  'piki:schedule', 'piki:sessions', 'piki:shell'];

test('existing workspaces keep the session tools they had on, now that a workspace has one only once it is added', () => {
  const files = readdirSync(migrations).filter(name => name.endsWith('.sql')).sort();
  assert.ok(files.includes(migration));
  assert.ok(readdirSync(new URL('../apps/server/migrations/postgres/', import.meta.url)).includes('0051_session_tool_extensions.sql'), 'Postgres has the same migration');
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const file of files.filter(name => name < migration)) sqlite.exec(readFileSync(new URL(file, migrations), 'utf8'));
  sqlite.exec(`INSERT INTO users (id, display_name, git_name, git_email, auth_kind, created_at) VALUES ('owner', 'Owner', 'Owner', 'owner@example.test', 'test', '2026-01-01');
    INSERT INTO workspaces (id, name, owner_id, created_at) VALUES ('code', 'Code', 'owner', '2026-01-01'), ('docs', 'Docs', 'owner', '2026-01-01'),
      ('empty', 'Empty', 'owner', '2026-01-01');
    INSERT INTO workspace_extensions (workspace_id, package_key, source, position, enabled, tools_mode, settings_json, updated_by, updated_at)
      VALUES ('code', 'npm:pi-memory', 'npm:pi-memory@1.0.0', 1, 1, 'approval', '{}', 'owner', '2026-01-02'),
        ('code', 'piki:schedule', 'piki:schedule', 2, 0, 'approval', '{}', 'owner', '2026-01-02'),
        ('code', 'piki:tunnel', 'piki:tunnel', 3, 1, 'approval', '{}', 'owner', '2026-01-02'),
        ('docs', 'piki:sources', 'piki:sources', 1, 0, 'approval', '{}', 'owner', '2026-01-02'),
        ('docs', 'piki:dropbox', 'piki:dropbox', 2, 1, 'approval', '{}', 'owner', '2026-01-02');`);
  sqlite.prepare(`INSERT INTO workspace_repositories (id, workspace_id, provider, host, repository_id, full_name, ref, private, created_at)
    VALUES ('r1', 'code', 'github', 'github.com', '1', 'acme/one', 'main', 0, '2026-01-03')`).run();
  const source = sqlite.prepare("INSERT INTO workspace_sources (id, workspace_id, kind, repository_binding_id, created_at) VALUES (?, ?, ?, NULL, '2026-01-03')");
  const detail = sqlite.prepare("INSERT INTO document_sources (source_id, workspace_id, kind, item_id, item_type, title, url, created_by) VALUES (?, ?, ?, ?, 'page', 'Specs', 'https://example.test/x', 'owner')");
  for (const [id, workspace, kind] of [['n1', 'code', 'notion'], ['n2', 'docs', 'notion'], ['d1', 'docs', 'dropbox']]) {
    source.run(id!, workspace!, kind!); detail.run(id!, workspace!, kind!, id!);
  }
  const before = (workspace: string) => listed(sqlite, workspace);
  const was = { code: before('code'), docs: before('docs'), empty: before('empty') };
  sqlite.exec(readFileSync(new URL(migration, migrations), 'utf8'));

  const rows = (workspace: string) => sqlite.prepare('SELECT source, enabled, updated_by FROM workspace_extensions WHERE workspace_id = ? ORDER BY source').all(workspace)
    .map(row => [row.source, row.enabled, row.updated_by]);
  const on = (sources: string[]) => sources.map(source => [source, 1, 'owner']);
  const byName = (a: unknown[], b: unknown[]) => (String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0);
  assert.deepEqual(rows('code'), [...on([...kept.filter(source => source !== 'piki:schedule'), 'piki:github', 'piki:notion']), ['npm:pi-memory@1.0.0', 1, 'owner'],
    ['piki:schedule', 0, 'owner'], ['piki:tunnel', 1, 'owner']].sort(byName));
  assert.deepEqual(rows('docs'), [...on([...kept, 'piki:dropbox']), ['piki:sources', 0, 'owner']].sort(byName));
  assert.deepEqual(rows('empty'), on(kept));

  const after = { code: listed(sqlite, 'code'), docs: listed(sqlite, 'docs'), empty: listed(sqlite, 'empty') };
  assert.deepEqual([...sessionToolsOff(withSessionToolsListed(after.code))].sort(), [...sessionToolsOff(was.code)].sort());
  assert.deepEqual([...documentKindsOff(withSessionToolsListed(after.code))].sort(), ['dropbox', 'feishu', 'google-drive', 'onedrive', 'tencent-docs'], 'kinds it has no source of');
  assert.deepEqual([...documentKindsOff(withSessionToolsListed(after.docs))].sort(), [...documentKindsOff(was.docs)].sort());
  assert.deepEqual([...sessionToolsOff(withSessionToolsListed(after.empty))].sort(),
    [...sessionToolsOff(was.empty), 'github_comment', 'github_issue', 'github_merge', 'github_read', 'source_read'].sort());
  const count = () => sqlite.prepare('SELECT COUNT(*) AS n FROM workspace_extensions').get()!.n;
  const total = count();
  sqlite.exec(readFileSync(new URL(migration, migrations), 'utf8'));
  assert.equal(count(), total);
  const updated = sqlite.prepare("SELECT updated_at FROM workspace_extensions WHERE workspace_id = 'empty'").get()!.updated_at as string;
  assert.match(updated, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
});

function listed(sqlite: DatabaseSync, workspace: string): WorkspaceExtension[] {
  return sqlite.prepare('SELECT source, enabled FROM workspace_extensions WHERE workspace_id = ? ORDER BY position, package_key').all(workspace)
    .map(row => ({ source: String(row.source), enabled: Number(row.enabled) === 1, tools: 'approval' as const, settings: {} }));
}
