import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { authClient, authErrorMessage } from '../lib/auth';
import { Alert, Field, PageTitle, PrimaryButton, Screen, linkClass } from '../components/ui';

export const Route = createFileRoute('/setup')({ component: OwnerSetup });

/**
 * One-time owner account creation. The API only accepts emails listed in
 * PLATFORM_ADMIN_EMAILS here; everyone else joins through an invite link.
 */
function OwnerSetup() {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError('');
    setFieldErrors({});
    try {
      const { error: authError } = await authClient.signUp.email({
        name: String(form.get('name') ?? '').trim(),
        email: String(form.get('email') ?? '').trim(),
        password: String(form.get('password') ?? ''),
      });
      if (authError) {
        setError(authErrorMessage(authError));
        const details = (authError as { error?: { details?: Record<string, string> } }).error
          ?.details;
        setFieldErrors(details ?? {});
        return;
      }
      await navigate({ to: '/platform' });
    } catch {
      setError('The service is busy. Try again shortly.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <PageTitle>Create owner account</PageTitle>
      <p className="mt-2 text-muted">
        For the Site Diary owner only. Everyone else joins through an invite link from their
        company.
      </p>
      <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4">
        <Field id="name" label="Your name" required autoComplete="name" error={fieldErrors.name} />
        <Field
          id="email"
          label="Email"
          type="email"
          required
          autoComplete="email"
          error={fieldErrors.email}
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
        <PrimaryButton disabled={busy}>Create account</PrimaryButton>
      </form>
      <Link to="/" className={`${linkClass} mt-4 self-start`}>
        Already have an account? Sign in
      </Link>
    </Screen>
  );
}
