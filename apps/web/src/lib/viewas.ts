// The Super Admin's read-only preview of another person. The token comes from the audited
// start endpoint; it lives in sessionStorage (this tab only, gone when the tab closes).

export type ViewAsPerson = {
  membershipId: string;
  name: string;
  email: string;
  roleName: string;
  roleKey: string | null;
};

type Stored = { token: string; person: ViewAsPerson };

const key = (company: string) => `sd.viewas.${company}`;

function read(company: string | null): Stored | null {
  if (!company) return null;
  try {
    const raw = sessionStorage.getItem(key(company));
    return raw ? (JSON.parse(raw) as Stored) : null;
  } catch {
    return null;
  }
}

/** The "view as" token for a company, or null. Never throws. */
export const getViewAsToken = (company: string | null): string | null =>
  read(company)?.token ?? null;

/** Starts (or switches) the preview for this tab. */
export function setViewAs(company: string, value: Stored): void {
  try {
    sessionStorage.setItem(key(company), JSON.stringify(value));
  } catch {
    // Storage blocked: the preview cannot start, and the app stays in the person's own view.
  }
}

/** Ends the preview for this tab. */
export function clearViewAs(company: string): void {
  try {
    sessionStorage.removeItem(key(company));
  } catch {
    // Nothing stored that could be removed.
  }
}
