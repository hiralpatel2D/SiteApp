import ExcelJS from 'exceljs';
import type { MonthlySummary, SummaryEntry, SummaryMember } from './summary';

/**
 * A text cell that a spreadsheet will not run as a formula: names and emails are typed by people,
 * and a value starting with = + - @ is read as a formula by Excel.
 */
export const safeCell = (v: string): string => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

const clock = (d: Date | null, tz: string): string =>
  d
    ? d.toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        timeZone: tz,
      })
    : '';

const CODE = { present: 'P', late: 'L', pending: '?', absent: 'A', open: '' } as const;

/** Builds the month's workbook: Summary (totals), Daily (a grid of times) and Entries (every row). */
export async function buildWorkbook(input: {
  projectName: string;
  timezone: string;
  summary: MonthlySummary;
  entries: SummaryEntry[];
  members: SummaryMember[];
}): Promise<Uint8Array<ArrayBuffer>> {
  const { summary, timezone: tz } = input;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Site Diary';
  const bold = { bold: true };

  const totals = wb.addWorksheet('Summary');
  totals.addRow([safeCell(`${input.projectName} - attendance ${summary.month}`)]).font = {
    bold: true,
    size: 14,
  };
  totals.addRow([
    'P = present, L = late (counted in present), ? = waiting for approval, A = absent',
  ]);
  totals.addRow([]);
  totals.addRow(['Name', 'Email', 'Present', 'Late', 'Pending', 'Absent', 'Hours']).font = bold;
  for (const p of summary.people) {
    totals.addRow([
      safeCell(p.name),
      safeCell(p.email),
      p.present,
      p.late,
      p.pending,
      p.absent,
      p.hours,
    ]);
  }
  totals.columns = [
    { width: 26 },
    { width: 30 },
    { width: 10 },
    { width: 8 },
    { width: 10 },
    { width: 8 },
    { width: 8 },
  ];

  const grid = wb.addWorksheet('Daily');
  grid.addRow(['Name', ...summary.days.map((d) => d.slice(8))]).font = bold;
  for (const p of summary.people) {
    grid.addRow([
      safeCell(p.name),
      ...p.cells.map((c) =>
        c.status === 'absent'
          ? 'A'
          : c.status === 'open'
            ? ''
            : `${CODE[c.status]} ${clock(c.in, tz)}${c.out ? `-${clock(c.out, tz)}` : ''}`,
      ),
    ]);
  }
  grid.getColumn(1).width = 26;
  for (let i = 2; i <= summary.days.length + 1; i++) grid.getColumn(i).width = 13;
  grid.views = [{ state: 'frozen', xSplit: 1, ySplit: 1 }];

  const names = new Map(input.members.map((m) => [m.membershipId, m.name]));
  const rows = wb.addWorksheet('Entries');
  rows.addRow([
    'Date',
    'Name',
    'In/Out',
    'Time',
    'Status',
    'Late (min)',
    'Distance (m)',
    'Reasons',
  ]).font = bold;
  for (const e of input.entries) {
    rows.addRow([
      e.workDate,
      safeCell(names.get(e.membershipId) ?? ''),
      e.kind === 'check_in' ? 'In' : 'Out',
      clock(e.at, tz),
      e.status,
      e.kind === 'check_in' ? e.lateMin : '',
      Math.round(e.distanceM),
      safeCell(e.reasons.join('; ')),
    ]);
  }
  rows.columns = [
    { width: 12 },
    { width: 26 },
    { width: 8 },
    { width: 8 },
    { width: 12 },
    { width: 11 },
    { width: 13 },
    { width: 50 },
  ];

  const buf = await wb.xlsx.writeBuffer();
  const out = new Uint8Array(buf.byteLength);
  out.set(new Uint8Array(buf));
  return out;
}
