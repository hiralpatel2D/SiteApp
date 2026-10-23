import { Hono } from 'hono';
import { and, asc, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import { writeAudit } from '../audit/audit';
import type { AppEnv } from '../auth/session';
import type { Pools } from '../db/pools';
import { memberships, roles, users } from '../db/schema';
import { parseBody } from '../http/body';
import { AppError } from '../http/errors';
import { runInTenant, tenantMiddleware, type TenantEnv } from './context';
import { signViewAs, VIEW_AS_TTL_MS } from './view-as-token';

const startBodySchema = z.object({ membershipId: z.string().uuid() });

const onlySuperAdmin = () =>
  new AppError(403, 'forbidden', 'Only a Super Admin can view the app as someone else.');

/**
 * The Super Admin's read-only preview of another person: `GET /company/view-as/people`,
 * `POST /company/view-as` (start, audited, returns a signed token) and `POST /company/view-as/stop`.
 * These use the real identity: an active view does not change who may start or stop one.
 */
export function viewAsRoutes(pools: Pools): Hono<AppEnv> {
  const r = new Hono<TenantEnv>();
  r.use('/company/view-as/*', tenantMiddleware(pools, { ignoreViewAs: true }));
  r.use('/company/view-as', tenantMiddleware(pools, { ignoreViewAs: true }));

  r.get('/company/view-as/people', async (c) => {
    if (!c.get('canViewAs')) throw onlySuperAdmin();
    const t = c.get('tenant');
    const people = await runInTenant(c, (tx) =>
      tx
        .select({
          membershipId: memberships.id,
          name: users.name,
          email: users.email,
          roleName: roles.name,
          roleKey: roles.key,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .innerJoin(
          roles,
          and(eq(roles.companyId, memberships.companyId), eq(roles.id, memberships.roleId)),
        )
        .where(
          and(
            eq(memberships.companyId, t.companyId),
            eq(memberships.status, 'active'),
            ne(memberships.id, t.membershipId),
          ),
        )
        .orderBy(asc(roles.name), asc(users.name)),
    );
    return c.json({ people });
  });

  r.post('/company/view-as', async (c) => {
    if (!c.get('canViewAs')) throw onlySuperAdmin();
    const t = c.get('tenant');
    const { membershipId } = await parseBody(c, startBodySchema);
    const target = await runInTenant(c, async (tx) => {
      const [row] = await tx
        .select({
          membershipId: memberships.id,
          name: users.name,
          email: users.email,
          roleName: roles.name,
          roleKey: roles.key,
          status: memberships.status,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .innerJoin(
          roles,
          and(eq(roles.companyId, memberships.companyId), eq(roles.id, memberships.roleId)),
        )
        .where(and(eq(memberships.companyId, t.companyId), eq(memberships.id, membershipId)));
      if (!row || row.status !== 'active' || row.membershipId === t.membershipId) {
        throw new AppError(404, 'not_found', 'Not found.');
      }
      await writeAudit(tx, t, {
        action: 'view_as.started',
        entity: 'membership',
        entityId: row.membershipId,
        before: null,
        after: { name: row.name, role: row.roleName },
      });
      return row;
    });
    const exp = Date.now() + VIEW_AS_TTL_MS;
    const token = signViewAs(pools.viewAsSecret, {
      u: t.userId,
      c: t.companyId,
      t: target.membershipId,
      exp,
    });
    return c.json({
      token,
      expiresAt: new Date(exp).toISOString(),
      person: {
        membershipId: target.membershipId,
        name: target.name,
        email: target.email,
        roleName: target.roleName,
        roleKey: target.roleKey,
      },
    });
  });

  r.post('/company/view-as/stop', async (c) => {
    if (!c.get('canViewAs')) throw onlySuperAdmin();
    const t = c.get('tenant');
    await runInTenant(c, (tx) =>
      writeAudit(tx, t, {
        action: 'view_as.stopped',
        entity: 'company',
        entityId: t.companyId,
        before: null,
        after: null,
      }),
    );
    return c.json({ ok: true });
  });

  return r as unknown as Hono<AppEnv>;
}
