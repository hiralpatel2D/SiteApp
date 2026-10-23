import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, createFileRoute } from '@tanstack/react-router';
import { ATTENDANCE_TZ, distanceMeters } from '@sitediary/shared';
import { ApiError, errorMessage } from '../lib/api';
import {
  getSettings,
  getToday,
  postCheck,
  type AttendanceSettings,
  type CheckKind,
  type CheckResult,
  type Today,
  type TodayEntry,
} from '../lib/attendance';
import { getActiveProject, type Project } from '../lib/project';
import { AppShell, useCan, useShell } from '../components/AppShell';
import { Icon } from '../components/icons';
import { Alert, Loading, primaryButton, secondaryButton } from '../components/ui';
import { CameraCheck } from '../attendance/CameraCheck';
import { timeOf } from '../attendance/time';
import { useActiveProjects } from '../attendance/useProjects';

export const Route = createFileRoute('/attendance')({ component: Attendance });

const LOCATION_BLOCKED =
  'Location is blocked. Allow location for this site in your browser settings.';
const LOCATION_FAILED = 'Could not find your location. Step into the open and try again.';
/** Some phones never answer getCurrentPosition; give up after this. */
const LOCATE_TIMEOUT_MS = 20_000;
/** /check refusals that mean our copy of today is out of date. */
const RELOAD_ON = new Set([
  'face_not_registered',
  'already_checked_in',
  'already_checked_out',
  'check_in_first',
]);
const NOT_SET_UP =
  'Attendance is not set up for this project yet. Ask your admin to set the site location.';

const NOT_SET_UP_ADMIN =
  'Attendance is not set up for this project yet. Set the site location and radius to start.';

const card = 'flex flex-col gap-3 rounded-[var(--r)] border border-line-soft bg-card p-4';

function Attendance() {
  return (
    <AppShell title="Self Attendance">
      <AttendanceBody />
      <Link to="/attendance/log" className={`${secondaryButton} mt-4 grid place-items-center`}>
        Attendance log
      </Link>
    </AppShell>
  );
}

/** Ruling R4: Home's active project, else the first active project. */
function useProject(): { project: Project | null | undefined; error: string } {
  const { ctx } = useShell();
  const { projects, error } = useActiveProjects();
  if (projects === null || !ctx) return { project: undefined, error };
  const active = getActiveProject(ctx.company.id);
  return { project: projects.find((p) => p.id === active) ?? projects[0] ?? null, error };
}

type Position = { lat: number; lng: number; accuracyM: number };

type Step =
  | { kind: 'idle' }
  | { kind: 'locating' }
  | { kind: 'camera'; pos: Position }
  | { kind: 'sending' }
  | { kind: 'done'; result: CheckResult }
  | { kind: 'failed'; message: string };

/** Admins get the way forward; everyone else is told who to ask. */
function NotSetUp() {
  const canSet = useCan('attendance.settings');
  if (!canSet) return <Card>{NOT_SET_UP}</Card>;
  return (
    <div className={card}>
      <p className="font-medium">{NOT_SET_UP_ADMIN}</p>
      <Link to="/attendance/settings" className={`${primaryButton} grid place-items-center`}>
        Set site location
      </Link>
    </div>
  );
}

function AttendanceBody() {
  const { project, error: projectError } = useProject();
  const [today, setToday] = useState<Today | null>(null);
  const [settings, setSettings] = useState<AttendanceSettings | null>(null);
  const [loadError, setLoadError] = useState('');
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const [reload, setReload] = useState(0);
  // Each location request gets an id; a cancelled or timed-out one is ignored.
  const locateId = useRef(0);
  const locateTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(locateTimer.current), []);

  const projectId = project?.id;
  useEffect(() => {
    if (!projectId) return;
    let live = true;
    setLoadError('');
    setToday(null);
    setSettings(null);
    Promise.all([getToday(projectId), getSettings(projectId)]).then(
      ([t, s]) => {
        if (!live) return;
        setToday(t);
        setSettings(s.settings);
      },
      (err: unknown) => live && setLoadError(errorMessage(err)),
    );
    return () => {
      live = false;
    };
  }, [projectId, reload]);

  if (project === undefined) return <Loading />;
  if (project === null) return projectError ? <Alert>{projectError}</Alert> : <NoProject />;

  const kind: CheckKind = today?.checkIn ? 'check_out' : 'check_in';
  const tz = settings?.timezone ?? ATTENDANCE_TZ;

  function stopLocating() {
    locateId.current++;
    clearTimeout(locateTimer.current);
  }

  function start() {
    stopLocating();
    const id = locateId.current;
    const current = () => locateId.current === id;
    setStep({ kind: 'locating' });
    if (!('geolocation' in navigator)) {
      setStep({ kind: 'failed', message: LOCATION_FAILED });
      return;
    }
    locateTimer.current = setTimeout(() => {
      if (!current()) return;
      stopLocating();
      setStep({ kind: 'failed', message: LOCATION_FAILED });
    }, LOCATE_TIMEOUT_MS);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        if (!current()) return;
        stopLocating();
        setStep({
          kind: 'camera',
          pos: { lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: p.coords.accuracy },
        });
      },
      (err) => {
        if (!current()) return;
        stopLocating();
        setStep({
          kind: 'failed',
          message: err.code === 1 ? LOCATION_BLOCKED : LOCATION_FAILED, // 1 = PERMISSION_DENIED
        });
      },
      { enableHighAccuracy: true, timeout: 15000 },
    );
  }

  function cancelLocating() {
    stopLocating();
    setStep({ kind: 'idle' });
  }

  async function submit(pos: Position, frames: string[]) {
    setStep({ kind: 'sending' });
    try {
      const result = await postCheck({ projectId: project!.id, kind, ...pos, frames });
      const entry: TodayEntry = {
        status: result.status,
        at: result.at,
        distanceM: result.distanceM,
        lateMin: result.lateMin,
        reasons: result.reasons,
      };
      setToday((t) =>
        t ? { ...t, [result.kind === 'check_in' ? 'checkIn' : 'checkOut']: entry } : t,
      );
      setStep({ kind: 'done', result });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'attendance_not_set_up') {
        setToday((t) => (t ? { ...t, setUp: false } : t));
        setStep({ kind: 'idle' });
        return;
      }
      if (err instanceof ApiError && RELOAD_ON.has(err.code)) {
        // Today's status on the server differs from ours: show the fresh one.
        back();
        return;
      }
      setStep({ kind: 'failed', message: errorMessage(err) });
    }
  }

  /** Back to the status view with a fresh copy of today. */
  function back() {
    setStep({ kind: 'idle' });
    setReload((n) => n + 1);
  }

  let body: ReactNode;
  if (loadError) body = <Alert>{loadError}</Alert>;
  else if (!today) body = <Loading />;
  else if (!today.setUp) body = <NotSetUp />;
  else if (today.face !== 'approved') body = <FaceCard face={today.face} />;
  else if (step.kind === 'done')
    body = <Confirmation result={step.result} tz={tz} onDone={() => setStep({ kind: 'idle' })} />;
  else if (step.kind === 'failed')
    body = (
      <div className={card}>
        <p role="alert" className="font-medium">
          {step.message}
        </p>
        <button type="button" className={primaryButton} onClick={start}>
          Try again
        </button>
        <button type="button" className={secondaryButton} onClick={back}>
          Back
        </button>
      </div>
    );
  else if (step.kind === 'camera')
    body = (
      <div className="flex flex-col gap-3">
        <Distance pos={step.pos} settings={settings} />
        <CameraCheck
          onCaptured={(frames) => void submit(step.pos, frames)}
          onError={(message) => setStep({ kind: 'failed', message })}
          onCancel={() => setStep({ kind: 'idle' })}
        />
      </div>
    );
  else if (step.kind === 'locating')
    body = (
      <div className={card}>
        <Loading>Finding your location…</Loading>
        <button type="button" className={secondaryButton} onClick={cancelLocating}>
          Cancel
        </button>
      </div>
    );
  else if (step.kind === 'sending') body = <Loading>Saving…</Loading>;
  else body = <Status today={today} kind={kind} tz={tz} onStart={start} />;

  return (
    <div className="flex flex-col gap-4">
      <p className="font-display text-[22px] font-extrabold uppercase leading-tight">
        {project.name}
      </p>
      {body}
    </div>
  );
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div className={card}>
      <p className="font-medium">{children}</p>
    </div>
  );
}

function NoProject() {
  return (
    <div className={card}>
      <h2 className="font-display text-[24px] font-extrabold uppercase">No project yet</h2>
      <p className="text-muted">Attendance works per project. Add or join a project first.</p>
      <Link to="/projects" className={`${primaryButton} grid place-items-center`}>
        Go to projects
      </Link>
    </div>
  );
}

function FaceCard({ face }: { face: Today['face'] }) {
  if (face === 'pending') {
    return <Card>Your face registration is waiting for approval by a senior.</Card>;
  }
  return (
    <div className={card}>
      <p className="font-medium">
        {face === 'rejected'
          ? 'Your face registration was not approved. Register again to check in.'
          : 'Register your face once before your first check-in.'}
      </p>
      <Link to="/attendance/register" className={`${primaryButton} grid place-items-center`}>
        Register your face
      </Link>
    </div>
  );
}

function entryLine(label: string, e: TodayEntry, tz: string): string {
  const extra = e.status === 'pending' ? ' · waiting for approval' : '';
  return `${label} at ${timeOf(e.at, tz)}${extra}`;
}

function Status({
  today,
  kind,
  tz,
  onStart,
}: {
  today: Today;
  kind: CheckKind;
  tz: string;
  onStart: () => void;
}) {
  const done = today.checkIn && today.checkOut;
  return (
    <div className="flex flex-col gap-4">
      {(today.checkIn || today.checkOut) && (
        <ul className={`${card} gap-1`} aria-label="Today">
          {today.checkIn && <li>{entryLine('Checked in', today.checkIn, tz)}</li>}
          {today.checkOut && <li>{entryLine('Checked out', today.checkOut, tz)}</li>}
        </ul>
      )}
      {done ? (
        <div className="flex flex-col items-center gap-2 rounded-[var(--r)] bg-good-bg p-6 text-center">
          <span className="text-good">
            <Tick />
          </span>
          <p className="font-display text-[28px] font-extrabold uppercase">Done for today</p>
        </div>
      ) : (
        <button type="button" onClick={onStart} className={`${primaryButton} h-[72px] text-[26px]`}>
          {kind === 'check_in' ? 'Check in' : 'Check out'}
        </button>
      )}
    </div>
  );
}

function Distance({ pos, settings }: { pos: Position; settings: AttendanceSettings | null }) {
  if (!settings) return null;
  const d = Math.round(distanceMeters(pos, settings));
  return (
    <p className="flex items-center gap-2 text-muted">
      <Icon name="pin" size={18} />
      {`${d} m from site · ±${Math.round(pos.accuracyM)} m`}
    </p>
  );
}

function Confirmation({
  result,
  tz,
  onDone,
}: {
  result: CheckResult;
  tz: string;
  onDone: () => void;
}) {
  const verb = result.kind === 'check_in' ? 'Checked in' : 'Checked out';
  const line = `${verb} at ${timeOf(result.at, tz)} · ${result.projectName} · ${Math.round(result.distanceM)} m from site`;
  const pending = result.status === 'pending';
  return (
    <div className="flex flex-col gap-4">
      <div
        className={`flex flex-col items-center gap-3 rounded-[var(--r)] p-6 text-center ${pending ? 'border border-line bg-card' : 'bg-good-bg'}`}
      >
        <span className={pending ? 'text-warn' : 'text-good'}>
          {pending ? <Icon name="clock" size={64} /> : <Tick />}
        </span>
        {pending && (
          <p className="font-display text-[28px] font-extrabold uppercase">Sent for approval</p>
        )}
        <p className="text-[17px] font-medium">{line}</p>
        {result.lateMin > 0 && <p className="font-medium">{`Late by ${result.lateMin} min`}</p>}
        {pending && result.reasons.length > 0 && (
          <ul aria-label="Reasons" className="list-disc self-stretch pl-6 text-left">
            {result.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
      </div>
      <button type="button" className={secondaryButton} onClick={onDone}>
        Done
      </button>
    </div>
  );
}

function Tick() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="64"
      height="64"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M7.5 12.5l3 3 6-6.5" />
    </svg>
  );
}
