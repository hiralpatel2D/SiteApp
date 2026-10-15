import { z } from 'zod';
import { CAPABILITIES, type Capability } from './capabilities';
import { projectCodeSchema } from './slug';

/**
 * Request body schemas shared by the API (validation) and the web app (forms).
 * Field messages surface as `details` of a 400 `validation_failed`.
 */

const KNOWN = new Set<string>(CAPABILITIES);

const versionField = z
  .number({ message: 'Reload and try again.' })
  .int('Reload and try again.')
  .min(1, 'Reload and try again.');

/**
 * A list of capability strings: every entry must be a known capability (any
 * unknown entry fails the whole field, keyed `capabilities`); duplicates are
 * dropped, keeping first-seen order.
 */
export const capabilityListSchema = z
  .array(z.unknown(), { message: 'Choose capabilities from the list.' })
  .max(CAPABILITIES.length * 2, 'Choose capabilities from the list.')
  .superRefine((list, ctx) => {
    if (list.some((c) => typeof c !== 'string' || !KNOWN.has(c))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Choose capabilities from the list.' });
    }
  })
  .transform((list) => [...new Set(list as Capability[])]);

export const roleNameSchema = z
  .string({ message: 'Enter a role name.' })
  .trim()
  .min(2, 'Role name must be at least 2 characters.')
  .max(40, 'Role name must be 40 characters or fewer.');

/** `POST /api/roles`. */
export const createRoleBodySchema = z.object({
  name: roleNameSchema,
  capabilities: capabilityListSchema,
});
export type CreateRoleBody = z.infer<typeof createRoleBodySchema>;

/** `PATCH /api/roles/:id`: `capabilities`, when given, replaces the role's whole set. */
export const updateRoleBodySchema = z.object({
  version: versionField,
  name: roleNameSchema.optional(),
  capabilities: capabilityListSchema.optional(),
});
export type UpdateRoleBody = z.infer<typeof updateRoleBodySchema>;

export const MEMBERSHIP_STATUSES = ['active', 'deactivated'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

/** `PATCH /api/users/:membershipId`: `projectIds`, when given, replaces the assignments. */
export const updateUserBodySchema = z.object({
  version: versionField,
  roleId: z.string({ message: 'Choose a role.' }).uuid('Choose a role.').optional(),
  status: z.enum(MEMBERSHIP_STATUSES, { message: 'Choose active or deactivated.' }).optional(),
  projectIds: z
    .array(z.string().uuid('Choose a project from the list.'), {
      message: 'Choose projects from the list.',
    })
    .max(500, 'Too many projects.')
    .transform((ids) => [...new Set(ids.map((id) => id.toLowerCase()))])
    .optional(),
});
export type UpdateUserBody = z.infer<typeof updateUserBodySchema>;

export const PROJECT_STATUSES = ['active', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

const projectNameSchema = z
  .string({ message: 'Enter a project name.' })
  .trim()
  .min(2, 'Project name must be at least 2 characters.')
  .max(80, 'Project name must be 80 characters or fewer.');

const projectLocationSchema = z
  .string({ message: 'Enter a location.' })
  .trim()
  .max(200, 'Location must be 200 characters or fewer.')
  .transform((v) => (v === '' ? null : v));

/** `POST /api/projects`. */
export const createProjectBodySchema = z.object({
  name: projectNameSchema,
  code: projectCodeSchema,
  location: projectLocationSchema.optional(),
});
export type CreateProjectBody = z.infer<typeof createProjectBodySchema>;

/** `PATCH /api/projects/:id`. */
export const updateProjectBodySchema = z.object({
  version: versionField,
  name: projectNameSchema.optional(),
  code: projectCodeSchema.optional(),
  location: projectLocationSchema.nullable().optional(),
  status: z.enum(PROJECT_STATUSES, { message: 'Choose active or archived.' }).optional(),
});
export type UpdateProjectBody = z.infer<typeof updateProjectBodySchema>;

/** `PUT /api/projects/:id/members`: replaces the project's assignments. */
export const setProjectMembersBodySchema = z.object({
  membershipIds: z
    .array(z.string().uuid('Choose people from the list.'), {
      message: 'Choose people from the list.',
    })
    .max(1000, 'Too many people.')
    .transform((ids) => [...new Set(ids.map((id) => id.toLowerCase()))]),
});
export type SetProjectMembersBody = z.infer<typeof setProjectMembersBodySchema>;

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ]([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,6})?)?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?)?$/;

/** Strict ISO date or date-time; the calendar date must exist (no 2026-02-31). */
const isoDateField = (message: string) =>
  z.string({ message }).refine((v) => {
    const m = ISO_RE.exec(v);
    if (!m) return false;
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
  }, message);

/** `GET /api/audit` query. `before` is the opaque cursor from a previous page. */
export const auditQuerySchema = z.object({
  userId: z.string().uuid('Choose a person from the list.').optional(),
  entity: z.string().trim().min(1, 'Enter an entity.').max(64, 'Entity is too long.').optional(),
  from: isoDateField('Enter a valid date.').optional(),
  to: isoDateField('Enter a valid date.').optional(),
  before: z.string().min(1, 'Invalid cursor.').max(200, 'Invalid cursor.').optional(),
  limit: z.coerce
    .number({ message: 'Limit must be between 1 and 100.' })
    .int('Limit must be between 1 and 100.')
    .min(1, 'Limit must be between 1 and 100.')
    .max(100, 'Limit must be between 1 and 100.')
    .default(50),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;
