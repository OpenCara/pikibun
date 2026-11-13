import { randomUUID } from 'node:crypto';
import { after } from 'node:test';
import pg from 'pg';

export const postgresServer = process.env.TEST_DATABASE_URL || undefined;

async function onServer<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: postgresServer });
  await client.connect();
  try { return await run(client); } finally { await client.end(); }
}

export function postgresDatabase(label: string): () => Promise<string> {
  const name = `pikibun_test_${label}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let created: Promise<string> | undefined;
  after(async () => {
    if (!created || !(await created.catch(() => undefined))) return;
    await onServer(client => client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
  });
  return () => {
    if (!postgresServer) throw new Error('TEST_DATABASE_URL is not set');
    created ??= onServer(async client => {
      await client.query(`CREATE DATABASE ${name}`);
      const url = new URL(postgresServer);
      url.pathname = `/${name}`;
      return url.toString();
    });
    return created;
  };
}
