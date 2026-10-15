import type { MiddlewareHandler } from 'hono';
import { AppError } from '../http/errors';
import type { Auth, SessionUser } from './auth';

export type AppEnv = { Variables: { user: SessionUser | null } };

export const PASSWORD_CHANGE_REQUIRED = {
  code: 'password_change_required',
  message: 'Set a new password to continue.',
} as const;

/**
 * The only routes behind this middleware a user with `mustChangePassword`
 * may call (`/api/auth/*` is handled by Better Auth before it).
 */
const ALLOWED_WHILE_PASSWORD_CHANGE_REQUIRED = new Set(['GET /api/me', 'POST /api/me/password']);

/** Cookie name of a `Set-Cookie` header value. */
const cookieName = (setCookie: string) => setCookie.slice(0, setCookie.indexOf('=')).trim();

/**
 * Resolves the Better Auth session (if any) into `c.var.user`. When Better Auth
 * extends a session nearing expiry (sliding expiry), it returns a refreshed
 * session cookie; that is forwarded on whatever response this request ends
 * with, so active users stay signed in.
 *
 * A user who must change their password gets 403 `password_change_required`
 * on every route except `GET /api/me` and `POST /api/me/password`. The check
 * lives here, ahead of every tenant and platform route, so no route can skip it.
 */
export function sessionMiddleware(auth: Auth): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const { headers, response: session } = await auth.api.getSession({
      headers: c.req.raw.headers,
      returnHeaders: true,
    });
    const u = session?.user;
    c.set(
      'user',
      u
        ? {
            id: u.id,
            email: u.email,
            name: u.name,
            isPlatformAdmin: u.isPlatformAdmin === true,
            mustChangePassword: u.mustChangePassword === true,
          }
        : null,
    );
    const refreshed = headers?.getSetCookie() ?? [];

    if (
      u?.mustChangePassword === true &&
      !ALLOWED_WHILE_PASSWORD_CHANGE_REQUIRED.has(`${c.req.method} ${c.req.path}`)
    ) {
      for (const cookie of refreshed) c.header('set-cookie', cookie, { append: true });
      return c.json({ error: { ...PASSWORD_CHANGE_REQUIRED } }, 403);
    }

    await next();
    // Appended after the handler (and any error handler) has produced the
    // response, so a handler's own Set-Cookie headers are kept alongside it.
    // A cookie the handler already set (e.g. the new session after a password
    // change) wins over the refresh of the old one.
    const own = new Set(c.res.headers.getSetCookie().map(cookieName));
    for (const cookie of refreshed) {
      if (!own.has(cookieName(cookie))) c.header('set-cookie', cookie, { append: true });
    }
  };
}

/** 401 `unauthenticated` unless a session user is present. */
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get('user')) throw new AppError(401, 'unauthenticated', 'Sign in to continue.');
  await next();
};
