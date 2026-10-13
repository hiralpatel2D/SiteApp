import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, createFileRoute } from '@tanstack/react-router';
import { authClient, authErrorMessage } from '../lib/auth';
import { Alert, Field, PageTitle, PrimaryButton, Screen, linkClass } from '../components/ui';

export const Route = createFileRoute('/reset-password')({
  validateSearch: (search: Record<string, unknown>): { token?: string } => ({
    token: typeof search.token === 'string' ? search.token : undefined,
  }),
  component: ResetPassword,
});

function ResetPassword() {
  const { token } = Route.useSearch();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fieldError, setFieldError] = useState<string>();
  const [done, setDone] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError('');
    setFieldError(undefined);
    try {
      const { error: authError } = await authClient.resetPassword({
        newPassword: String(form.get('password') ?? ''),
        token: token ?? '',
      });
      if (authError) {
        setError(authErrorMessage(authError));
        const details = (authError as { error?: { details?: Record<string, string> } }).error
          ?.details;
        setFieldError(details?.password ?? details?.token);
        return;
      }
      setDone(true);
    } catch {
      setError('The service is busy. Try again shortly.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <PageTitle>New password</PageTitle>
      <div className="mt-6 flex flex-col gap-4">
        {!token ? (
          <Alert>This link is invalid or has expired. Ask for a new one.</Alert>
        ) : done ? (
          <p role="status">Your password is changed. Sign in with your new password.</p>
        ) : (
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <Field
              id="password"
              label="New password"
              type="password"
              required
              minLength={10}
              autoComplete="new-password"
              hint="At least 10 characters."
              error={fieldError}
            />
            <Alert>{error}</Alert>
            <PrimaryButton disabled={busy}>Save password</PrimaryButton>
          </form>
        )}
        <Link to="/" className={`${linkClass} self-start`}>
          Go to sign in
        </Link>
      </div>
    </Screen>
  );
}
