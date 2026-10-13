import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { AppError, errorHandler, validationError } from '../src/http/errors';

function appThrowing(err: Error): Hono {
  const app = new Hono();
  app.onError(errorHandler);
  app.get('/x', () => {
    throw err;
  });
  return app;
}

describe('errorHandler', () => {
  it.each([
    [400, 'validation_failed'],
    [401, 'unauthenticated'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [405, 'method_not_allowed'],
    [429, 'rate_limited'],
    [503, 'unavailable'],
  ] as const)('HTTPException %i -> %s', async (status, code) => {
    const res = await appThrowing(new HTTPException(status)).request('/x');
    const body = (await res.json()) as { error: { code: string } };
    expect(res.status).toBe(status);
    expect(body.error.code).toBe(code);
  });

  it('other HTTPException >= 500 is a 500 internal', async () => {
    const res = await appThrowing(new HTTPException(502)).request('/x');
    const body = (await res.json()) as { error: { code: string } };
    expect(res.status).toBe(500);
    expect(body.error.code).toBe('internal');
  });

  it('AppError keeps status, code, message and details', async () => {
    const res = await appThrowing(new AppError(409, 'x', 'y', { a: 'b' })).request('/x');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: 'x', message: 'y', details: { a: 'b' } } });
  });

  it('validationError maps zod paths', () => {
    const e = validationError(
      z.object({ a: z.object({ b: z.string() }) }).safeParse({ a: { b: 1 } }).error!,
    );
    expect(e.status).toBe(400);
    expect(e.code).toBe('validation_failed');
    expect(e.message).toBe('Check the highlighted fields.');
    expect(e.details).toHaveProperty('a.b');
  });
});
