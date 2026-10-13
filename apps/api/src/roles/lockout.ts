import { sql } from 'drizzle-orm';
import type { AppTx } from '../db/tenant';
import { AppError } from '../http/errors';

export const SUPER_ADMIN_KEY = 'super_admin';

export const lastSuperAdmin = () =>
  new AppError(409, 'last_super_admin', 'A company must keep at least one active Super Admin.');

export const systemRoleLocked = () =>
  new AppError(
    409,
    'system_role_locked',
    'The Super Admin role cannot be renamed or lose user and role management.',
  );

/**
 * Lockout guard. Run inside the same transaction, after a membership change
 * (role or status) or a role capability edit: throws 409 `last_super_admin`
 * (rolling the transaction back) unless the company still has an active
 * membership whose role key is `super_admin`.
 *
 * It first takes `FOR UPDATE` on the company's Super Admin role row, which
 * serialises every guarded change in the company. The count is a separate
 * statement, so under READ COMMITTED it sees whatever a competing transaction
 * committed while this one waited for the lock: two concurrent demotions of
 * the last two Super Admins cannot both pass.
 */
export async function assertSuperAdminRemains(tx: AppTx, companyId: string): Promise<void> {
  await tx.execute(
    sql`select id from roles where company_id = ${companyId} and key = ${SUPER_ADMIN_KEY} for update`,
  );
  const res = await tx.execute<{ ok: boolean }>(sql`
    select exists (
      select 1
        from memberships m
        join roles r on r.company_id = m.company_id and r.id = m.role_id
       where m.company_id = ${companyId}
         and m.status = 'active'
         and r.key = ${SUPER_ADMIN_KEY}
    ) as ok`);
  if (!res.rows[0]?.ok) throw lastSuperAdmin();
}
