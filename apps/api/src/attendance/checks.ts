import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { and, eq, ne } from 'drizzle-orm';
import {
  ATTENDANCE_TZ,
  MIN_FACE_WIDTH_PX,
  checkBodySchema,
  decideCheck,
  distanceMeters,
  lateMinutes,
  matchBodySchema,
  newId,
  workDate,
  type CheckBody,
} from '@sitediary/shared';
import { writeAudit } from '../audit/audit';
import type { AppEnv } from '../auth/session';
import type { Config } from '../config';
import { attendanceEntries, attendanceSettings, projects } from '../db/schema';
import { isUniqueViolation } from '../db/errors';
import type { AppTx } from '../db/tenant';
import { parseBody } from '../http/body';
import { AppError } from '../http/errors';
import { requireCap, runInTenant, type Tenant, type TenantEnv } from '../tenant/context';
import type { FaceEngine, FaceReading } from './face/engine';
import { framesAgree, hasDuplicateFrames } from './face/frames';
import { decryptTemplate } from './face/template';
import { ipBackstop, memberLimit } from './limits';
import { canSeeProject } from './reach';
import { approvedTemplate, faceStatus } from './registration';

const CHECK_LIMIT = { max: 10, windowMs: 60_000 };
const MATCH_LIMIT = { max: 30, windowMs: 60_000 };
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new AppError(404, 'not_found', 'Not found.');
const notSetUp = () =>
  new AppError(409, 'attendance_not_set_up', 'Attendance is not set up for this project yet.');
const notRegistered = () =>
  new AppError(
    409,
    'face_not_registered',
    'Register your face and wait for approval before checking in.',
  );
const registerAgain = () => new AppError(409, 'face_not_registered', 'Register your face again.');

/** The approved template; one that no longer decrypts (key rotated, row damaged) means register again. */
function openTemplate(blob: Buffer, key: Buffer): number[] {
  try {
    return decryptTemplate(blob, key);
  } catch {
    throw registerAgain();
  }
}
const checkInFirst = () => new AppError(409, 'check_in_first', 'Check in first.');
const already = (kind: CheckBody['kind']) =>
  kind === 'check_in'
    ? new AppError(409, 'already_checked_in', 'You have already checked in today.')
    : new AppError(409, 'already_checked_out', 'You have already checked out today.');

const limitBody = () =>
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: () => {
      throw new AppError(413, 'too_large', 'Upload is too large.');
    },
  });

type Settings = typeof attendanceSettings.$inferSelect;

async function loadSettings(tx: AppTx, t: Tenant, projectId: string): Promise<Settings | null> {
  const [s] = await tx
    .select()
    .from(attendanceSettings)
    .where(
      and(
        eq(attendanceSettings.companyId, t.companyId),
        eq(attendanceSettings.projectId, projectId),
      ),
    );
  return s ?? null;
}

/** The caller's non-rejected entries for a work date (one per kind, by the partial unique index). */
async function dayEntries(tx: AppTx, t: Tenant, date: string) {
  return tx
    .select()
    .from(attendanceEntries)
    .where(
      and(
        eq(attendanceEntries.companyId, t.companyId),
        eq(attendanceEntries.membershipId, t.membershipId),
        eq(attendanceEntries.workDate, date),
        ne(attendanceEntries.status, 'rejected'),
      ),
    );
}

/** 409 when this kind is already on record today, or a check-out has no check-in. */
async function assertCanCheck(tx: AppTx, t: Tenant, date: string, kind: CheckBody['kind']) {
  const list = await dayEntries(tx, t, date);
  if (list.some((e) => e.kind === kind)) throw already(kind);
  if (kind === 'check_out' && !list.some((e) => e.kind === 'check_in')) throw checkInFirst();
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/**
 * Combines the frame readings into the face signals `decideCheck` takes. Anti-spoof and
 * liveness are the LOWEST frame's, so one spoofed frame among live ones fails; the frames
 * must also be one person and must not be replays of one photo.
 */
function faceSignals(
  jpegs: Buffer[],
  readings: FaceReading[],
  template: number[],
  engine: FaceEngine,
) {
  // Any frame without exactly one face decides the count, so 0 and 2+ both fail.
  const odd = readings.find((r) => r.faces !== 1);
  const sims = readings.flatMap((r) =>
    r.embedding ? [engine.similarity(r.embedding, template)] : [],
  );
  return {
    faces: odd ? odd.faces : 1,
    minFaceWidth: Math.min(...readings.map((r) => r.minFaceWidth)),
    similarity: median(sims),
    real: Math.min(...readings.map((r) => r.real)),
    live: Math.min(...readings.map((r) => r.live)),
    framesAgree: framesAgree(readings, engine),
    framesDistinct: !hasDuplicateFrames(jpegs),
  };
}

const entryView = (e: typeof attendanceEntries.$inferSelect) => ({
  status: e.status,
  at: e.at,
  distanceM: e.distanceM,
  lateMin: e.lateMin,
  reasons: e.reasons,
});

export type CheckDeps = { config: Config; faceEngine: FaceEngine };

/** `/match`, `/check` and `/today`: the server-side check-in decision. Mounted under the attendance router. */
export function checkRoutes({ config, faceEngine }: CheckDeps): Hono<AppEnv> {
  const r = new Hono<TenantEnv>();
  const thresholds = config.faceThresholds;
  const perIp = ipBackstop();

  r.post(
    '/match',
    perIp,
    memberLimit(MATCH_LIMIT),
    requireCap('attendance.view'),
    limitBody(),
    async (c) => {
      const body = await parseBody(c, matchBodySchema);
      const t = c.get('tenant');
      const blob = await runInTenant(c, (tx) => approvedTemplate(tx, t));
      if (!blob) throw notRegistered();
      const template = openTemplate(blob, config.faceTemplateKey);
      const reading = await faceEngine.read(Buffer.from(body.frame, 'base64'));
      // The same face gate as /check: one face, wide enough to read.
      const clear =
        reading.faces === 1 && reading.minFaceWidth >= MIN_FACE_WIDTH_PX && reading.embedding;
      const matched =
        !!clear && faceEngine.similarity(reading.embedding!, template) >= thresholds.minSimilarity;
      return c.json({ matched });
    },
  );

  r.post(
    '/check',
    perIp,
    memberLimit(CHECK_LIMIT),
    requireCap('attendance.view'),
    limitBody(),
    async (c) => {
      const body = await parseBody(c, checkBodySchema);
      const t = c.get('tenant');
      // One clock reading per request: `at`, the work date and lateness all agree.
      const now = new Date();
      const pre = await runInTenant(c, async (tx) => {
        if (!(await canSeeProject(tx, t, body.projectId))) throw notFound();
        const [project] = await tx
          .select({ name: projects.name })
          .from(projects)
          .where(and(eq(projects.companyId, t.companyId), eq(projects.id, body.projectId)));
        const settings = await loadSettings(tx, t, body.projectId);
        if (!settings) throw notSetUp();
        const blob = await approvedTemplate(tx, t);
        if (!blob) throw notRegistered();
        const date = workDate(now, settings.timezone);
        await assertCanCheck(tx, t, date, body.kind);
        return { projectName: project!.name, settings, blob, date };
      });
      const { settings, date } = pre;
      const template = openTemplate(pre.blob, config.faceTemplateKey);

      const jpegs = body.frames.map((f) => Buffer.from(f, 'base64'));
      const readings: FaceReading[] = [];
      for (const jpeg of jpegs) readings.push(await faceEngine.read(jpeg));
      const face = faceSignals(jpegs, readings, template, faceEngine);
      const distanceM = distanceMeters(body, settings);
      const decision = decideCheck(
        { distanceM, radiusM: settings.radiusM, accuracyM: body.accuracyM, ...face },
        thresholds,
      );
      if (decision.status === 'pending') {
        // Scores only (no images or names), so thresholds can be tuned from real phones.
        console.warn(
          `Check ${body.kind} pending: ${decision.reasons.join('; ')} | faces=${face.faces} ` +
            `w=${face.minFaceWidth} sim=${face.similarity} real=${face.real} live=${face.live} ` +
            `agree=${face.framesAgree} distinct=${face.framesDistinct}`,
        );
      }
      const lateMin =
        body.kind === 'check_in'
          ? lateMinutes(now, settings.startTime, settings.lateAfterMin, settings.timezone)
          : 0;

      const id = newId();
      try {
        await runInTenant(c, async (tx) => {
          // Re-check: another request may have recorded (or a reviewer rejected) since.
          await assertCanCheck(tx, t, date, body.kind);
          await tx.insert(attendanceEntries).values({
            id,
            companyId: t.companyId,
            membershipId: t.membershipId,
            projectId: body.projectId,
            workDate: date,
            kind: body.kind,
            at: now,
            lat: body.lat,
            lng: body.lng,
            accuracyM: body.accuracyM,
            distanceM,
            similarity: face.similarity,
            real: face.real >= thresholds.minLiveness,
            live: face.live >= thresholds.minLiveness,
            status: decision.status,
            reasons: decision.reasons,
            lateMin,
            evidence: decision.status === 'pending' ? jpegs : null,
            createdBy: t.userId,
            updatedBy: t.userId,
          });
          await writeAudit(tx, t, {
            action: body.kind === 'check_in' ? 'attendance.checked_in' : 'attendance.checked_out',
            entity: 'attendance_entry',
            entityId: id,
            before: null,
            after: {
              projectId: body.projectId,
              workDate: date,
              kind: body.kind,
              status: decision.status,
              reasons: decision.reasons,
              distanceM,
              accuracyM: body.accuracyM,
              similarity: face.similarity,
              lateMin,
            },
          });
        });
      } catch (err) {
        // The partial unique index is the race-safe guard: a concurrent twin loses here.
        if (isUniqueViolation(err, 'attendance_entries_one_per_day')) throw already(body.kind);
        throw err;
      }
      return c.json({
        id,
        kind: body.kind,
        status: decision.status,
        reasons: decision.reasons,
        at: now,
        workDate: date,
        distanceM,
        lateMin,
        projectName: pre.projectName,
      });
    },
  );

  r.get('/today', requireCap('attendance.view'), async (c) => {
    const projectId = (c.req.query('projectId') ?? '').toLowerCase();
    if (!UUID_RE.test(projectId)) throw notFound();
    const t = c.get('tenant');
    const now = new Date();
    const out = await runInTenant(c, async (tx) => {
      if (!(await canSeeProject(tx, t, projectId))) throw notFound();
      const settings = await loadSettings(tx, t, projectId);
      const date = workDate(now, settings?.timezone ?? ATTENDANCE_TZ);
      const list = await dayEntries(tx, t, date);
      const checkIn = list.find((e) => e.kind === 'check_in');
      const checkOut = list.find((e) => e.kind === 'check_out');
      return {
        setUp: settings !== null,
        face: await faceStatus(tx, t),
        checkIn: checkIn ? entryView(checkIn) : null,
        checkOut: checkOut ? entryView(checkOut) : null,
      };
    });
    return c.json(out);
  });

  return r as unknown as Hono<AppEnv>;
}
