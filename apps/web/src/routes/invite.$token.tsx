import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { ApiError, api, errorMessage } from '../lib/api';
import { authClient, authErrorMessage, fetchMe, signOut, type Me } from '../lib/auth';
import { setActiveCompany } from '../lib/company';
import {
  Alert,
  Field,
  Loading,
  PrimaryButton,
  Screen,
  SecondaryButton,
  linkClass,
} from '../components/ui';

type Preview = {
  companyName: string;
  email: string;
  roleName: string;
  expiresAt: string;
  hasAccount: boolean;
};

export const Route = createFileRoute('/invite/$token')({ component: Invite });

const dateFormat = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

function Invite() {
  const { token } = Route.useParams();
  const navigate = useNavigate();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    const path = `/api/invitations/by-token/${encodeURIComponent(token)}`;
    Promise.all([api<Preview>(path, { company: null }), fetchMe().catch(() => null)]).then(
      ([p, m]) => {
        if (!live) return;
        setPreview(p);
        setMe(m);
      },
      (err: unknown) => live && setLoadError(errorMessage(err)),
    );
    return () => {
      live = false;
    };
  }, [token]);

  async function accept(body?: { name: string; password: string }) {
    const res = await api<{ companyId: string }>(
      `/api/invitations/by-token/${encodeURIComponent(token)}/accept`,
      { method: 'POST', body: body ?? {}, company: null },
    );
    setActiveCompany(res.companyId);
    await navigate({ to: '/home' });
  }

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    setFieldErrors({});
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
      if (err instanceof ApiError && err.details) setFieldErrors(err.details);
    } finally {
      setBusy(false);
    }
  }

  function onCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    void run(() =>
      accept({
        name: String(form.get('name') ?? ''),
        password: String(form.get('password') ?? ''),
      }),
    );
  }

  function onSignInAndAccept(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    void run(async () => {
      const { error: authError } = await authClient.signIn.email({
        email: preview!.email,
        password: String(form.get('password') ?? ''),
      });
      if (authError) throw new ApiError(401, 'sign_in_failed', authErrorMessage(authError));
      await accept();
    });
  }

  async function onSignOut() {
    await signOut().catch(() => undefined);
    setMe(null);
    setError('');
  }

  if (loadError) {
    return (
      <Screen>
        <div className="flex flex-col gap-5">
          <Alert>{loadError}</Alert>
          <Link to="/" className={`${linkClass} self-start`}>
            Go to sign in
          </Link>
        </div>
      </Screen>
    );
  }
  if (!preview) {
    return (
      <Screen>
        <Loading />
      </Screen>
    );
  }

  return (
    <Screen>
      <h1 className="break-words text-[24px] leading-snug">
        Join <strong className="font-semibold">{preview.companyName}</strong> as{' '}
        <strong className="font-semibold">{preview.roleName}</strong>
      </h1>
      <p className="mb-6 mt-2 break-words text-muted">
        Invitation for {preview.email}. It works until{' '}
        {dateFormat.format(new Date(preview.expiresAt))}.
      </p>

      {me ? (
        <div className="flex flex-col gap-4">
          <p className="break-words">Signed in as {me.user.email}.</p>
          <Alert>{error}</Alert>
          <PrimaryButton type="button" disabled={busy} onClick={() => void run(() => accept())}>
            Accept
          </PrimaryButton>
          <SecondaryButton onClick={() => void onSignOut()}>Sign out</SecondaryButton>
        </div>
      ) : preview.hasAccount ? (
        <form onSubmit={onSignInAndAccept} className="flex flex-col gap-4">
          <p>You already have a Site Diary account. Sign in to accept.</p>
          <Field id="email" label="Email" value={preview.email} readOnly type="email" />
          <Field
            id="password"
            label="Password"
            type="password"
            required
            autoComplete="current-password"
          />
          <Alert>{error}</Alert>
          <PrimaryButton disabled={busy}>Sign in and join</PrimaryButton>
        </form>
      ) : (
        <form onSubmit={onCreate} className="flex flex-col gap-4">
          <Field id="email" label="Email" value={preview.email} readOnly type="email" />
          <Field
            id="name"
            label="Your name"
            required
            autoComplete="name"
            error={fieldErrors.name}
          />
          <Field
            id="password"
            label="Choose a password"
            type="password"
            required
            minLength={10}
            autoComplete="new-password"
            hint="At least 10 characters."
            error={fieldErrors.password}
          />
          <Alert>{error}</Alert>
          <PrimaryButton disabled={busy}>Join</PrimaryButton>
        </form>
      )}
    </Screen>
  );
}
