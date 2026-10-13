import { describe, it, expect } from 'vitest';
import { runMigrations } from '../src/db/migrate';
import { useTestDb } from './helpers/db';

useTestDb();

describe('runMigrations', () => {
  it('migrations are idempotent', async () => {
    await runMigrations(process.env.MIGRATION_DATABASE_URL!);
    await expect(runMigrations(process.env.MIGRATION_DATABASE_URL!)).resolves.toBeUndefined();
  });
});
