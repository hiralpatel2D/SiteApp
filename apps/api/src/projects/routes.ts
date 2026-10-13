import { Hono } from 'hono';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  createProjectBodySchema,
  newId,
  setProjectMembersBodySchema,
  updateProjectBodySchema,
} from '@sitediary/shared';
import { writeAudit } from '../audit/audit';
import { requireUser, type AppEnv } from '../auth/session';
import { isUniqueViolation } from '../db/errors';
import type { Pools } from '../db/pools';
import { memberships, projectAssignments, projects } from '../db/schema';
import type { AppTx } from '../db/tenant';
import { parseBody } from '../http/body';
import { AppError } from '../http/errors';
import {
  requireCap,
  runInTenant,
  tenantMiddleware,
  type Tenant,
  type TenantEnv,
} from '../tenant/context';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_UNIQUE = 'projects_company_id_code_unique';

const notFound = () => new AppError(404, 'not_found', 'Not found.');
const staleVersion = () =>
  new AppError(409, 'stale_version', 'Someone else changed this. Reload and try again.');
const codeTaken = () =>
  new AppError(409, 'project_code_taken', 'A project with this code already exists.');

export type ProjectListItem = {
  id: string;
  name: string;
  code: string;
  location: string | null;
  status: string;
  memberCount: number;
  version: number;
};

const sees = (t: Tenant) => t.capabilities.has('projects.all');

/** Projects visible to the tenant (all with `projects.all`, else assigned), by name. */
async function selectProjects(
  tx: AppTx,
  t: Tenant,
  projectId?: string,
): Promise<ProjectListItem[]> {
  const res = await tx.execute<ProjectListItem>(sql`
    select p.id, p.name, p.code, p.location, p.status, p.version,
           (select count(*)::int from project_assignments pa
             where pa.company_id = p.company_id and pa.project_id = p.id) as "memberCount"
      from projects p
     where p.company_id = ${t.companyId}
       ${projectId ? sql`and p.id = ${projectId}` : sql``}
       ${
         sees(t)
           ? sql``
           : sql`and exists (select 1 from project_assignments mine
                              where mine.company_id = p.company_id and mine.project_id = p.id
                                and mine.membership_id = ${t.membershipId})`
       }
     order by p.name, p.code, p.id`);
  return res.rows;
}

const projectParam = (raw: string) => {
  const id = raw.toLowerCase();
  if (!UUID_RE.test(id)) throw notFound();
  return id;
};

/** Locks a project the tenant can see, or throws 404 (hidden projects look absent). */
async function lockVisibleProject(tx: AppTx, t: Tenant, id: string) {
  const [p] = await tx
    .select()
    .from(projects)
    .where(and(eq(projects.companyId, t.companyId), eq(projects.id, id)))
    .for('update');
  if (!p) throw notFound();
  if (!sees(t)) {
    const [mine] = await tx
      .select({ id: projectAssignments.id })
      .from(projectAssignments)
      .where(
        and(
          eq(projectAssignments.companyId, t.companyId),
          eq(projectAssignments.projectId, id),
          eq(projectAssignments.membershipId, t.membershipId),
        ),
      );
    if (!mine) throw notFound();
  }
  return p;
}

const snapshot = (p: { name: string; code: string; location: string | null; status: string }) => ({
  name: p.name,
  code: p.code,
  location: p.location,
  status: p.status,
});

/**
 * `/api/projects`: a company's projects and who is assigned to them. People
 * without `projects.all` only see (and can only change) projects they are
 * assigned to; anything else reads as 404.
 */
export function projectRoutes(pools: Pools): Hono<AppEnv> {
  const r = new Hono<TenantEnv>();
  r.use('*', requireUser, tenantMiddleware(pools));

  r.get('/', requireCap('projects.view'), async (c) => {
    const t = c.get('tenant');
    return c.json(await runInTenant(c, (tx) => selectProjects(tx, t)));
  });

  r.post('/', requireCap('projects.manage'), async (c) => {
    const body = await parseBody(c, createProjectBodySchema);
    const t = c.get('tenant');
    try {
      const created = await runInTenant(c, async (tx) => {
        const id = newId();
        const row = {
          name: body.name,
          code: body.code,
          location: body.location ?? null,
          status: 'active',
        };
        await tx.insert(projects).values({
          id,
          companyId: t.companyId,
          ...row,
          createdBy: t.userId,
          updatedBy: t.userId,
        });
        if (!sees(t)) {
          await tx.insert(projectAssignments).values({
            id: newId(),
            companyId: t.companyId,
            membershipId: t.membershipId,
            projectId: id,
            createdBy: t.userId,
            updatedBy: t.userId,
          });
        }
        await writeAudit(tx, t, {
          action: 'project.created',
          entity: 'project',
          entityId: id,
          after: row,
        });
        return (await selectProjects(tx, t, id))[0]!;
      });
      return c.json(created, 201);
    } catch (err) {
      if (isUniqueViolation(err, CODE_UNIQUE)) throw codeTaken();
      throw err;
    }
  });

  r.patch('/:id', requireCap('projects.manage'), async (c) => {
    const id = projectParam(c.req.param('id'));
    const body = await parseBody(c, updateProjectBodySchema);
    const t = c.get('tenant');
    try {
      const updated = await runInTenant(c, async (tx) => {
        const p = await lockVisibleProject(tx, t, id);
        if (p.version !== body.version) throw staleVersion();
        const next = {
          name: body.name ?? p.name,
          code: body.code ?? p.code,
          location: body.location === undefined ? p.location : body.location,
          status: body.status ?? p.status,
        };
        const before = snapshot(p);
        if (JSON.stringify(before) === JSON.stringify(next)) {
          return (await selectProjects(tx, t, id))[0]!;
        }
        await tx
          .update(projects)
          .set({ ...next, updatedBy: t.userId, version: sql`${projects.version} + 1` })
          .where(and(eq(projects.companyId, t.companyId), eq(projects.id, id)));
        await writeAudit(tx, t, {
          action: 'project.updated',
          entity: 'project',
          entityId: id,
          before,
          after: next,
        });
        return (await selectProjects(tx, t, id))[0]!;
      });
      return c.json(updated);
    } catch (err) {
      if (isUniqueViolation(err, CODE_UNIQUE)) throw codeTaken();
      throw err;
    }
  });

  r.put('/:id/members', requireCap('projects.manage'), async (c) => {
    const id = projectParam(c.req.param('id'));
    const body = await parseBody(c, setProjectMembersBodySchema);
    const t = c.get('tenant');
    const updated = await runInTenant(c, async (tx) => {
      await lockVisibleProject(tx, t, id);
      const next = body.membershipIds;
      if (next.length > 0) {
        const valid = await tx
          .select({ id: memberships.id })
          .from(memberships)
          .where(
            and(
              eq(memberships.companyId, t.companyId),
              eq(memberships.status, 'active'),
              inArray(memberships.id, next),
            ),
          );
        if (valid.length !== next.length) throw notFound();
      }
      const current = await tx
        .select({ membershipId: projectAssignments.membershipId })
        .from(projectAssignments)
        .where(
          and(eq(projectAssignments.companyId, t.companyId), eq(projectAssignments.projectId, id)),
        );
      const before = current.map((a) => a.membershipId).sort();
      const after = [...next].sort();
      if (JSON.stringify(before) === JSON.stringify(after)) {
        return (await selectProjects(tx, t, id))[0] ?? null;
      }
      await tx
        .delete(projectAssignments)
        .where(
          and(eq(projectAssignments.companyId, t.companyId), eq(projectAssignments.projectId, id)),
        );
      if (next.length > 0) {
        await tx.insert(projectAssignments).values(
          next.map((membershipId) => ({
            id: newId(),
            companyId: t.companyId,
            membershipId,
            projectId: id,
            createdBy: t.userId,
            updatedBy: t.userId,
          })),
        );
      }
      await writeAudit(tx, t, {
        action: 'project.members_changed',
        entity: 'project',
        entityId: id,
        before: { membershipIds: before },
        after: { membershipIds: after },
      });
      // The caller may have removed their own access; report from the project row.
      const res = await tx.execute<{ memberCount: number }>(sql`
        select count(*)::int as "memberCount" from project_assignments
         where company_id = ${t.companyId} and project_id = ${id}`);
      const [p] = await tx
        .select()
        .from(projects)
        .where(and(eq(projects.companyId, t.companyId), eq(projects.id, id)));
      return {
        id: p!.id,
        name: p!.name,
        code: p!.code,
        location: p!.location,
        status: p!.status,
        memberCount: res.rows[0]!.memberCount,
        version: p!.version,
      } satisfies ProjectListItem;
    });
    return c.json(updated);
  });

  return r as unknown as Hono<AppEnv>;
}
