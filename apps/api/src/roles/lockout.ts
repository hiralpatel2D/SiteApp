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
 * Takes `FOR UPDATE` on the company's Super Admin role row and returns its id.
 * This row lock serialises every change guarded by `assertSuperAdminRemains`.
 *
 * Take it FIRST, before writing any membership: pointing a membership at the
 * Super Admin role makes the FK check take `FOR KEY SHARE` on this row, and
 * two transactions that each hold that share lock and then ask for
 * `FOR UPDATE` deadlock.
 */
export async function lockSuperAdminRole(tx: AppTx, companyId: string): Promise<string> {
  const res = await tx.execute<{ id: string }>(
    sql`select id from roles where company_id = ${companyId} and key = ${SUPER_ADMIN_KEY} for update`,
  );
  const id = res.rows[0]?.id;
  if (!id) throw new Error(`company ${companyId} has no super_admin role`);
  return id;
}

/**
 * Lockout guard. Run inside the same transaction, after a membership change
 * (role or status) or an edit of the Super Admin role: throws 409
 * `last_super_admin` (rolling the transaction back) unless the company still
 * has an active membership whose role key is `super_admin`.
 *
 * Callers must already hold `lockSuperAdminRole` (taken before their writes);
 * it is re-taken here (a no-op within the same transaction) so the guard is
 * never run unlocked. The count is a separate statement, so under READ
 * COMMITTED it sees whatever a competing transaction committed while this one
 * waited for the lock: two concurrent demotions of the last two Super Admins
 * cannot both pass.
 */
export async function assertSuperAdminRemains(tx: AppTx, companyId: string): Promise<void> {
  await lockSuperAdminRole(tx, companyId);
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
