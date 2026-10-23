import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { ApiError, errorMessage } from '../lib/api';
import {
  approveEntry,
  approveFace,
  getPendingEntries,
  getPendingFaces,
  rejectEntry,
  rejectFace,
  type PendingEntry,
  type PendingFace,
} from '../lib/attendance';
import { AppShell, useCan } from '../components/AppShell';
import { Alert, Loading, inputClass, labelClass, secondaryButton } from '../components/ui';
import { timeOf } from '../attendance/time';

export const Route = createFileRoute('/attendance_/approvals')({ component: Approvals });

type Tab = 'faces' | 'checkins';

const row = 'flex flex-col gap-3 rounded-[var(--r)] border border-line-soft bg-card p-4';
const approveButton =
  'inline-flex min-h-12 flex-1 cursor-pointer items-center justify-center rounded-[calc(var(--r)*0.75)] bg-accent px-4 font-display text-[19px] font-extrabold uppercase tracking-[0.03em] text-on-accent disabled:cursor-default disabled:opacity-60';
const rejectButton = `${secondaryButton} min-h-12 flex-1`;

function Approvals() {
  return (
    <AppShell title="Approvals">
      <ApprovalsBody />
    </AppShell>
  );
}

function ApprovalsBody() {
  const canFaces = useCan('attendance.approve_face');
  const canReview = useCan('attendance.review');
  const tabs: { id: Tab; label: string }[] = [
    ...(canFaces ? [{ id: 'faces' as const, label: 'Faces' }] : []),
    ...(canReview ? [{ id: 'checkins' as const, label: 'Check-ins' }] : []),
  ];
  const [picked, setPicked] = useState<Tab | null>(null);
  const tab = tabs.find((t) => t.id === picked)?.id ?? tabs[0]?.id;

  if (!tab) return <Alert>You do not have access to approvals.</Alert>;

  return (
    <div className="flex flex-col gap-4">
      {tabs.length > 1 && (
        <div role="tablist" aria-label="Approvals" className="grid grid-cols-2 gap-2">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              onClick={() => setPicked(t.id)}
              className="min-h-12 cursor-pointer rounded-[calc(var(--r)*0.75)] border border-field-line bg-card px-4 font-display text-[19px] font-extrabold uppercase aria-selected:border-text aria-selected:bg-surface aria-selected:shadow-[inset_0_-3px_0_var(--accent)]"
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
      <div
        id={`panel-${tab}`}
        role={tabs.length > 1 ? 'tabpanel' : undefined}
        aria-labelledby={tabs.length > 1 ? `tab-${tab}` : undefined}
      >
        {tab === 'faces' ? <Faces /> : <CheckIns />}
      </div>
    </div>
  );
}

/** Runs a decision: on success drops the row; on already_decided shows why and reloads. */
function useDecide(remove: (id: string) => void, reload: () => void) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function decide(id: string, call: () => Promise<unknown>, done: string) {
    setBusy(id);
    setError('');
    setNotice('');
    try {
      await call();
      remove(id);
      setNotice(done);
    } catch (err) {
      setError(errorMessage(err));
      if (err instanceof ApiError && (err.code === 'already_decided' || err.status === 404)) {
        reload();
      }
    } finally {
      setBusy(null);
    }
  }

  return { busy, error, notice, decide };
}

function Messages({ error, notice }: { error: string; notice: string }) {
  return (
    <>
      <Alert>{error}</Alert>
      {notice && (
        <p role="status" className="font-medium">
          {notice}
        </p>
      )}
    </>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-[var(--r)] border border-line-soft bg-card p-4 text-muted">{children}</p>
  );
}

function Faces() {
  const [faces, setFaces] = useState<PendingFace[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [reload, setReload] = useState(0);
  const { busy, error, notice, decide } = useDecide(
    (id) => setFaces((list) => list?.filter((f) => f.id !== id) ?? list),
    () => setReload((n) => n + 1),
  );

  useEffect(() => {
    let live = true;
    setLoadError('');
    getPendingFaces().then(
      (r) => live && setFaces(r.pending),
      (err: unknown) => live && setLoadError(errorMessage(err)),
    );
    return () => {
      live = false;
    };
  }, [reload]);

  if (loadError) return <Alert>{loadError}</Alert>;
  if (!faces) return <Loading />;

  return (
    <div className="flex flex-col gap-3">
      <Messages error={error} notice={notice} />
      {faces.length === 0 ? (
        <Empty>No face registrations waiting for approval.</Empty>
      ) : (
        <ul aria-label="Faces waiting for approval" className="flex flex-col gap-3">
          {faces.map((f) => (
            <li key={f.id} className={row}>
              <div className="flex min-w-0 items-center gap-3">
                <img
                  src={f.photo}
                  alt={f.name}
                  className="size-24 shrink-0 rounded-[calc(var(--r)*0.75)] border border-line-soft object-cover"
                />
                <div className="flex min-w-0 flex-col">
                  {f.own && (
                    <span className="font-mono text-[12px] uppercase tracking-widest text-muted">
                      Your registration
                    </span>
                  )}
                  <span className="break-words font-display text-[22px] font-extrabold uppercase leading-tight">
                    {f.name}
                  </span>
                  <span className="break-all text-sm text-muted">{f.email}</span>
                </div>
              </div>
              {!f.canDecide && (
                <p className="text-muted">
                  Another approver has to approve your registration. Ask a senior to open Approvals.
                </p>
              )}
              {f.canDecide && (
                <div className="flex gap-2">
                  <button
                    type="button"
                    className={approveButton}
                    disabled={busy !== null}
                    onClick={() =>
                      void decide(f.id, () => approveFace(f.id), `Approved ${f.name}.`)
                    }
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className={rejectButton}
                    disabled={busy !== null}
                    onClick={() => void decide(f.id, () => rejectFace(f.id), `Rejected ${f.name}.`)}
                  >
                    Reject
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const KIND_LABEL = { check_in: 'Check in', check_out: 'Check out' } as const;

function CheckIns() {
  const [data, setData] = useState<{ entries: PendingEntry[]; total: number } | null>(null);
  const [loadError, setLoadError] = useState('');
  const [reload, setReload] = useState(0);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const { busy, error, notice, decide } = useDecide(
    (id) => {
      // The last shown row went but more are waiting: fetch the next ones.
      if (data && data.entries.length === 1 && data.total > 1) setReload((n) => n + 1);
      setData((d) =>
        d ? { entries: d.entries.filter((e) => e.id !== id), total: Math.max(0, d.total - 1) } : d,
      );
    },
    () => setReload((n) => n + 1),
  );

  useEffect(() => {
    let live = true;
    setLoadError('');
    getPendingEntries().then(
      (r) => live && setData(r),
      (err: unknown) => live && setLoadError(errorMessage(err)),
    );
    return () => {
      live = false;
    };
  }, [reload]);

  if (loadError) return <Alert>{loadError}</Alert>;
  if (!data) return <Loading />;
  const { entries, total } = data;

  const noteOf = (id: string) => notes[id]?.trim() || undefined;

  return (
    <div className="flex flex-col gap-3">
      <Messages error={error} notice={notice} />
      {total > entries.length && (
        <p className="font-mono text-[12px] uppercase tracking-widest text-muted">
          {`Showing ${entries.length} of ${total}`}
        </p>
      )}
      {entries.length === 0 ? (
        <Empty>No check-ins waiting for approval.</Empty>
      ) : (
        <ul aria-label="Check-ins waiting for approval" className="flex flex-col gap-3">
          {entries.map((e) => (
            <li key={e.id} className={row}>
              <div className="flex flex-col">
                {e.own && (
                  <span className="font-mono text-[12px] uppercase tracking-widest text-muted">
                    Your check-in
                  </span>
                )}
                <span className="break-words font-display text-[22px] font-extrabold uppercase leading-tight">
                  {e.name}
                </span>
                <span className="text-sm text-muted">
                  {`${e.projectName} · ${KIND_LABEL[e.kind]} · ${timeOf(e.at)} · ${e.workDate}`}
                </span>
              </div>
              {e.reasons.length > 0 && (
                <ul aria-label="Reasons" className="list-disc pl-6 font-medium">
                  {e.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              )}
              {e.photos.length > 0 && (
                <div className="flex gap-2 overflow-x-auto">
                  {e.photos.map((src, i) => (
                    <img
                      key={i}
                      src={src}
                      alt={`${e.name}, photo ${i + 1}`}
                      className="size-24 shrink-0 rounded-[calc(var(--r)*0.75)] border border-line-soft object-cover"
                    />
                  ))}
                </div>
              )}
              <p className="text-sm">
                {`${Math.round(e.distanceM)} m from site (allowed ${e.radiusM} m) · ±${Math.round(e.accuracyM)} m`}
              </p>
              <p className="text-sm">
                {e.similarity === null
                  ? 'Match score —'
                  : `Match score ${(Math.floor(e.similarity * 100 + 1e-9) / 100).toFixed(2)}`}
              </p>
              {!e.canDecide && (
                <p className="text-muted">
                  Another approver has to decide your check-in. Ask a senior to open Approvals.
                </p>
              )}
              {e.canDecide && (
                <>
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor={`note-${e.id}`} className={labelClass}>
                      Note (optional)
                    </label>
                    <input
                      id={`note-${e.id}`}
                      maxLength={500}
                      value={notes[e.id] ?? ''}
                      onChange={(ev) => setNotes((n) => ({ ...n, [e.id]: ev.target.value }))}
                      className={inputClass}
                    />
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className={approveButton}
                      disabled={busy !== null}
                      onClick={() =>
                        void decide(
                          e.id,
                          () => approveEntry(e.id, noteOf(e.id)),
                          `Approved ${e.name}.`,
                        )
                      }
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      className={rejectButton}
                      disabled={busy !== null}
                      onClick={() =>
                        void decide(
                          e.id,
                          () => rejectEntry(e.id, noteOf(e.id)),
                          `Rejected ${e.name}.`,
                        )
                      }
                    >
                      Reject
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
