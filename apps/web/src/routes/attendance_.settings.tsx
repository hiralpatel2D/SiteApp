import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { ATTENDANCE_DEFAULTS, attendanceSettingsBodySchema } from '@sitediary/shared';
import { ApiError, errorMessage } from '../lib/api';
import { getSettings, putSettings } from '../lib/attendance';
import { getActiveProject } from '../lib/project';
import { AppShell, useCan, useShell } from '../components/AppShell';
import {
  Alert,
  Field,
  Loading,
  inputClass,
  labelClass,
  primaryButton,
  secondaryButton,
} from '../components/ui';
import { useActiveProjects } from '../attendance/useProjects';

export const Route = createFileRoute('/attendance_/settings')({ component: SiteSettings });

/** Site location must be better than this to be saved from the phone's GPS. */
const MAX_SETUP_ACCURACY_M = 50;
const LOCATE_TIMEOUT_MS = 20_000;
const LOCATION_BLOCKED =
  'Location is blocked. Allow location for this site in your browser settings.';
const LOCATION_FAILED = 'Could not find your location. Step into the open and try again.';

const card = 'flex flex-col gap-4 rounded-[var(--r)] border border-line-soft bg-card p-4';

function SiteSettings() {
  return (
    <AppShell title="Site settings">
      <SettingsGate />
    </AppShell>
  );
}

function SettingsGate() {
  const can = useCan('attendance.settings');
  if (!can) return <Alert>You do not have access to site settings.</Alert>;
  return <SettingsBody />;
}

type Form = {
  lat: string;
  lng: string;
  radiusM: number;
  startTime: string;
  lateAfterMin: string;
  reminderTime: string;
};

const blank: Form = {
  lat: '',
  lng: '',
  radiusM: ATTENDANCE_DEFAULTS.radiusM,
  startTime: ATTENDANCE_DEFAULTS.startTime,
  lateAfterMin: String(ATTENDANCE_DEFAULTS.lateAfterMin),
  reminderTime: ATTENDANCE_DEFAULTS.reminderTime,
};

/** Empty text is not a number (Number('') would be 0). */
const num = (s: string) => (s.trim() === '' ? NaN : Number(s));

function SettingsBody() {
  const { ctx } = useShell();
  const { projects, error: projectsError } = useActiveProjects();
  const [chosen, setChosen] = useState<string | null>(() =>
    ctx ? getActiveProject(ctx.company.id) : null,
  );
  const [form, setForm] = useState<Form | null>(null);
  const [version, setVersion] = useState<number | undefined>(undefined);
  const [loadError, setLoadError] = useState('');
  const [reload, setReload] = useState(0);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [locating, setLocating] = useState(false);
  const locateId = useRef(0);
  const locateTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(locateTimer.current), []);

  const project = projects?.find((p) => p.id === chosen) ?? projects?.[0] ?? null;
  const projectId = project?.id;

  useEffect(() => {
    if (!projectId) return;
    let live = true;
    setForm(null);
    setLoadError('');
    getSettings(projectId).then(
      ({ settings: s }) => {
        if (!live) return;
        setVersion(s?.version);
        setForm(
          s
            ? {
                lat: String(s.lat),
                lng: String(s.lng),
                radiusM: s.radiusM,
                startTime: s.startTime,
                lateAfterMin: String(s.lateAfterMin),
                reminderTime: s.reminderTime,
              }
            : blank,
        );
      },
      (err: unknown) => live && setLoadError(errorMessage(err)),
    );
    return () => {
      live = false;
    };
  }, [projectId, reload]);

  if (projects === null) return <Loading />;
  if (!project) {
    return (
      <Alert>
        {projectsError || 'No project yet. Add a project before setting up attendance.'}
      </Alert>
    );
  }

  const set = (patch: Partial<Form>) => {
    setForm((f) => (f ? { ...f, ...patch } : f));
    setNotice('');
  };

  function stopLocating() {
    locateId.current++;
    clearTimeout(locateTimer.current);
    setLocating(false);
  }

  function locate() {
    stopLocating();
    const id = locateId.current;
    const current = () => locateId.current === id;
    setError('');
    setNotice('');
    if (!('geolocation' in navigator)) {
      setError(LOCATION_FAILED);
      return;
    }
    setLocating(true);
    locateTimer.current = setTimeout(() => {
      if (!current()) return;
      stopLocating();
      setError(LOCATION_FAILED);
    }, LOCATE_TIMEOUT_MS);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        if (!current()) return;
        stopLocating();
        const acc = Math.round(p.coords.accuracy);
        if (!(p.coords.accuracy <= MAX_SETUP_ACCURACY_M)) {
          setError(`Location not accurate enough (±${acc} m). Move to open sky and try again.`);
          return;
        }
        set({ lat: p.coords.latitude.toFixed(6), lng: p.coords.longitude.toFixed(6) });
        setNotice(`Location set (±${acc} m). Save to keep it.`);
      },
      (err) => {
        if (!current()) return;
        stopLocating();
        setError(err.code === 1 ? LOCATION_BLOCKED : LOCATION_FAILED); // 1 = PERMISSION_DENIED
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!form || !projectId) return;
    setError('');
    setNotice('');
    setStale(false);
    const parsed = attendanceSettingsBodySchema.safeParse({
      lat: num(form.lat),
      lng: num(form.lng),
      radiusM: form.radiusM,
      startTime: form.startTime,
      lateAfterMin: num(form.lateAfterMin),
      reminderTime: form.reminderTime,
      version,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the settings and try again.');
      return;
    }
    setBusy(true);
    try {
      const { settings } = await putSettings(projectId, parsed.data);
      setVersion(settings.version);
      setNotice('Settings saved.');
    } catch (err) {
      setError(errorMessage(err));
      if (err instanceof ApiError && err.code === 'stale_version') setStale(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {projects.length > 1 ? (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="project" className={labelClass}>
            Project
          </label>
          <select
            id="project"
            value={project.id}
            disabled={busy}
            onChange={(e) => {
              stopLocating();
              setChosen(e.target.value);
              setError('');
              setNotice('');
              setStale(false);
            }}
            className={`${inputClass} min-h-11`}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <p className="font-display text-[22px] font-extrabold uppercase leading-tight">
          {project.name}
        </p>
      )}

      {loadError ? (
        <Alert>{loadError}</Alert>
      ) : !form ? (
        <Loading />
      ) : (
        <form onSubmit={(e) => void save(e)} noValidate className="flex flex-col gap-4">
          <section className={card} aria-label="Site location">
            <p className="font-medium">
              Stand at the site entrance or centre, then use your location.
            </p>
            <button type="button" className={secondaryButton} onClick={locate} disabled={locating}>
              {locating ? 'Finding your location…' : 'Use my current location'}
            </button>
            <div className="grid grid-cols-1 gap-3 min-[400px]:grid-cols-2">
              <Field
                id="lat"
                label="Latitude"
                inputMode="decimal"
                autoComplete="off"
                value={form.lat}
                onChange={(e) => set({ lat: e.target.value })}
              />
              <Field
                id="lng"
                label="Longitude"
                inputMode="decimal"
                autoComplete="off"
                value={form.lng}
                onChange={(e) => set({ lng: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-3">
                <label htmlFor="radius" className={labelClass}>
                  Radius
                </label>
                <span className="font-display text-[22px] font-extrabold">{`${form.radiusM} m`}</span>
              </div>
              <input
                id="radius"
                type="range"
                min={25}
                max={1000}
                step={1}
                value={form.radiusM}
                onChange={(e) => set({ radiusM: Number(e.target.value) })}
                className="h-11 w-full cursor-pointer accent-[var(--accent)]"
              />
            </div>
          </section>

          <section className={card} aria-label="Times">
            <div className="grid grid-cols-1 gap-3 min-[400px]:grid-cols-3">
              <Field
                id="start"
                label="Start time"
                type="time"
                value={form.startTime}
                onChange={(e) => set({ startTime: e.target.value })}
              />
              <Field
                id="late"
                label="Late after (min)"
                type="number"
                inputMode="numeric"
                min={0}
                max={120}
                value={form.lateAfterMin}
                onChange={(e) => set({ lateAfterMin: e.target.value })}
              />
              <Field
                id="reminder"
                label="Reminder time"
                type="time"
                value={form.reminderTime}
                onChange={(e) => set({ reminderTime: e.target.value })}
              />
            </div>
          </section>

          <Alert>{error}</Alert>
          {stale && (
            <button
              type="button"
              className={secondaryButton}
              onClick={() => {
                setStale(false);
                setError('');
                setReload((n) => n + 1);
              }}
            >
              Reload settings
            </button>
          )}
          {notice && (
            <p role="status" className="font-medium">
              {notice}
            </p>
          )}
          <button type="submit" className={primaryButton} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </form>
      )}
    </div>
  );
}
