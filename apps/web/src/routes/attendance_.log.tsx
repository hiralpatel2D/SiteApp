import { useEffect, useState } from 'react';
import { Link, createFileRoute } from '@tanstack/react-router';
import { workDate } from '@sitediary/shared';
import { errorMessage } from '../lib/api';
import { getLog, type LogEntry } from '../lib/attendance';
import { getActiveProject } from '../lib/project';
import { AppShell, useCan, useShell } from '../components/AppShell';
import { Alert, Loading, inputClass, labelClass, secondaryButton } from '../components/ui';
import { timeOf } from '../attendance/time';
import { useActiveProjects } from '../attendance/useProjects';

export const Route = createFileRoute('/attendance_/log')({ component: AttendanceLog });

type Scope = 'me' | 'team';

const STATUS_LABEL: Record<LogEntry['status'], string> = {
  recorded: 'Recorded',
  approved: 'Approved',
  pending: 'Waiting for approval',
  rejected: 'Rejected',
};
const DAY_MS = 86_400_000;
const card = 'flex flex-col gap-2 rounded-[var(--r)] border border-line-soft bg-card p-4';

function AttendanceLog() {
  return (
    <AppShell title="Attendance log">
      <LogBody />
    </AppShell>
  );
}

const dayTitle = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

function entryLine(e: LogEntry, showName: boolean) {
  const parts = [
    `${showName ? `${e.name} · ` : ''}${e.kind === 'check_in' ? 'In' : 'Out'} ${timeOf(e.at)}`,
    STATUS_LABEL[e.status],
  ];
  if (e.kind === 'check_in' && e.lateMin > 0) parts.push(`Late by ${e.lateMin} min`);
  parts.push(`${Math.round(e.distanceM)} m from site`);
  return parts.join(' · ');
}

function LogBody() {
  const { ctx } = useShell();
  const canTeam = useCan('attendance.review');
  const { projects, error: projectError } = useActiveProjects();
  const [scope, setScope] = useState<Scope>('me');
  const [to, setTo] = useState(() => workDate(new Date()));
  const [from, setFrom] = useState(() => workDate(new Date(Date.now() - 29 * DAY_MS)));
  const [entries, setEntries] = useState<LogEntry[] | null>(null);
  const [error, setError] = useState('');

  const active = ctx ? getActiveProject(ctx.company.id) : null;
  const project = projects
    ? (projects.find((p) => p.id === active) ?? projects[0] ?? null)
    : undefined;
  const projectId = project?.id;

  useEffect(() => {
    if (!projectId) return;
    let live = true;
    setEntries(null);
    setError('');
    getLog(projectId, from, to, scope).then(
      (r) => live && setEntries(r.entries),
      (err: unknown) => live && setError(errorMessage(err)),
    );
    return () => {
      live = false;
    };
  }, [projectId, from, to, scope]);

  if (projectError) return <Alert>{projectError}</Alert>;
  if (project === undefined) return <Loading />;
  if (project === null) return <Alert>There is no active project to show.</Alert>;

  // Newest day first; entries within a day stay in time order.
  const days = new Map<string, LogEntry[]>();
  for (const e of entries ?? []) days.set(e.workDate, [...(days.get(e.workDate) ?? []), e]);
  const ordered = [...days.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));

  return (
    <div className="flex flex-col gap-4">
      <p className="font-display text-[22px] font-extrabold uppercase leading-tight">
        {project.name}
      </p>
      {canTeam && (
        <Link to="/attendance/summary" className={`${secondaryButton} grid place-items-center`}>
          Monthly summary
        </Link>
      )}
      {canTeam && (
        <div role="tablist" aria-label="Log" className="grid grid-cols-2 gap-2">
          {(['me', 'team'] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={scope === s}
              onClick={() => setScope(s)}
              className="min-h-12 cursor-pointer rounded-[calc(var(--r)*0.75)] border border-field-line bg-card px-4 font-display text-[19px] font-extrabold uppercase aria-selected:border-text aria-selected:bg-surface aria-selected:shadow-[inset_0_-3px_0_var(--accent)]"
            >
              {s === 'me' ? 'My log' : 'Everyone'}
            </button>
          ))}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="log-from" className={labelClass}>
            From
          </label>
          <input
            id="log-from"
            type="date"
            value={from}
            max={to}
            onChange={(ev) => ev.target.value && setFrom(ev.target.value)}
            className={inputClass}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="log-to" className={labelClass}>
            To
          </label>
          <input
            id="log-to"
            type="date"
            value={to}
            min={from}
            onChange={(ev) => ev.target.value && setTo(ev.target.value)}
            className={inputClass}
          />
        </div>
      </div>
      <Alert>{error}</Alert>
      {!error && entries === null && <Loading />}
      {entries !== null &&
        (ordered.length === 0 ? (
          <p className="rounded-[var(--r)] border border-line-soft bg-card p-4 text-muted">
            No attendance in these dates.
          </p>
        ) : (
          <ul aria-label="Attendance by day" className="flex flex-col gap-3">
            {ordered.map(([day, list]) => (
              <li key={day} className={card}>
                <span className="font-display text-[20px] font-extrabold uppercase leading-tight">
                  {dayTitle(day)}
                </span>
                <ul className="flex flex-col gap-1">
                  {list.map((e) => (
                    <li key={e.id} className="font-medium">
                      {entryLine(e, scope === 'team')}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}
