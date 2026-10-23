import { Hono } from 'hono';
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { workDate } from '@sitediary/shared';
import type { AppEnv } from '../auth/session';
import { attendanceEntries, memberships, users } from '../db/schema';
import { AppError } from '../http/errors';
import { requireCap, runInTenant, type TenantEnv } from '../tenant/context';
import { canSeeProject } from './reach';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 62;
const MAX_ROWS = 1000;
const notFound = () => new AppError(404, 'not_found', 'Not found.');
const badRange = () =>
  new AppError(400, 'bad_range', `Choose dates no more than ${MAX_DAYS} days apart.`);

const dayNumber = (d: string) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 86_400_000);

/**
 * `GET /log?projectId&from&to&scope=me|team`: the attendance log of one project over a date range.
 * `me` (default) is the caller's own entries; `team` is everyone's on that project and needs
 * `attendance.review`. Every status is returned, rejected ones included, newest day first.
 */
export function logRoutes(): Hono<AppEnv> {
  const r = new Hono<TenantEnv>();

  r.get('/log', requireCap('attendance.view'), async (c) => {
    const t = c.get('tenant');
    const projectId = (c.req.query('projectId') ?? '').toLowerCase();
    if (!UUID_RE.test(projectId)) throw notFound();
    const today = workDate(new Date());
    const to = c.req.query('to') ?? today;
    const from = c.req.query('from') ?? workDate(new Date(Date.now() - 29 * 86_400_000));
    if (!DATE_RE.test(from) || !DATE_RE.test(to) || Number.isNaN(Date.parse(from + 'T00:00:00Z'))) {
      throw badRange();
    }
    if (Number.isNaN(Date.parse(to + 'T00:00:00Z'))) throw badRange();
    if (dayNumber(to) < dayNumber(from) || dayNumber(to) - dayNumber(from) >= MAX_DAYS) {
      throw badRange();
    }
    const team = c.req.query('scope') === 'team';
    if (team && !t.capabilities.has('attendance.review')) {
      throw new AppError(403, 'forbidden', 'You do not have access to this.');
    }
    const entries = await runInTenant(c, async (tx) => {
      if (!(await canSeeProject(tx, t, projectId))) throw notFound();
      return tx
        .select({
          id: attendanceEntries.id,
          membershipId: attendanceEntries.membershipId,
          name: users.name,
          workDate: attendanceEntries.workDate,
          kind: attendanceEntries.kind,
          at: attendanceEntries.at,
          status: attendanceEntries.status,
          lateMin: attendanceEntries.lateMin,
          distanceM: attendanceEntries.distanceM,
          reasons: attendanceEntries.reasons,
        })
        .from(attendanceEntries)
        .innerJoin(
          memberships,
          and(
            eq(memberships.companyId, attendanceEntries.companyId),
            eq(memberships.id, attendanceEntries.membershipId),
          ),
        )
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(
          and(
            eq(attendanceEntries.companyId, t.companyId),
            eq(attendanceEntries.projectId, projectId),
            gte(attendanceEntries.workDate, from),
            lte(attendanceEntries.workDate, to),
            ...(team ? [] : [eq(attendanceEntries.membershipId, t.membershipId)]),
          ),
        )
        .orderBy(asc(attendanceEntries.workDate), asc(attendanceEntries.at))
        .limit(MAX_ROWS);
    });
    return c.json({
      from,
      to,
      scope: team ? 'team' : 'me',
      entries: entries.map(({ membershipId, ...e }) => ({
        ...e,
        own: membershipId === t.membershipId,
      })),
    });
  });

  return r as unknown as Hono<AppEnv>;
}
