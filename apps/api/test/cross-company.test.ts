import { describe, it, expect } from 'vitest';
import { newId } from '@sitediary/shared';
import { createCompany } from '../src/companies/create-company';
import { invitations, projects, roles } from '../src/db/schema';
import { ownerDb, useTestDb } from './helpers/db';
import { req, seedMember, testApp } from './helpers/auth';

useTestDb();

describe('cross-company id sweep', () => {
  it('cross-company id sweep returns 404 on every endpoint', async () => {
    const a = await createCompany(ownerDb, { name: 'Alpha', slug: 'alpha' });
    const b = await createCompany(ownerDb, { name: 'Bravo', slug: 'bravo' });
    const { app } = testApp();
    const aAdmin = await seedMember(a.companyId, 'super_admin', 'admin@alpha.test', { app });
    const bMember = await seedMember(b.companyId, 'site_engineer', 'eng@bravo.test', {
      signIn: false,
    });
    const bRole = (await ownerDb.select().from(roles)).find(
      (r) => r.companyId === b.companyId && r.key === 'admin',
    )!;
    const bCustomRole = newId();
    await ownerDb.insert(roles).values({
      id: bCustomRole,
      companyId: b.companyId,
      key: null,
      name: 'Custom B',
      isSystem: false,
    });
    const bProject = newId();
    const aProject = newId();
    await ownerDb.insert(projects).values([
      { id: bProject, companyId: b.companyId, name: 'B Site', code: 'BS' },
      { id: aProject, companyId: a.companyId, name: 'A Site', code: 'AS' },
    ]);
    const bInvitation = newId();
    await ownerDb.insert(invitations).values({
      id: bInvitation,
      companyId: b.companyId,
      email: 'x@bravo.test',
      roleId: bRole.id,
      tokenHash: 'hash-' + bInvitation,
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    const cases: [string, string, unknown][] = [
      ['PATCH', `/api/users/${bMember.membershipId}`, { version: 1, status: 'deactivated' }],
      ['PATCH', `/api/roles/${bRole.id}`, { version: 1, name: 'Renamed' }],
      ['DELETE', `/api/roles/${bCustomRole}`, undefined],
      ['PATCH', `/api/projects/${bProject}`, { version: 1, name: 'Hijacked' }],
      ['PUT', `/api/projects/${bProject}/members`, { membershipIds: [] }],
      ['DELETE', `/api/invitations/${bInvitation}`, undefined],
      ['PUT', `/api/projects/${aProject}/members`, { membershipIds: [bMember.membershipId] }],
    ];
    for (const [method, path, body] of cases) {
      const r = await req(app, path, { cookie: aAdmin.cookie, company: a.companyId, method, body });
      expect(r.status, `${method} ${path}`).toBe(404);
    }
  });
});
