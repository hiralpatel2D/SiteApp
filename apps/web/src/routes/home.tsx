import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CSSProperties } from 'react';
import { Link, createFileRoute } from '@tanstack/react-router';
import { api, errorMessage } from '../lib/api';
import { getToday, type Today } from '../lib/attendance';
import { timeOf } from '../attendance/time';
import { getActiveProject, setActiveProject, type Project } from '../lib/project';
import { AppShell, useCan, useShell } from '../components/AppShell';
import { Icon, type IconName } from '../components/icons';
import { Alert, primaryButton } from '../components/ui';

export const Route = createFileRoute('/home')({ component: Home });

/** The site modules, in the demo's order. Only Self Attendance is built so far. */
const MODULES: { id: string; name: string; icon: IconName }[] = [
  { id: 'attendance', name: 'Self Attendance', icon: 'clock' },
  { id: 'manpower', name: 'Manpower & Trades', icon: 'users' },
  { id: 'hindrance', name: 'Hindrance & Decisions', icon: 'alert' },
  { id: 'indent', name: 'Indent', icon: 'clip' },
  { id: 'stock', name: 'Stock', icon: 'box' },
  { id: 'inward', name: 'Material Inward', icon: 'inward' },
  { id: 'outward', name: 'Material Outward', icon: 'outward' },
  { id: 'drawings', name: 'Drawing Register', icon: 'file' },
  { id: 'equipment', name: 'Equipment / Plant', icon: 'truck' },
  { id: 'safety', name: 'Safety', icon: 'shield' },
  { id: 'report', name: 'Daily Report', icon: 'book' },
  { id: 'insights', name: 'Project Insights', icon: 'chart' },
];

type Tab = 'today' | 'progress' | 'notes' | 'alerts';
const TABS: { id: Tab; label: string; icon: IconName; empty: string }[] = [
  { id: 'today', label: 'Today', icon: 'home', empty: '' },
  {
    id: 'progress',
    label: 'Progress',
    icon: 'camera',
    empty: 'Plan vs actual progress arrives with the Daily Report module.',
  },
  {
    id: 'notes',
    label: 'Notes',
    icon: 'notes',
    empty: 'Site notes arrive with the Daily Report module.',
  },
  {
    id: 'alerts',
    label: 'Alerts',
    icon: 'bell',
    empty: 'Overdue hindrances, low stock and approvals will show here as those modules arrive.',
  },
];

const tile =
  'flex min-h-[132px] w-full flex-col gap-1.5 rounded-[var(--r)] border border-line-soft p-4 shadow-[0_1px_2px_color-mix(in_srgb,var(--text)_6%,transparent)]';

const rise = 'animate-[rise_.55s_var(--ease-out)_both] [animation-delay:calc(var(--i,0)*40ms)]';

function Home() {
  return (
    <AppShell>
      <HomeBody />
    </AppShell>
  );
}

function HomeBody() {
  const { ctx } = useShell();
  const canSeeProjects = useCan('projects.view');
  const canAttend = useCan('attendance.view');
  const [tab, setTab] = useState<Tab>('today');
  const [projects, setProjects] = useState<Project[] | null>(canSeeProjects ? null : []);
  const [error, setError] = useState('');
  const [projectId, setProjectId] = useState<string | null>(() =>
    ctx ? getActiveProject(ctx.company.id) : null,
  );

  useEffect(() => {
    if (!canSeeProjects) return;
    let live = true;
    api<Project[]>('/api/projects').then(
      (list) => live && setProjects(list.filter((p) => p.status === 'active')),
      (err: unknown) => {
        if (!live) return;
        setProjects([]);
        setError(errorMessage(err));
      },
    );
    return () => {
      live = false;
    };
  }, [canSeeProjects]);

  if (!ctx) return null;
  const current = projects?.find((p) => p.id === projectId) ?? projects?.[0] ?? null;

  function choose(id: string) {
    setProjectId(id);
    setActiveProject(ctx!.company.id, id);
  }

  const today = new Date().toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

  return (
    <div className="flex flex-col pb-24">
      <ProjectSwitcher projects={projects} current={current} onChoose={choose} />
      <p className="mb-4 mt-1 text-[13px] text-muted">
        {today} · {ctx.role.name}
      </p>
      <Alert>{error}</Alert>

      <div key={tab}>
        {tab === 'today' ? (
          <>
            {projects && projects.length === 0 && !error && <NoProjects />}
            <ul aria-label="Modules" className="grid grid-cols-2 gap-3 lg:grid-cols-3">
              {MODULES.map((m, k) => (
                <li key={m.id} style={{ '--i': k } as CSSProperties} className={`flex ${rise}`}>
                  {m.id === 'attendance' && canAttend ? (
                    <AttendanceTile
                      name={m.name}
                      icon={m.icon}
                      projectId={projects === null ? undefined : (current?.id ?? null)}
                    />
                  ) : (
                    <div className={`${tile} bg-card`}>
                      <TileHead name={m.name} icon={m.icon} />
                      <p className="font-mono text-[11px] uppercase tracking-widest text-muted">
                        Coming soon
                      </p>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <div
            className={`flex flex-col items-center gap-3 rounded-[var(--r)] border border-line-soft bg-card px-6 py-10 text-center ${rise}`}
          >
            <span className="grid size-[46px] place-items-center rounded-[12px] bg-surface text-muted">
              <Icon name={TABS.find((t) => t.id === tab)!.icon} />
            </span>
            <p className="max-w-[36ch] text-muted">{TABS.find((t) => t.id === tab)!.empty}</p>
          </div>
        )}
      </div>

      <TabBar tab={tab} onTab={setTab} />
    </div>
  );
}

function TileHead({ name, icon }: { name: string; icon: IconName }) {
  return (
    <>
      <span className="mb-2 grid size-[46px] place-items-center rounded-[12px] bg-icon-bg text-icon-fg">
        <Icon name={icon} />
      </span>
      <h3 className="font-display text-[20px] font-extrabold uppercase leading-[1.02]">{name}</h3>
    </>
  );
}

type TileStatus = { line: string; good?: boolean; pending?: boolean };

/** Today's attendance in one line, from the latest of check-in and check-out. */
function tileStatus(t: Today): TileStatus {
  if (!t.setUp) return { line: 'Not set up for this project' };
  if (!t.checkIn && !t.checkOut) {
    if (t.face === 'none' || t.face === 'rejected') return { line: 'Register your face' };
    if (t.face === 'pending') return { line: 'Face registration pending approval' };
  }
  const latest = t.checkOut
    ? { label: 'Checked out', e: t.checkOut }
    : t.checkIn
      ? { label: 'Checked in', e: t.checkIn }
      : null;
  if (!latest) return { line: 'Not checked in' };
  const line = `${latest.label} ${timeOf(latest.e.at)}`;
  return latest.e.status === 'pending' ? { line, pending: true } : { line, good: true };
}

/**
 * Self Attendance: opens /attendance and shows today's status for the Home project.
 * `projectId` is undefined while projects load and null when there is none.
 */
function AttendanceTile({
  name,
  icon,
  projectId,
}: {
  name: string;
  icon: IconName;
  projectId: string | null | undefined;
}) {
  const [loaded, setLoaded] = useState<{ projectId: string; status: TileStatus } | null>(null);

  useEffect(() => {
    if (!projectId) return;
    let live = true;
    getToday(projectId).then(
      (t) => live && setLoaded({ projectId, status: tileStatus(t) }),
      () => live && setLoaded({ projectId, status: { line: 'Tap to open' } }),
    );
    return () => {
      live = false;
    };
  }, [projectId]);

  let status: TileStatus | null = null;
  if (projectId === null) status = { line: 'No project yet' };
  else if (projectId && loaded?.projectId === projectId) status = loaded.status;

  return (
    <Link
      to="/attendance"
      className={`${tile} cursor-pointer transition-transform duration-300 ease-(--spring) hover:border-accent active:scale-[0.98] ${status?.good ? 'bg-good-bg' : 'bg-card'}`}
    >
      <TileHead name={name} icon={icon} />
      {status ? (
        <p className={`font-medium ${status.good ? 'text-text' : 'text-muted'}`}>{status.line}</p>
      ) : (
        <p className="text-muted">Loading…</p>
      )}
      {status?.pending && (
        <span className="inline-flex items-center gap-1.5 self-start rounded-full border border-warn px-2.5 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-widest text-text">
          <span aria-hidden="true" className="size-2 rounded-full bg-warn" />
          Pending approval
        </span>
      )}
    </Link>
  );
}

function ProjectSwitcher({
  projects,
  current,
  onChoose,
}: {
  projects: Project[] | null;
  current: Project | null;
  onChoose: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const canManage = useCan('projects.manage');
  const name = current?.name ?? (projects === null ? 'Loading…' : 'No project yet');
  const canOpen = (projects?.length ?? 0) > 0 || canManage;

  return (
    <div className="relative">
      <button
        type="button"
        disabled={!canOpen}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={`Project: ${name}. Change project`}
        onClick={() => setOpen((v) => !v)}
        className="group flex w-full cursor-pointer items-center justify-between gap-3 text-left disabled:cursor-default"
      >
        <h1 className="min-w-0 break-words font-display text-[30px] font-extrabold uppercase leading-[1.05] [text-wrap:balance] md:text-[34px]">
          {name}
        </h1>
        {canOpen && (
          <span
            className={`transition-transform duration-300 ease-(--spring) ${open ? 'rotate-180' : ''}`}
          >
            <Icon name="chev" size={24} />
          </span>
        )}
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full z-10 mt-2 flex origin-top animate-[rise_.3s_var(--ease-out)_both] flex-col gap-1 rounded-[var(--r)] border border-line bg-card p-2 shadow-lg">
          <ul role="listbox" aria-label="Projects" className="flex flex-col gap-1">
            {projects?.map((p) => (
              <li key={p.id} role="option" aria-selected={p.id === current?.id}>
                <button
                  type="button"
                  onClick={() => {
                    onChoose(p.id);
                    setOpen(false);
                  }}
                  className="flex min-h-11 w-full cursor-pointer flex-col items-start justify-center rounded-[calc(var(--r)*0.6)] px-3 py-2 text-left hover:bg-surface aria-[selected=true]:bg-surface"
                  aria-current={p.id === current?.id ? 'true' : undefined}
                >
                  <span className="font-medium">{p.name}</span>
                  <span className="font-mono text-[11px] uppercase tracking-widest text-muted">
                    {p.code}
                    {p.location ? ` · ${p.location}` : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {canManage && (
            <Link
              to="/projects"
              className="flex min-h-11 items-center gap-2 rounded-[calc(var(--r)*0.6)] px-3 font-medium hover:bg-surface"
            >
              <Icon name="plus" size={18} />
              Add or manage projects
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

function NoProjects() {
  const canManage = useCan('projects.manage');
  return (
    <div className="mb-4 flex flex-col gap-3 rounded-[var(--r)] border border-line-soft bg-card p-4">
      <p className="font-medium">
        {canManage
          ? 'Start by adding your first project (site). Attendance and every module work per project.'
          : 'You are not on any project yet. Ask your admin to add you to one.'}
      </p>
      {canManage && (
        <Link to="/projects" className={`${primaryButton} grid place-items-center`}>
          Add a project
        </Link>
      )}
    </div>
  );
}

/** Rendered on <body>: the page's entry animation would otherwise trap `fixed`. */
function TabBar({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  return createPortal(
    <div
      role="tablist"
      aria-label="Home sections"
      className="fixed inset-x-0 bottom-0 z-20 grid h-16 grid-cols-4 border-t border-line bg-bg/95 backdrop-blur md:left-[272px]"
    >
      {TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={tab === t.id}
          onClick={() => onTab(t.id)}
          className="group flex cursor-pointer flex-col items-center justify-center gap-0.5 font-mono text-[10.5px] font-semibold uppercase tracking-widest text-muted aria-selected:text-text"
        >
          <span className="transition-transform duration-300 ease-(--spring) group-active:scale-[0.82] group-aria-selected:-translate-y-0.5 group-aria-selected:scale-110 group-aria-selected:text-accent">
            <Icon name={t.icon} />
          </span>
          {t.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
