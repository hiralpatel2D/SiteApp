import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createCompany } from '../src/companies/create-company';
import { memberships, sessions } from '../src/db/schema';
import { ownerDb, useTestDb } from './helpers/db';
import { cookieFrom, req, seedUser, signIn, testApp } from './helpers/auth';

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

describe('session refresh (sliding expiry)', () => {
  const DAY = 24 * 60 * 60 * 1000;

  it('a near-expiry session is extended and the refreshed cookie reaches the browser', async () => {
    const u = await seedUser({ email: 'refresh@x.test', password: PASSWORD, name: 'Ref' });
    const { app } = testApp();
    const cookie = await signIn(app, u.email, PASSWORD);
    // Two days left of seven: past Better Auth's one-day update age.
    await ownerDb
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() + 2 * DAY) })
      .where(eq(sessions.userId, u.id));

    const r = await req(app, '/api/me', { cookie });
    expect(r.status).toBe(200);
    const refreshed = r.headers.getSetCookie().find((c) => c.includes('session_token='));
    expect(refreshed).toBeDefined();
    expect(refreshed).toMatch(/Max-Age=604800/);
    expect(refreshed).toMatch(/HttpOnly/i);

    const [s] = await ownerDb.select().from(sessions).where(eq(sessions.userId, u.id));
    expect(s!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * DAY);

    // The refreshed cookie keeps working.
    const again = await req(app, '/api/me', { cookie: cookieFrom(r) });
    expect(again.status).toBe(200);
  });

  it('a fresh session gets no Set-Cookie on ordinary API calls', async () => {
    const u = await seedUser({ email: 'fresh@x.test', password: PASSWORD, name: 'Fresh' });
    const { app } = testApp();
    const cookie = await signIn(app, u.email, PASSWORD);
    const r = await req(app, '/api/me', { cookie });
    expect(r.status).toBe(200);
    expect(r.headers.getSetCookie()).toEqual([]);
  });

  it('the refreshed cookie is kept on error responses too', async () => {
    const u = await seedUser({ email: 'refresh.err@x.test', password: PASSWORD, name: 'Err' });
    const { app } = testApp();
    const cookie = await signIn(app, u.email, PASSWORD);
    await ownerDb
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() + 2 * DAY) })
      .where(eq(sessions.userId, u.id));
    // No company header: 400 company_required, still with the refreshed cookie.
    const r = await req(app, '/api/company/context', { cookie });
    expect(r.status).toBe(400);
    expect(r.headers.getSetCookie().some((c) => c.includes('session_token='))).toBe(true);
  });
});
