import { describe, expect, it } from 'vitest';
import { safeCell } from '../src/attendance/export';
import { buildSummary, daysOfMonth, type SummaryEntry } from '../src/attendance/summary';

const A = { membershipId: 'a', name: 'Asha', email: 'asha@x.test' };
const B = { membershipId: 'b', name: 'Bala', email: 'bala@x.test' };

const at = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00Z`);
const entry = (
  who: string,
  date: string,
  kind: 'check_in' | 'check_out',
  hhmm: string,
  over: Partial<SummaryEntry> = {},
): SummaryEntry => ({
  membershipId: who,
  workDate: date,
  kind,
  at: at(date, hhmm),
  status: 'recorded',
  lateMin: 0,
  distanceM: 5,
  reasons: [],
  ...over,
});

describe('daysOfMonth', () => {
  it('lists every day, including a leap February', () => {
    expect(daysOfMonth('2026-10')).toHaveLength(31);
    expect(daysOfMonth('2026-11')).toHaveLength(30);
    expect(daysOfMonth('2028-02')).toHaveLength(29);
    expect(daysOfMonth('2026-10')[0]).toBe('2026-10-01');
  });

  it('rejects a bad month', () => {
    for (const m of ['2026-13', '2026-1', 'x', '2026-00']) {
      expect(() => daysOfMonth(m)).toThrow();
    }
  });
});

describe('buildSummary', () => {
  const run = (entries: SummaryEntry[], today = '2026-10-05') =>
    buildSummary({ month: '2026-10', today, members: [B, A], entries });

  it('counts present, late, pending and absent, and sorts by name', () => {
    const s = run([
      entry('a', '2026-10-01', 'check_in', '09:00'),
      entry('a', '2026-10-02', 'check_in', '09:40', { lateMin: 40 }),
      entry('a', '2026-10-03', 'check_in', '09:00', { status: 'pending' }),
      entry('a', '2026-10-04', 'check_in', '09:00', { status: 'approved' }),
    ]);
    expect(s.people.map((p) => p.name)).toEqual(['Asha', 'Bala']);
    const asha = s.people[0]!;
    expect(asha).toMatchObject({ present: 3, late: 1, pending: 1, absent: 0 });
    expect(asha.cells[0]!.status).toBe('present');
    expect(asha.cells[1]!.status).toBe('late');
    expect(asha.cells[2]!.status).toBe('pending');
    expect(s.people[1]).toMatchObject({ present: 0, absent: 4 });
  });

  it('treats a day with no check-in as absent only before today', () => {
    const s = run([], '2026-10-03');
    const bala = s.people[1]!;
    expect(bala.absent).toBe(2);
    expect(bala.cells[2]!.status).toBe('open');
    expect(bala.cells[10]!.status).toBe('open');
  });

  it('ignores rejected entries, so that day is absent', () => {
    const s = run([entry('a', '2026-10-01', 'check_in', '09:00', { status: 'rejected' })]);
    expect(s.people[0]!.cells[0]!.status).toBe('absent');
    expect(s.people[0]!.present).toBe(0);
  });

  it('adds up hours from check-in to check-out, and ignores a lone check-out', () => {
    const s = run([
      entry('a', '2026-10-01', 'check_in', '09:00'),
      entry('a', '2026-10-01', 'check_out', '17:30'),
      entry('a', '2026-10-02', 'check_in', '10:00'),
      entry('a', '2026-10-02', 'check_out', '12:15'),
      entry('a', '2026-10-03', 'check_out', '18:00'),
    ]);
    expect(s.people[0]!.hours).toBe(10.75);
    expect(s.people[0]!.cells[0]).toMatchObject({ in: at('2026-10-01', '09:00') });
  });

  it('keeps people apart', () => {
    const s = run([entry('b', '2026-10-01', 'check_in', '09:00')]);
    expect(s.people[0]!.present).toBe(0);
    expect(s.people[1]!.present).toBe(1);
  });
});

describe('safeCell', () => {
  it('defuses spreadsheet formulas and leaves normal text alone', () => {
    expect(safeCell('=HYPERLINK("x")')).toBe(`'=HYPERLINK("x")`);
    expect(safeCell('+1')).toBe("'+1");
    expect(safeCell('-2')).toBe("'-2");
    expect(safeCell('@SUM')).toBe("'@SUM");
    expect(safeCell('Asha Rao')).toBe('Asha Rao');
  });
});
