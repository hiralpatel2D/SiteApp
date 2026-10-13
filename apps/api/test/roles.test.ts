import { describe, it, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { CAPABILITIES, SYSTEM_ROLES, defaultCapabilities } from '@sitediary/shared';
import { createCompany } from '../src/companies/create-company';
import { auditLog, roleCapabilities, roles } from '../src/db/schema';
import { ownerDb, useTestDb } from './helpers/db';
import { req, seedMember, testApp } from './helpers/auth';

useTestDb();

type ErrorBody = { error: { code: string; message: string; details?: Record<string, string> } };
const errorOf = async (r: Response) => ((await r.json()) as ErrorBody).error;

type RoleRow = {
  id: string;
  name: string;
  key: string | null;
  isSystem: boolean;
  capabilities: string[];
  memberCount: number;
  version: number;
};

async function setup() {
  const co = await createCompany(ownerDb, { name: 'Alpha Builders', slug: 'alpha' });
  const other = await createCompany(ownerDb, { name: 'Bravo', slug: 'bravo' });
  const { app } = testApp();
  const owner = await seedMember(co.companyId, 'super_admin', 'owner@alpha.test', { app });
  const eng = await seedMember(co.companyId, 'site_engineer', 'eng@alpha.test', { app });
  return { co, other, app, owner, eng };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

const call = (ctx: Ctx, method: string, path: string, body?: unknown, cookie = ctx.owner.cookie) =>
  req(ctx.app, path, { cookie, company: ctx.co.companyId, method, body });

const listRoles = async (ctx: Ctx): Promise<RoleRow[]> => {
  const r = await call(ctx, 'GET', '/api/roles');
  expect(r.status).toBe(200);
  return (await r.json()) as RoleRow[];
};

async function createRole(ctx: Ctx, name: string, capabilities: string[]): Promise<RoleRow> {
  const r = await call(ctx, 'POST', '/api/roles', { name, capabilities });
  if (r.status !== 201) throw new Error(`create role failed: ${r.status} ${await r.text()}`);
  return (await r.json()) as RoleRow;
}

const context = async (ctx: Ctx, cookie: string | undefined) =>
  req(ctx.app, '/api/company/context', { cookie, company: ctx.co.companyId });

const auditFor = (companyId: string, entityId: string) =>
  ownerDb
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.companyId, companyId), eq(auditLog.entityId, entityId)));

describe('GET /api/roles', () => {
  it('lists system roles in SYSTEM_ROLES order, then custom roles by name', async () => {
    const ctx = await setup();
    await createRole(ctx, 'Zeta Crew', ['company.view']);
    await createRole(ctx, 'Alpha Crew', ['company.view']);
    const list = await listRoles(ctx);
    expect(list.map((r) => r.name)).toEqual([
      ...SYSTEM_ROLES.map((r) => r.name),
      'Alpha Crew',
      'Zeta Crew',
    ]);
    const sa = list[0]!;
    expect(sa).toMatchObject({
      id: ctx.co.roleIds.super_admin,
      key: 'super_admin',
      isSystem: true,
      memberCount: 1,
      version: 1,
    });
    expect([...sa.capabilities].sort()).toEqual([...CAPABILITIES].sort());
    const se = list.find((r) => r.key === 'site_engineer')!;
    expect(se.memberCount).toBe(1);
    expect([...se.capabilities].sort()).toEqual(defaultCapabilities('site_engineer').sort());
    expect(list.find((r) => r.name === 'Alpha Crew')).toMatchObject({
      key: null,
      isSystem: false,
      memberCount: 0,
      capabilities: ['company.view'],
    });
  });

  it('without roles.view → 403 forbidden', async () => {
    const ctx = await setup();
    const r = await call(ctx, 'GET', '/api/roles', undefined, ctx.eng.cookie);
    expect(r.status).toBe(403);
  });
});

describe('roles and the permission matrix', () => {
  it('lockout guard: strip users.manage from Super Admin → 409 system_role_locked', async () => {
    const ctx = await setup();
    const id = ctx.co.roleIds.super_admin;
    const without = (cap: string) => CAPABILITIES.filter((c) => c !== cap);
    for (const cap of ['users.manage', 'roles.manage']) {
      const r = await call(ctx, 'PATCH', `/api/roles/${id}`, {
        version: 1,
        capabilities: without(cap),
      });
      expect(r.status, cap).toBe(409);
      expect(await errorOf(r)).toEqual({
        code: 'system_role_locked',
        message: 'The Super Admin role cannot be renamed or lose user and role management.',
      });
    }
    const rename = await call(ctx, 'PATCH', `/api/roles/${id}`, { version: 1, name: 'Boss' });
    expect(rename.status).toBe(409);
    expect((await errorOf(rename)).code).toBe('system_role_locked');
    // Same name (no rename) is fine; other capabilities may be removed.
    const ok = await call(ctx, 'PATCH', `/api/roles/${id}`, {
      version: 1,
      name: 'Super Admin',
      capabilities: without('insights.view'),
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as RoleRow).capabilities).not.toContain('insights.view');
  });

  it('custom role: create, tick capabilities, assign, member gains tiles capability', async () => {
    const ctx = await setup();
    const role = await createRole(ctx, '  Safety Officer ', [
      'company.view',
      'projects.view',
      'safety.view',
      'safety.view',
    ]);
    expect(role).toMatchObject({
      name: 'Safety Officer',
      key: null,
      isSystem: false,
      memberCount: 0,
      version: 1,
    });
    expect(role.capabilities).toEqual(['company.view', 'projects.view', 'safety.view']);

    const users = (await (await call(ctx, 'GET', '/api/users')).json()) as {
      membershipId: string;
      version: number;
    }[];
    const engRow = users.find((u) => u.membershipId === ctx.eng.membershipId)!;
    const r = await call(ctx, 'PATCH', `/api/users/${ctx.eng.membershipId}`, {
      version: engRow.version,
      roleId: role.id,
    });
    expect(r.status).toBe(200);

    const c = await context(ctx, ctx.eng.cookie);
    expect(c.status).toBe(200);
    const body = (await c.json()) as { role: { name: string }; capabilities: string[] };
    expect(body.role.name).toBe('Safety Officer');
    expect(body.capabilities).toEqual(['company.view', 'projects.view', 'safety.view']);

    // Tick one more box in the matrix.
    const p = await call(ctx, 'PATCH', `/api/roles/${role.id}`, {
      version: 1,
      capabilities: ['company.view', 'projects.view', 'safety.view', 'drawings.view'],
    });
    expect(p.status).toBe(200);
    expect(((await p.json()) as RoleRow).version).toBe(2);
    const c2 = (await (await context(ctx, ctx.eng.cookie)).json()) as { capabilities: string[] };
    expect(c2.capabilities).toEqual([
      'company.view',
      'drawings.view',
      'projects.view',
      'safety.view',
    ]);
  });

  it('delete system role → 409 system_role; delete used custom role → 409 role_in_use', async () => {
    const ctx = await setup();
    const sys = await call(ctx, 'DELETE', `/api/roles/${ctx.co.roleIds.client}`);
    expect(sys.status).toBe(409);
    expect(await errorOf(sys)).toEqual({
      code: 'system_role',
      message: 'Built-in roles cannot be deleted.',
    });

    const role = await createRole(ctx, 'Safety Officer', ['company.view']);
    await seedMember(ctx.co.companyId, role.id, 'safe@alpha.test', { signIn: false });
    const used = await call(ctx, 'DELETE', `/api/roles/${role.id}`);
    expect(used.status).toBe(409);
    expect(await errorOf(used)).toEqual({
      code: 'role_in_use',
      message: 'Move everyone off this role before deleting it.',
    });
    // A deactivated member still holds the role.
    const role2 = await createRole(ctx, 'Old Crew', ['company.view']);
    await seedMember(ctx.co.companyId, role2.id, 'old@alpha.test', {
      signIn: false,
      status: 'deactivated',
    });
    expect((await call(ctx, 'DELETE', `/api/roles/${role2.id}`)).status).toBe(409);

    const unused = await createRole(ctx, 'Temp Crew', ['company.view', 'safety.view']);
    const del = await call(ctx, 'DELETE', `/api/roles/${unused.id}`);
    expect(del.status).toBe(204);
    expect(await ownerDb.select().from(roles).where(eq(roles.id, unused.id))).toEqual([]);
    expect(
      await ownerDb.select().from(roleCapabilities).where(eq(roleCapabilities.roleId, unused.id)),
    ).toEqual([]);
  });

  it('unknown capability → 400 validation_failed with details.capabilities', async () => {
    const ctx = await setup();
    const r = await call(ctx, 'POST', '/api/roles', {
      name: 'Safety Officer',
      capabilities: ['company.view', 'launch.missiles'],
    });
    expect(r.status).toBe(400);
    const e = await errorOf(r);
    expect(e.code).toBe('validation_failed');
    expect(e.message).toBe('Check the highlighted fields.');
    expect(e.details).toEqual({ capabilities: 'Choose capabilities from the list.' });

    const p = await call(ctx, 'PATCH', `/api/roles/${ctx.co.roleIds.client}`, {
      version: 1,
      capabilities: [42],
    });
    expect(p.status).toBe(400);
    expect((await errorOf(p)).details).toEqual({
      capabilities: 'Choose capabilities from the list.',
    });

    const n = await call(ctx, 'POST', '/api/roles', { name: ' x ', capabilities: [] });
    expect(n.status).toBe(400);
    expect(Object.keys((await errorOf(n)).details!)).toEqual(['name']);
    const long = await call(ctx, 'POST', '/api/roles', { name: 'x'.repeat(41), capabilities: [] });
    expect(long.status).toBe(400);
  });

  it('duplicate name → 409 role_name_taken (create and rename)', async () => {
    const ctx = await setup();
    const dup = await call(ctx, 'POST', '/api/roles', { name: 'Admin', capabilities: [] });
    expect(dup.status).toBe(409);
    expect(await errorOf(dup)).toEqual({
      code: 'role_name_taken',
      message: 'A role with this name already exists.',
    });
    const role = await createRole(ctx, 'Safety Officer', []);
    const rename = await call(ctx, 'PATCH', `/api/roles/${role.id}`, {
      version: 1,
      name: 'Supervisor',
    });
    expect(rename.status).toBe(409);
    expect((await errorOf(rename)).code).toBe('role_name_taken');
    // Same name in another company is fine.
    const other = await seedMember(ctx.other.companyId, 'super_admin', 'b@bravo.test', {
      app: ctx.app,
    });
    const r = await req(ctx.app, '/api/roles', {
      cookie: other.cookie,
      company: ctx.other.companyId,
      body: { name: 'Safety Officer', capabilities: [] },
    });
    expect(r.status).toBe(201);
  });

  it('stale version → 409 stale_version', async () => {
    const ctx = await setup();
    const role = await createRole(ctx, 'Safety Officer', ['company.view']);
    expect(
      (await call(ctx, 'PATCH', `/api/roles/${role.id}`, { version: 1, name: 'Safety Lead' }))
        .status,
    ).toBe(200);
    const r = await call(ctx, 'PATCH', `/api/roles/${role.id}`, {
      version: 1,
      capabilities: [],
    });
    expect(r.status).toBe(409);
    expect(await errorOf(r)).toEqual({
      code: 'stale_version',
      message: 'Someone else changed this. Reload and try again.',
    });
    const after = (await listRoles(ctx)).find((x) => x.id === role.id)!;
    expect(after).toMatchObject({
      name: 'Safety Lead',
      capabilities: ['company.view'],
      version: 2,
    });
  });

  it('capability changes take effect on the very next request', async () => {
    const ctx = await setup();
    const role = await createRole(ctx, 'Office', ['company.view', 'users.view']);
    const member = await seedMember(ctx.co.companyId, role.id, 'office@alpha.test', {
      app: ctx.app,
    });
    const users = () => call(ctx, 'GET', '/api/users', undefined, member.cookie);
    expect((await users()).status).toBe(200);
    expect(
      (
        await call(ctx, 'PATCH', `/api/roles/${role.id}`, {
          version: 1,
          capabilities: ['company.view'],
        })
      ).status,
    ).toBe(200);
    expect((await users()).status).toBe(403);
    expect(
      (
        await call(ctx, 'PATCH', `/api/roles/${role.id}`, {
          version: 2,
          capabilities: ['company.view', 'users.view'],
        })
      ).status,
    ).toBe(200);
    expect((await users()).status).toBe(200);
  });

  it('every change writes one audit row', async () => {
    const ctx = await setup();
    const role = await createRole(ctx, 'Safety Officer', ['company.view', 'safety.view']);
    let rows = await auditFor(ctx.co.companyId, role.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'role.created',
      entity: 'role',
      userId: ctx.owner.userId,
      before: null,
      after: { name: 'Safety Officer', capabilities: ['company.view', 'safety.view'] },
    });

    await call(ctx, 'PATCH', `/api/roles/${role.id}`, {
      version: 1,
      name: 'Safety Lead',
      capabilities: ['safety.view'],
    });
    rows = await auditFor(ctx.co.companyId, role.id);
    expect(rows).toHaveLength(2);
    const updated = rows.find((r) => r.action === 'role.updated')!;
    expect(updated.before).toEqual({
      name: 'Safety Officer',
      capabilities: ['company.view', 'safety.view'],
    });
    expect(updated.after).toEqual({ name: 'Safety Lead', capabilities: ['safety.view'] });

    // A no-op PATCH is not a change: no row, version unchanged.
    const noop = await call(ctx, 'PATCH', `/api/roles/${role.id}`, {
      version: 2,
      name: 'Safety Lead',
      capabilities: ['safety.view'],
    });
    expect(((await noop.json()) as RoleRow).version).toBe(2);
    expect(await auditFor(ctx.co.companyId, role.id)).toHaveLength(2);

    await call(ctx, 'DELETE', `/api/roles/${role.id}`);
    rows = await auditFor(ctx.co.companyId, role.id);
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.action === 'role.deleted')).toMatchObject({
      before: { name: 'Safety Lead', capabilities: ['safety.view'] },
      after: null,
    });

    // Failed changes write nothing.
    await call(ctx, 'DELETE', `/api/roles/${ctx.co.roleIds.admin}`);
    await call(ctx, 'PATCH', `/api/roles/${ctx.co.roleIds.super_admin}`, {
      version: 1,
      name: 'Boss',
    });
    expect(await auditFor(ctx.co.companyId, ctx.co.roleIds.admin)).toEqual([]);
    expect(await auditFor(ctx.co.companyId, ctx.co.roleIds.super_admin)).toEqual([]);
  });

  it('cross-company role id → 404 not_found', async () => {
    const ctx = await setup();
    const bRole = ctx.other.roleIds.supervisor;
    const p = await call(ctx, 'PATCH', `/api/roles/${bRole}`, { version: 1, name: 'Hijacked' });
    expect(p.status).toBe(404);
    expect(await errorOf(p)).toEqual({ code: 'not_found', message: 'Not found.' });
    expect((await call(ctx, 'DELETE', `/api/roles/${bRole}`)).status).toBe(404);
    expect((await call(ctx, 'DELETE', '/api/roles/nope')).status).toBe(404);
    const [row] = await ownerDb.select().from(roles).where(eq(roles.id, bRole));
    expect(row!.name).toBe('Supervisor');
  });

  it('without roles.manage → 403 forbidden', async () => {
    const ctx = await setup();
    const r = await call(
      ctx,
      'POST',
      '/api/roles',
      { name: 'X Crew', capabilities: [] },
      ctx.eng.cookie,
    );
    expect(r.status).toBe(403);
    expect((await errorOf(r)).code).toBe('forbidden');
  });
});
