import { Hono, type Context } from 'hono';
import { and, asc, eq, exists, ne, sql } from 'drizzle-orm';
import { reviewDecisionBodySchema } from '@sitediary/shared';
import { writeAudit } from '../audit/audit';
import type { AppEnv } from '../auth/session';
import {
  attendanceEntries,
  attendanceSettings,
  memberships,
  projectAssignments,
  projects,
  users,
} from '../db/schema';
import type { AppTx } from '../db/tenant';
import { parseBody } from '../http/body';
import { AppError } from '../http/errors';
import { forbidden } from '../roles/authz';
import { requireCap, runInTenant, type Tenant, type TenantEnv } from '../tenant/context';
import { canSeeProject } from './reach';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new AppError(404, 'not_found', 'Not found.');
const alreadyDecided = () =>
  new AppError(409, 'already_decided', 'This entry has already been decided.');

const dataUrl = (b: Buffer) => `data:image/jpeg;base64,${b.toString('base64')}`;

/** Locks the entry the reviewer may decide: 404 out of reach, 403 own, 409 not pending. */
async function loadDecidable(tx: AppTx, t: Tenant, rawId: string) {
  const id = rawId.toLowerCase();
  if (!UUID_RE.test(id)) throw notFound();
  const [row] = await tx
    .select()
    .from(attendanceEntries)
    .where(and(eq(attendanceEntries.companyId, t.companyId), eq(attendanceEntries.id, id)))
    .for('update');
  if (!row) throw notFound();
  if (!(await canSeeProject(tx, t, row.projectId))) throw notFound();
  if (row.membershipId === t.membershipId) throw forbidden();
  if (row.status !== 'pending') throw alreadyDecided();
  return row;
}

/** `/pending`: senior review of attendance entries that failed a check. Mounted under the attendance router. */
export function reviewRoutes(): Hono<AppEnv> {
  const r = new Hono<TenantEnv>();

  r.get('/pending', requireCap('attendance.review'), async (c) => {
    const t = c.get('tenant');
    const pending = await runInTenant(c, async (tx) => {
      const reach = t.capabilities.has('projects.all')
        ? sql`true`
        : exists(
            tx
              .select({ one: sql`1` })
              .from(projectAssignments)
              .where(
                and(
                  eq(projectAssignments.companyId, t.companyId),
                  eq(projectAssignments.projectId, attendanceEntries.projectId),
                  eq(projectAssignments.membershipId, t.membershipId),
                ),
              ),
          );
      const rows = await tx
        .select({
          id: attendanceEntries.id,
          name: users.name,
          projectName: projects.name,
          kind: attendanceEntries.kind,
          at: attendanceEntries.at,
          workDate: attendanceEntries.workDate,
          reasons: attendanceEntries.reasons,
          distanceM: attendanceEntries.distanceM,
          accuracyM: attendanceEntries.accuracyM,
          similarity: attendanceEntries.similarity,
          lat: attendanceEntries.lat,
          lng: attendanceEntries.lng,
          siteLat: attendanceSettings.lat,
          siteLng: attendanceSettings.lng,
          radiusM: attendanceSettings.radiusM,
          evidence: attendanceEntries.evidence,
        })
        .from(attendanceEntries)
        .innerJoin(
          memberships,
          and(
            eq(memberships.companyId, attendanceEntries.companyId),
            eq(memberships.id, attendanceEntries.membershipId),
            eq(memberships.status, 'active'),
          ),
        )
        .innerJoin(users, eq(users.id, memberships.userId))
        .innerJoin(
          projects,
          and(
            eq(projects.companyId, attendanceEntries.companyId),
            eq(projects.id, attendanceEntries.projectId),
          ),
        )
        .innerJoin(
          attendanceSettings,
          and(
            eq(attendanceSettings.companyId, attendanceEntries.companyId),
            eq(attendanceSettings.projectId, attendanceEntries.projectId),
          ),
        )
        .where(
          and(
            eq(attendanceEntries.companyId, t.companyId),
            eq(attendanceEntries.status, 'pending'),
            ne(attendanceEntries.membershipId, t.membershipId),
            reach,
          ),
        )
        .orderBy(asc(attendanceEntries.at), asc(attendanceEntries.id));
      return rows.map(({ evidence, ...row }) => ({
        ...row,
        photos: (evidence ?? []).map(dataUrl),
      }));
    });
    return c.json({ pending });
  });

  const decide = (action: 'approve' | 'reject') => {
    const status = action === 'approve' ? 'approved' : 'rejected';
    return async (c: Context<TenantEnv>) => {
      const body = await parseBody(c, reviewDecisionBodySchema);
      const t = c.get('tenant');
      const note = body.note ? body.note : null;
      await runInTenant(c, async (tx) => {
        const row = await loadDecidable(tx, t, c.req.param('id')!);
        await tx
          .update(attendanceEntries)
          .set({
            status,
            reviewedBy: t.userId,
            reviewedAt: new Date(),
            reviewNote: note,
            updatedBy: t.userId,
          })
          .where(eq(attendanceEntries.id, row.id));
        await writeAudit(tx, t, {
          action: `attendance.${status}`,
          entity: 'attendance_entry',
          entityId: row.id,
          before: { status: 'pending' },
          after: { status, note },
        });
      });
      return c.json({ status });
    };
  };
  r.post('/pending/:id/approve', requireCap('attendance.review'), decide('approve'));
  r.post('/pending/:id/reject', requireCap('attendance.review'), decide('reject'));

  return r as unknown as Hono<AppEnv>;
}
