import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { eq, like } from 'drizzle-orm';
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
import { createFakeEngine, FAKE_EMBEDDING, fakeEmbedding } from '../src/attendance/face/fake';
import { encryptTemplate } from '../src/attendance/face/template';
import type { FaceReading } from '../src/attendance/face/types';
import type { Config } from '../src/config';
import { ownerDb, truncateAll, useTestDb } from './helpers/db';
import { req, seedMember, testApp } from './helpers/auth';

useTestDb();

type ErrorBody = { error: { code: string; message: string } };
const errorOf = async (r: Response) => ((await r.json()) as ErrorBody).error;

// The registered template; each frame reads as this person with its own jitter (fakeEmbedding).
const EMBEDDING = [...FAKE_EMBEDDING];
/** Someone else, jittered per frame like a live person. */
const stranger = (n: number) => fakeEmbedding(Buffer.from([n])).map((v) => v + 0.5);
/** The registered person, `k` times further from the template than a normal frame. */
const further = (n: number, k: number) =>
  fakeEmbedding(Buffer.from([n])).map((v, i) => EMBEDDING[i]! + k * (v - EMBEDDING[i]!));
const GOOD: Omit<FaceReading, 'embedding' | 'thumb'> = {
  faces: 1,
  minFaceWidth: 320,
  real: 0.95,
  live: 0.95,
};

// Frame n is the byte n repeated; the fake engine reads its first byte.
const frame = (n: number) => Buffer.from([n, n, n, n]).toString('base64');
const frames = (start = 1) => [0, 1, 2].map((i) => frame(start + i));

const SITE = { lat: 19.07, lng: 72.87 };
// 08:55 IST on 2026-10-16.
const EARLY = new Date('2026-10-16T03:25:00Z');

async function setup(
  opts: {
    readings?: Record<number, Partial<FaceReading>>;
    settings?: boolean;
    face?: boolean;
    gateReads?: number;
    /** Store the approved template under another key (it will not decrypt). */
    badTemplate?: boolean;
    config?: Partial<Config>;
  } = {},
) {
  const co = await createCompany(ownerDb, { name: 'Alpha Builders', slug: 'alpha' });
  const other = await createCompany(ownerDb, { name: 'Bravo', slug: 'bravo' });
  const readings = opts.readings ?? {};
  const base = createFakeEngine((jpeg) => ({
    ...GOOD,
    embedding: fakeEmbedding(jpeg),
    ...readings[jpeg[0]!],
  }));
  // With gateReads set, the last frame read of each request waits until that many requests reach it.
  let started = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const faceEngine = {
    ...base,
    async read(jpeg: Buffer) {
      if ((opts.gateReads ?? 0) > 0 && (jpeg[0] === 3 || jpeg[0] === 12)) {
        if (++started >= opts.gateReads!) open();
        await gate;
      }
      return base.read(jpeg);
    },
  };
  const { deps } = testApp({ config: opts.config });
  const app = (await import('../src/app')).createApp({ ...deps, faceEngine });
  const worker = await seedMember(co.companyId, 'site_engineer', 'w@alpha.test', { app });
  const mate = await seedMember(co.companyId, 'site_engineer', 'm@alpha.test', { app });
  const p1 = newId();
  const p2 = newId();
  const foreign = newId();
  await ownerDb.insert(projects).values([
    { id: p1, companyId: co.companyId, name: 'Tower', code: 'T1' },
    { id: p2, companyId: co.companyId, name: 'Bridge', code: 'B1' },
    { id: foreign, companyId: other.companyId, name: 'Elsewhere', code: 'E1' },
  ]);
  await ownerDb.insert(projectAssignments).values(
    [worker, mate].map((m) => ({
      id: newId(),
      companyId: co.companyId,
      membershipId: m.membershipId,
      projectId: p1,
    })),
  );
  if (opts.settings !== false) {
    for (const [companyId, projectId] of [
      [co.companyId, p1],
      [co.companyId, p2],
      [other.companyId, foreign],
    ] as const) {
      await ownerDb.insert(attendanceSettings).values({
        id: newId(),
        companyId,
        projectId,
        ...SITE,
        radiusM: 100,
        startTime: '09:00',
        lateAfterMin: 15,
        reminderTime: '19:00',
      });
    }
  }
  if (opts.face !== false) {
    const key = opts.badTemplate ? Buffer.alloc(32, 7) : deps.config.faceTemplateKey;
    await ownerDb.insert(faceRegistrations).values(
      [worker, mate].map((m) => ({
        id: newId(),
        companyId: co.companyId,
        membershipId: m.membershipId,
        status: 'approved',
        template: encryptTemplate(EMBEDDING, key),
        modelVersion: 'fake',
        consentAt: new Date(),
      })),
    );
  }
  return { co, app, worker, mate, p1, p2, foreign };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

type CheckResult = {
  id: string;
  kind: string;
  status: string;
  reasons: string[];
  at: string;
  workDate: string;
  distanceM: number;
  lateMin: number;
  projectName: string;
};
type Entry = { status: string; at: string; distanceM: number; lateMin: number; reasons: string[] };
type Today = { setUp: boolean; face: string; checkIn: Entry | null; checkOut: Entry | null };

const call = (
  ctx: Ctx,
  path: string,
  method = 'GET',
  body?: unknown,
  as: { cookie?: string; ip?: string } = ctx.worker,
) =>
  req(ctx.app, `/api/attendance${path}`, {
    cookie: as.cookie,
    company: ctx.co.companyId,
    method,
    body,
    ip: as.ip,
  });
const check = (ctx: Ctx, kind: 'check_in' | 'check_out', over: Record<string, unknown> = {}) =>
  call(ctx, '/check', 'POST', {
    projectId: ctx.p1,
    kind,
    ...SITE,
    accuracyM: 12,
    frames: frames(),
    ...over,
  });
const today = async (ctx: Ctx, projectId = ctx.p1) =>
  (await (await call(ctx, `/today?projectId=${projectId}`)).json()) as Today;
const entries = () => ownerDb.select().from(attendanceEntries);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(EARLY);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('attendance check-in / check-out', () => {
  it('records a check-in when every check passes, without evidence, and audits', async () => {
    const ctx = await setup();
    const res = await check(ctx, 'check_in');
    expect(res.status).toBe(200);
    const body = (await res.json()) as CheckResult;
    expect(body).toMatchObject({
      kind: 'check_in',
      status: 'recorded',
      reasons: [],
      workDate: '2026-10-16',
      lateMin: 0,
      projectName: 'Tower',
    });
    expect(body.at).toBe(EARLY.toISOString());
    expect(body.distanceM).toBeLessThan(1);
    const t = await today(ctx);
    expect(t.setUp).toBe(true);
    expect(t.face).toBe('approved');
    expect(t.checkIn?.status).toBe('recorded');
    expect(t.checkOut).toBeNull();
    const [row] = await entries();
    expect(row!.id).toBe(body.id);
    expect(row!.evidence).toBeNull();
    expect(row!.similarity).toBe(1);
    expect(row!.real).toBe(true);
    expect(row!.live).toBe(true);
    const audits = await ownerDb
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'attendance.checked_in'));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.entityId).toBe(body.id);
    expect(JSON.stringify(audits[0])).not.toContain(frame(1));
  });

  it('outside the radius is pending with the radius reason and stores the evidence', async () => {
    const ctx = await setup();
    const res = await check(ctx, 'check_in', { lat: 19.08 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as CheckResult;
    expect(body.status).toBe('pending');
    expect(body.reasons).toHaveLength(1);
    expect(body.reasons[0]).toMatch(/^Outside site radius \(\d+ m, allowed 100 m\)$/);
    expect(body.distanceM).toBeGreaterThan(1000);
    const [row] = await entries();
    expect(row!.status).toBe('pending');
    expect(row!.evidence).toHaveLength(3);
    expect(row!.evidence!.map((b) => b.toString('base64'))).toEqual(frames());
    expect((await today(ctx)).checkIn?.status).toBe('pending');
  });

  it('stores binary JPEG evidence byte for byte (not UTF-8, with quotes, commas and NULs)', async () => {
    const ctx = await setup();
    // A JPEG's SOI marker, then bytes a Postgres array literal would mangle.
    const binary = [0, 1, 2].map((i) =>
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x22, 0x5c, 0x2c, 0x7b, 0x7d, 0x00, 0x80 + i]),
    );
    const res = await check(ctx, 'check_in', {
      lat: 19.08,
      frames: binary.map((b) => b.toString('base64')),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as CheckResult).status).toBe('pending');
    const [row] = await entries();
    expect(row!.evidence!.map((b) => b.toString('hex'))).toEqual(
      binary.map((b) => b.toString('hex')),
    );
  });

  it('check-out before check-in is check_in_first; duplicates are 409', async () => {
    const ctx = await setup();
    const early = await check(ctx, 'check_out');
    expect(early.status).toBe(409);
    expect(await errorOf(early)).toEqual({ code: 'check_in_first', message: 'Check in first.' });
    expect((await check(ctx, 'check_in')).status).toBe(200);
    const again = await check(ctx, 'check_in');
    expect(again.status).toBe(409);
    expect((await errorOf(again)).code).toBe('already_checked_in');
    const out = await check(ctx, 'check_out');
    expect(out.status).toBe(200);
    expect(((await out.json()) as CheckResult).kind).toBe('check_out');
    const out2 = await check(ctx, 'check_out');
    expect(out2.status).toBe(409);
    expect((await errorOf(out2)).code).toBe('already_checked_out');
    const t = await today(ctx);
    expect(t.checkOut?.status).toBe('recorded');
    const audits = await ownerDb
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'attendance.checked_out'));
    expect(audits).toHaveLength(1);
  });

  it('without settings is attendance_not_set_up', async () => {
    const ctx = await setup({ settings: false });
    const res = await check(ctx, 'check_in');
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toEqual({
      code: 'attendance_not_set_up',
      message: 'Attendance is not set up for this project yet.',
    });
    const t = await today(ctx);
    expect(t.setUp).toBe(false);
  });

  it('without an approved face is face_not_registered', async () => {
    const ctx = await setup({ face: false });
    const res = await check(ctx, 'check_in');
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('face_not_registered');
    expect((await today(ctx)).face).toBe('none');
    expect(await entries()).toHaveLength(0);
  });

  it('a 3 MB body is 413 too_large', async () => {
    const ctx = await setup();
    const big = Array.from({ length: 3 }, () => 'A'.repeat(1_000_000));
    const res = await check(ctx, 'check_in', { frames: big });
    expect(res.status).toBe(413);
    expect(await errorOf(res)).toEqual({ code: 'too_large', message: 'Upload is too large.' });
  });

  it('a check-in at 09:20 IST is 20 minutes late; check-out carries no lateness', async () => {
    const ctx = await setup();
    vi.setSystemTime(new Date('2026-10-16T03:50:00Z'));
    const res = (await (await check(ctx, 'check_in')).json()) as CheckResult;
    expect(res.lateMin).toBe(20);
    expect((await today(ctx)).checkIn?.lateMin).toBe(20);
    vi.setSystemTime(new Date('2026-10-16T12:30:00Z'));
    const out = (await (await check(ctx, 'check_out')).json()) as CheckResult;
    expect(out.lateMin).toBe(0);
    expect(out.workDate).toBe('2026-10-16');
  });

  it('after a reviewer rejects, the entry is hidden and a new check-in is allowed', async () => {
    const ctx = await setup();
    const first = (await (await check(ctx, 'check_in', { lat: 19.08 })).json()) as CheckResult;
    await ownerDb
      .update(attendanceEntries)
      .set({ status: 'rejected' })
      .where(eq(attendanceEntries.id, first.id));
    expect((await today(ctx)).checkIn).toBeNull();
    const out = await check(ctx, 'check_out');
    expect((await errorOf(out)).code).toBe('check_in_first');
    const res = await check(ctx, 'check_in');
    expect(res.status).toBe(200);
    expect(((await res.json()) as CheckResult).status).toBe('recorded');
    expect((await today(ctx)).checkIn?.status).toBe('recorded');
  });

  it("another company's project or an unassigned one is 404", async () => {
    const ctx = await setup();
    for (const projectId of [ctx.foreign, ctx.p2]) {
      const res = await check(ctx, 'check_in', { projectId });
      expect(res.status).toBe(404);
      expect((await call(ctx, `/today?projectId=${projectId}`)).status).toBe(404);
    }
    expect((await call(ctx, '/today?projectId=nope')).status).toBe(404);
    expect(await entries()).toHaveLength(0);
  });

  it('a frame with two faces is pending as Face not clear', async () => {
    const ctx = await setup({ readings: { 2: { faces: 2, embedding: null } } });
    const body = (await (await check(ctx, 'check_in')).json()) as CheckResult;
    expect(body.status).toBe('pending');
    expect(body.reasons).toEqual(['Face not clear']);
  });

  it('a frame with no face is pending as Face not clear and Liveness failed (lowest frame)', async () => {
    const ctx = await setup({
      readings: { 1: { faces: 0, minFaceWidth: 0, embedding: null, real: 0, live: 0 } },
    });
    const body = (await (await check(ctx, 'check_in')).json()) as CheckResult;
    expect(body.status).toBe('pending');
    expect(body.reasons).toEqual(['Face not clear', 'Liveness failed']);
  });

  it('a different face is pending as Face not matched', async () => {
    const ctx = await setup({
      readings: {
        1: { embedding: stranger(1) },
        2: { embedding: stranger(2) },
        3: { embedding: stranger(3) },
      },
    });
    const body = (await (await check(ctx, 'check_in')).json()) as CheckResult;
    expect(body.status).toBe('pending');
    expect(body.reasons).toHaveLength(1);
    expect(body.reasons).toEqual(['Face not matched (score 0.00)']);
  });

  it('one stranger frame among two matches is Face not clear: the frames must be one person', async () => {
    const ctx = await setup({ readings: { 2: { embedding: stranger(2) } } });
    const body = (await (await check(ctx, 'check_in')).json()) as CheckResult;
    expect(body.status).toBe('pending');
    expect(body.reasons).toEqual(['Face not clear']);
    const [row] = await entries();
    expect(row!.similarity).toBe(1); // still the median, kept for the reviewer
  });

  it('one low-liveness frame is pending as Liveness failed (lowest frame, not the mean)', async () => {
    const ctx = await setup({ readings: { 2: { live: 0.2 } } });
    const body = (await (await check(ctx, 'check_in')).json()) as CheckResult;
    expect(body.reasons).toEqual(['Liveness failed']);
    const [row] = await entries();
    expect(row!.live).toBe(false);
    expect(row!.real).toBe(true);
  });

  it('one spoof frame among two live ones is pending as Liveness failed', async () => {
    const ctx = await setup({ readings: { 3: { real: 0.1 } } });
    const body = (await (await check(ctx, 'check_in')).json()) as CheckResult;
    expect(body.reasons).toEqual(['Liveness failed']);
    const [row] = await entries();
    expect(row!.real).toBe(false);
    expect(row!.live).toBe(true);
  });

  it('byte-identical frames are pending as Liveness failed', async () => {
    const ctx = await setup();
    const body = (await (
      await check(ctx, 'check_in', { frames: [frame(1), frame(2), frame(1)] })
    ).json()) as CheckResult;
    expect(body.status).toBe('pending');
    expect(body.reasons).toEqual(['Liveness failed']);
    const [row] = await entries();
    expect(row!.evidence).toHaveLength(3);
  });

  it('near-identical frames (32×32 grey downscale) are pending as Liveness failed', async () => {
    const ctx = await setup({
      readings: {
        1: { thumb: new Uint8Array(1024).fill(100) },
        3: { thumb: Uint8Array.from({ length: 1024 }, (_, i) => 100 + (i % 2)) },
      },
    });
    const body = (await (await check(ctx, 'check_in')).json()) as CheckResult;
    expect(body.reasons).toEqual(['Liveness failed']);
  });

  it('different photos whose embeddings are all identical still record', async () => {
    const ctx = await setup({
      readings: {
        1: { embedding: EMBEDDING },
        2: { embedding: EMBEDDING },
        3: { embedding: EMBEDDING },
      },
    });
    const body = (await (await check(ctx, 'check_in')).json()) as CheckResult;
    expect(body).toMatchObject({ status: 'recorded', reasons: [] });
  });

  it('uses FACE_MATCH_MIN and FACE_LIVENESS_MIN from config', async () => {
    const readings = {
      1: { embedding: further(1, 2) },
      2: { embedding: further(2, 2) },
      3: { embedding: further(3, 2) },
    };
    const lax = await setup({ readings });
    const ok = (await (await check(lax, 'check_in')).json()) as CheckResult;
    expect(ok.status).toBe('recorded');
    await truncateAll();
    const strict = await setup({
      readings,
      config: { faceThresholds: { minSimilarity: 0.9, minLiveness: 0.97 } },
    });
    const body = (await (await check(strict, 'check_in')).json()) as CheckResult;
    expect(body.reasons).toEqual(['Face not matched (score 0.83)', 'Liveness failed']);
    const match = await call(strict, '/match', 'POST', { frame: frame(1) });
    expect(await match.json()).toEqual({ matched: false });
  });

  it('a template that no longer decrypts is face_not_registered: register again', async () => {
    const ctx = await setup({ badTemplate: true });
    for (const res of [
      await check(ctx, 'check_in'),
      await call(ctx, '/match', 'POST', { frame: frame(1) }),
    ]) {
      expect(res.status).toBe(409);
      expect(await errorOf(res)).toEqual({
        code: 'face_not_registered',
        message: 'Register your face again.',
      });
    }
    expect(await entries()).toHaveLength(0);
  });

  it('rate limits are per member: two members behind one IP do not share them', async () => {
    const ctx = await setup();
    const ip = '10.9.9.9';
    const worker = { cookie: ctx.worker.cookie, ip };
    const mate = { cookie: ctx.mate.cookie, ip };
    for (let i = 0; i < 30; i++) {
      expect((await call(ctx, '/match', 'POST', { frame: frame(1) }, worker)).status).toBe(200);
    }
    expect((await call(ctx, '/match', 'POST', { frame: frame(1) }, worker)).status).toBe(429);
    expect((await call(ctx, '/match', 'POST', { frame: frame(1) }, mate)).status).toBe(200);
    const body = { projectId: ctx.p1, kind: 'check_in', ...SITE, accuracyM: 12, frames: frames() };
    for (let i = 0; i < 10; i++) {
      expect((await call(ctx, '/check', 'POST', body, worker)).status).not.toBe(429);
    }
    expect((await call(ctx, '/check', 'POST', body, worker)).status).toBe(429);
    expect((await call(ctx, '/check', 'POST', body, mate)).status).toBe(200);
  });

  it('two parallel check-ins: one succeeds, the other gets already_checked_in', async () => {
    const ctx = await setup({ gateReads: 2 });
    const rs = await Promise.all([
      check(ctx, 'check_in'),
      check(ctx, 'check_in', { frames: frames(10) }),
    ]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    const loser = rs.find((r) => r.status === 409)!;
    expect((await errorOf(loser)).code).toBe('already_checked_in');
    expect(await entries()).toHaveLength(1);
  });
});

describe('attendance match', () => {
  it('matches against the approved template and records nothing', async () => {
    const ctx = await setup({
      readings: {
        7: { embedding: stranger(7) },
        8: { faces: 0, embedding: null },
        9: { faces: 2 },
        10: { minFaceWidth: 159 },
      },
    });
    const ok = await call(ctx, '/match', 'POST', { frame: frame(1) });
    expect(ok.status).toBe(200);
    // Only the verdict: the score is never shown to the person checking in.
    expect(await ok.json()).toEqual({ matched: true });
    for (const n of [7, 8, 9, 10]) {
      const res = await call(ctx, '/match', 'POST', { frame: frame(n) });
      expect(await res.json()).toEqual({ matched: false });
    }
    expect(await entries()).toHaveLength(0);
    const audits = await ownerDb
      .select()
      .from(auditLog)
      .where(like(auditLog.action, 'attendance.%'));
    expect(audits).toHaveLength(0);
  });

  it('without an approved face is face_not_registered', async () => {
    const ctx = await setup({ face: false });
    const res = await call(ctx, '/match', 'POST', { frame: frame(1) });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('face_not_registered');
  });

  it('a missing frame is 400', async () => {
    const ctx = await setup();
    const res = await call(ctx, '/match', 'POST', {});
    expect(res.status).toBe(400);
  });
});
