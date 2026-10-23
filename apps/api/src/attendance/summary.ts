import { Hono } from 'hono';
import { and, asc, eq, gte, inArray, lte, or } from 'drizzle-orm';
import { ATTENDANCE_TZ, workDate } from '@sitediary/shared';
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
import { AppError } from '../http/errors';
import { requireCap, runInTenant, type Tenant, type TenantEnv } from '../tenant/context';
import { buildWorkbook } from './export';
import { ipBackstop, memberLimit } from './limits';
import { canSeeProject } from './reach';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
/** A month's summary or file is a heavy read: each member gets a few a minute. */
const SUMMARY_LIMIT = { max: 30, windowMs: 60_000 };
const EXPORT_LIMIT = { max: 6, windowMs: 60_000 };
const notFound = () => new AppError(404, 'not_found', 'Not found.');
const badMonth = () => new AppError(400, 'bad_month', 'Choose a month like 2026-10.');

export type SummaryEntry = {
  membershipId: string;
  workDate: string;
  kind: string;
  at: Date;
  status: string;
  lateMin: number;
  distanceM: number;
  reasons: string[];
};
export type SummaryMember = { membershipId: string; name: string; email: string };

/** `open` is a day that has not ended and has no check-in yet; it never counts as absent. */
export type DayStatus = 'present' | 'late' | 'pending' | 'absent' | 'open';
export type DayCell = { date: string; status: DayStatus; in: Date | null; out: Date | null };
export type PersonSummary = SummaryMember & {
  /** Recorded or approved check-ins, late ones included. */
  present: number;
  /** Of `present`, the check-ins after the late limit. */
  late: number;
  /** Check-ins still waiting for a reviewer. */
  pending: number;
  /** Past days with no check-in at all. */
  absent: number;
  /** Sum of check-out minus check-in over the days that have both, in hours. */
  hours: number;
  cells: DayCell[];
};
export type MonthlySummary = { month: string; days: string[]; people: PersonSummary[] };

/** Every `YYYY-MM-DD` of a month (`YYYY-MM`). */
export function daysOfMonth(month: string): string[] {
  const m = MONTH_RE.exec(month);
  if (!m) throw badMonth();
  const year = Number(m[1]);
  const mon = Number(m[2]);
  const count = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return Array.from(
    { length: count },
    (_, i) => `${m[1]}-${m[2]}-${String(i + 1).padStart(2, '0')}`,
  );
}

/**
 * Builds the month's attendance for each person. Attendance is every day (no days off), so a past
 * day with no check-in is absent. Rejected entries never count. `today` is the site's local date.
 */
export function buildSummary(input: {
  month: string;
  today: string;
  members: SummaryMember[];
  entries: SummaryEntry[];
}): MonthlySummary {
  const days = daysOfMonth(input.month);
  const live = input.entries.filter((e) => e.status !== 'rejected');
  const people = input.members.map((member): PersonSummary => {
    const mine = live.filter((e) => e.membershipId === member.membershipId);
    let present = 0;
    let late = 0;
    let pending = 0;
    let absent = 0;
    let hours = 0;
    const cells = days.map((date): DayCell => {
      const day = mine.filter((e) => e.workDate === date);
      const inn = day.find((e) => e.kind === 'check_in') ?? null;
      const out = day.find((e) => e.kind === 'check_out') ?? null;
      let status: DayStatus;
      if (!inn) {
        status = date < input.today ? 'absent' : 'open';
        if (status === 'absent') absent++;
      } else if (inn.status === 'pending') {
        status = 'pending';
        pending++;
      } else {
        status = inn.lateMin > 0 ? 'late' : 'present';
        present++;
        if (status === 'late') late++;
      }
      if (inn && out && out.at > inn.at) hours += (out.at.getTime() - inn.at.getTime()) / 3_600_000;
      return { date, status, in: inn?.at ?? null, out: out?.at ?? null };
    });
    return {
      ...member,
      present,
      late,
      pending,
      absent,
      hours: Math.round(hours * 100) / 100,
      cells,
    };
  });
  people.sort((a, b) => a.name.localeCompare(b.name));
  return { month: input.month, days, people };
}

/** Everything the summary and the export read for one project and month, inside the tenant. */
async function loadMonth(tx: AppTx, t: Tenant, projectId: string, month: string) {
  if (!(await canSeeProject(tx, t, projectId))) throw notFound();
  const days = daysOfMonth(month);
  const first = days[0]!;
  const last = days[days.length - 1]!;
  const [project] = await tx
    .select({ name: projects.name })
    .from(projects)
    .where(and(eq(projects.companyId, t.companyId), eq(projects.id, projectId)));
  const [settings] = await tx
    .select({ timezone: attendanceSettings.timezone })
    .from(attendanceSettings)
    .where(
      and(
        eq(attendanceSettings.companyId, t.companyId),
        eq(attendanceSettings.projectId, projectId),
      ),
    );
  const tz = settings?.timezone ?? ATTENDANCE_TZ;
  const entries = await tx
    .select({
      membershipId: attendanceEntries.membershipId,
      workDate: attendanceEntries.workDate,
      kind: attendanceEntries.kind,
      at: attendanceEntries.at,
      status: attendanceEntries.status,
      lateMin: attendanceEntries.lateMin,
      distanceM: attendanceEntries.distanceM,
      reasons: attendanceEntries.reasons,
    })
    .from(attendanceEntries)
    .where(
      and(
        eq(attendanceEntries.companyId, t.companyId),
        eq(attendanceEntries.projectId, projectId),
        gte(attendanceEntries.workDate, first),
        lte(attendanceEntries.workDate, last),
      ),
    )
    .orderBy(asc(attendanceEntries.workDate), asc(attendanceEntries.at));
  // People on the project, plus anyone who has an entry on it this month.
  const assigned = await tx
    .select({ id: projectAssignments.membershipId })
    .from(projectAssignments)
    .where(
      and(
        eq(projectAssignments.companyId, t.companyId),
        eq(projectAssignments.projectId, projectId),
      ),
    );
  const ids = [...new Set([...assigned.map((a) => a.id), ...entries.map((e) => e.membershipId)])];
  const members =
    ids.length === 0
      ? []
      : await tx
          .select({ membershipId: memberships.id, name: users.name, email: users.email })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(
            and(
              eq(memberships.companyId, t.companyId),
              inArray(memberships.id, ids),
              or(
                eq(memberships.status, 'active'),
                inArray(
                  memberships.id,
                  entries.map((e) => e.membershipId),
                ),
              ),
            ),
          );
  return { projectName: project?.name ?? 'Project', tz, entries, members };
}

function params(c: { req: { query: (k: string) => string | undefined } }) {
  const projectId = (c.req.query('projectId') ?? '').toLowerCase();
  if (!UUID_RE.test(projectId)) throw notFound();
  const month = c.req.query('month') ?? workDate(new Date()).slice(0, 7);
  if (!MONTH_RE.test(month)) throw badMonth();
  return { projectId, month };
}

/** `GET /summary` (needs `attendance.review`) and `GET /export` (needs `attendance.export`). */
export function summaryRoutes(): Hono<AppEnv> {
  const r = new Hono<TenantEnv>();

  r.get(
    '/summary',
    ipBackstop(),
    memberLimit(SUMMARY_LIMIT),
    requireCap('attendance.review'),
    async (c) => {
      const t = c.get('tenant');
      const { projectId, month } = params(c);
      const data = await runInTenant(c, (tx) => loadMonth(tx, t, projectId, month));
      const summary = buildSummary({
        month,
        today: workDate(new Date(), data.tz),
        members: data.members,
        entries: data.entries,
      });
      return c.json({ projectName: data.projectName, timezone: data.tz, ...summary });
    },
  );

  r.get(
    '/export',
    ipBackstop(),
    memberLimit(EXPORT_LIMIT),
    requireCap('attendance.export'),
    async (c) => {
      const t = c.get('tenant');
      const { projectId, month } = params(c);
      const data = await runInTenant(c, async (tx) => {
        const loaded = await loadMonth(tx, t, projectId, month);
        await writeAudit(tx, t, {
          action: 'attendance.exported',
          entity: 'project',
          entityId: projectId,
          before: null,
          after: { month, people: loaded.members.length },
        });
        return loaded;
      });
      const summary = buildSummary({
        month,
        today: workDate(new Date(), data.tz),
        members: data.members,
        entries: data.entries,
      });
      const body = await buildWorkbook({
        projectName: data.projectName,
        timezone: data.tz,
        summary,
        entries: data.entries,
        members: data.members,
      });
      const safe =
        data.projectName.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
      return c.body(body, 200, {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': `attachment; filename="attendance-${safe}-${month}.xlsx"`,
        'cache-control': 'no-store',
      });
    },
  );

  return r as unknown as Hono<AppEnv>;
}
