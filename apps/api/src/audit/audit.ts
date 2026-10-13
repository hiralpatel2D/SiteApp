import { newId } from '@sitediary/shared';
import { auditLog } from '../db/schema';
import type { AppTx } from '../db/tenant';
import type { Tenant } from '../tenant/context';

export type AuditEvent = {
  /** Dotted action name, e.g. `membership.role_changed`. */
  action: string;
  entity: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
};

/** Appends one audit row for the tenant's company and acting user, inside the caller's transaction. */
export async function writeAudit(tx: AppTx, t: Tenant, e: AuditEvent): Promise<void> {
  await tx.insert(auditLog).values({
    id: newId(),
    companyId: t.companyId,
    userId: t.userId,
    createdBy: t.userId,
    action: e.action,
    entity: e.entity,
    entityId: e.entityId ?? null,
    before: e.before ?? null,
    after: e.after ?? null,
  });
}
