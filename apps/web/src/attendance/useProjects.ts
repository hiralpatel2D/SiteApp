import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import type { Project } from '../lib/project';
import { useCan } from '../components/AppShell';

/** Active projects the person can see (null while loading), and any load error. */
export function useActiveProjects(): { projects: Project[] | null; error: string } {
  const canSeeProjects = useCan('projects.view');
  const [projects, setProjects] = useState<Project[] | null>(canSeeProjects ? null : []);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!canSeeProjects) return;
    let live = true;
    api<Project[]>('/api/projects').then(
      (list) => live && setProjects(list.filter((p) => p.status === 'active')),
      (err: unknown) => {
        if (!live) return;
        setProjects([]);
        setError(errorMessage(err));
      },
    );
    return () => {
      live = false;
    };
  }, [canSeeProjects]);

  return { projects, error };
}
