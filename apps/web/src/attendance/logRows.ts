import type { LogEntry } from '../lib/attendance';

export type RowStatus = 'rejected' | 'pending' | 'approved' | 'recorded';

/** One person's day: the check-in and check-out paired on a single row. */
export type LogRow = {
  key: string;
  workDate: string;
  memberId: string;
  name: string;
  inAt: string | null;
  outAt: string | null;
  /** Worked minutes; null until both a check-in and a check-out exist. */
  workedMin: number | null;
  lateMin: number;
  distanceM: number;
  status: RowStatus;
  /** Why the system flagged the entry, joined for display. */
  reasons: string[];
};

// A row shows its most urgent state: a rejected or waiting entry must not hide behind an approved one.
const URGENCY: RowStatus[] = ['rejected', 'pending', 'approved', 'recorded'];

export function buildRows(entries: LogEntry[]): LogRow[] {
  const byKey = new Map<string, LogEntry[]>();
  for (const e of entries) {
    const k = `${e.workDate}|${e.memberId}`;
    byKey.set(k, [...(byKey.get(k) ?? []), e]);
  }
  const rows: LogRow[] = [];
  for (const [key, list] of byKey) {
    const ins = list.filter((e) => e.kind === 'check_in').sort((a, b) => (a.at < b.at ? -1 : 1));
    const outs = list.filter((e) => e.kind === 'check_out').sort((a, b) => (a.at < b.at ? 1 : -1));
    const first = ins[0] ?? null;
    const last = outs[0] ?? null;
    const any = list[0]!;
    const workedMin =
      first && last && last.at > first.at
        ? Math.round((Date.parse(last.at) - Date.parse(first.at)) / 60_000)
        : null;
    rows.push({
      key,
      workDate: any.workDate,
      memberId: any.memberId,
      name: any.name,
      inAt: first?.at ?? null,
      outAt: last?.at ?? null,
      workedMin,
      lateMin: first?.lateMin ?? 0,
      distanceM: Math.max(...list.map((e) => e.distanceM)),
      status: URGENCY.find((s) => list.some((e) => e.status === s)) ?? 'recorded',
      reasons: [...new Set(list.flatMap((e) => e.reasons))],
    });
  }
  return rows;
}

export type SortKey = 'date' | 'name' | 'in' | 'out' | 'hours' | 'status' | 'distance';
export type SortDir = 'asc' | 'desc';

const cmpText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
// Missing values sort last in either direction (handled by the caller).
const VALUE: Record<SortKey, (r: LogRow) => string | number | null> = {
  date: (r) => r.workDate,
  name: (r) => r.name.toLowerCase(),
  in: (r) => r.inAt,
  out: (r) => r.outAt,
  hours: (r) => r.workedMin,
  status: (r) => URGENCY.indexOf(r.status),
  distance: (r) => r.distanceM,
};

export function sortRows(rows: LogRow[], key: SortKey, dir: SortDir): LogRow[] {
  const sign = dir === 'asc' ? 1 : -1;
  const get = VALUE[key];
  return [...rows].sort((a, b) => {
    const x = get(a);
    const y = get(b);
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    const c =
      typeof x === 'number' && typeof y === 'number' ? x - y : cmpText(String(x), String(y));
    // Ties fall back to newest day then name so the order is stable and readable.
    return c !== 0
      ? c * sign
      : cmpText(b.workDate, a.workDate) || cmpText(a.name.toLowerCase(), b.name.toLowerCase());
  });
}

export type LogFilters = { status: RowStatus | 'all'; lateOnly: boolean; search: string };

export function filterRows(rows: LogRow[], f: LogFilters): LogRow[] {
  const q = f.search.trim().toLowerCase();
  return rows.filter(
    (r) =>
      (f.status === 'all' || r.status === f.status) &&
      (!f.lateOnly || r.lateMin > 0) &&
      (q === '' || r.name.toLowerCase().includes(q)),
  );
}

export const hoursText = (min: number | null) =>
  min === null ? '—' : `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`;
