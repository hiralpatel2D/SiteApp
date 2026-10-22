import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { newId, REGISTRATION_PHOTO_FRAME } from '@sitediary/shared';
import { createCompany } from '../src/companies/create-company';
import {
  auditLog,
  faceRegistrations,
  memberships,
  projectAssignments,
  projects,
} from '../src/db/schema';
import { createFakeEngine, FAKE_EMBEDDING, fakeEmbedding } from '../src/attendance/face/fake';
import type { FaceReading } from '../src/attendance/face/types';
import type { Config } from '../src/config';
import { cfg, ownerDb, useTestDb } from './helpers/db';
import { decryptTemplate } from '../src/attendance/face/template';
import { req, seedMember, testApp } from './helpers/auth';

useTestDb();

type ErrorBody = { error: { code: string; message: string } };
const errorOf = async (r: Response) => ((await r.json()) as ErrorBody).error;

const GOOD: Omit<FaceReading, 'embedding' | 'thumb'> = {
  faces: 1,
  minFaceWidth: 320,
  real: 0.95,
  live: 0.95,
};
// Frame n is the byte n repeated; the fake engine reads its first byte.
const frame = (n: number) => Buffer.from([n, n, n, n]).toString('base64');
const frames = (start = 1) => [0, 1, 2, 3, 4].map((i) => frame(start + i));

async function setup(
  readings: Record<number, Partial<FaceReading>> = {},
  gateReads = 0,
  config: Partial<Config> = {},
) {
  const co = await createCompany(ownerDb, { name: 'Alpha Builders', slug: 'alpha' });
  const base = createFakeEngine((jpeg) => ({
    ...GOOD,
    embedding: fakeEmbedding(jpeg),
    ...readings[jpeg[0]!],
  }));
  // With gateReads set, the last frame read of each request waits until that many requests have reached it, so parallel requests reach the DB together.
  let started = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const faceEngine = {
    ...base,
    async read(jpeg: Buffer) {
      if (gateReads > 0 && (jpeg[0] === 5 || jpeg[0] === 14)) {
        if (++started >= gateReads) open();
        await gate;
      }
      return base.read(jpeg);
    },
  };
  const { deps } = testApp({ config });
  const withEngine = (await import('../src/app')).createApp({ ...deps, faceEngine });
  const worker = await seedMember(co.companyId, 'site_engineer', 'w@alpha.test', {
    app: withEngine,
    name: 'Wanda Worker',
  });
  const pm = await seedMember(co.companyId, 'project_manager', 'pm@alpha.test', {
    app: withEngine,
  });
  const pmOther = await seedMember(co.companyId, 'project_manager', 'pm2@alpha.test', {
    app: withEngine,
  });
  const p1 = newId();
  const p2 = newId();
  await ownerDb.insert(projects).values([
    { id: p1, companyId: co.companyId, name: 'Tower', code: 'T1' },
    { id: p2, companyId: co.companyId, name: 'Bridge', code: 'B1' },
  ]);
  await ownerDb.insert(projectAssignments).values([
    { id: newId(), companyId: co.companyId, membershipId: worker.membershipId, projectId: p1 },
    { id: newId(), companyId: co.companyId, membershipId: pm.membershipId, projectId: p1 },
    { id: newId(), companyId: co.companyId, membershipId: pmOther.membershipId, projectId: p2 },
  ]);
  return { co, app: withEngine, worker, pm, pmOther };
}
type Ctx = Awaited<ReturnType<typeof setup>>;
const call = (ctx: Ctx, cookie: string | undefined, path: string, method = 'GET', body?: unknown) =>
  req(ctx.app, `/api/attendance/face${path}`, { cookie, company: ctx.co.companyId, method, body });
const register = (ctx: Ctx, cookie: string | undefined, f = frames()) =>
  call(ctx, cookie, '', 'POST', { consent: true, frames: f });
const statusOf = async (ctx: Ctx, cookie: string | undefined) =>
  ((await (await call(ctx, cookie, '/me')).json()) as { status: string }).status;
const rows = () => ownerDb.select().from(faceRegistrations);

describe('face registration', () => {
  it('registers as pending and me reflects it', async () => {
    const ctx = await setup();
    expect(await statusOf(ctx, ctx.worker.cookie)).toBe('none');
    const res = await register(ctx, ctx.worker.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'pending' });
    expect(await statusOf(ctx, ctx.worker.cookie)).toBe('pending');
    const [row] = await rows();
    // The approver sees a straight-ahead frame (the first "look straight" photo).
    expect(REGISTRATION_PHOTO_FRAME).toBe(3);
    expect(row!.photo!.toString('base64')).toBe(frames()[REGISTRATION_PHOTO_FRAME]);
    expect(row!.modelVersion).toBe('fake');
    // The template is the raw mean of the frame embeddings, in the engine's own space.
    const template = decryptTemplate(row!.template, cfg.faceTemplateKey);
    const embs = frames().map((f) => fakeEmbedding(Buffer.from(f, 'base64')));
    template.forEach((v, i) =>
      expect(v).toBeCloseTo(embs.reduce((sum, e) => sum + e[i]!, 0) / embs.length, 5),
    );
    const audits = await ownerDb
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'face.registered'));
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0])).not.toContain(row!.template.toString('base64'));
  });

  it('rejects consent:false with 400', async () => {
    const ctx = await setup();
    const res = await call(ctx, ctx.worker.cookie, '', 'POST', {
      consent: false,
      frames: frames(),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a frame with two faces as face_not_clear', async () => {
    const ctx = await setup({ 3: { faces: 2, embedding: null } });
    const res = await register(ctx, ctx.worker.cookie);
    expect(res.status).toBe(422);
    const e = await errorOf(res);
    expect(e.code).toBe('face_not_clear');
    expect(e.message).toBe('Face not clear. Face the camera in good light and try again.');
    expect(await rows()).toHaveLength(0);
  });

  it.each([[{ minFaceWidth: 100 }], [{ real: 0.3 }], [{ live: 0.3 }]])(
    'rejects a weak frame %o as face_not_clear',
    async (bad) => {
      const ctx = await setup({ 2: bad });
      const res = await register(ctx, ctx.worker.cookie);
      expect(res.status).toBe(422);
      expect((await errorOf(res)).code).toBe('face_not_clear');
    },
  );

  it('rejects frames that disagree as face_not_consistent', async () => {
    const ctx = await setup({ 4: { embedding: Array.from({ length: 1024 }, () => -1) } });
    const res = await register(ctx, ctx.worker.cookie);
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe('face_not_consistent');
  });

  it.each([
    ['byte-identical photos', {}, [1, 2, 3, 2, 5]],
    [
      'near-identical photos',
      {
        2: { thumb: new Uint8Array(1024).fill(50) },
        4: { thumb: Uint8Array.from({ length: 1024 }, (_, i) => 50 + (i % 2)) },
      },
      [1, 2, 3, 4, 5],
    ],
  ] as const)('rejects %s as frames_identical', async (_, readings, nums) => {
    const ctx = await setup(readings as Record<number, Partial<FaceReading>>);
    const res = await register(ctx, ctx.worker.cookie, nums.map(frame));
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toEqual({
      code: 'frames_identical',
      message: 'Move slightly and try again — the photos looked identical.',
    });
    expect(await rows()).toHaveLength(0);
  });

  it('accepts different photos whose embeddings are identical', async () => {
    const ctx = await setup(
      Object.fromEntries([1, 2, 3, 4, 5].map((n) => [n, { embedding: [...FAKE_EMBEDDING] }])),
    );
    expect((await register(ctx, ctx.worker.cookie)).status).toBe(200);
  });

  it('uses FACE_LIVENESS_MIN from config for the photos', async () => {
    const ctx = await setup({}, 0, { faceThresholds: { minSimilarity: 0.5, minLiveness: 0.97 } });
    const res = await register(ctx, ctx.worker.cookie);
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe('face_not_clear');
  });

  it('limits registrations per member, not per IP', async () => {
    const ctx = await setup();
    const ip = '10.8.8.8';
    const as = (cookie: string | undefined, f = frames()) =>
      req(ctx.app, '/api/attendance/face', {
        cookie,
        company: ctx.co.companyId,
        body: { consent: true, frames: f },
        ip,
      });
    for (let i = 0; i < 5; i++) expect((await as(ctx.worker.cookie)).status).toBe(200);
    expect((await as(ctx.worker.cookie)).status).toBe(429);
    expect((await as(ctx.pm.cookie)).status).toBe(200);
  });

  it('a new registration replaces the older pending one', async () => {
    const ctx = await setup();
    await register(ctx, ctx.worker.cookie);
    await register(ctx, ctx.worker.cookie, frames(10));
    const all = await rows();
    expect(all.map((r) => r.status).sort()).toEqual(['pending', 'superseded']);
    expect(all.find((r) => r.status === 'superseded')!.photo).toBeNull();
    expect(await statusOf(ctx, ctx.worker.cookie)).toBe('pending');
  });

  it('a PM sharing a project lists and approves; photo is cleared', async () => {
    const ctx = await setup();
    await register(ctx, ctx.worker.cookie);
    const list = (await (await call(ctx, ctx.pm.cookie, '/pending')).json()) as {
      pending: {
        id: string;
        membershipId: string;
        name: string;
        email: string;
        photo: string;
      }[];
    };
    expect(list.pending).toHaveLength(1);
    expect(list.pending[0]).toMatchObject({
      membershipId: ctx.worker.membershipId,
      name: 'Wanda Worker',
      email: 'w@alpha.test',
    });
    expect(list.pending[0]!.photo.startsWith('data:image/jpeg;base64,')).toBe(true);
    const res = await call(ctx, ctx.pm.cookie, `/${list.pending[0]!.id}/approve`, 'POST', {});
    expect(res.status).toBe(200);
    expect(await statusOf(ctx, ctx.worker.cookie)).toBe('approved');
    const [row] = await rows();
    expect(row!.photo).toBeNull();
    expect(row!.decidedBy).toBe(ctx.pm.userId);
    expect(row!.decidedAt).not.toBeNull();
    const audits = await ownerDb
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'face.approved'));
    expect(audits).toHaveLength(1);
  });

  it('refuses self approval with 403 and hides self from the list', async () => {
    const ctx = await setup();
    await register(ctx, ctx.pm.cookie);
    const [row] = await rows();
    const res = await call(ctx, ctx.pm.cookie, `/${row!.id}/approve`, 'POST', {});
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('forbidden');
    const list = (await (await call(ctx, ctx.pm.cookie, '/pending')).json()) as {
      pending: unknown[];
    };
    expect(list.pending).toHaveLength(0);
  });

  it('a PM without a shared project gets 404 and an empty list', async () => {
    const ctx = await setup();
    await register(ctx, ctx.worker.cookie);
    const [row] = await rows();
    const res = await call(ctx, ctx.pmOther.cookie, `/${row!.id}/approve`, 'POST', {});
    expect(res.status).toBe(404);
    const rej = await call(ctx, ctx.pmOther.cookie, `/${row!.id}/reject`, 'POST', {});
    expect(rej.status).toBe(404);
    const list = (await (await call(ctx, ctx.pmOther.cookie, '/pending')).json()) as {
      pending: unknown[];
    };
    expect(list.pending).toHaveLength(0);
  });

  it('a worker cannot approve', async () => {
    const ctx = await setup();
    await register(ctx, ctx.worker.cookie);
    const [row] = await rows();
    const res = await call(ctx, ctx.worker.cookie, `/${row!.id}/approve`, 'POST', {});
    expect(res.status).toBe(403);
  });

  it('reject sets rejected, clears the photo and audits', async () => {
    const ctx = await setup();
    await register(ctx, ctx.worker.cookie);
    const [row] = await rows();
    const res = await call(ctx, ctx.pm.cookie, `/${row!.id}/reject`, 'POST', {});
    expect(res.status).toBe(200);
    const [after] = await rows();
    expect(after!.status).toBe('rejected');
    expect(after!.photo).toBeNull();
    expect(await statusOf(ctx, ctx.worker.cookie)).toBe('rejected');
    const audits = await ownerDb
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'face.rejected'));
    expect(audits).toHaveLength(1);
    // already decided
    const again = await call(ctx, ctx.pm.cookie, `/${row!.id}/approve`, 'POST', {});
    expect(again.status).toBe(404);
  });

  it('re-registering while approved keeps approved until the new one is approved', async () => {
    const ctx = await setup();
    await register(ctx, ctx.worker.cookie);
    const [first] = await rows();
    await call(ctx, ctx.pm.cookie, `/${first!.id}/approve`, 'POST', {});
    await register(ctx, ctx.worker.cookie, frames(20));
    expect(await statusOf(ctx, ctx.worker.cookie)).toBe('approved');
    const pending = (await rows()).find((r) => r.status === 'pending')!;
    const res = await call(ctx, ctx.pm.cookie, `/${pending.id}/approve`, 'POST', {});
    expect(res.status).toBe(200);
    const byId = new Map((await rows()).map((r) => [r.id, r.status]));
    expect(byId.get(first!.id)).toBe('superseded');
    expect(byId.get(pending.id)).toBe('approved');
    expect(await statusOf(ctx, ctx.worker.cookie)).toBe('approved');
  });

  it('records the replaced row id in the audit', async () => {
    const ctx = await setup();
    await register(ctx, ctx.worker.cookie);
    const [first] = await rows();
    await register(ctx, ctx.worker.cookie, frames(10));
    const audits = await ownerDb
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'face.registered'));
    expect(audits.map((a) => a.before)).toContainEqual({ replacedId: first!.id });
  });

  it('ignores deactivated members pending registrations', async () => {
    const ctx = await setup();
    await register(ctx, ctx.worker.cookie);
    const [row] = await rows();
    await ownerDb
      .update(memberships)
      .set({ status: 'deactivated' })
      .where(eq(memberships.id, ctx.worker.membershipId));
    const list = (await (await call(ctx, ctx.pm.cookie, '/pending')).json()) as {
      pending: unknown[];
    };
    expect(list.pending).toHaveLength(0);
    expect((await call(ctx, ctx.pm.cookie, `/${row!.id}/approve`, 'POST', {})).status).toBe(404);
    expect((await call(ctx, ctx.pm.cookie, `/${row!.id}/reject`, 'POST', {})).status).toBe(404);
  });

  it('rejects an oversized frame with 400', async () => {
    const ctx = await setup();
    const f = frames();
    f[1] = 'A'.repeat(Math.ceil((300 * 1024) / 3) * 4 + 4);
    const res = await register(ctx, ctx.worker.cookie, f);
    expect(res.status).toBe(400);
    const e = (await res.json()) as { error: { code: string; details?: unknown } };
    expect(e.error.code).toBe('validation_failed');
    expect(e.error.details).toBeDefined();
  });

  it('rejects a body over 2 MB with 413', async () => {
    const ctx = await setup();
    const big = Array.from({ length: 5 }, () => 'A'.repeat(500_000));
    const res = await register(ctx, ctx.worker.cookie, big);
    expect(res.status).toBe(413);
    const e = await errorOf(res);
    expect(e).toMatchObject({ code: 'too_large', message: 'Upload is too large.' });
  });

  it('two parallel first registrations: one succeeds, one gets 409', async () => {
    const ctx = await setup({}, 2);
    const rs = await Promise.all([
      register(ctx, ctx.worker.cookie),
      register(ctx, ctx.worker.cookie, frames(10)),
    ]);
    const codes = rs.map((r) => r.status).sort();
    expect(codes).toEqual([200, 409]);
    const loser = rs.find((r) => r.status === 409)!;
    expect((await errorOf(loser)).code).toBe('registration_in_progress');
  });
});
