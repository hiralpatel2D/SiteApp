import { Hono, type Context } from 'hono';
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { writeAudit } from '../audit/audit';
import {
  MIN_PASSWORD_LENGTH,
  normaliseAuthResponse,
  normaliseEmail,
  type Auth,
} from '../auth/auth';
import { requireUser, type AppEnv } from '../auth/session';
import type { Config } from '../config';
import type { Pools } from '../db/pools';
import { invitations, roles } from '../db/schema';
import { withTenant } from '../db/tenant';
import type { EmailSender } from '../email/email';
import { AppError, validationError } from '../http/errors';
import { rateLimit } from '../http/rate-limit';
import { requireCap, runInTenant, tenantMiddleware, type TenantEnv } from '../tenant/context';
import { claimInvitation, createInvitation, lookupOpenInvitation, notFound } from './service';

export type InvitationRouteDeps = {
  pools: Pools;
  config: Config;
  email: EmailSender;
  auth: Auth;
};

/** Spec §10: invite endpoints are rate-limited per client IP. */
const PREVIEW_LIMIT = { max: 20, windowMs: 60_000 };
const ACCEPT_LIMIT = { max: 5, windowMs: 60_000 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const createBody = z.object({
  email: z
    .string({ message: 'Enter a valid email address.' })
    .trim()
    .toLowerCase()
    .email('Enter a valid email address.')
    .max(254, 'Enter a valid email address.'),
  roleId: z.string({ message: 'Choose a role.' }).uuid('Choose a role.'),
  projectIds: z
    .array(z.string().uuid('Choose a project from the list.'))
    .max(500, 'Too many projects.')
    .default([]),
});

const acceptBody = z.object({
  name: z
    .string({ message: 'Enter your name.' })
    .trim()
    .min(1, 'Enter your name.')
    .max(200, 'This name is too long.'),
  password: z
    .string({ message: 'Enter a password.' })
    .min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters.`)
    .max(128, 'This password is too long.'),
});

/** Reads a JSON body; a missing or malformed body reads as `{}`. */
async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (!r.success) throw validationError(r.error);
  return r.data;
}

/**
 * Public by-token routes: the invite landing page's preview and the accept
 * action. No `x-company-id`; the token resolves the company.
 */
function byTokenRoutes(deps: InvitationRouteDeps): Hono<AppEnv> {
  const { pools, auth } = deps;
  const r = new Hono<AppEnv>();

  r.get('/:token', rateLimit(PREVIEW_LIMIT), async (c) => {
    const inv = await lookupOpenInvitation(pools.app, c.req.param('token'));
    const { rows } = await pools.app.query<{ exists: boolean }>(
      'select exists (select 1 from users where email = $1) as exists',
      [inv.email],
    );
    return c.json({
      companyName: inv.companyName,
      email: inv.email,
      roleName: inv.roleName,
      expiresAt: inv.expiresAt.toISOString(),
      hasAccount: rows[0]?.exists === true,
    });
  });

  r.post('/:token/accept', rateLimit(ACCEPT_LIMIT), async (c) => {
    const inv = await lookupOpenInvitation(pools.app, c.req.param('token'));
    const user = c.get('user');
    let userId: string;
    let setCookies: string[] = [];

    if (user) {
      if (normaliseEmail(user.email) !== inv.email) {
        throw new AppError(
          403,
          'invitation_email_mismatch',
          'This invitation is for a different email address. Sign out and try again.',
        );
      }
      userId = user.id;
    } else {
      const { rows } = await pools.app.query<{ exists: boolean }>(
        'select exists (select 1 from users where email = $1) as exists',
        [inv.email],
      );
      // An account exists: the web app asks them to sign in, then accept.
      if (rows[0]?.exists) throw new AppError(401, 'unauthenticated', 'Sign in to continue.');

      const body = parse(acceptBody, await jsonBody(c));
      // Server-side call without `request`: skips the public sign-up gate,
      // which is for platform admins only; the DB create hook still requires
      // an open invitation for this email.
      const res = await auth.api.signUpEmail({
        body: { email: inv.email, password: body.password, name: body.name },
        asResponse: true,
      });
      if (!res.ok) return normaliseAuthResponse(res);
      const created = (await res.json()) as { user?: { id?: string } };
      if (!created.user?.id) throw new Error('signUpEmail returned no user');
      userId = created.user.id;
      setCookies = res.headers.getSetCookie();
    }

    // If this fails after the account was created, the invitation stays open
    // (the transaction rolls back), so signing in and accepting again works.
    await withTenant(pools.app, { companyId: inv.companyId, userId }, async (tx) => {
      const m = await claimInvitation(tx, {
        invitationId: inv.invitationId,
        companyId: inv.companyId,
        userId,
      });
      await writeAudit(
        tx,
        {
          companyId: inv.companyId,
          userId,
          membershipId: m.membershipId,
          roleId: m.roleId,
          roleKey: null,
          capabilities: new Set(),
        },
        {
          action: 'membership.created',
          entity: 'membership',
          entityId: m.membershipId,
          after: {
            userId,
            roleId: m.roleId,
            projectIds: m.projectIds,
            invitationId: inv.invitationId,
          },
        },
      );
      return m;
    });

    for (const cookie of setCookies) c.header('set-cookie', cookie, { append: true });
    return c.json({ companyId: inv.companyId });
  });

  return r;
}

/** Tenant routes: create, list and revoke invitations in the active company. */
function tenantRoutes(deps: InvitationRouteDeps): Hono<AppEnv> {
  const r = new Hono<TenantEnv>();
  r.use('*', requireUser, tenantMiddleware(deps.pools));

  r.post('/', requireCap('users.manage'), async (c) => {
    const body = parse(createBody, await jsonBody(c));
    const t = c.get('tenant');
    const created = await runInTenant(c, async (tx) => {
      const inv = await createInvitation(
        tx,
        {
          companyId: t.companyId,
          email: body.email,
          roleId: body.roleId,
          projectIds: body.projectIds,
          invitedBy: t.userId,
          actor: t,
        },
        { appBaseUrl: deps.config.appBaseUrl },
      );
      const [role] = await tx
        .select({ name: roles.name })
        .from(roles)
        .where(eq(roles.id, body.roleId));
      await writeAudit(tx, t, {
        action: 'invitation.created',
        entity: 'invitation',
        entityId: inv.invitationId,
        after: {
          email: body.email,
          roleId: body.roleId,
          projectIds: [...new Set(body.projectIds)],
          expiresAt: inv.expiresAt.toISOString(),
        },
      });
      return { ...inv, roleName: role!.name };
    });

    try {
      await deps.email.sendInvitation(body.email, {
        companyName: c.get('tenantInfo').companyName,
        roleName: created.roleName,
        inviteUrl: created.inviteUrl,
        expiresAt: created.expiresAt,
      });
    } catch (err) {
      // The admin still gets the link in the response and can share it.
      console.error(
        `Invitation email failed for invitation ${created.invitationId}:`,
        err instanceof Error ? err.name : 'error',
      );
    }

    return c.json(
      {
        id: created.invitationId,
        email: body.email,
        roleName: created.roleName,
        inviteUrl: created.inviteUrl,
        expiresAt: created.expiresAt.toISOString(),
      },
      201,
    );
  });

  r.get('/', requireCap('users.view'), async (c) => {
    const rows = await runInTenant(c, (tx) =>
      tx
        .select({
          id: invitations.id,
          email: invitations.email,
          roleId: invitations.roleId,
          roleName: roles.name,
          projectIds: invitations.projectIds,
          expiresAt: invitations.expiresAt,
          createdAt: invitations.createdAt,
        })
        .from(invitations)
        .innerJoin(
          roles,
          and(eq(roles.companyId, invitations.companyId), eq(roles.id, invitations.roleId)),
        )
        .where(
          and(
            isNull(invitations.acceptedAt),
            isNull(invitations.revokedAt),
            gt(invitations.expiresAt, sql`now()`),
          ),
        )
        .orderBy(asc(invitations.createdAt), asc(invitations.id)),
    );
    return c.json({
      invitations: rows.map((i) => ({
        ...i,
        expiresAt: i.expiresAt.toISOString(),
        createdAt: i.createdAt.toISOString(),
      })),
    });
  });

  r.delete('/:id', requireCap('users.manage'), async (c) => {
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) throw notFound();
    const t = c.get('tenant');
    await runInTenant(c, async (tx) => {
      const [row] = await tx
        .update(invitations)
        .set({
          revokedAt: new Date(),
          updatedBy: t.userId,
          version: sql`${invitations.version} + 1`,
        })
        .where(
          and(
            eq(invitations.id, id),
            isNull(invitations.acceptedAt),
            isNull(invitations.revokedAt),
          ),
        )
        .returning({ id: invitations.id, email: invitations.email });
      if (!row) throw notFound();
      await writeAudit(tx, t, {
        action: 'invitation.revoked',
        entity: 'invitation',
        entityId: row.id,
        before: { email: row.email },
      });
    });
    return c.body(null, 204);
  });

  return r as unknown as Hono<AppEnv>;
}

/**
 * `/api/invitations`. The public by-token routes are registered before the
 * tenant routes' `use('*')` middleware so they never require a session or
 * `x-company-id` (a by-token handler always responds, ending the chain).
 */
export function invitationRoutes(deps: InvitationRouteDeps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.route('/by-token', byTokenRoutes(deps));
  r.route('/', tenantRoutes(deps));
  return r;
}
