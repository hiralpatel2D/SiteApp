import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { newId } from '@sitediary/shared';
import { createCompany } from '../src/companies/create-company';
import {
  DEFAULT_TEST_PASSWORD,
  TEST_EMPLOYEES,
  removeTestEmployees,
  seedTestEmployees,
} from '../src/testing/test-employees';
import { memberships, projectAssignments, projects, users } from '../src/db/schema';
import { cfg, ownerDb, pools, useTestDb } from './helpers/db';
import { req, seedMember, signIn, testApp } from './helpers/auth';

useTestDb();

const deps = { pools, config: cfg };

async function company(slug = 'acme') {
  const { companyId } = await createCompany(ownerDb, { name: 'Acme', slug });
  await ownerDb.insert(projects).values({ id: newId(), companyId, name: 'Tower', code: 'T1' });
  return companyId;
}

describe('test employees', () => {
  it('has one per role and none is Super Admin or Admin', () => {
    const roles = TEST_EMPLOYEES.map((e) => e.role);
    expect(roles).toHaveLength(7);
    expect(roles).not.toContain('super_admin');
    expect(roles).not.toContain('admin');
  });

  it('each employee signs in with no onboarding steps and lands in the company', async () => {
    const companyId = await company();
    const r = await seedTestEmployees(deps, { companySlug: 'acme' });
    expect(r.created).toHaveLength(7);

    const { app } = testApp();
    for (const e of TEST_EMPLOYEES) {
      const cookie = await signIn(app, e.email, DEFAULT_TEST_PASSWORD);
      const me = (await (await req(app, '/api/me', { cookie })).json()) as {
        user: { name: string; mustChangePassword: boolean };
        memberships: { companyId: string; roleName: string }[];
      };
      expect(me.user.name).toBe(e.name);
      expect(me.user.mustChangePassword).toBe(false);
      expect(me.memberships).toHaveLength(1);
      expect(me.memberships[0]!.companyId).toBe(companyId);
      expect(['Super Admin', 'Admin']).not.toContain(me.memberships[0]!.roleName);
    }
    const assigned = await ownerDb.select().from(projectAssignments);
    expect(assigned).toHaveLength(7);
  });

  it('running twice creates nobody new', async () => {
    await company();
    await seedTestEmployees(deps, { companySlug: 'acme' });
    const again = await seedTestEmployees(deps, { companySlug: 'acme' });
    expect(again.created).toHaveLength(0);
    expect(again.skipped).toHaveLength(7);
  });

  it('creates the Test Workspace with a project when asked, and reuses it', async () => {
    const r = await seedTestEmployees(deps, {
      companySlug: 'test-workspace',
      createIfMissing: true,
    });
    expect(r.created).toHaveLength(7);
    expect(r.projects).toBe(1);
    await removeTestEmployees(pools);
    const again = await seedTestEmployees(deps, {
      companySlug: 'test-workspace',
      createIfMissing: true,
    });
    expect(again.created).toHaveLength(7);
    expect(await ownerDb.select().from(projects)).toHaveLength(1);
  });

  it('rejects an unknown company', async () => {
    await expect(seedTestEmployees(deps, { companySlug: 'nope' })).rejects.toThrow(/No company/);
  });

  it('remove deletes only the test employees and what hangs off them', async () => {
    const companyId = await company();
    const real = await seedMember(companyId, 'site_engineer', 'real.person@acme.in', {
      signIn: false,
    });
    await seedTestEmployees(deps, { companySlug: 'acme' });

    expect(await removeTestEmployees(pools)).toBe(7);
    expect(await removeTestEmployees(pools)).toBe(0);

    const left = await ownerDb.select().from(users);
    expect(left.map((u) => u.email)).toEqual(['real.person@acme.in']);
    const ms = await ownerDb.select().from(memberships).where(eq(memberships.userId, real.userId));
    expect(ms).toHaveLength(1);
    expect(await ownerDb.select().from(projectAssignments)).toHaveLength(0);
  });
});
