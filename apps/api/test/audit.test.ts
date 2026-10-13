import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { newId } from '@sitediary/shared';
import { createCompany } from '../src/companies/create-company';
import { auditLog } from '../src/db/schema';
import { ownerDb, useTestDb } from './helpers/db';
import { req, seedMember, testApp } from './helpers/auth';

useTestDb();

type Item = {
  id: string;
  at: string;
  userName: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
};
type Page = { items: Item[]; nextCursor: string | null };

async function setup() {
  const co = await createCompany(ownerDb, { name: 'Alpha', slug: 'alpha' });
  const other = await createCompany(ownerDb, { name: 'Bravo', slug: 'bravo' });
  const { app } = testApp();
  const admin = await seedMember(co.companyId, 'super_admin', 'admin@alpha.test', {
    app,
    name: 'Ada Admin',
  });
  const eng = await seedMember(co.companyId, 'site_engineer', 'eng@alpha.test', { app });
  // Start from a known log: drop the row createCompany wrote.
  await ownerDb.delete(auditLog).where(eq(auditLog.action, 'company.created'));
  const rows = [];
  for (let i = 0; i < 5; i++) {
    rows.push({
      id: newId(),
      companyId: co.companyId,
      userId: i === 4 ? null : admin.userId,
      action: i % 2 ? 'project.updated' : 'project.created',
      entity: i % 2 ? 'project' : 'role',
      entityId: newId(),
      before: i % 2 ? { a: i } : null,
      after: { a: i + 1 },
      createdAt: new Date(Date.UTC(2026, 0, 1 + i)),
    });
  }
  rows.push({
    id: newId(),
    companyId: other.companyId,
    userId: null,
    action: 'secret.thing',
    entity: 'project',
    entityId: null,
    before: null,
    after: null,
    createdAt: new Date(Date.UTC(2026, 0, 3)),
  });
  await ownerDb.insert(auditLog).values(rows);
  return { co, other, app, admin, eng, rows };
}
type Ctx = Awaited<ReturnType<typeof setup>>;
const get = (ctx: Ctx, qs = '', cookie = ctx.admin.cookie) =>
  req(ctx.app, `/api/audit${qs}`, { cookie, company: ctx.co.companyId });

describe('GET /api/audit', () => {
  it('requires audit.view', async () => {
    const ctx = await setup();
    expect((await get(ctx, '', ctx.eng.cookie)).status).toBe(403);
  });

  it('paginates newest-first with a cursor, never leaking other companies', async () => {
    const ctx = await setup();
    const p1 = (await (await get(ctx, '?limit=2')).json()) as Page;
    expect(p1.items).toHaveLength(2);
    expect(p1.items[0]!.userName).toBeNull();
    expect(p1.items[1]!.userName).toBe('Ada Admin');
    expect(p1.nextCursor).toEqual(expect.any(String));
    const p2 = (await (
      await get(ctx, `?limit=2&before=${encodeURIComponent(p1.nextCursor!)}`)
    ).json()) as Page;
    const p3 = (await (
      await get(ctx, `?limit=2&before=${encodeURIComponent(p2.nextCursor!)}`)
    ).json()) as Page;
    expect(p3.nextCursor).toBeNull();
    const seen = [...p1.items, ...p2.items, ...p3.items];
    expect(seen).toHaveLength(5);
    const times = seen.map((i) => Date.parse(i.at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(seen.some((i) => i.action === 'secret.thing')).toBe(false);
    expect(seen[0]).toMatchObject({ entity: 'role', before: null, after: { a: 5 } });
  });

  it('filters by userId, entity and date range; default limit works', async () => {
    const ctx = await setup();
    const byUser = (await (await get(ctx, `?userId=${ctx.admin.userId}`)).json()) as Page;
    expect(byUser.items).toHaveLength(4);
    const byEntity = (await (await get(ctx, '?entity=project')).json()) as Page;
    expect(byEntity.items.every((i) => i.entity === 'project')).toBe(true);
    expect(byEntity.items).toHaveLength(2);
    const ranged = (await (
      await get(ctx, '?from=2026-01-02&to=2026-01-03T23:59:59Z')
    ).json()) as Page;
    expect(ranged.items).toHaveLength(2);
  });

  it('invalid filters → 400 validation_failed', async () => {
    const ctx = await setup();
    for (const qs of [
      '?from=nope',
      '?to=2026-13-45',
      '?limit=0',
      '?limit=101',
      '?userId=x',
      '?before=garbage',
    ]) {
      const r = await get(ctx, qs);
      expect(r.status, qs).toBe(400);
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe(
        'validation_failed',
      );
    }
  });

  it('2026-02-31 is a 400 with details on the field', async () => {
    const ctx = await setup();
    const r = await get(ctx, '?from=2026-02-31&to=2026-02-31');
    expect(r.status).toBe(400);
    const e = ((await r.json()) as { error: { details: Record<string, string> } }).error;
    expect(Object.keys(e.details).sort()).toEqual(['from', 'to']);
  });

  it('pages across rows with identical created_at without skipping or duplicating', async () => {
    const ctx = await setup();
    const at = new Date(Date.UTC(2027, 0, 1));
    const ids = Array.from({ length: 7 }, () => newId());
    await ownerDb.insert(auditLog).values(
      ids.map((id) => ({
        id,
        companyId: ctx.co.companyId,
        action: 'tie.row',
        entity: 'tie',
        createdAt: at,
      })),
    );
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const qs: string = `?entity=tie&limit=3${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`;
      const page = (await (await get(ctx, qs)).json()) as Page;
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(7);
    expect(new Set(seen)).toEqual(new Set(ids));
  });
});
