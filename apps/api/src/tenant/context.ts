import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { eq } from 'drizzle-orm';
import type pg from 'pg';
import type { Capability } from '@sitediary/shared';
import type { AppEnv } from '../auth/session';
import type { Pools } from '../db/pools';
import { roleCapabilities } from '../db/schema';
import { withTenant, type AppTx } from '../db/tenant';
import { AppError } from '../http/errors';

export type Tenant = {
  companyId: string;
  userId: string;
  membershipId: string;
  roleId: string;
  roleKey: string | null;
  capabilities: Set<Capability>;
};

export type TenantEnv = {
  Variables: AppEnv['Variables'] & {
    tenant: Tenant;
    /** Display data for the resolved company and role. */
    tenantInfo: { companyName: string; companySlug: string; roleName: string };
    appPool: pg.Pool;
  };
};

type MembershipRow = {
  membership_id: string;
  company_id: string;
  company_name: string;
  company_slug: string;
  company_status: string;
  role_id: string;
  role_key: string | null;
  role_name: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves `x-company-id` against the session user's active memberships and
 * loads the role's capabilities fresh (no caching) inside `withTenant`.
 */
export function tenantMiddleware(pools: Pools): MiddlewareHandler<TenantEnv> {
  return async (c, next) => {
    const user = c.get('user');
    if (!user) throw new AppError(401, 'unauthenticated', 'Sign in to continue.');

    const header = c.req.header('x-company-id')?.trim();
    if (!header || !UUID_RE.test(header)) {
      throw new AppError(400, 'company_required', 'Choose a company first.');
    }
    const companyId = header.toLowerCase();

    // SECURITY DEFINER lookup keyed by the session user's id only.
    const { rows } = await pools.app.query<MembershipRow>(
      `select membership_id, company_id, company_name, company_slug, company_status,
              role_id, role_key, role_name
         from app_user_memberships($1)
        where membership_status = 'active' and company_id = $2`,
      [user.id, companyId],
    );
    const m = rows[0];
    if (!m) throw new AppError(403, 'not_a_member', 'You do not have access to this company.');
    if (m.company_status === 'suspended') {
      throw new AppError(
        403,
        'company_suspended',
        "This company's access is suspended. Contact Site Diary support.",
      );
    }

    const caps = await withTenant(pools.app, { companyId, userId: user.id }, (tx) =>
      tx
        .select({ capability: roleCapabilities.capability })
        .from(roleCapabilities)
        .where(eq(roleCapabilities.roleId, m.role_id)),
    );

    c.set('tenant', {
      companyId,
      userId: user.id,
      membershipId: m.membership_id,
      roleId: m.role_id,
      roleKey: m.role_key,
      capabilities: new Set(caps.map((r) => r.capability as Capability)),
    });
    c.set('tenantInfo', {
      companyName: m.company_name,
      companySlug: m.company_slug,
      roleName: m.role_name,
    });
    c.set('appPool', pools.app);
    await next();
  };
}

/** 403 `forbidden` unless the tenant's role has `cap`. Use after `tenantMiddleware`. */
export function requireCap(cap: Capability): MiddlewareHandler<TenantEnv> {
  return async (c, next) => {
    if (!c.get('tenant').capabilities.has(cap)) {
      throw new AppError(403, 'forbidden', 'You do not have permission to do this.');
    }
    await next();
  };
}

/** Runs `fn` in a transaction scoped to the request's tenant (RLS applies). */
export function runInTenant<T>(c: Context<TenantEnv>, fn: (tx: AppTx) => Promise<T>): Promise<T> {
  const t = c.get('tenant');
  return withTenant(c.get('appPool'), { companyId: t.companyId, userId: t.userId }, fn);
}

/** `GET /api/company/context`: the active company, the user's role and capabilities. */
export function companyContextRoutes(pools: Pools): Hono<AppEnv> {
  const r = new Hono<TenantEnv>();
  r.get('/company/context', tenantMiddleware(pools), (c) => {
    const t = c.get('tenant');
    const info = c.get('tenantInfo');
    return c.json({
      company: { id: t.companyId, name: info.companyName, slug: info.companySlug },
      role: { id: t.roleId, name: info.roleName, key: t.roleKey },
      capabilities: [...t.capabilities].sort(),
    });
  });
  return r as unknown as Hono<AppEnv>;
}
