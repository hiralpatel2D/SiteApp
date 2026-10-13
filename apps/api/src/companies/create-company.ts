import {
  SYSTEM_ROLES,
  defaultCapabilities,
  newId,
  slugSchema,
  type SystemRoleKey,
} from '@sitediary/shared';
import type { Db } from '../db/pools';
import { auditLog, companies, roleCapabilities, roles } from '../db/schema';
import { isUniqueViolation } from '../db/errors';
import { AppError } from '../http/errors';

export type CreateCompanyInput = { name: string; slug: string };
export type CreateCompanyResult = { companyId: string; roleIds: Record<SystemRoleKey, string> };

const SLUG_UNIQUE = 'companies_slug_unique';

/**
 * Creates a company with its nine system roles, their default capabilities and
 * an audit entry, in one owner transaction (owner connection bypasses RLS).
 */
export async function createCompany(
  ownerDb: Db,
  input: CreateCompanyInput,
): Promise<CreateCompanyResult> {
  const parsed = slugSchema.safeParse(input.slug);
  if (!parsed.success) {
    throw new AppError(
      400,
      'invalid_slug',
      parsed.error.issues[0]?.message ?? 'Workspace name is not valid.',
    );
  }
  const slug = parsed.data;
  const companyId = newId();
  const roleIds = Object.fromEntries(SYSTEM_ROLES.map((r) => [r.key, newId()])) as Record<
    SystemRoleKey,
    string
  >;

  try {
    await ownerDb.transaction(async (tx) => {
      await tx.insert(companies).values({ id: companyId, name: input.name, slug });
      await tx.insert(roles).values(
        SYSTEM_ROLES.map((r) => ({
          id: roleIds[r.key],
          companyId,
          key: r.key,
          name: r.name,
          isSystem: true,
        })),
      );
      const caps = SYSTEM_ROLES.flatMap((r) =>
        defaultCapabilities(r.key).map((capability) => ({
          id: newId(),
          companyId,
          roleId: roleIds[r.key],
          capability,
        })),
      );
      if (caps.length > 0) await tx.insert(roleCapabilities).values(caps);
      await tx.insert(auditLog).values({
        id: newId(),
        companyId,
        action: 'company.created',
        entity: 'company',
        entityId: companyId,
        after: { name: input.name, slug },
      });
    });
  } catch (err) {
    if (isUniqueViolation(err, SLUG_UNIQUE)) {
      throw new AppError(409, 'slug_taken', 'That workspace name is already in use.');
    }
    throw err;
  }
  return { companyId, roleIds };
}
