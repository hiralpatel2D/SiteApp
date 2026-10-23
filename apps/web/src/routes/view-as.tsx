import { useEffect, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { api, errorMessage } from '../lib/api';
import { clearViewAs, setViewAs, type ViewAsPerson } from '../lib/viewas';
import { AppShell, useShell } from '../components/AppShell';
import { Alert, Loading, primaryButton, secondaryButton } from '../components/ui';

export const Route = createFileRoute('/view-as')({ component: ViewAsPage });

function ViewAsPage() {
  return (
    <AppShell title="View as">
      <ViewAsBody />
    </AppShell>
  );
}

function ViewAsBody() {
  const { ctx } = useShell();
  const [people, setPeople] = useState<ViewAsPerson[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!ctx?.canViewAs) return;
    let live = true;
    api<{ people: ViewAsPerson[] }>('/api/company/view-as/people').then(
      (r) => live && setPeople(r.people),
      (err: unknown) => live && setError(errorMessage(err)),
    );
    return () => {
      live = false;
    };
  }, [ctx?.canViewAs]);

  if (!ctx?.canViewAs) return <Alert>Only a Super Admin can view the app as someone else.</Alert>;

  async function start(p: ViewAsPerson) {
    if (!ctx) return;
    setBusy(p.membershipId);
    setError('');
    try {
      const r = await api<{ token: string; person: ViewAsPerson }>('/api/company/view-as', {
        body: { membershipId: p.membershipId },
      });
      setViewAs(ctx.company.id, { token: r.token, person: r.person });
      window.location.assign('/home');
    } catch (err) {
      setError(errorMessage(err));
      setBusy(null);
    }
  }

  // People are grouped by role so "what does a Site Engineer see" is one tap.
  const byRole = new Map<string, ViewAsPerson[]>();
  for (const p of people ?? []) byRole.set(p.roleName, [...(byRole.get(p.roleName) ?? []), p]);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[17px]">
        Pick a person to see the app exactly as they see it: their menu, screens and data. It is{' '}
        <strong>read-only</strong>, nothing can be saved or approved while you are viewing, and each
        use is recorded in the audit log.
      </p>
      {ctx.viewAs && (
        <p className="rounded-[var(--r)] border border-line-soft bg-card p-4 font-medium">
          {`Now viewing as ${ctx.viewAs.name} (${ctx.viewAs.roleName}).`}
        </p>
      )}
      <Alert>{error}</Alert>
      {!error && people === null && <Loading />}
      {people !== null && people.length === 0 && (
        <p className="rounded-[var(--r)] border border-line-soft bg-card p-4 text-muted">
          There is nobody else in this company yet. Invite someone from Team first.
        </p>
      )}
      {[...byRole.entries()].map(([role, list]) => (
        <section key={role} aria-label={role} className="flex flex-col gap-2">
          <h2 className="font-display text-[20px] font-extrabold uppercase leading-tight">
            {role}
          </h2>
          <ul className="flex flex-col gap-2">
            {list.map((p) => (
              <li
                key={p.membershipId}
                className="flex items-center gap-3 rounded-[var(--r)] border border-line-soft bg-card p-3"
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="break-words font-medium">{p.name}</span>
                  <span className="break-all text-sm text-muted">{p.email}</span>
                </span>
                <button
                  type="button"
                  className={`${primaryButton} min-h-11 shrink-0 px-4 text-base`}
                  disabled={busy !== null}
                  aria-label={`View as ${p.name}`}
                  onClick={() => void start(p)}
                >
                  View
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {ctx.viewAs && (
        <button
          type="button"
          className={secondaryButton}
          onClick={() => {
            void api('/api/company/view-as/stop', { method: 'POST', body: {} }).finally(() => {
              clearViewAs(ctx.company.id);
              window.location.assign('/home');
            });
          }}
        >
          Back to my own view
        </button>
      )}
    </div>
  );
}
