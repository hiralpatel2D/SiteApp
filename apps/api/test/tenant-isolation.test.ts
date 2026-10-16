import { describe, it, expect } from 'vitest';
import pg from 'pg';
import { newId } from '@sitediary/shared';
import { withTenant } from '../src/db/tenant';
import { companies, projects, roleCapabilities, roles } from '../src/db/schema';
import { app, owner, ownerDb, seedTwoCompanies, useTestDb } from './helpers/db';

useTestDb();

describe('tenant isolation (RLS)', () => {
  it('tenant A sees only its own projects', async () => {
    const { a } = await seedTwoCompanies();
    const rows = await withTenant(app, { companyId: a }, (tx) => tx.select().from(projects));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.companyId).toBe(a);
  });
  it('no tenant context sees nothing', async () => {
    await seedTwoCompanies();
    const { rows } = await app.query('select * from projects');
    expect(rows).toHaveLength(0);
  });
  it('tenant context does not leak across pooled connections', async () => {
    const { a } = await seedTwoCompanies();
    const small = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    await withTenant(small, { companyId: a }, (tx) => tx.select().from(projects));
    const { rows } = await small.query('select * from projects');
    expect(rows).toHaveLength(0);
    await small.end();
  });
  it('cannot insert a row for another company', async () => {
    const { a, b } = await seedTwoCompanies();
    await expect(
      withTenant(app, { companyId: a }, (tx) =>
        tx.insert(projects).values({ id: newId(), companyId: b, name: 'X', code: 'X1' }),
      ),
    ).rejects.toThrow(/row-level security/);
  });
  it('cannot read another company row', async () => {
    const { a } = await seedTwoCompanies();
    const rows = await withTenant(app, { companyId: a }, (tx) => tx.select().from(companies));
    expect(rows.map((r) => r.id)).toEqual([a]);
  });

  // Guards beyond the brief's six: catch a future table that forgets RLS, and
  // a cross-tenant reference slipping through an FK (FK checks bypass RLS).
  it('every table with company_id has forced RLS and a policy', async () => {
    const { rows } = await owner.query<{
      table: string;
      rls: boolean;
      forced: boolean;
      policies: number;
    }>(`
      select c.relname as table, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
             (select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and exists (select 1 from information_schema.columns col
                    where col.table_schema = 'public' and col.table_name = c.relname and col.column_name = 'company_id')
      order by 1`);
    expect(rows.map((r) => r.table)).toEqual([
      'attendance_entries',
      'attendance_settings',
      'audit_log',
      'face_registrations',
      'invitations',
      'memberships',
      'project_assignments',
      'projects',
      'role_capabilities',
      'roles',
    ]);
    for (const r of rows)
      expect(r, r.table).toMatchObject({ rls: true, forced: true, policies: 1 });
  });
  it('cannot attach a capability to another company role', async () => {
    const { a, b } = await seedTwoCompanies();
    const roleB = newId();
    await ownerDb.insert(roles).values({ id: roleB, companyId: b, name: 'Site Manager' });
    await expect(
      withTenant(app, { companyId: a }, (tx) =>
        tx
          .insert(roleCapabilities)
          .values({ id: newId(), companyId: a, roleId: roleB, capability: 'diary.write' }),
      ),
    ).rejects.toThrow(/foreign key/);
  });
  it('app_user cannot modify companies', async () => {
    const { a } = await seedTwoCompanies();
    await expect(
      withTenant(app, { companyId: a }, (tx) => tx.update(companies).set({ name: 'Hijacked' })),
    ).rejects.toThrow(/permission denied/);
  });
});
