import { useEffect, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { workDate } from '@sitediary/shared';
import { errorMessage } from '../lib/api';
import { downloadExport, getSummary, type DayStatus, type MonthlySummary } from '../lib/attendance';
import { getActiveProject } from '../lib/project';
import { AppShell, useCan, useShell } from '../components/AppShell';
import { Alert, Loading, inputClass, labelClass, primaryButton } from '../components/ui';
import { useActiveProjects } from '../attendance/useProjects';

export const Route = createFileRoute('/attendance_/summary')({ component: Summary });

const CODE: Record<DayStatus, string> = {
  present: 'P',
  late: 'L',
  pending: '?',
  absent: 'A',
  open: '',
};
const TONE: Record<DayStatus, string> = {
  present: 'bg-good-bg text-good',
  late: 'bg-surface font-semibold text-warn',
  pending: 'bg-surface text-muted',
  absent: 'bg-surface text-text font-bold',
  open: 'text-muted',
};

function Summary() {
  return (
    <AppShell title="Monthly summary">
      <SummaryBody />
    </AppShell>
  );
}

/** "October 2026" for a `YYYY-MM` month. */
export const monthTitle = (month: string) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

const weekday = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });

type TotalKey = 'name' | 'present' | 'late' | 'pending' | 'absent' | 'hours';
const TOTALS: { key: TotalKey; label: string }[] = [
  { key: 'present', label: 'Present' },
  { key: 'late', label: 'Late' },
  { key: 'pending', label: 'Pending' },
  { key: 'absent', label: 'Absent' },
  { key: 'hours', label: 'Hours' },
];

/** One table for the month: a row per person with totals, then a header of dates, scrolling sideways. */
function DayTable({ data }: { data: MonthlySummary }) {
  const today = workDate(new Date());
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<{ key: TotalKey; dir: 'asc' | 'desc' }>({
    key: 'name',
    dir: 'asc',
  });
  const q = search.trim().toLowerCase();
  const people = data.people
    .filter((p) => q === '' || p.name.toLowerCase().includes(q))
    .sort((a, b) => {
      const sign = sort.dir === 'asc' ? 1 : -1;
      const c =
        sort.key === 'name'
          ? a.name.toLowerCase().localeCompare(b.name.toLowerCase())
          : a[sort.key] - b[sort.key];
      return c * sign || a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
  const toggle = (key: TotalKey) =>
    setSort((cur) =>
      cur.key === key
        ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: key === 'name' ? 'asc' : 'desc' },
    );
  const sortHead = (key: TotalKey, label: string, cls: string) => (
    <th
      key={key}
      scope="col"
      aria-sort={sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={`border-b border-line-soft px-2 py-1.5 font-medium ${cls}`}
    >
      <button
        type="button"
        onClick={() => toggle(key)}
        className="cursor-pointer hover:text-accent"
      >
        {label}
        {sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
      </button>
    </th>
  );
  return (
    <div className="flex flex-col gap-3">
      <h2 className="font-display text-[20px] font-extrabold uppercase leading-tight">
        {`Day by day · ${monthTitle(data.month)}`}
      </h2>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="summary-search" className={labelClass}>
          Find a person
        </label>
        <input
          id="summary-search"
          type="search"
          value={search}
          placeholder="Type a name"
          onChange={(ev) => setSearch(ev.target.value)}
          className={inputClass}
        />
      </div>
      <div className="overflow-x-auto rounded-[var(--r)] border border-line-soft bg-card">
        <table
          aria-label={`Day by day, ${monthTitle(data.month)}`}
          className="border-separate border-spacing-0 text-xs"
        >
          <thead>
            <tr>
              {sortHead('name', 'Name', 'sticky left-0 z-10 min-w-28 border-r bg-card text-left')}
              {TOTALS.map((t) => sortHead(t.key, t.label, 'bg-surface text-center'))}
              {data.days.map((d) => (
                <th
                  key={d}
                  scope="col"
                  title={d}
                  className={`min-w-8 border-b border-line-soft px-1 py-1.5 text-center font-medium ${d === today ? 'bg-surface' : ''}`}
                >
                  <span className="block">{d.slice(8)}</span>
                  <span className="block font-normal text-muted">{weekday(d).slice(0, 2)}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {people.map((p) => (
              <tr key={p.membershipId}>
                <th
                  scope="row"
                  className="sticky left-0 z-10 max-w-36 truncate border-b border-r border-line-soft bg-card px-2 py-1.5 text-left font-medium"
                >
                  {p.name}
                </th>
                {TOTALS.map((t) => (
                  <td
                    key={t.key}
                    className="border-b border-line-soft bg-surface px-2 py-1.5 text-center font-medium"
                  >
                    {p[t.key]}
                  </td>
                ))}
                {p.cells.map((c) => (
                  <td
                    key={c.date}
                    title={`${c.date} · ${c.status}`}
                    className={`h-8 border-b border-line-soft text-center ${TONE[c.status]}`}
                  >
                    {CODE[c.status]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {people.length === 0 && (
        <p className="rounded-[var(--r)] border border-line-soft bg-card p-4 text-muted">
          Nobody matches that name.
        </p>
      )}
    </div>
  );
}

function SummaryBody() {
  const { ctx } = useShell();
  const canExport = useCan('attendance.export');
  const canReview = useCan('attendance.review');
  const { projects, error: projectError } = useActiveProjects();
  const [month, setMonth] = useState(() => workDate(new Date()).slice(0, 7));
  const [data, setData] = useState<MonthlySummary | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const active = ctx ? getActiveProject(ctx.company.id) : null;
  const project = projects
    ? (projects.find((p) => p.id === active) ?? projects[0] ?? null)
    : undefined;
  const projectId = project?.id;

  useEffect(() => {
    if (!projectId || !canReview) return;
    let live = true;
    setData(null);
    setError('');
    getSummary(projectId, month).then(
      (r) => live && setData(r),
      (err: unknown) => live && setError(errorMessage(err)),
    );
    return () => {
      live = false;
    };
  }, [projectId, month, canReview]);

  async function download() {
    if (!projectId) return;
    setBusy(true);
    setError('');
    try {
      await downloadExport(projectId, month);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!canReview) return <Alert>You do not have access to the monthly summary.</Alert>;
  if (projectError) return <Alert>{projectError}</Alert>;
  if (project === undefined) return <Loading />;
  if (project === null) return <Alert>There is no active project to show.</Alert>;

  return (
    <div className="flex flex-col gap-4">
      <p className="font-display text-[22px] font-extrabold uppercase leading-tight">
        {project.name}
      </p>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="summary-month" className={labelClass}>
          Month
        </label>
        <input
          id="summary-month"
          type="month"
          value={month}
          max={workDate(new Date()).slice(0, 7)}
          onChange={(ev) => ev.target.value && setMonth(ev.target.value)}
          className={inputClass}
        />
      </div>
      {canExport && (
        <button
          type="button"
          className={primaryButton}
          disabled={busy}
          onClick={() => void download()}
        >
          {busy ? 'Preparing…' : 'Download Excel'}
        </button>
      )}
      <Alert>{error}</Alert>
      {!error && !data && <Loading />}
      {data &&
        (data.people.length === 0 ? (
          <p className="rounded-[var(--r)] border border-line-soft bg-card p-4 text-muted">
            No one is assigned to this project and nothing is recorded this month.
          </p>
        ) : (
          <>
            <p className="font-medium">{monthTitle(data.month)}</p>
            <p className="text-sm text-muted">
              P present · L late (counted in present) · ? waiting for approval · A absent
            </p>
            <DayTable data={data} />
          </>
        ))}
    </div>
  );
}
