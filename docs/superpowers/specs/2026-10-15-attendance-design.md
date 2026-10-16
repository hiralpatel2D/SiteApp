# Site Diary — Self Attendance (Geofence + Face) Design

**Date:** 2026-10-15
**Status:** Approved by the owner on 2026-10-16. Build plan: `docs/superpowers/plans/2026-10-16-attendance-stage-a.md` (Stage A), with Stage B to follow.
**Builds on:** `docs/superpowers/specs/2026-10-13-site-diary-core-design.md` (core platform) and the live Plan 2 code (auth, companies, roles, projects, audit)

---

## 1. Intent

Staff (engineers, supervisors, store keepers, and so on) mark their own attendance on **their own phone**. The owner's goal is to **stop cheating and lying**: proxy attendance, marking from home, and marking for a friend. Each check-in or check-out is therefore confirmed two ways:

1. **Location:** the phone is inside the project site's allowed radius (geofence).
2. **Face:** the live face belongs to the signed-in person (face detection + liveness + recognition).

When a check can't pass, the entry is not blocked outright. It goes to **Pending approval** with the reason, and a dedicated team decides.

## 2. Goals

1. One check-in and one check-out per person per day at their assigned project site.
2. The face flow: the camera opens → a face is detected and recognised → the **screen turns green** → the person **holds still for 3 seconds** → check-in or check-out is confirmed → a confirmation screen states exactly what was recorded (action, time, site, distance).
3. Geofence per project, set by Admin and Super Admin: site location plus an allowed radius.
4. Face registration happens in the presence of a senior person, who approves it.
5. Failed checks go to Pending approval with the reason. The attendance team approves or rejects, and every decision is audited.
6. A 7:00 PM check-out reminder. Days still missing a check-out go to Pending approval the next morning.
7. Management view: today's summary, a people list, the pending approvals queue, and a monthly calendar with Excel export.
8. **Attendance tile ("container")** on the Today screen: its own unique icon at the top. It **turns green only when the person's attendance is marked today**; otherwise it stays neutral. It shows a one-line status ("Checked in 08:52", "Pending approval", "Not checked in").

## 3. Non-goals (this phase)

- Labour headcount by trade. That is the separate Manpower module.
- Shift rosters, overtime, leave management and payroll calculation. The monthly export feeds payroll; it is not payroll.
- Native iOS or Android apps. This remains the installable PWA (spec §4 of core).
- Offline check-in. It is online-only first, built to allow offline later (core §9). A check-in without signal shows "No connection. Try again when you have signal."
- Shared gate kiosks (one device for everyone). Each person uses their own phone.

## 4. Anti-goals (a failure even if it "works")

- **A photo or video of someone's face passes.** Liveness is mandatory, not optional.
- **Face photos stored long-term or reused.** Store a face *template* (a numeric code), not photo galleries. Selfies taken for disputes are kept only as long as the review needs them (§8).
- **The client decides the match.** The server makes the final face decision. A tampered app must not be able to say "matched".
- **Nobody can tell why an entry is pending.** Every pending entry carries a plain-English reason.
- **Small text on the orange fill**, or any UI that breaks at 360px (core design rules).

## 5. Roles and permissions

New capabilities. They are added to the shared capability list and seeded into system roles. Custom roles can be granted them in the Permission Matrix.

| Capability | Meaning | Default holders |
|---|---|---|
| `attendance.view` | See the Attendance tile and mark one's own attendance | All system roles except Client |
| `attendance.approve_face` | Approve a colleague's face registration (the senior person) | Super Admin, Admin, Project Manager |
| `attendance.review` | See the team's attendance, the pending queue, and approve or reject entries, for projects the reviewer can see | Super Admin, Admin, Project Manager, Co-ordinator |
| `attendance.settings` | Set a project's site location, radius, start time, late threshold and reminder time | Super Admin, Admin |
| `attendance.export` | Export the monthly Excel | Super Admin, Admin |

`attendance.view` replaces the existing placeholder capability for the attendance tile. Visibility follows `projects.all` and project assignment, exactly as Projects does. A reviewer cannot approve their own entry.

## 6. Per-project attendance settings

| Setting | Default | Range / rule |
|---|---|---|
| Site location | — (required before anyone can check in) | Set by "Use my current location" while standing on site (accuracy shown; refused if worse than 50 m), or by dropping a pin on a map |
| Allowed radius | 100 m | 25–1000 m |
| Working day starts | 09:00 | Local time (company timezone, default Asia/Kolkata) |
| Late after | 15 min | 0–120 min |
| Check-out reminder | 19:00 | Any time after the start time |

A project without a site location shows on the tile as "Attendance not set up for this project", with a link to settings for those allowed to change them. Every change is audited.

## 7. Flows

### 7.1 Face registration (once per person, repeated on request)
1. On first use the person sees "Register your face". They give **consent** first, with a plain-English notice: what is stored, why, how long, and how to delete it.
2. The camera opens and a **liveness check** runs: follow 2 random prompts, such as turn left, blink, or smile. Then several frames are captured.
3. The server creates the face template, and the registration becomes **Pending senior approval**.
4. A senior with `attendance.approve_face`, standing with the person, opens **Approvals → Face registrations**, sees the captured photo and the person's name, and taps **Approve** or **Reject**. The registration photo is kept until it's approved or rejected, then deleted. Only the template remains.
5. Until approved, the person cannot check in, and the tile says "Face registration pending approval".
6. Re-registration (new phone, injury, a big change in appearance) follows the same steps. The old template stays valid until the new one is approved.

### 7.2 Daily check-in / check-out
1. The person taps the Attendance tile. The screen shows the project, today's status and a big action button: **Check in** (or **Check out** once checked in).
2. **Location:** the app reads GPS. It shows distance from the site and accuracy, e.g. "42 m from site · ±12 m".
3. **Face:** the camera opens and a face outline guides the person. Liveness runs with one random prompt.
   - On a recognised match, the **whole screen turns green** with "Hold still… 3, 2, 1".
   - If the face leaves the frame or the match drops during the 3 seconds, the countdown resets.
4. After 3 seconds the app sends the server the GPS reading, the captured frames and the liveness result. **The server decides:**
   - Inside the radius, the face matches and liveness passed → **Recorded**.
   - Any check fails → **Pending approval**, with every failing reason listed, e.g. "Outside site radius (180 m, allowed 100 m)", "Face not matched (score 0.52)", "Liveness failed", "Location accuracy too low (±250 m)", "Possible mock location".
5. **Confirmation screen**: a large tick (green) or clock (amber), plus the plain statement "Checked in at 08:52 · Riverside Tower · 42 m from site". For pending entries it says "Sent for approval: Outside site radius". Late check-ins are marked "Late (by 12 min)".
6. The tile turns green when there is a recorded check-in for today. A pending check-in keeps the tile neutral with an amber "Pending approval" chip.

### 7.3 Reminders and missing check-out
- At the project's reminder time (19:00), anyone checked in but not out gets a push notification: "You haven't checked out today. Tap to check out."
- At 04:00 the next day, a day with a check-in but no check-out becomes **Pending approval** with the reason "No check-out". The reviewer can set a check-out time on approval.
- **Push notifications:** Android Chrome works once the person allows notifications. iPhone works only if Site Diary is **added to the Home Screen** (iOS 16.4+), so the registration flow guides iPhone users to do this.

### 7.4 Review (attendance team)
- **Today:** summary counts (Present · Late · Pending · Not checked in · Checked out). A people list shows name, check-in and check-out times, distance and flags. It can be filtered by project.
- **Pending approvals:** each entry shows the reason(s), the selfie captured at the time, the location on a map against the site circle, the distance and accuracy, and the match score. **Approve** or **Reject**, with an optional note. The decision is final and audited, and the person sees the outcome on their tile and history.
- **Monthly:** a per-person calendar (present, late, absent, pending, rejected) with an **Excel export** of one row per person per day: date, project, in, out, hours, status, late minutes, reasons and reviewer.

## 8. Face technology and privacy *(Claude's calls, reviewable)*

| Topic | Decision |
|---|---|
| Detection and guidance (on phone) | Use an on-device face landmark model in the browser (e.g. MediaPipe Face Landmarker, WASM). It drives the face outline, the green screen and the liveness prompts in real time, with no video sent while guiding. |
| Liveness | Active liveness: random prompts (blink, turn left or right), checked on-device for UX. Then **re-checked on the server** from the captured frame sequence, together with a passive anti-spoof check (screen or print replay). |
| Recognition (server) | The server computes a face embedding (e.g. an ArcFace-class model via ONNX Runtime in the API, or a separate small inference service) from the captured frames and compares it with the person's approved template. The match threshold is configurable; default chosen for a low false-accept rate, with near-misses going to Pending. |
| What is stored | The face **template** (encrypted at rest, per company, under RLS). The frames from each check-in are kept only when the entry is pending, for the reviewer, and deleted **30 days** after the decision. Recorded entries keep no image. |
| Consent and rights | Explicit consent screen before registration (India DPDP Act 2023). The person can view and delete their registration, which stops face check-in. The template is deleted when the membership is deactivated, or 30 days later for audit grace. |
| Mock location | The browser cannot reliably detect mock-GPS apps. The server flags impossible jumps and implausibly perfect accuracy, and very poor accuracy readings, and sends them to Pending. The face check stays the second wall. |
| Accuracy limits | No face system is perfect. Near-threshold cases go to Pending rather than being rejected. False rejects are cheap (a reviewer approves); false accepts are what we design against. |

## 9. Data model (new tenant tables, all under RLS with the core column set)

- `attendance_settings` (per project): lat, lng, radius_m, start_time, late_after_min, reminder_time, timezone.
- `face_registrations`: membership, status (pending / approved / rejected / superseded), template (encrypted bytes), model_version, consent_at, approved_by, approved_at, photo (temporary, nulled after decision).
- `attendance_entries`: membership, project, work_date, kind (check_in / check_out), at, lat, lng, accuracy_m, distance_m, match_score, liveness_passed, status (recorded / pending / approved / rejected), reasons (text[]), late_min, reviewed_by, reviewed_at, review_note, evidence (temporary frames, nulled per §8). Unique: one check-in and one check-out per membership per work_date (a rejected entry can be retried).
- `push_subscriptions`: membership, endpoint, keys, created_at.

Every insert, approval and rejection writes an audit row.

## 10. Quality bar (in addition to core §10)

- **Tests:**
  - Geofence math with real coordinates.
  - Every pending reason.
  - Late calculation in the company timezone, including the day boundary.
  - One-check-in-per-day rule.
  - Reviewers can't see projects they don't have access to (cross-company and cross-project 404).
  - A reviewer can't approve their own entry.
  - Template and evidence retention jobs.
- **Face pipeline tests:** a fixed set of test images (same person, different person, printed photo, screen replay) with expected outcomes, run in CI.
- **E2E:** register → approve → check in inside the radius (green, recorded, tile green) and outside it (pending with reason) → reviewer approves. Uses a fake camera stream and mocked geolocation.
- The face flow works at 360px and in sunlight mode. The green-screen state still meets contrast rules, and the camera prompts are large and plain.

## 11. Decided by the owner

| Topic | Decision |
|---|---|
| Who marks | Each person on their own phone |
| Purpose | Stop cheating: double confirmation by face and location |
| Face registration | Done in the presence of a senior person |
| Failed checks | Go to Pending approval with the reason; a dedicated team approves or rejects |
| Check-out | Reminder at 7 PM |
| Settings | Admin and Super Admin set the project site location and allowed radius |
| Tile | Unique icon on top; turns green only when attendance is marked |
| Face flow | Screen turns green on recognition; hold 3 seconds to confirm; then a confirmation of the action taken |
| Management view | Today summary, people list, pending queue, monthly calendar with Excel export |
| Working days | **Every day.** Construction sites work all week, so there are no weekly offs or holidays in the calendar. A day without a check-in is absent. |
| Libraries | Use relevant open-source GitHub projects. Face detection, recognition, anti-spoof and liveness use **vladmandic/human** (MIT): light models in the browser for guidance, and the decision on the server. Thresholds come from its Face ID demo. |
| Green screen | The screen turns green only after the **server** confirms the face matches (one frame sent for a quick match). The 3-second hold then captures 3 frames, and the server re-checks everything before recording. |

## 12. Claude's calls (owner to check)

- Defaults: start 09:00, late after 15 min, radius 100 m (25–1000 m).
- New capabilities and their default holders (§5). The "dedicated team" is anyone holding `attendance.review`.
- Missing check-out becomes pending at 04:00 the next day.
- On-device guidance plus server-side recognition and liveness re-check; templates instead of photos; pending evidence kept for 30 days after the decision.
- **Which project:** a person checks in to the project currently selected in the project switcher, and must be assigned to it (or hold `projects.all`). One check-in and one check-out per person per day, whichever project it is at. Multi-site days are out of scope for now.
- **Face approver reach:** `attendance.approve_face` holders can approve only people who share a project they can see (`projects.all` sees everyone in the company). Nobody can approve their own registration or re-registration.
- **Face test set:** built from consented photos (the owner's team or synthetic faces). No public datasets with unclear licences. Face inference runs on CPU inside the API service. If its latency (target under 1.5 s per check-in) or memory forces it, it moves to a separate small Railway service.
- iPhone users are guided to "Add to Home Screen" for reminders.

## 13. Left to the builder

- The exact face model and liveness model (must meet the anti-goals and the test set in §10), and whether inference runs in the API or a separate service on Railway.
- Map provider for the pin-drop and reviewer map (OpenStreetMap tiles preferred; no paid key needed).
- Push delivery details (Web Push with VAPID keys from env).
- Excel generation library.
