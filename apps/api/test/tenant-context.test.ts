import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { defaultCapabilities } from '@sitediary/shared';
import { createCompany } from '../src/companies/create-company';
import { writeAudit } from '../src/audit/audit';
import { auditLog, companies } from '../src/db/schema';
import { requireCap, runInTenant, tenantMiddleware, type TenantEnv } from '../src/tenant/context';
import { errorHandler } from '../src/http/errors';
import { sessionMiddleware } from '../src/auth/session';
import { createAuth } from '../src/auth/auth';
import { ownerDb, pools, cfg, useTestDb } from './helpers/db';
import { recordingEmail, req, seedMember, testApp } from './helpers/auth';

useTestDb();

async function setup() {
  const a = await createCompany(ownerDb, { name: 'Alpha', slug: 'alpha' });
  const b = await createCompany(ownerDb, { name: 'Bravo', slug: 'bravo' });
  const { app } = testApp();
  return { a, b, app };
}

describe('tenantMiddleware', () => {
  it('no x-company-id → 400 company_required', async () => {
    const { a, app } = await setup();
    const m = await seedMember(a.companyId, 'site_engineer', 'se@x.test', { app });
    for (const company of [undefined, 'not-a-uuid']) {
      const r = await req(app, '/api/company/context', { cookie: m.cookie, company });
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({
        error: { code: 'company_required', message: 'Choose a company first.' },
      });
    }
  });

  it('no session → 401', async () => {
    const { a, app } = await setup();
    const r = await req(app, '/api/company/context', { company: a.companyId });
    expect(r.status).toBe(401);
  });

  it('another company’s real id → 403 not_a_member (same as random id)', async () => {
    const { a, b, app } = await setup();
    const m = await seedMember(a.companyId, 'admin', 'ad@x.test', { app });
    const real = await req(app, '/api/company/context', { cookie: m.cookie, company: b.companyId });
    const random = await req(app, '/api/company/context', {
      cookie: m.cookie,
      company: crypto.randomUUID(),
    });
    expect(real.status).toBe(403);
    expect(random.status).toBe(403);
    const expected = {
      error: { code: 'not_a_member', message: 'You do not have access to this company.' },
    };
    expect(await real.json()).toEqual(expected);
    expect(await random.json()).toEqual(expected);
  });

  it('deactivated membership → 403 not_a_member', async () => {
    const { a, app } = await setup();
    const m = await seedMember(a.companyId, 'admin', 'gone@x.test', {
      app,
      status: 'deactivated',
    });
    const r = await req(app, '/api/company/context', { cookie: m.cookie, company: a.companyId });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('not_a_member');
  });

  it('suspended company → 403 company_suspended', async () => {
    const { a, app } = await setup();
    const m = await seedMember(a.companyId, 'admin', 'ad@x.test', { app });
    await ownerDb
      .update(companies)
      .set({ status: 'suspended' })
      .where(eq(companies.id, a.companyId));
    const r = await req(app, '/api/company/context', { cookie: m.cookie, company: a.companyId });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({
      error: {
        code: 'company_suspended',
        message: "This company's access is suspended. Contact Site Diary support.",
      },
    });
  });

  it('context returns sorted capabilities of the role', async () => {
    const { a, app } = await setup();
    const m = await seedMember(a.companyId, 'site_engineer', 'se@x.test', { app });
    const r = await req(app, '/api/company/context', { cookie: m.cookie, company: a.companyId });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      company: unknown;
      role: unknown;
      capabilities: string[];
    };
    expect(body.company).toEqual({ id: a.companyId, name: 'Alpha', slug: 'alpha' });
    expect(body.role).toEqual({
      id: a.roleIds.site_engineer,
      name: 'Site Engineer',
      key: 'site_engineer',
    });
    expect(body.capabilities).toEqual([...defaultCapabilities('site_engineer')].sort());
  });

  it('capabilities are loaded fresh on every request', async () => {
    const { a, app } = await setup();
    const m = await seedMember(a.companyId, 'site_engineer', 'se@x.test', { app });
    await pools.owner.query(
      `delete from role_capabilities where role_id = $1 and capability = 'safety.view'`,
      [a.roleIds.site_engineer],
    );
    const r = await req(app, '/api/company/context', { cookie: m.cookie, company: a.companyId });
    const body = (await r.json()) as { capabilities: string[] };
    expect(body.capabilities).not.toContain('safety.view');
  });
});

function guardedApp() {
  const auth = createAuth({
    pools,
    config: cfg,
    email: recordingEmail(),
    canSignUp: async () => false,
  });
  const app = new Hono<TenantEnv>();
  app.onError(errorHandler);
  app.use('*', sessionMiddleware(auth));
  app.use('*', tenantMiddleware(pools));
  app.get('/needs-users', requireCap('users.manage'), (c) => c.json({ ok: true }));
  app.post('/audit', async (c) => {
    await runInTenant(c, (tx) =>
      writeAudit(tx, c.get('tenant'), {
        action: 'thing.created',
        entity: 'thing',
        after: { n: 1 },
      }),
    );
    return c.json({ ok: true });
  });
  return app;
}

describe('requireCap and writeAudit', () => {
  it('requireCap blocks a missing capability with 403 forbidden', async () => {
    const { a, app } = await setup();
    const se = await seedMember(a.companyId, 'site_engineer', 'se@x.test', { app });
    const sa = await seedMember(a.companyId, 'super_admin', 'sa@x.test', { app });
    const g = guardedApp();
    const hdr = (cookie = '') => ({ cookie, 'x-company-id': a.companyId });
    const denied = await g.request('/needs-users', { headers: hdr(se.cookie) });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({
      error: { code: 'forbidden', message: 'You do not have permission to do this.' },
    });
    const ok = await g.request('/needs-users', { headers: hdr(sa.cookie) });
    expect(ok.status).toBe(200);
  });

  it('writeAudit stores user, action and entity under the tenant', async () => {
    const { a, app } = await setup();
    const sa = await seedMember(a.companyId, 'super_admin', 'sa@x.test', { app });
    const g = guardedApp();
    const r = await g.request('/audit', {
      method: 'POST',
      headers: { cookie: sa.cookie!, 'x-company-id': a.companyId },
    });
    expect(r.status).toBe(200);
    const rows = await ownerDb.select().from(auditLog).where(eq(auditLog.companyId, a.companyId));
    const row = rows.find((x) => x.action === 'thing.created')!;
    expect(row).toMatchObject({
      companyId: a.companyId,
      userId: sa.userId,
      createdBy: sa.userId,
      entity: 'thing',
      entityId: null,
      after: { n: 1 },
    });
  });
});
