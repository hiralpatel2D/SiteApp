import { Hono } from 'hono';
import { errorHandler, notFoundHandler } from './http/errors';

export type AppDeps = { checkDb: () => Promise<boolean> };

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.onError(errorHandler);
  app.notFound(notFoundHandler);

  const api = new Hono();
  api.get('/health', async (c) => {
    const up = await deps.checkDb();
    return up
      ? c.json({ status: 'ok', db: 'up' }, 200)
      : c.json({ status: 'degraded', db: 'down' }, 503);
  });
  app.route('/api', api);
  return app;
}
