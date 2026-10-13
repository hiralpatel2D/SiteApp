import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { newId } from '@sitediary/shared';
import { loadConfig } from '../../src/config';
import { createPools } from '../../src/db/pools';
import { runMigrations } from '../../src/db/migrate';
import { companies, projects } from '../../src/db/schema';

// Locally, env comes from apps/api/.env.test (see scripts/test-db.sh); in CI
// from the process env. loadEnvFile never overrides variables already set.
const envFile = fileURLToPath(new URL('../../.env.test', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const cfg = loadConfig({ ...process.env, NODE_ENV: 'test' });
const pools = createPools(cfg);

/** Owner (BYPASSRLS) pool: seeding and cleanup only. */
export const owner = pools.owner;
/** Restricted app_user pool: what the API uses at runtime. */
export const app = pools.app;
export const ownerDb = pools.ownerDb;

const TENANT_TABLES = ['audit_log', 'role_capabilities', 'roles', 'projects', 'companies'];

export async function truncateAll(): Promise<void> {
  await owner.query(`truncate table ${TENANT_TABLES.join(', ')} cascade`);
}

/** Registers hooks: migrate once per file, truncate before each test, close pools after. */
export function useTestDb(): void {
  beforeAll(async () => {
    await runMigrations(cfg.migrationDatabaseUrl);
  });
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    await pools.owner.end();
    await pools.app.end();
  });
}

/** Two companies, each with one project. Seeded as owner. */
export async function seedTwoCompanies(): Promise<{ a: string; b: string }> {
  const a = newId();
  const b = newId();
  await ownerDb.insert(companies).values([
    { id: a, name: 'Alpha Builders', slug: `alpha-${a}` },
    { id: b, name: 'Bravo Construction', slug: `bravo-${b}` },
  ]);
  await ownerDb.insert(projects).values([
    { id: newId(), companyId: a, name: 'Alpha Tower', code: 'AT1' },
    { id: newId(), companyId: b, name: 'Bravo Bridge', code: 'BB1' },
  ]);
  return { a, b };
}
