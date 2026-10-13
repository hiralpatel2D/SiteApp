import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));
const RLS_FILE = fileURLToPath(new URL('./rls.sql', import.meta.url));
/** Serialises concurrent migration runs (several instances deploying at once). */
const MIGRATION_LOCK_KEY = 72_410_001;

/**
 * Applies Drizzle migrations, then (re)applies roles, grants and row-level
 * security from rls.sql. Safe to run repeatedly. `ownerUrl` must connect as a
 * superuser or BYPASSRLS role (FORCE ROW LEVEL SECURITY applies to the owner).
 */
export async function runMigrations(
  ownerUrl: string,
  opts: { appDbPassword?: string } = {},
): Promise<void> {
  const appDbPassword = opts.appDbPassword ?? process.env.APP_DB_PASSWORD;
  if (!appDbPassword) throw new Error('Missing or invalid environment variable: APP_DB_PASSWORD');

  const rlsSql = await readFile(RLS_FILE, 'utf8');
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
      await client.query('begin');
      try {
        await client.query(rlsSql);
        // DDL cannot take bind parameters; escapeLiteral quotes the value safely.
        await client.query(`alter role app_user password ${client.escapeLiteral(appDbPassword)}`);
        await client.query('commit');
      } catch (err) {
        await client.query('rollback');
        throw err;
      }
    } finally {
      await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    await client.end();
  }
}

// CLI: `pnpm --filter api db:migrate`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) {
    console.error('Missing or invalid environment variable: MIGRATION_DATABASE_URL');
    process.exit(1);
  }
  runMigrations(url).then(
    () => console.log('Migrations applied.'),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
