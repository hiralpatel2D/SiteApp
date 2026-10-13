import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

// Shared pieces for the Plan 2 flows, matching the sign-in screen (tokens only).

export const inputClass =
  'w-full min-w-0 rounded-[calc(var(--r)*0.75)] border border-field-line bg-card px-3 py-3 text-text outline-none focus:border-accent focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_20%,transparent)] read-only:bg-surface';
export const labelClass = 'font-mono text-[11px] font-medium uppercase tracking-widest text-muted';

/** Accent fill: large bold text only (brand contrast rule). */
export const primaryButton =
  'h-[50px] w-full cursor-pointer whitespace-nowrap rounded-[calc(var(--r)*0.875)] bg-accent px-4 font-display text-[19px] font-extrabold uppercase tracking-[0.03em] text-on-accent transition-transform duration-300 ease-(--spring) hover:brightness-105 active:scale-[0.97] disabled:cursor-default disabled:opacity-60 disabled:active:scale-100';

/** Outline button on the card colour; any text size is fine here. */
export const secondaryButton =
  'inline-flex min-h-11 shrink-0 cursor-pointer items-center justify-center whitespace-nowrap rounded-[calc(var(--r)*0.75)] border border-field-line bg-card px-4 font-medium text-text hover:border-accent disabled:cursor-default disabled:opacity-60';

export const linkClass = 'font-medium text-text underline underline-offset-4 hover:text-accent';

export function Logo({ size = 'large' }: { size?: 'large' | 'small' }) {
  const box = size === 'large' ? 'size-[46px]' : 'size-9';
  const icon = size === 'large' ? 22 : 18;
  return (
    <div
      aria-hidden="true"
      className={`grid ${box} shrink-0 place-items-center rounded-[calc(var(--r)*0.75)] bg-accent text-on-accent`}
    >
      <svg
        viewBox="0 0 24 24"
        width={icon}
        height={icon}
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
  );
}

/** Page frame for the signed-in and invite screens: brand bar, then content. */
export function Screen({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[560px] flex-col px-6 pb-8 pt-8">
      <header className="mb-8 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <Logo size="small" />
          <span className="font-display text-[22px] font-extrabold uppercase leading-none tracking-[0.01em]">
            Site Diary
          </span>
        </div>
        {aside}
      </header>
      {children}
    </main>
  );
}

export function PageTitle({ children }: { children: ReactNode }) {
  return (
    <h1 className="break-words font-display text-[34px] font-extrabold uppercase leading-none tracking-[0.01em]">
      {children}
    </h1>
  );
}

type FieldProps = InputHTMLAttributes<HTMLInputElement> & {
  id: string;
  label: string;
  hint?: string;
  error?: string;
};

/** Labelled input; a field error is announced and linked by aria-describedby. */
export function Field({ id, label, hint, error, ...input }: FieldProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      <input
        id={id}
        name={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={inputClass}
        {...input}
      />
      {hint && (
        <p id={hintId} className="text-xs text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-sm font-medium text-text">
          {error}
        </p>
      )}
    </div>
  );
}

/** Error message box (catalogue copy). Renders nothing without a message. */
export function Alert({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return (
    <p
      role="alert"
      className="rounded-[calc(var(--r)*0.75)] border border-field-line border-l-4 border-l-accent bg-card px-3 py-2.5 text-text"
    >
      {children}
    </p>
  );
}

export function Loading({ children = 'Loading…' }: { children?: ReactNode }) {
  return (
    <p role="status" className="text-muted">
      {children}
    </p>
  );
}

export function PrimaryButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="submit" {...props} className={primaryButton} />;
}

export function SecondaryButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...props} className={secondaryButton} />;
}
