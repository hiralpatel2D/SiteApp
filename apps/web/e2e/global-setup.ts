import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// The e2e suite owns the test database: start every run from empty tables so
// fixed names (owner@sitediary.test, mehta-infra) never collide with a past run.
const TABLES = [
  'audit_log',
  'invitations',
  'project_assignments',
  'memberships',
  'role_capabilities',
  'roles',
  'projects',
  'companies',
  'verifications',
  'accounts',
  'sessions',
  'users',
];

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Refuses to truncate anything but a local database whose name ends in `_test`. */
function assertLocalTestDatabase(url: string): void {
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

export default async function globalSetup(): Promise<void> {
  const envFile = fileURLToPath(new URL('../../api/.env.test', import.meta.url));
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error('e2e needs MIGRATION_DATABASE_URL (run scripts/test-db.sh start)');
  assertLocalTestDatabase(url);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<{ name: string }>(
      'select t as name from unnest($1::text[]) t where to_regclass(t) is not null',
      [TABLES],
    );
    if (rows.length)
      await client.query(`truncate table ${rows.map((r) => r.name).join(', ')} cascade`);
  } finally {
    await client.end();
  }
}
