import { z } from 'zod';

export function normaliseSlug(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

const SLUG_MESSAGE = 'Workspace name must be 3–40 letters, numbers or hyphens.';

export const slugSchema = z
  .string()
  .transform(normaliseSlug)
  .pipe(
    z
      .string()
      .min(3, SLUG_MESSAGE)
      .max(40, SLUG_MESSAGE)
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, SLUG_MESSAGE),
  );

const CODE_MESSAGE = 'Project code must be 2–16 letters, numbers or hyphens, e.g. RT-PH2.';

export const projectCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(
    z
      .string()
      .min(2, CODE_MESSAGE)
      .max(16, CODE_MESSAGE)
      .regex(/^[A-Z0-9]+(-[A-Z0-9]+)*$/, CODE_MESSAGE),
  );
