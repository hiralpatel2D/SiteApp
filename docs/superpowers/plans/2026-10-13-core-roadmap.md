# Site Diary Core — Build Roadmap

**Spec:** `docs/superpowers/specs/2026-10-13-site-diary-core-design.md` (approved 2026-10-13)

The core spec covers several subsystems, so it is built as **three plans in sequence**. Each plan ends with working, tested, deployed software. Plans 2 and 3 are written in full once the plan before them is merged, so they build on the real code rather than on guesses.

| # | Plan | What you can see when it's done | Status |
|---|------|----------------------------------|--------|
| 1 | **Foundation** (`2026-10-13-plan-1-foundation.md`) | The live Railway URL shows the Site Diary sign-in screen in the Field Ops theme, with light, dark and sunlight modes. `/api/health` reports the database is up. Company data isolation is enforced by the database and proven by tests. CI runs on every PR. | Written |
| 2 | **Identity & access** | You (platform admin) create a company and invite its Super Admin by email. That person signs in, invites others, creates custom roles, edits the Permission Matrix, and creates projects. Everything is written to the audit log. Suspend company works. | Outline below |
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
