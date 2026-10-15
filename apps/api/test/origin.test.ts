import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { requireSameOrigin } from '../src/http/origin';
import { errorHandler } from '../src/http/errors';
import { cfg, useTestDb } from './helpers/db';
import { req, testApp } from './helpers/auth';

useTestDb();

const BAD_ORIGIN = { error: { code: 'bad_origin', message: 'Request blocked.' } };

function probe(): Hono {
  const app = new Hono();
  app.onError(errorHandler);
  app.use('/api/*', requireSameOrigin('https://app.sitediary.test'));
  app.all('/api/thing', (c) => c.json({ ok: true }));
  app.all('/api/auth/thing', (c) => c.json({ ok: true }));
  return app;
}

describe('requireSameOrigin', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('%s without Origin is 403 bad_origin', async (m) => {
    const r = await probe().request('/api/thing', { method: m });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual(BAD_ORIGIN);
  });

  it('POST without matching Origin is 403 bad_origin', async () => {
    const r = await probe().request('/api/thing', {
      method: 'POST',
      headers: { origin: 'https://evil.test' },
    });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual(BAD_ORIGIN);
  });

  it('a look-alike origin is rejected', async () => {
    const r = await probe().request('/api/thing', {
      method: 'POST',
      headers: { origin: 'https://app.sitediary.test.evil.test' },
    });
    expect(r.status).toBe(403);
  });

  it('POST with the app origin passes', async () => {
    const r = await probe().request('/api/thing', {
      method: 'POST',
      headers: { origin: 'https://app.sitediary.test' },
    });
    expect(r.status).toBe(200);
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('%s needs no Origin', async (m) => {
    const r = await probe().request('/api/thing', { method: m });
    expect(r.status).toBe(200);
  });

  it('leaves /api/auth/* to Better Auth', async () => {
    const r = await probe().request('/api/auth/thing', { method: 'POST' });
    expect(r.status).toBe(200);
  });

  it('is wired into the app', async () => {
    const { app } = testApp();
    const bad = await req(app, '/api/me', { method: 'POST', origin: null });
    expect(bad.status).toBe(403);
    expect(await bad.json()).toEqual(BAD_ORIGIN);
    const ok = await req(app, '/api/nowhere', { method: 'POST', origin: cfg.appBaseUrl });
    expect(ok.status).toBe(404);
  });
});
