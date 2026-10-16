import { describe, it, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { newId } from '@sitediary/shared';
import { createCompany } from '../src/companies/create-company';
import { auditLog, projectAssignments, projects } from '../src/db/schema';
import { ownerDb, useTestDb } from './helpers/db';
import { req, seedMember, testApp } from './helpers/auth';

useTestDb();

type ErrorBody = { error: { code: string; message: string; details?: Record<string, string> } };
const errorOf = async (r: Response) => ((await r.json()) as ErrorBody).error;
type Settings = {
  lat: number;
  lng: number;
  radiusM: number;
  startTime: string;
  lateAfterMin: number;
  reminderTime: string;
  version: number;
};

async function setup() {
  const co = await createCompany(ownerDb, { name: 'Alpha Builders', slug: 'alpha' });
  const other = await createCompany(ownerDb, { name: 'Bravo', slug: 'bravo' });
  const { app } = testApp();
  const admin = await seedMember(co.companyId, 'admin', 'admin@alpha.test', { app });
  const eng = await seedMember(co.companyId, 'site_engineer', 'eng@alpha.test', { app });
  const assigned = await seedMember(co.companyId, 'supervisor', 'sup@alpha.test', { app });
  const p1 = newId();
  const p2 = newId();
  const foreign = newId();
  await ownerDb.insert(projects).values([
    { id: p1, companyId: co.companyId, name: 'Tower', code: 'T1' },
    { id: p2, companyId: co.companyId, name: 'Bridge', code: 'B1' },
    { id: foreign, companyId: other.companyId, name: 'Elsewhere', code: 'E1' },
  ]);
  await ownerDb.insert(projectAssignments).values({
    id: newId(),
    companyId: co.companyId,
    membershipId: assigned.membershipId,
    projectId: p2,
  });
  return { co, app, admin, eng, assigned, p1, p2, foreign };
}
type Ctx = Awaited<ReturnType<typeof setup>>;
const call = (ctx: Ctx, cookie: string | undefined, path: string, method = 'GET', body?: unknown) =>
  req(ctx.app, `/api/attendance/settings/${path}`, {
    cookie,
    company: ctx.co.companyId,
    method,
    body,
  });

describe('attendance settings', () => {
  it('GET is null until set; admin PUT saves defaults and audits', async () => {
    const ctx = await setup();
    const empty = await call(ctx, ctx.admin.cookie, ctx.p1);
    expect(await empty.json()).toEqual({ settings: null });
    const put = await call(ctx, ctx.admin.cookie, ctx.p1, 'PUT', { lat: 19.07, lng: 72.87 });
    expect(put.status).toBe(200);
    const { settings } = (await put.json()) as { settings: Settings };
    expect(settings).toMatchObject({
      lat: 19.07,
      lng: 72.87,
      radiusM: 100,
      startTime: '09:00',
      lateAfterMin: 15,
      reminderTime: '19:00',
      version: 1,
    });
    const got = (await (await call(ctx, ctx.admin.cookie, ctx.p1)).json()) as {
      settings: Settings;
    };
    expect(got.settings.version).toBe(1);
    const audits = await ownerDb
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.companyId, ctx.co.companyId),
          eq(auditLog.action, 'attendance.settings_changed'),
        ),
      );
    expect(audits).toHaveLength(1);
  });

  it('update requires the current version; stale gets 409', async () => {
    const ctx = await setup();
    await call(ctx, ctx.admin.cookie, ctx.p1, 'PUT', { lat: 19, lng: 72 });
    const ok = await call(ctx, ctx.admin.cookie, ctx.p1, 'PUT', {
      lat: 19,
      lng: 72,
      radiusM: 200,
      version: 1,
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { settings: Settings }).settings).toMatchObject({
      radiusM: 200,
      version: 2,
    });
    const stale = await call(ctx, ctx.admin.cookie, ctx.p1, 'PUT', {
      lat: 19,
      lng: 72,
      version: 1,
    });
    expect(stale.status).toBe(409);
    expect((await errorOf(stale)).code).toBe('stale_version');
  });

  it('site engineer cannot PUT (403)', async () => {
    const ctx = await setup();
    const r = await call(ctx, ctx.eng.cookie, ctx.p1, 'PUT', { lat: 19, lng: 72 });
    expect(r.status).toBe(403);
  });

  it('radius 10 is rejected with details.radiusM', async () => {
    const ctx = await setup();
    const r = await call(ctx, ctx.admin.cookie, ctx.p1, 'PUT', { lat: 19, lng: 72, radiusM: 10 });
    expect(r.status).toBe(400);
    expect((await errorOf(r)).details).toHaveProperty('radiusM');
  });

  it('another company project is 404', async () => {
    const ctx = await setup();
    expect((await call(ctx, ctx.admin.cookie, ctx.foreign)).status).toBe(404);
    const r = await call(ctx, ctx.admin.cookie, ctx.foreign, 'PUT', { lat: 19, lng: 72 });
    expect(r.status).toBe(404);
  });

  it('non-assigned user GET is 404; assigned user can GET', async () => {
    const ctx = await setup();
    await call(ctx, ctx.admin.cookie, ctx.p2, 'PUT', { lat: 19, lng: 72 });
    expect((await call(ctx, ctx.eng.cookie, ctx.p2)).status).toBe(404);
    const ok = await call(ctx, ctx.assigned.cookie, ctx.p2);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { settings: Settings }).settings.lat).toBe(19);
    expect((await call(ctx, ctx.assigned.cookie, ctx.p1)).status).toBe(404);
  });
});
