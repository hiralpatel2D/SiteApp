# Site Diary Core — Build Roadmap

**Spec:** `docs/superpowers/specs/2026-10-13-site-diary-core-design.md` (approved 2026-10-13)

The core spec covers several subsystems, so it is built as **three plans in sequence**. Each plan ends with working, tested, deployed software. Plans 2 and 3 are written in full once the plan before them is merged, so they build on the real code rather than on guesses.

| # | Plan | What you can see when it's done | Status |
|---|------|----------------------------------|--------|
| 1 | **Foundation** (`2026-10-13-plan-1-foundation.md`) | The live Railway URL shows the Site Diary sign-in screen in the Field Ops theme, with light, dark and sunlight modes. `/api/health` reports the database is up. Company data isolation is enforced by the database and proven by tests. CI runs on every PR. | Written |
| 2 | **Identity & access** (`2026-10-13-plan-2-identity-access.md`) | You (platform admin) create a company and invite its Super Admin by email. That person signs in, invites others, creates custom roles, edits the Permission Matrix, and creates projects. Everything is written to the audit log. Suspend company works. | Built (PR #2) |
| 3 | **App shell & motion** | The full shell from the motion demo, wired to real data: app bar, project switcher, tiles filtered by permission, tabs, side menu, sheets, toasts, glove mode, and the motion library. Admin screens get the full design treatment. Module tiles open the generic module scaffold. | Outline below |

## Plan 2 outline: Identity & access

- Better Auth on the API (email + password, HTTP-only cookie sessions, password reset), with the Drizzle adapter on our `users` table.
- Tables: `users` (incl. `is_platform_admin`), `memberships` (user, company, role), `project_assignments`, `invitations`, plus Better Auth session/account tables. RLS on all tenant tables.
- Request pipeline: session → active company (header or cookie) → membership check → `withTenant` → capability check middleware `requireCap(cap)`.
- Endpoints: invite accept, company picker and switcher, users (list, invite, change role, deactivate), roles (CRUD custom roles), permission matrix (get, update), projects (CRUD, assign), audit log (list and filter), platform admin (create company + invite, list, suspend).
- Guards: lockout guard (§6.4), no deleting a role that is in use, suspended company blocks sign-in.
- Tenant isolation suite extended to every endpoint (cross-company IDs → 404).
- Email sender interface, with a console logger in dev.
- Minimal unstyled web screens to exercise the flows end to end (Plan 3 styles them).

## Plan 3 outline: App shell & motion

- `apps/web/src/motion/`: route transitions (View Transitions API + fallback), shared-element morph, stagger, sheet with drag-to-dismiss, drawer, press feedback, skeletons, count-up, toast, layout re-flow, and the reduced-motion switch.
- Shell components matching `docs/design/motion-demo.html` (Field Ops default).
- Data layer `apps/web/src/data/` (TanStack Query hooks, client UUIDv7 IDs, idempotency keys, version-checked updates), set up ready for offline.
- Styled screens: sign-in, company picker, invite accept, Users & Roles, Roles, Permission Matrix, Projects, Audit Log, profile, platform admin.
- Playwright end-to-end smoke from spec §10, accessibility checks (axe), and a 360px no-clipping check.

## Carry-over from Plan 1 reviews (fold into Plan 2 / 3)

Non-blocking items found by the Plan 1 task reviews and final review. Plan 2 and Plan 3 should pick these up where they touch the same code.

**Plan 2 (identity & access)**
- Make `audit_log` append-only for `app_user` (INSERT + SELECT only).
- Extract one shared `unwrapDbError` helper; today it is duplicated in `apps/api/src/db/tenant.ts` and `apps/api/src/companies/create-company.ts`.
- Error handler: map HTTPException statuses to proper codes (401/403/404/405 are currently labelled `bad_request`; a 503 from inside the API currently comes back as a 500). Also narrow `AppError.status` to Hono's status type, and add tests for the `AppError` branch.
- Validate and trim the company `name` at the platform-admin endpoint.
- Add an explicit `REVOKE CREATE ON SCHEMA public FROM PUBLIC` in `rls.sql`.
- Graceful shutdown on SIGTERM: close the DB pools and handle EADDRINUSE.
- Production web proxy: add `x-forwarded-for` / `x-forwarded-proto`, and send `accept-encoding: identity` upstream. Auth rate limiting needs the client IP.

**Plan 3 (shell & motion)**
- ThemeProvider: add tests for an OS colour-scheme flip and for a stored preference read on mount; move `writeStoredTheme` out of the state updater.
- Reduced motion: use `transition: none` rather than 1ms.
- Use a separate maskable PWA icon with safe-zone padding.
- `server.mjs`: add MIME types for jpeg/webp/gif/avif, and add tests for query strings, path traversal, `/api` 404 passthrough and redirects.
- Brand orange with white text only reaches 3.58:1. It may be used for large or bold text (≥19px bold) and icons, never for small text on an orange fill (pinned by `apps/web/test/contrast.test.ts`).

## Carry-over from Plan 2 reviews

**Before scaling or launch**
- Password-reset and invitation emails only go to the server log. Wire a real email provider, then add email verification for platform-admin sign-up (R12/R16).
- Rate limits (sign-in, invite links) are in memory per process. Move them to a shared store before running more than one API replica.
- Confirm on staging that Railway sends `X-Real-IP` (check `sessions.ip_address`). The fallback is the right-most `X-Forwarded-For` entry.
- The sign-in "workspace" field is ignored until per-company subdomains arrive.

**Plan 3 (shell & motion)**
- E2E is not covered for password reset, the suspended-company display, or the existing-account invite path.
- Admin screens (users, roles, permission matrix, projects, audit) are API-only today and need their UI.
- Small API polish:
  - `requireCap` used before `tenantMiddleware` should fail with an explicit error, not a TypeError.
  - A revoke/expire racing an accept reports `invitation_used`.
  - The company status isn't re-checked inside the accept transaction.
  - Expired invitations that get auto-revoked write no audit row.
  - The invitation list should add an explicit `companyId` filter on top of RLS.
  - Add a test that the company is rolled back if invitation creation fails.
- Migration 0002 (case-insensitive role names) fails on a database that already has role names differing only by case. Production has no companies yet, so this is fine there.
