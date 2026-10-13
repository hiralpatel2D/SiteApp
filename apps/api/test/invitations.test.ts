import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { newId } from '@sitediary/shared';
import { createCompany } from '../src/companies/create-company';
import {
  auditLog,
  companies,
  invitations,
  memberships,
  projectAssignments,
  projects,
  users,
} from '../src/db/schema';
import { cfg, ownerDb, useTestDb } from './helpers/db';
import { cookieFrom, req, seedMember, seedUser, signIn, testApp } from './helpers/auth';

useTestDb();

const PASSWORD = 'longpassword1';
const DAY = 24 * 60 * 60 * 1000;

type ErrorBody = { error: { code: string; message: string; details?: Record<string, string> } };
const errorOf = async (r: Response) => ((await r.json()) as ErrorBody).error;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

type Created = {
  id: string;
  email: string;
  roleName: string;
  inviteUrl: string;
  expiresAt: string;
};

async function setup() {
  const co = await createCompany(ownerDb, { name: 'Alpha Builders', slug: 'alpha' });
  const other = await createCompany(ownerDb, { name: 'Bravo', slug: 'bravo' });
  const p1 = newId();
  const p2 = newId();
  const otherProject = newId();
  await ownerDb.insert(projects).values([
    { id: p1, companyId: co.companyId, name: 'Tower', code: 'T1' },
    { id: p2, companyId: co.companyId, name: 'Bridge', code: 'B1' },
    { id: otherProject, companyId: other.companyId, name: 'Other', code: 'O1' },
  ]);
  const { app, email } = testApp();
  const admin = await seedMember(co.companyId, 'admin', 'admin@alpha.test', { app });
  return { co, other, p1, p2, otherProject, app, email, admin };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

async function invite(
  ctx: Ctx,
  body: { email: string; roleId?: string; projectIds?: string[] },
  cookie = ctx.admin.cookie,
): Promise<Response> {
  return req(ctx.app, '/api/invitations', {
    cookie,
    company: ctx.co.companyId,
    body: { roleId: ctx.co.roleIds.site_engineer, ...body },
  });
}

async function inviteOk(
  ctx: Ctx,
  body: { email: string; roleId?: string; projectIds?: string[] },
): Promise<Created & { token: string }> {
  const r = await invite(ctx, body);
  if (r.status !== 201) throw new Error(`invite failed: ${r.status} ${await r.text()}`);
  const created = (await r.json()) as Created;
  const token = created.inviteUrl.split('/invite/')[1]!;
  return { ...created, token };
}

const preview = (ctx: Ctx, token: string) =>
  req(ctx.app, `/api/invitations/by-token/${token}`, { origin: null });

const accept = (ctx: Ctx, token: string, opts: { body?: unknown; cookie?: string } = {}) =>
  req(ctx.app, `/api/invitations/by-token/${token}/accept`, {
    method: 'POST',
    body: opts.body,
    cookie: opts.cookie,
  });

describe('invitations', () => {
  it('admin invites and gets an inviteUrl with a 7-day expiry', async () => {
    const ctx = await setup();
    const before = Date.now();
    const r = await invite(ctx, { email: 'new.hire@alpha.test', projectIds: [ctx.p1] });
    expect(r.status).toBe(201);
    const body = (await r.json()) as Created;
    expect(body.email).toBe('new.hire@alpha.test');
    expect(body.roleName).toBe('Site Engineer');
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.inviteUrl).toMatch(new RegExp(`^${cfg.appBaseUrl}/invite/[A-Za-z0-9_-]{43}$`));
    const exp = new Date(body.expiresAt).getTime();
    expect(exp).toBeGreaterThanOrEqual(before + 7 * DAY - 5000);
    expect(exp).toBeLessThanOrEqual(Date.now() + 7 * DAY + 5000);

    // Email sent with the same link.
    expect(ctx.email.sent).toHaveLength(1);
    expect(ctx.email.sent[0]).toMatchObject({
      kind: 'invitation',
      to: 'new.hire@alpha.test',
      data: { companyName: 'Alpha Builders', roleName: 'Site Engineer', inviteUrl: body.inviteUrl },
    });

    // Audited, without the token.
    const audits = await ownerDb
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'invitation.created'));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      companyId: ctx.co.companyId,
      userId: ctx.admin.userId,
      entity: 'invitation',
      entityId: body.id,
    });
    expect(JSON.stringify(audits[0])).not.toContain(body.inviteUrl.split('/invite/')[1]);

    // Listed without the URL.
    const list = await req(ctx.app, '/api/invitations', {
      cookie: ctx.admin.cookie,
      company: ctx.co.companyId,
    });
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { invitations: Record<string, unknown>[] };
    expect(listed.invitations).toHaveLength(1);
    expect(listed.invitations[0]).toMatchObject({
      id: body.id,
      email: 'new.hire@alpha.test',
      roleName: 'Site Engineer',
      projectIds: [ctx.p1],
    });
    expect(JSON.stringify(listed)).not.toContain('/invite/');
    expect(listed.invitations[0]).not.toHaveProperty('tokenHash');
  });

  it('email is normalised for invite, duplicate check and accept', async () => {
    const ctx = await setup();
    const first = await inviteOk(ctx, { email: ' Anita@X.example ' });
    expect(first.email).toBe('anita@x.example');
    const [row] = await ownerDb.select().from(invitations);
    expect(row!.email).toBe('anita@x.example');

    const dup = await invite(ctx, { email: 'ANITA@x.example' });
    expect(dup.status).toBe(409);
    expect(await errorOf(dup)).toEqual({
      code: 'invitation_pending',
      message: 'This person already has a pending invitation.',
    });

    const r = await accept(ctx, first.token, { body: { name: 'Anita', password: PASSWORD } });
    expect(r.status).toBe(200);
    const [u] = await ownerDb.select().from(users).where(eq(users.email, 'anita@x.example'));
    expect(u).toBeTruthy();
    await signIn(ctx.app, 'anita@x.example', PASSWORD);
  });

  it('preview of expired / revoked / accepted invitation → 410 with the right code', async () => {
    const ctx = await setup();
    const open = await inviteOk(ctx, { email: 'open@alpha.test' });
    const p = await preview(ctx, open.token);
    expect(p.status).toBe(200);
    expect(await p.json()).toEqual({
      companyName: 'Alpha Builders',
      email: 'open@alpha.test',
      roleName: 'Site Engineer',
      expiresAt: open.expiresAt,
      hasAccount: false,
    });

    const cases = [
      ['expired', { expiresAt: new Date(Date.now() - 1000) }, 'invitation_expired'],
      ['revoked', { revokedAt: new Date() }, 'invitation_revoked'],
      ['accepted', { acceptedAt: new Date() }, 'invitation_used'],
    ] as const;
    const messages: Record<string, string> = {
      invitation_expired: 'This invitation has expired. Ask for a new one.',
      invitation_revoked: 'This invitation was cancelled.',
      invitation_used: 'This invitation has already been used.',
    };
    for (const [label, patch, code] of cases) {
      const inv = await inviteOk(ctx, { email: `${label}@alpha.test` });
      await ownerDb.update(invitations).set(patch).where(eq(invitations.id, inv.id));
      const r = await preview(ctx, inv.token);
      expect(r.status, label).toBe(410);
      expect(await errorOf(r)).toEqual({ code, message: messages[code] });
      // Accept gives the same answer and writes nothing.
      const a = await accept(ctx, inv.token, { body: { name: 'X', password: PASSWORD } });
      expect(a.status, label).toBe(410);
      expect((await errorOf(a)).code).toBe(code);
    }
    expect(await ownerDb.select().from(users).where(eq(users.email, 'expired@alpha.test'))).toEqual(
      [],
    );

    // Unknown or malformed token: plain 404.
    for (const t of ['A'.repeat(43), 'nope']) {
      const r = await preview(ctx, t);
      expect(r.status).toBe(404);
      expect(await errorOf(r)).toEqual({ code: 'not_found', message: 'Not found.' });
    }
  });

  it('preview for a suspended company → 403 company_suspended; accept refused too', async () => {
    const ctx = await setup();
    const inv = await inviteOk(ctx, { email: 'late@alpha.test' });
    await ownerDb
      .update(companies)
      .set({ status: 'suspended' })
      .where(eq(companies.id, ctx.co.companyId));
    const r = await preview(ctx, inv.token);
    expect(r.status).toBe(403);
    expect((await errorOf(r)).code).toBe('company_suspended');
    const a = await accept(ctx, inv.token, { body: { name: 'L', password: PASSWORD } });
    expect(a.status).toBe(403);
    expect((await errorOf(a)).code).toBe('company_suspended');
    expect(await ownerDb.select().from(users).where(eq(users.email, 'late@alpha.test'))).toEqual(
      [],
    );
  });

  it('new person accepts: account + membership + assignments + audit, cookie set', async () => {
    const ctx = await setup();
    const inv = await inviteOk(ctx, {
      email: 'ravi@alpha.test',
      roleId: ctx.co.roleIds.supervisor,
      projectIds: [ctx.p1, ctx.p2],
    });
    // Public preview: no session, no x-company-id.
    expect((await preview(ctx, inv.token)).status).toBe(200);

    const r = await accept(ctx, inv.token, { body: { name: 'Ravi', password: PASSWORD } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ companyId: ctx.co.companyId });
    const cookie = cookieFrom(r);
    expect(cookie).toContain('session_token');

    const [u] = await ownerDb.select().from(users).where(eq(users.email, 'ravi@alpha.test'));
    expect(u).toMatchObject({ name: 'Ravi', isPlatformAdmin: false });
    const [m] = await ownerDb.select().from(memberships).where(eq(memberships.userId, u!.id));
    expect(m).toMatchObject({
      companyId: ctx.co.companyId,
      roleId: ctx.co.roleIds.supervisor,
      status: 'active',
    });
    const assigned = await ownerDb
      .select()
      .from(projectAssignments)
      .where(eq(projectAssignments.membershipId, m!.id));
    expect(assigned.map((a) => a.projectId).sort()).toEqual([ctx.p1, ctx.p2].sort());
    const [i] = await ownerDb.select().from(invitations).where(eq(invitations.id, inv.id));
    expect(i!.acceptedAt).toBeInstanceOf(Date);
    const audits = await ownerDb
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'membership.created'));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      companyId: ctx.co.companyId,
      userId: u!.id,
      entity: 'membership',
      entityId: m!.id,
    });

    // The returned cookie is a working session in the new company.
    const me = await req(ctx.app, '/api/company/context', {
      cookie,
      company: ctx.co.companyId,
    });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { role: { name: string } }).role.name).toBe('Supervisor');
  });

  it('accept as a new person validates name and password', async () => {
    const ctx = await setup();
    const inv = await inviteOk(ctx, { email: 'v@alpha.test' });
    const r = await accept(ctx, inv.token, { body: { name: ' ', password: 'short' } });
    expect(r.status).toBe(400);
    const e = await errorOf(r);
    expect(e.code).toBe('validation_failed');
    expect(e.details?.name).toBeTruthy();
    expect(e.details?.password).toBeTruthy();
    expect(await ownerDb.select().from(users).where(eq(users.email, 'v@alpha.test'))).toEqual([]);
  });

  it('double accept → 410 invitation_used', async () => {
    const ctx = await setup();
    const inv = await inviteOk(ctx, { email: 'twice@alpha.test' });
    const first = await accept(ctx, inv.token, { body: { name: 'T', password: PASSWORD } });
    expect(first.status).toBe(200);
    const again = await accept(ctx, inv.token, { body: { name: 'T', password: PASSWORD } });
    expect(again.status).toBe(410);
    expect(await errorOf(again)).toEqual({
      code: 'invitation_used',
      message: 'This invitation has already been used.',
    });
    // Signed in as the invited person: still used.
    const third = await accept(ctx, inv.token, { cookie: cookieFrom(first) });
    expect(third.status).toBe(410);
    expect(await ownerDb.select().from(memberships)).toHaveLength(2); // admin + twice
  });

  it('existing account signed in as the invited email accepts without a body', async () => {
    const ctx = await setup();
    const elsewhere = await seedMember(ctx.other.companyId, 'admin', 'Mira@Alpha.test', {
      app: ctx.app,
    });
    const inv = await inviteOk(ctx, { email: 'MIRA@alpha.test', projectIds: [ctx.p2] });
    const p = await preview(ctx, inv.token);
    expect(((await p.json()) as { hasAccount: boolean }).hasAccount).toBe(true);

    // Not signed in, account exists → 401, nothing created.
    const anon = await accept(ctx, inv.token, { body: { name: 'M', password: PASSWORD } });
    expect(anon.status).toBe(401);
    expect((await errorOf(anon)).code).toBe('unauthenticated');

    const r = await accept(ctx, inv.token, { cookie: elsewhere.cookie });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ companyId: ctx.co.companyId });
    const [m] = await ownerDb
      .select()
      .from(memberships)
      .where(
        and(eq(memberships.userId, elsewhere.userId), eq(memberships.companyId, ctx.co.companyId)),
      );
    expect(m).toMatchObject({ roleId: ctx.co.roleIds.site_engineer });
    const assigned = await ownerDb
      .select()
      .from(projectAssignments)
      .where(eq(projectAssignments.membershipId, m!.id));
    expect(assigned.map((a) => a.projectId)).toEqual([ctx.p2]);
  });

  it('wrong signed-in user → 403 invitation_email_mismatch and no membership', async () => {
    const ctx = await setup();
    const wrong = await seedMember(ctx.other.companyId, 'admin', 'wrong@bravo.test', {
      app: ctx.app,
    });
    const inv = await inviteOk(ctx, { email: 'right@alpha.test' });
    const r = await accept(ctx, inv.token, {
      cookie: wrong.cookie,
      body: { name: 'W', password: PASSWORD },
    });
    expect(r.status).toBe(403);
    expect(await errorOf(r)).toEqual({
      code: 'invitation_email_mismatch',
      message: 'This invitation is for a different email address. Sign out and try again.',
    });
    const ms = await ownerDb
      .select()
      .from(memberships)
      .where(eq(memberships.companyId, ctx.co.companyId));
    expect(ms.map((m) => m.userId)).toEqual([ctx.admin.userId]);
    expect(await ownerDb.select().from(users).where(eq(users.email, 'right@alpha.test'))).toEqual(
      [],
    );
    const [i] = await ownerDb.select().from(invitations).where(eq(invitations.id, inv.id));
    expect(i!.acceptedAt).toBeNull();
  });

  it('existing member invited again → 409 already_member', async () => {
    const ctx = await setup();
    await seedMember(ctx.co.companyId, 'supervisor', 'sup@alpha.test', { signIn: false });
    const r = await invite(ctx, { email: ' SUP@alpha.test' });
    expect(r.status).toBe(409);
    expect(await errorOf(r)).toEqual({
      code: 'already_member',
      message: 'This person is already a member of this company.',
    });
    expect(await ownerDb.select().from(invitations)).toEqual([]);
  });

  it('without users.manage → 403 forbidden', async () => {
    const ctx = await setup();
    const coord = await seedMember(ctx.co.companyId, 'coordinator', 'co@alpha.test', {
      app: ctx.app,
    });
    const r = await invite(ctx, { email: 'x@alpha.test' }, coord.cookie);
    expect(r.status).toBe(403);
    expect(await errorOf(r)).toEqual({
      code: 'forbidden',
      message: 'You do not have permission to do this.',
    });
    // users.view may list; revoke needs users.manage.
    const inv = await inviteOk(ctx, { email: 'y@alpha.test' });
    const list = await req(ctx.app, '/api/invitations', {
      cookie: coord.cookie,
      company: ctx.co.companyId,
    });
    expect(list.status).toBe(200);
    const del = await req(ctx.app, `/api/invitations/${inv.id}`, {
      method: 'DELETE',
      cookie: coord.cookie,
      company: ctx.co.companyId,
    });
    expect(del.status).toBe(403);
    // No users.view at all.
    const se = await seedMember(ctx.co.companyId, 'site_engineer', 'se@alpha.test', {
      app: ctx.app,
    });
    const seList = await req(ctx.app, '/api/invitations', {
      cookie: se.cookie,
      company: ctx.co.companyId,
    });
    expect(seList.status).toBe(403);
    // No session at all.
    const anon = await req(ctx.app, '/api/invitations', { company: ctx.co.companyId });
    expect(anon.status).toBe(401);
  });

  it('token is stored only as a sha-256 hash', async () => {
    const ctx = await setup();
    const inv = await inviteOk(ctx, { email: 'hash@alpha.test' });
    expect(Buffer.from(inv.token, 'base64url')).toHaveLength(32);
    const [row] = await ownerDb.select().from(invitations).where(eq(invitations.id, inv.id));
    expect(row!.tokenHash).not.toBe(inv.token);
    expect(row!.tokenHash).toBe(sha256(inv.token));
    expect(JSON.stringify(row)).not.toContain(inv.token);
  });

  it('roleId or projectIds from another company → 404 not_found', async () => {
    const ctx = await setup();
    const badRole = await invite(ctx, { email: 'a@alpha.test', roleId: ctx.other.roleIds.admin });
    expect(badRole.status).toBe(404);
    expect(await errorOf(badRole)).toEqual({ code: 'not_found', message: 'Not found.' });
    const badProject = await invite(ctx, {
      email: 'b@alpha.test',
      projectIds: [ctx.p1, ctx.otherProject],
    });
    expect(badProject.status).toBe(404);
    expect(await ownerDb.select().from(invitations)).toEqual([]);
    const invalid = await invite(ctx, { email: 'not-an-email', projectIds: ['nope'] });
    expect(invalid.status).toBe(400);
    const e = await errorOf(invalid);
    expect(e.code).toBe('validation_failed');
    expect(e.details?.email).toBeTruthy();
  });

  it('accept re-validates project ids (a project deleted since the invite is skipped)', async () => {
    const ctx = await setup();
    const inv = await inviteOk(ctx, { email: 'pp@alpha.test', projectIds: [ctx.p1, ctx.p2] });
    await ownerDb.delete(projects).where(eq(projects.id, ctx.p2));
    const r = await accept(ctx, inv.token, { body: { name: 'P', password: PASSWORD } });
    expect(r.status).toBe(200);
    const assigned = await ownerDb.select().from(projectAssignments);
    expect(assigned.map((a) => a.projectId)).toEqual([ctx.p1]);
  });

  it('an expired open invitation does not block a new one (it is revoked)', async () => {
    const ctx = await setup();
    const old = await inviteOk(ctx, { email: 'again@alpha.test' });
    await ownerDb
      .update(invitations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invitations.id, old.id));
    const fresh = await inviteOk(ctx, { email: 'again@alpha.test' });
    expect(fresh.id).not.toBe(old.id);
    const [o] = await ownerDb.select().from(invitations).where(eq(invitations.id, old.id));
    expect(o!.revokedAt).toBeInstanceOf(Date);
    expect((await preview(ctx, old.token)).status).toBe(410);
  });

  it('revoke: sets revokedAt, audits, removes from list, then 404', async () => {
    const ctx = await setup();
    const inv = await inviteOk(ctx, { email: 'gone@alpha.test' });
    const del = await req(ctx.app, `/api/invitations/${inv.id}`, {
      method: 'DELETE',
      cookie: ctx.admin.cookie,
      company: ctx.co.companyId,
    });
    expect(del.status).toBe(204);
    const [row] = await ownerDb.select().from(invitations).where(eq(invitations.id, inv.id));
    expect(row!.revokedAt).toBeInstanceOf(Date);
    const audits = await ownerDb
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'invitation.revoked'));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ entityId: inv.id, userId: ctx.admin.userId });
    const list = await req(ctx.app, '/api/invitations', {
      cookie: ctx.admin.cookie,
      company: ctx.co.companyId,
    });
    expect(((await list.json()) as { invitations: unknown[] }).invitations).toEqual([]);
    expect((await preview(ctx, inv.token)).status).toBe(410);
    for (const id of [inv.id, newId(), 'not-a-uuid']) {
      const again = await req(ctx.app, `/api/invitations/${id}`, {
        method: 'DELETE',
        cookie: ctx.admin.cookie,
        company: ctx.co.companyId,
      });
      expect(again.status).toBe(404);
    }
    // Another company's admin cannot revoke it either.
    const inv2 = await inviteOk(ctx, { email: 'keep@alpha.test' });
    const bravoAdmin = await seedMember(ctx.other.companyId, 'admin', 'ad@bravo.test', {
      app: ctx.app,
    });
    const cross = await req(ctx.app, `/api/invitations/${inv2.id}`, {
      method: 'DELETE',
      cookie: bravoAdmin.cookie,
      company: ctx.other.companyId,
    });
    expect(cross.status).toBe(404);
  });

  it('create invitation with an account that already exists elsewhere is allowed', async () => {
    const ctx = await setup();
    await seedUser({ email: 'free@else.test', password: PASSWORD, name: 'F' });
    const r = await invite(ctx, { email: 'free@else.test' });
    expect(r.status).toBe(201);
  });
});
