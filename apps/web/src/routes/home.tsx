import { useEffect, useState } from 'react';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { ApiError, api, errorMessage } from '../lib/api';
import { fetchMe, isPasswordChangeRequired, signOut } from '../lib/auth';
import { getActiveCompany, setActiveCompany } from '../lib/company';
import {
  Alert,
  Loading,
  PageTitle,
  Screen,
  SecondaryButton,
  labelClass,
  linkClass,
} from '../components/ui';

type CompanyContext = {
  company: { id: string; name: string; slug: string };
  role: { id: string; name: string; key: string | null };
  capabilities: string[];
};

export const Route = createFileRoute('/home')({ component: Home });

function Home() {
  const navigate = useNavigate();
  const [ctx, setCtx] = useState<CompanyContext | null>(null);
  const [error, setError] = useState('');
  const [platformAdmin, setPlatformAdmin] = useState(false);

  useEffect(() => {
    if (!getActiveCompany()) {
      void navigate({ to: '/companies', replace: true });
      return;
    }
    let live = true;
    // Only decides whether to show the Platform admin link; failures hide it.
    // Decides whether to show the Platform admin link (failures hide it), and
    // sends a user who must change their password to do that first.
    fetchMe().then(
      (me) => {
        if (!live) return;
        if (me.user.mustChangePassword) {
          live = false;
          void navigate({ to: '/change-password', replace: true });
          return;
        }
        setPlatformAdmin(me.user.isPlatformAdmin);
      },
      () => undefined,
    );
    api<CompanyContext>('/api/company/context').then(
      (data) => live && setCtx(data),
      (err: unknown) => {
        if (!live) return;
        if (err instanceof ApiError && err.status === 401) {
          void navigate({ to: '/', replace: true });
          return;
        }
        // Checked before the generic 403 below, which would forget the company.
        if (isPasswordChangeRequired(err)) {
          void navigate({ to: '/change-password', replace: true });
          return;
        }
        // Not a member any more, suspended, unknown or no company: choose again.
        if (err instanceof ApiError && [400, 403, 404].includes(err.status)) {
          setActiveCompany(null);
          void navigate({ to: '/companies', replace: true });
          return;
        }
        setError(errorMessage(err));
      },
    );
    return () => {
      live = false;
    };
  }, [navigate]);

  async function onSignOut() {
    await signOut().catch(() => undefined);
    await navigate({ to: '/' });
  }

  const aside = <SecondaryButton onClick={() => void onSignOut()}>Sign out</SecondaryButton>;

  return (
    <Screen aside={aside}>
      <Alert>{error}</Alert>
      {!ctx && !error && <Loading />}
      {ctx && (
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <span className={labelClass}>Company</span>
            <PageTitle>{ctx.company.name}</PageTitle>
          </div>
          <div className="flex flex-col gap-1.5 rounded-[var(--r)] border border-line bg-card px-4 py-3.5">
            <span className={labelClass}>Your role</span>
            <span className="text-[17px] font-medium">{ctx.role.name}</span>
          </div>
          <p className="text-muted">
            Projects, daily diaries and reports arrive in the next releases.
          </p>
        </div>
      )}
      <nav className="mt-6 flex flex-wrap gap-x-6 gap-y-3">
        <Link to="/companies" className={linkClass}>
          Switch company
        </Link>
        {platformAdmin && (
          <Link to="/platform" className={linkClass}>
            Platform admin
          </Link>
        )}
      </nav>
    </Screen>
  );
}
