import { getActiveCompany } from './company';
import { api, ApiError, toApiError } from './api';

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

export type MatchResult = { matched: boolean };

export type PendingFace = {
  id: string;
  membershipId: string;
  /** True for the signed-in person's own registration. */
  own: boolean;
  /** False when someone else must decide it (your own, while another approver exists). */
  canDecide: boolean;
  name: string;
  email: string;
  createdAt: string;
  /** data: URL of the registration photo. */
  photo: string;
};

export type PendingEntry = {
  id: string;
  /** True for the signed-in person's own check-in. */
  own: boolean;
  /** False when someone else must decide it (your own, while another reviewer exists). */
  canDecide: boolean;
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

/** How long a face match may take before we give up and go back to guidance. */
export const MATCH_TIMEOUT_MS = 20_000;
export const MATCH_TOO_SLOW = 'Checking took too long. Try again.';

/**
 * Previews whether one frame matches the approved face. Records nothing. Gives up after
 * MATCH_TIMEOUT_MS with a `timeout` ApiError carrying MATCH_TOO_SLOW.
 */
export async function matchFace(frame: string): Promise<MatchResult> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), MATCH_TIMEOUT_MS);
  try {
    return await api<MatchResult>(`${BASE}/match`, { body: { frame }, signal: ctl.signal });
  } catch (err) {
    if (ctl.signal.aborted) throw new ApiError(0, 'timeout', MATCH_TOO_SLOW);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

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

export type LogEntry = {
  id: string;
  name: string;
  own: boolean;
  workDate: string;
  kind: CheckKind;
  at: string;
  status: 'recorded' | 'pending' | 'approved' | 'rejected';
  lateMin: number;
  distanceM: number;
  reasons: string[];
};

export const getLog = (projectId: string, from: string, to: string, scope: 'me' | 'team') =>
  api<{ from: string; to: string; scope: 'me' | 'team'; entries: LogEntry[] }>(
    `${BASE}/log?projectId=${seg(projectId)}&from=${seg(from)}&to=${seg(to)}&scope=${scope}`,
  );

export type DayStatus = 'present' | 'late' | 'pending' | 'absent' | 'open';

export type MonthlySummary = {
  projectName: string;
  timezone: string;
  month: string;
  days: string[];
  people: {
    membershipId: string;
    name: string;
    email: string;
    present: number;
    late: number;
    pending: number;
    absent: number;
    hours: number;
    cells: { date: string; status: DayStatus; in: string | null; out: string | null }[];
  }[];
};

export const getSummary = (projectId: string, month: string) =>
  api<MonthlySummary>(`${BASE}/summary?projectId=${seg(projectId)}&month=${seg(month)}`);

/** Downloads the month's Excel file (needs `attendance.export`). */
export async function downloadExport(projectId: string, month: string): Promise<void> {
  const headers = new Headers();
  const company = getActiveCompany();
  if (company) headers.set('x-company-id', company);
  let res: Response;
  try {
    res = await fetch(`${BASE}/export?projectId=${seg(projectId)}&month=${seg(month)}`, {
      credentials: 'include',
      headers,
    });
  } catch {
    throw new ApiError(0, 'unavailable', 'The service is busy. Try again shortly.');
  }
  if (!res.ok) throw await toApiError(res);
  const blob = await res.blob();
  const name =
    /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ??
    `attendance-${month}.xlsx`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
