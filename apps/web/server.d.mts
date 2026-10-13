import type { Hono } from 'hono';

export function createWebServer(opts: { distDir: string; apiUrl: string }): Hono;
