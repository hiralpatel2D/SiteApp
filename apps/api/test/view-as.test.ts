import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createCompany } from '../src/companies/create-company';
import { auditLog, memberships } from '../src/db/schema';
import { signViewAs, verifyViewAs } from '../src/tenant/view-as-token';
import { ownerDb, pools, useTestDb } from './helpers/db';
import { req, seedMember, testApp } from './helpers/auth';

useTestDb();

type Ctx = {
  role: { name: string; key: string | null };
  capabilities: string[];
  canViewAs: boolean;
  viewAs: { name: string; roleName: string } | null;
};

async function setup() {
  const co = await createCompany(ownerDb, { name: 'Alpha', slug: 'alpha' });
  const other = await createCompany(ownerDb, { name: 'Bravo', slug: 'bravo' });
  const { app } = testApp();
  const boss = await seedMember(co.companyId, 'super_admin', 'boss@alpha.test', {
    app,
    name: 'Boss',
  });
  const eng = await seedMember(co.companyId, 'site_engineer', 'eng@alpha.test', {
    app,
    name: 'Esha Engineer',
  });
  const admin = await seedMember(co.companyId, 'admin', 'admin@alpha.test', { app, name: 'Adi' });
  const stranger = await seedMember(other.companyId, 'site_engineer', 's@bravo.test', { app });
  const as = (who: { cookie?: string }, path: string, extra: Record<string, unknown> = {}) =>
    req(app, path, { cookie: who.cookie, company: co.companyId, ...extra });
  return { co, other, app, boss, eng, admin, stranger, as };
}

const start = (ctx: Awaited<ReturnType<typeof setup>>, membershipId: string) =>
  ctx.as(ctx.boss, '/api/company/view-as', { body: { membershipId } });

async function tokenFor(ctx: Awaited<ReturnType<typeof setup>>, membershipId: string) {
  const res = await start(ctx, membershipId);
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

describe('view as (Super Admin, read-only)', () => {
  it('only a Super Admin can list, start or stop', async () => {
    const ctx = await setup();
    for (const who of [ctx.eng, ctx.admin]) {
      expect((await ctx.as(who, '/api/company/view-as/people')).status).toBe(403);
      const res = await ctx.as(who, '/api/company/view-as', {
        body: { membershipId: ctx.eng.membershipId },
      });
      expect(res.status).toBe(403);
      expect(
        (await ctx.as(who, '/api/company/view-as/stop', { method: 'POST', body: {} })).status,
      ).toBe(403);
    }
  });

  it('lists the other active people with their roles, never the Super Admin themselves', async () => {
    const ctx = await setup();
    await ownerDb
      .update(memberships)
      .set({ status: 'deactivated' })
      .where(eq(memberships.id, ctx.admin.membershipId));
    const res = await ctx.as(ctx.boss, '/api/company/view-as/people');
    const body = (await res.json()) as { people: { membershipId: string; name: string }[] };
    expect(body.people.map((p) => p.name)).toEqual(['Esha Engineer']);
  });

  it('start is audited and the token makes the app see the person, not the Super Admin', async () => {
    const ctx = await setup();
    const token = await tokenFor(ctx, ctx.eng.membershipId);
    const own = (await (await ctx.as(ctx.boss, '/api/company/context')).json()) as Ctx;
    expect(own.canViewAs).toBe(true);
    expect(own.viewAs).toBeNull();
    expect(own.role.key).toBe('super_admin');

    const seen = (await (
      await ctx.as(ctx.boss, '/api/company/context', { headers: { 'x-view-as': token } })
    ).json()) as Ctx;
    expect(seen.viewAs).toMatchObject({ name: 'Esha Engineer' });
    expect(seen.canViewAs).toBe(true);
    expect(seen.role.key).toBe('site_engineer');
    expect(seen.capabilities).not.toContain('users.manage');
    expect(seen.capabilities.length).toBeLessThan(own.capabilities.length);

    const [audit] = await ownerDb
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'view_as.started'));
    expect(audit!.entityId).toBe(ctx.eng.membershipId);
    expect(audit!.userId).toBe(ctx.boss.userId);
  });

  it('is read-only: anything but a read is refused with read_only_view', async () => {
    const ctx = await setup();
    const token = await tokenFor(ctx, ctx.eng.membershipId);
    const res = await ctx.as(ctx.boss, '/api/projects', {
      headers: { 'x-view-as': token },
      body: { name: 'Nope', code: 'N-1' },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('read_only_view');
  });

  it('reads respect the viewed role (a site engineer cannot read the team list)', async () => {
    const ctx = await setup();
    const token = await tokenFor(ctx, ctx.eng.membershipId);
    const asBoss = await ctx.as(ctx.boss, '/api/users');
    expect(asBoss.status).toBe(200);
    const viewing = await ctx.as(ctx.boss, '/api/users', { headers: { 'x-view-as': token } });
    expect(viewing.status).toBe(403);
  });

  it('a forged, expired, other-person or other-company token is just ignored', async () => {
    const ctx = await setup();
    const good = await tokenFor(ctx, ctx.eng.membershipId);
    const secret = pools.viewAsSecret;
    const mk = (over: Partial<{ u: string; c: string; t: string; exp: number }>) =>
      signViewAs(secret, {
        u: ctx.boss.userId,
        c: ctx.co.companyId,
        t: ctx.eng.membershipId,
        exp: Date.now() + 60_000,
        ...over,
      });
    const tokens = [
      `${good.split('.')[0]}.AAAA`,
      mk({ exp: Date.now() - 1 }),
      mk({ u: ctx.eng.userId }),
      mk({ c: ctx.other.companyId }),
      signViewAs('another-secret-another-secret-0000000', {
        u: ctx.boss.userId,
        c: ctx.co.companyId,
        t: ctx.eng.membershipId,
        exp: Date.now() + 60_000,
      }),
      'garbage',
    ];
    for (const token of tokens) {
      const seen = (await (
        await ctx.as(ctx.boss, '/api/company/context', { headers: { 'x-view-as': token } })
      ).json()) as Ctx;
      expect(seen.viewAs).toBeNull();
      expect(seen.role.key).toBe('super_admin');
    }
  });

  it('a token is worthless to anyone but the Super Admin who started it', async () => {
    const ctx = await setup();
    const token = await tokenFor(ctx, ctx.admin.membershipId);
    const seen = (await (
      await ctx.as(ctx.eng, '/api/company/context', { headers: { 'x-view-as': token } })
    ).json()) as Ctx;
    expect(seen.viewAs).toBeNull();
    expect(seen.canViewAs).toBe(false);
    expect(seen.role.key).toBe('site_engineer');
  });

  it('cannot start on yourself, a deactivated person, or someone in another company', async () => {
    const ctx = await setup();
    await ownerDb
      .update(memberships)
      .set({ status: 'deactivated' })
      .where(eq(memberships.id, ctx.admin.membershipId));
    for (const id of [ctx.boss.membershipId, ctx.admin.membershipId, ctx.stranger.membershipId]) {
      expect((await start(ctx, id)).status).toBe(404);
    }
    expect((await start(ctx, 'not-a-uuid')).status).toBe(400);
  });

  it('a token stops working when the person is deactivated', async () => {
    const ctx = await setup();
    const token = await tokenFor(ctx, ctx.eng.membershipId);
    await ownerDb
      .update(memberships)
      .set({ status: 'deactivated' })
      .where(eq(memberships.id, ctx.eng.membershipId));
    const seen = (await (
      await ctx.as(ctx.boss, '/api/company/context', { headers: { 'x-view-as': token } })
    ).json()) as Ctx;
    expect(seen.viewAs).toBeNull();
  });

  it('stop is audited, and start and stop still work while a view is active', async () => {
    const ctx = await setup();
    const token = await tokenFor(ctx, ctx.eng.membershipId);
    const stop = await ctx.as(ctx.boss, '/api/company/view-as/stop', {
      method: 'POST',
      body: {},
      headers: { 'x-view-as': token },
    });
    expect(stop.status).toBe(200);
    const [audit] = await ownerDb
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'view_as.stopped'));
    expect(audit!.userId).toBe(ctx.boss.userId);
    const again = await ctx.as(ctx.boss, '/api/company/view-as', {
      body: { membershipId: ctx.admin.membershipId },
      headers: { 'x-view-as': token },
    });
    expect(again.status).toBe(200);
  });
});

describe('view-as token', () => {
  it('round-trips and rejects a tampered body', () => {
    const t = signViewAs('s'.repeat(40), { u: 'u', c: 'c', t: 't', exp: Date.now() + 1000 });
    expect(verifyViewAs('s'.repeat(40), t, 'u', 'c')).toMatchObject({ t: 't' });
    const [body, mac] = t.split('.');
    const forged = `${Buffer.from(JSON.stringify({ u: 'u', c: 'c', t: 'x', exp: Date.now() + 1000 })).toString('base64url')}.${mac}`;
    expect(verifyViewAs('s'.repeat(40), forged, 'u', 'c')).toBeNull();
    expect(body).toBeTruthy();
  });
});
