/** localStorage key for the company the user is working in. */
export const COMPANY_KEY = 'sd.company';

/** The active company id, or null (also when storage is unavailable). */
export function getActiveCompany(): string | null {
  try {
    return localStorage.getItem(COMPANY_KEY) || null;
  } catch {
    return null;
  }
}

/** Stores (or with `null`, clears) the active company. Never throws. */
export function setActiveCompany(id: string | null): void {
  try {
    if (id) localStorage.setItem(COMPANY_KEY, id);
    else localStorage.removeItem(COMPANY_KEY);
  } catch {
    // Storage blocked (private mode, policy): the choice lasts for this page only.
  }
}
