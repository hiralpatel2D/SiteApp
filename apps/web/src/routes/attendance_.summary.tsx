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

const card = 'flex flex-col gap-2 rounded-[var(--r)] border border-line-soft bg-card p-4';
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

const weekday = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });

/** One table for the whole month: a header of dates, one row per person, scrolling sideways. */
function DayTable({ data }: { data: MonthlySummary }) {
  const today = workDate(new Date());
  return (
    <div className="flex flex-col gap-2">
      <h2 className="font-display text-[20px] font-extrabold uppercase leading-tight">
        Day by day
      </h2>
      <div className="overflow-x-auto rounded-[var(--r)] border border-line-soft bg-card">
        <table aria-label="Day by day" className="border-separate border-spacing-0 text-xs">
          <thead>
            <tr>
              <th
                scope="col"
                className="sticky left-0 z-10 min-w-28 border-b border-r border-line-soft bg-card px-2 py-1.5 text-left font-medium"
              >
                Name
              </th>
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
            {data.people.map((p) => (
              <tr key={p.membershipId}>
                <th
                  scope="row"
                  className="sticky left-0 z-10 max-w-36 truncate border-r border-line-soft bg-card px-2 py-1.5 text-left font-medium"
                >
                  {p.name}
                </th>
                {p.cells.map((c) => (
                  <td
                    key={c.date}
                    title={`${c.date} · ${c.status}`}
                    className={`h-8 text-center ${TONE[c.status]}`}
                  >
                    {CODE[c.status]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
            <p className="text-sm text-muted">
              P present · L late (counted in present) · ? waiting for approval · A absent
            </p>
            <ul aria-label="People" className="flex flex-col gap-3">
              {data.people.map((p) => (
                <li key={p.membershipId} className={card}>
                  <span className="break-words font-display text-[20px] font-extrabold uppercase leading-tight">
                    {p.name}
                  </span>
                  <p className="font-medium">
                    {`Present ${p.present} · Late ${p.late} · Pending ${p.pending} · Absent ${p.absent} · ${p.hours} h`}
                  </p>
                </li>
              ))}
            </ul>
            <DayTable data={data} />
          </>
        ))}
    </div>
  );
}
