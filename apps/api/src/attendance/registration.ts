import { Hono } from 'hono';
import { and, asc, desc, eq } from 'drizzle-orm';
import { faceRegistrationBodySchema, newId } from '@sitediary/shared';
import { writeAudit } from '../audit/audit';
import type { AppEnv } from '../auth/session';
import type { Config } from '../config';
import { faceRegistrations, memberships, users } from '../db/schema';
import type { AppTx } from '../db/tenant';
import { parseBody } from '../http/body';
import { AppError } from '../http/errors';
import { rateLimit } from '../http/rate-limit';
import { forbidden } from '../roles/authz';
import { requireCap, runInTenant, type Tenant, type TenantEnv } from '../tenant/context';
import type { FaceEngine, FaceReading } from './face/engine';
import { averageEmbedding, encryptTemplate } from './face/template';
import { sharesProject } from './reach';

const REGISTER_LIMIT = { max: 5, windowMs: 60_000 };
const MIN_FACE_WIDTH = 160;
const MIN_SCORE = 0.6;
const MIN_AGREEMENT = 0.5;
const PHOTO_FRAME = 2;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new AppError(404, 'not_found', 'Not found.');
const notClear = () =>
  new AppError(
    422,
    'face_not_clear',
    'Face not clear. Face the camera in good light and try again.',
  );
const notConsistent = () =>
  new AppError(
    422,
    'face_not_consistent',
    'The photos do not match each other. Keep your face in view and try again.',
  );

const isClear = (r: FaceReading) =>
  r.faces === 1 &&
  r.minFaceWidth >= MIN_FACE_WIDTH &&
  r.real >= MIN_SCORE &&
  r.live >= MIN_SCORE &&
  r.embedding !== null;

export type RegistrationDeps = { config: Config; faceEngine: FaceEngine };

/** `/face`: face registration and senior approval. Mounted under the attendance router. */
export function registrationRoutes({ config, faceEngine }: RegistrationDeps): Hono<AppEnv> {
  const r = new Hono<TenantEnv>();

  r.post('/', rateLimit(REGISTER_LIMIT), requireCap('attendance.view'), async (c) => {
    const body = await parseBody(c, faceRegistrationBodySchema);
    const t = c.get('tenant');
    const jpegs = body.frames.map((f) => Buffer.from(f, 'base64'));
    const readings: FaceReading[] = [];
    for (const jpeg of jpegs) readings.push(await faceEngine.read(jpeg));
    if (!readings.every(isClear)) throw notClear();
    const embeddings = readings.map((x) => x.embedding!);
    for (let i = 0; i < embeddings.length; i++) {
      for (let j = i + 1; j < embeddings.length; j++) {
        if (faceEngine.similarity(embeddings[i]!, embeddings[j]!) < MIN_AGREEMENT) {
          throw notConsistent();
        }
      }
    }
    const template = encryptTemplate(averageEmbedding(embeddings), config.faceTemplateKey);
    await runInTenant(c, async (tx) => {
      // A newer registration replaces any older pending one: the old row is marked rejected
      // (the app role cannot delete) and its photo dropped, so the one-pending index holds.
      await tx
        .update(faceRegistrations)
        .set({ status: 'rejected', photo: null, updatedBy: t.userId })
        .where(
          and(
            eq(faceRegistrations.companyId, t.companyId),
            eq(faceRegistrations.membershipId, t.membershipId),
            eq(faceRegistrations.status, 'pending'),
          ),
        );
      const id = newId();
      await tx.insert(faceRegistrations).values({
        id,
        companyId: t.companyId,
        membershipId: t.membershipId,
        status: 'pending',
        template,
        modelVersion: faceEngine.modelVersion,
        consentAt: new Date(),
        photo: jpegs[PHOTO_FRAME]!,
        createdBy: t.userId,
        updatedBy: t.userId,
      });
      await writeAudit(tx, t, {
        action: 'face.registered',
        entity: 'face_registration',
        entityId: id,
        after: {
          status: 'pending',
          membershipId: t.membershipId,
          modelVersion: faceEngine.modelVersion,
        },
      });
    });
    return c.json({ status: 'pending' });
  });

  r.get('/me', requireCap('attendance.view'), async (c) => {
    const t = c.get('tenant');
    const statuses = await runInTenant(c, async (tx) => {
      const list = await tx
        .select({ status: faceRegistrations.status })
        .from(faceRegistrations)
        .where(
          and(
            eq(faceRegistrations.companyId, t.companyId),
            eq(faceRegistrations.membershipId, t.membershipId),
          ),
        )
        .orderBy(desc(faceRegistrations.createdAt));
      return list.map((x) => x.status);
    });
    // An approved registration wins over a pending re-registration; otherwise the latest decision shows.
    const status = statuses.includes('approved')
      ? 'approved'
      : statuses.includes('pending')
        ? 'pending'
        : statuses.includes('rejected')
          ? 'rejected'
          : 'none';
    return c.json({ status });
  });

  r.get('/pending', requireCap('attendance.approve_face'), async (c) => {
    const t = c.get('tenant');
    const pending = await runInTenant(c, async (tx) => {
      const list = await tx
        .select({
          id: faceRegistrations.id,
          membershipId: faceRegistrations.membershipId,
          name: users.name,
          email: users.email,
          createdAt: faceRegistrations.createdAt,
          photo: faceRegistrations.photo,
        })
        .from(faceRegistrations)
        .innerJoin(
          memberships,
          and(
            eq(memberships.companyId, faceRegistrations.companyId),
            eq(memberships.id, faceRegistrations.membershipId),
          ),
        )
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(
          and(
            eq(faceRegistrations.companyId, t.companyId),
            eq(faceRegistrations.status, 'pending'),
          ),
        )
        .orderBy(asc(faceRegistrations.createdAt));
      const out = [];
      for (const row of list) {
        if (row.membershipId === t.membershipId) continue;
        if (!(await sharesProject(tx, t, row.membershipId))) continue;
        out.push({
          id: row.id,
          membershipId: row.membershipId,
          name: row.name,
          email: row.email,
          createdAt: row.createdAt,
          photo: `data:image/jpeg;base64,${(row.photo ?? Buffer.alloc(0)).toString('base64')}`,
        });
      }
      return out;
    });
    return c.json({ pending });
  });

  /** Loads the pending row the approver may decide: 404 if missing or out of reach, 403 for their own. */
  async function loadDecidable(tx: AppTx, t: Tenant, rawId: string) {
    const id = rawId.toLowerCase();
    if (!UUID_RE.test(id)) throw notFound();
    const [row] = await tx
      .select()
      .from(faceRegistrations)
      .where(
        and(
          eq(faceRegistrations.companyId, t.companyId),
          eq(faceRegistrations.id, id),
          eq(faceRegistrations.status, 'pending'),
        ),
      )
      .for('update');
    if (!row) throw notFound();
    if (row.membershipId === t.membershipId) throw forbidden();
    if (!(await sharesProject(tx, t, row.membershipId))) throw notFound();
    return row;
  }

  r.post('/:id/approve', requireCap('attendance.approve_face'), async (c) => {
    const t = c.get('tenant');
    await runInTenant(c, async (tx) => {
      const row = await loadDecidable(tx, t, c.req.param('id'));
      // Supersede the current approved row first so the one-approved index holds.
      await tx
        .update(faceRegistrations)
        .set({ status: 'superseded', updatedBy: t.userId })
        .where(
          and(
            eq(faceRegistrations.companyId, t.companyId),
            eq(faceRegistrations.membershipId, row.membershipId),
            eq(faceRegistrations.status, 'approved'),
          ),
        );
      await tx
        .update(faceRegistrations)
        .set({
          status: 'approved',
          photo: null,
          decidedBy: t.userId,
          decidedAt: new Date(),
          updatedBy: t.userId,
        })
        .where(eq(faceRegistrations.id, row.id));
      await writeAudit(tx, t, {
        action: 'face.approved',
        entity: 'face_registration',
        entityId: row.id,
        before: { status: 'pending' },
        after: { status: 'approved', membershipId: row.membershipId },
      });
    });
    return c.json({ status: 'approved' });
  });

  r.post('/:id/reject', requireCap('attendance.approve_face'), async (c) => {
    const t = c.get('tenant');
    await runInTenant(c, async (tx) => {
      const row = await loadDecidable(tx, t, c.req.param('id'));
      await tx
        .update(faceRegistrations)
        .set({
          status: 'rejected',
          photo: null,
          decidedBy: t.userId,
          decidedAt: new Date(),
          updatedBy: t.userId,
        })
        .where(eq(faceRegistrations.id, row.id));
      await writeAudit(tx, t, {
        action: 'face.rejected',
        entity: 'face_registration',
        entityId: row.id,
        before: { status: 'pending' },
        after: { status: 'rejected', membershipId: row.membershipId },
      });
    });
    return c.json({ status: 'rejected' });
  });

  return r as unknown as Hono<AppEnv>;
}
