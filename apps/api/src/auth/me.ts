import { Hono } from 'hono';
import type { Pools } from '../db/pools';
import { requireUser, type AppEnv } from './session';

type MembershipRow = {
  company_id: string;
  company_name: string;
  company_slug: string;
  company_status: string;
  role_name: string;
  membership_status: string;
};

/** `GET /api/me`: the signed-in user and their active company memberships. */
export function meRoutes(pools: Pools): Hono<AppEnv> {
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
  return r;
}
