/** The project picked in the Home switcher, remembered per company on this device. */
const key = (companyId: string) => `sd.project.${companyId}`;

export function getActiveProject(companyId: string): string | null {
  try {
    return localStorage.getItem(key(companyId)) || null;
  } catch {
    return null;
  }
}

/** Stores (or with `null`, clears) the project. Never throws. */
export function setActiveProject(companyId: string, projectId: string | null): void {
  try {
    if (projectId) localStorage.setItem(key(companyId), projectId);
    else localStorage.removeItem(key(companyId));
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
}

export type Project = {
  id: string;
  name: string;
  code: string;
  location: string | null;
  status: string;
  memberCount: number;
  version: number;
};
