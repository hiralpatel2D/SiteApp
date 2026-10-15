import { describe, it, expect, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { bootstrapOwner } from '../src/auth/bootstrap';
import { createCompany } from '../src/companies/create-company';
import { accounts, memberships, sessions, users } from '../src/db/schema';
import { cfg, ownerDb, pools, useTestDb } from './helpers/db';
import { cookieFrom, req, seedUser, signIn, testApp } from './helpers/auth';

useTestDb();

const OWNER = 'owner@sitediary.test';
const TEMP = '123456789';
const NEW_PASSWORD = 'brand-new-password-1';

type ErrorBody = { error: { code: string; message: string; details?: Record<string, string> } };
const errorOf = async (r: Response) => ((await r.json()) as ErrorBody).error;

const PASSWORD_CHANGE_REQUIRED = {
  code: 'password_change_required',
  message: 'Set a new password to continue.',
};

const bootCfg = { ...cfg, bootstrapOwner: { email: OWNER, password: TEMP } };

/** A must-change platform admin, signed in. */
async function flaggedOwner() {
  const u = await seedUser({
    email: OWNER,
    password: TEMP,
    name: 'Owner',
    isPlatformAdmin: true,
    mustChangePassword: true,
  });
  const { app } = testApp();
  const cookie = await signIn(app, OWNER, TEMP);
  return { app, cookie, id: u.id };
}

const changePassword = (
  app: ReturnType<typeof testApp>['app'],
  cookie: string,
  body: unknown,
  opts: { ip?: string } = {},
) => req(app, '/api/me/password', { cookie, body, ip: opts.ip });

describe('bootstrapOwner', () => {
  it('does nothing when not configured', async () => {
    expect(await bootstrapOwner({ pools, config: { ...cfg, bootstrapOwner: null } })).toBe(
      'disabled',
    );
    expect(await ownerDb.select().from(users)).toEqual([]);
  });

  it('creates the owner once, flagged, and the temporary password signs in', async () => {
    const log = vi.fn();
    expect(await bootstrapOwner({ pools, config: bootCfg }, log)).toBe('created');
    expect(log).toHaveBeenCalledWith(
      `Owner account created for ${OWNER}; password change required at first sign-in.`,
    );
    const [u] = await ownerDb.select().from(users);
    expect(u).toMatchObject({
      email: OWNER,
      name: 'Owner',
      isPlatformAdmin: true,
      mustChangePassword: true,
    });
    const accts = await ownerDb.select().from(accounts).where(eq(accounts.userId, u!.id));
    expect(accts).toHaveLength(1);
    expect(accts[0]).toMatchObject({ providerId: 'credential', accountId: u!.id });
    expect(accts[0]!.password).not.toContain(TEMP);

    const { app } = testApp();
    const cookie = await signIn(app, OWNER, TEMP);
    const me = await req(app, '/api/me', { cookie });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: unknown }).user).toMatchObject({
      email: OWNER,
      isPlatformAdmin: true,
      mustChangePassword: true,
    });

    // Second start-up: no second user, no log line.
    const log2 = vi.fn();
    expect(await bootstrapOwner({ pools, config: bootCfg }, log2)).toBe('exists');
    expect(log2).not.toHaveBeenCalled();
    expect(await ownerDb.select().from(users)).toHaveLength(1);
  });

  it('never touches an existing user (password not reset, flag not set)', async () => {
    await seedUser({ email: OWNER, password: 'existing-password-1', name: 'Me' });
    expect(await bootstrapOwner({ pools, config: bootCfg }, () => {})).toBe('exists');
    const [u] = await ownerDb.select().from(users);
    expect(u).toMatchObject({ name: 'Me', mustChangePassword: false });
    const { app } = testApp();
    await signIn(app, OWNER, 'existing-password-1');
    const r = await req(app, '/api/auth/sign-in/email', { body: { email: OWNER, password: TEMP } });
    expect(r.status).toBe(401);
  });

  it('concurrent start-ups create exactly one account', async () => {
    const results = await Promise.all(
      [1, 2, 3].map(() => bootstrapOwner({ pools, config: bootCfg }, () => {})),
    );
    expect(results.filter((r) => r === 'created')).toHaveLength(1);
    expect(await ownerDb.select().from(users)).toHaveLength(1);
    expect(await ownerDb.select().from(accounts)).toHaveLength(1);
  });
});

describe('password change required', () => {
  it('blocks platform and tenant routes but not /api/me', async () => {
    const { app, cookie, id } = await flaggedOwner();
    const co = await createCompany(ownerDb, { name: 'Alpha', slug: 'alpha' });
    await ownerDb
      .insert(memberships)
      .values({ companyId: co.companyId, userId: id, roleId: co.roleIds.admin });

    const platform = await req(app, '/api/platform/companies', { cookie });
    expect(platform.status).toBe(403);
    expect(await errorOf(platform)).toEqual(PASSWORD_CHANGE_REQUIRED);

    const create = await req(app, '/api/platform/companies', {
      cookie,
      body: { name: 'Bravo', slug: 'bravo', adminEmail: 'b@x.test' },
    });
    expect(create.status).toBe(403);
    expect(await errorOf(create)).toEqual(PASSWORD_CHANGE_REQUIRED);

    const context = await req(app, '/api/company/context', { cookie, company: co.companyId });
    expect(context.status).toBe(403);
    expect(await errorOf(context)).toEqual(PASSWORD_CHANGE_REQUIRED);

    const projects = await req(app, '/api/projects', { cookie, company: co.companyId });
    expect(projects.status).toBe(403);
    expect(await errorOf(projects)).toEqual(PASSWORD_CHANGE_REQUIRED);

    const me = await req(app, '/api/me', { cookie });
    expect(me.status).toBe(200);

    // Better Auth routes still answer (get-session, sign-out).
    const s = await req(app, '/api/auth/get-session', { cookie });
    expect(s.status).toBe(200);
  });

  it('users without the flag are not affected', async () => {
    await seedUser({ email: OWNER, password: NEW_PASSWORD, name: 'O', isPlatformAdmin: true });
    const { app } = testApp();
    const cookie = await signIn(app, OWNER, NEW_PASSWORD);
    expect((await req(app, '/api/platform/companies', { cookie })).status).toBe(200);
  });

  it('update-user cannot clear the flag', async () => {
    const { app, cookie, id } = await flaggedOwner();
    await req(app, '/api/auth/update-user', {
      cookie,
      body: { mustChangePassword: false, name: 'Owner' },
    });
    const [u] = await ownerDb.select().from(users).where(eq(users.id, id));
    expect(u!.mustChangePassword).toBe(true);
  });
});

describe('POST /api/me/password', () => {
  it('changes the password, clears the flag and keeps the caller signed in', async () => {
    const { app, cookie, id } = await flaggedOwner();
    const r = await changePassword(app, cookie, {
      currentPassword: TEMP,
      newPassword: NEW_PASSWORD,
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    const [u] = await ownerDb.select().from(users).where(eq(users.id, id));
    expect(u!.mustChangePassword).toBe(false);

    // The response carries the new session cookie, which works everywhere now.
    const fresh = cookieFrom(r);
    expect(fresh).toMatch(/session_token=/);
    const platform = await req(app, '/api/platform/companies', { cookie: fresh });
    expect(platform.status).toBe(200);
    const me = await req(app, '/api/me', { cookie: fresh });
    expect(((await me.json()) as { user: { mustChangePassword: boolean } }).user).toMatchObject({
      mustChangePassword: false,
    });

    // Old password no longer signs in; the new one does.
    const old = await req(app, '/api/auth/sign-in/email', {
      body: { email: OWNER, password: TEMP },
    });
    expect(old.status).toBe(401);
    await signIn(app, OWNER, NEW_PASSWORD);
  });

  it('revokes other sessions', async () => {
    const { app, cookie, id } = await flaggedOwner();
    const other = await signIn(app, OWNER, TEMP);
    expect(await ownerDb.select().from(sessions).where(eq(sessions.userId, id))).toHaveLength(2);
    const r = await changePassword(app, cookie, {
      currentPassword: TEMP,
      newPassword: NEW_PASSWORD,
    });
    expect(r.status).toBe(200);
    expect((await req(app, '/api/me', { cookie: other })).status).toBe(401);
    expect((await req(app, '/api/me', { cookie })).status).toBe(401);
    expect(await ownerDb.select().from(sessions).where(eq(sessions.userId, id))).toHaveLength(1);
  });

  it('wrong current password is 400 with a currentPassword detail; flag stays', async () => {
    const { app, cookie, id } = await flaggedOwner();
    const r = await changePassword(app, cookie, {
      currentPassword: 'not-the-password',
      newPassword: NEW_PASSWORD,
    });
    expect(r.status).toBe(400);
    expect(await errorOf(r)).toEqual({
      code: 'validation_failed',
      message: 'Check the highlighted fields.',
      details: { currentPassword: 'Your current password is not correct.' },
    });
    const [u] = await ownerDb.select().from(users).where(eq(users.id, id));
    expect(u!.mustChangePassword).toBe(true);
    await signIn(app, OWNER, TEMP);
  });

  it('a new password under 10 characters is 400 with a newPassword detail', async () => {
    const { app, cookie } = await flaggedOwner();
    const r = await changePassword(app, cookie, {
      currentPassword: TEMP,
      newPassword: 'short1234',
    });
    expect(r.status).toBe(400);
    const e = await errorOf(r);
    expect(e.code).toBe('validation_failed');
    expect(e.details).toEqual({ newPassword: 'Use at least 10 characters.' });
  });

  it('the new password must differ from the current one', async () => {
    await seedUser({
      email: OWNER,
      password: 'same-password-12',
      name: 'O',
      mustChangePassword: true,
    });
    const { app } = testApp();
    const cookie = await signIn(app, OWNER, 'same-password-12');
    const r = await changePassword(app, cookie, {
      currentPassword: 'same-password-12',
      newPassword: 'same-password-12',
    });
    expect(r.status).toBe(400);
    const e = await errorOf(r);
    expect(e.code).toBe('validation_failed');
    expect(e.details).toEqual({
      newPassword: 'Choose a password different from your current one.',
    });
  });

  it('needs a session', async () => {
    const { app } = testApp();
    const r = await req(app, '/api/me/password', {
      body: { currentPassword: TEMP, newPassword: NEW_PASSWORD },
    });
    expect(r.status).toBe(401);
  });

  it('needs the same origin', async () => {
    const { app, cookie } = await flaggedOwner();
    const r = await req(app, '/api/me/password', {
      cookie,
      origin: 'https://evil.example',
      body: { currentPassword: TEMP, newPassword: NEW_PASSWORD },
    });
    expect(r.status).toBe(403);
    expect((await errorOf(r)).code).toBe('bad_origin');
  });

  it('is rate limited to 5 attempts a minute per client IP', async () => {
    const { app, cookie } = await flaggedOwner();
    const ip = '10.9.9.9';
    for (let i = 0; i < 5; i++) {
      const r = await changePassword(
        app,
        cookie,
        { currentPassword: 'wrong-password', newPassword: NEW_PASSWORD },
        { ip },
      );
      expect(r.status).toBe(400);
    }
    const r = await changePassword(
      app,
      cookie,
      { currentPassword: TEMP, newPassword: NEW_PASSWORD },
      { ip },
    );
    expect(r.status).toBe(429);
    expect((await errorOf(r)).code).toBe('rate_limited');
  });
});
