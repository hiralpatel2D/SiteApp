import { z } from 'zod';
import { CAPABILITIES, type Capability } from './capabilities';

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
