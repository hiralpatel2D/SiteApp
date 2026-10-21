import { api } from './api';

// Typed calls for /api/attendance (settings, face registration, check-in/out, review).

const BASE = '/api/attendance';
const seg = encodeURIComponent;

export type CheckKind = 'check_in' | 'check_out';
export type FaceStatus = 'none' | 'pending' | 'approved' | 'rejected';

export type AttendanceSettings = {
  lat: number;
  lng: number;
  radiusM: number;
  startTime: string;
  lateAfterMin: number;
  reminderTime: string;
  timezone: string;
  version: number;
};

export type AttendanceSettingsInput = {
  lat: number;
  lng: number;
  radiusM?: number;
  startTime?: string;
  lateAfterMin?: number;
  reminderTime?: string;
  /** Required when updating existing settings. */
  version?: number;
};

/** One of today's entries (rejected entries are not returned). */
export type TodayEntry = {
  status: 'recorded' | 'pending' | 'approved';
  at: string;
  distanceM: number;
  lateMin: number;
  reasons: string[];
};

export type Today = {
  setUp: boolean;
  face: FaceStatus;
  checkIn: TodayEntry | null;
  checkOut: TodayEntry | null;
};

export type CheckInput = {
  projectId: string;
  kind: CheckKind;
  lat: number;
  lng: number;
  accuracyM: number;
  /** Exactly 3 raw base64 JPEG frames. */
  frames: string[];
};

export type CheckResult = {
  id: string;
  kind: CheckKind;
  status: 'recorded' | 'pending';
  reasons: string[];
  at: string;
  workDate: string;
  distanceM: number;
  lateMin: number;
  projectName: string;
};

export type MatchResult = { matched: boolean; similarity: number | null };

export type PendingFace = {
  id: string;
  membershipId: string;
  name: string;
  email: string;
  createdAt: string;
  /** data: URL of the registration photo. */
  photo: string;
};

export type PendingEntry = {
  id: string;
  name: string;
  projectName: string;
  kind: CheckKind;
  at: string;
  workDate: string;
  reasons: string[];
  distanceM: number;
  accuracyM: number;
  similarity: number | null;
  lat: number;
  lng: number;
  siteLat: number;
  siteLng: number;
  radiusM: number;
  /** data: URLs of the evidence frames. */
  photos: string[];
};

export const getToday = (projectId: string) =>
  api<Today>(`${BASE}/today?projectId=${seg(projectId)}`);

export const getSettings = (projectId: string) =>
  api<{ settings: AttendanceSettings | null }>(`${BASE}/settings/${seg(projectId)}`);

export const putSettings = (projectId: string, body: AttendanceSettingsInput) =>
  api<{ settings: AttendanceSettings }>(`${BASE}/settings/${seg(projectId)}`, {
    method: 'PUT',
    body,
  });

/** Previews whether one frame matches the approved face. Records nothing. */
export const matchFace = (frame: string) => api<MatchResult>(`${BASE}/match`, { body: { frame } });

/** How long a check may take before we give up and offer Try again. */
export const CHECK_TIMEOUT_MS = 30_000;

/** Records a check-in/out. Gives up after CHECK_TIMEOUT_MS with the `unavailable` ApiError. */
export async function postCheck(body: CheckInput): Promise<CheckResult> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CHECK_TIMEOUT_MS);
  try {
    return await api<CheckResult>(`${BASE}/check`, { body, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export const registerFace = (frames: string[]) =>
  api<{ status: 'pending' }>(`${BASE}/face`, { body: { consent: true, frames } });

export const getMyFace = () => api<{ status: FaceStatus }>(`${BASE}/face/me`);

export const getPendingFaces = () => api<{ pending: PendingFace[] }>(`${BASE}/face/pending`);

export const approveFace = (id: string) =>
  api<{ status: 'approved' }>(`${BASE}/face/${seg(id)}/approve`, { method: 'POST' });

export const rejectFace = (id: string) =>
  api<{ status: 'rejected' }>(`${BASE}/face/${seg(id)}/reject`, { method: 'POST' });

export const getPendingEntries = () =>
  api<{ entries: PendingEntry[]; total: number }>(`${BASE}/pending`);

export const approveEntry = (id: string, note?: string) =>
  api<{ status: string }>(`${BASE}/pending/${seg(id)}/approve`, { body: { note } });

export const rejectEntry = (id: string, note?: string) =>
  api<{ status: string }>(`${BASE}/pending/${seg(id)}/reject`, { body: { note } });
