import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { newId } from '@sitediary/shared';
import type { Config } from '../config';
import type { Pools } from '../db/pools';
import { accounts, sessions, users, verifications } from '../db/schema';
import type { EmailSender } from '../email/email';

export const MIN_PASSWORD_LENGTH = 10;

const INVITE_ONLY = {
  code: 'invite_only',
  message: 'Site Diary is invite-only. Ask your company admin for an invitation.',
} as const;

/** Emails are compared and stored trimmed and lowercased (DB CHECK enforces lowercase). */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

function inviteOnlyError(): APIError {
  return new APIError('FORBIDDEN', { code: 'INVITE_ONLY', message: INVITE_ONLY.message });
}

/**
 * Sign-up gate: platform admin emails, or emails with an open invitation in
 * any company (looked up through the SECURITY DEFINER function, since no
 * tenant context exists yet).
 */
export function makeCanSignUp(deps: {
  pools: Pools;
  config: Config;
}): (email: string) => Promise<boolean> {
  return async (raw) => {
    const email = normaliseEmail(raw);
    if (!email) return false;
    if (deps.config.platformAdminEmails.includes(email)) return true;
    const { rows } = await deps.pools.app.query<{ open: boolean }>(
      'select app_open_invitation_exists($1) as open',
      [email],
    );
    return rows[0]?.open === true;
  };
}

export type AuthDeps = {
  pools: Pools;
  config: Config;
  email: EmailSender;
  canSignUp: (email: string) => Promise<boolean>;
};

export function createAuth(deps: AuthDeps) {
  const { config } = deps;
  return betterAuth({
    secret: config.betterAuthSecret,
    baseURL: config.appBaseUrl,
    basePath: '/api/auth',
    trustedOrigins: [config.appBaseUrl],
    telemetry: { enabled: false },
    logger: { level: config.nodeEnv === 'test' ? 'error' : 'warn' },
    // Restricted app_user pool only, never the owner pool.
    database: drizzleAdapter(deps.pools.appDb, {
      provider: 'pg',
      schema: { users, sessions, accounts, verifications },
    }),
    user: {
      modelName: 'users',
      additionalFields: {
        // Server-controlled: never accepted from sign-up or update-user input.
        isPlatformAdmin: { type: 'boolean', input: false, defaultValue: false, required: false },
      },
    },
    session: { modelName: 'sessions' },
    account: { modelName: 'accounts' },
    verification: { modelName: 'verifications' },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, token }) => {
        await deps.email.sendPasswordReset(user.email, {
          resetUrl: `${config.appBaseUrl}/reset-password?token=${encodeURIComponent(token)}`,
        });
      },
    },
    rateLimit: {
      enabled: true,
      storage: 'memory',
      customRules: { '/sign-in/email': { window: 60, max: 5 } },
    },
    advanced: {
      useSecureCookies: config.nodeEnv === 'production',
      // Better Auth skips these checks under NODE_ENV=test by default; keep them on.
      disableOriginCheck: false,
      disableCSRFCheck: false,
      database: { generateId: () => newId() },
      // Set by apps/web/server.mjs from the right-most x-forwarded-for entry
      // (appended by the platform edge); the left-most entry is client-controlled.
      ipAddress: { ipAddressHeaders: ['x-client-ip'] },
    },
    hooks: {
      // Refuse uninvited sign-ups before Better Auth looks the email up, so an
      // existing account's email gets the same answer as an unknown one.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/sign-up/email') return;
        const email: unknown = (ctx.body as { email?: unknown } | undefined)?.email;
        if (typeof email !== 'string') return;
        if (!(await deps.canSignUp(email))) throw inviteOnlyError();
      }),
    },
    databaseHooks: {
      user: {
        create: {
          // Authoritative gate for every user-creation path.
          before: async (user) => {
            const email = normaliseEmail(user.email);
            if (!(await deps.canSignUp(email))) throw inviteOnlyError();
            return {
              data: {
                ...user,
                email,
                isPlatformAdmin: config.platformAdminEmails.includes(email),
              },
            };
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

type ErrorJson = { code: string; message: string; details?: Record<string, string> };

const VALIDATION_FAILED = 'Check the highlighted fields.';

const ORIGIN_CODES = new Set([
  'INVALID_ORIGIN',
  'MISSING_OR_NULL_ORIGIN',
  'CROSS_SITE_NAVIGATION_LOGIN_BLOCKED',
  'INVALID_CALLBACK_URL',
  'INVALID_REDIRECT_URL',
  'INVALID_ERROR_CALLBACK_URL',
  'INVALID_NEW_USER_CALLBACK_URL',
]);

const FIELD_DETAILS: Record<string, Record<string, string>> = {
  PASSWORD_TOO_SHORT: { password: `Use at least ${MIN_PASSWORD_LENGTH} characters.` },
  PASSWORD_TOO_LONG: { password: 'This password is too long.' },
  INVALID_PASSWORD: { password: 'Enter a password.' },
  INVALID_EMAIL: { email: 'Enter a valid email address.' },
  INVALID_TOKEN: { token: 'This link is invalid or has expired. Ask for a new one.' },
};

function validationDetails(code: string | undefined, message: string | undefined) {
  if (code && FIELD_DETAILS[code]) return FIELD_DETAILS[code];
  // Better Auth body-schema failures read like "[body.email] Invalid email address".
  const m = message?.match(/^\[body\.([\w.]+)\]\s*(.*)$/);
  if (m) return { [m[1]!]: m[2] || 'Invalid value.' };
  return undefined;
}

function mapAuthError(
  status: number,
  code: string | undefined,
  message: string | undefined,
): { status: ContentfulStatusCode; error: ErrorJson } {
  const s = status as ContentfulStatusCode;
  if (status === 429) {
    return {
      status: 429,
      error: { code: 'rate_limited', message: 'Too many attempts. Wait a minute and try again.' },
    };
  }
  if (status === 403 && code === 'INVITE_ONLY') return { status: 403, error: { ...INVITE_ONLY } };
  if (status === 403 && code && ORIGIN_CODES.has(code)) {
    return { status: 403, error: { code: 'bad_origin', message: 'Request blocked.' } };
  }
  if (status === 403) {
    return {
      status: 403,
      error: { code: 'forbidden', message: 'You do not have permission to do this.' },
    };
  }
  if (status === 401 && code === 'INVALID_EMAIL_OR_PASSWORD') {
    return {
      status: 401,
      error: { code: 'invalid_credentials', message: 'Email or password is incorrect.' },
    };
  }
  if (status === 401) {
    return { status: 401, error: { code: 'unauthenticated', message: 'Sign in to continue.' } };
  }
  if (status === 400) {
    const details = validationDetails(code, message);
    const error: ErrorJson = { code: 'validation_failed', message: VALIDATION_FAILED };
    if (details) error.details = details;
    return { status: 400, error };
  }
  if (status === 404) return { status: 404, error: { code: 'not_found', message: 'Not found.' } };
  if (status === 405) {
    return {
      status: 405,
      error: { code: 'method_not_allowed', message: 'That action is not allowed here.' },
    };
  }
  if (status >= 500) {
    return {
      status: 500,
      error: { code: 'internal', message: 'Something went wrong. Try again.' },
    };
  }
  return {
    status: s,
    error: {
      code: code ? code.toLowerCase() : 'error',
      message: message ?? 'Something went wrong. Try again.',
    },
  };
}

/**
 * Re-emits Better Auth's 4xx/5xx bodies in our `{ error: { code, message } }`
 * shape, with catalogue copy where a catalogue code applies. Headers (notably
 * every Set-Cookie) are kept. Successful responses pass through untouched.
 */
export async function normaliseAuthResponse(res: Response): Promise<Response> {
  if (res.status < 400) return res;
  let body: { code?: unknown; message?: unknown } = {};
  try {
    const parsed: unknown = await res.clone().json();
    if (parsed && typeof parsed === 'object') body = parsed as typeof body;
  } catch {
    // Not JSON: map by status alone.
  }
  const code = typeof body.code === 'string' ? body.code : undefined;
  const message = typeof body.message === 'string' ? body.message : undefined;
  const mapped = mapAuthError(res.status, code, message);
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify({ error: mapped.error }), {
    status: mapped.status,
    headers,
  });
}

/** Shape of `auth.api.getSession` users, as exposed to route handlers. */
export type SessionUser = { id: string; email: string; name: string; isPlatformAdmin: boolean };
