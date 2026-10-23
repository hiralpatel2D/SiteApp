import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Config } from '../config';
import * as schema from './schema';

export type Schema = typeof schema;
export type Db = NodePgDatabase<Schema>;

export type Pools = {
  /** Owner/migration role (superuser or BYPASSRLS). Platform admin, seeding and migrations only. */
  owner: pg.Pool;
  /** Restricted app_user role. All tenant requests go through `withTenant(app, ...)`. */
  app: pg.Pool;
  ownerDb: Db;
  /** Without tenant context, RLS makes every tenant table look empty. */
  appDb: Db;
  /** Signs "view as" tokens (the Super Admin's read-only preview of another person). */
  viewAsSecret: string;
};

function makePool(connectionString: string, name: string): pg.Pool {
  const pool = new pg.Pool({ connectionString });
  // An idle client erroring (e.g. DB restart) must not crash the process.
  pool.on('error', (err) => console.error(`Postgres ${name} pool error: ${err.message}`));
  return pool;
}

export function createPools(cfg: Config): Pools {
  const owner = makePool(cfg.migrationDatabaseUrl, 'owner');
  const app = makePool(cfg.databaseUrl, 'app');
  return {
    owner,
    app,
    ownerDb: drizzle(owner, { schema }),
    appDb: drizzle(app, { schema }),
    viewAsSecret: cfg.betterAuthSecret,
  };
}
