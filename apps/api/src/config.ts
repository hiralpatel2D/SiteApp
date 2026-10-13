import { z } from 'zod';

export type Config = {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  /** Runtime connection (restricted app_user role). */
  databaseUrl: string;
  /** Migration connection (schema owner role). */
  migrationDatabaseUrl: string;
  /** Password migrations set on the restricted app_user role. */
  appDbPassword: string;
};

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  MIGRATION_DATABASE_URL: z.string().min(1),
  APP_DB_PASSWORD: z.string().min(1),
});

export function loadConfig(env: Record<string, string | undefined>): Config {
  // Treat empty strings as unset so defaults apply.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    const name = String(result.error.issues[0]?.path[0] ?? 'environment');
    throw new Error(`Missing or invalid environment variable: ${name}`);
  }
  const e = result.data;
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    migrationDatabaseUrl: e.MIGRATION_DATABASE_URL,
    appDbPassword: e.APP_DB_PASSWORD,
  };
}
