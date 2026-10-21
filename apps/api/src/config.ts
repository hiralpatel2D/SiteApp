import { z } from 'zod';
import { DEFAULT_FACE_THRESHOLDS, type FaceThresholds } from '@sitediary/shared';

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
  /**
   * First owner account created at start-up when no user has this email yet,
   * with a temporary password that must be changed at first sign-in. Null when
   * BOOTSTRAP_OWNER_EMAIL/BOOTSTRAP_OWNER_PASSWORD are unset.
   */
  bootstrapOwner: { email: string; password: string } | null;
  /** AES-256-GCM key (32 bytes) that encrypts stored face templates. */
  faceTemplateKey: Buffer;
  /** Face recognition engine; `fake` is for e2e tests only and refused in production. */
  faceEngine: 'human' | 'fake';
  /** Face match / liveness minimums (FACE_MATCH_MIN, FACE_LIVENESS_MIN; 0..1). */
  faceThresholds: FaceThresholds;
};

/**
 * Fixed face template key used outside production when FACE_TEMPLATE_KEY is
 * unset. It is public, so it must never protect real templates.
 */
export const DEV_FACE_TEMPLATE_KEY: Buffer = Buffer.from(
  'site-diary-dev-face-key-INSECURE',
  'utf8',
);

/** Minimum length of the temporary bootstrap password (normal passwords need 10). */
export const MIN_BOOTSTRAP_PASSWORD_LENGTH = 8;

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
  BOOTSTRAP_OWNER_EMAIL: z.string().optional(),
  BOOTSTRAP_OWNER_PASSWORD: z.string().optional(),
  FACE_TEMPLATE_KEY: z.string().optional(),
  API_FACE_ENGINE: z.enum(['human', 'fake']).default('human'),
  FACE_MATCH_MIN: z.coerce.number().min(0).max(1).default(DEFAULT_FACE_THRESHOLDS.minSimilarity),
  FACE_LIVENESS_MIN: z.coerce.number().min(0).max(1).default(DEFAULT_FACE_THRESHOLDS.minLiveness),
});

function invalid(name: string): Error {
  return new Error(`Missing or invalid environment variable: ${name}`);
}

function loadBootstrapOwner(
  rawEmail: string | undefined,
  password: string | undefined,
  platformAdminEmails: string[],
): Config['bootstrapOwner'] {
  const email = rawEmail?.trim().toLowerCase() || undefined;
  if (!email && password === undefined) return null;
  if (!email) throw invalid('BOOTSTRAP_OWNER_EMAIL');
  if (password === undefined) throw invalid('BOOTSTRAP_OWNER_PASSWORD');
  if (!platformAdminEmails.includes(email)) {
    throw new Error(
      'Invalid environment variable: BOOTSTRAP_OWNER_EMAIL must be listed in PLATFORM_ADMIN_EMAILS',
    );
  }
  if (password.length < MIN_BOOTSTRAP_PASSWORD_LENGTH) {
    throw new Error(
      `Invalid environment variable: BOOTSTRAP_OWNER_PASSWORD must be at least ${MIN_BOOTSTRAP_PASSWORD_LENGTH} characters`,
    );
  }
  return { email, password };
}

function loadFaceEngine(
  engine: Config['faceEngine'],
  nodeEnv: Config['nodeEnv'],
): Config['faceEngine'] {
  if (engine === 'fake' && nodeEnv === 'production') {
    throw new Error(
      'Invalid environment variable: API_FACE_ENGINE=fake is not allowed in production',
    );
  }
  return engine;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function loadFaceTemplateKey(raw: string | undefined, nodeEnv: Config['nodeEnv']): Buffer {
  if (raw === undefined) {
    if (nodeEnv === 'production') throw invalid('FACE_TEMPLATE_KEY');
    return DEV_FACE_TEMPLATE_KEY;
  }
  const trimmed = raw.trim();
  const key = Buffer.from(trimmed, 'base64');
  if (!BASE64.test(trimmed) || key.length !== 32) {
    throw new Error(
      'Invalid environment variable: FACE_TEMPLATE_KEY must be 32 bytes, base64-encoded',
    );
  }
  return key;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  // Treat empty strings as unset so defaults apply; the face thresholds are also trimmed,
  // so a whitespace-only value is unset too (not coerced to 0).
  const trimmed = new Set(['FACE_MATCH_MIN', 'FACE_LIVENESS_MIN']);
  const cleaned = Object.fromEntries(
    Object.entries(env)
      .map(([k, v]) => [k, trimmed.has(k) ? v?.trim() : v] as const)
      .filter(([, v]) => v !== ''),
  );
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    const name = String(result.error.issues[0]?.path[0] ?? 'environment');
    throw new Error(`Missing or invalid environment variable: ${name}`);
  }
  const e = result.data;
  const platformAdminEmails = e.PLATFORM_ADMIN_EMAILS.split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    migrationDatabaseUrl: e.MIGRATION_DATABASE_URL,
    appDbPassword: e.APP_DB_PASSWORD,
    betterAuthSecret: e.BETTER_AUTH_SECRET,
    appBaseUrl: e.APP_BASE_URL,
    platformAdminEmails,
    bootstrapOwner: loadBootstrapOwner(
      e.BOOTSTRAP_OWNER_EMAIL,
      e.BOOTSTRAP_OWNER_PASSWORD,
      platformAdminEmails,
    ),
    faceTemplateKey: loadFaceTemplateKey(e.FACE_TEMPLATE_KEY, e.NODE_ENV),
    faceEngine: loadFaceEngine(e.API_FACE_ENGINE, e.NODE_ENV),
    faceThresholds: { minSimilarity: e.FACE_MATCH_MIN, minLiveness: e.FACE_LIVENESS_MIN },
  };
}
