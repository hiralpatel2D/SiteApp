import { useState } from 'react';
import type { FormEvent } from 'react';
import { ThemeSwitcher } from './ThemeSwitcher';

const input =
  'w-full min-w-0 border border-line bg-card px-3 py-3 text-text outline-none focus:border-accent focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_20%,transparent)]';
const label = 'font-mono text-[11px] font-medium uppercase tracking-widest text-muted';

export function SignIn() {
  const [submitted, setSubmitted] = useState(false);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[480px] flex-col px-6 pb-8 pt-11">
      <div
        aria-hidden="true"
        className="mb-5 grid size-[46px] place-items-center rounded-[calc(var(--r)*0.75)] bg-accent text-on-accent"
      >
        <svg
          viewBox="0 0 24 24"
          width="22"
          height="22"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2z" />
          <path d="M9 8h5M9 12h5M9 16h3" />
        </svg>
      </div>
      <h1 className="font-display text-[44px] font-extrabold uppercase leading-none tracking-[0.01em]">
        Site Diary
      </h1>
      <p className="mb-8 mt-2.5 text-muted">Every site, every day, on record.</p>

      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="workspace" className={label}>
            Company workspace (optional)
          </label>
          <div className="flex items-stretch">
            <input
              id="workspace"
              name="workspace"
              autoComplete="organization"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="your-company"
              className={`${input} rounded-l-[calc(var(--r)*0.75)]`}
            />
            <span className="grid shrink-0 place-items-center rounded-r-[calc(var(--r)*0.75)] border border-l-0 border-line bg-card px-2.5 font-mono text-[11px] text-muted">
              .sitediary.app
            </span>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="email" className={label}>
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            className={`${input} rounded-[calc(var(--r)*0.75)]`}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="password" className={label}>
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            className={`${input} rounded-[calc(var(--r)*0.75)]`}
          />
        </div>
        <button
          type="submit"
          className="h-[50px] w-full cursor-pointer whitespace-nowrap rounded-[calc(var(--r)*0.875)] bg-accent font-display text-[19px] font-extrabold uppercase tracking-[0.03em] text-on-accent transition-transform duration-300 ease-(--spring) hover:brightness-105 active:scale-[0.97]"
        >
          Sign in
        </button>
        <p role="status" className="min-h-5 text-muted">
          {submitted ? 'Sign-in is switched on in the next release.' : ''}
        </p>
      </form>

      <footer className="mt-auto flex flex-col gap-4 pt-6">
        <ThemeSwitcher />
        <p className="text-xs text-muted">
          Each company gets its own workspace and its data is never shared with another company.
        </p>
      </footer>
    </main>
  );
}
