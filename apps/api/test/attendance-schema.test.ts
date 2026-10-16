import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { newId } from '@sitediary/shared';
import { withTenant } from '../src/db/tenant';
import { createCompany } from '../src/companies/create-company';
import {
  attendanceEntries,
  attendanceSettings,
  faceRegistrations,
  projects,
  roles,
} from '../src/db/schema';
import { seedMember } from './helpers/auth';
import { app, owner, ownerDb, seedTwoCompanies, useTestDb } from './helpers/db';

useTestDb();

async function seedCompany(companyId: string) {
  const [project] = await ownerDb.select().from(projects).where(eq(projects.companyId, companyId));
  const roleId = newId();
  await ownerDb.insert(roles).values({ id: roleId, companyId, name: 'Engineer' });
  const m = await seedMember(companyId, roleId, `e-${companyId}@x.test`, {
    signIn: false,
  });
  return { projectId: project!.id, membershipId: m.membershipId };
}

const entry = (companyId: string, membershipId: string, projectId: string, kind = 'check_in') => ({
  id: newId(),
  companyId,
  membershipId,
  projectId,
  workDate: '2026-10-16',
  kind,
  at: new Date(),
  lat: 1,
  lng: 2,
  accuracyM: 5,
  distanceM: 10,
  real: true,
  live: true,
  status: 'recorded',
  reasons: [] as string[],
  lateMin: 0,
});

describe('attendance schema', () => {
  it('isolates all three tables by tenant', async () => {
    const { a, b } = await seedTwoCompanies();
    const sa = await seedCompany(a);
    const sb = await seedCompany(b);
    for (const [c, s] of [
      [a, sa],
      [b, sb],
    ] as const) {
      await ownerDb.insert(attendanceSettings).values({
        companyId: c,
        projectId: s.projectId,
        lat: 1,
        lng: 2,
        radiusM: 100,
        startTime: '09:00',
        lateAfterMin: 15,
        reminderTime: '08:30',
      });
      await ownerDb.insert(faceRegistrations).values({
        companyId: c,
        membershipId: s.membershipId,
        status: 'approved',
        template: Buffer.from([1, 2, 3]),
        modelVersion: 'v1',
        consentAt: new Date(),
      });
      await ownerDb.insert(attendanceEntries).values(entry(c, s.membershipId, s.projectId));
    }
    await withTenant(app, { companyId: a }, async (tx) => {
      expect(await tx.select().from(attendanceSettings)).toHaveLength(1);
      const faces = await tx.select().from(faceRegistrations);
      expect(faces).toHaveLength(1);
      expect(Buffer.from(faces[0]!.template)).toEqual(Buffer.from([1, 2, 3]));
      const rows = await tx.select().from(attendanceEntries);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.companyId).toBe(a);
    });
    // tenant a cannot insert a row for tenant b
    await expect(
      withTenant(app, { companyId: a }, (tx) =>
        tx.insert(attendanceEntries).values(entry(b, sb.membershipId, sb.projectId)),
      ),
    ).rejects.toThrow();
    // default timezone
    const [s] = await ownerDb
      .select()
      .from(attendanceSettings)
      .where(eq(attendanceSettings.companyId, a));
    expect(s!.timezone).toBe('Asia/Kolkata');
  });

  it('allows one non-rejected entry per membership/date/kind', async () => {
    const { a } = await seedTwoCompanies();
    const s = await seedCompany(a);
    const first = entry(a, s.membershipId, s.projectId);
    await withTenant(app, { companyId: a }, (tx) => tx.insert(attendanceEntries).values(first));
    await expect(
      withTenant(app, { companyId: a }, (tx) =>
        tx.insert(attendanceEntries).values(entry(a, s.membershipId, s.projectId)),
      ),
    ).rejects.toThrow(/attendance_entries_one_per_day/);
    // a check_out on the same day is fine
    await withTenant(app, { companyId: a }, (tx) =>
      tx.insert(attendanceEntries).values(entry(a, s.membershipId, s.projectId, 'check_out')),
    );
    await withTenant(app, { companyId: a }, (tx) =>
      tx
        .update(attendanceEntries)
        .set({ status: 'rejected' })
        .where(eq(attendanceEntries.id, first.id)),
    );
    await withTenant(app, { companyId: a }, (tx) =>
      tx.insert(attendanceEntries).values(entry(a, s.membershipId, s.projectId)),
    );
  });

  it('allows one pending and one approved face registration per membership', async () => {
    const { a } = await seedTwoCompanies();
    const s = await seedCompany(a);
    const face = (status: string) => ({
      companyId: a,
      membershipId: s.membershipId,
      status,
      template: Buffer.from([1]),
      modelVersion: 'v1',
      consentAt: new Date(),
    });
    await ownerDb.insert(faceRegistrations).values(face('approved'));
    await ownerDb.insert(faceRegistrations).values(face('pending'));
    await expect(ownerDb.insert(faceRegistrations).values(face('approved'))).rejects.toThrow();
    await expect(ownerDb.insert(faceRegistrations).values(face('pending'))).rejects.toThrow();
    await ownerDb.insert(faceRegistrations).values(face('superseded'));
    await ownerDb.insert(faceRegistrations).values(face('superseded'));
    await expect(ownerDb.insert(faceRegistrations).values(face('bogus'))).rejects.toThrow();
  });

  it('app_user cannot delete attendance_entries', async () => {
    const { a } = await seedTwoCompanies();
    const s = await seedCompany(a);
    const e = entry(a, s.membershipId, s.projectId);
    await withTenant(app, { companyId: a }, (tx) => tx.insert(attendanceEntries).values(e));
    await expect(
      withTenant(app, { companyId: a }, (tx) =>
        tx.delete(attendanceEntries).where(eq(attendanceEntries.id, e.id)),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('backfills attendance capabilities onto existing system roles', async () => {
    const { companyId } = await createCompany(ownerDb, { name: 'Old Co', slug: 'old-co' });
    await owner.query(
      `delete from role_capabilities where capability like 'attendance.%' and capability <> 'attendance.view'`,
    );
    const file = await readFile(
      fileURLToPath(new URL('../drizzle/0005_attendance.sql', import.meta.url)),
      'utf8',
    );
    const backfill = file
      .split('--> statement-breakpoint')
      .find((s) => s.includes('INSERT INTO "role_capabilities"'));
    expect(backfill).toBeTruthy();
    await owner.query(backfill!);
    await owner.query(backfill!); // idempotent
    const { rows } = await owner.query<{ key: string; capability: string }>(
      `select r.key, rc.capability from role_capabilities rc join roles r on r.id = rc.role_id
       where rc.company_id = $1 and rc.capability in ('attendance.approve_face','attendance.review','attendance.settings','attendance.export')`,
      [companyId],
    );
    const by = (k: string) =>
      rows
        .filter((r) => r.key === k)
        .map((r) => r.capability)
        .sort();
    expect(by('admin')).toContain('attendance.settings');
    expect(by('super_admin')).toHaveLength(4);
    expect(by('admin')).toHaveLength(4);
    expect(by('project_manager')).toEqual(['attendance.approve_face', 'attendance.review']);
    expect(by('coordinator')).toEqual(['attendance.review']);
    expect(by('site_engineer')).toEqual([]);
    expect(by('client')).toEqual([]);
  });
});
