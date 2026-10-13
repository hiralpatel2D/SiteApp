import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { CAPABILITIES } from '@sitediary/shared';
import { createCompany } from '../src/companies/create-company';
import { withTenant } from '../src/db/tenant';
import { auditLog, companies, roleCapabilities, roles } from '../src/db/schema';
import { app, ownerDb, useTestDb } from './helpers/db';

useTestDb();

describe('createCompany', () => {
  it('creates company with nine system roles', async () => {
    const { companyId } = await createCompany(ownerDb, {
      name: 'Mehta Infra',
      slug: 'Mehta Infra',
    });
    const rs = await withTenant(app, { companyId }, (tx) => tx.select().from(roles));
    expect(rs).toHaveLength(9);
    expect(rs.every((r) => r.isSystem)).toBe(true);
  });
  it('stores the normalised slug', async () => {
    const { companyId } = await createCompany(ownerDb, { name: 'X', slug: '  Shah Builders ' });
    const [c] = await withTenant(app, { companyId }, (tx) => tx.select().from(companies));
    expect(c!.slug).toBe('shah-builders');
  });
  it('super_admin gets every capability', async () => {
    const { companyId, roleIds } = await createCompany(ownerDb, { name: 'A', slug: 'aaa' });
    const caps = await withTenant(app, { companyId }, (tx) =>
      tx.select().from(roleCapabilities).where(eq(roleCapabilities.roleId, roleIds.super_admin)),
    );
    expect(caps).toHaveLength(CAPABILITIES.length);
  });
  it('duplicate slug is a 409', async () => {
    await createCompany(ownerDb, { name: 'A', slug: 'dup-co' });
    await expect(createCompany(ownerDb, { name: 'B', slug: 'Dup Co' })).rejects.toMatchObject({
      status: 409,
      code: 'slug_taken',
      message: 'That workspace name is already in use.',
    });
  });
  it('writes an audit entry', async () => {
    const { companyId } = await createCompany(ownerDb, { name: 'A', slug: 'audit-co' });
    const rows = await withTenant(app, { companyId }, (tx) => tx.select().from(auditLog));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('company.created');
    expect(rows[0]!.entity).toBe('company');
    expect(rows[0]!.entityId).toBe(companyId);
    expect(rows[0]!.after).toEqual({ name: 'A', slug: 'audit-co' });
  });
  it('invalid slug is a 400', async () => {
    await expect(createCompany(ownerDb, { name: 'A', slug: '!!' })).rejects.toMatchObject({
      status: 400,
      code: 'invalid_slug',
      message: 'Workspace name must be 3–40 letters, numbers or hyphens.',
    });
  });
});
