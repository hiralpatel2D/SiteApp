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

export default async function globalSetup(): Promise<void> {
  const envFile = fileURLToPath(new URL('../../api/.env.test', import.meta.url));
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error('e2e needs MIGRATION_DATABASE_URL (run scripts/test-db.sh start)');
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
