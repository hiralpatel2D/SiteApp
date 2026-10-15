import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { newId } from '@sitediary/shared';
import { auditLog, companies, invitations } from '../src/db/schema';
import { createCompany } from '../src/companies/create-company';
import { ownerDb, useTestDb } from './helpers/db';
import { req, seedMember, seedUser, signIn, testApp } from './helpers/auth';

useTestDb();

const PASSWORD = 'longpassword1';

type ErrorBody = { error: { code: string; message: string; details?: Record<string, string> } };
const errorOf = async (r: Response) => ((await r.json()) as ErrorBody).error;

async function platformAdmin(app: ReturnType<typeof testApp>['app']) {
  const u = await seedUser({
    email: 'owner@sitediary.test',
    password: PASSWORD,
    name: 'Owner',
    isPlatformAdmin: true,
  });
  return { ...u, cookie: await signIn(app, u.email, PASSWORD) };
}

const create = (
  app: ReturnType<typeof testApp>['app'],
  cookie: string,
  body: Record<string, unknown>,
) => req(app, '/api/platform/companies', { cookie, body });

describe('platform admin', () => {
  it('non-platform user → 403 forbidden on every /api/platform route', async () => {
    const { app } = testApp();
    const { companyId } = await createCompany(ownerDb, { name: 'Acme', slug: 'acme' });
    const m = await seedMember(companyId, 'admin', 'a@acme.test', { app });
    const calls: [string, string][] = [
      ['GET', '/api/platform/companies'],
      ['POST', '/api/platform/companies'],
      ['POST', `/api/platform/companies/${companyId}/suspend`],
      ['POST', `/api/platform/companies/${companyId}/reactivate`],
    ];
    for (const [method, path] of calls) {
      const r = await req(app, path, {
        cookie: m.cookie,
        method,
        body: method === 'POST' ? {} : undefined,
      });
      expect(r.status, `${method} ${path}`).toBe(403);
      expect((await errorOf(r)).code).toBe('forbidden');
    }
    const anon = await req(app, '/api/platform/companies');
    expect(anon.status).toBe(401);
  });

  it('creates company + returns super_admin inviteUrl; accepting it makes a Super Admin', async () => {
    const { app, email } = testApp();
    const admin = await platformAdmin(app);
    const r = await create(app, admin.cookie, {
      name: '  Mehta Infra ',
      slug: 'Mehta Infra',
      adminEmail: ' Boss@Mehta.TEST ',
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as {
      company: { id: string; name: string; slug: string; status: string };
      inviteUrl: string;
    };
    expect(body.company).toMatchObject({
      name: 'Mehta Infra',
      slug: 'mehta-infra',
      status: 'active',
    });
    expect(body.inviteUrl).toMatch(/\/invite\/[A-Za-z0-9_-]{43}$/);

    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]).toMatchObject({ kind: 'invitation', to: 'boss@mehta.test' });

    const audit = await ownerDb
      .select()
      .from(auditLog)
      .where(eq(auditLog.companyId, body.company.id));
    expect(audit.map((a) => a.action).sort()).toEqual(['company.created', 'invitation.created']);
    expect(audit.every((a) => a.userId === admin.id)).toBe(true);
    const [inv] = await ownerDb
      .select()
      .from(invitations)
      .where(eq(invitations.companyId, body.company.id));
    const invAudit = audit.find((a) => a.action === 'invitation.created')!;
    expect(invAudit).toMatchObject({ entity: 'invitation', entityId: inv!.id });
    expect(invAudit.after).toMatchObject({
      email: 'boss@mehta.test',
      roleId: inv!.roleId,
      projectIds: [],
      expiresAt: inv!.expiresAt.toISOString(),
    });

    const token = body.inviteUrl.split('/invite/')[1]!;
    const acc = await req(app, `/api/invitations/by-token/${token}/accept`, {
      body: { name: 'Boss', password: PASSWORD },
    });
    expect(acc.status).toBe(200);
    const cookie = await signIn(app, 'boss@mehta.test', PASSWORD);
    const ctx = await req(app, '/api/company/context', { cookie, company: body.company.id });
    const ctxBody = (await ctx.json()) as { role: { key: string } };
    expect(ctxBody.role.key).toBe('super_admin');
  });

  it('company name is trimmed and length-checked; email validated', async () => {
    const { app } = testApp();
    const admin = await platformAdmin(app);
    const short = await create(app, admin.cookie, {
      name: ' a ',
      slug: 'short-co',
      adminEmail: 'x@y.test',
    });
    expect(short.status).toBe(400);
    const e1 = await errorOf(short);
    expect(e1.code).toBe('validation_failed');
    expect(e1.details).toHaveProperty('name');

    const long = await create(app, admin.cookie, {
      name: 'n'.repeat(81),
      slug: 'long-co',
      adminEmail: 'x@y.test',
    });
    expect((await errorOf(long)).details).toHaveProperty('name');

    const badEmail = await create(app, admin.cookie, {
      name: 'Okay Co',
      slug: 'okay-co',
      adminEmail: 'nope',
    });
    expect((await errorOf(badEmail)).details).toHaveProperty('adminEmail');

    const badSlug = await create(app, admin.cookie, {
      name: 'Okay Co',
      slug: '!!',
      adminEmail: 'x@y.test',
    });
    expect(badSlug.status).toBe(400);
    expect((await errorOf(badSlug)).details).toHaveProperty('slug');

    const ok = await create(app, admin.cookie, {
      name: '  ab  ',
      slug: 'ab-co',
      adminEmail: 'x@y.test',
    });
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { company: { name: string } }).company.name).toBe('ab');
  });

  it('duplicate slug → 409 slug_taken and leaves no extra company or invitation', async () => {
    const { app, email } = testApp();
    const admin = await platformAdmin(app);
    await create(app, admin.cookie, { name: 'One Co', slug: 'one-co', adminEmail: 'a@one.test' });
    const r = await create(app, admin.cookie, {
      name: 'Two Co',
      slug: 'One Co',
      adminEmail: 'b@two.test',
    });
    expect(r.status).toBe(409);
    expect((await errorOf(r)).code).toBe('slug_taken');
    expect(await ownerDb.select().from(companies)).toHaveLength(1);
    expect(await ownerDb.select().from(invitations)).toHaveLength(1);
    expect(email.sent).toHaveLength(1);
  });

  it('lists companies ordered by name with active member counts', async () => {
    const { app } = testApp();
    const admin = await platformAdmin(app);
    const b = await createCompany(ownerDb, { name: 'Beta', slug: 'beta' });
    const a = await createCompany(ownerDb, { name: 'Alpha', slug: 'alpha' });
    await seedMember(a.companyId, 'admin', 'a1@alpha.test', { signIn: false });
    await seedMember(a.companyId, 'client', 'a2@alpha.test', { signIn: false });
    await seedMember(a.companyId, 'client', 'a3@alpha.test', {
      signIn: false,
      status: 'deactivated',
    });
    const r = await req(app, '/api/platform/companies', { cookie: admin.cookie });
    expect(r.status).toBe(200);
    const rows = (await r.json()) as Record<string, unknown>[];
    expect(rows.map((x) => x.name)).toEqual(['Alpha', 'Beta']);
    expect(rows[0]).toMatchObject({
      id: a.companyId,
      slug: 'alpha',
      status: 'active',
      plan: 'trial',
      memberCount: 2,
    });
    expect(typeof rows[0]!.createdAt).toBe('string');
    expect(rows[1]).toMatchObject({ id: b.companyId, memberCount: 0 });
  });

  it('suspend/reactivate: 404 for unknown or non-uuid id; idempotent; audited once per change', async () => {
    const { app } = testApp();
    const admin = await platformAdmin(app);
    const { companyId } = await createCompany(ownerDb, { name: 'Acme', slug: 'acme' });
    for (const id of [newId(), 'not-a-uuid']) {
      for (const action of ['suspend', 'reactivate']) {
        const r = await req(app, `/api/platform/companies/${id}/${action}`, {
          cookie: admin.cookie,
          method: 'POST',
        });
        expect(r.status).toBe(404);
        expect((await errorOf(r)).code).toBe('not_found');
      }
    }
    const post = (action: string) =>
      req(app, `/api/platform/companies/${companyId}/${action}`, {
        cookie: admin.cookie,
        method: 'POST',
      });
    const s1 = await post('suspend');
    expect(s1.status).toBe(200);
    expect(((await s1.json()) as { company: { status: string } }).company.status).toBe('suspended');
    expect((await post('suspend')).status).toBe(200);
    expect((await post('reactivate')).status).toBe(200);
    expect((await post('reactivate')).status).toBe(200);
    const actions = (await ownerDb.select().from(auditLog).where(eq(auditLog.companyId, companyId)))
      .map((a) => a.action)
      .filter((a) => a !== 'company.created')
      .sort();
    expect(actions).toEqual(['company.reactivated', 'company.suspended']);
  });

  it('suspension blocks existing sessions on next request', async () => {
    const { app } = testApp();
    const admin = await platformAdmin(app);
    const { companyId } = await createCompany(ownerDb, { name: 'Acme', slug: 'acme' });
    const m = await seedMember(companyId, 'admin', 'a@acme.test', { app });
    const ctx = () => req(app, '/api/company/context', { cookie: m.cookie, company: companyId });
    expect((await ctx()).status).toBe(200);

    const s = await req(app, `/api/platform/companies/${companyId}/suspend`, {
      cookie: admin.cookie,
      method: 'POST',
    });
    expect(s.status).toBe(200);

    const blocked = await ctx();
    expect(blocked.status).toBe(403);
    expect((await errorOf(blocked)).code).toBe('company_suspended');
    expect((await req(app, '/api/platform/companies', { cookie: admin.cookie })).status).toBe(200);

    await req(app, `/api/platform/companies/${companyId}/reactivate`, {
      cookie: admin.cookie,
      method: 'POST',
    });
    expect((await ctx()).status).toBe(200);
  });
});
