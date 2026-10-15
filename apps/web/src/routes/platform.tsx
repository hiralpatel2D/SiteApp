import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { ApiError, api, errorMessage } from '../lib/api';
import { fetchMe, isPasswordChangeRequired, signOut } from '../lib/auth';
import {
  Alert,
  Field,
  Loading,
  PageTitle,
  PrimaryButton,
  Screen,
  SecondaryButton,
  labelClass,
} from '../components/ui';

type Company = {
  id: string;
  name: string;
  slug: string;
  status: string;
  memberCount: number;
};

type Created = { company: { id: string; name: string; slug: string }; inviteUrl: string };

const FORBIDDEN = 'You do not have permission to do this.';

export const Route = createFileRoute('/platform')({ component: Platform });

function Platform() {
  const navigate = useNavigate();
  const [state, setState] = useState<'loading' | 'ready' | 'forbidden'>('loading');
  const [companies, setCompanies] = useState<Company[]>([]);
  const [listError, setListError] = useState('');

  const load = useCallback(async () => {
    try {
      setCompanies(await api<Company[]>('/api/platform/companies', { company: null }));
      setListError('');
    } catch (err) {
      if (isPasswordChangeRequired(err)) {
        void navigate({ to: '/change-password', replace: true });
        return;
      }
      setListError(errorMessage(err));
    }
  }, [navigate]);

  useEffect(() => {
    let live = true;
    fetchMe().then(
      async (me) => {
        if (!live) return;
        if (me.user.mustChangePassword) {
          void navigate({ to: '/change-password', replace: true });
          return;
        }
        if (!me.user.isPlatformAdmin) {
          setState('forbidden');
          return;
        }
        await load();
        if (live) setState('ready');
      },
      (err: unknown) => {
        if (!live) return;
        if (err instanceof ApiError && err.status === 401) {
          void navigate({ to: '/', replace: true });
          return;
        }
        setListError(errorMessage(err));
        setState('ready');
      },
    );
    return () => {
      live = false;
    };
  }, [load, navigate]);

  async function onSignOut() {
    await signOut().catch(() => undefined);
    await navigate({ to: '/' });
  }

  const aside = <SecondaryButton onClick={() => void onSignOut()}>Sign out</SecondaryButton>;

  return (
    <Screen aside={aside}>
      <PageTitle>Platform admin</PageTitle>
      <div className="mt-6 flex flex-col gap-8">
        {state === 'loading' && <Loading />}
        {state === 'forbidden' && <Alert>{FORBIDDEN}</Alert>}
        {state === 'ready' && (
          <>
            <CreateCompany onCreated={load} />
            <section aria-labelledby="companies-heading" className="flex flex-col gap-3">
              <h2
                id="companies-heading"
                className="font-display text-[24px] font-extrabold uppercase leading-none"
              >
                Companies
              </h2>
              <Alert>{listError}</Alert>
              {companies.length === 0 && !listError && (
                <p className="text-muted">No companies yet.</p>
              )}
              <ul className="flex flex-col gap-3">
                {companies.map((c) => (
                  <CompanyRow key={c.id} company={c} onChanged={load} />
                ))}
              </ul>
            </section>
          </>
        )}
      </div>
    </Screen>
  );
}

function CreateCompany({ onCreated }: { onCreated: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [created, setCreated] = useState<Created | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    setBusy(true);
    setError('');
    setFieldErrors({});
    try {
      const res = await api<Created>('/api/platform/companies', {
        company: null,
        body: {
          name: String(form.get('name') ?? ''),
          slug: String(form.get('slug') ?? ''),
          adminEmail: String(form.get('adminEmail') ?? ''),
        },
      });
      setCreated(res);
      formEl.reset();
      await onCreated();
    } catch (err) {
      setError(errorMessage(err));
      if (err instanceof ApiError) {
        if (err.details) setFieldErrors(err.details);
        else if (err.code === 'slug_taken') setFieldErrors({ slug: err.message });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="create-heading" className="flex flex-col gap-4">
      <h2
        id="create-heading"
        className="font-display text-[24px] font-extrabold uppercase leading-none"
      >
        New company
      </h2>
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <Field
          id="name"
          label="Company name"
          required
          autoComplete="off"
          error={fieldErrors.name}
        />
        <Field
          id="slug"
          label="Workspace name"
          required
          autoCapitalize="none"
          spellCheck={false}
          autoComplete="off"
          hint="Lowercase letters, numbers and hyphens, e.g. mehta-infra."
          error={fieldErrors.slug}
        />
        <Field
          id="adminEmail"
          label="Super Admin email"
          type="email"
          required
          autoComplete="off"
          error={fieldErrors.adminEmail}
        />
        <Alert>{error}</Alert>
        <PrimaryButton disabled={busy}>Create company</PrimaryButton>
      </form>
      {created && <InviteLink created={created} />}
    </section>
  );
}

function InviteLink({ created }: { created: Created }) {
  const linkRef = useRef<HTMLParagraphElement>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'manual'>('idle');

  function selectLink() {
    const el = linkRef.current;
    const sel = window.getSelection();
    if (!el || !sel) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  async function copy() {
    try {
      if (!navigator.clipboard) throw new Error('no clipboard');
      await navigator.clipboard.writeText(created.inviteUrl);
      setCopyState('copied');
    } catch {
      // No clipboard access: select the text so it can be copied by hand.
      selectLink();
      setCopyState('manual');
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-[var(--r)] border border-line bg-card px-4 py-4">
      <p className="break-words">
        <strong className="font-semibold">{created.company.name}</strong> is ready. Send this link
        to their Super Admin. It works for 7 days.
      </p>
      <span className={labelClass}>Invite link</span>
      <p
        ref={linkRef}
        data-testid="invite-link"
        className="select-all break-all rounded-[calc(var(--r)*0.75)] border border-field-line bg-surface px-3 py-2.5 font-mono text-[13px]"
      >
        {created.inviteUrl}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <SecondaryButton onClick={() => void copy()}>Copy link</SecondaryButton>
        <span role="status" className="text-muted">
          {copyState === 'copied'
            ? 'Link copied.'
            : copyState === 'manual'
              ? 'Link selected. Copy it from your device menu.'
              : ''}
        </span>
      </div>
    </div>
  );
}

function CompanyRow({ company, onChanged }: { company: Company; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const suspended = company.status === 'suspended';
  const action = suspended ? 'Reactivate' : 'Suspend';

  async function toggle() {
    setBusy(true);
    setError('');
    try {
      await api(`/api/platform/companies/${company.id}/${suspended ? 'reactivate' : 'suspend'}`, {
        method: 'POST',
        company: null,
      });
      await onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-col gap-2 rounded-[var(--r)] border border-line bg-card px-4 py-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="break-words font-display text-[20px] font-bold uppercase leading-tight">
            {company.name}
          </span>
          <span className="break-all font-mono text-[12px] text-muted">{company.slug}</span>
          <span className="text-muted">
            {suspended ? 'Suspended' : 'Active'} ·{' '}
            {company.memberCount === 1 ? '1 member' : `${company.memberCount} members`}
          </span>
        </div>
        <SecondaryButton
          disabled={busy}
          aria-label={`${action} ${company.name}`}
          onClick={() => void toggle()}
        >
          {action}
        </SecondaryButton>
      </div>
      <Alert>{error}</Alert>
    </li>
  );
}
