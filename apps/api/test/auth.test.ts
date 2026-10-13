import { createHash, randomBytes } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createCompany } from '../src/companies/create-company';
import { invitations, sessions, users } from '../src/db/schema';
import { createAuth, makeCanSignUp, normaliseAuthResponse } from '../src/auth/auth';
import { consoleEmailSender } from '../src/email/email';
import { cfg, ownerDb, pools, useTestDb } from './helpers/db';
import { cookieFrom, recordingEmail, req, seedUser, signIn, signUp, testApp } from './helpers/auth';

useTestDb();

const OWNER = 'owner@sitediary.test';
const PASSWORD = 'longpassword1';

type ErrorBody = { error: { code: string; message: string; details?: Record<string, string> } };
const errorOf = async (r: Response) => ((await r.json()) as ErrorBody).error;

const INVITE_ONLY = {
  code: 'invite_only',
  message: 'Site Diary is invite-only. Ask your company admin for an invitation.',
};

async function invite(
  email: string,
  opts: { expiresAt?: Date; acceptedAt?: Date; revokedAt?: Date } = {},
): Promise<void> {
  const { companyId, roleIds } = await createCompany(ownerDb, {
    name: 'Invite Co',
    slug: `invite-${randomBytes(4).toString('hex')}`,
  });
  await ownerDb.insert(invitations).values({
    companyId,
    email,
    roleId: roleIds.site_engineer,
    tokenHash: createHash('sha256').update(randomBytes(32)).digest('hex'),
    expiresAt: opts.expiresAt ?? new Date(Date.now() + 7 * 864e5),
    acceptedAt: opts.acceptedAt ?? null,
    revokedAt: opts.revokedAt ?? null,
  });
}

const userCount = async () => (await ownerDb.select().from(users)).length;

/** The auth instance as the invitation-accept endpoint will use it (server-side calls). */
const serverAuth = () =>
  createAuth({
    pools,
    config: cfg,
    email: recordingEmail(),
    canSignUp: makeCanSignUp({ pools, config: cfg }),
  });

describe('invite-only sign-up', () => {
  it('signup with a random email is refused as invite_only', async () => {
    const { app } = testApp();
    const r = await req(app, '/api/auth/sign-up/email', {
      body: { email: 'x@y.z', password: PASSWORD, name: 'X' },
    });
    expect(r.status).toBe(403);
    expect(await errorOf(r)).toEqual(INVITE_ONLY);
    expect(await userCount()).toBe(0);
  });

  it('signup for an email that already has an account (not invited) is invite_only too', async () => {
    await seedUser({ email: 'existing@x.test', password: PASSWORD, name: 'E' });
    const { app } = testApp();
    const r = await req(app, '/api/auth/sign-up/email', {
      body: { email: 'existing@x.test', password: PASSWORD, name: 'E' },
    });
    expect(r.status).toBe(403);
    expect(await errorOf(r)).toEqual(INVITE_ONLY);
  });

  it('platform admin email can sign up and is flagged', async () => {
    const { app } = testApp();
    const r = await req(app, '/api/auth/sign-up/email', {
      body: { email: OWNER, password: PASSWORD, name: 'Owner' },
    });
    expect(r.status).toBe(200);
    const rows = await ownerDb.select().from(users);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.isPlatformAdmin).toBe(true);
    const c = cookieFrom(r);
    const me = await req(app, '/api/me', { cookie: c });
    expect(me.status).toBe(200);
    const body = (await me.json()) as { user: { email: string; isPlatformAdmin: boolean } };
    expect(body.user.isPlatformAdmin).toBe(true);
    expect(body.user.email).toBe(OWNER);
  });

  it('stores the email lowercased', async () => {
    const { app } = testApp();
    await signUp(app, { email: 'Owner@SiteDiary.TEST', password: PASSWORD, name: 'Owner' });
    const [u] = await ownerDb.select().from(users);
    expect(u!.email).toBe(OWNER);
    expect(u!.isPlatformAdmin).toBe(true);
  });

  it('gives users UUIDv7 ids', async () => {
    const { app } = testApp();
    await signUp(app, { email: OWNER, password: PASSWORD, name: 'Owner' });
    const [u] = await ownerDb.select().from(users);
    expect(u!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('an email with an open invitation cannot use the public sign-up (R11)', async () => {
    await invite('new.hire@x.test');
    const { app } = testApp();
    const r = await req(app, '/api/auth/sign-up/email', {
      body: { email: 'new.hire@x.test', password: PASSWORD, name: 'N' },
    });
    expect(r.status).toBe(403);
    expect(await errorOf(r)).toEqual(INVITE_ONLY);
    expect(await userCount()).toBe(0);
  });

  it('a server-side signUpEmail for an invited email succeeds, unflagged', async () => {
    await invite('new.hire@x.test');
    const res = await serverAuth().api.signUpEmail({
      body: { email: 'New.Hire@x.test', password: PASSWORD, name: 'N' },
    });
    expect(res.user.email).toBe('new.hire@x.test');
    const rows = await ownerDb.select().from(users);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: 'new.hire@x.test', isPlatformAdmin: false });
    // The account works for normal sign-in.
    const { app } = testApp();
    await signIn(app, 'new.hire@x.test', PASSWORD);
  });

  it('isPlatformAdmin in a sign-up body is ignored', async () => {
    await invite('sneaky@x.test');
    // Not allowed by the endpoint's types; smuggle it in as untyped input.
    const body = { email: 'sneaky@x.test', password: PASSWORD, name: 'S' };
    Object.assign(body, { isPlatformAdmin: true });
    await serverAuth().api.signUpEmail({ body });
    const rows = await ownerDb.select().from(users);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.isPlatformAdmin).toBe(false);
  });

  it('a server-side signUpEmail without an invitation is refused', async () => {
    await expect(
      serverAuth().api.signUpEmail({
        body: { email: 'random@x.test', password: PASSWORD, name: 'R' },
      }),
    ).rejects.toMatchObject({ statusCode: 403, body: { code: 'INVITE_ONLY' } });
    expect(await userCount()).toBe(0);
  });

  it.each([
    ['expired', { expiresAt: new Date(Date.now() - 1000) }],
    ['accepted', { acceptedAt: new Date() }],
    ['revoked', { revokedAt: new Date() }],
  ])('an %s invitation does not allow sign-up', async (_label, opts) => {
    await invite('late@x.test', opts);
    await expect(
      serverAuth().api.signUpEmail({
        body: { email: 'late@x.test', password: PASSWORD, name: 'L' },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(await userCount()).toBe(0);
  });

  it('password shorter than 10 is rejected', async () => {
    const { app } = testApp();
    const r = await req(app, '/api/auth/sign-up/email', {
      body: { email: OWNER, password: 'short1234', name: 'Owner' },
    });
    expect(r.status).toBe(400);
    const e = await errorOf(r);
    expect(e.code).toBe('validation_failed');
    expect(e.message).toBe('Check the highlighted fields.');
    expect(e.details?.password).toBeTruthy();
    expect(await userCount()).toBe(0);
  });

  it('a malformed body from an allowed email is validation_failed', async () => {
    const { app } = testApp();
    const r = await req(app, '/api/auth/sign-up/email', {
      body: { email: OWNER, password: PASSWORD, name: 42 },
    });
    expect(r.status).toBe(400);
    const e = await errorOf(r);
    expect(e.code).toBe('validation_failed');
    expect(e.message).toBe('Check the highlighted fields.');
  });

  it('a malformed email is still invite_only (the gate runs first)', async () => {
    const { app } = testApp();
    const r = await req(app, '/api/auth/sign-up/email', {
      body: { email: 'not-an-email', password: PASSWORD, name: 'X' },
    });
    expect(r.status).toBe(403);
    expect(await errorOf(r)).toEqual(INVITE_ONLY);
  });
});

describe('canSignUp', () => {
  const canSignUp = makeCanSignUp({ pools, config: cfg });
  it('allows platform admin emails, case-insensitively', async () => {
    expect(await canSignUp(' Owner@SiteDiary.test ')).toBe(true);
  });
  it('allows an open invitation and refuses everything else', async () => {
    await invite('a@x.test');
    await invite('b@x.test', { revokedAt: new Date() });
    expect(await canSignUp('A@x.test')).toBe(true);
    expect(await canSignUp('b@x.test')).toBe(false);
    expect(await canSignUp('c@x.test')).toBe(false);
  });
});

describe('sign-in and sessions', () => {
  it('session cookie is HttpOnly and SameSite=Lax', async () => {
    await seedUser({ email: 'u@x.test', password: PASSWORD, name: 'U' });
    const { app } = testApp();
    const r = await req(app, '/api/auth/sign-in/email', {
      body: { email: 'u@x.test', password: PASSWORD },
    });
    expect(r.status).toBe(200);
    const setCookie = r.headers.getSetCookie().find((c) => c.includes('session_token'))!;
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).not.toMatch(/;\s*Secure/i);
  });

  it('session cookie is Secure in production', async () => {
    await seedUser({ email: 'u@x.test', password: PASSWORD, name: 'U' });
    const { app } = testApp({ config: { nodeEnv: 'production' } });
    const r = await req(app, '/api/auth/sign-in/email', {
      body: { email: 'u@x.test', password: PASSWORD },
    });
    expect(r.status).toBe(200);
    const setCookie = r.headers.getSetCookie().find((c) => c.includes('session_token'))!;
    expect(setCookie).toMatch(/;\s*Secure/i);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
  });

  it('sign-in is case-insensitive on email and the cookie authenticates /api/me', async () => {
    await seedUser({ email: 'u@x.test', password: PASSWORD, name: 'U' });
    const { app } = testApp();
    const c = await signIn(app, 'U@X.test', PASSWORD);
    const me = await req(app, '/api/me', { cookie: c });
    expect(me.status).toBe(200);
  });

  it('a wrong password is a 401 in our error shape', async () => {
    await seedUser({ email: 'u@x.test', password: PASSWORD, name: 'U' });
    const { app } = testApp();
    const r = await req(app, '/api/auth/sign-in/email', {
      body: { email: 'u@x.test', password: 'wrongpassword' },
    });
    expect(r.status).toBe(401);
    const e = await errorOf(r);
    expect(e.code).toBe('invalid_credentials');
    expect(e.message).toBe('Email or password is incorrect.');
  });

  it('6th sign-in attempt in a minute is 429', async () => {
    await seedUser({ email: 'u@x.test', password: PASSWORD, name: 'U' });
    const { app } = testApp();
    const ip = '203.0.113.50';
    for (let i = 0; i < 5; i++) {
      const r = await req(app, '/api/auth/sign-in/email', {
        ip,
        body: { email: 'u@x.test', password: 'wrongpassword' },
      });
      expect(r.status).toBe(401);
    }
    const r = await req(app, '/api/auth/sign-in/email', {
      ip,
      body: { email: 'u@x.test', password: PASSWORD },
    });
    expect(r.status).toBe(429);
    expect(await errorOf(r)).toEqual({
      code: 'rate_limited',
      message: 'Too many attempts. Wait a minute and try again.',
    });
    // Another client IP is unaffected.
    const other = await req(app, '/api/auth/sign-in/email', {
      ip: '203.0.113.51',
      body: { email: 'u@x.test', password: PASSWORD },
    });
    expect(other.status).toBe(200);
  });

  it('rate limiting keys on x-client-ip, not a client-supplied x-forwarded-for', async () => {
    await seedUser({ email: 'u@x.test', password: PASSWORD, name: 'U' });
    const { app } = testApp();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await req(app, '/api/auth/sign-in/email', {
        ip: '203.0.113.60',
        headers: { 'x-forwarded-for': `198.51.100.${i + 1}` },
        body: { email: 'u@x.test', password: 'wrongpassword' },
      });
      statuses.push(r.status);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
  });

  it('records the x-client-ip on the session', async () => {
    await seedUser({ email: 'u@x.test', password: PASSWORD, name: 'U' });
    const { app } = testApp();
    const r = await req(app, '/api/auth/sign-in/email', {
      ip: '203.0.113.77',
      body: { email: 'u@x.test', password: PASSWORD },
    });
    expect(r.status).toBe(200);
    const [s] = await ownerDb.select().from(sessions);
    expect(s!.ipAddress).toBe('203.0.113.77');
  });

  it('sign-out ends the session', async () => {
    await seedUser({ email: 'u@x.test', password: PASSWORD, name: 'U' });
    const { app } = testApp();
    const c = await signIn(app, 'u@x.test', PASSWORD);
    const out = await req(app, '/api/auth/sign-out', { cookie: c, body: {} });
    expect(out.status).toBe(200);
    const me = await req(app, '/api/me', { cookie: c });
    expect(me.status).toBe(401);
  });

  it('a cross-origin sign-in is blocked as bad_origin', async () => {
    await seedUser({ email: 'u@x.test', password: PASSWORD, name: 'U' });
    const { app } = testApp();
    const r = await req(app, '/api/auth/sign-in/email', {
      origin: 'https://evil.test',
      body: { email: 'u@x.test', password: PASSWORD },
    });
    expect(r.status).toBe(403);
    expect(await errorOf(r)).toEqual({ code: 'bad_origin', message: 'Request blocked.' });
  });

  it('POST /api/auth/update-user cannot set isPlatformAdmin', async () => {
    const u = await seedUser({ email: 'u@x.test', password: PASSWORD, name: 'U' });
    const { app } = testApp();
    const c = await signIn(app, 'u@x.test', PASSWORD);
    const r = await req(app, '/api/auth/update-user', {
      cookie: c,
      body: { isPlatformAdmin: true },
    });
    expect(r.status).toBe(400);
    expect((await errorOf(r)).code).toBe('validation_failed');
    const [row] = await ownerDb.select().from(users).where(eq(users.id, u.id));
    expect(row!.isPlatformAdmin).toBe(false);
    const me = await req(app, '/api/me', { cookie: c });
    expect(((await me.json()) as { user: { isPlatformAdmin: boolean } }).user.isPlatformAdmin).toBe(
      false,
    );
  });
});

describe('password reset', () => {
  it('password reset: request logs a link; reset with its token lets the user sign in with the new password', async () => {
    await seedUser({ email: 'u@x.test', password: PASSWORD, name: 'U' });
    const { app, email } = testApp();
    const oldSession = await signIn(app, 'u@x.test', PASSWORD);

    const r = await req(app, '/api/auth/request-password-reset', {
      body: { email: 'u@x.test' },
    });
    expect(r.status).toBe(200);
    expect(email.sent).toHaveLength(1);
    const sent = email.sent[0]!;
    expect(sent.kind).toBe('passwordReset');
    expect(sent.to).toBe('u@x.test');
    const resetUrl = (sent.data as { resetUrl: string }).resetUrl;
    const prefix = `${cfg.appBaseUrl}/reset-password?token=`;
    expect(resetUrl.startsWith(prefix)).toBe(true);
    const token = decodeURIComponent(resetUrl.slice(prefix.length));

    const reset = await req(app, '/api/auth/reset-password', {
      body: { token, newPassword: 'brandnewpassword2' },
    });
    expect(reset.status).toBe(200);

    await signIn(app, 'u@x.test', 'brandnewpassword2');
    const old = await req(app, '/api/auth/sign-in/email', {
      body: { email: 'u@x.test', password: PASSWORD },
    });
    expect(old.status).toBe(401);
    // Existing sessions are revoked by a reset.
    expect((await req(app, '/api/me', { cookie: oldSession })).status).toBe(401);
  });

  it('a reset token works only once', async () => {
    await seedUser({ email: 'u@x.test', password: PASSWORD, name: 'U' });
    const { app, email } = testApp();
    await req(app, '/api/auth/request-password-reset', { body: { email: 'u@x.test' } });
    const resetUrl = (email.sent[0]!.data as { resetUrl: string }).resetUrl;
    const token = decodeURIComponent(resetUrl.split('?token=')[1]!);

    const first = await req(app, '/api/auth/reset-password', {
      body: { token, newPassword: 'firstnewpassword1' },
    });
    expect(first.status).toBe(200);
    const second = await req(app, '/api/auth/reset-password', {
      body: { token, newPassword: 'secondnewpassword2' },
    });
    expect(second.status).toBe(400);
    expect((await errorOf(second)).code).toBe('validation_failed');

    await signIn(app, 'u@x.test', 'firstnewpassword1');
    const r = await req(app, '/api/auth/sign-in/email', {
      body: { email: 'u@x.test', password: 'secondnewpassword2' },
    });
    expect(r.status).toBe(401);
  });

  it('an unknown email gets the same 200 and no email', async () => {
    const { app, email } = testApp();
    const r = await req(app, '/api/auth/request-password-reset', {
      body: { email: 'nobody@x.test' },
    });
    expect(r.status).toBe(200);
    expect(email.sent).toHaveLength(0);
  });

  it('a bad reset token is rejected in our error shape', async () => {
    const { app } = testApp();
    const r = await req(app, '/api/auth/reset-password', {
      body: { token: 'nope', newPassword: 'brandnewpassword2' },
    });
    expect(r.status).toBe(400);
    expect((await errorOf(r)).code).toBe('validation_failed');
  });
});

describe('consoleEmailSender', () => {
  it('logs invitation and reset links', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await consoleEmailSender.sendInvitation('a@x.test', {
        companyName: 'C',
        roleName: 'Admin',
        inviteUrl: 'https://app.test/invite/abc',
        expiresAt: new Date(),
      });
      await consoleEmailSender.sendPasswordReset('b@x.test', {
        resetUrl: 'https://app.test/reset-password?token=t',
      });
      expect(log).toHaveBeenCalledWith('Invitation for a@x.test: https://app.test/invite/abc');
      expect(log).toHaveBeenCalledWith(
        'Password reset for b@x.test: https://app.test/reset-password?token=t',
      );
    } finally {
      log.mockRestore();
    }
  });
});

describe('normaliseAuthResponse', () => {
  it('re-emits Better Auth errors in our shape and keeps Set-Cookie', async () => {
    const h = new Headers({ 'content-type': 'application/json' });
    h.append('set-cookie', 'a=1; Path=/; HttpOnly');
    h.append('set-cookie', 'b=; Max-Age=0; Path=/');
    const res = await normaliseAuthResponse(
      new Response(JSON.stringify({ code: 'INVITE_ONLY', message: 'x' }), {
        status: 403,
        headers: h,
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: INVITE_ONLY });
    expect(res.headers.getSetCookie()).toHaveLength(2);
  });

  it('passes successful responses through untouched', async () => {
    const original = new Response('{"ok":true}', { status: 200 });
    expect(await normaliseAuthResponse(original)).toBe(original);
  });

  it('maps unknown 4xx codes to validation_failed without Better Auth text', async () => {
    const res = await normaliseAuthResponse(
      new Response(JSON.stringify({ code: 'SOMETHING_ODD', message: 'odd' }), { status: 422 }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: 'validation_failed', message: 'Check the highlighted fields.' },
    });
  });

  it.each(['USER_ALREADY_EXISTS', 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL'])(
    'maps %s to invite_only (no account enumeration)',
    async (code) => {
      const res = await normaliseAuthResponse(
        new Response(JSON.stringify({ code, message: 'User already exists.' }), { status: 422 }),
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: INVITE_ONLY });
    },
  );
});

describe('cookieFrom', () => {
  it('drops cleared cookies', () => {
    const h = new Headers();
    h.append('set-cookie', 'a=1; Path=/');
    h.append('set-cookie', 'b=; Max-Age=0');
    expect(cookieFrom(new Response(null, { headers: h }))).toBe('a=1');
  });
});
