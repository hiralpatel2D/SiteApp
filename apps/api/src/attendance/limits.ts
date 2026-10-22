import { rateLimit, type RateLimitOptions } from '../http/rate-limit';
import type { TenantEnv } from '../tenant/context';

/**
 * Loose per-IP backstop on the face routes. Many people on one site share a mobile
 * carrier's NAT address, so the real limits are per member (memberLimit).
 */
export const IP_BACKSTOP: RateLimitOptions = { max: 300, windowMs: 60_000 };

/** Per-IP backstop limiter (one bucket set per call). */
export const ipBackstop = () => rateLimit(IP_BACKSTOP);

/** Limits each tenant member separately. Mount after the tenant middleware. */
export const memberLimit = (opts: RateLimitOptions) =>
  rateLimit<TenantEnv>({
    ...opts,
    key: (c) => `member:${c.get('tenant').membershipId}`,
  });
