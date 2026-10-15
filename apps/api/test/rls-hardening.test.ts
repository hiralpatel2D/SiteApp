import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { newId } from '@sitediary/shared';
import { withTenant } from '../src/db/tenant';
import { auditLog } from '../src/db/schema';
import { app, owner, seedTwoCompanies, useTestDb } from './helpers/db';

useTestDb();

describe('RLS hardening', () => {
  it('app_user can insert and read but not update or delete audit_log', async () => {
    const { a } = await seedTwoCompanies();
    const id = newId();
    await withTenant(app, { companyId: a }, (tx) =>
      tx.insert(auditLog).values({ id, companyId: a, action: 'x.y', entity: 'x' }),
    );
    const rows = await withTenant(app, { companyId: a }, (tx) => tx.select().from(auditLog));
    expect(rows).toHaveLength(1);
    await expect(
      withTenant(app, { companyId: a }, (tx) =>
        tx.update(auditLog).set({ action: 'z' }).where(eq(auditLog.id, id)),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withTenant(app, { companyId: a }, (tx) => tx.delete(auditLog).where(eq(auditLog.id, id))),
    ).rejects.toThrow(/permission denied/);
  });

  it('PUBLIC has no CREATE on schema public', async () => {
    const { rows } = await owner.query<{ c: boolean }>(
      "select has_schema_privilege('public','public','CREATE') as c",
    );
    expect(rows[0]!.c).toBe(false);
  });
});
