import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { ApiError, api, errorMessage } from '../lib/api';
import { isPasswordChangeRequired } from '../lib/auth';
import { AppShell, useShell } from '../components/AppShell';
import { InviteLink } from '../components/InviteLink';
import { Alert, Field, Loading, PrimaryButton, SecondaryButton } from '../components/ui';

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
  return (
    <AppShell title="Platform admin" company={false}>
      <PlatformBody />
    </AppShell>
  );
}

function PlatformBody() {
  const navigate = useNavigate();
  const { me } = useShell();
  const [loaded, setLoaded] = useState(false);
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
    if (!me.user.isPlatformAdmin) return;
    let live = true;
    void load().then(() => live && setLoaded(true));
    return () => {
      live = false;
    };
  }, [load, me.user.isPlatformAdmin]);

  if (!me.user.isPlatformAdmin) return <Alert>{FORBIDDEN}</Alert>;
  if (!loaded) return <Loading />;
  return (
    <div className="flex flex-col gap-8">
      <CreateCompany onCreated={load} />
      <section aria-labelledby="companies-heading" className="flex flex-col gap-3">
        <h2
          id="companies-heading"
          className="font-display text-[24px] font-extrabold uppercase leading-none"
        >
          Companies
        </h2>
        <Alert>{listError}</Alert>
        {companies.length === 0 && !listError && <p className="text-muted">No companies yet.</p>}
        <ul className="flex flex-col gap-3">
          {companies.map((c) => (
            <CompanyRow key={c.id} company={c} onChanged={load} />
          ))}
        </ul>
      </section>
    </div>
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
      {created && (
        <InviteLink
          url={created.inviteUrl}
          shareText={`You're invited to run ${created.company.name} on Site Diary. Open this link to join:`}
        >
          <p>
            <strong className="font-semibold">{created.company.name}</strong> is ready. Send this
            link to their Super Admin. It works for 7 days.
          </p>
        </InviteLink>
      )}
    </section>
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
