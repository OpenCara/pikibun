import type { DatabaseSync } from 'node:sqlite';
import { migrationsDirectory } from './migrations.js';
import { SqliteDatabase, sqlitePath } from './sqlite.js';
import type { Database, InstanceLock } from './types.js';

export { ConstraintError, InstanceLockedError, InstanceLockLostError } from './types.js';
export type { Database, DatabaseProviderName, ExecResult, InstanceLock, Query, SqlValue, Transaction } from './types.js';

export async function openDatabase(url: string): Promise<Database> {
  if (url.startsWith('sqlite:')) return new SqliteDatabase(sqlitePath(url), migrationsDirectory('sqlite'));
  if (url.startsWith('postgres:') || url.startsWith('postgresql:')) {
    const { PostgresDatabase } = await import('./postgres.js');
    return new PostgresDatabase(url, migrationsDirectory('postgres'));
  }
  throw new Error('DATABASE_URL must start with sqlite:, postgres: or postgresql:.');
}

export interface LockOptions {
  heartbeatMs?: number;
  graceMs?: number;
}

export async function lockInstance(db: Database, options?: LockOptions): Promise<InstanceLock> {
  const lockable = db as Database & { lockInstance?: (options?: LockOptions) => Promise<InstanceLock> };
  return await lockable.lockInstance?.(options) ?? { release: async () => {} };
}

export function sqliteHandle(db: Database): DatabaseSync {
  if (!(db instanceof SqliteDatabase)) throw new TypeError(`sqliteHandle() needs the sqlite provider, got ${db.provider}.`);
  return db.handle;
}
