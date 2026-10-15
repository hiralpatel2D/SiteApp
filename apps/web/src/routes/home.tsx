import { Link, createFileRoute } from '@tanstack/react-router';
import { AppShell, useCan, useShell } from '../components/AppShell';
import { labelClass } from '../components/ui';

export const Route = createFileRoute('/home')({ component: Home });

function Home() {
  return (
    <AppShell title="Home">
      <HomeBody />
    </AppShell>
  );
}

const tile =
  'flex min-h-[112px] flex-col justify-between gap-3 rounded-[var(--r)] border border-line bg-card p-4 transition-transform duration-300 ease-(--spring) hover:border-accent active:scale-[0.98]';

function HomeBody() {
  const { me, ctx } = useShell();
  const canInvite = useCan('users.manage');
  const canSeeTeam = useCan('users.view');
  if (!ctx) return null;
  const first = me.user.name.split(' ')[0] || me.user.name;
  return (
    <div className="flex flex-col gap-6">
      <p className="text-[17px] text-muted">
        Welcome, <span className="text-text">{first}</span>. You are {ctx.role.name} at{' '}
        <span className="text-text">{ctx.company.name}</span>.
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {canSeeTeam && (
          <Link to="/team" className={tile}>
            <span className={labelClass}>Team</span>
            <span className="font-display text-[22px] font-bold uppercase leading-tight">
              {canInvite ? 'Invite people' : 'See your team'}
            </span>
          </Link>
        )}
        {me.user.isPlatformAdmin && (
          <Link to="/platform" className={tile}>
            <span className={labelClass}>Platform admin</span>
            <span className="font-display text-[22px] font-bold uppercase leading-tight">
              Companies
            </span>
          </Link>
        )}
      </div>

      <p className="text-muted">
        Attendance, projects, daily diaries and reports arrive in the next releases.
      </p>
    </div>
  );
}
