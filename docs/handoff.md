# Site Diary: handoff note (2026-10-23)

For a fresh chat. Read this, then `docs/bucket-list.md`. Do not re-derive anything listed as live.

## What it is
Multi-company construction SaaS ("Site Diary"), Field Ops theme. Monorepo (pnpm): `packages/shared`,
`apps/api` (Hono, Drizzle, Postgres with row level security via `withTenant`/`runInTenant`, Better Auth),
`apps/web` (React 19, Vite, TanStack Router file routes, Tailwind v4, PWA).
Live: https://web-production-a648e.up.railway.app (Railway project ed63112f-f42d-46df-a2a5-b2142394168d,
env c0fe27f0-9129-492a-819b-84c2e0f0cbb8, api service e247f26a-67a4-46f9-8b41-0e35428a31c6,
web service 1069e012-96ba-4aa6-aa5b-66c0c1a467ff).

## Live now (main at e1e8d5b, PR #20)
| Area | State |
|---|---|
| Core app, projects, team invites, roles | live |
| Self attendance: site location, face registration + approval, check-in/out with face and radius check | live |
| Pending reviews (own items listed; sole-approver rule), approvals | live |
| Attendance log: one table, paired in/out, status and late tags, date presets, status capsules, late-only, name search, sortable | live (PR #20) |
| Monthly summary: one table (totals + day grid), sortable, name search, month in heading; Excel export | live |
| Super Admin "View as…" (read-only, banner, audited, 2 h token) | live (PR #19); owner reported not seeing it, **role not yet confirmed** |

## Open question to resolve first
The owner could not find "View as…". It shows only when the login's role in that company is exactly
**Super Admin**. Ask what role the Menu shows under the company name. Admin or Platform admin only
means working as designed (decide whether to widen or to make them Super Admin). Super Admin means a real bug.

## Decisions made for the next build (leave and holidays, 2026-10-23, owner chose all defaults)
Holidays
- Company-wide holiday list, with per-project changes (add or remove for one project).
- Weekly off days set per project.
- Edit: Super Admin and Admin only (`attendance.settings`), every change audited.
- Holiday shows as **H** in the summary and Excel, never Absent.
- Working on a holiday: counts as present, tagged "Worked on holiday".

Leave (version 1: simple, **no balances**)
- Types: Casual, Sick, Unpaid.
- Employee applies (from, to, type, optional reason); a manager may also enter it on their behalf.
- Approver: the person's project manager, Admin as fallback; same sole-approver rule as faces and check-ins.
- Past dates allowed up to 7 days back, flagged "late entry".
- Approved leave replaces Absent in summary and Excel. **Code: use `LV`, not `L`**: `L` already means Late
  in the summary legend (an earlier chat message said "L"; that was a slip).
- Employee may cancel before it starts; the manager is notified.
- Visibility: employee sees own leave plus an "Away" marker for their project team; managers see dates for
  their project team; reasons readable only by manager and Admin; medical detail never required.

Cross-module effects to check: summary and Excel (H, LV, Manual), Attendance log, Approvals (a Leave tab),
Home tile, Team (deactivated people), Projects (Active/Inactive), audit log, role menus, view-as.

## Still parked (see bucket list)
A2 demo workspace; A5 Super Admin override (reason required, "Manual" tag, `attendance.override`, migration);
B reminders and missing check-out job and retention; C safety items.

## Before real workers use it (not done)
Rotate the Railway-held secrets (FACE_TEMPLATE_KEY, BETTER_AUTH_SECRET, database credentials, bootstrap
password); printed-photo and screen-replay face tests; face thresholds (match 0.50, liveness 0.60) are
unmeasured on real phones; Excel download and the new log table untested on real phones.

## How to work (owner's standing rules)
- After any completed task, give the webapp link: https://web-production-a648e.up.railway.app
- Honest pushback, no flattery; plain English with tables and numbered lists; do not re-ask settled requirements.
- Test well before deploy; map cross-module effects first.
- Per change: branch `claude/dreamy-heisenberg-cxao9d` from origin/main, draft PR, wait for CI job "verify" on
  the final head SHA, mark ready, squash merge (pass expectedHeadSha), then deploy api and web with Railway
  `connect-service-source` (repo hiralpatel2D/SiteApp, branch main) and verify logs: api "Migrations applied."
  + "API listening"; web "web listening". Railway does not auto-deploy on merge; an image-push failure once
  needed a single retry.
- Local checks: `scripts/test-db.sh start` (Postgres on 54329), `pnpm lint`, `pnpm format:check`,
  `pnpm typecheck`, `pnpm test`, `pnpm build`, Playwright with
  `PW_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome`.
