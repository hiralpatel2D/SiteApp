# Site Diary — Core Platform Design

**Date:** 2026-10-13
**Status:** Approved by owner (2026-10-13)
**Repo:** `SiteApp` · **Hosting:** Railway

---

## 1. Intent

Site Diary is a multi-company (SaaS) app for construction sites. Site engineers, supervisors, store keepers, project managers and clients use it, mostly on phones and on the site itself, to record what happened each day: attendance, manpower, hindrances, indents, stock, material movement, drawings, equipment, safety and the daily report.

This document covers **only the core**: the foundation every module will plug into. That is the frontend shell, the backend, multi-company accounts, login, roles and permissions, theming, the motion system, and deployment. No business module (Indent, Stock, etc.) is built in this phase beyond what is needed to prove the shell works.

**Why the core first:** every module depends on the same things: who the user is, which company and project they're in, what their role lets them do, how screens look and move, and how data reaches the server. Getting these right once avoids rework in all twelve modules.

## 2. Reference material (in this repo)

| File | What it is |
|---|---|
| `docs/design/site-diary-v2-design.html` | The owner's original "Swiss v2" design prototype (made with Claude Design). Self-unpacking bundle; open in a browser. Shows screens, roles, menu structure and module list. |
| `docs/design/motion-demo.html` | The approved clickable demo of the shell, motion patterns and both themes. **This is the reference for look and feel.** Open in a current Chrome, Edge or Safari. (Also published privately at https://claude.ai/artifact/EKfUKUmop7vDHewRK3G29w.) |

The owner also shared screenshots of a second app ("Field Ops" style: condensed uppercase headings, monospace labels, white rounded cards, orange primary, navy icon squares). That style is implemented in the motion demo as the **Field Ops** look and is the approved default.

## 3. Goals

1. A user from Company A can sign up, create their company workspace, invite colleagues with roles, create projects, assign people to projects, and land in a working app shell. They can never see anything belonging to Company B.
2. The app shell matches the motion demo: app bar, project switcher, module tile grid, bottom tabs, side menu, bottom sheets, toasts, sync indicator, glove mode, sunlight mode.
3. Modern motion is built in from day one, as reusable primitives, not added per screen later (see §8).
4. Themes are swappable through design tokens only. Field Ops is the default. Swiss v2 is a second built-in theme. Each has light, dark and sunlight variants.
5. Roles and permissions are enforced on the server and reflected in the UI (hidden tiles, read-only states).
6. Online-only at launch, but structured so offline capture and sync can be added later **without a rewrite** (see §9).
7. Deployed on Railway from the `SiteApp` repo, with a working production URL, health checks and database migrations.

## 4. Non-goals (this phase)

- Building the business modules (Indent, Stock, Drawings, etc.). Each comes later as its own design and plan. The tiles exist and open a placeholder module page.
- Offline data capture and background sync.
- Billing and subscriptions (Stripe). The data model leaves room for a `plan` on the company, but there's no payment.
- Native iOS or Android apps. The app is an installable PWA.
- Weather auto-logging, push notifications, reports, exports.

## 5. Anti-goals (this would be a failure even if it "works")

- **Any possibility of cross-company data leakage.** Tenant isolation must hold even if a developer forgets a `WHERE company_id = …`.
- Showing internal IDs (UUIDs, `proj-3`) to users. Every user-facing record gets a readable reference (e.g. `IND-0142`, project code `GMS-VD-04`).
- Buttons with wrapping or clipped labels at phone width (an observed bug in the reference app).
- Animation that slows people down or ignores "reduce motion". Motion must feel fast and responsive, and switch off cleanly.
- Hard-coded colours or fonts in components. If a theme change needs a component edit, the token system has failed.
- Everything red. Red/accent is reserved for overdue or blocking states, not "not started yet".

## 6. Users, companies and roles

### 6.1 Tenancy model

| Concept | Rule |
|---|---|
| **Company (tenant)** | One construction company. Has a unique workspace slug (e.g. `mehta-infra`), name, logo, plan placeholder. All business data belongs to exactly one company. |
| **User** | A person with one login (email). May belong to **more than one company** with a different role in each (e.g. Admin at one, Client at another). |
| **Membership** | Links user ↔ company with **one role for the whole company**. Roles are not per project *(owner's decision)*. If someone is a PM on one site and an engineer on another, they get one role that covers both; a custom role can fit the mix (§6.3). |
| **Project** | Belongs to one company. Has a name, a short **project code** (e.g. `RT-PH2`), location, and status. |
| **Project assignment** | Links a membership to the projects it can see. Super Admin and Admin see all projects in their company. |
| **Platform admin** | The app owner (above all companies). Creates companies and invites their first Super Admin, lists companies, sees usage, and can suspend a company. Suspending blocks sign-in for that company's users but keeps all its data. Separate from company roles. Minimal UI in this phase. |

### 6.2 Signup and onboarding flow

1. **Access is by invitation only. There is no public signup.** The platform admin (app owner) creates a company (name, slug) and invites its first user by email. *(Owner's decision)*
2. That person accepts the invite, sets a password (unless they already have an account), and becomes the company's **Super Admin**.
3. Super Admin creates the first project (name, code, location).
4. Super Admin invites people by email with a role and project(s). The invite link sets a password.
5. **One global account per person** (email + password), not one per workspace. Sign-in asks for email + password; the workspace field shown in the demo is optional and only pre-selects the company. If a user belongs to several companies and no workspace was given, they pick one after sign-in and can switch later from the side menu. *(Claude's call)*
6. If an invite goes to an email that already has an account, accepting it simply adds the new membership. No new password is set. *(Claude's call)*
7. **No subdomains in this phase.** Everything runs on one domain; the workspace slug is a name, not a host. The `.sitediary.app` suffix in the demo is decorative and becomes a plain label. Real per-company subdomains can come later. *(Claude's call)*
8. The workspace slug is unique and can be renamed by Super Admin, which is safe because nothing routes on it. Project codes are unique within a company and editable. Records always link by internal ID, and the code is display-only. *(Claude's call)*

Email delivery needs a provider. Builder's call (e.g. Resend), behind an interface. In development, invite links are logged to the console.

### 6.3 Roles

**Companies can create their own custom roles** *(owner's decision)*. Each company starts with nine **system roles**, seeded from the v2 design. Super Admin can edit their permissions, except where §6.4's lockout guard applies. Super Admin and Admin can also create, rename and delete **custom roles** (e.g. "Safety Officer", "Quantity Surveyor") and tick their capabilities in the Permission Matrix. System roles can't be deleted, and Super Admin can't be renamed. A role can't be deleted while members hold it; they must be moved to another role first.

The nine system roles:

| Role | Scope summary (default permissions; editable per company in the Permission Matrix) |
|---|---|
| Super Admin | Everything in the company, including billing placeholder, deleting the company and managing admins |
| Admin | Everything except company deletion and managing Super Admins |
| Co-ordinator | Read all assigned projects, create and edit most daily records, no user management |
| Project Manager | Full control of assigned projects, approvals (e.g. indents, daily report sign-off) |
| Site Engineer | Create and edit daily records on assigned projects, raise indents and hindrances |
| Supervisor | Create daily records (attendance, manpower, progress) on assigned projects |
| Store Keeper | Stock, material inward and outward, indents (view and receive) |
| Purchase Team | Indents (process, mark ordered) across assigned projects |
| Client (read-only) | Read-only view of reports, insights, drawings and safety on assigned projects |

### 6.4 Permission model

- Permissions are **named capabilities** per module and action, e.g. `indent.create`, `indent.approve`, `stock.view`, `users.manage`.
- Each company has a **permission matrix**: role × capability → allowed. It covers system and custom roles, is seeded with the defaults above, and is edited by users holding `roles.manage` (the "Permission Matrix" screen in the v2 menu). Changes take effect on the user's next request. Changes are written to the audit log.
- The server checks capabilities on every request. The client receives the user's effective capabilities at sign-in and uses them **only** to hide or disable UI. That is a convenience, not security.
- Module tiles appear only if the user has that module's `.view` capability (the demo's "View as" control shows this).
- **Seeded in this phase:** full capabilities for core areas (`users.*`, `roles.*`, `projects.*`, `audit.view`, `company.*`), plus a `<module>.view` capability for each of the twelve module tiles: attendance, manpower, hindrance, indent, stock, inward, outward, drawings, equipment, safety, report, insights. Each module's detailed actions are added when that module is built. *(Claude's call)*
- **Lockout guard:** the API refuses any change that would leave a company with no active Super Admin, or remove `users.manage` and `roles.manage` from the Super Admin role. *(Claude's call)*

## 7. Architecture

### 7.1 Stack (decided)

| Layer | Choice |
|---|---|
| Language | TypeScript everywhere |
| Monorepo | pnpm workspaces: `apps/web`, `apps/api`, `packages/shared` |
| Frontend | React 19 + Vite, installable PWA (manifest + service worker for app-shell caching only in this phase) |
| Routing / data | TanStack Router (type-safe, file-based) + TanStack Query |
| Styling | Tailwind CSS v4 driven by CSS-variable design tokens |
| Motion | Motion (formerly Framer Motion) for springs, gestures, layout and presence. Browser **View Transitions API** for route-level and shared-element transitions, with a fade fallback where unsupported |
| Backend | Node + Hono, REST JSON API |
| Validation | Zod schemas in `packages/shared`, used by both API (request validation) and web (forms) |
| Database | PostgreSQL on Railway + Drizzle ORM and Drizzle migrations |
| Auth | Better Auth (email + password, sessions in HTTP-only cookies, password reset, invitations) |

### 7.2 Repository layout

```
SiteApp/
  apps/
    web/          React PWA
    api/          Hono API
  packages/
    shared/       Zod schemas, types, capability names, role defaults
  docs/
    design/       reference prototypes
    superpowers/specs/
```

### 7.3 Deployment (Railway)

| Service | Notes |
|---|---|
| `api` | Node service; runs migrations on deploy; `/health` endpoint |
| `web` | Static build served by a small static server (or Railway static hosting); SPA fallback to `index.html` |
| `postgres` | Railway Postgres plugin |

- Web and API share a parent domain, or the web app proxies `/api` to the API, so session cookies work without third-party-cookie problems. Builder picks the mechanism and documents it.
- Environments: `production` plus one `staging`. Secrets live in Railway variables only, never in the repo.
- Deploys come from the `main` branch via Railway's GitHub integration. PRs must pass CI (lint, typecheck, tests) before merge.

### 7.4 Tenant isolation (critical)

- Every tenant-owned table has `company_id NOT NULL`.
- **Postgres row-level security (RLS)** is enabled on every tenant-owned table, with a policy `company_id = current_setting('app.company_id')::uuid`.
- The API sets `app.company_id` (and `app.user_id`) at the start of each request's transaction from the authenticated session. The app connects as a non-superuser role that cannot bypass RLS.
- Platform-admin operations use a separate code path and DB role. They are never mixed into tenant request handling.
- **Required tests:** an automated test suite proves that a user of Company A gets 404 or empty results for every endpoint when targeting Company B's IDs, and that a query without the session variable returns nothing.

### 7.5 Data model (core tables only)

`companies`, `users`, `memberships` (user, company, role), `projects` (company, name, code, location, status), `project_assignments` (membership, project), `roles` (per company: `is_system` flag for the nine seeded roles, plus custom roles), `role_capabilities` (permission matrix), `invitations`, `audit_log` (company, user, action, entity, entity_id, before/after JSON, timestamp), plus Better Auth's own session tables.

All primary keys are UUIDv7 (time-ordered, client-generatable; see §9). Every row has `created_at`, `updated_at`, `created_by`, `updated_by`. Every user-visible entity has a human reference, either a code (projects) or a per-company sequence (later modules, e.g. `IND-0142`).

The **audit log** is written by the API for every create, update and delete from day one (it's in the v2 menu under Records).

## 8. Frontend shell, theming and motion

### 8.1 Shell (as in the motion demo)

- **App bar:** menu/back button (animated swap), wordmark, sync status pill, search button that expands into a field.
- **Project header:** project name with switcher (opens bottom sheet), date, role. The project code is shown in mono.
- **Today:** weather card placeholder (static "not connected yet" state is acceptable), module tile grid. Tiles show icon, name, one-line status, and a status chip slot.
- **Bottom tabs:** Today, Progress, Notes, Alerts (placeholder content OK) with sliding indicator and badge.
- **Side menu:** Display (Glove mode, Sunlight), Masters, Access Control (Permission Matrix, Users & Roles), Project settings, Records (Audit Log, …), company switcher, Sign out. Items for modules not yet built go to a "Coming soon" placeholder.
- **Module page:** a generic module scaffold (hero, stats row, entries list, "New entry" floating button, bottom-sheet form) that real modules will reuse.
- **Working screens in this phase:** sign in, company picker, invite accept, Users & Roles (list, invite, change role, deactivate), Roles (create, rename, delete custom roles), Permission Matrix (view and edit, system and custom roles), Platform admin (create company + invite Super Admin, list, suspend), Projects (list, create, edit, assign users), Audit Log (list, filter by user/date), profile.

### 8.2 Design tokens and themes

- All colours, fonts, radii, borders, shadows, spacing and motion durations/easings are CSS variables. Tailwind v4 reads them via `@theme`.
- **Themes:** `field-ops` (default) and `swiss-v2`. **Modes:** light, dark, sunlight (high contrast, thicker borders). **Mode default:** follow the device; the user can override in the side menu. Company admins can set the company's default theme. Users can override it for themselves.
- **Field Ops tokens** are in `docs/design/motion-demo.html` under `.app[data-look="field"]` (light, dark, sun). **Swiss v2 tokens** are in the same file (`.app[data-eff=…]`) and in the v2 design (`--color-bg #f3f2f2`, `--color-accent #ec3013`, Archivo, radius 0).
- **Fonts:** Field Ops uses Barlow Condensed (headings, uppercase), IBM Plex Sans (body) and JetBrains Mono (labels, chips, codes). Swiss v2 uses Archivo. Fonts are self-hosted for the PWA.
- **Glove mode:** larger touch targets (min 56px) and larger tile text.
- **Status colours** are semantic tokens (good, warn, bad, neutral) separate from the accent. "Not started" uses neutral; only overdue or blocking uses bad/accent.

### 8.3 Motion system

Motion is a shared library (`apps/web/src/motion/`) of primitives and presets. Screens compose these and don't hand-roll animations.

| Primitive | Behaviour (see demo) |
|---|---|
| Route transitions | View Transitions API: fade/scale for root, plus **shared-element morph** from a tile to its module page header and back. Falls back to a simple fade where unsupported |
| Brand hand-off | Sign-in wordmark morphs into the app bar title |
| Tab switch | Directional slide (left/right by tab order) + spring indicator |
| Staggered entrance | Lists and tile grids rise in with ~40ms stagger, on first load only (not on back navigation) |
| Bottom sheet | Spring open/close, drag-to-dismiss with velocity threshold, scrim |
| Drawer | Slide in, groups cascade |
| Press feedback | Scale-down on press for tiles, buttons and icons (spring back) |
| Skeletons | Shimmer placeholders while loading; never blank screens |
| Count-up numbers | Stats animate to value on first show |
| Feedback | Form validation shake + inline message; button loading state; toast; sync pill pulse; new row "lands" with highlight |
| Layout re-flow | Filtering or search re-flows items smoothly (layout animation) |

**Rules:** durations 150–550ms; springs with slight overshoot for things that move, ease-out for fades; respect `prefers-reduced-motion` plus an in-app "Reduce motion" setting (instant changes, no transforms). Nothing important is ever hidden behind an animation. Content stays usable at rest.

## 9. Built ready for offline (not offline yet)

So that offline capture can be added later without a rewrite:

1. **Client-generated IDs:** records use UUIDv7, and the API accepts a client-supplied ID on create.
2. **Idempotent writes:** creates and updates accept an `Idempotency-Key` header. Retries never duplicate.
3. **Versioning:** every mutable row has `updated_at` and an integer `version`. Updates send the version they edited, and the API rejects stale writes with 409 (optimistic concurrency).
4. **One data-access layer on the client:** all reads and writes go through TanStack Query hooks in one place (`apps/web/src/data/`). A later offline phase swaps the transport for a local store + sync queue behind the same hooks.
5. **Sync status UI** already exists (the pill). For now it reflects network and pending mutations.
6. **"Changed since" reads:** list endpoints accept `updated_since` for future delta sync.

## 10. Quality bar

- **CI on every PR:** lint (ESLint), format (Prettier), typecheck, unit tests (Vitest), API integration tests against a real Postgres (tenant isolation suite required), and a Playwright smoke test (platform admin creates company → Super Admin accepts invite → creates project and a custom role → invites a user → invitee signs in and sees only the tiles their role allows).
- **Accessibility:** keyboard reachable, visible focus, WCAG AA contrast in all theme × mode combinations (sunlight mode targets AAA), and labels on all controls.
- **Performance:** first load of the shell under ~200KB JS gzipped on the Today screen; Lighthouse PWA installable.
- **Phone-width check:** no clipped or wrapping button labels at 360px width.
- **Security:** password hashing via Better Auth defaults, rate-limited sign-in and invite endpoints, CSRF protection for cookie sessions, secure cookie flags, audit log on admin actions.

## 11. Decided by the owner

| Topic | Decision |
|---|---|
| Hosting | Railway |
| Repo | `SiteApp` |
| Scope of this phase | Core platform: frontend + backend foundation |
| Motion | Modern transitions and animations from day one |
| Tenancy | True SaaS, multiple companies |
| Offline | Online-only first, built ready for offline |
| Stack | Left to Claude (choices in §7.1 are Claude's recommendation; owner accepted) |
| Theme | Field Ops is the default; Swiss v2 kept as a switchable theme |
| Process | The approved motion demo is the visual reference. **No further demo per milestone.** A new demo is needed only if the look and feel itself is to change.  |
| Signup | Invite-only. The platform admin creates companies; no public signup |
| Roles | One role per person per company (not per project) |
| Custom roles | Yes. Companies can create their own roles on top of the nine system roles |

## 12. Calls made by Claude (all confirmed by owner on 2026-10-13)

- A user can belong to several companies with a different role in each.
- Platform admin (app owner) role exists above all companies, with a minimal UI.
- Billing deferred; `plan` field placeholder only. The owner invoices companies outside the app at first.
- Default permission matrix as in §6.3. Editable per company.
- RLS as the isolation mechanism (§7.4).
- Per-company subdomains come in a later phase.
- Monorepo with pnpm; Hono for the API; Better Auth.
- Staging + production environments on Railway.
- Audit log from day one.
- Weather card shows a placeholder until a weather source is chosen.

## 13. Left to the builder

- Exact folder structure inside each app, component library internals, test file layout.
- Static hosting mechanism for `web` on Railway, and the cookie/domain approach (must be documented).
- Email provider (behind an interface).
- Exact spring parameters and durations, within §8.3 rules, matched by eye to the demo.
- Icon set (Lucide matches the demo).
