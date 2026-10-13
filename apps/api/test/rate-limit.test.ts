import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createRateLimiter, rateLimit } from '../src/http/rate-limit';
import { errorHandler } from '../src/http/errors';

describe('createRateLimiter', () => {
  it('allows max hits per window per key, then blocks until the window ends', () => {
    let now = 1_000_000;
    const limiter = createRateLimiter({ max: 3, windowMs: 60_000, now: () => now });
    expect([1, 2, 3, 4].map(() => limiter.hit('a'))).toEqual([true, true, true, false]);
    // Another key has its own bucket.
    expect(limiter.hit('b')).toBe(true);
    now += 59_999;
    expect(limiter.hit('a')).toBe(false);
    now += 1;
    expect(limiter.hit('a')).toBe(true);
  });

  it('forgets expired buckets so memory does not grow without bound', () => {
    let now = 0;
    const limiter = createRateLimiter({ max: 1, windowMs: 1000, now: () => now });
    for (let i = 0; i < 50; i++) limiter.hit(`ip-${i}`);
    expect(limiter.size()).toBe(50);
    now += 1000;
    limiter.hit('fresh');
    expect(limiter.size()).toBe(1);
  });
});

describe('rateLimit middleware', () => {
  function app() {
    const a = new Hono();
    a.onError(errorHandler);
    a.get('/x', rateLimit({ max: 2, windowMs: 60_000 }), (c) => c.text('ok'));
    return a;
  }

  it('keys on x-client-ip and answers 429 rate_limited with catalogue copy', async () => {
    const a = app();
    const hit = (ip: string) => a.request('/x', { headers: { 'x-client-ip': ip } });
    expect((await hit('203.0.113.1')).status).toBe(200);
    expect((await hit('203.0.113.1')).status).toBe(200);
    const r = await hit('203.0.113.1');
    expect(r.status).toBe(429);
    expect(await r.json()).toEqual({
      error: { code: 'rate_limited', message: 'Too many attempts. Wait a minute and try again.' },
    });
    expect((await hit('203.0.113.2')).status).toBe(200);
  });
});
