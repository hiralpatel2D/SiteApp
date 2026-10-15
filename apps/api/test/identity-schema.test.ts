import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { newId } from '@sitediary/shared';
import { withTenant } from '../src/db/tenant';
import {
  invitations,
  memberships,
  projectAssignments,
  projects,
  roles,
  users,
} from '../src/db/schema';
import { app, owner, ownerDb, seedTwoCompanies, useTestDb } from './helpers/db';

useTestDb();

/** Two companies, one role each, users u1 (member of A) and u2 (member of B). */
async function seedIdentity() {
  const { a, b } = await seedTwoCompanies();
  const roleA = newId();
  const roleB = newId();
  await ownerDb.insert(roles).values([
    { id: roleA, companyId: a, key: 'super_admin', name: 'Super Admin', isSystem: true },
    { id: roleB, companyId: b, key: 'super_admin', name: 'Super Admin', isSystem: true },
  ]);
  const u1 = newId();
  const u2 = newId();
  await ownerDb.insert(users).values([
    { id: u1, name: 'Uma One', email: `u1-${u1}@example.com` },
    { id: u2, name: 'Ulf Two', email: `u2-${u2}@example.com` },
  ]);
  const mA = newId();
  const mB = newId();
  await ownerDb.insert(memberships).values([
    { id: mA, companyId: a, userId: u1, roleId: roleA },
    { id: mB, companyId: b, userId: u2, roleId: roleB },
  ]);
  return { a, b, roleA, roleB, u1, u2, mA, mB };
}

const sha = (s: string) => s.padEnd(64, '0');

describe('identity schema', () => {
  it('app_user_memberships returns only that user’s memberships', async () => {
    const { a, u1 } = await seedIdentity();
    const { rows } = await app.query('select * from app_user_memberships($1)', [u1]);
    expect(rows.map((r) => r.company_id)).toEqual([a]);
    expect(rows[0]).toMatchObject({
      company_name: 'Alpha Builders',
      company_status: 'active',
      role_key: 'super_admin',
      role_name: 'Super Admin',
      membership_status: 'active',
    });
    expect(Object.keys(rows[0]).sort()).toEqual(
      [
        'membership_id',
        'company_id',
        'company_name',
        'company_slug',
        'company_status',
        'role_id',
        'role_key',
        'role_name',
        'membership_status',
      ].sort(),
    );
  });

  it('app_user cannot select memberships without tenant context', async () => {
    await seedIdentity();
    const { rows } = await app.query('select * from memberships');
    expect(rows).toHaveLength(0);
  });

  it('tenant A sees only its own memberships', async () => {
    const { a, mA } = await seedIdentity();
    const rows = await withTenant(app, { companyId: a }, (tx) => tx.select().from(memberships));
    expect(rows.map((r) => r.id)).toEqual([mA]);
  });

  it('membership cannot reference another company’s role', async () => {
    const { a, u2, roleB } = await seedIdentity();
    await expect(
      withTenant(app, { companyId: a }, (tx) =>
        tx.insert(memberships).values({ companyId: a, userId: u2, roleId: roleB }),
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it('a role in use by a membership cannot be deleted', async () => {
    const { roleA } = await seedIdentity();
    await expect(ownerDb.delete(roles).where(eq(roles.id, roleA))).rejects.toThrow();
  });

  it('project assignment cannot reference another company’s project', async () => {
    const { a, b, mA } = await seedIdentity();
    const [projB] = await ownerDb.select().from(projects).where(eq(projects.companyId, b));
    await expect(
      withTenant(app, { companyId: a }, (tx) =>
        tx
          .insert(projectAssignments)
          .values({ companyId: a, membershipId: mA, projectId: projB!.id }),
      ),
    ).rejects.toThrow(/foreign key/);
    const [projA] = await ownerDb.select().from(projects).where(eq(projects.companyId, a));
    await withTenant(app, { companyId: a }, (tx) =>
      tx
        .insert(projectAssignments)
        .values({ companyId: a, membershipId: mA, projectId: projA!.id }),
    );
  });

  it('only one open invitation per email per company', async () => {
    const { a, b, roleA, roleB } = await seedIdentity();
    const email = 'new.person@example.com';
    const first = newId();
    await withTenant(app, { companyId: a }, (tx) =>
      tx.insert(invitations).values({
        id: first,
        companyId: a,
        email,
        roleId: roleA,
        tokenHash: sha('a1'),
        expiresAt: new Date(Date.now() + 86_400_000),
      }),
    );
    await expect(
      withTenant(app, { companyId: a }, (tx) =>
        tx.insert(invitations).values({
          companyId: a,
          email,
          roleId: roleA,
          tokenHash: sha('a2'),
          expiresAt: new Date(Date.now() + 86_400_000),
        }),
      ),
    ).rejects.toThrow(/unique/);
    // Another company may invite the same email.
    await withTenant(app, { companyId: b }, (tx) =>
      tx.insert(invitations).values({
        companyId: b,
        email,
        roleId: roleB,
        tokenHash: sha('b1'),
        expiresAt: new Date(Date.now() + 86_400_000),
      }),
    );
    // Once revoked, a new invitation is allowed.
    await withTenant(app, { companyId: a }, (tx) =>
      tx.update(invitations).set({ revokedAt: new Date() }).where(eq(invitations.id, first)),
    );
    await withTenant(app, { companyId: a }, (tx) =>
      tx.insert(invitations).values({
        companyId: a,
        email,
        roleId: roleA,
        tokenHash: sha('a3'),
        expiresAt: new Date(Date.now() + 86_400_000),
      }),
    );
  });

  it('app_invitation_lookup finds by hash only', async () => {
    const { a, b, roleA, roleB } = await seedIdentity();
    const inv = newId();
    await ownerDb.insert(invitations).values([
      {
        id: inv,
        companyId: a,
        email: 'x@example.com',
        roleId: roleA,
        tokenHash: sha('aa'),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
      {
        companyId: b,
        email: 'y@example.com',
        roleId: roleB,
        tokenHash: sha('bb'),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    ]);
    const hit = await app.query('select * from app_invitation_lookup($1)', [sha('aa')]);
    expect(hit.rows).toHaveLength(1);
    expect(hit.rows[0]).toMatchObject({
      invitation_id: inv,
      company_id: a,
      company_name: 'Alpha Builders',
      company_status: 'active',
      email: 'x@example.com',
      role_name: 'Super Admin',
      accepted_at: null,
      revoked_at: null,
    });
    expect(Object.keys(hit.rows[0]).sort()).toEqual(
      [
        'invitation_id',
        'company_id',
        'company_name',
        'company_status',
        'email',
        'role_name',
        'expires_at',
        'accepted_at',
        'revoked_at',
      ].sort(),
    );
    const miss = await app.query('select * from app_invitation_lookup($1)', [sha('cc')]);
    expect(miss.rows).toHaveLength(0);
  });

  it('emails must be stored lowercase', async () => {
    const { a, roleA } = await seedIdentity();
    await expect(
      owner.query("insert into users (id, name, email) values ($1, 'Caps', 'Caps@Example.com')", [
        newId(),
      ]),
    ).rejects.toThrow(/check constraint/);
    await expect(
      withTenant(app, { companyId: a }, (tx) =>
        tx.insert(invitations).values({
          companyId: a,
          email: 'Caps@Example.com',
          roleId: roleA,
          tokenHash: sha('c1'),
          expiresAt: new Date(),
        }),
      ),
    ).rejects.toThrow(/check/);
  });

  it('app_user can use the global identity tables', async () => {
    const id = newId();
    await app.query("insert into users (id, name, email) values ($1, 'Gil', $2)", [
      id,
      `gil-${id}@example.com`,
    ]);
    await app.query(
      "insert into sessions (id, user_id, token, expires_at) values ($1, $2, $3, now() + interval '1 day')",
      [newId(), id, `t-${id}`],
    );
    await app.query(
      "insert into accounts (id, user_id, account_id, provider_id, password) values ($1, $2, $3, 'credential', 'hash')",
      [newId(), id, id],
    );
    await app.query(
      "insert into verifications (id, identifier, value, expires_at) values ($1, 'x', 'y', now())",
      [newId()],
    );
    await app.query("update users set name = 'Gil B' where id = $1", [id]);
    await app.query('delete from users where id = $1', [id]);
    const { rows } = await app.query('select count(*)::int as n from sessions where user_id = $1', [
      id,
    ]);
    expect(rows[0].n).toBe(0);
  });

  it('PUBLIC cannot touch identity tables or execute the lookup functions', async () => {
    const { rows } = await owner.query<{ name: string; ok: boolean }>(`
      select t as name, has_table_privilege('public', t, 'SELECT') as ok
        from unnest(array['users','sessions','accounts','verifications']) t
      union all
      select f, has_function_privilege('public', f, 'EXECUTE')
        from unnest(array['app_user_memberships(uuid)','app_invitation_lookup(text)']) f`);
    for (const r of rows) expect(r.ok, r.name).toBe(false);
  });

  it('lookup functions are SECURITY DEFINER with a pinned search_path', async () => {
    const { rows } = await owner.query<{
      name: string;
      secdef: boolean;
      config: string[] | null;
      ownedByMigrator: boolean;
    }>(`
      select p.proname as name, p.prosecdef as secdef, p.proconfig as config,
             pg_get_userbyid(p.proowner) = current_user as "ownedByMigrator"
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname in ('app_user_memberships','app_invitation_lookup')
       order by 1`);
    expect(rows.map((r) => r.name)).toEqual(['app_invitation_lookup', 'app_user_memberships']);
    for (const r of rows) {
      expect(r.secdef, r.name).toBe(true);
      expect(r.ownedByMigrator, r.name).toBe(true);
      expect(r.config, r.name).toEqual(['search_path=pg_catalog, public']);
    }
  });
});
