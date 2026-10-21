import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, createFileRoute } from '@tanstack/react-router';
import { errorMessage } from '../lib/api';
import { getMyFace, registerFace, type FaceStatus } from '../lib/attendance';
import { AppShell } from '../components/AppShell';
import { Alert, Loading, primaryButton, secondaryButton } from '../components/ui';
import { FaceCapture } from '../attendance/FaceCapture';

export const Route = createFileRoute('/attendance_/register')({ component: RegisterFace });

const CONSENT =
  "Site Diary stores a numeric face code (not your photo) to confirm it's you at check-in. A senior approves it once. You can delete it any time from this page.";
const SENT = 'Sent for approval. Ask your senior to approve it now.';

const card = 'flex flex-col gap-3 rounded-[var(--r)] border border-line-soft bg-card p-4';

function RegisterFace() {
  return (
    <AppShell title="Register your face">
      <RegisterBody />
    </AppShell>
  );
}

type Step =
  | { kind: 'consent' }
  | { kind: 'camera' }
  | { kind: 'sending' }
  | { kind: 'done' }
  | { kind: 'failed'; message: string };

function RegisterBody() {
  const [face, setFace] = useState<FaceStatus | null>(null);
  const [loadError, setLoadError] = useState('');
  const [step, setStep] = useState<Step>({ kind: 'consent' });

  useEffect(() => {
    let live = true;
    getMyFace().then(
      (r) => live && setFace(r.status),
      (err: unknown) => live && setLoadError(errorMessage(err)),
    );
    return () => {
      live = false;
    };
  }, []);

  async function send(frames: string[]) {
    setStep({ kind: 'sending' });
    try {
      await registerFace(frames);
      setFace('pending');
      setStep({ kind: 'done' });
    } catch (err) {
      setStep({ kind: 'failed', message: errorMessage(err) });
    }
  }

  if (loadError) return <Alert>{loadError}</Alert>;
  if (face === null) return <Loading />;

  if (step.kind === 'done') {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex flex-col items-center gap-3 rounded-[var(--r)] border border-line bg-card p-6 text-center">
          <p className="font-display text-[28px] font-extrabold uppercase leading-tight">{SENT}</p>
        </div>
        <BackToAttendance />
      </div>
    );
  }
  if (face === 'approved') {
    return (
      <Card>
        <p className="font-medium">Your face is registered. You can check in.</p>
        <BackToAttendance />
      </Card>
    );
  }
  if (face === 'pending') {
    return (
      <Card>
        <p className="font-medium">Your face registration is waiting for approval by a senior.</p>
        <BackToAttendance />
      </Card>
    );
  }
  if (step.kind === 'camera') {
    return (
      <FaceCapture
        onCaptured={(frames) => void send(frames)}
        onError={(message) => setStep({ kind: 'failed', message })}
        onCancel={() => setStep({ kind: 'consent' })}
      />
    );
  }
  if (step.kind === 'sending') return <Loading>Sending…</Loading>;
  if (step.kind === 'failed') {
    return (
      <Card>
        <p role="alert" className="font-medium">
          {step.message}
        </p>
        <button type="button" className={primaryButton} onClick={() => setStep({ kind: 'camera' })}>
          Try again
        </button>
        <button
          type="button"
          className={secondaryButton}
          onClick={() => setStep({ kind: 'consent' })}
        >
          Back
        </button>
      </Card>
    );
  }
  return (
    <Card>
      {face === 'rejected' && (
        <p className="font-medium">Your last registration was not approved. Register again.</p>
      )}
      <p className="text-[17px]">{CONSENT}</p>
      <p className="text-muted">
        You will blink, turn your head left, then right, then look straight at the camera.
      </p>
      <button type="button" className={primaryButton} onClick={() => setStep({ kind: 'camera' })}>
        I agree
      </button>
    </Card>
  );
}

function Card({ children }: { children: ReactNode }) {
  return <div className={card}>{children}</div>;
}

function BackToAttendance() {
  return (
    <Link to="/attendance" className={`${secondaryButton} w-full`}>
      Back to attendance
    </Link>
  );
}
