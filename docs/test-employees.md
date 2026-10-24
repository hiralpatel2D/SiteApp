# Test employees

Seven throwaway people for checking what each role sees. None is Super Admin or Admin.
Every email ends in `@sitediary-test.example`; `remove` deletes by that suffix only, so real people are never touched.

| Role | Email |
|---|---|
| Co-ordinator | coordinator@sitediary-test.example |
| Project Manager | project-manager@sitediary-test.example |
| Site Engineer | site-engineer@sitediary-test.example |
| Supervisor | supervisor@sitediary-test.example |
| Store Keeper | store-keeper@sitediary-test.example |
| Purchase Team | purchase@sitediary-test.example |
| Client (read-only) | client@sitediary-test.example |

Each has a verified account, a password with no forced change, an active membership and every active
project of the company, so they sign in directly (no invite, no onboarding steps). Face registration is
not faked; register a face from a phone if you need to test attendance.

With no `--company`, `seed` uses a separate **Test Workspace** (`test-workspace`), creating it with one sample project
if missing, so real company data stays clean. Pass `--company` to seed an existing workspace instead.

Run against the database the env vars point at (from `apps/api`; use the Railway env for the live app):

```sh
pnpm test-employees seed [--company <workspace-name>] [--password <pw>]   # default password TestEmployee#2026
pnpm test-employees list
pnpm test-employees remove    # deletes them, their assignments, faces and attendance entries
```

`seed` can be run again safely (existing ones are skipped). Both commands leave an audit entry.
In an existing company they appear in its Team list, attendance log and monthly summary while they exist.
`remove` deletes the people but leaves the Test Workspace itself.
