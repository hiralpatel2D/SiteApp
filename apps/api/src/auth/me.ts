import { Hono } from 'hono';
import { APIError } from 'better-auth/api';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Pools } from '../db/pools';
import { users } from '../db/schema';
import { parseBody } from '../http/body';
import { AppError } from '../http/errors';
import { rateLimit } from '../http/rate-limit';
import { MIN_PASSWORD_LENGTH, type Auth } from './auth';
import { requireUser, type AppEnv } from './session';

type MembershipRow = {
  company_id: string;
  company_name: string;
  company_slug: string;
  company_status: string;
  role_name: string;
  membership_status: string;
};

const VALIDATION_FAILED = 'Check the highlighted fields.';

const passwordBody = z.object({
  currentPassword: z
    .string({ message: 'Enter your current password.' })
    .min(1, 'Enter your current password.'),
  newPassword: z
    .string({ message: `Use at least ${MIN_PASSWORD_LENGTH} characters.` })
    .min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters.`)
    .max(128, 'This password is too long.'),
});

/**
 * `GET /api/me`: the signed-in user and their active company memberships.
 * `POST /api/me/password`: changes the password (verifying the current one),
 * signs out every other session and clears `mustChangePassword`.
 */
export function meRoutes(pools: Pools, auth: Auth): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.get('/me', requireUser, async (c) => {
    const user = c.get('user')!;
    // SECURITY DEFINER lookup: keyed by the session's user id only, ordered by company name.
    const { rows } = await pools.app.query<MembershipRow>(
      `select company_id, company_name, company_slug, company_status, role_name, membership_status
         from app_user_memberships($1)
        where membership_status = 'active'
        order by company_name, company_id`,
      [user.id],
    );
    return c.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        isPlatformAdmin: user.isPlatformAdmin,
        mustChangePassword: user.mustChangePassword,
      },
      memberships: rows.map((m) => ({
        companyId: m.company_id,
        companyName: m.company_name,
        companySlug: m.company_slug,
        companyStatus: m.company_status,
        roleName: m.role_name,
        status: m.membership_status,
      })),
    });
  });

  r.post('/me/password', rateLimit({ max: 5, windowMs: 60_000 }), requireUser, async (c) => {
    const user = c.get('user')!;
    const body = await parseBody(c, passwordBody);
    if (body.newPassword === body.currentPassword) {
      throw new AppError(400, 'validation_failed', VALIDATION_FAILED, {
        newPassword: 'Choose a password different from your current one.',
      });
    }
    let headers: Headers;
    try {
      // Verifies the current password, stores the new hash, deletes every
      // session of this user and issues a fresh one (Set-Cookie below).
      ({ headers } = await auth.api.changePassword({
        body: {
          currentPassword: body.currentPassword,
          newPassword: body.newPassword,
          revokeOtherSessions: true,
        },
        headers: c.req.raw.headers,
        returnHeaders: true,
      }));
    } catch (err) {
      if (err instanceof APIError && err.body?.code === 'INVALID_PASSWORD') {
        throw new AppError(400, 'validation_failed', VALIDATION_FAILED, {
          currentPassword: 'Your current password is not correct.',
        });
      }
      if (err instanceof APIError && err.statusCode === 401) {
        throw new AppError(401, 'unauthenticated', 'Sign in to continue.');
      }
      throw err;
    }
    await pools.appDb.update(users).set({ mustChangePassword: false }).where(eq(users.id, user.id));
    console.log(`Password changed for user ${user.id}.`);
    for (const cookie of headers.getSetCookie()) c.header('set-cookie', cookie, { append: true });
    return c.json({ ok: true });
  });
  return r;
}
