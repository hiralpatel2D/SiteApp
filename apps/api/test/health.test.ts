import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app';

describe('GET /api/health', () => {
  it('reports db up', async () => {
    const res = await createApp({ checkDb: async () => true }).request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', db: 'up' });
  });
  it('reports db down with 503', async () => {
    const res = await createApp({ checkDb: async () => false }).request('/api/health');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'degraded', db: 'down' });
  });
  it('unknown route returns JSON 404', async () => {
    const res = await createApp({ checkDb: async () => true }).request('/api/nope');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_found');
  });
  it('unexpected errors become a generic 500 without a stack', async () => {
    const res = await createApp({
      checkDb: async () => {
        throw new Error('boom secret');
      },
    }).request('/api/health');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: 'internal', message: 'Something went wrong. Try again.' },
    });
  });
});
