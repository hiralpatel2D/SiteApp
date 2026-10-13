import type pg from 'pg';
import { DrizzleQueryError, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema';
import type { Db } from './pools';

/** Drizzle transaction handle scoped to one tenant by `withTenant`. */
export type AppTx = Parameters<Parameters<Db['transaction']>[0]>[0];

export type TenantContext = { companyId: string; userId?: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs `fn` in one transaction on one pooled connection with the tenant
 * context set transaction-locally (`set_config(..., true)`), so RLS policies
 * see `app.company_id` and the setting cannot outlive the transaction.
 * Commits on success, rolls back and rethrows on error. Database errors are
 * rethrown as the underlying `pg` error (with its SQLSTATE `code`, e.g. 42501
 * for an RLS violation) rather than Drizzle's wrapper, whose message embeds
 * the query parameters.
 */
export async function withTenant<T>(
  appPool: pg.Pool,
  ctx: TenantContext,
  fn: (tx: AppTx) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(ctx.companyId)) throw new Error('withTenant: companyId must be a UUID');
  if (ctx.userId !== undefined && !UUID_RE.test(ctx.userId)) {
    throw new Error('withTenant: userId must be a UUID');
  }

  const client = await appPool.connect();
  try {
    const result = await drizzle(client, { schema }).transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.company_id', ${ctx.companyId}, true), set_config('app.user_id', ${ctx.userId ?? ''}, true)`,
      );
      return fn(tx);
    });
    client.release();
    return result;
  } catch (err) {
    // We cannot be sure the rollback reached the server, so never hand this
    // connection (possibly still inside the tenant's transaction) to another
    // request: destroy it instead of returning it to the pool.
    client.release(err instanceof Error ? err : true);
    if (err instanceof DrizzleQueryError && err.cause instanceof Error) throw err.cause;
    throw err;
  }
}
