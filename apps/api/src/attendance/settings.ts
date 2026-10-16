import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { attendanceSettingsBodySchema, newId } from '@sitediary/shared';
import { writeAudit } from '../audit/audit';
import type { AppEnv } from '../auth/session';
import { attendanceSettings } from '../db/schema';
import { parseBody } from '../http/body';
import { AppError } from '../http/errors';
import { requireCap, runInTenant, type TenantEnv } from '../tenant/context';
import { canSeeProject } from './reach';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new AppError(404, 'not_found', 'Not found.');
const staleVersion = () =>
  new AppError(409, 'stale_version', 'Someone else changed this. Reload and try again.');

const projectParam = (raw: string) => {
  const id = raw.toLowerCase();
  if (!UUID_RE.test(id)) throw notFound();
  return id;
};

type Row = typeof attendanceSettings.$inferSelect;
const view = (s: Row) => ({
  lat: s.lat,
  lng: s.lng,
  radiusM: s.radiusM,
  startTime: s.startTime,
  lateAfterMin: s.lateAfterMin,
  reminderTime: s.reminderTime,
  timezone: s.timezone,
  version: s.version,
});
const fields = (s: Row) => ({
  lat: s.lat,
  lng: s.lng,
  radiusM: s.radiusM,
  startTime: s.startTime,
  lateAfterMin: s.lateAfterMin,
  reminderTime: s.reminderTime,
  timezone: s.timezone,
});

/** `/settings/:projectId`: per-project geofence and timing rules. Mounted under the attendance router. */
export function settingsRoutes(): Hono<AppEnv> {
  const r = new Hono<TenantEnv>();

  r.get('/:projectId', requireCap('attendance.view'), async (c) => {
    const projectId = projectParam(c.req.param('projectId'));
    const t = c.get('tenant');
    const settings = await runInTenant(c, async (tx) => {
      if (!(await canSeeProject(tx, t, projectId))) throw notFound();
      const [s] = await tx
        .select()
        .from(attendanceSettings)
        .where(
          and(
            eq(attendanceSettings.companyId, t.companyId),
            eq(attendanceSettings.projectId, projectId),
          ),
        );
      return s ? view(s) : null;
    });
    return c.json({ settings });
  });

  r.put('/:projectId', requireCap('attendance.settings'), async (c) => {
    const projectId = projectParam(c.req.param('projectId'));
    const body = await parseBody(c, attendanceSettingsBodySchema);
    const t = c.get('tenant');
    const values = {
      lat: body.lat,
      lng: body.lng,
      radiusM: body.radiusM,
      startTime: body.startTime,
      lateAfterMin: body.lateAfterMin,
      reminderTime: body.reminderTime,
    };
    const settings = await runInTenant(c, async (tx) => {
      if (!(await canSeeProject(tx, t, projectId))) throw notFound();
      const [existing] = await tx
        .select()
        .from(attendanceSettings)
        .where(
          and(
            eq(attendanceSettings.companyId, t.companyId),
            eq(attendanceSettings.projectId, projectId),
          ),
        )
        .for('update');
      if (!existing) {
        await tx.insert(attendanceSettings).values({
          id: newId(),
          companyId: t.companyId,
          projectId,
          ...values,
          createdBy: t.userId,
          updatedBy: t.userId,
        });
      } else {
        if (existing.version !== body.version) throw staleVersion();
        await tx
          .update(attendanceSettings)
          .set({ ...values, updatedBy: t.userId, version: sql`${attendanceSettings.version} + 1` })
          .where(eq(attendanceSettings.id, existing.id));
      }
      const [saved] = await tx
        .select()
        .from(attendanceSettings)
        .where(
          and(
            eq(attendanceSettings.companyId, t.companyId),
            eq(attendanceSettings.projectId, projectId),
          ),
        );
      await writeAudit(tx, t, {
        action: 'attendance.settings_changed',
        entity: 'attendance_settings',
        entityId: saved!.id,
        before: existing ? fields(existing) : null,
        after: fields(saved!),
      });
      return view(saved!);
    });
    return c.json({ settings });
  });

  return r as unknown as Hono<AppEnv>;
}
