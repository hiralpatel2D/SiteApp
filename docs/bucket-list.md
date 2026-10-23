# Site Diary: bucket list

Things asked for or known, not built yet. Newest decisions first. Each item says what was
asked, my recommended design, and what is still open. Update this file when an item is built.

## A. Asked on 2026-10-23, parked by the owner ("skip for now")

Recommended order if picked up: A1 → A2 → A3 → A4 → A5 (build the testing tools first, so every
later item can be checked per role).

| # | Item | Recommended design | Open question |
|---|---|---|---|
| A1 | ✅ **Live (PR #19, deployed 2026-10-23): View as another user** (super admin switches to what a person sees, to test visibility) | Pick a person; the whole app shows exactly their menu, screens and data. **Read-only** (no saving or approving), a banner "Viewing as X. Exit", every use audited. Only a Super Admin, only inside their own company. Server side: a header that swaps the tenant context, writes refused. | none |
| A2 | **Demo data** (to see what is shown or hidden per user) | A separate **Demo Company** workspace with sample people, projects, check-ins, pending items and absences, and the owner as its Super Admin. Not loaded into the real company (it would pollute real summaries and Excel files). | none |
| A3 | **Public holidays** | A holiday list (date and name). On a holiday, no check-in is not absent; if someone works, it still counts as present. Shown as **H** in the summary and Excel. Settings right: `attendance.settings`. | ✅ Decided 2026-10-23: company-wide list **plus per-project changes**; weekly offs set **per project**. See docs/handoff.md. |
| A4 | **Leave applications** for employees | Apply with from, to, type (Casual, Sick, Unpaid, Other) and reason. Reviewers (`attendance.review`) approve or reject; same sole-approver rule as faces and check-ins. Approved leave shows as **LV** and is not absent. | ✅ Decided 2026-10-23: **no balances in v1**. See the leave rules in docs/handoff.md. |
| A5 | **Super Admin override of attendance** | Mark a person present or absent for any day, change a time, or reverse an approval. A **reason is required**, it is audited, and it carries a **Manual** tag in the log, summary and Excel. New capability `attendance.override`, Super Admin only. Needs a migration (entry `source`, note; backfill the capability for existing Super Admin roles). Build after A3 and A4 so it handles holidays and leave. | none |

Cross-module effects to check when building A3 to A5: the monthly summary and Excel (new
statuses H, LV, Manual), the Attendance log, Approvals (a Leave tab), the Home tile, Team
(deactivated people), Projects (Active/Inactive), the audit log, and role menus.

## B. Stage B leftovers

| # | Item | Notes |
|---|---|---|
| B1 | 7 PM reminder | Needs a scheduler and web push. |
| B2 | Missing check-out job | Needs a scheduler. Decide the rule (auto close, or flag for review). |
| B3 | Face data and evidence retention, self-service face deletion | Photos of pending check-ins are kept for the reviewer; set how long. |

## C. Safety and hardening (do before real workers use it)

| # | Item | Notes |
|---|---|---|
| C1 | **Spoof tests on real phones** | Printed photo and screen replay must go to Pending; a different person must not match; 5 genuine check-ins must all be Recorded. Blink-only plus the near-identical-frame rule being dropped weakens replay defence. |
| C2 | Head-turn or blink **challenge from the server** (ruling R23) | The server cannot yet tell a live blink from a video of one. |
| C3 | **Rotate Railway-held secrets** | After the Oct 21 Railway incident: `FACE_TEMPLATE_KEY` (free to rotate until real faces are registered), `BETTER_AUTH_SECRET`, Postgres credentials, owner bootstrap password. Needs a deploy to pick up. |
| C4 | A second approver | Invite a second Super Admin or PM so approvals are not self-approvals. |
| C5 | Measure thresholds on real phones | Face match 0.50, liveness 0.60, 160 px face width, 176 px guide margin. The server logs scores for every pending check. |

## D. Working notes

- Deploys: Railway deploys only when told (connect the service source again for api and web).
- Before merging: CI green on the final commit; the real-browser journey covers the attendance flow.
- Sessions get expensive when long: one stage per fresh session.
