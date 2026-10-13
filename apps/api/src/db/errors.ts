import { DrizzleQueryError } from 'drizzle-orm';

/**
 * Returns the underlying pg `DatabaseError` when `err` is Drizzle's
 * `DrizzleQueryError` wrapper (whose message embeds query parameters),
 * otherwise `err` unchanged.
 */
export function unwrapDbError(err: unknown): unknown {
  return err instanceof DrizzleQueryError && err.cause instanceof Error ? err.cause : err;
}

/** True when `err` is a Postgres unique violation (23505) on the named constraint. */
export function isUniqueViolation(err: unknown, constraint: string): boolean {
  const cause = unwrapDbError(err);
  if (typeof cause !== 'object' || cause === null) return false;
  const e = cause as { code?: unknown; constraint?: unknown };
  return e.code === '23505' && e.constraint === constraint;
}
