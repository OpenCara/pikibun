import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';
import { PostgresDatabase } from '../apps/server/src/db/postgres.js';

const url = process.env.TEST_DATABASE_URL;
// Its own database: other test files reset the public schema of TEST_DATABASE_URL's meanwhile.
const DATABASE = 'pikibun_raise_rename';
function inDatabase(base: string): string {
  const u = new URL(base);
  u.pathname = `/${DATABASE}`;
  return u.toString();
}
const migrations = fileURLToPath(new URL('../apps/server/migrations/postgres/', import.meta.url));

// Pistead became Pikibun, and its Postgres trigger function pistead_raise() became pikibun_raise(). A database that
// skipped releases still holds the old name when it reaches migrations that call the new one (0033_workspace_sources
// is the first), so migrate() renames the function before applying any file.
test('a Postgres database from before the rename migrates past files that call pikibun_raise()', { skip: url ? false : 'TEST_DATABASE_URL is not set; skipping the Postgres run' }, async t => {
  const old = mkdtempSync(join(tmpdir(), 'pistead-migrations-'));
  t.after(() => rmSync(old, { recursive: true, force: true }));
  // The migrations a Pistead release before 0033 shipped: the same files, with the function under its old name.
  const files = readdirSync(migrations).filter(name => name.endsWith('.sql')).sort();
  const before = files.filter(name => name < '0033');
  assert.ok(files.length > before.length, 'later migrations remain to apply');
  for (const name of before) writeFileSync(join(old, name), readFileSync(join(migrations, name), 'utf8').replaceAll('pikibun_raise', 'pistead_raise'));

  // CREATE and DROP DATABASE can't run in a transaction block, so straight through the driver.
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DATABASE}`);
  t.after(async () => { await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`); await admin.end(); });

  const legacy = new PostgresDatabase(inDatabase(url!), old);
  try {
    await legacy.migrate();
    const proc = (name: string) => legacy.query<{ oid: string | null }>(`SELECT to_regprocedure('${name}()')::text AS oid`).first('oid');
    assert.notEqual(await proc('pistead_raise'), null);
    assert.equal(await proc('pikibun_raise'), null);
  } finally {
    await legacy.close();
  }

  const db = new PostgresDatabase(inDatabase(url!), migrations);
  try {
    await upgraded(db, files);
  } finally {
    await db.close();
  }
});

async function upgraded(db: PostgresDatabase, files: string[]): Promise<void> {
  await db.migrate();
  const applied = await db.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name').all();
  assert.deepEqual(applied.map(row => row.name), files);
  const functions = await db.query<{ name: string; triggers: number }>(`
    SELECT p.proname AS name, COUNT(t.oid)::int AS triggers FROM pg_proc p LEFT JOIN pg_trigger t ON t.tgfoid = p.oid
    WHERE p.proname IN ('pistead_raise', 'pikibun_raise') GROUP BY p.proname`).all();
  assert.equal(functions.length, 1, 'one trigger function, under the new name');
  assert.equal(functions[0]!.name, 'pikibun_raise');
  // The triggers of 0001 and of 0033 and later all call it.
  const sources = await db.query<{ n: number }>(`
    SELECT COUNT(*)::int AS n FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE p.proname = 'pikibun_raise' AND t.tgrelid = 'workspace_sources'::regclass`).first('n');
  assert.ok(sources! > 0);
  assert.ok(functions[0]!.triggers > sources!);

  // Migrating again leaves it as it is.
  await db.migrate();
  assert.equal(await db.query(`SELECT to_regprocedure('pikibun_raise()')::text AS oid`).first('oid'), 'pikibun_raise()');
}
