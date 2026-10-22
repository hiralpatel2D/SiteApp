# Self Attendance — Stage A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff mark their own attendance every day on their own phone, with geofence plus server-verified face recognition. Failures go to a pending queue with reasons. Admins set each site's location and radius, a senior approves each person's face, and the Home tile turns green once attendance is marked.

**Architecture:** One open-source face library, **vladmandic/human 3.3.6 (MIT, github.com/vladmandic/human)**, runs on both sides:
- **In the browser**, light models (blazeface, facemesh, iris) guide the person in real time: framing, distance and blink.
- **On the API**, the heavy models (faceres embedding, antispoof, liveness) make every decision from JPEG frames the phone sends. The client never decides a match.
- Thresholds and the match formula come from the library's own Face ID demo (`demo/faceid`).

Geofencing is server-side haversine distance against a per-project circle. Everything lives in new RLS-protected tenant tables, and all writes are audited.

**Tech Stack:** Existing monorepo (Hono, Drizzle, Postgres RLS, Better Auth; React 19, TanStack Router, Tailwind v4). New libraries:
- `@vladmandic/human@3.3.6`
- `@tensorflow/tfjs-core`, `@tensorflow/tfjs-converter` and `@tensorflow/tfjs-backend-wasm`, all `@4.22.0` (API only)
- `sharp@0.34.4` (API JPEG decode)

**Spec:** `docs/superpowers/specs/2026-10-15-attendance-design.md`. Stage B (today summary, monthly calendar + Excel, 7 PM push, missing-check-out job, retention jobs) follows in its own plan.

## Global Constraints

- Attendance is **every day**. There are no weekly offs or holidays in Stage A.
- Timezone `Asia/Kolkata` for work date and lateness.
- Defaults, enforced by the shared schema:
  - radius **100 m** (25–1000)
  - start **09:00**
  - late after **15 min** (0–120)
  - reminder **19:00** (stored now, used in Stage B)
- Site location from "Use my current location" is refused when GPS accuracy is worse than **50 m**.
- A check whose GPS accuracy is worse than **100 m** goes to pending: "Location accuracy too low (±N m)".
- Face match uses Human `match.similarity(a, b, { order: 2, multiplier: 25, min: 0.2, max: 0.8 })`.
  - **≥ 0.50** passes.
  - Below that the check is pending: "Face not matched (score 0.NN)".
- Antispoof `real` and liveness `live` must each be **≥ 0.60** (averaged over frames). Otherwise pending: "Liveness failed".
- Each frame must hold **exactly one** face, with a box of at least **160 px** wide. Otherwise pending: "Face not clear".
- Frames:
  - check-in or check-out: **3** JPEG frames
  - registration: **5**
  - pre-match ("green screen"): **1**
  - each JPEG at most **640 px** on its longest side and **300 KB**
  - request body at most **2 MB**
- Templates are stored only AES-256-GCM encrypted with `FACE_TEMPLATE_KEY` (32 bytes, base64). The key is required in production; the test config uses a fixed key.
- Images:
  - The registration photo is kept until approve/reject, then set to null.
  - Pending check frames are kept for the reviewer. Stage B deletes them 30 days after the decision.
  - Recorded entries keep no image.
- One active check-in and one active check-out per membership per work date. A rejected entry may be retried.
- Nobody approves their own face registration or their own pending entry.
- Reviewers and face approvers reach only people on a project they can see (`projects.all` sees the whole company).
- Copy:
  - plain English, catalogue errors `{error:{code,message,details?}}`
  - large text only on the accent fill
  - works at 360 px and in sunlight mode
- Every insert, approve and reject writes an audit row.

## Review Focus

1. **iPhone Safari camera/GPS denial.** The person must see a plain fix ("Allow camera in Settings › Safari"). The screen must never spin forever. → Task 9 test `shows a plain message when the camera is blocked`.
2. **Checking out without a check-in**, or checking in twice. Expect a clear 409, not a 500. → Task 6 tests `409 check_in_first` and `409 already_checked_in`.
3. **Project without a site location.** The tile says "Attendance not set up for this project", and the API refuses with 409 `attendance_not_set_up`. → Task 6 and Task 10 tests.
4. **Midnight boundary in IST.** A check-in at 00:30 IST belongs to that IST date, not the UTC date. → Task 1 test `workDate uses Asia/Kolkata`.
5. **Huge or garbage frame uploads.** Expect 400 `invalid_image` or 413, never a crash or memory blow-up. → Task 3 test `rejects non-JPEG bytes` and Task 6 test `413 on oversized body`.

---

## File map

| Area | Files |
|---|---|
| Shared | `packages/shared/src/capabilities.ts` (new caps), `roles.ts` (defaults), `attendance.ts` (new: schemas, geo, time, decision, reasons), `index.ts` |
| DB | `apps/api/src/db/schema.ts`, `apps/api/drizzle/0005_attendance.sql` (generated + hand-added backfill), `apps/api/src/db/rls.sql` |
| API face | `apps/api/src/attendance/face/engine.ts`, `apps/api/src/attendance/face/template.ts`, `apps/api/src/attendance/face/fake.ts` |
| API routes | `apps/api/src/attendance/settings.ts`, `registration.ts`, `checks.ts`, `review.ts`, `reach.ts`, `routes.ts` (mounts all at `/api/attendance`) |
| Config | `apps/api/src/config.ts` (`faceTemplateKey`), `apps/api/src/app.ts` (`faceEngine` dep) |
| Web | `apps/web/src/lib/attendance.ts`, `apps/web/src/attendance/face-guide.ts`, `apps/web/src/attendance/CameraCheck.tsx`, routes `attendance.tsx`, `attendance.register.tsx`, `attendance.settings.tsx`, `attendance.approvals.tsx`; `home.tsx` tile; `scripts/copy-face-models.mjs` |

---

### Task 1: Shared attendance rules and new capabilities

**Files:**
- Create `packages/shared/src/attendance.ts`.
- Modify `capabilities.ts`, `roles.ts` and `index.ts`.
- Test: `packages/shared/test/attendance.test.ts`.

**Interfaces — Produces:**
- `ATTENDANCE_CAPABILITIES = ['attendance.approve_face','attendance.review','attendance.settings','attendance.export'] as const`. These are added to `CAPABILITIES`. `attendance.view` already exists.
- `distanceMeters(a:{lat:number,lng:number}, b:{lat:number,lng:number}): number` (haversine, R = 6371008.8).
- `workDate(at: Date, tz = 'Asia/Kolkata'): string` (`YYYY-MM-DD`).
- `lateMinutes(at: Date, start: 'HH:MM', lateAfterMin: number, tz?): number`. Returns minutes after start when beyond the threshold, else 0.
- `type CheckSignals = { distanceM:number; radiusM:number; accuracyM:number; faces:number; minFaceWidth:number; similarity:number|null; real:number; live:number }`.
- `decideCheck(s: CheckSignals): { status: 'recorded'|'pending'; reasons: string[] }`. The reasons are the exact strings from Global Constraints plus `Outside site radius (N m, allowed R m)` and `Possible mock location` (accuracy below 1 m).
- `attendanceSettingsBodySchema`: `{ lat, lng, radiusM=100, startTime='09:00', lateAfterMin=15, reminderTime='19:00', version? }`.
- `checkBodySchema`: `{ projectId: uuid, kind: 'check_in'|'check_out', lat, lng, accuracyM, frames: string[] (3, base64 JPEG) }`.
- `faceRegistrationBodySchema`: `{ consent: true, frames: string[5] }`.
- `reviewDecisionBodySchema`: `{ note?: string<=500 }`.

Role defaults:

| Capability | Holders |
|---|---|
| `attendance.approve_face` | super_admin, admin, project_manager |
| `attendance.review` | super_admin, admin, project_manager, coordinator |
| `attendance.settings` | super_admin, admin |
| `attendance.export` | super_admin, admin |

- [ ] **Step 1: Write the failing tests.**
  - `distanceMeters` from (19.0760, 72.8777) to (19.0769, 72.8777) is ≈ 100 m (within ±1).
  - `workDate(new Date('2026-10-15T19:00:00Z'))` is `'2026-10-16'` (00:30 IST).
  - `lateMinutes` at 09:20 IST with start 09:00 and 15 min allowed is 20; at 09:10 IST it is 0.
  - `decideCheck` with distance 180, radius 100 gives pending with `Outside site radius (180 m, allowed 100 m)`.
  - Similarity 0.42 gives `Face not matched (score 0.42)`; accuracy 250 gives `Location accuracy too low (±250 m)`; `real` 0.3 gives `Liveness failed`; 2 faces gives `Face not clear`.
  - An accuracy below 1 m gives `Possible mock location` (real phones never report that precision).
  - When everything passes: `{status:'recorded', reasons:[]}`.
  - Several failures list every reason, in the order radius, accuracy, face, liveness.
  - `defaultCapabilities('coordinator')` includes `attendance.review` but not `attendance.settings`.
- [ ] **Step 2:** Run `pnpm --filter @sitediary/shared test`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement. Use `Intl.DateTimeFormat` with `timeZone` for IST, with no date library.
- [ ] **Step 4:** Run the tests again. Expected: PASS. Then run `pnpm -r typecheck`.
- [ ] **Step 5:** Commit `feat(shared): attendance rules, schemas and capabilities`.

### Task 2: Tables, RLS and capability backfill

**Files:** `apps/api/src/db/schema.ts`, `apps/api/drizzle/0005_attendance.sql` (from `pnpm --filter api db:generate`, then append the backfill), `apps/api/src/db/rls.sql`. Test: `apps/api/test/attendance-schema.test.ts`.

**Interfaces — Produces:** these Drizzle tables, all with `...common` and `companyId()`.

**`attendanceSettings`**
- `projectId` uuid; unique `(company_id, project_id)`; composite FK to `projects`.
- `lat`, `lng`: `doublePrecision`.
- `radiusM` int; `startTime` text; `lateAfterMin` int; `reminderTime` text.
- `timezone` text, default `'Asia/Kolkata'`.

**`faceRegistrations`**
- `membershipId`.
- `status`: check in `('pending','approved','rejected','superseded')`.
- `template`: bytea (`customType`).
- `modelVersion` text; `consentAt` timestamptz.
- `photo`: bytea nullable.
- `decidedBy` uuid; `decidedAt`.
- Composite FK to `memberships`.
- Partial unique index: one `approved` per membership; one `pending` per membership.

**`attendanceEntries`**
- `membershipId`, `projectId`, `workDate` (date as text), `kind` (check in `check_in`/`check_out`), `at`.
- `lat`, `lng`, `accuracyM`, `distanceM`, `similarity` (nullable), `real`, `live`.
- `status`: check in `('recorded','pending','approved','rejected')`.
- `reasons` text[]; `lateMin` int.
- `reviewedBy`, `reviewedAt`, `reviewNote`.
- `evidence`: bytea[], nullable.
- Composite FKs to `memberships` and `projects`.
- Partial unique index `attendance_entries_one_per_day` on `(membership_id, work_date, kind) WHERE status <> 'rejected'`.

**Backfill and RLS**
- The backfill SQL inserts the four new caps into `role_capabilities` for every existing system role, following the Task 1 table (`ON CONFLICT DO NOTHING`). Also add them to company creation's seeding if it does not already read `defaultCapabilities`.
- RLS: `tenant_isolation` policy plus FORCE on all three tables, and grant SELECT/INSERT/UPDATE to `app_user`. No DELETE on `attendance_entries`.

- [ ] **Step 1: Write the failing tests.**
  - Insert across companies under `withTenant(a)`. The `b` rows are invisible.
  - A second non-rejected `check_in` for the same membership and date violates `attendance_entries_one_per_day`. A second one after the first is set to `rejected` succeeds.
  - After migrate, an existing company's `admin` role holds `attendance.settings`.
  - `app_user` cannot DELETE from `attendance_entries` (permission denied).
- [ ] **Step 2:** Run `bash scripts/test-db.sh start && pnpm --filter api test attendance-schema`. Expected: FAIL.
- [ ] **Step 3:** Implement the schema, generate the migration, append the backfill, and add RLS.
- [ ] **Step 4:** Run the tests again and `pnpm --filter api test migrate`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(api): attendance tables with RLS and capability backfill`.

### Task 3: Server face engine and template encryption

**Files:** `apps/api/src/attendance/face/engine.ts`, `template.ts`, `fake.ts`; `apps/api/package.json` dependencies; `apps/api/src/config.ts` (`faceTemplateKey: Buffer`, from env `FACE_TEMPLATE_KEY`, required in production, fixed in test); `docs/deploy/railway.md` (add the variable). Test: `apps/api/test/face-engine.test.ts`, `template.test.ts`.

**Interfaces — Produces:**
```ts
export type FaceReading = { faces: number; minFaceWidth: number; embedding: number[] | null; real: number; live: number };
export interface FaceEngine {
  read(jpeg: Buffer): Promise<FaceReading>;            // throws AppError(400,'invalid_image','Could not read the photo. Try again.')
  similarity(a: number[], b: number[]): number;       // Human match.similarity with order 2, multiplier 25, min 0.2, max 0.8
  readonly modelVersion: string;                       // 'human-3.3.6/faceres'
}
export function createHumanEngine(): FaceEngine;       // lazy singleton load on first read
export function createFakeEngine(map?: (jpeg: Buffer) => FaceReading): FaceEngine; // tests/e2e
export function encryptTemplate(embedding: number[], key: Buffer): Buffer;   // AES-256-GCM: iv(12)|tag(16)|ciphertext(Float32)
export function decryptTemplate(blob: Buffer, key: Buffer): number[];
export function averageEmbedding(list: number[][]): number[]; // mean, then L2-normalise
```

**Engine notes**
- Load `@vladmandic/human/dist/human.node-wasm.js` by absolute path. Its `exports` map is broken, so use `createRequire` + `require.resolve('@vladmandic/human/package.json')`.
- `wasmPath` and `modelBasePath` are `file://` URLs. During `load()`, patch `fetch` for `file://` URLs only, then restore it.
- Config:
  - `cacheSensitivity: 0`, `face.detector.skipFrames: 0`, `maxDetected: 3`
  - `description`, `antispoof` and `liveness` enabled
  - `emotion`, `iris`, `body`, `hand`, `object` and `gesture` disabled
- Decode with `sharp(jpeg).rotate().resize({ width: 640, height: 640, fit: 'inside' }).removeAlpha().raw()`. Dispose tensors.
- `API_FACE_ENGINE=fake` in env selects the fake engine (e2e only; the config refuses it in production).

- [ ] **Step 1: Write the failing tests.**
  - `encryptTemplate`/`decryptTemplate` round-trip within 1e-6; a wrong key throws.
  - `averageEmbedding` has unit L2 norm.
  - The real engine on a blank 320×320 grey JPEG (made with sharp in the test) returns `faces: 0` within 15 s.
  - Non-JPEG bytes throw `invalid_image`.
  - `similarity(x, x) ≥ 0.99`.
- [ ] **Step 2:** Run `pnpm --filter api test face-engine template`. Expected: FAIL.
- [ ] **Step 3:** Implement and add the dependencies (exact versions above).
- [ ] **Step 4:** Run the tests again. Expected: PASS. Record the first-load time in the PR.
- [ ] **Step 5:** Commit `feat(api): server face engine (human, wasm) and encrypted templates`.

### Task 4: Reach rules and per-project settings API

**Files:** `apps/api/src/attendance/reach.ts`, `settings.ts`, `routes.ts`; `apps/api/src/app.ts` (mount `/api/attendance`; pass `faceEngine`, `config`). Test: `apps/api/test/attendance-settings.test.ts`.

**Interfaces — Produces:**
- `canSeeProject(tx, t: Tenant, projectId): Promise<boolean>` (`projects.all` or assigned).
- `sharesProject(tx, t: Tenant, membershipId): Promise<boolean>` (`projects.all`, or any common assignment).
- `GET /api/attendance/settings/:projectId` (`attendance.view` plus project visible): returns `{ settings: {...,version} | null }`.
- `PUT /api/attendance/settings/:projectId` (`attendance.settings`): upserts with optimistic `version` (409 `stale_version`), audit `attendance.settings_changed`.

- [ ] **Step 1: Write the failing tests.**
  - An admin PUTs `{lat:19.07,lng:72.87}`, which saves radius 100 and start 09:00.
  - A site engineer PUT gets 403.
  - radius 10 gets 400 with `details.radiusM`.
  - A project from another company gets 404.
  - A stale version gets 409.
  - A non-assigned engineer GET gets 404.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(api): attendance settings per project`.

### Task 5: Face registration and senior approval API

**Files:** `apps/api/src/attendance/registration.ts`. Test: `apps/api/test/face-registration.test.ts` (fake engine).

**Interfaces — Produces:**

**`POST /api/attendance/face`** (`attendance.view`; body `faceRegistrationBodySchema`; rate limit 5/min)
- Every frame needs `faces===1`, `minFaceWidth≥160`, `real≥0.6`, `live≥0.6`, and a non-null embedding. Otherwise 422 `face_not_clear` "Face not clear. Face the camera in good light and try again."
- Frames must agree: the pairwise similarity minimum is ≥ 0.5, else 422 `face_not_consistent`.
- Stores `averageEmbedding` encrypted, `photo` = frame[2], `status='pending'`, and replaces any older pending row. Audit `face.registered`.
- Returns `{ status:'pending' }`.

**`GET /api/attendance/face/me`** returns `{ status: 'none'|'pending'|'approved'|'rejected' }`. An approved registration wins over a pending re-registration.

**`GET /api/attendance/face/pending`** (`attendance.approve_face`)
- Rows `{ id, membershipId, name, email, createdAt, photo: dataURL }`.
- Only people the approver `sharesProject` with, excluding self.

**`POST /api/attendance/face/:id/approve`** and **`/reject`** (`attendance.approve_face`, same reach, not self → 403 `forbidden`)
- Approve: the row becomes `approved`, `photo=null`, and the previous `approved` row becomes `superseded`.
- Reject: `rejected`, `photo=null`.
- Audit `face.approved` / `face.rejected`.

- [ ] **Step 1: Write the failing tests.**
  - Register, then `me` returns pending.
  - A PM sharing a project approves; `me` returns approved and the photo column is null.
  - Self-approval gets 403.
  - A PM without a shared project gets 404.
  - A frame with 2 faces gets 422 `face_not_clear`.
  - Re-registration while approved: `me` stays approved until the new one is approved, then the old one is `superseded`.
  - `consent:false` gets 400.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(api): face registration with senior approval`.

### Task 6: Check-in / check-out API (the decision)

**Files:** `apps/api/src/attendance/checks.ts`. Test: `apps/api/test/attendance-checks.test.ts` (fake engine).

**Interfaces — Produces:**

**`POST /api/attendance/match`** (`attendance.view`; `{ frame }`; rate limit 30/min)
- Returns `{ matched: boolean, similarity: number|null }` against the approved template. It drives the green screen and records nothing.
- No approved face gives 409 `face_not_registered`.

**`POST /api/attendance/check`** (`attendance.view`; body `checkBodySchema`; body limit 2 MB → 413 `too_large`)
1. The project must be visible (404). Settings must exist, else 409 `attendance_not_set_up` "Attendance is not set up for this project yet."
2. An approved face is required, else 409 `face_not_registered`.
3. `check_out` with no non-rejected `check_in` today gives 409 `check_in_first` "Check in first." A duplicate non-rejected entry of the same kind today gives 409 `already_checked_in` / `already_checked_out`.
4. Read the 3 frames. Signals:
   - `faces` = minimum over frames
   - `minFaceWidth` = minimum
   - `real` and `live` = means
   - `similarity` = median against the template
   - `distanceM` from settings
5. `decideCheck` gives the status. `lateMin` is computed only for check-in. `evidence` holds the frames only when pending.
6. Insert, then audit `attendance.checked_in` / `attendance.checked_out`.
7. Return `{ id, kind, status, reasons, at, workDate, distanceM, lateMin, projectName }`.

**`GET /api/attendance/today?projectId=`** returns:
```
{ setUp: boolean,
  face: 'none'|'pending'|'approved'|'rejected',
  checkIn: Entry|null,
  checkOut: Entry|null }
```
`Entry = {status, at, distanceM, lateMin, reasons}`. Rejected entries are hidden, so the person can retry.

- [ ] **Step 1: Write the failing tests.**
  - All pass gives `recorded`; `today.checkIn.status==='recorded'`.
  - Outside the radius gives `pending` with the radius reason, and evidence is stored.
  - Recorded entries store no evidence.
  - Check-out before check-in gives 409 `check_in_first`; a second check-in gives 409 `already_checked_in`.
  - No settings gives 409 `attendance_not_set_up`; no approved face gives 409 `face_not_registered`.
  - A 3 MB body gives 413.
  - A check-in at 09:20 IST (frozen clock via `vi.setSystemTime`) gives `lateMin` 20.
  - After a reviewer rejects (Task 7) a new check-in is allowed.
  - Another company's project gives 404.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(api): geofence + face check-in/out with pending reasons`.

### Task 7: Pending review API

**Files:** `apps/api/src/attendance/review.ts`. Test: `apps/api/test/attendance-review.test.ts`.

**Interfaces — Produces:**

**`GET /api/attendance/pending`** (`attendance.review`)
- Returns pending entries for projects the reviewer can see, excluding their own, oldest first.
- Each row: `{ id, name, projectName, kind, at, workDate, reasons, distanceM, accuracyM, similarity, lat, lng, siteLat, siteLng, radiusM, photos: dataURL[] }`.

**`POST /api/attendance/pending/:id/approve`** and **`/reject`** (`attendance.review`; `reviewDecisionBodySchema`)
- Only `pending` can be decided, else 409 `already_decided`.
- Self gives 403 `forbidden`.
- Sets `reviewedBy`, `reviewedAt`, `reviewNote`. Audit `attendance.approved` / `attendance.rejected`.

- [ ] **Step 1: Write the failing tests.**
  - A coordinator sees a pending entry on a visible project, approves it, and `today` shows `approved`.
  - The coordinator cannot see an entry on a non-visible project (not listed; approve gives 404).
  - Self-approval gives 403.
  - A second decision gives 409.
  - Rejecting lets the person check in again.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(api): attendance pending review`.

### Task 8: Browser face guidance module

**Files:** `apps/web/package.json` (`@vladmandic/human@3.3.6`), `scripts/copy-face-models.mjs` (copies `blazeface`, `facemesh`, `iris` `.json/.bin` to `apps/web/public/face-models/`; hooked into the `prebuild` and `predev` scripts; output git-ignored), `apps/web/vite.config.ts` (exclude `face-models/**` from the PWA precache, add a runtime CacheFirst rule), `apps/web/src/attendance/face-guide.ts`. Test: `apps/web/test/face-guide.test.ts`.

**Interfaces — Produces:**
```ts
export type GuideState =
  | { kind: 'no-face' } | { kind: 'many-faces' }
  | { kind: 'too-far' } | { kind: 'too-close' } | { kind: 'not-centred' }
  | { kind: 'ready'; blinked: boolean };
export function evaluateFrame(f: { faces: number; box?: [number,number,number,number]; videoW: number; videoH: number; blink: boolean }): GuideState;
export function createGuide(video: HTMLVideoElement): { next(): Promise<GuideState>; capture(maxSide=640, quality=0.85): Promise<string>; stop(): void };
```

**Rules for `evaluateFrame`**
- The face width must be 30–70% of the video width ("too far" / "too close").
- The centre must lie within the middle 40% horizontally and vertically.
- `blinked` latches true after a blink lasting 10–800 ms. The blink comes from Human's `gesture` "blink" results.
- Loads Human lazily (`import('@vladmandic/human')`) with `modelBasePath: '/face-models/'` and the `webgl` backend.
- `window.__SD_FAKE_FACE__` (e2e only) makes `next()` return `{kind:'ready',blinked:true}` and `capture()` return a fixed tiny JPEG.

- [ ] **Step 1: Write the failing tests** for `evaluateFrame`, one per state.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement and add the model copy step.
- [ ] **Step 4:** Run → PASS. `pnpm --filter web build` lists no `face-models` in the precache.
- [ ] **Step 5:** Commit `feat(web): on-device face guidance`.

### Task 9: Attendance page — camera, green screen, 3-second hold, confirmation

**Files:** `apps/web/src/lib/attendance.ts` (typed API calls for Tasks 4–7), `apps/web/src/attendance/CameraCheck.tsx`, `apps/web/src/routes/attendance.tsx`. Test: `apps/web/test/attendance-page.test.tsx`.

**Behaviour**
- The page shows the project (Home's active project), today's status and one big button: **Check in**, or **Check out** once checked in. When both are done it shows "Done for today".
- On tap:
  1. GPS via `getCurrentPosition({enableHighAccuracy:true, timeout:15000})`. Show "N m from site · ±A m". Denied gives "Location is blocked. Allow location for this site in your browser settings."
  2. The camera opens (`facingMode:'user'`). Denied gives "Camera is blocked. Allow camera for this site in your browser settings."
  3. The guide prompts: "Move closer", "Centre your face", "Blink once".
  4. When `ready && blinked`, POST `/match` with one frame. When `matched`, the whole screen turns `bg-good` with "Hold still… 3, 2, 1". On losing the face or the match, reset.
  5. After 3 s, capture 3 frames ~250 ms apart and POST `/check`.
  6. **Confirmation**:
     - Recorded: a green tick with "Checked in at 08:52 · Riverside Tower · 42 m from site", plus a "Late by 12 min" line when relevant.
     - Pending: an amber clock with "Sent for approval" and each reason as a bullet.
- No face registered gives a card with a "Register your face" link. A pending registration says "Your face registration is waiting for approval by a senior."
- The 3-second hold respects `prefers-reduced-motion`: the countdown stays, the animation does not.

- [ ] **Step 1: Write the failing tests** (fetch, geolocation and guide mocked):
  - `shows Check in when nothing is marked`
  - `green screen then confirmation with time and distance` (fake timers)
  - `pending confirmation lists reasons`
  - `shows a plain message when the camera is blocked`
  - `shows not set up when the project has no site location`
  - `asks to register the face when none is approved`
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(web): self attendance with green-screen face confirmation`.

### Task 10: Register face, site settings, approvals pages and the live Home tile

**Files:**
- Routes: `attendance.register.tsx`, `attendance.settings.tsx`, `attendance.approvals.tsx`.
- `home.tsx` (the Self Attendance tile becomes a link with live status), `AppShell.tsx` (menu item **Approvals** for `attendance.review` or `attendance.approve_face`).

Test: `apps/web/test/attendance-admin.test.tsx`.

**Behaviour**

*Register face*
- A consent card. Exact copy: "Site Diary stores a numeric face code (not your photo) to confirm it's you at check-in. A senior approves it once. You can delete it any time from this page."
- "I agree", then the camera. Prompts: blink, then turn left, then turn right (from Human's gesture "facing left/right"). Capture 5 frames, then POST.
- Result: "Sent for approval. Ask your senior to approve it now."
- "Delete my face registration" is **out of Stage A**. It lands in Stage B together with retention.

*Settings* (`attendance.settings`)
- "Use my current location" (refused when accuracy > 50 m, with the reason shown), lat/lng fields, a radius slider 25–1000, start time, late after, reminder.
- Saves via PUT. The project comes from the Home switcher, and the page also has its own project select.

*Approvals*
- Two tabs: **Faces** (photo, name, Approve/Reject) and **Check-ins** (name, project, time, reasons, photos, distance vs radius, Approve/Reject with an optional note).

*Home tile*
- Recorded or approved check-in today: `bg-good-bg` with "Checked in 08:52", or "Checked out 18:40".
- Pending: neutral with an amber "Pending approval" chip.
- None: neutral with "Not checked in".
- Not set up: "Not set up for this project".
- Tapping it opens `/attendance`. The other tiles stay "Coming soon".

- [ ] **Step 1: Write the failing tests:**
  - `tile turns green after a recorded check-in`
  - `tile shows Pending approval chip`
  - `settings refuses a location worse than 50 m`
  - `approvals approve a face and remove it from the list`
  - `approvals show reasons for a pending check-in`
  - `approvals menu item hidden without the capabilities`
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(web): face registration, site settings, approvals and live attendance tile`.

### Task 11: End-to-end, deploy notes and ship

**Files:** `apps/web/e2e/attendance.spec.ts`, `apps/web/playwright.config.ts` (API started with `API_FACE_ENGINE=fake`), `docs/deploy/railway.md` (`FACE_TEMPLATE_KEY`, memory note ~350 MB for the API).

- [ ] **Step 1: Write the e2e.** It uses `context.grantPermissions(['geolocation','camera'])`, `setGeolocation` and `addInitScript(() => window.__SD_FAKE_FACE__ = true)`.
  1. An admin sets the site location.
  2. The engineer registers a face; the admin approves it.
  3. The engineer checks in inside the radius: green confirmation, and the Home tile is green.
  4. A second engineer outside the radius gets a pending confirmation with the radius reason.
  5. The admin approves it in Approvals.
  6. Repeat at 360 px with no horizontal scroll.
- [ ] **Step 2:** Run the full suites: `pnpm lint && pnpm format:check && pnpm -r typecheck && pnpm -r test && pnpm --filter web exec playwright test`. Expected: all PASS.
- [ ] **Step 3:** Commit and push, open the PR, CI green, merge. Set Railway `FACE_TEMPLATE_KEY` (generated, 32 bytes base64) on `api` before deploying; deploy `api` and `web`; check the API logs for `Migrations applied.`.
- [ ] **Step 4:** Live smoke test with the owner on a real phone: register, approve, check in on site, then outside the radius. Calibrate the 0.50 threshold from the owner team's consented results if needed. This is a config change, not a code change.
