import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { authClient, authErrorMessage, enterApp, fetchMe } from '../lib/auth';
import { errorMessage } from '../lib/api';
import { Alert, Loading, Logo, linkClass, primaryButton } from './ui';

const input =
  'w-full min-w-0 border border-field-line bg-card px-3 py-3 text-text outline-none focus:border-accent focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_20%,transparent)]';
const label = 'font-mono text-[11px] font-medium uppercase tracking-widest text-muted';

export const RESET_SENT = 'If that email has an account, a reset link is on its way.';

export function SignIn() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<'sign-in' | 'forgot'>('sign-in');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [resetSent, setResetSent] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  // Already signed in: skip the form and open the app. Any failure shows the form.
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let live = true;
    fetchMe()
      .then((me) => {
        if (live) void navigate({ to: enterApp(me), replace: true });
      })
      .catch(() => {
        if (live) setChecking(false);
      });
    return () => {
      live = false;
    };
  }, [navigate]);

  async function onSignIn(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError('');
    try {
      const { error: authError } = await authClient.signIn.email({
        email: String(form.get('email') ?? ''),
        password: String(form.get('password') ?? ''),
      });
      if (authError) {
        setError(authErrorMessage(authError));
        return;
      }
      await navigate({ to: enterApp(await fetchMe()) });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function onForgot(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    try {
      // The answer is the same whether or not the email has an account.
      await authClient.requestPasswordReset({ email: String(form.get('reset-email') ?? '') });
    } catch {
      // Same message either way: never reveal whether an account exists.
    } finally {
      setBusy(false);
      setResetSent(true);
    }
  }

  function switchMode(next: 'sign-in' | 'forgot') {
    setMode(next);
    setError('');
    setResetSent(false);
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[480px] flex-col px-6 pb-8 pt-11">
      <div className="mb-5">
        <Logo />
      </div>
      <h1 className="font-display text-[44px] font-extrabold uppercase leading-none tracking-[0.01em]">
        Site Diary
      </h1>
      <p className="mb-8 mt-2.5 text-muted">Every site, every day, on record.</p>

      {checking ? (
        <Loading />
      ) : mode === 'sign-in' ? (
        <form onSubmit={onSignIn} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="email" className={label}>
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              className={`${input} rounded-[calc(var(--r)*0.75)]`}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="password" className={label}>
              Password
            </label>
            <div className="relative">
              <input
                id="password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                required
                autoComplete="current-password"
                className={`${input} rounded-[calc(var(--r)*0.75)] pr-12`}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                aria-pressed={showPassword}
                className="absolute inset-y-0 right-0 grid w-12 cursor-pointer place-items-center text-muted hover:text-text"
              >
                <svg
                  viewBox="0 0 24 24"
                  width="20"
                  height="20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
                  <circle cx="12" cy="12" r="3" />
                  {showPassword && <path d="M4 4l16 16" />}
                </svg>
              </button>
            </div>
          </div>
          <Alert>{error}</Alert>
          <button type="submit" disabled={busy} className={primaryButton}>
            Sign in
          </button>
          <button
            type="button"
            onClick={() => switchMode('forgot')}
            className={`${linkClass} cursor-pointer self-start`}
          >
            Forgot password?
          </button>
        </form>
      ) : (
        <form onSubmit={onForgot} className="flex flex-col gap-4">
          <p className="text-muted">
            Enter your email and we will send you a link to set a new password.
          </p>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="reset-email" className={label}>
              Email
            </label>
            <input
              id="reset-email"
              name="reset-email"
              type="email"
              required
              autoComplete="email"
              className={`${input} rounded-[calc(var(--r)*0.75)]`}
            />
          </div>
          <p role="status" className="min-h-5 text-text">
            {resetSent ? RESET_SENT : ''}
          </p>
          <button type="submit" disabled={busy} className={primaryButton}>
            Send reset link
          </button>
          <button
            type="button"
            onClick={() => switchMode('sign-in')}
            className={`${linkClass} cursor-pointer self-start`}
          >
            Back to sign in
          </button>
        </form>
      )}

      <footer className="mt-auto flex flex-col gap-4 pt-6">
        <p className="text-xs text-muted">
          Each company's data is kept separate and never shared with another company.
        </p>
      </footer>
    </main>
  );
}
