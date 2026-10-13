import type { MiddlewareHandler } from 'hono';
import { AppError } from './errors';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF guard: state-changing requests must carry `Origin` equal to the app's
 * own origin. `/api/auth/*` is exempt here because Better Auth runs its own
 * origin and fetch-metadata checks against `trustedOrigins`.
 */
export function requireSameOrigin(appBaseUrl: string): MiddlewareHandler {
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method) || c.req.path.startsWith('/api/auth/')) return next();
    if (c.req.header('origin') !== appBaseUrl) {
      throw new AppError(403, 'bad_origin', 'Request blocked.');
    }
    await next();
  };
}
