import { useEffect, useState } from 'react';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { ApiError, errorMessage } from '../lib/api';
import { fetchMe, onlyActiveCompany, signOut, type Me, type Membership } from '../lib/auth';
import { setActiveCompany } from '../lib/company';
import { Alert, Loading, PageTitle, Screen, SecondaryButton, linkClass } from '../components/ui';

export const SUSPENDED = "This company's access is suspended. Contact Site Diary support.";

export const Route = createFileRoute('/companies')({ component: Companies });

function Companies() {
  const navigate = useNavigate();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    fetchMe().then(
      (data) => {
        if (!live) return;
        if (data.user.mustChangePassword) {
          void navigate({ to: '/change-password', replace: true });
          return;
        }
        // One active company: nothing to pick, open its main page. Platform
        // admins reach Platform admin from there.
        const only = onlyActiveCompany(data);
        if (only) {
          setActiveCompany(only);
          void navigate({ to: '/home', replace: true });
          return;
        }
        setMe(data);
      },
      (err: unknown) => {
        if (!live) return;
        if (err instanceof ApiError && err.status === 401) {
          void navigate({ to: '/', replace: true });
          return;
        }
        setError(errorMessage(err));
      },
    );
    return () => {
      live = false;
    };
  }, [navigate]);

  function choose(m: Membership) {
    setActiveCompany(m.companyId);
    void navigate({ to: '/home' });
  }

  async function onSignOut() {
    await signOut().catch(() => undefined);
    await navigate({ to: '/' });
  }

  const aside = <SecondaryButton onClick={() => void onSignOut()}>Sign out</SecondaryButton>;

  return (
    <Screen aside={aside}>
      <PageTitle>Your companies</PageTitle>
      <div className="mt-6 flex flex-col gap-4">
        <Alert>{error}</Alert>
        {!me && !error && <Loading />}
        {me && me.memberships.length === 0 && (
          <p className="text-muted">
            You are not in any company yet. Ask your company admin for an invitation.
          </p>
        )}
        {me && me.memberships.length > 0 && (
          <ul className="flex flex-col gap-3">
            {me.memberships.map((m) => {
              const suspended = m.companyStatus !== 'active';
              const describedBy = suspended ? `suspended-${m.companyId}` : undefined;
              return (
                <li key={m.companyId}>
                  <button
                    type="button"
                    disabled={suspended}
                    aria-describedby={describedBy}
                    onClick={() => choose(m)}
                    className="flex w-full min-w-0 cursor-pointer flex-col items-start gap-1 rounded-[var(--r)] border border-line bg-card px-4 py-3.5 text-left hover:border-accent disabled:cursor-default disabled:opacity-70 disabled:hover:border-line"
                  >
                    <span className="max-w-full break-words font-display text-[22px] font-bold uppercase leading-tight">
                      {m.companyName}
                    </span>
                    <span className="text-muted">{m.roleName}</span>
                    {suspended && (
                      <span id={describedBy} className="text-sm font-medium text-text">
                        {SUSPENDED}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {me?.user.isPlatformAdmin && (
          <Link to="/platform" className={`${linkClass} self-start`}>
            Platform admin
          </Link>
        )}
      </div>
    </Screen>
  );
}
