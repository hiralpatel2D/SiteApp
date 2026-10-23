import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { newId } from '@sitediary/shared';
import { createCompany } from '../src/companies/create-company';
import {
  attendanceEntries,
  attendanceSettings,
  auditLog,
  faceRegistrations,
  memberships,
  projectAssignments,
  projects,
} from '../src/db/schema';
import { createFakeEngine, FAKE_EMBEDDING, fakeEmbedding } from '../src/attendance/face/fake';
import { encryptTemplate } from '../src/attendance/face/template';
import ExcelJS from 'exceljs';
import { ownerDb, useTestDb } from './helpers/db';
import { req, seedMember, testApp } from './helpers/auth';

useTestDb();

type ErrorBody = { error: { code: string; message: string } };
const errorOf = async (r: Response) => ((await r.json()) as ErrorBody).error;

const EMBEDDING = [...FAKE_EMBEDDING];
const GOOD = { faces: 1, minFaceWidth: 320, real: 0.95, live: 0.95 };
const frame = (n: number) => Buffer.from([n, n, n, n]).toString('base64');
const SITE = { lat: 19.07, lng: 72.87 };
const EARLY = new Date('2026-10-16T03:25:00Z');

type Pending = {
  own: boolean;
  canDecide: boolean;
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
  const faceEngine = createFakeEngine((jpeg) => ({
    ...GOOD,
    embedding: fakeEmbedding(jpeg),
    real: jpeg[0]! === 9 ? 0.1 : 0.95,
  }));
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
  ((await (await asCoord(ctx, '/pending')).json()) as { entries: Pending[] }).entries;

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
    expect(a!.after).toEqual({ status: 'approved', note: 'Seen on site', selfDecided: false });
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

  it('lists your own entry and lets the only reviewer decide it, audited', async () => {
    const ctx = await setup();
    const own = await pendingEntry(ctx, { membershipId: ctx.coord.membershipId });
    const rows = await list(ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: own, own: true, canDecide: true });
    const res = await asCoord(ctx, `/pending/${own}/approve`, 'POST', {});
    expect(res.status).toBe(200);
    const [a] = await ownerDb
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'attendance.approved'));
    expect(a!.after).toMatchObject({ selfDecided: true });
  });

  it('lists your own entry but forbids self-decision while another reviewer exists', async () => {
    const ctx = await setup();
    await seedMember(ctx.co.companyId, 'coordinator', 'c2@alpha.test', { app: ctx.app });
    const own = await pendingEntry(ctx, { membershipId: ctx.coord.membershipId });
    const rows = await list(ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: own, own: true, canDecide: false });
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
    expect(a!.after).toEqual({ status: 'rejected', note: 'No', selfDecided: false });

    const again = await asWorker(ctx, '/check', 'POST', { ...checkBody, lat: SITE.lat });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { status: string }).status).toBe('recorded');
  });

  it('caps the list at 50 and reports the total', async () => {
    const ctx = await setup();
    const rows = Array.from({ length: 51 }, (_, i) => ({
      id: newId(),
      companyId: ctx.co.companyId,
      membershipId: ctx.worker.membershipId,
      projectId: ctx.p1,
      workDate: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
      kind: 'check_in',
      at: new Date(EARLY.getTime() + i * 1000),
      ...SITE,
      accuracyM: 12,
      distanceM: 250,
      real: true,
      live: true,
      status: 'pending',
      reasons: ['outside_radius'],
    }));
    await ownerDb.insert(attendanceEntries).values(rows);
    const body = (await (await asCoord(ctx, '/pending')).json()) as {
      entries: Pending[];
      total: number;
    };
    expect(body.entries).toHaveLength(50);
    expect(body.total).toBe(51);
    expect(body.entries[0]!.id).toBe(rows[0]!.id);
  });

  it('treats entries of deactivated members as not found', async () => {
    const ctx = await setup();
    const id = await pendingEntry(ctx);
    await ownerDb
      .update(memberships)
      .set({ status: 'deactivated' })
      .where(eq(memberships.id, ctx.worker.membershipId));
    expect(await list(ctx)).toHaveLength(0);
    expect((await asCoord(ctx, `/pending/${id}/approve`, 'POST', {})).status).toBe(404);
  });

  it('lets a projects.all reviewer see unassigned projects', async () => {
    const ctx = await setup();
    const admin = await seedMember(ctx.co.companyId, 'admin', 'a@alpha.test', { app: ctx.app });
    const id = await pendingEntry(ctx, { projectId: ctx.p2 });
    const res = await req(ctx.app, '/api/attendance/pending', {
      cookie: admin.cookie,
      company: ctx.co.companyId,
    });
    const body = (await res.json()) as { entries: Pending[]; total: number };
    expect(body.entries.map((e) => e.id)).toEqual([id]);
    expect(body.total).toBe(1);
  });

  it('never lists or decides another company entry', async () => {
    const ctx = await setup();
    const other = await createCompany(ownerDb, { name: 'Bravo', slug: 'bravo' });
    const ow = await seedMember(other.companyId, 'site_engineer', 'w@bravo.test');
    const op = newId();
    await ownerDb
      .insert(projects)
      .values({ id: op, companyId: other.companyId, name: 'Elsewhere', code: 'E1' });
    await ownerDb.insert(attendanceSettings).values({
      id: newId(),
      companyId: other.companyId,
      projectId: op,
      ...SITE,
      radiusM: 100,
      startTime: '09:00',
      lateAfterMin: 15,
      reminderTime: '19:00',
    });
    const id = newId();
    await ownerDb.insert(attendanceEntries).values({
      id,
      companyId: other.companyId,
      membershipId: ow.membershipId,
      projectId: op,
      workDate: '2026-10-16',
      kind: 'check_in',
      at: EARLY,
      ...SITE,
      accuracyM: 12,
      distanceM: 250,
      real: true,
      live: true,
      status: 'pending',
      reasons: ['outside_radius'],
    });
    expect(await list(ctx)).toHaveLength(0);
    expect((await asCoord(ctx, `/pending/${id}/approve`, 'POST', {})).status).toBe(404);
  });

  it('persists the reject note', async () => {
    const ctx = await setup();
    const id = await pendingEntry(ctx);
    await asCoord(ctx, `/pending/${id}/reject`, 'POST', { note: 'Wrong site' });
    const [row] = await ownerDb
      .select()
      .from(attendanceEntries)
      .where(eq(attendanceEntries.id, id));
    expect(row).toMatchObject({ status: 'rejected', reviewNote: 'Wrong site' });
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

  describe('attendance log', () => {
    type Log = {
      scope: string;
      entries: { id: string; name: string; own: boolean; status: string; workDate: string }[];
    };
    const range = '&from=2026-10-01&to=2026-10-31';

    it('my log lists only my entries, with every status', async () => {
      const ctx = await setup();
      const mine = await pendingEntry(ctx);
      await pendingEntry(ctx, { membershipId: ctx.coord.membershipId });
      const res = await asWorker(ctx, `/log?projectId=${ctx.p1}${range}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Log;
      expect(body.scope).toBe('me');
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0]).toMatchObject({ id: mine, own: true, status: 'pending', name: 'w' });
    });

    it('team log lists everyone on the project for a reviewer, and is 403 for others', async () => {
      const ctx = await setup();
      await pendingEntry(ctx);
      await pendingEntry(ctx, { membershipId: ctx.coord.membershipId });
      const body = (await (
        await asCoord(ctx, `/log?projectId=${ctx.p1}${range}&scope=team`)
      ).json()) as Log;
      expect(body.scope).toBe('team');
      expect(body.entries).toHaveLength(2);
      expect(body.entries.filter((e) => e.own)).toHaveLength(1);
      const res = await asWorker(ctx, `/log?projectId=${ctx.p1}${range}&scope=team`);
      expect(res.status).toBe(403);
    });

    it('is limited to the dates asked for and to visible projects', async () => {
      const ctx = await setup();
      await pendingEntry(ctx);
      const other = (await (
        await asWorker(ctx, `/log?projectId=${ctx.p1}&from=2026-09-01&to=2026-09-30`)
      ).json()) as Log;
      expect(other.entries).toHaveLength(0);
      expect((await asCoord(ctx, `/log?projectId=${ctx.p2}${range}`)).status).toBe(404);
    });

    it('rejects a bad or oversized date range with 400', async () => {
      const ctx = await setup();
      for (const q of [
        '&from=2026-10-31&to=2026-10-01',
        '&from=2026-01-01&to=2026-12-31',
        '&from=nope&to=2026-10-01',
      ]) {
        const res = await asWorker(ctx, `/log?projectId=${ctx.p1}${q}`);
        expect(res.status).toBe(400);
        expect((await errorOf(res)).code).toBe('bad_range');
      }
    });
  });

  describe('monthly summary and export', () => {
    type Sum = {
      projectName: string;
      people: { name: string; present: number; pending: number }[];
    };

    it('summary needs the review capability and counts a pending check-in', async () => {
      const ctx = await setup();
      await pendingEntry(ctx);
      const res = await asCoord(ctx, `/summary?projectId=${ctx.p1}&month=2026-10`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Sum;
      expect(body.projectName).toBe('Tower');
      const w = body.people.find((p) => p.name === 'w');
      expect(w).toMatchObject({ present: 0, pending: 1 });
      expect((await asWorker(ctx, `/summary?projectId=${ctx.p1}&month=2026-10`)).status).toBe(403);
    });

    it('rejects a bad month and a project the person cannot see', async () => {
      const ctx = await setup();
      const bad = await asCoord(ctx, `/summary?projectId=${ctx.p1}&month=2026-99`);
      expect(bad.status).toBe(400);
      expect((await errorOf(bad)).code).toBe('bad_month');
      expect((await asCoord(ctx, `/summary?projectId=${ctx.p2}&month=2026-10`)).status).toBe(404);
    });

    it('export gives a real .xlsx with Summary, Daily and Entries, and is audited', async () => {
      const ctx = await setup();
      await pendingEntry(ctx);
      const admin = await seedMember(ctx.co.companyId, 'admin', 'admin@alpha.test', {
        app: ctx.app,
      });
      const res = await req(ctx.app, `/api/attendance/export?projectId=${ctx.p1}&month=2026-10`, {
        cookie: admin.cookie,
        company: ctx.co.companyId,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('spreadsheetml.sheet');
      expect(res.headers.get('content-disposition')).toBe(
        'attachment; filename="attendance-Tower-2026-10.xlsx"',
      );
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as unknown as ArrayBuffer);
      expect(wb.worksheets.map((w) => w.name)).toEqual(['Summary', 'Daily', 'Entries']);
      const entries = wb.getWorksheet('Entries')!;
      expect(entries.getRow(2).getCell(2).value).toBe('w');
      expect(entries.getRow(2).getCell(5).value).toBe('pending');
      const summary = wb.getWorksheet('Summary')!;
      const names: unknown[] = [];
      summary.eachRow((row) => names.push(row.getCell(1).value));
      expect(names).toContain('w');
      const [audit] = await ownerDb
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, 'attendance.exported'));
      expect(audit!.entityId).toBe(ctx.p1);
    });

    it('export is forbidden without attendance.export (a coordinator has review only)', async () => {
      const ctx = await setup();
      const res = await asCoord(ctx, `/export?projectId=${ctx.p1}&month=2026-10`);
      expect(res.status).toBe(403);
    });
  });
});
