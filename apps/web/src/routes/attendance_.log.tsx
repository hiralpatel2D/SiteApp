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
import {
  buildRows,
  filterRows,
  hoursText,
  sortRows,
  type LogFilters,
  type LogRow,
  type RowStatus,
  type SortDir,
  type SortKey,
} from '../attendance/logRows';

export const Route = createFileRoute('/attendance_/log')({ component: AttendanceLog });

type Scope = 'me' | 'team';

const STATUS_LABEL: Record<RowStatus, string> = {
  recorded: 'Recorded',
  approved: 'Approved',
  pending: 'Waiting',
  rejected: 'Rejected',
};
const STATUS_TAG: Record<RowStatus, string> = {
  approved: 'bg-good-bg text-good',
  recorded: 'bg-surface text-muted',
  pending: 'bg-surface font-semibold text-warn',
  rejected: 'bg-text font-semibold text-card',
};
const DAY_MS = 86_400_000;
const tag = 'inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium';
const capsule =
  'min-h-9 cursor-pointer rounded-full border border-field-line bg-card px-3 text-sm font-medium aria-pressed:border-text aria-pressed:bg-surface aria-pressed:font-semibold aria-pressed:shadow-[inset_0_-2px_0_var(--accent)]';

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

const shift = (d: string, days: number) =>
  workDate(new Date(Date.parse(`${d}T00:00:00Z`) + days * DAY_MS));

/** Quick date ranges, each as [from, to] relative to today. */
function presets(today: string): { label: string; from: string; to: string }[] {
  return [
    { label: 'Today', from: today, to: today },
    { label: 'Yesterday', from: shift(today, -1), to: shift(today, -1) },
    { label: 'Last 7 days', from: shift(today, -6), to: today },
    { label: 'Last 30 days', from: shift(today, -29), to: today },
    { label: 'This month', from: `${today.slice(0, 7)}-01`, to: today },
  ];
}

const COLUMNS: { key: SortKey; label: string; team?: boolean }[] = [
  { key: 'date', label: 'Date' },
  { key: 'name', label: 'Name', team: true },
  { key: 'in', label: 'In' },
  { key: 'out', label: 'Out' },
  { key: 'hours', label: 'Hours' },
  { key: 'status', label: 'Status' },
  { key: 'distance', label: 'Distance' },
];

function LogTable({
  rows,
  team,
  sort,
  onSort,
}: {
  rows: LogRow[];
  team: boolean;
  sort: { key: SortKey; dir: SortDir };
  onSort: (key: SortKey) => void;
}) {
  const cols = COLUMNS.filter((c) => team || !c.team);
  return (
    <div className="overflow-x-auto rounded-[var(--r)] border border-line-soft bg-card">
      <table aria-label="Attendance log" className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-line-soft bg-surface">
            {cols.map((c) => (
              <th
                key={c.key}
                scope="col"
                aria-sort={
                  sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'
                }
                className="whitespace-nowrap px-3 py-2 text-left"
              >
                <button
                  type="button"
                  onClick={() => onSort(c.key)}
                  className="cursor-pointer font-mono text-[11px] font-medium uppercase tracking-widest text-muted hover:text-text"
                >
                  {c.label}
                  {sort.key === c.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-b border-line-soft last:border-b-0">
              <td className="whitespace-nowrap px-3 py-2.5 font-medium">{dayTitle(r.workDate)}</td>
              {team && <td className="min-w-28 px-3 py-2.5 font-medium">{r.name}</td>}
              <td className="whitespace-nowrap px-3 py-2.5">
                {r.inAt ? timeOf(r.inAt) : '—'}
                {r.lateMin > 0 && (
                  <span
                    className={`${tag} ml-1.5 bg-surface text-warn`}
                  >{`Late ${r.lateMin} min`}</span>
                )}
              </td>
              <td className="whitespace-nowrap px-3 py-2.5">{r.outAt ? timeOf(r.outAt) : '—'}</td>
              <td className="whitespace-nowrap px-3 py-2.5">{hoursText(r.workedMin)}</td>
              <td className="px-3 py-2.5" title={r.reasons.join(', ')}>
                <span className={`${tag} ${STATUS_TAG[r.status]}`}>{STATUS_LABEL[r.status]}</span>
              </td>
              <td className="whitespace-nowrap px-3 py-2.5 text-muted">{`${Math.round(r.distanceM)} m`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
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
  const [filters, setFilters] = useState<LogFilters>({
    status: 'all',
    lateOnly: false,
    search: '',
  });
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'date', dir: 'desc' });
  const today = workDate(new Date());

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

  const team = scope === 'team';
  const rows = buildRows(entries ?? []);
  const shown = sortRows(filterRows(rows, filters), sort.key, sort.dir);
  const count = (st: RowStatus) => rows.filter((r) => r.status === st).length;
  const filtered = filters.status !== 'all' || filters.lateOnly || filters.search.trim() !== '';
  const toggleSort = (key: SortKey) =>
    setSort((cur) =>
      cur.key === key
        ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: key === 'date' || key === 'status' ? 'desc' : 'asc' },
    );

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
      <div role="group" aria-label="Date range" className="flex flex-wrap gap-2">
        {presets(today).map((p) => (
          <button
            key={p.label}
            type="button"
            aria-pressed={from === p.from && to === p.to}
            onClick={() => {
              setFrom(p.from);
              setTo(p.to);
            }}
            className={capsule}
          >
            {p.label}
          </button>
        ))}
      </div>
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
      {team && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="log-search" className={labelClass}>
            Find a person
          </label>
          <input
            id="log-search"
            type="search"
            value={filters.search}
            placeholder="Type a name"
            onChange={(ev) => setFilters({ ...filters, search: ev.target.value })}
            className={inputClass}
          />
        </div>
      )}
      <div role="group" aria-label="Filter by status" className="flex flex-wrap gap-2">
        <button
          type="button"
          aria-pressed={filters.status === 'all'}
          onClick={() => setFilters({ ...filters, status: 'all' })}
          className={capsule}
        >
          {`All ${rows.length}`}
        </button>
        {(['approved', 'pending', 'rejected', 'recorded'] as const).map((st) => (
          <button
            key={st}
            type="button"
            aria-pressed={filters.status === st}
            onClick={() => setFilters({ ...filters, status: filters.status === st ? 'all' : st })}
            className={capsule}
          >
            {`${STATUS_LABEL[st]} ${count(st)}`}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={filters.lateOnly}
          onClick={() => setFilters({ ...filters, lateOnly: !filters.lateOnly })}
          className={capsule}
        >
          {`Late only ${rows.filter((r) => r.lateMin > 0).length}`}
        </button>
      </div>
      <Alert>{error}</Alert>
      {!error && entries === null && <Loading />}
      {entries !== null && (
        <>
          <div className="flex items-center justify-between gap-3 text-sm text-muted">
            <span role="status">{`${shown.length} of ${rows.length} days shown`}</span>
            {filtered && (
              <button
                type="button"
                onClick={() => setFilters({ status: 'all', lateOnly: false, search: '' })}
                className="cursor-pointer font-medium text-text underline underline-offset-4 hover:text-accent"
              >
                Clear filters
              </button>
            )}
          </div>
          {shown.length === 0 ? (
            <p className="rounded-[var(--r)] border border-line-soft bg-card p-4 text-muted">
              {rows.length === 0
                ? 'No attendance in these dates.'
                : 'Nothing matches these filters.'}
            </p>
          ) : (
            <LogTable rows={shown} team={team} sort={sort} onSort={toggleSort} />
          )}
        </>
      )}
    </div>
  );
}
