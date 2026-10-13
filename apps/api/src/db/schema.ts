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
  (t) => [unique('projects_company_id_code_unique').on(t.companyId, t.code)],
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
