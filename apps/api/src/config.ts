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
  /** Better Auth signing/encryption secret (at least 32 characters). */
  betterAuthSecret: string;
  /** Public origin of the web app, e.g. `https://app.sitediary.in` (no trailing slash). */
  appBaseUrl: string;
  /** Emails allowed to self-sign-up; they become platform admins. Lowercased. */
  platformAdminEmails: string[];
};

/** An absolute http(s) origin; a trailing slash is stripped, any other path is rejected. */
const originUrl = z
  .string()
  .transform((v) => v.replace(/\/+$/, ''))
  .refine((v) => {
    try {
      const u = new URL(v);
      return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin === v;
    } catch {
      return false;
    }
  });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  MIGRATION_DATABASE_URL: z.string().min(1),
  APP_DB_PASSWORD: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(32),
  APP_BASE_URL: originUrl,
  PLATFORM_ADMIN_EMAILS: z.string().default(''),
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
    betterAuthSecret: e.BETTER_AUTH_SECRET,
    appBaseUrl: e.APP_BASE_URL,
    platformAdminEmails: e.PLATFORM_ADMIN_EMAILS.split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  };
}
