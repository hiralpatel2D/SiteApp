import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { newId } from '@sitediary/shared';
import { createCompany } from '../src/companies/create-company';
import {
  attendanceEntries,
  attendanceSettings,
  auditLog,
  faceRegistrations,
  projectAssignments,
  projects,
} from '../src/db/schema';
import { createFakeEngine } from '../src/attendance/face/fake';
import { encryptTemplate } from '../src/attendance/face/template';
import { ownerDb, useTestDb } from './helpers/db';
import { req, seedMember, testApp } from './helpers/auth';

useTestDb();

type ErrorBody = { error: { code: string; message: string } };
const errorOf = async (r: Response) => ((await r.json()) as ErrorBody).error;

const EMBEDDING = Array.from({ length: 1024 }, () => 1 / 32);
const GOOD = { faces: 1, minFaceWidth: 320, embedding: EMBEDDING, real: 0.95, live: 0.95 };
const frame = (n: number) => Buffer.from([n, n, n, n]).toString('base64');
const SITE = { lat: 19.07, lng: 72.87 };
const EARLY = new Date('2026-10-16T03:25:00Z');

type Pending = {
  id: string;
  name: string;
  projectName: string;
  kind: string;
  reasons: string[];
  siteLat: number;
  siteLng: number;
  radiusM: number;
  photos: string[];
};

async function setup() {
  const co = await createCompany(ownerDb, { name: 'Alpha Builders', slug: 'alpha' });
  const faceEngine = createFakeEngine((jpeg) => ({ ...GOOD, real: jpeg[0]! === 9 ? 0.1 : 0.95 }));
  const { deps } = testApp();
  const app = (await import('../src/app')).createApp({ ...deps, faceEngine });
  const worker = await seedMember(co.companyId, 'site_engineer', 'w@alpha.test', { app });
  const coord = await seedMember(co.companyId, 'coordinator', 'c@alpha.test', { app });
  const p1 = newId();
  const p2 = newId();
  await ownerDb.insert(projects).values([
    { id: p1, companyId: co.companyId, name: 'Tower', code: 'T1' },
    { id: p2, companyId: co.companyId, name: 'Bridge', code: 'B1' },
  ]);
  await ownerDb.insert(projectAssignments).values([
    { id: newId(), companyId: co.companyId, membershipId: worker.membershipId, projectId: p1 },
    { id: newId(), companyId: co.companyId, membershipId: coord.membershipId, projectId: p1 },
    { id: newId(), companyId: co.companyId, membershipId: worker.membershipId, projectId: p2 },
  ]);
  for (const projectId of [p1, p2]) {
    await ownerDb.insert(attendanceSettings).values({
      id: newId(),
      companyId: co.companyId,
      projectId,
      ...SITE,
      radiusM: 100,
      startTime: '09:00',
      lateAfterMin: 15,
      reminderTime: '19:00',
    });
  }
  await ownerDb.insert(faceRegistrations).values({
    id: newId(),
    companyId: co.companyId,
    membershipId: worker.membershipId,
    status: 'approved',
    template: encryptTemplate(EMBEDDING, deps.config.faceTemplateKey),
    modelVersion: 'fake',
    consentAt: new Date(),
  });
  return { co, app, worker, coord, p1, p2 };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

async function pendingEntry(
  ctx: Ctx,
  over: { membershipId?: string; projectId?: string; at?: Date; kind?: string } = {},
) {
  const id = newId();
  await ownerDb.insert(attendanceEntries).values({
    id,
    companyId: ctx.co.companyId,
    membershipId: over.membershipId ?? ctx.worker.membershipId,
    projectId: over.projectId ?? ctx.p1,
    workDate: '2026-10-16',
    kind: over.kind ?? 'check_in',
    at: over.at ?? EARLY,
    ...SITE,
    accuracyM: 12,
    distanceM: 250,
    similarity: 0.9,
    real: true,
    live: true,
    status: 'pending',
    reasons: ['outside_radius'],
    evidence: [Buffer.from([1, 2, 3])],
  });
  return id;
}

const asCoord = (ctx: Ctx, path: string, method = 'GET', body?: unknown) =>
  req(ctx.app, `/api/attendance${path}`, {
    cookie: ctx.coord.cookie,
    company: ctx.co.companyId,
    method,
    body,
  });
const asWorker = (ctx: Ctx, path: string, method = 'GET', body?: unknown) =>
  req(ctx.app, `/api/attendance${path}`, {
    cookie: ctx.worker.cookie,
    company: ctx.co.companyId,
    method,
    body,
  });
const list = async (ctx: Ctx) =>
  ((await (await asCoord(ctx, '/pending')).json()) as { pending: Pending[] }).pending;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(EARLY);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('attendance pending review', () => {
  it('lists pending entries on visible projects with photos, and approval shows in today', async () => {
    const ctx = await setup();
    const id = await pendingEntry(ctx);
    const rows = await list(ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id,
      name: 'w',
      projectName: 'Tower',
      kind: 'check_in',
      reasons: ['outside_radius'],
      siteLat: SITE.lat,
      siteLng: SITE.lng,
      radiusM: 100,
    });
    expect(rows[0]!.photos).toEqual([
      `data:image/jpeg;base64,${Buffer.from([1, 2, 3]).toString('base64')}`,
    ]);

    const res = await asCoord(ctx, `/pending/${id}/approve`, 'POST', { note: 'Seen on site' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'approved' });
    expect(await list(ctx)).toHaveLength(0);

    const t = (await (await asWorker(ctx, `/today?projectId=${ctx.p1}`)).json()) as {
      checkIn: { status: string };
    };
    expect(t.checkIn.status).toBe('approved');
    const [row] = await ownerDb
      .select()
      .from(attendanceEntries)
      .where(eq(attendanceEntries.id, id));
    expect(row).toMatchObject({
      status: 'approved',
      reviewedBy: ctx.coord.userId,
      reviewNote: 'Seen on site',
    });
    expect(row!.reviewedAt).toBeInstanceOf(Date);
    expect(row!.evidence).not.toBeNull();
    const [a] = await ownerDb
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'attendance.approved'));
    expect(a!.entityId).toBe(id);
    expect(a!.before).toEqual({ status: 'pending' });
    expect(a!.after).toEqual({ status: 'approved', note: 'Seen on site' });
    expect(JSON.stringify(a)).not.toContain('AQID');
  });

  it('hides entries on non-visible projects and gives 404 on decision', async () => {
    const ctx = await setup();
    const hidden = await pendingEntry(ctx, { projectId: ctx.p2 });
    expect(await list(ctx)).toHaveLength(0);
    for (const action of ['approve', 'reject']) {
      const res = await asCoord(ctx, `/pending/${hidden}/${action}`, 'POST', {});
      expect(res.status).toBe(404);
    }
    expect((await asCoord(ctx, '/pending/not-a-uuid/approve', 'POST', {})).status).toBe(404);
  });

  it('excludes own entries from the list and forbids self-decision', async () => {
    const ctx = await setup();
    const own = await pendingEntry(ctx, { membershipId: ctx.coord.membershipId });
    expect(await list(ctx)).toHaveLength(0);
    const res = await asCoord(ctx, `/pending/${own}/approve`, 'POST', {});
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('forbidden');
  });

  it('requires the review capability', async () => {
    const ctx = await setup();
    expect((await asWorker(ctx, '/pending')).status).toBe(403);
  });

  it('gives 409 already_decided on a second decision', async () => {
    const ctx = await setup();
    const id = await pendingEntry(ctx);
    expect((await asCoord(ctx, `/pending/${id}/approve`, 'POST', {})).status).toBe(200);
    for (const action of ['approve', 'reject']) {
      const res = await asCoord(ctx, `/pending/${id}/${action}`, 'POST', {});
      expect(res.status).toBe(409);
      expect(await errorOf(res)).toEqual({
        code: 'already_decided',
        message: 'This entry has already been decided.',
      });
    }
  });

  it('rejecting lets the person check in again', async () => {
    const ctx = await setup();
    const checkBody = {
      projectId: ctx.p1,
      kind: 'check_in',
      lat: 19.08,
      ...{ lng: SITE.lng },
      accuracyM: 12,
      frames: [1, 2, 3].map(frame),
    };
    const first = await asWorker(ctx, '/check', 'POST', checkBody);
    const firstBody = (await first.json()) as { id: string; status: string };
    expect(firstBody.status).toBe('pending');
    expect((await asWorker(ctx, '/check', 'POST', checkBody)).status).toBe(409);

    const rej = await asCoord(ctx, `/pending/${firstBody.id}/reject`, 'POST', { note: 'No' });
    expect(rej.status).toBe(200);
    expect(await rej.json()).toEqual({ status: 'rejected' });
    const [a] = await ownerDb
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'attendance.rejected'));
    expect(a!.after).toEqual({ status: 'rejected', note: 'No' });

    const again = await asWorker(ctx, '/check', 'POST', { ...checkBody, lat: SITE.lat });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { status: string }).status).toBe('recorded');
  });

  it('lists oldest first', async () => {
    const ctx = await setup();
    const late = await pendingEntry(ctx, { at: new Date('2026-10-16T04:00:00Z') });
    const early = await pendingEntry(ctx, {
      at: new Date('2026-10-16T03:00:00Z'),
      kind: 'check_out',
    });
    expect((await list(ctx)).map((r) => r.id)).toEqual([early, late]);
  });
});
