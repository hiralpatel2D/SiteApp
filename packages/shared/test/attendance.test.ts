import { describe, expect, it } from 'vitest';
import {
  ATTENDANCE_CAPABILITIES,
  attendanceSettingsBodySchema,
  checkBodySchema,
  decideCheck,
  distanceMeters,
  faceRegistrationBodySchema,
  lateMinutes,
  reviewDecisionBodySchema,
  workDate,
  type CheckSignals,
} from '../src/attendance';
import { CAPABILITIES } from '../src/capabilities';
import { defaultCapabilities } from '../src/roles';

const ok: CheckSignals = {
  distanceM: 20,
  radiusM: 100,
  accuracyM: 15,
  faces: 1,
  minFaceWidth: 200,
  similarity: 0.8,
  real: 0.9,
  live: 0.9,
};

describe('distanceMeters', () => {
  it('is about 100 m for 0.0009 degrees of latitude', () => {
    const d = distanceMeters({ lat: 19.076, lng: 72.8777 }, { lat: 19.0769, lng: 72.8777 });
    expect(Math.abs(d - 100)).toBeLessThanOrEqual(1);
  });
});

describe('workDate and lateMinutes', () => {
  it('uses Asia/Kolkata for the work date', () =>
    expect(workDate(new Date('2026-10-15T19:00:00Z'))).toBe('2026-10-16'));
  it('counts minutes after start once beyond the threshold', () => {
    expect(lateMinutes(new Date('2026-10-16T03:50:00Z'), '09:00', 15)).toBe(20);
    expect(lateMinutes(new Date('2026-10-16T03:40:00Z'), '09:00', 15)).toBe(0);
  });
  it('is not late at or before start', () =>
    expect(lateMinutes(new Date('2026-10-16T03:00:00Z'), '09:00', 15)).toBe(0));
});

describe('decideCheck', () => {
  it('records when everything passes', () =>
    expect(decideCheck(ok)).toEqual({ status: 'recorded', reasons: [] }));
  it('flags outside radius', () =>
    expect(decideCheck({ ...ok, distanceM: 180 })).toEqual({
      status: 'pending',
      reasons: ['Outside site radius (180 m, allowed 100 m)'],
    }));
  it('flags a poor face match', () =>
    expect(decideCheck({ ...ok, similarity: 0.42 }).reasons).toEqual([
      'Face not matched (score 0.42)',
    ]));
  it('passes a face match at exactly 0.50', () =>
    expect(decideCheck({ ...ok, similarity: 0.5 }).status).toBe('recorded'));
  it('flags poor accuracy', () =>
    expect(decideCheck({ ...ok, accuracyM: 250 }).reasons).toEqual([
      'Location accuracy too low (±250 m)',
    ]));
  it('flags liveness failure', () => {
    expect(decideCheck({ ...ok, real: 0.3 }).reasons).toEqual(['Liveness failed']);
    expect(decideCheck({ ...ok, live: 0.59 }).reasons).toEqual(['Liveness failed']);
  });
  it('flags unclear faces', () => {
    expect(decideCheck({ ...ok, faces: 2 }).reasons).toEqual(['Face not clear']);
    expect(decideCheck({ ...ok, faces: 0 }).reasons).toEqual(['Face not clear']);
    expect(decideCheck({ ...ok, minFaceWidth: 159 }).reasons).toEqual(['Face not clear']);
  });
  it('flags mock location below 1 m accuracy', () =>
    expect(decideCheck({ ...ok, accuracyM: 0.5 }).reasons).toEqual(['Possible mock location']));
  it('lists every reason in order radius, accuracy, face, liveness', () => {
    const r = decideCheck({
      ...ok,
      distanceM: 180,
      accuracyM: 250,
      similarity: 0.42,
      real: 0.3,
    });
    expect(r.status).toBe('pending');
    expect(r.reasons).toEqual([
      'Outside site radius (180 m, allowed 100 m)',
      'Location accuracy too low (±250 m)',
      'Face not matched (score 0.42)',
      'Liveness failed',
    ]);
  });
});

describe('schemas', () => {
  it('applies settings defaults', () => {
    const r = attendanceSettingsBodySchema.parse({ lat: 19.07, lng: 72.87 });
    expect(r).toMatchObject({
      radiusM: 100,
      startTime: '09:00',
      lateAfterMin: 15,
      reminderTime: '19:00',
    });
  });
  it('bounds settings', () => {
    const base = { lat: 19.07, lng: 72.87 };
    expect(attendanceSettingsBodySchema.safeParse({ ...base, radiusM: 24 }).success).toBe(false);
    expect(attendanceSettingsBodySchema.safeParse({ ...base, radiusM: 1001 }).success).toBe(false);
    expect(attendanceSettingsBodySchema.safeParse({ ...base, lateAfterMin: 121 }).success).toBe(
      false,
    );
    expect(attendanceSettingsBodySchema.safeParse({ ...base, startTime: '9am' }).success).toBe(
      false,
    );
    expect(attendanceSettingsBodySchema.safeParse({ lat: 91, lng: 0 }).success).toBe(false);
  });
  const frame = '/9j/4AAQSkZJRg==';
  const body = {
    projectId: '3f1c2b8e-5a4d-4e7a-9c1b-2d3e4f5a6b7c',
    kind: 'check_in',
    lat: 19.07,
    lng: 72.87,
    accuracyM: 12,
    frames: [frame, frame, frame],
  };
  it('requires exactly 3 frames for a check', () => {
    expect(checkBodySchema.safeParse(body).success).toBe(true);
    expect(checkBodySchema.safeParse({ ...body, frames: [frame, frame] }).success).toBe(false);
  });
  it('rejects data: URLs as frames', () =>
    expect(
      checkBodySchema.safeParse({ ...body, frames: Array(3).fill('data:image/jpeg;base64,AAAA') })
        .success,
    ).toBe(false));
  it('requires consent and 5 frames for registration', () => {
    const f5 = Array(5).fill(frame);
    expect(faceRegistrationBodySchema.safeParse({ consent: true, frames: f5 }).success).toBe(true);
    expect(faceRegistrationBodySchema.safeParse({ consent: false, frames: f5 }).success).toBe(
      false,
    );
    expect(
      faceRegistrationBodySchema.safeParse({ consent: true, frames: f5.slice(0, 3) }).success,
    ).toBe(false);
  });
  it('limits the review note to 500 characters', () => {
    expect(reviewDecisionBodySchema.safeParse({}).success).toBe(true);
    expect(reviewDecisionBodySchema.safeParse({ note: 'x'.repeat(501) }).success).toBe(false);
  });
});

describe('attendance capabilities', () => {
  it('are all known capabilities', () =>
    ATTENDANCE_CAPABILITIES.forEach((c) => expect(CAPABILITIES).toContain(c)));
  it('follow the role table', () => {
    const coord = defaultCapabilities('coordinator');
    expect(coord).toContain('attendance.review');
    expect(coord).not.toContain('attendance.settings');
    expect(defaultCapabilities('project_manager')).toContain('attendance.approve_face');
    expect(defaultCapabilities('project_manager')).not.toContain('attendance.export');
    expect(defaultCapabilities('admin')).toEqual(
      expect.arrayContaining([...ATTENDANCE_CAPABILITIES]),
    );
    expect(defaultCapabilities('supervisor')).not.toContain('attendance.review');
  });
});
