import { and, eq, sql } from 'drizzle-orm';
import { projectAssignments, projects } from '../db/schema';
import type { AppTx } from '../db/tenant';
import type { Tenant } from '../tenant/context';

/** True when the project exists in the tenant's company and they can see it (`projects.all` or assigned). */
export async function canSeeProject(tx: AppTx, t: Tenant, projectId: string): Promise<boolean> {
  const [p] = await tx
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.companyId, t.companyId), eq(projects.id, projectId)));
  if (!p) return false;
  if (t.capabilities.has('projects.all')) return true;
  const [mine] = await tx
    .select({ id: projectAssignments.id })
    .from(projectAssignments)
    .where(
      and(
        eq(projectAssignments.companyId, t.companyId),
        eq(projectAssignments.projectId, projectId),
        eq(projectAssignments.membershipId, t.membershipId),
      ),
    );
  return !!mine;
}

/** True when the tenant (with `projects.all`, or any common assignment) can reach another member. */
export async function sharesProject(tx: AppTx, t: Tenant, membershipId: string): Promise<boolean> {
  if (t.capabilities.has('projects.all')) return true;
  const res = await tx.execute<{ ok: number }>(sql`
    select 1 as ok from project_assignments a
      join project_assignments b
        on b.company_id = a.company_id and b.project_id = a.project_id
     where a.company_id = ${t.companyId}
       and a.membership_id = ${t.membershipId}
       and b.membership_id = ${membershipId}
     limit 1`);
  return res.rows.length > 0;
}
