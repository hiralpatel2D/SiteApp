import { withTestDb } from './test-db';

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
  await withTestDb(async (client) => {
    const { rows } = await client.query<{ name: string }>(
      'select t as name from unnest($1::text[]) t where to_regclass(t) is not null',
      [TABLES],
    );
    if (rows.length)
      await client.query(`truncate table ${rows.map((r) => r.name).join(', ')} cascade`);
  });
}
