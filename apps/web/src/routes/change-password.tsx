import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { ApiError, api, errorMessage } from '../lib/api';
import { enterApp, fetchMe, signOut } from '../lib/auth';
import {
  Alert,
  Field,
  Loading,
  PageTitle,
  PrimaryButton,
  Screen,
  SecondaryButton,
} from '../components/ui';

export const CHECK_FIELDS = 'Check the highlighted fields.';
export const PASSWORDS_DIFFER = 'The passwords do not match.';

export const Route = createFileRoute('/change-password')({ component: ChangePassword });

/**
 * "Set a new password": shown after signing in with a temporary password
 * (the API refuses everything else until this is done). Also usable by any
 * signed-in user who wants to change their password.
 */
function ChangePassword() {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    let live = true;
    fetchMe().then(
      () => live && setReady(true),
      (err: unknown) => {
        if (!live) return;
        if (err instanceof ApiError && err.status === 401) {
          void navigate({ to: '/', replace: true });
          return;
        }
        setError(errorMessage(err));
        setReady(true);
      },
    );
    return () => {
      live = false;
    };
  }, [navigate]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const currentPassword = String(form.get('currentPassword') ?? '');
    const newPassword = String(form.get('newPassword') ?? '');
    const confirmPassword = String(form.get('confirmPassword') ?? '');
    setError('');
    setFieldErrors({});
    if (newPassword !== confirmPassword) {
      setError(CHECK_FIELDS);
      setFieldErrors({ confirmPassword: PASSWORDS_DIFFER });
      return;
    }
    setBusy(true);
    try {
      await api('/api/me/password', { company: null, body: { currentPassword, newPassword } });
      await navigate({ to: enterApp(await fetchMe()), replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        await navigate({ to: '/', replace: true });
        return;
      }
      setError(errorMessage(err));
      if (err instanceof ApiError && err.details) setFieldErrors(err.details);
    } finally {
      setBusy(false);
    }
  }

  async function onSignOut() {
    await signOut().catch(() => undefined);
    await navigate({ to: '/' });
  }

  const aside = <SecondaryButton onClick={() => void onSignOut()}>Sign out</SecondaryButton>;

  return (
    <Screen aside={aside}>
      <PageTitle>Set a new password</PageTitle>
      <p className="mt-2 text-muted">
        Your account has a temporary password. Choose your own to continue.
      </p>
      <div className="mt-6 flex flex-col gap-4">
        {!ready ? (
          <Loading />
        ) : (
          <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
            <Field
              id="currentPassword"
              label="Current password"
              type="password"
              required
              autoComplete="current-password"
              error={fieldErrors.currentPassword}
            />
            <Field
              id="newPassword"
              label="New password"
              type="password"
              required
              minLength={10}
              autoComplete="new-password"
              hint="At least 10 characters."
              error={fieldErrors.newPassword}
            />
            <Field
              id="confirmPassword"
              label="Confirm new password"
              type="password"
              required
              autoComplete="new-password"
              error={fieldErrors.confirmPassword}
            />
            <Alert>{error}</Alert>
            <PrimaryButton disabled={busy}>Save</PrimaryButton>
          </form>
        )}
      </div>
    </Screen>
  );
}
