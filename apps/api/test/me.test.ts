import { describe, it, expect } from 'vitest';
import { createCompany } from '../src/companies/create-company';
import { memberships } from '../src/db/schema';
import { ownerDb, useTestDb } from './helpers/db';
import { req, seedUser, signIn, testApp } from './helpers/auth';

useTestDb();

const PASSWORD = 'longpassword1';

type Me = {
  user: { id: string; name: string; email: string; isPlatformAdmin: boolean };
  memberships: Array<{
    companyId: string;
    companyName: string;
    companySlug: string;
    companyStatus: string;
    roleName: string;
    status: string;
  }>;
};

describe('GET /api/me', () => {
  it('/api/me without session is 401 unauthenticated', async () => {
    const { app } = testApp();
    const r = await req(app, '/api/me');
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({
      error: { code: 'unauthenticated', message: 'Sign in to continue.' },
    });
  });

  it('a forged session cookie is 401', async () => {
    const { app } = testApp();
    const r = await req(app, '/api/me', { cookie: 'better-auth.session_token=forged.value' });
    expect(r.status).toBe(401);
  });

  it('returns the user and active memberships ordered by company name', async () => {
    const u = await seedUser({ email: 'pm@x.test', password: PASSWORD, name: 'Priya' });
    const zeta = await createCompany(ownerDb, { name: 'Zeta Works', slug: 'zeta' });
    const alpha = await createCompany(ownerDb, { name: 'Alpha Builders', slug: 'alpha' });
    const gone = await createCompany(ownerDb, { name: 'Mid Co', slug: 'mid' });
    const other = await createCompany(ownerDb, { name: 'Other Co', slug: 'other' });
    await ownerDb.insert(memberships).values([
      { companyId: zeta.companyId, userId: u.id, roleId: zeta.roleIds.project_manager },
      { companyId: alpha.companyId, userId: u.id, roleId: alpha.roleIds.admin },
      {
        companyId: gone.companyId,
        userId: u.id,
        roleId: gone.roleIds.admin,
        status: 'deactivated',
      },
    ]);
    // Someone else's membership must not show up.
    const v = await seedUser({ email: 'v@x.test', password: PASSWORD, name: 'V' });
    await ownerDb
      .insert(memberships)
      .values({ companyId: other.companyId, userId: v.id, roleId: other.roleIds.admin });

    const { app } = testApp();
    const c = await signIn(app, 'pm@x.test', PASSWORD);
    const r = await req(app, '/api/me', { cookie: c });
    expect(r.status).toBe(200);
    const body = (await r.json()) as Me;
    expect(body.user).toEqual({
      id: u.id,
      name: 'Priya',
      email: 'pm@x.test',
      isPlatformAdmin: false,
    });
    expect(body.memberships).toEqual([
      {
        companyId: alpha.companyId,
        companyName: 'Alpha Builders',
        companySlug: 'alpha',
        companyStatus: 'active',
        roleName: 'Admin',
        status: 'active',
      },
      {
        companyId: zeta.companyId,
        companyName: 'Zeta Works',
        companySlug: 'zeta',
        companyStatus: 'active',
        roleName: 'Project Manager',
        status: 'active',
      },
    ]);
  });
});
