// @vitest-environment node
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createWebServer } from '../server.mjs';

let distDir: string;
let fakeApi: Server;
let web: Hono;

beforeAll(async () => {
  distDir = mkdtempSync(join(tmpdir(), 'web-dist-'));
  mkdirSync(join(distDir, 'assets'));
  writeFileSync(join(distDir, 'index.html'), '<html><body><div id="root"></div></body></html>');
  writeFileSync(join(distDir, 'sw.js'), 'console.log("sw")');
  writeFileSync(join(distDir, 'manifest.webmanifest'), '{"name":"Site Diary"}');
  writeFileSync(join(distDir, 'assets', 'app-abc123.js'), 'console.log("app")');

  const api = new Hono();
  api.get('/api/health', (c) => c.json({ status: 'ok', db: 'up' }));
  api.get('/api/cookie', () => {
    const h = new Headers();
    h.append('set-cookie', 'sid=abc; Path=/; HttpOnly');
    h.append('set-cookie', 'theme=dark; Path=/');
    return new Response('ok', { headers: h });
  });
  api.post('/api/echo', async (c) =>
    c.json({
      body: await c.req.json(),
      contentType: c.req.header('content-type'),
      custom: c.req.header('x-custom'),
      host: c.req.header('host'),
    }),
  );
  api.get('/api/headers', (c) => c.json(Object.fromEntries(c.req.raw.headers)));
  api.get('/api/teapot', (c) => c.json({ error: 'nope' }, 418));
  fakeApi = await new Promise<Server>((resolve) => {
    const s = serve({ fetch: api.fetch, port: 0, hostname: '127.0.0.1' }, () =>
      resolve(s as Server),
    );
  });
  const port = (fakeApi.address() as AddressInfo).port;
  web = createWebServer({ distDir, apiUrl: `http://127.0.0.1:${port}` });
});

afterAll(async () => {
  await new Promise((r) => fakeApi.close(r));
  rmSync(distDir, { recursive: true, force: true });
});

describe('web server', () => {
  it('serves index.html for app routes', async () => {
    const r = await web.request('/projects/123');
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('<div id="root">');
  });

  it('serves index.html at / with no-cache', async () => {
    const r = await web.request('/');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-cache');
    expect(r.headers.get('content-type')).toContain('text/html');
  });

  it('serves sw.js and the manifest with correct types', async () => {
    const sw = await web.request('/sw.js');
    expect(sw.status).toBe(200);
    expect(sw.headers.get('content-type')).toContain('javascript');
    expect(sw.headers.get('cache-control')).toBe('no-cache');
    const m = await web.request('/manifest.webmanifest');
    expect(m.status).toBe(200);
    expect(m.headers.get('content-type')).toContain('application/manifest+json');
  });

  it('caches hashed assets for a long time', async () => {
    const r = await web.request('/assets/app-abc123.js');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toContain('immutable');
    expect(r.headers.get('cache-control')).toContain('max-age=31536000');
  });

  it('does not fall back to index.html for missing assets', async () => {
    const r = await web.request('/assets/missing.js');
    expect(r.status).toBe(404);
  });

  it('proxies /api/health', async () => {
    const r = await web.request('/api/health');
    expect(await r.json()).toEqual({ status: 'ok', db: 'up' });
  });

  it('passes Set-Cookie through, including several', async () => {
    const r = await web.request('/api/cookie');
    expect(r.headers.get('set-cookie')).toContain('sid=');
    expect(r.headers.getSetCookie()).toHaveLength(2);
  });

  it('forwards method, headers and body, and drops host', async () => {
    const r = await web.request('/api/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-custom': 'yes', host: 'public.example' },
      body: JSON.stringify({ hello: 'world' }),
    });
    const j = (await r.json()) as {
      body: unknown;
      contentType: string;
      custom: string;
      host: string;
    };
    expect(j.body).toEqual({ hello: 'world' });
    expect(j.custom).toBe('yes');
    expect(j.host).not.toBe('public.example');
  });

  it('sets forwarding headers and identity encoding upstream', async () => {
    const r = await web.request('/api/headers', {
      headers: { 'accept-encoding': 'gzip', 'x-forwarded-for': '203.0.113.9' },
    });
    const h = (await r.json()) as Record<string, string>;
    expect(h['x-forwarded-for']).toBeTruthy();
    expect(h['x-forwarded-for']).toContain('203.0.113.9');
    expect(h['accept-encoding']).toBe('identity');
    expect(h['x-forwarded-proto']).toBe('http');
  });

  it('appends the client socket address on a real connection', async () => {
    const real = await new Promise<Server>((resolve) => {
      const s = serve({ fetch: web.fetch, port: 0, hostname: '127.0.0.1' }, () =>
        resolve(s as Server),
      );
    });
    try {
      const port = (real.address() as AddressInfo).port;
      const r = await fetch(`http://127.0.0.1:${port}/api/headers`);
      const h = (await r.json()) as Record<string, string>;
      expect(h['x-forwarded-for']).toMatch(/127\.0\.0\.1$/);
    } finally {
      await new Promise((res) => real.close(res));
    }
  });

  it('keeps an incoming https x-forwarded-proto', async () => {
    const r = await web.request('/api/headers', { headers: { 'x-forwarded-proto': 'https' } });
    const h = (await r.json()) as Record<string, string>;
    expect(h['x-forwarded-proto']).toBe('https');
  });

  it('returns upstream status codes', async () => {
    const r = await web.request('/api/teapot');
    expect(r.status).toBe(418);
  });

  it('returns 502 JSON when the API is unreachable', async () => {
    const dead = createWebServer({ distDir, apiUrl: 'http://127.0.0.1:1' });
    const r = await dead.request('/api/health');
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({
      error: { code: 'bad_gateway', message: 'The server is not reachable. Try again shortly.' },
    });
  });
});
