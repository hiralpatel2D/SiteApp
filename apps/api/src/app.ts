import { Hono } from 'hono';
import { createAuth, makeCanSignUp, normaliseAuthResponse } from './auth/auth';
import { meRoutes } from './auth/me';
import { sessionMiddleware, type AppEnv } from './auth/session';
import type { Config } from './config';
import type { Pools } from './db/pools';
import type { EmailSender } from './email/email';
import { errorHandler, notFoundHandler } from './http/errors';
import { requireSameOrigin } from './http/origin';
import { auditRoutes } from './audit/routes';
import { invitationRoutes } from './invitations/routes';
import { platformRoutes } from './platform/routes';
import { projectRoutes } from './projects/routes';
import { roleRoutes } from './roles/routes';
import { companyContextRoutes } from './tenant/context';
import { userRoutes } from './users/routes';

export type AppDeps = {
  checkDb: () => Promise<boolean>;
  pools: Pools;
  config: Config;
  email: EmailSender;
};

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const auth = createAuth({
    pools: deps.pools,
    config: deps.config,
    email: deps.email,
    canSignUp: makeCanSignUp(deps),
  });

  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.notFound(notFoundHandler);

  app.use('/api/*', requireSameOrigin(deps.config.appBaseUrl));

  app.on(['GET', 'POST'], '/api/auth/*', async (c) =>
    normaliseAuthResponse(await auth.handler(c.req.raw)),
  );

  const api = new Hono<AppEnv>();
  api.get('/health', async (c) => {
    const up = await deps.checkDb();
    return up
      ? c.json({ status: 'ok', db: 'up' }, 200)
      : c.json({ status: 'degraded', db: 'down' }, 503);
  });
  api.use('*', sessionMiddleware(auth));
  api.route('/', meRoutes(deps.pools, auth));
  api.route('/', companyContextRoutes(deps.pools));
  api.route('/invitations', invitationRoutes({ ...deps, auth }));
  api.route('/platform', platformRoutes(deps));
  api.route('/users', userRoutes(deps.pools));
  api.route('/roles', roleRoutes(deps.pools));
  api.route('/projects', projectRoutes(deps.pools));
  api.route('/audit', auditRoutes(deps.pools));
  app.route('/api', api);
  return app;
}
