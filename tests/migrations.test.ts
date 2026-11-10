import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import test from 'node:test';

type Provider = 'sqlite' | 'postgres';

const prefixesSharedBeforeTheRule: Record<Provider, readonly string[]> = {
  sqlite: ['0013', '0024', '0036', '0047'],
  postgres: ['0006', '0017', '0029', '0040'],
};
const firstMigrationInBothProviders = 'chat_agents';

function migrationFiles(provider: Provider): string[] {
  return readdirSync(new URL(`../apps/server/migrations/${provider}/`, import.meta.url)).filter(name => name.endsWith('.sql')).sort();
}

const prefixOf = (file: string) => file.slice(0, file.indexOf('_'));
const subjectOf = (file: string) => file.slice(file.indexOf('_') + 1, -'.sql'.length);

for (const provider of ['sqlite', 'postgres'] as const) {
  test(`${provider} migrations are named NNNN_subject.sql and no new one shares a prefix`, () => {
    const files = migrationFiles(provider);
    for (const file of files) assert.match(file, /^\d{4}_[a-z0-9_]+\.sql$/, file);
    const filesByPrefix = Map.groupBy(files, prefixOf);
    const shared = [...filesByPrefix].filter(([, group]) => group.length > 1).map(([prefix]) => prefix);
    assert.deepEqual(shared, prefixesSharedBeforeTheRule[provider], `${provider} migrations with a prefix another file already has`);
  });

  test(`${provider} migration prefixes leave no gap`, () => {
    const prefixes = [...new Set(migrationFiles(provider).map(prefixOf))].map(Number);
    assert.deepEqual(prefixes, prefixes.map((_, index) => index + 1));
  });
}

test('every migration since the Postgres baseline exists for both providers, in the same order', () => {
  const sqlite = migrationFiles('sqlite').map(subjectOf);
  const postgres = migrationFiles('postgres').map(subjectOf);
  const sharedSqlite = sqlite.slice(sqlite.indexOf(firstMigrationInBothProviders));
  const sharedPostgres = postgres.slice(postgres.indexOf(firstMigrationInBothProviders));
  assert.ok(sharedSqlite.length > 0 && sharedPostgres.length > 0);
  assert.deepEqual(sharedPostgres, sharedSqlite);
});
