import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { ApiError, api, errorMessage } from '../lib/api';
import { fetchMe, isPasswordChangeRequired, signOut, type Me } from '../lib/auth';
import { getActiveCompany, setActiveCompany } from '../lib/company';
import { Icon } from './icons';
import { ThemeSwitcher } from './ThemeSwitcher';
import { Alert, Loading, Logo, PageTitle, labelClass } from './ui';

export type CompanyContext = {
  company: { id: string; name: string; slug: string };
  role: { id: string; name: string; key: string | null };
  capabilities: string[];
};

type Shell = { me: Me; ctx: CompanyContext | null };

const ShellContext = createContext<Shell | null>(null);

/** The signed-in user and, on company pages, the active company. */
export function useShell(): Shell {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error('useShell outside AppShell');
  return shell;
}

/** True when the active company grants the capability. */
export function useCan(capability: string): boolean {
  return useShell().ctx?.capabilities.includes(capability) ?? false;
}

type Props = {
  /** Page heading; Home has its own (the project switcher). */
  title?: string;
  /** Company pages need an active company; Platform admin does not. */
  company?: boolean;
  children: ReactNode;
};

/**
 * Signed-in frame: a left menu (always open on wide screens, a sliding drawer
 * on phones) with the pages, theme and mode, and sign out. Loads the user and
 * company once and sends people where they belong when that fails.
 */
export function AppShell({ title, company = true, children }: Props) {
  const navigate = useNavigate();
  const [shell, setShell] = useState<Shell | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const path = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    let live = true;
    const go = (to: '/' | '/change-password' | '/companies') => {
      live = false;
      void navigate({ to, replace: true });
    };
    if (company && !getActiveCompany()) {
      go('/companies');
      return;
    }
    // Both at once; the company answer decides redirects when /api/me fails.
    void Promise.allSettled([
      fetchMe(),
      company ? api<CompanyContext>('/api/company/context') : Promise.resolve(null),
    ]).then(([meRes, ctxRes]) => {
      if (!live) return;
      if (meRes.status === 'fulfilled' && meRes.value.user.mustChangePassword) {
        return go('/change-password');
      }
      const err =
        ctxRes.status === 'rejected'
          ? ctxRes.reason
          : meRes.status === 'rejected'
            ? meRes.reason
            : undefined;
      if (err === undefined && meRes.status === 'fulfilled' && ctxRes.status === 'fulfilled') {
        setShell({ me: meRes.value, ctx: ctxRes.value });
        return;
      }
      if (err instanceof ApiError && err.status === 401) return go('/');
      // Checked before the generic 403 below, which would forget the company.
      if (isPasswordChangeRequired(err)) return go('/change-password');
      // Not a member any more, suspended, unknown or no company: choose again.
      if (
        company &&
        ctxRes.status === 'rejected' &&
        err instanceof ApiError &&
        [400, 403, 404].includes(err.status)
      ) {
        setActiveCompany(null);
        return go('/companies');
      }
      setError(errorMessage(err));
    });
    return () => {
      live = false;
    };
  }, [company, navigate]);

  // Close the drawer on navigation and on Escape.
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  async function onSignOut() {
    await signOut().catch(() => undefined);
    await navigate({ to: '/' });
  }

  return (
    <div className="min-h-dvh md:pl-[272px]">
      {/* Phone top bar */}
      <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-line bg-bg/95 px-4 py-3 backdrop-blur md:hidden">
        <button
          type="button"
          aria-label="Open menu"
          aria-expanded={open}
          aria-controls="app-menu"
          onClick={() => setOpen(true)}
          className="-ml-2 grid size-11 shrink-0 cursor-pointer place-items-center rounded-full text-text hover:bg-surface"
        >
          <svg
            viewBox="0 0 24 24"
            width="24"
            height="24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>
        <span className="min-w-0 truncate font-display text-[22px] font-extrabold uppercase leading-none">
          Site Diary
        </span>
      </header>

      {/* Backdrop (phones) */}
      <div
        aria-hidden="true"
        onClick={() => setOpen(false)}
        className={`fixed inset-0 z-30 bg-black/40 transition-opacity duration-300 motion-reduce:transition-none md:hidden ${
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      />

      <nav
        id="app-menu"
        aria-label="Main menu"
        className={`fixed inset-y-0 left-0 z-40 flex w-[272px] max-w-[85vw] flex-col gap-6 overflow-y-auto border-r border-line bg-card px-5 py-6 transition-[transform,visibility] duration-300 ease-(--spring) motion-reduce:transition-none md:visible md:translate-x-0 ${
          open ? 'visible translate-x-0' : 'invisible -translate-x-full'
        }`}
      >
        <div className="flex items-center gap-2.5">
          <Logo size="small" />
          <span className="font-display text-[22px] font-extrabold uppercase leading-none">
            Site Diary
          </span>
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
            className="ml-auto grid size-10 cursor-pointer place-items-center rounded-full text-muted hover:text-text md:hidden"
          >
            <svg
              viewBox="0 0 24 24"
              width="18"
              height="18"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        {shell && <MenuLinks shell={shell} />}

        <div className="flex flex-col gap-2 border-t border-line pt-5">
          <span className={labelClass}>Appearance</span>
          <ThemeSwitcher />
        </div>

        <div className="mt-auto flex flex-col gap-3 border-t border-line pt-5">
          {shell && (
            <p className="min-w-0 break-words text-sm text-muted">
              Signed in as <span className="text-text">{shell.me.user.email}</span>
            </p>
          )}
          <button
            type="button"
            onClick={() => void onSignOut()}
            className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-[calc(var(--r)*0.75)] border border-field-line bg-card px-4 font-medium text-text hover:border-accent"
          >
            Sign out
          </button>
        </div>
      </nav>

      <main className="mx-auto flex w-full max-w-[720px] flex-col gap-6 px-5 pb-10 pt-6 md:px-8 md:pt-10">
        {title && <PageTitle>{title}</PageTitle>}
        <Alert>{error}</Alert>
        {!shell && !error && <Loading />}
        {shell && (
          <ShellContext.Provider value={shell}>
            <div className="animate-[rise_.4s_var(--spring)_both] motion-reduce:animate-none">
              {children}
            </div>
          </ShellContext.Provider>
        )}
      </main>
    </div>
  );
}

const item =
  'flex min-h-11 items-center gap-3 rounded-[calc(var(--r)*0.75)] px-3 font-medium text-text hover:bg-surface aria-[current=page]:bg-surface aria-[current=page]:font-semibold aria-[current=page]:shadow-[inset_3px_0_0_var(--accent)]';

function MenuLinks({ shell }: { shell: Shell }) {
  const { me, ctx } = shell;
  const can = (cap: string) => ctx?.capabilities.includes(cap) ?? false;
  const otherCompanies = ctx ? me.memberships.length > 1 : me.memberships.length > 0;
  return (
    <div className="flex flex-col gap-1">
      {ctx && (
        <div className="mb-3 flex flex-col gap-0.5 rounded-[calc(var(--r)*0.75)] bg-surface px-3 py-2.5">
          <span className="min-w-0 break-words font-display text-[18px] font-bold uppercase leading-tight">
            {ctx.company.name}
          </span>
          <span className="text-sm text-muted">{ctx.role.name}</span>
        </div>
      )}
      {ctx && (
        <Link to="/home" className={item}>
          <Icon name="home" />
          Home
        </Link>
      )}
      {can('projects.view') && (
        <Link to="/projects" className={item}>
          <Icon name="pin" />
          Projects
        </Link>
      )}
      {can('users.view') && (
        <Link to="/team" className={item}>
          <Icon name="users" />
          Team
        </Link>
      )}
      {me.user.isPlatformAdmin && (
        <Link to="/platform" className={item}>
          <Icon name="building" />
          Platform admin
        </Link>
      )}
      {otherCompanies && (
        <Link to="/companies" className={item}>
          <Icon name="swap" />
          {ctx ? 'Switch company' : 'Your companies'}
        </Link>
      )}
    </div>
  );
}
