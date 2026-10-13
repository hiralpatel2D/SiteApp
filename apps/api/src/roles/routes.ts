import { Hono } from 'hono';
import { and, asc, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  SYSTEM_ROLES,
  createRoleBodySchema,
  newId,
  updateRoleBodySchema,
  type Capability,
} from '@sitediary/shared';
import { writeAudit } from '../audit/audit';
import { requireUser, type AppEnv } from '../auth/session';
import type { Pools } from '../db/pools';
import { isUniqueViolation } from '../db/errors';
import { invitations, memberships, roleCapabilities, roles } from '../db/schema';
import type { AppTx } from '../db/tenant';
import { parseBody } from '../http/body';
import { AppError } from '../http/errors';
import { requireCap, runInTenant, tenantMiddleware, type TenantEnv } from '../tenant/context';
import { SUPER_ADMIN_KEY, assertSuperAdminRemains, systemRoleLocked } from './lockout';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_UNIQUE = 'roles_company_id_name_unique';
/** Capabilities the Super Admin role can never lose (spec §6.3). */
const LOCKED_CAPABILITIES: readonly Capability[] = ['users.manage', 'roles.manage'];

const notFound = () => new AppError(404, 'not_found', 'Not found.');
const staleVersion = () =>
  new AppError(409, 'stale_version', 'Someone else changed this. Reload and try again.');
const nameTaken = () =>
  new AppError(409, 'role_name_taken', 'A role with this name already exists.');

export type RoleListItem = {
  id: string;
  name: string;
  key: string | null;
  isSystem: boolean;
  capabilities: Capability[];
  memberCount: number;
  version: number;
};

const SYSTEM_ORDER = new Map<string, number>(SYSTEM_ROLES.map((r, i) => [r.key, i]));

/** System roles first in `SYSTEM_ROLES` order, then custom roles by name. */
function compareRoles(a: RoleListItem, b: RoleListItem): number {
  const ia = a.key !== null ? (SYSTEM_ORDER.get(a.key) ?? SYSTEM_ORDER.size) : Infinity;
  const ib = b.key !== null ? (SYSTEM_ORDER.get(b.key) ?? SYSTEM_ORDER.size) : Infinity;
  if (ia !== ib) return ia < ib ? -1 : 1;
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

/** The company's roles (or one of them) with capabilities and member counts. */
async function selectRoles(tx: AppTx, companyId: string, roleId?: string): Promise<RoleListItem[]> {
  const roleFilter = roleId
    ? and(eq(roles.companyId, companyId), eq(roles.id, roleId))
    : eq(roles.companyId, companyId);
  const rows = await tx
    .select({
      id: roles.id,
      name: roles.name,
      key: roles.key,
      isSystem: roles.isSystem,
      version: roles.version,
    })
    .from(roles)
    .where(roleFilter);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const caps = await tx
    .select({ roleId: roleCapabilities.roleId, capability: roleCapabilities.capability })
    .from(roleCapabilities)
    .where(and(eq(roleCapabilities.companyId, companyId), inArray(roleCapabilities.roleId, ids)))
    .orderBy(asc(roleCapabilities.capability));
  const counts = await tx
    .select({ roleId: memberships.roleId, n: count() })
    .from(memberships)
    .where(and(eq(memberships.companyId, companyId), inArray(memberships.roleId, ids)))
    .groupBy(memberships.roleId);

  const capsBy = new Map<string, Capability[]>();
  for (const c of caps) {
    const list = capsBy.get(c.roleId) ?? [];
    list.push(c.capability as Capability);
    capsBy.set(c.roleId, list);
  }
  const countBy = new Map(counts.map((c) => [c.roleId, Number(c.n)]));
  return rows
    .map((r) => ({
      ...r,
      capabilities: capsBy.get(r.id) ?? [],
      memberCount: countBy.get(r.id) ?? 0,
    }))
    .sort(compareRoles);
}

async function insertCapabilities(
  tx: AppTx,
  companyId: string,
  roleId: string,
  userId: string,
  capabilities: readonly Capability[],
): Promise<void> {
  if (capabilities.length === 0) return;
  await tx.insert(roleCapabilities).values(
    capabilities.map((capability) => ({
      id: newId(),
      companyId,
      roleId,
      capability,
      createdBy: userId,
      updatedBy: userId,
    })),
  );
}

/** Lock a role row of the tenant's company for the rest of the transaction. */
async function lockRole(tx: AppTx, companyId: string, id: string) {
  const [row] = await tx
    .select({
      id: roles.id,
      name: roles.name,
      key: roles.key,
      isSystem: roles.isSystem,
      version: roles.version,
    })
    .from(roles)
    .where(and(eq(roles.companyId, companyId), eq(roles.id, id)))
    .for('update');
  if (!row) throw notFound();
  return row;
}

async function capabilitiesOf(tx: AppTx, companyId: string, roleId: string) {
  const rows = await tx
    .select({ capability: roleCapabilities.capability })
    .from(roleCapabilities)
    .where(and(eq(roleCapabilities.companyId, companyId), eq(roleCapabilities.roleId, roleId)));
  return rows.map((r) => r.capability as Capability).sort();
}

function roleIdParam(raw: string): string {
  const id = raw.toLowerCase();
  if (!UUID_RE.test(id)) throw notFound();
  return id;
}

/**
 * `/api/roles`: system and custom roles and the permission matrix (each
 * role's capability set). Capabilities are read fresh on every request by
 * `tenantMiddleware`, so edits apply to the role's members on their next request.
 */
export function roleRoutes(pools: Pools): Hono<AppEnv> {
  const r = new Hono<TenantEnv>();
  r.use('*', requireUser, tenantMiddleware(pools));

  r.get('/', requireCap('roles.view'), async (c) => {
    const t = c.get('tenant');
    return c.json(await runInTenant(c, (tx) => selectRoles(tx, t.companyId)));
  });

  r.post('/', requireCap('roles.manage'), async (c) => {
    const body = await parseBody(c, createRoleBodySchema);
    const t = c.get('tenant');
    const capabilities = [...body.capabilities].sort();
    try {
      const created = await runInTenant(c, async (tx) => {
        const id = newId();
        await tx.insert(roles).values({
          id,
          companyId: t.companyId,
          key: null,
          name: body.name,
          isSystem: false,
          createdBy: t.userId,
          updatedBy: t.userId,
        });
        await insertCapabilities(tx, t.companyId, id, t.userId, capabilities);
        await writeAudit(tx, t, {
          action: 'role.created',
          entity: 'role',
          entityId: id,
          after: { name: body.name, capabilities },
        });
        return (await selectRoles(tx, t.companyId, id))[0]!;
      });
      return c.json(created, 201);
    } catch (err) {
      if (isUniqueViolation(err, NAME_UNIQUE)) throw nameTaken();
      throw err;
    }
  });

  r.patch('/:id', requireCap('roles.manage'), async (c) => {
    const id = roleIdParam(c.req.param('id'));
    const body = await parseBody(c, updateRoleBodySchema);
    const t = c.get('tenant');
    try {
      const updated = await runInTenant(c, async (tx) => {
        const role = await lockRole(tx, t.companyId, id);
        if (role.version !== body.version) throw staleVersion();

        const before = await capabilitiesOf(tx, t.companyId, id);
        const nextName = body.name ?? role.name;
        const nextCaps = body.capabilities ? [...body.capabilities].sort() : before;

        if (role.key === SUPER_ADMIN_KEY) {
          if (nextName !== role.name) throw systemRoleLocked();
          if (LOCKED_CAPABILITIES.some((cap) => !nextCaps.includes(cap))) {
            throw systemRoleLocked();
          }
        }

        const nameChanged = nextName !== role.name;
        const capsChanged =
          nextCaps.length !== before.length || nextCaps.some((cap, i) => cap !== before[i]);
        if (!nameChanged && !capsChanged) {
          return (await selectRoles(tx, t.companyId, id))[0]!;
        }

        await tx
          .update(roles)
          .set({
            name: nextName,
            updatedBy: t.userId,
            version: sql`${roles.version} + 1`,
          })
          .where(and(eq(roles.companyId, t.companyId), eq(roles.id, id)));
        if (capsChanged) {
          await tx
            .delete(roleCapabilities)
            .where(
              and(eq(roleCapabilities.companyId, t.companyId), eq(roleCapabilities.roleId, id)),
            );
          await insertCapabilities(tx, t.companyId, id, t.userId, nextCaps);
        }
        await writeAudit(tx, t, {
          action: 'role.updated',
          entity: 'role',
          entityId: id,
          before: { name: role.name, capabilities: before },
          after: { name: nextName, capabilities: nextCaps },
        });
        await assertSuperAdminRemains(tx, t.companyId);
        return (await selectRoles(tx, t.companyId, id))[0]!;
      });
      return c.json(updated);
    } catch (err) {
      if (isUniqueViolation(err, NAME_UNIQUE)) throw nameTaken();
      throw err;
    }
  });

  r.delete('/:id', requireCap('roles.manage'), async (c) => {
    const id = roleIdParam(c.req.param('id'));
    const t = c.get('tenant');
    await runInTenant(c, async (tx) => {
      const role = await lockRole(tx, t.companyId, id);
      if (role.isSystem) {
        throw new AppError(409, 'system_role', 'Built-in roles cannot be deleted.');
      }
      const roleInUse = () =>
        new AppError(409, 'role_in_use', 'Move everyone off this role before deleting it.');
      // Any member, active or deactivated, still holds the role (FK, no cascade).
      const [held] = await tx
        .select({ n: count() })
        .from(memberships)
        .where(and(eq(memberships.companyId, t.companyId), eq(memberships.roleId, id)));
      if (Number(held?.n ?? 0) > 0) throw roleInUse();
      // A pending invitation would make someone a member with this role.
      const [pending] = await tx
        .select({ n: count() })
        .from(invitations)
        .where(
          and(
            eq(invitations.companyId, t.companyId),
            eq(invitations.roleId, id),
            isNull(invitations.acceptedAt),
            isNull(invitations.revokedAt),
            sql`${invitations.expiresAt} > now()`,
          ),
        );
      if (Number(pending?.n ?? 0) > 0) throw roleInUse();

      const capabilities = await capabilitiesOf(tx, t.companyId, id);
      // Spent invitations (accepted, revoked or expired) still reference the
      // role by FK; they are removed with it and listed in the audit row.
      const spent = await tx
        .delete(invitations)
        .where(and(eq(invitations.companyId, t.companyId), eq(invitations.roleId, id)))
        .returning({ id: invitations.id });
      await tx.delete(roles).where(and(eq(roles.companyId, t.companyId), eq(roles.id, id)));
      await writeAudit(tx, t, {
        action: 'role.deleted',
        entity: 'role',
        entityId: id,
        before: {
          name: role.name,
          capabilities,
          ...(spent.length > 0 ? { removedInvitationIds: spent.map((i) => i.id).sort() } : {}),
        },
      });
    });
    return c.body(null, 204);
  });

  return r as unknown as Hono<AppEnv>;
}
