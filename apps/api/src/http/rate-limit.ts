import type { MiddlewareHandler } from 'hono';
import { AppError } from './errors';

export type RateLimitOptions = {
  /** Requests allowed per key in each window. */
  max: number;
  windowMs: number;
  /** Clock, for tests. */
  now?: () => number;
};

export type RateLimiter = {
  /** Records one request for `key`; false once the key is over its limit for this window. */
  hit(key: string): boolean;
  /** Number of keys currently tracked (for tests). */
  size(): number;
};

/**
 * A fixed-window, in-memory rate limiter.
 *
 * Limitation: counts live in this process only. With several `api` replicas
 * (or after a restart) each process counts separately, so the effective limit
 * is `max` × replicas. That is acceptable while `api` runs as one instance;
 * move to a shared store (Postgres/Redis) before scaling out.
 */
export function createRateLimiter(opts: RateLimitOptions): RateLimiter {
  const now = opts.now ?? Date.now;
  const buckets = new Map<string, { count: number; resetAt: number }>();
  let nextSweep = now() + opts.windowMs;

  return {
    hit(key) {
      const t = now();
      // Drop expired buckets at most once per window, so memory stays bounded.
      if (t >= nextSweep) {
        for (const [k, b] of buckets) if (b.resetAt <= t) buckets.delete(k);
        nextSweep = t + opts.windowMs;
      }
      const b = buckets.get(key);
      if (!b || b.resetAt <= t) {
        buckets.set(key, { count: 1, resetAt: t + opts.windowMs });
        return true;
      }
      b.count += 1;
      return b.count <= opts.max;
    },
    size: () => buckets.size,
  };
}

/**
 * Middleware: 429 `rate_limited` once a client IP goes over the limit. The IP
 * comes from `x-client-ip`, which apps/web/server.mjs sets (and never takes
 * from the browser); requests without it share one bucket.
 */
export function rateLimit(opts: RateLimitOptions): MiddlewareHandler {
  const limiter = createRateLimiter(opts);
  return async (c, next) => {
    const ip = c.req.header('x-client-ip')?.trim() || 'unknown';
    if (!limiter.hit(ip)) {
      throw new AppError(429, 'rate_limited', 'Too many attempts. Wait a minute and try again.');
    }
    await next();
  };
}
