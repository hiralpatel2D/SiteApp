import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { newId, updateUserBodySchema, type MembershipStatus } from '@sitediary/shared';
import { writeAudit } from '../audit/audit';
import { requireUser, type AppEnv } from '../auth/session';
import type { Pools } from '../db/pools';
import { memberships, projectAssignments, roles } from '../db/schema';
import type { AppTx } from '../db/tenant';
import { parseBody } from '../http/body';
import { AppError } from '../http/errors';
import { companyProjectIds } from '../invitations/service';
import { assertSuperAdminRemains } from '../roles/lockout';
import { requireCap, runInTenant, tenantMiddleware, type TenantEnv } from '../tenant/context';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const notFound = () => new AppError(404, 'not_found', 'Not found.');
const staleVersion = () =>
  new AppError(409, 'stale_version', 'Someone else changed this. Reload and try again.');

export type UserListItem = {
  membershipId: string;
  name: string;
  email: string;
  roleId: string;
  roleName: string;
  status: MembershipStatus;
  projectIds: string[];
  version: number;
};

/** The company's members (or one of them), ordered by name. */
async function selectUsers(
  tx: AppTx,
  companyId: string,
  membershipId?: string,
): Promise<UserListItem[]> {
  const res = await tx.execute<UserListItem>(sql`
    select m.id as "membershipId", u.name, u.email, m.role_id as "roleId",
           r.name as "roleName", m.status, m.version,
           coalesce(
             array_agg(pa.project_id::text order by pa.project_id)
               filter (where pa.project_id is not null),
             '{}'
           ) as "projectIds"
      from memberships m
      join users u on u.id = m.user_id
      join roles r on r.company_id = m.company_id and r.id = m.role_id
      left join project_assignments pa
        on pa.company_id = m.company_id and pa.membership_id = m.id
     where m.company_id = ${companyId}
       ${membershipId ? sql`and m.id = ${membershipId}` : sql``}
     group by m.id, u.id, r.id
     order by u.name, u.email, m.id`);
  return res.rows;
}

const sorted = (ids: Iterable<string>) => [...ids].sort();
const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && sorted(a).every((x, i) => x === sorted(b)[i]);

/**
 * `/api/users`: the company's members, their role, status and project
 * assignments. Every role or status change runs the lockout guard in the same
 * transaction. Users may deactivate themselves (or change their own role)
 * unless that would leave the company without an active Super Admin.
 */
export function userRoutes(pools: Pools): Hono<AppEnv> {
  const r = new Hono<TenantEnv>();
  r.use('*', requireUser, tenantMiddleware(pools));

  r.get('/', requireCap('users.view'), async (c) => {
    const t = c.get('tenant');
    return c.json(await runInTenant(c, (tx) => selectUsers(tx, t.companyId)));
  });

  r.patch('/:membershipId', requireCap('users.manage'), async (c) => {
    const membershipId = c.req.param('membershipId').toLowerCase();
    if (!UUID_RE.test(membershipId)) throw notFound();
    const body = await parseBody(c, updateUserBodySchema);
    const t = c.get('tenant');

    const updated = await runInTenant(c, async (tx) => {
      const [m] = await tx
        .select({
          id: memberships.id,
          roleId: memberships.roleId,
          status: memberships.status,
          version: memberships.version,
        })
        .from(memberships)
        .where(and(eq(memberships.companyId, t.companyId), eq(memberships.id, membershipId)))
        .for('update');
      if (!m) throw notFound();
      if (m.version !== body.version) throw staleVersion();

      // Resolve and validate everything before writing anything.
      const roleName = async (id: string) => {
        const [row] = await tx
          .select({ name: roles.name })
          .from(roles)
          .where(and(eq(roles.companyId, t.companyId), eq(roles.id, id)));
        return row?.name;
      };
      const newRoleId = body.roleId?.toLowerCase();
      const roleChanged = newRoleId !== undefined && newRoleId !== m.roleId;
      const newRoleName = roleChanged ? await roleName(newRoleId) : undefined;
      if (roleChanged && newRoleName === undefined) throw notFound();

      let projectsBefore: string[] = [];
      let projectsChanged = false;
      if (body.projectIds !== undefined) {
        const valid = await companyProjectIds(tx, t.companyId, body.projectIds);
        if (valid.length !== body.projectIds.length) throw notFound();
        const current = await tx
          .select({ projectId: projectAssignments.projectId })
          .from(projectAssignments)
          .where(
            and(
              eq(projectAssignments.companyId, t.companyId),
              eq(projectAssignments.membershipId, m.id),
            ),
          );
        projectsBefore = current.map((p) => p.projectId);
        projectsChanged = !sameSet(projectsBefore, body.projectIds);
      }

      const statusChanged = body.status !== undefined && body.status !== m.status;

      if (!roleChanged && !statusChanged && !projectsChanged) {
        return (await selectUsers(tx, t.companyId, m.id))[0]!;
      }

      await tx
        .update(memberships)
        .set({
          ...(roleChanged ? { roleId: newRoleId } : {}),
          ...(statusChanged ? { status: body.status } : {}),
          updatedBy: t.userId,
          version: sql`${memberships.version} + 1`,
        })
        .where(and(eq(memberships.companyId, t.companyId), eq(memberships.id, m.id)));

      if (roleChanged) {
        await writeAudit(tx, t, {
          action: 'membership.role_changed',
          entity: 'membership',
          entityId: m.id,
          before: { roleId: m.roleId, roleName: await roleName(m.roleId) },
          after: { roleId: newRoleId, roleName: newRoleName },
        });
      }
      if (statusChanged) {
        await writeAudit(tx, t, {
          action: 'membership.status_changed',
          entity: 'membership',
          entityId: m.id,
          before: { status: m.status },
          after: { status: body.status },
        });
      }
      if (projectsChanged) {
        const next = body.projectIds!;
        await tx
          .delete(projectAssignments)
          .where(
            and(
              eq(projectAssignments.companyId, t.companyId),
              eq(projectAssignments.membershipId, m.id),
            ),
          );
        if (next.length > 0) {
          await tx.insert(projectAssignments).values(
            next.map((projectId) => ({
              id: newId(),
              companyId: t.companyId,
              membershipId: m.id,
              projectId,
              createdBy: t.userId,
              updatedBy: t.userId,
            })),
          );
        }
        await writeAudit(tx, t, {
          action: 'membership.projects_changed',
          entity: 'membership',
          entityId: m.id,
          before: { projectIds: sorted(projectsBefore) },
          after: { projectIds: sorted(next) },
        });
      }

      if (roleChanged || statusChanged) await assertSuperAdminRemains(tx, t.companyId);
      return (await selectUsers(tx, t.companyId, m.id))[0]!;
    });

    return c.json(updated);
  });

  return r as unknown as Hono<AppEnv>;
}
