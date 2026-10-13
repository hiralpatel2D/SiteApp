import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { auditQuerySchema } from '@sitediary/shared';
import { requireUser, type AppEnv } from '../auth/session';
import type { Pools } from '../db/pools';
import { AppError, validationError } from '../http/errors';
import { requireCap, runInTenant, tenantMiddleware, type TenantEnv } from '../tenant/context';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

type Row = {
  id: string;
  at: string;
  userName: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
};

const badCursor = () =>
  new AppError(400, 'validation_failed', 'Check the highlighted fields.', {
    before: 'Invalid cursor.',
  });

/** Cursor = base64url("<created_at, microsecond ISO>|<id>"). Opaque to clients. */
const encodeCursor = (at: string, id: string) => Buffer.from(`${at}|${id}`).toString('base64url');
function decodeCursor(raw: string): { at: string; id: string } {
  const [at, id, ...rest] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  if (rest.length > 0 || !at || !id || !CURSOR_AT_RE.test(at) || !UUID_RE.test(id)) {
    throw badCursor();
  }
  return { at, id };
}

/** `/api/audit`: the company's audit log, newest first. */
export function auditRoutes(pools: Pools): Hono<AppEnv> {
  const r = new Hono<TenantEnv>();
  r.use('*', requireUser, tenantMiddleware(pools));

  r.get('/', requireCap('audit.view'), async (c) => {
    const parsed = auditQuerySchema.safeParse(c.req.query());
    if (!parsed.success) throw validationError(parsed.error);
    const q = parsed.data;
    const cursor = q.before ? decodeCursor(q.before) : undefined;
    const t = c.get('tenant');
    const dateOnly = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
    // Zone-less values are UTC, whatever the DB session timezone is.
    const instant = (v: string) =>
      /(Z|[+-]\d{2}:?\d{2})$/.test(v) && v.length > 10
        ? sql`${v}::timestamptz`
        : sql`(${v}::timestamp at time zone 'utc')`;

    const rows = await runInTenant(c, async (tx) => {
      const res = await tx.execute<Row & { cursorAt: string }>(sql`
        select a.id,
               to_char(a.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorAt",
               u.name as "userName", a.action, a.entity, a.entity_id as "entityId",
               a.before, a.after
          from audit_log a
          left join users u on u.id = a.user_id
         where a.company_id = ${t.companyId}
           ${q.userId ? sql`and a.user_id = ${q.userId}` : sql``}
           ${q.entity ? sql`and a.entity = ${q.entity}` : sql``}
           ${q.from ? sql`and a.created_at >= ${instant(q.from)}` : sql``}
           ${
             q.to
               ? dateOnly(q.to)
                 ? sql`and a.created_at < ((${q.to}::date + 1)::timestamp at time zone 'utc')`
                 : sql`and a.created_at <= ${instant(q.to)}`
               : sql``
           }
           ${
             cursor
               ? sql`and (a.created_at, a.id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
               : sql``
           }
         order by a.created_at desc, a.id desc
         limit ${q.limit + 1}`);
      return res.rows;
    });

    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return c.json({
      items: page.map(({ cursorAt, ...row }) => ({ ...row, at: cursorAt })),
      nextCursor: rows.length > q.limit && last ? encodeCursor(last.cursorAt, last.id) : null,
    });
  });

  return r as unknown as Hono<AppEnv>;
}
