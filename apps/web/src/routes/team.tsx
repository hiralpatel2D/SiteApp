import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { ApiError, api, errorMessage } from '../lib/api';
import { AppShell, useCan, useShell } from '../components/AppShell';
import { InviteLink } from '../components/InviteLink';
import {
  Alert,
  Field,
  Loading,
  PrimaryButton,
  inputClass,
  labelClass,
  secondaryButton,
} from '../components/ui';

export const Route = createFileRoute('/team')({ component: Team });

type Member = {
  membershipId: string;
  name: string;
  email: string;
  roleId: string;
  roleName: string;
  status: string;
};

type Role = { id: string; name: string; key: string | null };

type Invitation = {
  id: string;
  email: string;
  roleName: string;
  expiresAt: string;
};

type Created = { id: string; email: string; roleName: string; inviteUrl: string };

const heading = 'font-display text-[24px] font-extrabold uppercase leading-none';
const row =
  'flex min-w-0 items-center justify-between gap-3 rounded-[var(--r)] border border-line bg-card px-4 py-3';

function Team() {
  return (
    <AppShell title="Team">
      <TeamBody />
    </AppShell>
  );
}

function TeamBody() {
  const canView = useCan('users.view');
  const canManage = useCan('users.manage');
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invites, setInvites] = useState<Invitation[]>([]);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [m, i] = await Promise.all([
        api<Member[]>('/api/users'),
        api<{ invitations: Invitation[] }>('/api/invitations'),
      ]);
      setMembers(m);
      setInvites(i.invitations);
      setError('');
    } catch (err) {
      setError(errorMessage(err));
      setMembers((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    if (canView) void load();
  }, [canView, load]);

  if (!canView) return <Alert>You do not have permission to do this.</Alert>;

  return (
    <div className="flex flex-col gap-8">
      {canManage && <InviteForm onInvited={load} />}

      <Alert>{error}</Alert>

      {invites.length > 0 && (
        <section aria-labelledby="pending-heading" className="flex flex-col gap-3">
          <h2 id="pending-heading" className={heading}>
            Waiting to join
          </h2>
          <ul className="flex flex-col gap-2">
            {invites.map((i) => (
              <PendingRow key={i.id} invite={i} canManage={canManage} onChanged={load} />
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="members-heading" className="flex flex-col gap-3">
        <h2 id="members-heading" className={heading}>
          Members
        </h2>
        {!members && <Loading />}
        {members && members.length === 0 && !error && <p className="text-muted">No members yet.</p>}
        <ul className="flex flex-col gap-2">
          {members?.map((m) => (
            <li key={m.membershipId} className={row}>
              <div className="flex min-w-0 flex-col">
                <span className="break-words font-medium">{m.name}</span>
                <span className="break-all text-sm text-muted">{m.email}</span>
              </div>
              <div className="flex shrink-0 flex-col items-end text-right">
                <span className="text-sm font-medium">{m.roleName}</span>
                {m.status !== 'active' && (
                  <span className="text-sm text-muted">
                    {m.status === 'suspended' ? 'Suspended' : m.status}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function InviteForm({ onInvited }: { onInvited: () => Promise<void> }) {
  const { ctx } = useShell();
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [rolesError, setRolesError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [created, setCreated] = useState<Created | null>(null);

  useEffect(() => {
    api<Role[]>('/api/roles').then(
      (r) => setRoles([...r].sort((a, b) => a.name.localeCompare(b.name))),
      (err: unknown) => {
        setRoles([]);
        setRolesError(errorMessage(err));
      },
    );
  }, []);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    const roleId = String(form.get('roleId') ?? '');
    setError('');
    setFieldErrors({});
    if (!roleId) {
      setFieldErrors({ roleId: 'Choose a role.' });
      return;
    }
    setBusy(true);
    try {
      const res = await api<Created>('/api/invitations', {
        body: { email: String(form.get('email') ?? ''), roleId },
      });
      setCreated(res);
      formEl.reset();
      await onInvited();
    } catch (err) {
      setError(errorMessage(err));
      if (err instanceof ApiError && err.details) setFieldErrors(err.details);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="invite-heading" className="flex flex-col gap-4">
      <h2 id="invite-heading" className={heading}>
        Invite someone
      </h2>
      <p className="text-muted">
        They get a link, open it, and set their own password. Nobody can join without one.
      </p>
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <Field
          id="email"
          label="Their email"
          type="email"
          required
          autoComplete="off"
          error={fieldErrors.email}
        />
        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor="roleId" className={labelClass}>
            Role
          </label>
          <select
            id="roleId"
            name="roleId"
            defaultValue=""
            disabled={!roles}
            aria-invalid={fieldErrors.roleId ? true : undefined}
            aria-describedby={fieldErrors.roleId ? 'roleId-error' : undefined}
            className={`${inputClass} cursor-pointer`}
          >
            <option value="" disabled>
              {roles ? 'Choose a role' : 'Loading roles…'}
            </option>
            {roles?.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          {fieldErrors.roleId && (
            <p id="roleId-error" className="text-sm font-medium text-text">
              {fieldErrors.roleId}
            </p>
          )}
        </div>
        <Alert>{rolesError || error}</Alert>
        <PrimaryButton disabled={busy || !roles}>Create invite</PrimaryButton>
      </form>
      {created && (
        <InviteLink
          key={created.id}
          url={created.inviteUrl}
          shareText={`You're invited to join ${ctx?.company.name ?? 'our company'} on Site Diary as ${created.roleName}. Open this link to join:`}
        >
          <p>
            Invite ready for <strong className="break-all font-semibold">{created.email}</strong> as{' '}
            {created.roleName}. Send them this link. It works for 7 days.
          </p>
        </InviteLink>
      )}
    </section>
  );
}

function PendingRow({
  invite,
  canManage,
  onChanged,
}: {
  invite: Invitation;
  canManage: boolean;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const expires = new Date(invite.expiresAt).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  });

  async function revoke() {
    setBusy(true);
    setError('');
    try {
      await api(`/api/invitations/${invite.id}`, { method: 'DELETE' });
      await onChanged();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-col gap-2">
      <div className={row}>
        <div className="flex min-w-0 flex-col">
          <span className="break-all font-medium">{invite.email}</span>
          <span className="text-sm text-muted">
            {invite.roleName} · link works until {expires}
          </span>
        </div>
        {canManage && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void revoke()}
            aria-label={`Cancel invite for ${invite.email}`}
            className={secondaryButton}
          >
            Cancel
          </button>
        )}
      </div>
      <Alert>{error}</Alert>
    </li>
  );
}
