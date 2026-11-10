import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseProviderName } from './types.js';

export interface MigrationFile { name: string; sql: string }

export function migrationsDirectory(provider: DatabaseProviderName): string {
  if (process.env.MIGRATIONS_DIR) return resolve(process.env.MIGRATIONS_DIR, provider);
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 3; depth++) {
    const candidate = join(directory, 'migrations', provider);
    if (existsSync(candidate)) return candidate;
    directory = dirname(directory);
  }
  throw new Error(`No migrations directory for ${provider} near ${fileURLToPath(import.meta.url)}; set MIGRATIONS_DIR.`);
}

export async function readMigrations(directory: string): Promise<MigrationFile[]> {
  const names = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
  return Promise.all(names.map(async name => ({ name, sql: await readFile(join(directory, name), 'utf8') })));
}
