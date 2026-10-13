// Production web server: serves the built PWA, falls back to index.html for
// app routes, and proxies /api/* to the internal API service.
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

const NO_CACHE_FILES = new Set(['/index.html', '/sw.js']);

function cacheControl(urlPath) {
  if (urlPath.startsWith('/assets/')) return 'public, max-age=31536000, immutable';
  if (NO_CACHE_FILES.has(urlPath)) return 'no-cache';
  return 'public, max-age=3600';
}

function badGateway() {
  return new Response(
    JSON.stringify({
      error: { code: 'bad_gateway', message: 'The server is not reachable. Try again shortly.' },
    }),
    { status: 502, headers: { 'content-type': 'application/json; charset=utf-8' } },
  );
}

/** @param {{ distDir: string, apiUrl: string }} opts */
export function createWebServer({ distDir, apiUrl }) {
  const root = resolve(distDir);
  const upstream = apiUrl.replace(/\/+$/, '');
  const app = new Hono();

  app.all('/api/*', async (c) => {
    const incoming = new URL(c.req.url);
    const target = `${upstream}${incoming.pathname}${incoming.search}`;
    const headers = new Headers();
    for (const [k, v] of c.req.raw.headers) {
      if (!HOP_BY_HOP.has(k.toLowerCase())) headers.set(k, v);
    }
    const method = c.req.method;
    const hasBody = method !== 'GET' && method !== 'HEAD';
    try {
      const res = await fetch(target, {
        method,
        headers,
        body: hasBody ? await c.req.arrayBuffer() : undefined,
        redirect: 'manual',
      });
      const out = new Headers();
      for (const [k, v] of res.headers) {
        const key = k.toLowerCase();
        if (HOP_BY_HOP.has(key) || key === 'set-cookie') continue;
        // fetch() has already decoded the body, so drop encoding headers.
        if (key === 'content-encoding' || key === 'content-length') continue;
        out.set(k, v);
      }
      for (const cookie of res.headers.getSetCookie()) out.append('set-cookie', cookie);
      return new Response(res.body, { status: res.status, headers: out });
    } catch {
      return badGateway();
    }
  });

  async function sendFile(file, urlPath) {
    const body = await readFile(file);
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': cacheControl(urlPath),
      },
    });
  }

  app.on(['GET', 'HEAD'], '*', async (c) => {
    let urlPath;
    try {
      urlPath = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      return c.text('Bad request', 400);
    }
    const file = normalize(join(root, urlPath));
    const inside = file === root || file.startsWith(root + sep);
    if (inside && existsSync(file) && statSync(file).isFile()) {
      return sendFile(file, urlPath);
    }
    // Missing files (anything with an extension) are real 404s; app routes get the SPA shell.
    if (extname(urlPath) || urlPath.startsWith('/assets/')) return c.text('Not found', 404);
    return sendFile(join(root, 'index.html'), '/index.html');
  });

  return app;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const here = dirname(fileURLToPath(import.meta.url));
  const port = Number(process.env.PORT ?? 3000);
  const apiUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:3001';
  const app = createWebServer({ distDir: join(here, 'dist'), apiUrl });
  serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {
    console.log(`web listening on :${info.port}, proxying /api to ${apiUrl}`);
  });
}
