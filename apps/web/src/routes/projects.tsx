import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { ApiError, api, errorMessage } from '../lib/api';
import { setActiveProject, type Project } from '../lib/project';
import { AppShell, useCan, useShell } from '../components/AppShell';
import { Icon } from '../components/icons';
import { Alert, Field, Loading, PrimaryButton, secondaryButton } from '../components/ui';

export const Route = createFileRoute('/projects')({ component: Projects });

const heading = 'font-display text-[24px] font-extrabold uppercase leading-none';

function Projects() {
  return (
    <AppShell title="Projects">
      <ProjectsBody />
    </AppShell>
  );
}

function ProjectsBody() {
  const canView = useCan('projects.view');
  const canManage = useCan('projects.manage');
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setProjects(await api<Project[]>('/api/projects'));
      setError('');
    } catch (err) {
      setProjects((prev) => prev ?? []);
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    if (canView) void load();
  }, [canView, load]);

  if (!canView) return <Alert>You do not have permission to do this.</Alert>;

  const active = projects?.filter((p) => p.status === 'active') ?? [];
  const archived = projects?.filter((p) => p.status !== 'active') ?? [];

  return (
    <div className="flex flex-col gap-8">
      {canManage && <CreateProject onCreated={load} />}
      <Alert>{error}</Alert>
      <section aria-labelledby="active-heading" className="flex flex-col gap-3">
        <h2 id="active-heading" className={heading}>
          Active projects
        </h2>
        {!projects && <Loading />}
        {projects && active.length === 0 && !error && (
          <p className="text-muted">No active projects yet.</p>
        )}
        <ul className="flex flex-col gap-2">
          {active.map((p) => (
            <ProjectRow key={p.id} project={p} canManage={canManage} onChanged={load} />
          ))}
        </ul>
      </section>
      {archived.length > 0 && (
        <section aria-labelledby="archived-heading" className="flex flex-col gap-3">
          <h2 id="archived-heading" className={heading}>
            Archived
          </h2>
          <ul className="flex flex-col gap-2">
            {archived.map((p) => (
              <ProjectRow key={p.id} project={p} canManage={canManage} onChanged={load} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function CreateProject({ onCreated }: { onCreated: () => Promise<void> }) {
  const { ctx } = useShell();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState('');

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    setBusy(true);
    setError('');
    setFieldErrors({});
    setDone('');
    try {
      const created = await api<Project>('/api/projects', {
        body: {
          name: String(form.get('name') ?? ''),
          code: String(form.get('code') ?? ''),
          location: String(form.get('location') ?? ''),
        },
      });
      // The new project opens on Home next time.
      if (ctx) setActiveProject(ctx.company.id, created.id);
      setDone(`${created.name} added. It now opens on Home.`);
      formEl.reset();
      await onCreated();
    } catch (err) {
      setError(errorMessage(err));
      if (err instanceof ApiError) {
        if (err.details) setFieldErrors(err.details);
        else if (err.code === 'project_code_taken') setFieldErrors({ code: err.message });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="create-heading" className="flex flex-col gap-4">
      <h2 id="create-heading" className={heading}>
        Add a project
      </h2>
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <Field
          id="name"
          label="Project name"
          required
          autoComplete="off"
          placeholder="Riverside Tower – Phase 2"
          error={fieldErrors.name}
        />
        <Field
          id="code"
          label="Short code"
          required
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="RT-P2"
          hint="2 to 16 letters or numbers, hyphens allowed. Used on reports and entry numbers."
          error={fieldErrors.code}
        />
        <Field
          id="location"
          label="Location (optional)"
          autoComplete="off"
          placeholder="Baner, Pune"
          hint="The exact site point and attendance radius are set with Attendance."
          error={fieldErrors.location}
        />
        <Alert>{error}</Alert>
        <PrimaryButton disabled={busy}>Add project</PrimaryButton>
        <p role="status" className="min-h-5 font-medium">
          {done}
        </p>
      </form>
    </section>
  );
}

function ProjectRow({
  project,
  canManage,
  onChanged,
}: {
  project: Project;
  canManage: boolean;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const archived = project.status !== 'active';
  const action = archived ? 'Restore' : 'Archive';

  async function toggle() {
    setBusy(true);
    setError('');
    try {
      await api(`/api/projects/${project.id}`, {
        method: 'PATCH',
        body: { version: project.version, status: archived ? 'active' : 'archived' },
      });
      await onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-col gap-2">
      <div className="flex min-w-0 items-center justify-between gap-3 rounded-[var(--r)] border border-line bg-card px-4 py-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-[10px] bg-icon-bg text-icon-fg">
            <Icon name="pin" size={18} />
          </span>
          <div className="flex min-w-0 flex-col">
            <span className="break-words font-medium">{project.name}</span>
            <span className="break-words font-mono text-[11px] uppercase tracking-widest text-muted">
              {project.code}
              {project.location ? ` · ${project.location}` : ''}
            </span>
          </div>
        </div>
        {canManage && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void toggle()}
            aria-label={`${action} ${project.name}`}
            className={secondaryButton}
          >
            {action}
          </button>
        )}
      </div>
      <Alert>{error}</Alert>
    </li>
  );
}
