import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { newId } from '@sitediary/shared';

/** Columns every table carries (Global Constraints). */
const common = {
  id: uuid('id')
    .primaryKey()
    .$defaultFn(() => newId()),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  version: integer('version').notNull().default(1),
  createdBy: uuid('created_by'),
  updatedBy: uuid('updated_by'),
};

/** Tenant key. Every tenant table has it and is covered by an RLS policy (rls.sql). */
const companyId = () =>
  uuid('company_id')
    .notNull()
    .references(() => companies.id);

export const companies = pgTable(
  'companies',
  {
    ...common,
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    plan: text('plan').notNull().default('trial'),
    status: text('status').notNull().default('active'),
  },
  (t) => [check('companies_status_check', sql`${t.status} in ('active', 'suspended')`)],
);

export const projects = pgTable(
  'projects',
  {
    ...common,
    companyId: companyId(),
    name: text('name').notNull(),
    code: text('code').notNull(),
    location: text('location'),
    status: text('status').notNull().default('active'),
  },
  (t) => [
    unique('projects_company_id_code_unique').on(t.companyId, t.code),
    // Target for composite FKs (project_assignments) pinning same-company references.
    unique('projects_company_id_id_unique').on(t.companyId, t.id),
  ],
);

export const roles = pgTable(
  'roles',
  {
    ...common,
    companyId: companyId(),
    /** System role key, or null for a custom role. */
    key: text('key'),
    name: text('name').notNull(),
    isSystem: boolean('is_system').notNull().default(false),
  },
  (t) => [
    unique('roles_company_id_name_unique').on(t.companyId, t.name),
    // Target for the composite FK below, so a capability can only point at a
    // role of the same company.
    unique('roles_company_id_id_unique').on(t.companyId, t.id),
  ],
);

export const roleCapabilities = pgTable(
  'role_capabilities',
  {
    ...common,
    companyId: companyId(),
    roleId: uuid('role_id').notNull(),
    capability: text('capability').notNull(),
  },
  (t) => [
    unique('role_capabilities_role_id_capability_unique').on(t.roleId, t.capability),
    // FK checks bypass RLS, so a plain role_id FK would let tenant A attach a
    // capability to tenant B's role. Pin the reference to the same company.
    foreignKey({
      name: 'role_capabilities_role_fk',
      columns: [t.companyId, t.roleId],
      foreignColumns: [roles.companyId, roles.id],
    }).onDelete('cascade'),
  ],
);

export const auditLog = pgTable(
  'audit_log',
  {
    ...common,
    companyId: companyId(),
    userId: uuid('user_id'),
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    entityId: uuid('entity_id'),
    before: jsonb('before'),
    after: jsonb('after'),
  },
  (t) => [index('audit_log_company_id_created_at_idx').on(t.companyId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Identity. users/sessions/accounts/verifications are global (not company
// data, no RLS) and are used by Better Auth through its Drizzle adapter, so
// their TS property names must match Better Auth 1.7's core schema field names
// (@better-auth/core db/get-tables): user{name,email,emailVerified,image},
// session{expiresAt,token,ipAddress,userAgent,userId},
// account{accountId,providerId,userId,accessToken,refreshToken,idToken,
// accessTokenExpiresAt,refreshTokenExpiresAt,scope,password},
// verification{identifier,value,expiresAt}; createdAt/updatedAt come from
// `common`.
// ---------------------------------------------------------------------------

export const users = pgTable(
  'users',
  {
    ...common,
    name: text('name').notNull(),
    email: text('email').notNull().unique(),
    emailVerified: boolean('email_verified').notNull().default(false),
    image: text('image'),
    isPlatformAdmin: boolean('is_platform_admin').notNull().default(false),
  },
  (t) => [check('users_email_lowercase_check', sql`${t.email} = lower(${t.email})`)],
);

export const sessions = pgTable(
  'sessions',
  {
    ...common,
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
  },
  (t) => [index('sessions_user_id_idx').on(t.userId)],
);

export const accounts = pgTable(
  'accounts',
  {
    ...common,
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    password: text('password'),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
  },
  (t) => [index('accounts_user_id_idx').on(t.userId)],
);

export const verifications = pgTable(
  'verifications',
  {
    ...common,
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('verifications_identifier_idx').on(t.identifier)],
);

/** A user's membership of one company, with exactly one role there. */
export const memberships = pgTable(
  'memberships',
  {
    ...common,
    companyId: companyId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    roleId: uuid('role_id').notNull(),
    status: text('status').notNull().default('active'),
  },
  (t) => [
    check('memberships_status_check', sql`${t.status} in ('active', 'deactivated')`),
    unique('memberships_company_id_user_id_unique').on(t.companyId, t.userId),
    unique('memberships_company_id_id_unique').on(t.companyId, t.id),
    index('memberships_user_id_idx').on(t.userId),
    // Same-company role only. No cascade: a role in use cannot be deleted.
    foreignKey({
      name: 'memberships_role_fk',
      columns: [t.companyId, t.roleId],
      foreignColumns: [roles.companyId, roles.id],
    }),
  ],
);

export const projectAssignments = pgTable(
  'project_assignments',
  {
    ...common,
    companyId: companyId(),
    membershipId: uuid('membership_id').notNull(),
    projectId: uuid('project_id').notNull(),
  },
  (t) => [
    unique('project_assignments_membership_id_project_id_unique').on(t.membershipId, t.projectId),
    foreignKey({
      name: 'project_assignments_membership_fk',
      columns: [t.companyId, t.membershipId],
      foreignColumns: [memberships.companyId, memberships.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'project_assignments_project_fk',
      columns: [t.companyId, t.projectId],
      foreignColumns: [projects.companyId, projects.id],
    }).onDelete('cascade'),
  ],
);

export const invitations = pgTable(
  'invitations',
  {
    ...common,
    companyId: companyId(),
    email: text('email').notNull(),
    roleId: uuid('role_id').notNull(),
    /** Not FK-checked (arrays cannot be); validate within the tenant before insert. */
    projectIds: uuid('project_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    /** SHA-256 hex of the invitation token; the token itself is never stored. */
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    invitedBy: uuid('invited_by'),
  },
  (t) => [
    check('invitations_email_lowercase_check', sql`${t.email} = lower(${t.email})`),
    uniqueIndex('invitations_open_company_id_email_unique')
      .on(t.companyId, t.email)
      .where(sql`accepted_at is null and revoked_at is null`),
    foreignKey({
      name: 'invitations_role_fk',
      columns: [t.companyId, t.roleId],
      foreignColumns: [roles.companyId, roles.id],
    }),
  ],
);
