import { describe, it, expect } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { newId } from '@sitediary/shared';
import { createCompany } from '../src/companies/create-company';
import {
  auditLog,
  memberships,
  projectAssignments,
  projects,
  roleCapabilities,
  roles,
} from '../src/db/schema';
import { owner, ownerDb, useTestDb } from './helpers/db';
import { req, seedMember, signIn, testApp } from './helpers/auth';

useTestDb();

type ErrorBody = { error: { code: string; message: string; details?: Record<string, string> } };
const errorOf = async (r: Response) => ((await r.json()) as ErrorBody).error;

type UserRow = {
  membershipId: string;
  name: string;
  email: string;
  roleId: string;
  roleName: string;
  status: 'active' | 'deactivated';
  projectIds: string[];
  version: number;
};

async function setup() {
  const co = await createCompany(ownerDb, { name: 'Alpha Builders', slug: 'alpha' });
  const other = await createCompany(ownerDb, { name: 'Bravo', slug: 'bravo' });
  const p1 = newId();
  const p2 = newId();
  const otherProject = newId();
  await ownerDb.insert(projects).values([
    { id: p1, companyId: co.companyId, name: 'Tower', code: 'T1' },
    { id: p2, companyId: co.companyId, name: 'Bridge', code: 'B1' },
    { id: otherProject, companyId: other.companyId, name: 'Other', code: 'O1' },
  ]);
  const { app } = testApp();
  const owner = await seedMember(co.companyId, 'super_admin', 'owner@alpha.test', {
    app,
    name: 'Owner Olga',
  });
  const eng = await seedMember(co.companyId, 'site_engineer', 'eng@alpha.test', {
    app,
    name: 'Engineer Esha',
  });
  const otherMember = await seedMember(other.companyId, 'site_engineer', 'b@bravo.test', {
    signIn: false,
  });
  return { co, other, p1, p2, otherProject, app, owner, eng, otherMember };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

const patch = (ctx: Ctx, membershipId: string, body: unknown, cookie = ctx.owner.cookie) =>
  req(ctx.app, `/api/users/${membershipId}`, {
    cookie,
    company: ctx.co.companyId,
    method: 'PATCH',
    body,
  });

const list = async (ctx: Ctx, cookie = ctx.owner.cookie): Promise<UserRow[]> => {
  const r = await req(ctx.app, '/api/users', { cookie, company: ctx.co.companyId });
  expect(r.status).toBe(200);
  return (await r.json()) as UserRow[];
};

const userOf = async (ctx: Ctx, membershipId: string) =>
  (await list(ctx)).find((u) => u.membershipId === membershipId)!;

const auditRows = (companyId: string, entityId: string) =>
  ownerDb
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.companyId, companyId), eq(auditLog.entityId, entityId)))
    .orderBy(auditLog.action);

const activeSuperAdmins = async (companyId: string) => {
  const { rows } = await owner.query<{ n: number }>(
    `select count(*)::int as n from memberships m join roles r on r.id = m.role_id
      where m.company_id = $1 and m.status = 'active' and r.key = 'super_admin'`,
    [companyId],
  );
  return rows[0]!.n;
};

/**
 * Runs two requests so their transactions really overlap: a SHARE lock on
 * audit_log (held by a separate connection) stops each one at its audit
 * insert, i.e. after its membership write and before the lockout guard, or
 * earlier on a row lock the other holds. Released once both backends wait.
 */
async function race(
  first: () => Promise<Response>,
  second: () => Promise<Response>,
): Promise<[Response, Response]> {
  const gate = await owner.connect();
  try {
    await gate.query('begin');
    await gate.query('lock table audit_log in share mode');
    const { rows: me } = await gate.query<{ pid: number }>('select pg_backend_pid() as pid');
    const pa = first();
    const pb = second();
    const deadline = Date.now() + 10_000;
    for (;;) {
      const { rows } = await owner.query<{ n: number }>(
        `select count(distinct pid)::int as n from pg_locks
          where not granted and pid <> $1`,
        [me[0]!.pid],
      );
      if (rows[0]!.n >= 2) break;
      if (Date.now() > deadline) throw new Error('requests never both blocked');
      await new Promise((r) => setTimeout(r, 10));
    }
    await gate.query('commit');
    return await Promise.all([pa, pb]);
  } finally {
    gate.release();
  }
}

describe('GET /api/users', () => {
  it('lists the company’s members ordered by name, without other companies', async () => {
    const ctx = await setup();
    await ownerDb.insert(projectAssignments).values({
      companyId: ctx.co.companyId,
      membershipId: ctx.eng.membershipId,
      projectId: ctx.p1,
    });
    const users = await list(ctx);
    expect(users).toEqual([
      {
        membershipId: ctx.eng.membershipId,
        name: 'Engineer Esha',
        email: 'eng@alpha.test',
        roleId: ctx.co.roleIds.site_engineer,
        roleName: 'Site Engineer',
        status: 'active',
        projectIds: [ctx.p1],
        version: 1,
      },
      {
        membershipId: ctx.owner.membershipId,
        name: 'Owner Olga',
        email: 'owner@alpha.test',
        roleId: ctx.co.roleIds.super_admin,
        roleName: 'Super Admin',
        status: 'active',
        projectIds: [],
        version: 1,
      },
    ]);
  });

  it('without users.view → 403 forbidden', async () => {
    const ctx = await setup();
    const r = await req(ctx.app, '/api/users', {
      cookie: ctx.eng.cookie,
      company: ctx.co.companyId,
    });
    expect(r.status).toBe(403);
    expect((await errorOf(r)).code).toBe('forbidden');
  });
});

describe('PATCH /api/users/:membershipId', () => {
  it('lockout guard: deactivate the only super admin → 409 last_super_admin', async () => {
    const ctx = await setup();
    const r = await patch(ctx, ctx.owner.membershipId, { version: 1, status: 'deactivated' });
    expect(r.status).toBe(409);
    expect(await errorOf(r)).toEqual({
      code: 'last_super_admin',
      message: 'A company must keep at least one active Super Admin.',
    });
    const u = await userOf(ctx, ctx.owner.membershipId);
    expect(u.status).toBe('active');
    expect(u.version).toBe(1);
    expect(await auditRows(ctx.co.companyId, ctx.owner.membershipId)).toEqual([]);
  });

  it('lockout guard: change the only super admin’s role → 409 last_super_admin', async () => {
    const ctx = await setup();
    const r = await patch(ctx, ctx.owner.membershipId, {
      version: 1,
      roleId: ctx.co.roleIds.admin,
    });
    expect(r.status).toBe(409);
    expect((await errorOf(r)).code).toBe('last_super_admin');
    expect((await userOf(ctx, ctx.owner.membershipId)).roleId).toBe(ctx.co.roleIds.super_admin);
  });

  it('lockout guard: a deactivated super admin does not count', async () => {
    const ctx = await setup();
    await seedMember(ctx.co.companyId, 'super_admin', 'gone@alpha.test', {
      status: 'deactivated',
      signIn: false,
    });
    const r = await patch(ctx, ctx.owner.membershipId, { version: 1, status: 'deactivated' });
    expect(r.status).toBe(409);
    expect((await errorOf(r)).code).toBe('last_super_admin');
  });

  it('with two super admins, one can be deactivated (including themselves)', async () => {
    const ctx = await setup();
    const second = await seedMember(ctx.co.companyId, 'super_admin', 'second@alpha.test', {
      signIn: false,
    });
    // Self-deactivation is allowed while another active super admin remains.
    const r = await patch(ctx, ctx.owner.membershipId, { version: 1, status: 'deactivated' });
    expect(r.status).toBe(200);
    const body = (await r.json()) as UserRow;
    expect(body).toMatchObject({ status: 'deactivated', version: 2 });
    // ...and now the second one is the last: they cannot deactivate themselves.
    const r2 = await patch(
      ctx,
      second.membershipId,
      { version: 1, status: 'deactivated' },
      await signIn(ctx.app, second.email, second.password),
    );
    expect(r2.status).toBe(409);
    expect((await errorOf(r2)).code).toBe('last_super_admin');
  });

  it('two concurrent demotions of the two remaining super admins: exactly one 409', async () => {
    const ctx = await setup();
    const second = await seedMember(ctx.co.companyId, 'super_admin', 'second@alpha.test', {
      signIn: false,
    });
    for (let round = 0; round < 3; round++) {
      // Reset both to active super admins between rounds.
      await ownerDb
        .update(memberships)
        .set({ status: 'active', roleId: ctx.co.roleIds.super_admin, version: 1 })
        .where(inArray(memberships.id, [ctx.owner.membershipId, second.membershipId]));

      const [a, b] = await race(
        () => patch(ctx, ctx.owner.membershipId, { version: 1, status: 'deactivated' }),
        () => patch(ctx, second.membershipId, { version: 1, roleId: ctx.co.roleIds.admin }),
      );
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 409]);
      const loser = a.status === 409 ? a : b;
      expect((await errorOf(loser)).code).toBe('last_super_admin');
      expect(await activeSuperAdmins(ctx.co.companyId)).toBe(1);
    }
  });

  it('two concurrent promotions to super admin both succeed (no deadlock)', async () => {
    const ctx = await setup();
    const x = await seedMember(ctx.co.companyId, 'admin', 'x@alpha.test', { signIn: false });
    const y = await seedMember(ctx.co.companyId, 'admin', 'y@alpha.test', { signIn: false });
    for (let round = 0; round < 3; round++) {
      await ownerDb
        .update(memberships)
        .set({ roleId: ctx.co.roleIds.admin, version: 1 })
        .where(inArray(memberships.id, [x.membershipId, y.membershipId]));
      const [a, b] = await race(
        () => patch(ctx, x.membershipId, { version: 1, roleId: ctx.co.roleIds.super_admin }),
        () => patch(ctx, y.membershipId, { version: 1, roleId: ctx.co.roleIds.super_admin }),
      );
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(await activeSuperAdmins(ctx.co.companyId)).toBe(3);
    }
  });

  it('changes role, status and projects; one audit row per change', async () => {
    const ctx = await setup();
    const r = await patch(ctx, ctx.eng.membershipId, {
      version: 1,
      roleId: ctx.co.roleIds.supervisor,
      status: 'deactivated',
      projectIds: [ctx.p1, ctx.p2, ctx.p1],
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as UserRow;
    expect(body).toMatchObject({
      membershipId: ctx.eng.membershipId,
      roleId: ctx.co.roleIds.supervisor,
      roleName: 'Supervisor',
      status: 'deactivated',
      version: 2,
    });
    expect([...body.projectIds].sort()).toEqual([ctx.p1, ctx.p2].sort());

    const rows = await auditRows(ctx.co.companyId, ctx.eng.membershipId);
    expect(rows.map((a) => a.action)).toEqual([
      'membership.projects_changed',
      'membership.role_changed',
      'membership.status_changed',
    ]);
    for (const a of rows) {
      expect(a.userId).toBe(ctx.owner.userId);
      expect(a.entity).toBe('membership');
    }
    const [projectsRow, roleRow, statusRow] = rows;
    expect(roleRow!.before).toEqual({
      roleId: ctx.co.roleIds.site_engineer,
      roleName: 'Site Engineer',
    });
    expect(roleRow!.after).toEqual({ roleId: ctx.co.roleIds.supervisor, roleName: 'Supervisor' });
    expect(statusRow!.before).toEqual({ status: 'active' });
    expect(statusRow!.after).toEqual({ status: 'deactivated' });
    expect(projectsRow!.before).toEqual({ projectIds: [] });
    expect(projectsRow!.after).toEqual({ projectIds: [ctx.p1, ctx.p2].sort() });
  });

  it('projectIds replaces the assignments', async () => {
    const ctx = await setup();
    expect(
      (await patch(ctx, ctx.eng.membershipId, { version: 1, projectIds: [ctx.p1] })).status,
    ).toBe(200);
    const r = await patch(ctx, ctx.eng.membershipId, { version: 2, projectIds: [ctx.p2] });
    expect(r.status).toBe(200);
    expect(((await r.json()) as UserRow).projectIds).toEqual([ctx.p2]);
    const rows = await ownerDb
      .select({ projectId: projectAssignments.projectId })
      .from(projectAssignments)
      .where(eq(projectAssignments.membershipId, ctx.eng.membershipId));
    expect(rows).toEqual([{ projectId: ctx.p2 }]);
    const r2 = await patch(ctx, ctx.eng.membershipId, { version: 3, projectIds: [] });
    expect(((await r2.json()) as UserRow).projectIds).toEqual([]);
  });

  it('a project of another company → 404 not_found, nothing changes', async () => {
    const ctx = await setup();
    const r = await patch(ctx, ctx.eng.membershipId, {
      version: 1,
      roleId: ctx.co.roleIds.supervisor,
      projectIds: [ctx.p1, ctx.otherProject],
    });
    expect(r.status).toBe(404);
    expect(await errorOf(r)).toEqual({ code: 'not_found', message: 'Not found.' });
    const u = await userOf(ctx, ctx.eng.membershipId);
    expect(u).toMatchObject({ roleId: ctx.co.roleIds.site_engineer, projectIds: [], version: 1 });
    expect(await auditRows(ctx.co.companyId, ctx.eng.membershipId)).toEqual([]);
  });

  it('cross-company membershipId or roleId → 404 not_found', async () => {
    const ctx = await setup();
    const r1 = await patch(ctx, ctx.otherMember.membershipId, {
      version: 1,
      status: 'deactivated',
    });
    expect(r1.status).toBe(404);
    expect((await errorOf(r1)).code).toBe('not_found');
    const r2 = await patch(ctx, ctx.eng.membershipId, {
      version: 1,
      roleId: ctx.other.roleIds.admin,
    });
    expect(r2.status).toBe(404);
    const r3 = await patch(ctx, 'not-a-uuid', { version: 1 });
    expect(r3.status).toBe(404);
    const [m] = await ownerDb
      .select({ status: memberships.status })
      .from(memberships)
      .where(eq(memberships.id, ctx.otherMember.membershipId));
    expect(m!.status).toBe('active');
  });

  it('stale version → 409 stale_version', async () => {
    const ctx = await setup();
    expect(
      (await patch(ctx, ctx.eng.membershipId, { version: 1, status: 'deactivated' })).status,
    ).toBe(200);
    const r = await patch(ctx, ctx.eng.membershipId, { version: 1, status: 'active' });
    expect(r.status).toBe(409);
    expect(await errorOf(r)).toEqual({
      code: 'stale_version',
      message: 'Someone else changed this. Reload and try again.',
    });
    expect((await userOf(ctx, ctx.eng.membershipId)).status).toBe('deactivated');
  });

  it('a no-op PATCH writes no audit row and keeps the version', async () => {
    const ctx = await setup();
    const r = await patch(ctx, ctx.eng.membershipId, {
      version: 1,
      status: 'active',
      roleId: ctx.co.roleIds.site_engineer,
      projectIds: [],
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as UserRow).version).toBe(1);
    expect(await auditRows(ctx.co.companyId, ctx.eng.membershipId)).toEqual([]);
  });

  it('invalid body → 400 validation_failed with details', async () => {
    const ctx = await setup();
    const r = await patch(ctx, ctx.eng.membershipId, { status: 'gone', projectIds: ['x'] });
    expect(r.status).toBe(400);
    const e = await errorOf(r);
    expect(e.code).toBe('validation_failed');
    expect(Object.keys(e.details!).sort()).toEqual(['projectIds.0', 'status', 'version']);
  });

  it('without users.manage → 403 forbidden', async () => {
    const ctx = await setup();
    const r = await patch(
      ctx,
      ctx.eng.membershipId,
      { version: 1, status: 'deactivated' },
      ctx.eng.cookie,
    );
    expect(r.status).toBe(403);
    expect((await errorOf(r)).code).toBe('forbidden');
  });

  it('a deactivated member loses access on the next request', async () => {
    const ctx = await setup();
    const before = await req(ctx.app, '/api/company/context', {
      cookie: ctx.eng.cookie,
      company: ctx.co.companyId,
    });
    expect(before.status).toBe(200);
    expect(
      (await patch(ctx, ctx.eng.membershipId, { version: 1, status: 'deactivated' })).status,
    ).toBe(200);
    const after = await req(ctx.app, '/api/company/context', {
      cookie: ctx.eng.cookie,
      company: ctx.co.companyId,
    });
    expect(after.status).toBe(403);
    expect((await errorOf(after)).code).toBe('not_a_member');
  });
});

describe('PATCH /api/users: only a Super Admin manages Super Admins (R14)', () => {
  it('an Admin cannot promote themselves, demote or deactivate a Super Admin → 403', async () => {
    const ctx = await setup();
    const admin = await seedMember(ctx.co.companyId, 'admin', 'admin@alpha.test', {
      app: ctx.app,
    });
    const forbiddenBody = {
      code: 'forbidden',
      message: 'You do not have permission to do this.',
    };
    const promote = await patch(
      ctx,
      admin.membershipId,
      { version: 1, roleId: ctx.co.roleIds.super_admin },
      admin.cookie,
    );
    expect(promote.status).toBe(403);
    expect(await errorOf(promote)).toEqual(forbiddenBody);
    // Even with a second Super Admin (so the lockout guard would pass).
    await seedMember(ctx.co.companyId, 'super_admin', 'second@alpha.test', { signIn: false });
    const deactivate = await patch(
      ctx,
      ctx.owner.membershipId,
      { version: 1, status: 'deactivated' },
      admin.cookie,
    );
    expect(deactivate.status).toBe(403);
    const demote = await patch(
      ctx,
      ctx.owner.membershipId,
      { version: 1, roleId: ctx.co.roleIds.admin },
      admin.cookie,
    );
    expect(demote.status).toBe(403);
    // Project assignments of a Super Admin are not Super Admin management.
    const projectsOnly = await patch(
      ctx,
      ctx.owner.membershipId,
      { version: 1, projectIds: [ctx.p1] },
      admin.cookie,
    );
    expect(projectsOnly.status).toBe(200);
    const u = await userOf(ctx, ctx.owner.membershipId);
    expect(u).toMatchObject({ roleId: ctx.co.roleIds.super_admin, status: 'active' });
    expect((await userOf(ctx, admin.membershipId)).roleId).toBe(ctx.co.roleIds.admin);
    // The Admin still manages everyone else.
    expect(
      (await patch(ctx, ctx.eng.membershipId, { version: 1, status: 'deactivated' }, admin.cookie))
        .status,
    ).toBe(200);
  });

  it('a Super Admin can promote and demote Super Admins', async () => {
    const ctx = await setup();
    const promote = await patch(ctx, ctx.eng.membershipId, {
      version: 1,
      roleId: ctx.co.roleIds.super_admin,
    });
    expect(promote.status).toBe(200);
    const demote = await patch(ctx, ctx.eng.membershipId, {
      version: 2,
      roleId: ctx.co.roleIds.supervisor,
    });
    expect(demote.status).toBe(200);
  });

  it('nobody assigns a role with a capability they lack → 403', async () => {
    const ctx = await setup();
    const hr = await ownerDb
      .insert(roles)
      .values({ companyId: ctx.co.companyId, name: 'HR', isSystem: false })
      .returning({ id: roles.id });
    const hrRoleId = hr[0]!.id;
    await ownerDb.insert(roleCapabilities).values(
      ['company.view', 'users.view', 'users.manage'].map((capability) => ({
        companyId: ctx.co.companyId,
        roleId: hrRoleId,
        capability,
      })),
    );
    const hrUser = await seedMember(ctx.co.companyId, hrRoleId, 'hr@alpha.test', { app: ctx.app });
    // Promoting themselves (or anyone) to Admin would grant capabilities HR lacks.
    for (const target of [hrUser.membershipId, ctx.eng.membershipId]) {
      const r = await patch(
        ctx,
        target,
        { version: 1, roleId: ctx.co.roleIds.admin },
        hrUser.cookie,
      );
      expect(r.status).toBe(403);
      expect((await errorOf(r)).code).toBe('forbidden');
    }
    // A role within their own capabilities is fine.
    const ok = await patch(
      ctx,
      ctx.eng.membershipId,
      { version: 1, roleId: hrRoleId },
      hrUser.cookie,
    );
    expect(ok.status).toBe(200);
  });
});
