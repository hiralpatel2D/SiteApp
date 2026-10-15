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
type ProjectRow = {
  id: string;
  name: string;
  code: string;
  location: string | null;
  status: string;
  memberCount: number;
  version: number;
};

async function setup() {
  const co = await createCompany(ownerDb, { name: 'Alpha Builders', slug: 'alpha' });
  const other = await createCompany(ownerDb, { name: 'Bravo', slug: 'bravo' });
  const { app } = testApp();
  const admin = await seedMember(co.companyId, 'admin', 'admin@alpha.test', { app });
  const pm = await seedMember(co.companyId, 'project_manager', 'pm@alpha.test', { app });
  const eng = await seedMember(co.companyId, 'site_engineer', 'eng@alpha.test', { app });
  const p1 = newId();
  const p2 = newId();
  await ownerDb.insert(projects).values([
    { id: p1, companyId: co.companyId, name: 'Tower', code: 'T1' },
    { id: p2, companyId: co.companyId, name: 'Bridge', code: 'B1' },
  ]);
  await ownerDb.insert(projectAssignments).values({
    id: newId(),
    companyId: co.companyId,
    membershipId: eng.membershipId,
    projectId: p2,
  });
  return { co, other, app, admin, pm, eng, p1, p2 };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

const call = (ctx: Ctx, cookie: string | undefined, path: string, method = 'GET', body?: unknown) =>
  req(ctx.app, path, { cookie, company: ctx.co.companyId, method, body });
const auditFor = (companyId: string, action: string) =>
  ownerDb
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.companyId, companyId), eq(auditLog.action, action)));

describe('projects', () => {
  it('site engineer sees only assigned projects; admin sees all', async () => {
    const ctx = await setup();
    const engList = (await (
      await call(ctx, ctx.eng.cookie, '/api/projects')
    ).json()) as ProjectRow[];
    expect(engList.map((p) => p.code)).toEqual(['B1']);
    expect(engList[0]).toMatchObject({
      name: 'Bridge',
      memberCount: 1,
      status: 'active',
      version: 1,
    });
    const all = (await (await call(ctx, ctx.admin.cookie, '/api/projects')).json()) as ProjectRow[];
    expect(all.map((p) => p.name)).toEqual(['Bridge', 'Tower']);
  });

  it('duplicate project code in same company → 409, in another company → allowed', async () => {
    const ctx = await setup();
    const ok = await call(ctx, ctx.pm.cookie, '/api/projects', 'POST', {
      name: 'New Site',
      code: ' ns-1 ',
      location: 'Pune',
    });
    expect(ok.status).toBe(201);
    expect(await ok.json()).toMatchObject({ code: 'NS-1', location: 'Pune', memberCount: 1 });
    const dup = await call(ctx, ctx.pm.cookie, '/api/projects', 'POST', {
      name: 'Again',
      code: 'NS-1',
    });
    expect(dup.status).toBe(409);
    expect((await errorOf(dup)).code).toBe('project_code_taken');
    // another company can reuse the code
    const bAdmin = await seedMember(ctx.other.companyId, 'super_admin', 'a@bravo.test', {
      app: ctx.app,
    });
    const b = await req(ctx.app, '/api/projects', {
      cookie: bAdmin.cookie,
      company: ctx.other.companyId,
      method: 'POST',
      body: { name: 'Bravo Site', code: 'NS-1' },
    });
    expect(b.status).toBe(201);
  });

  it('validates the create body and requires projects.manage', async () => {
    const ctx = await setup();
    const bad = await call(ctx, ctx.pm.cookie, '/api/projects', 'POST', { name: 'x', code: '!' });
    expect(bad.status).toBe(400);
    expect(Object.keys((await errorOf(bad)).details!).sort()).toEqual(['code', 'name']);
    const denied = await call(ctx, ctx.eng.cookie, '/api/projects', 'POST', {
      name: 'Okay',
      code: 'OK',
    });
    expect(denied.status).toBe(403);
  });

  it('creator is auto-assigned unless they hold projects.all; one audit row', async () => {
    const ctx = await setup();
    const a = await call(ctx, ctx.admin.cookie, '/api/projects', 'POST', {
      name: 'By Admin',
      code: 'AD',
    });
    const ar = (await a.json()) as ProjectRow;
    expect(ar.memberCount).toBe(0);
    const p = await call(ctx, ctx.pm.cookie, '/api/projects', 'POST', {
      name: 'By PM',
      code: 'PM',
    });
    const pr = (await p.json()) as ProjectRow;
    expect(pr.memberCount).toBe(1);
    const mine = (await (await call(ctx, ctx.pm.cookie, '/api/projects')).json()) as ProjectRow[];
    expect(mine.map((x) => x.code)).toEqual(['PM']);
    const rows = await auditFor(ctx.co.companyId, 'project.created');
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.entityId === pr.id)!.after).toMatchObject({
      code: 'PM',
      name: 'By PM',
    });
  });

  it('PATCH updates with version check, audit, and 409 on stale / duplicate code', async () => {
    const ctx = await setup();
    const url = `/api/projects/${ctx.p1}`;
    const r = await call(ctx, ctx.admin.cookie, url, 'PATCH', {
      version: 1,
      name: 'Tower II',
      status: 'archived',
      location: 'Mumbai',
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({
      name: 'Tower II',
      status: 'archived',
      version: 2,
      location: 'Mumbai',
    });
    const rows = await auditFor(ctx.co.companyId, 'project.updated');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.before).toMatchObject({ name: 'Tower', status: 'active' });
    expect(rows[0]!.after).toMatchObject({ name: 'Tower II', status: 'archived' });
    const stale = await call(ctx, ctx.admin.cookie, url, 'PATCH', { version: 1, name: 'Nope' });
    expect(stale.status).toBe(409);
    expect((await errorOf(stale)).code).toBe('stale_version');
    const dup = await call(ctx, ctx.admin.cookie, url, 'PATCH', { version: 2, code: 'b1' });
    expect(dup.status).toBe(409);
    expect((await errorOf(dup)).code).toBe('project_code_taken');
    const badStatus = await call(ctx, ctx.admin.cookie, url, 'PATCH', {
      version: 2,
      status: 'gone',
    });
    expect(badStatus.status).toBe(400);
    expect(await auditFor(ctx.co.companyId, 'project.updated')).toHaveLength(1);
  });

  it('PATCH/PUT on a project the caller cannot see → 404', async () => {
    const ctx = await setup();
    const { id } = { id: ctx.p1 }; // pm is not assigned to p1 and lacks projects.all
    const patch = await call(ctx, ctx.pm.cookie, `/api/projects/${id}`, 'PATCH', {
      version: 1,
      name: 'Hidden',
    });
    expect(patch.status).toBe(404);
    const put = await call(ctx, ctx.pm.cookie, `/api/projects/${id}/members`, 'PUT', {
      membershipIds: [],
    });
    expect(put.status).toBe(404);
    expect(
      await call(ctx, ctx.pm.cookie, '/api/projects/not-a-uuid', 'PATCH', { version: 1 }),
    ).toHaveProperty('status', 404);
  });

  it('PUT members replaces the set, audits before/after, and rejects foreign or inactive memberships', async () => {
    const ctx = await setup();
    const url = `/api/projects/${ctx.p2}/members`;
    const r = await call(ctx, ctx.admin.cookie, url, 'PUT', {
      membershipIds: [ctx.pm.membershipId, ctx.pm.membershipId],
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ id: ctx.p2, memberCount: 1 });
    const now = await ownerDb
      .select()
      .from(projectAssignments)
      .where(eq(projectAssignments.projectId, ctx.p2));
    expect(now.map((a) => a.membershipId)).toEqual([ctx.pm.membershipId]);
    const rows = await auditFor(ctx.co.companyId, 'project.members_changed');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.before).toEqual({ membershipIds: [ctx.eng.membershipId] });
    expect(rows[0]!.after).toEqual({ membershipIds: [ctx.pm.membershipId] });

    const bMember = await seedMember(ctx.other.companyId, 'site_engineer', 'b@bravo.test', {
      signIn: false,
    });
    const foreign = await call(ctx, ctx.admin.cookie, url, 'PUT', {
      membershipIds: [bMember.membershipId],
    });
    expect(foreign.status).toBe(404);
    const off = await seedMember(ctx.co.companyId, 'site_engineer', 'off@alpha.test', {
      signIn: false,
      status: 'deactivated',
    });
    const inactive = await call(ctx, ctx.admin.cookie, url, 'PUT', {
      membershipIds: [off.membershipId],
    });
    expect(inactive.status).toBe(404);
    const bad = await call(ctx, ctx.admin.cookie, url, 'PUT', { membershipIds: ['x'] });
    expect(bad.status).toBe(400);
    expect(await auditFor(ctx.co.companyId, 'project.members_changed')).toHaveLength(1);
  });
});
