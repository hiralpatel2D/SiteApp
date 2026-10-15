import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Refuses anything but a local database whose name ends in `_test`. */
export function assertLocalTestDatabase(url: string): void {
  let host = '';
  let name = '';
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    name = decodeURIComponent(u.pathname.replace(/^\//, ''));
  } catch {
    // Unparseable: falls through to the refusal below.
  }
  if (!LOCAL_HOSTS.has(host) || !name.endsWith('_test')) {
    throw new Error(
      `e2e refuses to empty this database: MIGRATION_DATABASE_URL must point at a local ` +
        `database whose name ends in _test (got host "${host}", database "${name}").`,
    );
  }
}

/**
 * Runs `fn` with an owner connection to the e2e test database. Locally the
 * settings come from apps/api/.env.test; in CI from the job env. Always checks
 * that the database is a local `_test` one first.
 */
export async function withTestDb<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const envFile = fileURLToPath(new URL('../../api/.env.test', import.meta.url));
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error('e2e needs MIGRATION_DATABASE_URL (run scripts/test-db.sh start)');
  assertLocalTestDatabase(url);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
