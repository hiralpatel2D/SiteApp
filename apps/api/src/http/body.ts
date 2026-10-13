import type { Context } from 'hono';
import type { z } from 'zod';
import { validationError } from './errors';

/**
 * Reads the JSON body and parses it with `schema`; a missing or malformed body
 * reads as `{}`. Failures throw 400 `validation_failed` with field details.
 */
export async function parseBody<T extends z.ZodTypeAny>(
  c: Context,
  schema: T,
): Promise<z.output<T>> {
  let input: unknown;
  try {
    input = await c.req.json();
  } catch {
    input = {};
  }
  const r = schema.safeParse(input);
  if (!r.success) throw validationError(r.error);
  return r.data;
}
