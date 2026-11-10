export type SqlValue = string | number | null | Uint8Array;

export interface ExecResult {
  changes: number;
}

export interface Query<T> {
  bind(...values: SqlValue[]): Query<T>;
  first(): Promise<T | null>;
  first<K extends keyof T>(column: K): Promise<T[K] | null>;
  all(): Promise<T[]>;
  run(): Promise<ExecResult>;
}

export interface Database {
  readonly provider: DatabaseProviderName;
  query<T = Record<string, SqlValue>>(sql: string): Query<T>;
  batch<T = Record<string, SqlValue>>(statements: Query<T>[]): Promise<{ results: T[]; changes: number }[]>;
  transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
  migrate(): Promise<void>;
  close(): Promise<void>;
}

export interface InstanceLock {
  release(): Promise<void>;
}

export class InstanceLockedError extends Error {
  constructor() {
    super('Another Pikibun server already serves this database. Pikibun runs as a single instance: stop the other server first.');
    this.name = 'InstanceLockedError';
  }
}

export interface Transaction {
  query<T = Record<string, SqlValue>>(sql: string): Query<T>;
}

export const databaseProviderNames = ['sqlite', 'postgres'] as const;
export type DatabaseProviderName = (typeof databaseProviderNames)[number];

export class ConstraintError extends Error {
  constructor(message: string, readonly constraint: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConstraintError';
  }
}
