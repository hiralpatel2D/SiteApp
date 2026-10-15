import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { and, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm';
import { newId } from '@sitediary/shared';
import { normaliseEmail } from '../auth/auth';
import { isUniqueViolation } from '../db/errors';
import type { Db } from '../db/pools';
import { invitations, memberships, projectAssignments, projects, users } from '../db/schema';
import type { AppTx } from '../db/tenant';
import { AppError } from '../http/errors';
import { assertCanGrant, forbidden, isSuperAdmin, readAssignableRole } from '../roles/authz';
import { SUPER_ADMIN_KEY } from '../roles/lockout';
import type { Tenant } from '../tenant/context';

/** Invitations expire 7 days after creation (Global Constraints, Fixed values). */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const OPEN_UNIQUE = 'invitations_open_company_id_email_unique';

/** 32 random bytes, base64url (43 characters). */
export function newInvitationToken(): string {
  return randomBytes(32).toString('base64url');
}

/** The only form of the token that is stored: SHA-256, hex. */
export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** True when `token` has the shape `newInvitationToken` produces. */
export function isWellFormedToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

export function inviteUrlFor(appBaseUrl: string, token: string): string {
  return `${appBaseUrl}/invite/${token}`;
}

export const notFound = () => new AppError(404, 'not_found', 'Not found.');

/**
 * Returns the distinct `projectIds` that are projects of `companyId`, in input
 * order. The caller decides whether missing ones are an error.
 */
export async function companyProjectIds(
  tx: AppTx | Db,
  companyId: string,
  projectIds: readonly string[],
): Promise<string[]> {
  const wanted = [...new Set(projectIds)];
  if (wanted.length === 0) return [];
  const rows = await tx
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.companyId, companyId), inArray(projects.id, wanted)));
  const found = new Set(rows.map((r) => r.id));
  return wanted.filter((id) => found.has(id));
}

export type CreateInvitationInput = {
  companyId: string;
  email: string;
  roleId: string;
  projectIds: string[];
  invitedBy: string | null;
  /**
   * The inviting company member. When given, the R14 rules apply: only a
   * Super Admin may invite as Super Admin, and the role may not carry a
   * capability the inviter lacks (403 `forbidden`). The platform-admin
   * bootstrap invitation passes none.
   */
  actor?: Tenant;
};

/**
 * Creates an invitation inside the caller's (tenant) transaction. Returns the
 * link with the plaintext token; only its SHA-256 hash is stored. Expired but
 * still-open invitations for the same email are revoked first (R9).
 */
export async function createInvitation(
  tx: AppTx | Db,
  input: CreateInvitationInput,
  cfg: { appBaseUrl: string },
): Promise<{ invitationId: string; inviteUrl: string; expiresAt: Date }> {
  const email = normaliseEmail(input.email);
  const { companyId } = input;

  // FOR KEY SHARE: a concurrent role delete waits for us, or wins and we 404.
  const role = await readAssignableRole(tx, companyId, input.roleId);
  if (!role) throw notFound();
  if (input.actor) {
    if (role.key === SUPER_ADMIN_KEY && !isSuperAdmin(input.actor)) throw forbidden();
    assertCanGrant(input.actor, role.capabilities);
  }

  const projectIds = [...new Set(input.projectIds)];
  const valid = await companyProjectIds(tx, companyId, projectIds);
  if (valid.length !== projectIds.length) throw notFound();

  const now = new Date();
  await tx
    .update(invitations)
    .set({ revokedAt: now, updatedBy: input.invitedBy, version: sql`${invitations.version} + 1` })
    .where(
      and(
        eq(invitations.companyId, companyId),
        eq(invitations.email, email),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
        lte(invitations.expiresAt, now),
      ),
    );

  const [member] = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.companyId, companyId), eq(users.email, email)));
  if (member) {
    throw new AppError(409, 'already_member', 'This person is already a member of this company.');
  }

  const [pending] = await tx
    .select({ id: invitations.id })
    .from(invitations)
    .where(
      and(
        eq(invitations.companyId, companyId),
        eq(invitations.email, email),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
        gt(invitations.expiresAt, now),
      ),
    );
  if (pending) throw pendingError();

  const token = newInvitationToken();
  const invitationId = newId();
  const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS);
  try {
    // Savepoint, so a lost race on the open-invitation unique index can be
    // reported as `invitation_pending` without aborting the outer transaction.
    await tx.transaction(async (sp) => {
      await sp.insert(invitations).values({
        id: invitationId,
        companyId,
        email,
        roleId: role.id,
        projectIds,
        tokenHash: hashInvitationToken(token),
        expiresAt,
        invitedBy: input.invitedBy,
        createdBy: input.invitedBy,
        updatedBy: input.invitedBy,
      });
    });
  } catch (err) {
    if (isUniqueViolation(err, OPEN_UNIQUE)) throw pendingError();
    throw err;
  }
  return { invitationId, inviteUrl: inviteUrlFor(cfg.appBaseUrl, token), expiresAt };
}

function pendingError(): AppError {
  return new AppError(409, 'invitation_pending', 'This person already has a pending invitation.');
}

export type InvitationLookup = {
  invitationId: string;
  companyId: string;
  companyName: string;
  email: string;
  roleName: string;
  expiresAt: Date;
};

type LookupRow = {
  invitation_id: string;
  company_id: string;
  company_name: string;
  company_status: string;
  email: string;
  role_name: string;
  expires_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
};

/**
 * Resolves a token to a usable invitation through the SECURITY DEFINER lookup
 * (no tenant context yet). Throws 404 for an unknown token, 410 for a used,
 * revoked or expired one, and 403 `company_suspended` for a suspended company.
 */
export async function lookupOpenInvitation(
  appPool: pg.Pool,
  token: string,
): Promise<InvitationLookup> {
  if (!isWellFormedToken(token)) throw notFound();
  const { rows } = await appPool.query<LookupRow>(
    `select invitation_id, company_id, company_name, company_status, email, role_name,
            expires_at, accepted_at, revoked_at
       from app_invitation_lookup($1)`,
    [hashInvitationToken(token)],
  );
  const row = rows[0];
  if (!row) throw notFound();
  if (row.accepted_at) {
    throw new AppError(410, 'invitation_used', 'This invitation has already been used.');
  }
  if (row.revoked_at) {
    throw new AppError(410, 'invitation_revoked', 'This invitation was cancelled.');
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    throw new AppError(
      410,
      'invitation_expired',
      'This invitation has expired. Ask for a new one.',
    );
  }
  if (row.company_status !== 'active') {
    throw new AppError(
      403,
      'company_suspended',
      "This company's access is suspended. Contact Site Diary support.",
    );
  }
  return {
    invitationId: row.invitation_id,
    companyId: row.company_id,
    companyName: row.company_name,
    email: row.email,
    roleName: row.role_name,
    expiresAt: new Date(row.expires_at),
  };
}

/**
 * Inside a tenant transaction for the invitation's company: claims the
 * invitation (sets `accepted_at` only if still open, so concurrent accepts
 * cannot both win), then creates the membership and the project assignments
 * for projects that still belong to the company. Returns the membership.
 */
export async function claimInvitation(
  tx: AppTx,
  input: { invitationId: string; companyId: string; userId: string },
): Promise<{ membershipId: string; roleId: string; projectIds: string[] }> {
  const now = new Date();
  const [inv] = await tx
    .update(invitations)
    .set({ acceptedAt: now, updatedBy: input.userId, version: sql`${invitations.version} + 1` })
    .where(
      and(
        eq(invitations.id, input.invitationId),
        eq(invitations.companyId, input.companyId),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
        gt(invitations.expiresAt, now),
      ),
    )
    .returning({ roleId: invitations.roleId, projectIds: invitations.projectIds });
  if (!inv) throw new AppError(410, 'invitation_used', 'This invitation has already been used.');

  const [existing] = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.companyId, input.companyId), eq(memberships.userId, input.userId)));
  if (existing) {
    throw new AppError(409, 'already_member', 'This person is already a member of this company.');
  }

  const membershipId = newId();
  await tx.insert(memberships).values({
    id: membershipId,
    companyId: input.companyId,
    userId: input.userId,
    roleId: inv.roleId,
    status: 'active',
    createdBy: input.userId,
    updatedBy: input.userId,
  });

  const projectIds = await companyProjectIds(tx, input.companyId, inv.projectIds);
  if (projectIds.length > 0) {
    await tx.insert(projectAssignments).values(
      projectIds.map((projectId) => ({
        id: newId(),
        companyId: input.companyId,
        membershipId,
        projectId,
        createdBy: input.userId,
        updatedBy: input.userId,
      })),
    );
  }
  return { membershipId, roleId: inv.roleId, projectIds };
}
