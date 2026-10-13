import type { MiddlewareHandler } from 'hono';
import { AppError } from '../http/errors';
import type { Auth, SessionUser } from './auth';

export type AppEnv = { Variables: { user: SessionUser | null } };

/**
 * Resolves the Better Auth session (if any) into `c.var.user`. When Better Auth
 * extends a session nearing expiry (sliding expiry), it returns a refreshed
 * session cookie; that is forwarded on whatever response this request ends
 * with, so active users stay signed in.
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
        ? { id: u.id, email: u.email, name: u.name, isPlatformAdmin: u.isPlatformAdmin === true }
        : null,
    );
    await next();
    // Appended after the handler (and any error handler) has produced the
    // response, so a handler's own Set-Cookie headers are kept alongside it.
    for (const cookie of headers?.getSetCookie() ?? []) {
      c.header('set-cookie', cookie, { append: true });
    }
  };
}

/** 401 `unauthenticated` unless a session user is present. */
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get('user')) throw new AppError(401, 'unauthenticated', 'Sign in to continue.');
  await next();
};
