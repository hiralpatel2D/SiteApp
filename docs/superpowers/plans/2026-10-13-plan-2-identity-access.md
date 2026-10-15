# Site Diary — Plan 2: Identity & Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The platform admin creates a company and invites its Super Admin. People join by invitation only, sign in, pick a company, and act within their role's permissions: users, custom roles, the permission matrix, projects and assignments. Everything is audited, and isolation between companies is proven for every endpoint.

**Architecture:** Better Auth (email + password, HTTP-only cookie sessions) is mounted at `/api/auth/*` and stores global identity tables (`users`, `sessions`, `accounts`, `verifications`). Company-owned identity tables (`memberships`, `project_assignments`, `invitations`) are tenant tables under RLS. Two lookups must happen before a company context exists: "which companies is this user in?" and "what is this invitation?". These go through narrow `SECURITY DEFINER` SQL functions, so the API keeps running as `app_user`. Each request then flows: session → `x-company-id` header → membership check → `withTenant` → capability check.

**Tech Stack:** Existing (Hono, Drizzle, pg, Zod, React 19, Vite, TanStack Router, Vitest, Playwright), plus `better-auth` (latest 1.x at install time) and its client `better-auth/react`.

**Spec:** `docs/superpowers/specs/2026-10-13-site-diary-core-design.md` (§6, §7.4, §7.5, §10) · Roadmap: `docs/superpowers/plans/2026-10-13-core-roadmap.md` (Plan 2 outline + carry-over)

## Global Constraints

- All Plan 1 constraints still hold. Every new tenant table has `company_id uuid NOT NULL` with ENABLE + FORCE RLS and a USING + WITH CHECK policy. The API never connects as a role that can bypass RLS. Exception: the platform-admin code path uses the owner pool and is never mixed into tenant request handling (spec §7.4).
- Every new table has the common columns (`id`, `created_at`, `updated_at`, `version`, `created_by`, `updated_by`).
- The server checks capabilities on every request. Client-side capability checks only hide UI (spec §6.4).
- Every create, update and delete in a tenant writes one `audit_log` row (spec §7.5).
- Access is invite-only. Self-signup is allowed only for emails listed in `PLATFORM_ADMIN_EMAILS` (spec §6.2, owner decision).
- One role per person per company, not per project. Companies can create custom roles. System roles can't be deleted, and Super Admin can't be renamed (spec §6.1, §6.3).
- No user-facing UUIDs. Error JSON shape is `{ error: { code, message, details? } }`. All codes and messages are copied verbatim from the **Error catalogue** below.
- Secrets come only from env (`BETTER_AUTH_SECRET`). Session cookies are HTTP-only, `SameSite=Lax`, and `Secure` in production.
- Brand rule: no small text on an orange fill (Plan 1 contrast test).

### Error catalogue (exact copy)

| Status | code | message |
|---|---|---|
| 400 | `validation_failed` | `Check the highlighted fields.` (+ `details: { <field>: <message> }`) |
| 400 | `company_required` | `Choose a company first.` |
| 401 | `unauthenticated` | `Sign in to continue.` |
| 403 | `bad_origin` | `Request blocked.` |
| 403 | `forbidden` | `You do not have permission to do this.` |
| 403 | `not_a_member` | `You do not have access to this company.` |
| 403 | `company_suspended` | `This company's access is suspended. Contact Site Diary support.` |
| 403 | `invite_only` | `Site Diary is invite-only. Ask your company admin for an invitation.` |
| 403 | `invitation_email_mismatch` | `This invitation is for a different email address. Sign out and try again.` |
| 404 | `not_found` | `Not found.` |
| 405 | `method_not_allowed` | `That action is not allowed here.` |
| 409 | `slug_taken` | `That workspace name is already in use.` (exists) |
| 409 | `already_member` | `This person is already a member of this company.` |
| 409 | `invitation_pending` | `This person already has a pending invitation.` |
| 409 | `last_super_admin` | `A company must keep at least one active Super Admin.` |
| 409 | `system_role` | `Built-in roles cannot be deleted.` |
| 409 | `system_role_locked` | `The Super Admin role cannot be renamed or lose user and role management.` |
| 409 | `role_in_use` | `Move everyone off this role before deleting it.` |
| 409 | `role_name_taken` | `A role with this name already exists.` |
| 409 | `project_code_taken` | `A project with this code already exists.` |
| 409 | `stale_version` | `Someone else changed this. Reload and try again.` |
| 410 | `invitation_expired` | `This invitation has expired. Ask for a new one.` |
| 410 | `invitation_used` | `This invitation has already been used.` |
| 410 | `invitation_revoked` | `This invitation was cancelled.` |
| 429 | `rate_limited` | `Too many attempts. Wait a minute and try again.` |
| 503 | `unavailable` | `The service is busy. Try again shortly.` |

### Fixed values

- Invitation token: 32 random bytes, base64url. Only the SHA-256 hex digest is stored. Expiry is **7 days**. The link is `${APP_BASE_URL}/invite/<token>`.
- Minimum password length is **10**. Sign-in is rate-limited to **5 attempts per 60 s per IP**, using the client IP from `x-forwarded-for`.
- Optimistic concurrency: PATCH bodies carry `version`. A mismatch returns `409 stale_version`, and a success increments `version`.
- New capability `projects.all` ("see all projects"), granted by default to `super_admin` and `admin` only.

## Review Focus

1. **Guessing another company's IDs.** A member of A who sends B's role, project, membership or invitation ID to any endpoint must get `404 not_found`, never B's data and never a different error that reveals the ID exists. Pinned in Task 8, test `cross-company id sweep returns 404 on every endpoint`.
2. **Email case and spacing.** An invitation sent to `Anita@MehtaInfra.example ` must be accepted by a person signing up as `anita@mehtainfra.example`, and must block a duplicate invitation. Pinned in Task 5, test `email is normalised for invite, duplicate check and accept`.
3. **Removing the last Super Admin by indirect routes.** Deactivating the last one, changing their role, or editing the Super Admin role's capabilities must all be refused. Pinned in Task 7, tests `lockout guard: deactivate|change role|strip capability`.
4. **Suspension takes effect immediately for signed-in users.** The next request after a company is suspended returns `403 company_suspended`. Platform admins are unaffected. Pinned in Task 6, test `suspension blocks existing sessions on next request`.
5. **Clicking an invite link twice, or after signing in as someone else.** The second accept returns `410 invitation_used`. A different signed-in email returns `403 invitation_email_mismatch`, and no membership is created. Pinned in Task 5, tests `double accept` and `wrong signed-in user`.

---

## File Structure

```
packages/shared/src/capabilities.ts        + 'projects.all'
packages/shared/src/roles.ts               defaults: projects.all → super_admin, admin
packages/shared/src/api.ts                 NEW Zod request schemas + response types shared by api/web
apps/api/src/db/errors.ts                  NEW unwrapDbError(), isUniqueViolation()
apps/api/src/http/errors.ts                status-mapped HTTPException codes, typed AppError, validation errors
apps/api/src/http/origin.ts                NEW requireSameOrigin middleware
apps/api/src/server.ts                     graceful shutdown
apps/api/src/config.ts                     + betterAuthSecret, appBaseUrl, platformAdminEmails
apps/api/src/db/schema.ts                  + users, sessions, accounts, verifications, memberships, projectAssignments, invitations
apps/api/src/db/rls.sql                    + policies, grants, SECURITY DEFINER functions, audit append-only, REVOKE CREATE
apps/api/src/auth/auth.ts                  NEW createAuth(deps) (Better Auth instance)
apps/api/src/auth/session.ts               NEW sessionMiddleware, requireUser
apps/api/src/auth/me.ts                    NEW GET /api/me
apps/api/src/tenant/context.ts             NEW tenantMiddleware, requireCap, runInTenant
apps/api/src/audit/audit.ts                NEW writeAudit()
apps/api/src/email/email.ts                NEW EmailSender + console sender
apps/api/src/invitations/*.ts              NEW service, routes
apps/api/src/platform/routes.ts            NEW platform-admin routes
apps/api/src/users/routes.ts               NEW memberships routes
apps/api/src/roles/routes.ts               NEW roles + permission matrix routes
apps/api/src/projects/routes.ts            NEW projects + assignments routes
apps/api/src/audit/routes.ts               NEW audit log listing
apps/api/src/app.ts                        wires everything; AppDeps grows
apps/api/test/helpers/auth.ts              NEW signUpPlatformAdmin(), signIn(), inviteAndAccept(), as(user).request()
apps/web/server.mjs                        x-forwarded-*, accept-encoding identity
apps/web/src/lib/api.ts                    NEW fetch wrapper (credentials, x-company-id, error shape)
apps/web/src/lib/auth.ts                   NEW better-auth react client
apps/web/src/routes/                       sign-in wired, /invite/$token, /companies, /home, /platform
docs/deploy/railway.md                     + new api variables
```

---

### Task 1: Carry-over hardening and the `projects.all` capability

**Files:** Modify `packages/shared/src/{capabilities,roles}.ts` and tests; create `apps/api/src/db/errors.ts`; modify `apps/api/src/http/errors.ts`, `apps/api/src/companies/create-company.ts`, `apps/api/src/db/tenant.ts`, `apps/api/src/db/rls.sql`, `apps/api/src/server.ts`, `apps/web/server.mjs`; tests `apps/api/test/{errors,db-errors,rls-hardening}.test.ts`, `apps/web/test/server.test.ts`.

**Interfaces:**
- Produces:
  - `unwrapDbError(err: unknown): unknown` returns the pg `DatabaseError` from a `DrizzleQueryError` cause, otherwise `err`. `isUniqueViolation(err: unknown, constraint: string): boolean`. Both `tenant.ts` and `create-company.ts` use them, and no copy remains.
  - `class AppError` takes `(status: ContentfulStatusCode, code: string, message: string, details?: Record<string,string>)`. `validationError(zodError): AppError` maps to 400 `validation_failed` with `details` keyed by the field path joined with `.`.
  - `errorHandler` maps HTTPException statuses 400 → `validation_failed`, 401 → `unauthenticated`, 403 → `forbidden`, 404 → `not_found`, 405 → `method_not_allowed`, 429 → `rate_limited`, 503 → `unavailable`. Anything else at or above 500 is a 500 `internal` (the existing message).
  - `server.ts` handles SIGTERM/SIGINT by closing the HTTP server, then `pools.owner.end()` and `pools.app.end()`, then exiting 0. A listen error with `EADDRINUSE` logs `Port <n> is already in use.` and exits 1.
  - `rls.sql` gains `REVOKE CREATE ON SCHEMA public FROM PUBLIC;` and `REVOKE UPDATE, DELETE ON audit_log FROM app_user;`. Grants on `audit_log` become `SELECT, INSERT` only.
  - `server.mjs` sets `x-forwarded-for` (appending the client socket address) and `x-forwarded-proto` (`https` when the incoming `x-forwarded-proto` is https, else the request protocol), and always sends `accept-encoding: identity` upstream.
  - `CAPABILITIES` adds `'projects.all'` after `'projects.manage'`. Its default holders are `super_admin` and `admin`.

- [ ] **Step 1: Write failing tests:**

```ts
// errors.test.ts
it.each([[401,'unauthenticated'],[403,'forbidden'],[404,'not_found'],[405,'method_not_allowed'],[429,'rate_limited'],[503,'unavailable']])
  ('HTTPException %i → %s', async (s, code) => { /* app with route throwing new HTTPException(s) */ expect(res.status).toBe(s); expect(body.error.code).toBe(code); });
it('AppError keeps status, code, message and details', async () => { /* throw new AppError(409,'x','y',{a:'b'}) */ expect(body).toEqual({ error: { code:'x', message:'y', details:{a:'b'} } }); });
it('validationError maps zod paths', () => { const e = validationError(z.object({ a: z.object({ b: z.string() }) }).safeParse({ a: { b: 1 } }).error!); expect(e.details).toHaveProperty('a.b'); });
// rls-hardening.test.ts (real DB)
it('app_user cannot update or delete audit_log', async () => { /* withTenant(...) update auditLog → rejects /permission denied/ ; delete → same */ });
it('PUBLIC has no CREATE on schema public', async () => { const { rows } = await owner.query("select has_schema_privilege('public','public','CREATE') as c"); expect(rows[0].c).toBe(false); });
// shared roles.test.ts
it('projects.all only for super_admin and admin', () => { for (const r of SYSTEM_ROLES) expect(defaultCapabilities(r.key).includes('projects.all')).toBe(r.key === 'super_admin' || r.key === 'admin'); });
// web server.test.ts
it('sets x-forwarded-for and identity encoding upstream', async () => { /* fake upstream echoes headers */ expect(h['x-forwarded-for']).toBeTruthy(); expect(h['accept-encoding']).toBe('identity'); });
```

- [ ] **Step 2: Run the failing tests** (`scripts/test-db.sh start`, then `pnpm test`). Expected: the new tests FAIL.
- [ ] **Step 3: Implement** per the Interfaces block. Existing tests that assert the old `bad_request` behaviour are updated to the new codes.
- [ ] **Step 4: Run `pnpm lint && pnpm typecheck && pnpm test`.** Expected: all PASS.
- [ ] **Step 5: Commit** `refactor: harden errors, db error unwrapping, audit append-only, graceful shutdown, proxy headers`

---

### Task 2: Identity schema, RLS and pre-tenant lookup functions

**Files:** Modify `apps/api/src/db/schema.ts`, `apps/api/src/db/rls.sql`, `apps/api/test/helpers/db.ts` (truncate list); generate the migration; test `apps/api/test/identity-schema.test.ts`. Extend the existing catalog test so new tenant tables are covered automatically.

**Interfaces:**
- Produces these Drizzle exports (TS camelCase, SQL snake_case), all with the common columns:
  - `users` (global): `name text not null`, `email text not null unique` (stored lowercase), `emailVerified boolean not null default false`, `image text`, `isPlatformAdmin boolean not null default false`
  - `sessions` (global, Better Auth): `userId uuid → users on delete cascade`, `token text unique not null`, `expiresAt timestamptz not null`, `ipAddress text`, `userAgent text`
  - `accounts` (global, Better Auth): `userId → users cascade`, `accountId text not null`, `providerId text not null`, `password text`, `accessToken text`, `refreshToken text`, `idToken text`, `accessTokenExpiresAt timestamptz`, `refreshTokenExpiresAt timestamptz`, `scope text`
  - `verifications` (global, Better Auth): `identifier text not null`, `value text not null`, `expiresAt timestamptz not null`
  - `memberships` (tenant): `companyId`, `userId uuid not null → users`, `roleId uuid not null`, `status text not null default 'active'` with check in (`active`, `deactivated`); unique `(company_id, user_id)`; unique `(company_id, id)`; composite FK `(company_id, role_id) → roles(company_id, id)` with **no** cascade
  - `projectAssignments` (tenant): `companyId`, `membershipId`, `projectId`; unique `(membership_id, project_id)`; composite FKs `(company_id, membership_id) → memberships(company_id, id) on delete cascade` and `(company_id, project_id) → projects(company_id, id) on delete cascade`. Add unique `(company_id, id)` on `projects`.
  - `invitations` (tenant): `companyId`, `email text not null` (lowercase), `roleId` (composite FK to roles), `projectIds uuid[] not null default '{}'`, `tokenHash text not null unique`, `expiresAt timestamptz not null`, `acceptedAt timestamptz`, `revokedAt timestamptz`, `invitedBy uuid`; a partial unique index on `(company_id, email)` where `accepted_at is null and revoked_at is null`
  - Better Auth must be able to use these tables (Task 3 maps model names `users`/`sessions`/`accounts`/`verifications`). Column names must match Better Auth's field names after its drizzle-adapter mapping. The implementer checks the installed `better-auth` schema docs, and adjusts this list only to add fields Better Auth requires.
- `rls.sql` additions:
  - Grant `app_user` SELECT, INSERT, UPDATE, DELETE on the global tables `users`, `sessions`, `accounts`, `verifications`, which have no RLS because they are identity, not company data.
  - Tenant policies, identical in shape to Plan 1's, plus grants on `memberships`, `project_assignments` and `invitations`.
  - `CREATE OR REPLACE FUNCTION app_user_memberships(p_user uuid) RETURNS TABLE(membership_id uuid, company_id uuid, company_name text, company_slug text, company_status text, role_id uuid, role_key text, role_name text, membership_status text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public` returns only `p_user`'s rows.
  - `CREATE OR REPLACE FUNCTION app_invitation_lookup(p_token_hash text) RETURNS TABLE(invitation_id uuid, company_id uuid, company_name text, company_status text, email text, role_name text, expires_at timestamptz, accepted_at timestamptz, revoked_at timestamptz)`, with the same settings.
  - `REVOKE ALL ON FUNCTION ... FROM PUBLIC; GRANT EXECUTE ... TO app_user;` for both.

- [ ] **Step 1: Write failing tests:**

```ts
it('every company_id table has forced RLS with one policy', ...)   // existing catalog test, now finds 7 tables
it('app_user_memberships returns only that user’s memberships', async () => { /* seed users u1,u2 in companies A,B */ const { rows } = await app.query('select * from app_user_memberships($1)', [u1]); expect(rows.map(r => r.company_id)).toEqual([A]); });
it('app_user cannot select memberships without tenant context', async () => { const { rows } = await app.query('select * from memberships'); expect(rows).toHaveLength(0); });
it('membership cannot reference another company’s role', async () => { await expect(withTenant(app,{companyId:A}, tx => tx.insert(memberships).values({ companyId:A, userId:u1, roleId: roleOfB }))).rejects.toThrow(); });
it('only one open invitation per email per company', async () => { /* second insert same company+email → unique violation; after revoke → allowed */ });
it('app_invitation_lookup finds by hash only', async () => { /* returns 1 row for correct hash, 0 for other */ });
```

- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement the schema,** then `pnpm --filter api db:generate` (commit the SQL), then the `rls.sql` additions.
- [ ] **Step 4: Run the tests.** Expected: PASS, including the Plan 1 tests.
- [ ] **Step 5: Commit** `feat(api): identity tables, tenant RLS and pre-tenant lookup functions`

---

### Task 3: Better Auth, invite-only signup, sessions and `/api/me`

**Files:** Create `apps/api/src/auth/{auth,session,me}.ts`, `apps/api/src/http/origin.ts`, `apps/api/test/helpers/auth.ts`; modify `config.ts` (+ test), `app.ts`, `server.ts`, `.env.example`, `scripts/test-db.sh` (prints the new test env), `.github/workflows/ci.yml` (env); tests `apps/api/test/{auth,me,origin}.test.ts`.

**Interfaces:**
- Consumes: `users`, `sessions`, `accounts`, `verifications` (Task 2); `app_user_memberships` (Task 2); `Pools`.
- Produces:
  - Config adds `betterAuthSecret: string` (env `BETTER_AUTH_SECRET`, at least 32 chars), `appBaseUrl: string` (env `APP_BASE_URL`, an absolute URL without a trailing slash), and `platformAdminEmails: string[]` (env `PLATFORM_ADMIN_EMAILS`, comma-separated, trimmed, lowercased, may be empty).
  - `createAuth(deps: { pools: Pools; config: Config; canSignUp: (email: string) => Promise<boolean> })` returns the Better Auth instance with:
    - Drizzle adapter on `pools.appDb`, `basePath: '/api/auth'`, `baseURL: config.appBaseUrl`, `trustedOrigins: [config.appBaseUrl]`.
    - `emailAndPassword: { enabled: true, minPasswordLength: 10 }`.
    - `advanced.database.generateId` set to `newId`, and `advanced.ipAddress.ipAddressHeaders: ['x-forwarded-for']`.
    - Secure cookies when `nodeEnv === 'production'`.
    - Rate limit enabled with a custom rule of `/sign-in/email` at 5 per 60 s.
    - A `databaseHooks.user.create.before` hook that lowercases and trims the email, throws an `APIError` mapped to `403 invite_only` unless `canSignUp(email)`, and sets `isPlatformAdmin` when the email is in `platformAdminEmails`.
  - `canSignUp(email)` is true when the email is in `platformAdminEmails`, or when an open (not accepted, not revoked, not expired) invitation exists for it. That check runs through `app_invitation_lookup`-style SQL: add `app_open_invitation_exists(p_email text) RETURNS boolean SECURITY DEFINER` to `rls.sql` in this task.
  - `sessionMiddleware`: Hono middleware that resolves the session through `auth.api.getSession({ headers })` and sets `c.var.user` (`{ id, email, name, isPlatformAdmin } | null`). `requireUser` returns 401 `unauthenticated` when there is no user.
  - `requireSameOrigin`: for non-GET/HEAD/OPTIONS requests outside `/api/auth/*`, it requires the `Origin` header to equal `config.appBaseUrl`, else 403 `bad_origin`.
  - `GET /api/me` (requireUser) returns `{ user: { id, name, email, isPlatformAdmin }, memberships: Array<{ companyId, companyName, companySlug, companyStatus, roleName, status }> }`. Only active memberships are returned, ordered by company name.
  - `apps/api/src/email/email.ts` defines `interface EmailSender { sendInvitation(to: string, data: { companyName: string; roleName: string; inviteUrl: string; expiresAt: Date }): Promise<void>; sendPasswordReset(to: string, data: { resetUrl: string }): Promise<void> }`. `consoleEmailSender` logs `Invitation for <to>: <url>` and `Password reset for <to>: <url>`.
  - Password reset: Better Auth `emailAndPassword.sendResetPassword` calls `deps.email.sendPasswordReset`. The reset link points at `${appBaseUrl}/reset-password?token=…`. Its endpoints (`/api/auth/request-password-reset`, `/api/auth/reset-password`) are covered by a test.
  - `AppDeps` becomes `{ checkDb; pools: Pools; config: Config; email: EmailSender }`.
  - Test helper `signUp(app, { email, password, name })` returns a cookie string, `signIn(app, email, password)` returns a cookie string, and `req(app, path, { cookie, company?, method?, body? })` sets `Origin`, `Cookie` and `x-company-id`.

- [ ] **Step 1: Write failing tests:**

```ts
it('signup with a random email is refused as invite_only', async () => { const r = await post('/api/auth/sign-up/email', { email:'x@y.z', password:'longpassword1', name:'X' }); expect(r.status).toBe(403); expect((await r.json()).error?.code ?? (await r.json()).code).toMatch(/invite_only/i); });
it('platform admin email can sign up and is flagged', async () => { /* PLATFORM_ADMIN_EMAILS=owner@sitediary.test */ const c = await signUp(...); const me = await req(app,'/api/me',{cookie:c}); expect((await me.json()).user.isPlatformAdmin).toBe(true); });
it('/api/me without session is 401 unauthenticated', ...);
it('password shorter than 10 is rejected', ...);
it('6th sign-in attempt in a minute is 429', ...);
it('POST without matching Origin is 403 bad_origin', ...);
it('password reset: request logs a link; reset with its token lets the user sign in with the new password', ...);
it('session cookie is HttpOnly and SameSite=Lax', async () => { expect(setCookie).toMatch(/HttpOnly/i); expect(setCookie).toMatch(/SameSite=Lax/i); });
```

Better Auth's own error body shape may differ. Normalise it: wrap the Better Auth handler so that its 4xx JSON errors are re-emitted in our shape, with `invite_only` and `rate_limited` mapped from the catalogue. The test asserts our shape: `body.error.code === 'invite_only'`.

- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.** Mount with `app.on(['GET','POST'], '/api/auth/*', (c) => normalise(auth.handler(c.req.raw)))`. Add `BETTER_AUTH_SECRET`, `APP_BASE_URL` and `PLATFORM_ADMIN_EMAILS` to `.env.example`, to the CI env (test values), and to the output of `scripts/test-db.sh`.
- [ ] **Step 4: Run the tests.** Expected: PASS. Then run the full suite.
- [ ] **Step 5: Commit** `feat(api): better auth with invite-only signup, sessions, origin check and /api/me`

---

### Task 4: Company context, capabilities and the audit writer

**Files:** Create `apps/api/src/tenant/context.ts`, `apps/api/src/audit/audit.ts`; modify `app.ts`; test `apps/api/test/tenant-context.test.ts`. Extend `test/helpers/auth.ts` with `seedMember(companyId, roleKey, email)`, which writes owner-side seeding (user, account with password, membership) for tests.

**Interfaces:**
- Consumes: `sessionMiddleware`/`requireUser` (Task 3), `app_user_memberships` (Task 2), `withTenant` (Plan 1).
- Produces:
  - `type Tenant = { companyId: string; userId: string; membershipId: string; roleId: string; roleKey: string | null; capabilities: Set<Capability> }`
  - `tenantMiddleware`: requires a user. It reads the `x-company-id` header: a missing or non-UUID value gives 400 `company_required`. It finds an active membership through `app_user_memberships(userId)`: none (including a real ID of another company) gives 403 `not_a_member`; `company_status = 'suspended'` gives 403 `company_suspended`. It loads the role's capabilities with `withTenant` and sets `c.var.tenant`.
  - `requireCap(cap: Capability)` returns 403 `forbidden` when the capability is missing.
  - `runInTenant<T>(c, fn: (tx: AppTx) => Promise<T>): Promise<T>` calls `withTenant(pools.app, { companyId, userId }, fn)`.
  - `writeAudit(tx: AppTx, t: Tenant, e: { action: string; entity: string; entityId?: string; before?: unknown; after?: unknown }): Promise<void>`. Action names are dotted, e.g. `membership.role_changed`.
  - `GET /api/company/context` (tenant) returns `{ company: { id, name, slug }, role: { id, name, key }, capabilities: Capability[] }`, with capabilities sorted.

- [ ] **Step 1: Write failing tests:**

```ts
it('no x-company-id → 400 company_required', ...);
it('another company’s real id → 403 not_a_member (same as random id)', ...);
it('deactivated membership → 403 not_a_member', ...);
it('suspended company → 403 company_suspended', ...);
it('context returns sorted capabilities of the role', async () => { /* site_engineer */ expect(body.capabilities).toEqual([...defaultCapabilities('site_engineer')].sort()); });
it('requireCap blocks a missing capability with 403 forbidden', ...);
it('writeAudit stores user, action and entity under the tenant', ...);
```

- [ ] **Step 2: Run the tests.** Expected: FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat(api): company context middleware, capability guard and audit writer`

---

### Task 5: Invitations (create, list, revoke, preview, accept) and the email sender

**Files:** Create `apps/api/src/invitations/{service,routes}.ts`; modify `app.ts`; test `apps/api/test/invitations.test.ts`.

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces:
  - Uses `EmailSender.sendInvitation` (Task 3) after creating an invitation.
  - `createInvitation(tx: AppTx | Db, input: { companyId; email; roleId; projectIds: string[]; invitedBy: string | null }, cfg: { appBaseUrl }): Promise<{ invitationId: string; inviteUrl: string; expiresAt: Date }>`. It normalises the email (trim, lowercase); a member with that email gives 409 `already_member`; an open invitation gives 409 `invitation_pending`. It also validates that `roleId` and `projectIds` belong to the company (otherwise 404 `not_found`).
  - Routes:
    - `POST /api/invitations` (`users.manage`) with body `{ email, roleId, projectIds? }` returns 201 `{ id, email, roleName, inviteUrl, expiresAt }`. The response includes `inviteUrl` so an admin can also share it on WhatsApp.
    - `GET /api/invitations` (`users.view`) returns open invitations, without the URL.
    - `DELETE /api/invitations/:id` (`users.manage`) sets `revokedAt`.
    - `GET /api/invitations/by-token/:token` (public) returns `{ companyName, email, roleName, expiresAt, hasAccount }`, or 410 `invitation_expired`/`invitation_used`/`invitation_revoked`, or 404.
    - `POST /api/invitations/by-token/:token/accept` with body `{ name, password }` when no account exists (it creates the account through `auth.api.signUpEmail`, then sets the session cookie), or no body when signed in as the invited email (403 `invitation_email_mismatch` otherwise). In one tenant transaction it creates the membership and project assignments, sets `acceptedAt`, and writes the audit entry `membership.created`. It returns `{ companyId }`.
  - Audit actions: `invitation.created`, `invitation.revoked`, `membership.created`.

- [ ] **Step 1: Write failing tests:**

```ts
it('admin invites and gets an inviteUrl with a 7-day expiry', ...);
it('email is normalised for invite, duplicate check and accept', async () => { /* invite ' Anita@X.example ' → stored 'anita@x.example'; second invite 'ANITA@x.example' → 409 invitation_pending; signup via accept as 'anita@x.example' works */ });
it('preview of expired / revoked / accepted invitation → 410 with the right code', ...);
it('new person accepts: account + membership + assignments + audit, cookie set', ...);
it('double accept → 410 invitation_used', ...);
it('wrong signed-in user → 403 invitation_email_mismatch and no membership', ...);
it('existing member invited again → 409 already_member', ...);
it('without users.manage → 403 forbidden', ...);
it('token is stored only as a sha-256 hash', async () => { /* select token_hash; expect !== token and === sha256(token) */ });
```

- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat(api): invitations with hashed tokens, accept flow and email sender`

---

### Task 6: Platform admin (create company + Super Admin invite, list, suspend)

**Files:** Create `apps/api/src/platform/routes.ts`; modify `create-company.ts` (name validation), `app.ts`; test `apps/api/test/platform.test.ts`.

**Interfaces:**
- Consumes: `createCompany` (Plan 1), `createInvitation` (Task 5), `sessionMiddleware` (Task 3). It uses `pools.ownerDb`, the only owner-pool request path.
- Produces:
  - Middleware `requirePlatformAdmin` returns 403 `forbidden` unless `user.isPlatformAdmin`.
  - `POST /api/platform/companies` with body `{ name (trimmed, 2–80), slug, adminEmail }` creates the company and a `super_admin` invitation, writes the audit entry `company.created`, and returns 201 `{ company: { id, name, slug, status }, inviteUrl }`. A bad name or email gives 400 `validation_failed`, and a duplicate slug gives 409 `slug_taken`.
  - `GET /api/platform/companies` returns `[{ id, name, slug, status, plan, memberCount, createdAt }]`, ordered by name.
  - `POST /api/platform/companies/:id/suspend` and `/reactivate` set `status`, write the audit entries `company.suspended`/`company.reactivated`, and return 404 for an unknown id.

- [ ] **Step 1: Write failing tests:**

```ts
it('non-platform user → 403 forbidden on every /api/platform route', ...);
it('creates company + returns super_admin inviteUrl; accepting it makes a Super Admin', ...);
it('company name is trimmed and length-checked', ...);
it('suspension blocks existing sessions on next request', async () => { /* member requests ok → suspend → same cookie → 403 company_suspended; platform admin /api/platform still 200 */ });
```

- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat(api): platform admin company creation, listing and suspension`

---

### Task 7: Users, roles and the permission matrix with lockout guards

**Files:** Create `apps/api/src/users/routes.ts`, `apps/api/src/roles/routes.ts`; add request schemas to `packages/shared/src/api.ts`; tests `apps/api/test/{users,roles}.test.ts`.

**Interfaces:**
- Consumes: Task 4 (`tenantMiddleware`, `requireCap`, `runInTenant`, `writeAudit`).
- Produces:
  - `GET /api/users` (`users.view`) returns `[{ membershipId, name, email, roleId, roleName, status, projectIds, version }]`, ordered by name.
  - `PATCH /api/users/:membershipId` (`users.manage`) with body `{ version, roleId?, status?: 'active'|'deactivated', projectIds? }`. It writes audit entries `membership.role_changed`, `membership.status_changed` and `membership.projects_changed`. A version mismatch gives 409 `stale_version`.
  - `GET /api/roles` (`roles.view`) returns `[{ id, name, key, isSystem, capabilities: Capability[], memberCount, version }]`, system roles first in `SYSTEM_ROLES` order, then custom roles by name.
  - `POST /api/roles` (`roles.manage`) with body `{ name (trimmed, 2–40), capabilities: Capability[] }` returns 201. Unknown capability strings give 400 `validation_failed`; a duplicate name gives 409 `role_name_taken`.
  - `PATCH /api/roles/:id` (`roles.manage`) with body `{ version, name?, capabilities? }`. This is the permission-matrix edit: it replaces the capability set.
  - `DELETE /api/roles/:id` (`roles.manage`): a system role gives 409 `system_role`, and a role with members gives 409 `role_in_use`.
  - Lockout guard `assertSuperAdminRemains(tx, companyId)` runs inside the same transaction after every membership change. If no active membership has role key `super_admin`, it rolls back with 409 `last_super_admin`. Renaming the `super_admin` role, or removing `users.manage` or `roles.manage` from it, gives 409 `system_role_locked`.
  - Audit actions: `role.created`, `role.updated`, `role.deleted`.

- [ ] **Step 1: Write failing tests:**

```ts
it('lockout guard: deactivate the only super admin → 409 last_super_admin', ...);
it('lockout guard: change the only super admin’s role → 409 last_super_admin', ...);
it('lockout guard: strip users.manage from Super Admin → 409 system_role_locked', ...);
it('with two super admins, one can be deactivated', ...);
it('custom role: create, tick capabilities, assign, member gains tiles capability', async () => { /* create 'Safety Officer' with ['company.view','projects.view','safety.view']; PATCH user roleId; their /api/company/context capabilities equal that set */ });
it('delete system role → 409 system_role; delete used custom role → 409 role_in_use', ...);
it('unknown capability → 400 validation_failed with details.capabilities', ...);
it('stale version → 409 stale_version', ...);
it('capability changes take effect on the very next request', ...);
it('every change writes one audit row', ...);
```

- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat(api): users, custom roles and permission matrix with lockout guards`

---

### Task 8: Projects, assignments, audit log listing and the cross-company sweep

**Files:** Create `apps/api/src/projects/routes.ts`, `apps/api/src/audit/routes.ts`; tests `apps/api/test/{projects,audit,cross-company}.test.ts`.

**Interfaces:**
- Produces:
  - `GET /api/projects` (`projects.view`) returns all projects when the caller has `projects.all`, else only assigned ones: `[{ id, name, code, location, status, memberCount, version }]`, ordered by name.
  - `POST /api/projects` (`projects.manage`) with body `{ name (2–80), code (projectCodeSchema), location? }` returns 201; a duplicate gives 409 `project_code_taken`. The creator is auto-assigned unless they have `projects.all`.
  - `PATCH /api/projects/:id` (`projects.manage`) with body `{ version, name?, code?, location?, status?: 'active'|'archived' }`.
  - `PUT /api/projects/:id/members` (`projects.manage`) with body `{ membershipIds: string[] }` replaces the assignments; foreign membership IDs give 404.
  - Audit actions: `project.created`, `project.updated`, `project.members_changed`.
  - `GET /api/audit` (`audit.view`), query `{ userId?, entity?, from?, to?, before? (cursor = created_at|id), limit ≤ 100, default 50 }`, returns `{ items: [{ id, at, userName, action, entity, entityId, before, after }], nextCursor }`, newest first.
  - Also extend `writeAudit` callers' coverage: every mutating route from Tasks 5–8 must produce exactly one row per change (asserted per route in its own tests).

- [ ] **Step 1: Write failing tests:**

```ts
it('site engineer sees only assigned projects; admin sees all', ...);
it('duplicate project code in same company → 409, in another company → allowed', ...);
it('audit list paginates newest-first with a cursor', ...);
it('cross-company id sweep returns 404 on every endpoint', async () => {
  // member of A (super_admin) targets B's ids
  const cases = [
    ['PATCH', `/api/users/${bMembership}`], ['PATCH', `/api/roles/${bRole}`], ['DELETE', `/api/roles/${bCustomRole}`],
    ['PATCH', `/api/projects/${bProject}`], ['PUT', `/api/projects/${bProject}/members`], ['DELETE', `/api/invitations/${bInvitation}`],
    ['PUT', `/api/projects/${aProject}/members` /* with B membership in body */],
  ];
  for (const [m, p] of cases) { const r = await req(app, p, { cookie: aAdmin, company: A, method: m, body: validBodyFor(p) }); expect(r.status, `${m} ${p}`).toBe(404); }
});
```

- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat(api): projects, assignments, audit listing and cross-company sweep`

---

### Task 9: Web flows: sign-in, invite accept, company picker, home, platform admin

Only the flows needed to start using the product are built here, with tokens-only styling consistent with the sign-in screen. The full shell, motion and admin screens for users, roles, projects and audit come in Plan 3. *(Claude's call: building throwaway admin screens now would be redone in Plan 3. The API for them is fully covered by Tasks 5–8 tests.)*

**Files:** Create `apps/web/src/lib/{api,auth,company}.ts`, routes `apps/web/src/routes/{invite.$token,companies,home,platform}.tsx`; modify `SignIn.tsx`, `routes/index.tsx`; tests `apps/web/test/{api,company}.test.ts`, `apps/web/e2e/bootstrap.spec.ts`; modify `docs/deploy/railway.md` (new variables) and `playwright.config.ts` (start api + web against the test DB for e2e).

**Interfaces:**
- Consumes: the API from Tasks 3–8.
- Produces:
  - `api<T>(path, { method?, body?, company? }): Promise<T>` uses `credentials: 'include'` and JSON. It sets `x-company-id` from `getActiveCompany()`, and throws `ApiError { status, code, message, details }` built from the error shape.
  - `getActiveCompany()` and `setActiveCompany(id)` use `localStorage` key `sd.company`, inside try/catch.
  - `authClient = createAuthClient({ basePath: '/api/auth' })`.
  - Routing:
    - The sign-in submit calls `authClient.signIn.email`. On success it goes to `/companies`, or to `/platform` for a platform admin with no memberships. Errors show the catalogue message inline in `role="alert"`.
    - `/companies` lists memberships. With exactly one, it auto-selects and goes to `/home`. A suspended company is shown disabled with the `company_suspended` message.
    - `/home` shows the company name, the role name, a "Switch company" link, and "Sign out".
    - `/reset-password` shows a new-password form. A "Forgot password?" link on sign-in asks for an email, and always shows `If that email has an account, a reset link is on its way.`
    - `/invite/$token` shows the preview ("Join **{companyName}** as **{roleName}**"). It shows a name/password form when `hasAccount` is false, and an "Accept" button when signed in. Errors (410/403) use the catalogue copy.
    - `/platform` (platform admin only) has a create-company form (name, workspace name, Super Admin email). After creation it shows the invite link with a **Copy link** button, and lists companies with Suspend/Reactivate.
  - `docs/deploy/railway.md` adds the api variables `BETTER_AUTH_SECRET` (random, 48 letters and digits), `APP_BASE_URL` (the web public URL), and `PLATFORM_ADMIN_EMAILS` (the owner's email).
- [ ] **Step 1: Write failing tests:**

```ts
// api.test.ts: ApiError carries code/message from { error: {...} }; x-company-id sent when active company set; storage throwing → no header, no crash
// e2e/bootstrap.spec.ts (API + web against test DB, PLATFORM_ADMIN_EMAILS=owner@sitediary.test)
test('platform admin → company → invite → super admin lands in home', async ({ page, context }) => {
  // sign up owner via API helper; sign in on /; go to /platform; create "Mehta Infra" / mehta-infra / anita@mehtainfra.example
  // read the invite link text; sign out; open link; fill name + password; submit
  // expect URL /home and text "Mehta Infra" and "Super Admin"
});
test('invite link opened twice shows "This invitation has already been used."', ...);
test('360px: invite and platform pages have no horizontal scroll', ...);
```

- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS, including the existing smoke and contrast tests. **Step 5:** Commit `feat(web): sign-in, invite accept, company picker, home and platform admin flows`

---

## Done when

1. CI is green. The Review Focus tests exist and pass.
2. After merge, the controller sets `BETTER_AUTH_SECRET`, `APP_BASE_URL` and `PLATFORM_ADMIN_EMAILS` on Railway `api` (production, and staging if it exists). The owner then signs up at the live URL with their email, creates their first company, and opens the invite link.
