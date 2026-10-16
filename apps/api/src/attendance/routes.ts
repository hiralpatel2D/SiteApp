import { Hono } from 'hono';
import { requireUser, type AppEnv } from '../auth/session';
import type { Config } from '../config';
import type { Pools } from '../db/pools';
import { tenantMiddleware, type TenantEnv } from '../tenant/context';
import type { FaceEngine } from './face/engine';
import { settingsRoutes } from './settings';

export type AttendanceDeps = { pools: Pools; config: Config; faceEngine: FaceEngine };

/** `/api/attendance`: face-verified attendance. Later tasks add registration, checks and review. */
export function attendanceRoutes(deps: AttendanceDeps): Hono<AppEnv> {
  const r = new Hono<TenantEnv>();
  r.use('*', requireUser, tenantMiddleware(deps.pools));
  r.route('/settings', settingsRoutes() as unknown as Hono<TenantEnv>);
  return r as unknown as Hono<AppEnv>;
}
