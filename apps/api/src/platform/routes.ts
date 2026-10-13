import { Hono, type Context } from 'hono';
import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { newId } from '@sitediary/shared';
import { normaliseEmail } from '../auth/auth';
import { requireUser, type AppEnv } from '../auth/session';
import { createCompany } from '../companies/create-company';
import type { Config } from '../config';
import type { Pools } from '../db/pools';
import { auditLog, companies, roles } from '../db/schema';
import type { EmailSender } from '../email/email';
import { AppError, validationError } from '../http/errors';
import { createInvitation } from '../invitations/service';

export type PlatformRouteDeps = { pools: Pools; config: Config; email: EmailSender };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const createBody = z.object({
  name: z
    .string({ message: 'Enter the company name.' })
    .trim()
    .min(2, 'Company name must be at least 2 characters.')
    .max(80, 'Company name must be 80 characters or fewer.'),
  slug: z.string({ message: 'Enter a workspace name.' }),
  adminEmail: z
    .string({ message: 'Enter a valid email address.' })
    .trim()
    .toLowerCase()
    .email('Enter a valid email address.')
    .max(254, 'Enter a valid email address.'),
});

async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

/** 403 `forbidden` unless the signed-in user is a platform admin. Use after `requireUser`. */
export const requirePlatformAdmin = async (c: Context<AppEnv>, next: () => Promise<void>) => {
  if (!c.get('user')?.isPlatformAdmin) {
    throw new AppError(403, 'forbidden', 'You do not have permission to do this.');
  }
  await next();
};

/**
 * Platform-admin routes, mounted at `/api/platform`. This is the only request
 * path that uses the owner pool (RLS-bypassing); it never runs in a tenant request.
 */
export function platformRoutes(deps: PlatformRouteDeps): Hono<AppEnv> {
  const db = deps.pools.ownerDb;
  const r = new Hono<AppEnv>();
  r.use('*', requireUser, requirePlatformAdmin);

  r.post('/companies', async (c) => {
    const admin = c.get('user')!;
    const parsed = createBody.safeParse(await jsonBody(c));
    if (!parsed.success) throw validationError(parsed.error);
    const { name, slug, adminEmail } = parsed.data;
    const email = normaliseEmail(adminEmail);

    // Company and Super Admin invitation commit together; the email goes out after.
    const created = await db.transaction(async (tx) => {
      const { companyId, roleIds } = await createCompany(tx, { name, slug }, { actorId: admin.id });
      const inv = await createInvitation(
        tx,
        {
          companyId,
          email,
          roleId: roleIds.super_admin,
          projectIds: [],
          invitedBy: admin.id,
        },
        { appBaseUrl: deps.config.appBaseUrl },
      );
      const [company] = await tx.select().from(companies).where(eq(companies.id, companyId));
      const [role] = await tx
        .select({ name: roles.name })
        .from(roles)
        .where(eq(roles.id, roleIds.super_admin));
      return { company: company!, inv, roleName: role!.name };
    });

    try {
      await deps.email.sendInvitation(email, {
        companyName: created.company.name,
        roleName: created.roleName,
        inviteUrl: created.inv.inviteUrl,
        expiresAt: created.inv.expiresAt,
      });
    } catch (err) {
      // The platform admin still gets the link in the response.
      console.error(
        `Invitation email failed for invitation ${created.inv.invitationId}:`,
        err instanceof Error ? err.name : 'error',
      );
    }
    const { id, slug: savedSlug, status } = created.company;
    return c.json(
      {
        company: { id, name: created.company.name, slug: savedSlug, status },
        inviteUrl: created.inv.inviteUrl,
      },
      201,
    );
  });

  r.get('/companies', async (c) => {
    const rows = await db
      .select({
        id: companies.id,
        name: companies.name,
        slug: companies.slug,
        status: companies.status,
        plan: companies.plan,
        createdAt: companies.createdAt,
        memberCount: sql<number>`(select count(*)::int from memberships m
          where m.company_id = companies.id and m.status = 'active')`,
      })
      .from(companies)
      .orderBy(asc(companies.name), asc(companies.id));
    return c.json(rows.map((x) => ({ ...x, createdAt: x.createdAt.toISOString() })));
  });

  /**
   * Idempotent: setting a status the company already has returns 200 with the
   * company and writes no audit row.
   */
  const setStatus = (to: 'suspended' | 'active', action: string) => async (c: Context<AppEnv>) => {
    const admin = c.get('user')!;
    const id = c.req.param('id') ?? '';
    if (!UUID_RE.test(id)) throw new AppError(404, 'not_found', 'Not found.');
    const company = await db.transaction(async (tx) => {
      const [cur] = await tx.select().from(companies).where(eq(companies.id, id)).for('update');
      if (!cur) throw new AppError(404, 'not_found', 'Not found.');
      if (cur.status === to) return cur;
      const [upd] = await tx
        .update(companies)
        .set({ status: to, updatedBy: admin.id, version: sql`${companies.version} + 1` })
        .where(eq(companies.id, id))
        .returning();
      await tx.insert(auditLog).values({
        id: newId(),
        companyId: id,
        userId: admin.id,
        createdBy: admin.id,
        action,
        entity: 'company',
        entityId: id,
        before: { status: cur.status },
        after: { status: to },
      });
      return upd!;
    });
    return c.json({
      company: { id: company.id, name: company.name, slug: company.slug, status: company.status },
    });
  };
  r.post('/companies/:id/suspend', setStatus('suspended', 'company.suspended'));
  r.post('/companies/:id/reactivate', setStatus('active', 'company.reactivated'));

  return r;
}
