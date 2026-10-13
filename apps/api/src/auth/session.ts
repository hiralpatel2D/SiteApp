import type { MiddlewareHandler } from 'hono';
import { AppError } from '../http/errors';
import type { Auth, SessionUser } from './auth';

export type AppEnv = { Variables: { user: SessionUser | null } };

/** Resolves the Better Auth session (if any) into `c.var.user`. */
export function sessionMiddleware(auth: Auth): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    const u = session?.user;
    c.set(
      'user',
      u
        ? { id: u.id, email: u.email, name: u.name, isPlatformAdmin: u.isPlatformAdmin === true }
        : null,
    );
    await next();
  };
}

/** 401 `unauthenticated` unless a session user is present. */
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get('user')) throw new AppError(401, 'unauthenticated', 'Sign in to continue.');
  await next();
};
