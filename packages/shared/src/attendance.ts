import { z } from 'zod';

export const ATTENDANCE_CAPABILITIES = [
  'attendance.approve_face',
  'attendance.review',
  'attendance.settings',
  'attendance.export',
] as const;
export type AttendanceCapability = (typeof ATTENDANCE_CAPABILITIES)[number];

export const ATTENDANCE_TZ = 'Asia/Kolkata';

export const ATTENDANCE_DEFAULTS = {
  radiusM: 100,
  startTime: '09:00',
  lateAfterMin: 15,
  reminderTime: '19:00',
} as const;

const EARTH_RADIUS_M = 6371008.8;
const MAX_ACCURACY_M = 100;
const MIN_PLAUSIBLE_ACCURACY_M = 1;
/** Default lowest face similarity (0..1) that counts as the registered person. */
export const MIN_SIMILARITY = 0.5;
/** Default lowest anti-spoof and liveness score (0..1) that passes. */
export const MIN_LIVENESS = 0.6;
/** Smallest face width, in pixels of the photo as the server reads it, that counts as clear. */
export const MIN_FACE_WIDTH_PX = 160;

/** Face thresholds `decideCheck` applies; the API reads them from FACE_MATCH_MIN / FACE_LIVENESS_MIN. */
export type FaceThresholds = { minSimilarity: number; minLiveness: number };
export const DEFAULT_FACE_THRESHOLDS: FaceThresholds = {
  minSimilarity: MIN_SIMILARITY,
  minLiveness: MIN_LIVENESS,
};

export type LatLng = { lat: number; lng: number };

/** Great-circle (haversine) distance in metres. */
export function distanceMeters(a: LatLng, b: LatLng): number {
  const rad = (d: number): number => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function zonedParts(at: Date, tz: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  return Object.fromEntries(parts.map((p) => [p.type, p.value]));
}

/** The calendar date (`YYYY-MM-DD`) of an instant in the given timezone. */
export function workDate(at: Date, tz: string = ATTENDANCE_TZ): string {
  const p = zonedParts(at, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Minutes after `start` (`HH:MM`) when later than `lateAfterMin`, else 0. */
export function lateMinutes(
  at: Date,
  start: string,
  lateAfterMin: number,
  tz: string = ATTENDANCE_TZ,
): number {
  const p = zonedParts(at, tz);
  const [sh = 0, sm = 0] = start.split(':').map(Number);
  const late = Number(p.hour) * 60 + Number(p.minute) - (sh * 60 + sm);
  return late > lateAfterMin ? late : 0;
}

export type CheckSignals = {
  distanceM: number;
  radiusM: number;
  accuracyM: number;
  faces: number;
  minFaceWidth: number;
  similarity: number | null;
  /** Lowest anti-spoof score over the frames. */
  real: number;
  /** Lowest liveness score over the frames. */
  live: number;
  /** Every pair of frames shows the same person. */
  framesAgree: boolean;
  /** No two frames are identical or near-identical (a replayed photo). */
  framesDistinct: boolean;
};

export type CheckDecision = { status: 'recorded' | 'pending'; reasons: string[] };

/** Applies the attendance rules; reasons are listed radius, accuracy, face, liveness. */
export function decideCheck(
  s: CheckSignals,
  t: FaceThresholds = DEFAULT_FACE_THRESHOLDS,
): CheckDecision {
  const reasons: string[] = [];
  // Every check is written so that NaN (or a missing value) fails closed.
  if (!(s.distanceM <= s.radiusM)) {
    const shown = Number.isFinite(s.distanceM) ? `${Math.ceil(s.distanceM)} m` : 'unknown distance';
    reasons.push(`Outside site radius (${shown}, allowed ${s.radiusM} m)`);
  }
  if (!(s.accuracyM <= MAX_ACCURACY_M)) {
    reasons.push(
      Number.isFinite(s.accuracyM)
        ? `Location accuracy too low (±${Math.round(s.accuracyM)} m)`
        : 'Location accuracy too low',
    );
  } else if (s.accuracyM < MIN_PLAUSIBLE_ACCURACY_M) {
    reasons.push('Possible mock location');
  }
  if (s.faces !== 1 || !(s.minFaceWidth >= MIN_FACE_WIDTH_PX) || s.framesAgree !== true) {
    reasons.push('Face not clear');
  } else if (s.similarity === null || Number.isNaN(s.similarity)) {
    reasons.push('Face not clear');
  } else if (s.similarity < t.minSimilarity) {
    const truncated = Math.floor(s.similarity * 100 + 1e-9) / 100;
    reasons.push(`Face not matched (score ${truncated.toFixed(2)})`);
  }
  if (!(s.real >= t.minLiveness) || !(s.live >= t.minLiveness) || s.framesDistinct !== true) {
    reasons.push('Liveness failed');
  }
  return { status: reasons.length === 0 ? 'recorded' : 'pending', reasons };
}

const timeField = (message: string) =>
  z.string({ message }).regex(/^([01]\d|2[0-3]):[0-5]\d$/, message);

const versionField = z
  .number({ message: 'Reload and try again.' })
  .int('Reload and try again.')
  .min(1, 'Reload and try again.');

/** `PUT` attendance settings for a project. */
export const attendanceSettingsBodySchema = z.object({
  lat: z.number({ message: 'Enter a valid latitude.' }).min(-90).max(90, 'Enter a valid latitude.'),
  lng: z
    .number({ message: 'Enter a valid longitude.' })
    .min(-180)
    .max(180, 'Enter a valid longitude.'),
  radiusM: z
    .number({ message: 'Radius must be between 25 and 1000 m.' })
    .int('Radius must be between 25 and 1000 m.')
    .min(25, 'Radius must be between 25 and 1000 m.')
    .max(1000, 'Radius must be between 25 and 1000 m.')
    .default(ATTENDANCE_DEFAULTS.radiusM),
  startTime: timeField('Enter the start time as HH:MM.').default(ATTENDANCE_DEFAULTS.startTime),
  lateAfterMin: z
    .number({ message: 'Late-after must be between 0 and 120 minutes.' })
    .int('Late-after must be between 0 and 120 minutes.')
    .min(0, 'Late-after must be between 0 and 120 minutes.')
    .max(120, 'Late-after must be between 0 and 120 minutes.')
    .default(ATTENDANCE_DEFAULTS.lateAfterMin),
  reminderTime: timeField('Enter the reminder time as HH:MM.').default(
    ATTENDANCE_DEFAULTS.reminderTime,
  ),
  version: versionField.optional(),
});
export type AttendanceSettingsBody = z.infer<typeof attendanceSettingsBodySchema>;

/** Base64 length of a 300 KB JPEG. */
const MAX_FRAME_CHARS = Math.ceil((300 * 1024) / 3) * 4;

/** A raw base64 JPEG (no `data:` prefix), at most 300 KB decoded. */
const frameSchema = z
  .string({ message: 'Send the photo frames again.' })
  .min(1, 'Send the photo frames again.')
  .max(MAX_FRAME_CHARS, 'Photo is too large.')
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Send the photo frames again.');

const framesSchema = (count: number) =>
  z
    .array(frameSchema, { message: `Send exactly ${count} photo frames.` })
    .length(count, `Send exactly ${count} photo frames.`);

export const CHECK_FRAME_COUNT = 3;
export const REGISTRATION_FRAME_COUNT = 5;
/**
 * Which registration frame the approver sees: the first "look straight" photo. The web
 * capture order is blink, turn left, turn right, then two straight-ahead frames (3 and 4).
 */
export const REGISTRATION_PHOTO_FRAME = 3;

/** `POST` a check-in or check-out. */
export const checkBodySchema = z.object({
  projectId: z.string({ message: 'Choose a project.' }).uuid('Choose a project.'),
  kind: z.enum(['check_in', 'check_out'], { message: 'Choose check in or check out.' }),
  lat: z.number({ message: 'Location is missing.' }).min(-90).max(90),
  lng: z.number({ message: 'Location is missing.' }).min(-180).max(180),
  accuracyM: z.number({ message: 'Location accuracy is missing.' }).min(0),
  frames: framesSchema(CHECK_FRAME_COUNT),
});
export type CheckBody = z.infer<typeof checkBodySchema>;

/** `POST` a single frame to preview the face match (records nothing). */
export const matchBodySchema = z.object({ frame: frameSchema });
export type MatchBody = z.infer<typeof matchBodySchema>;

/** `POST` face registration. */
export const faceRegistrationBodySchema = z.object({
  consent: z.literal(true, { message: 'Consent is required to register your face.' }),
  frames: framesSchema(REGISTRATION_FRAME_COUNT),
});
export type FaceRegistrationBody = z.infer<typeof faceRegistrationBodySchema>;

/** Approve / reject decisions on pending records or faces. */
export const reviewDecisionBodySchema = z.object({
  note: z.string().trim().max(500, 'Note must be 500 characters or fewer.').optional(),
});
export type ReviewDecisionBody = z.infer<typeof reviewDecisionBodySchema>;
