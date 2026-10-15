import { and, eq } from 'drizzle-orm';
import type { Capability } from '@sitediary/shared';
import { roleCapabilities, roles } from '../db/schema';
import type { Db } from '../db/pools';
import type { AppTx } from '../db/tenant';
import { AppError } from '../http/errors';
import type { Tenant } from '../tenant/context';
import { SUPER_ADMIN_KEY } from './lockout';

/**
 * Anti-escalation rules (R14, spec §6.3 "Admin: everything except managing
 * Super Admins"). Every violation is 403 `forbidden`.
 *
 * - Only a Super Admin may assign the Super Admin role, move someone off it,
 *   change the status of a Super Admin membership, edit or delete the Super
 *   Admin role, or invite someone as Super Admin.
 * - Nobody may grant a capability they do not hold themselves: not by adding
 *   it to a role, nor by assigning or inviting someone to a role that has it.
 */
export const forbidden = () =>
  new AppError(403, 'forbidden', 'You do not have permission to do this.');

export const isSuperAdmin = (t: Tenant) => t.roleKey === SUPER_ADMIN_KEY;

/** 403 unless the actor holds every capability in `caps`. */
export function assertCanGrant(t: Tenant, caps: Iterable<string>): void {
  for (const cap of caps) {
    if (!t.capabilities.has(cap as Capability)) throw forbidden();
  }
}

/**
 * Reads a role of the company with `FOR KEY SHARE` (so a concurrent delete of
 * it waits, and a role deleted first reads as missing → 404, not an FK error),
 * plus its capability set. Returns undefined when it is not the company's role.
 */
export async function readAssignableRole(
  tx: AppTx | Db,
  companyId: string,
  roleId: string,
): Promise<
  { id: string; name: string; key: string | null; capabilities: Capability[] } | undefined
> {
  const [role] = await tx
    .select({ id: roles.id, name: roles.name, key: roles.key })
    .from(roles)
    .where(and(eq(roles.companyId, companyId), eq(roles.id, roleId)))
    .for('key share');
  if (!role) return undefined;
  const caps = await tx
    .select({ capability: roleCapabilities.capability })
    .from(roleCapabilities)
    .where(and(eq(roleCapabilities.companyId, companyId), eq(roleCapabilities.roleId, roleId)));
  return { ...role, capabilities: caps.map((c) => c.capability as Capability) };
}
