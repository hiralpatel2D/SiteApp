import { createAuthClient } from 'better-auth/client';
import { api } from './api';
import { setActiveCompany } from './company';

/** Better Auth client; same origin, so the browser sets `Origin` and cookies. */
export const authClient = createAuthClient({
  basePath: '/api/auth',
  // Look up `fetch` on each call (not once at start-up), so tests can stub it.
  fetchOptions: { customFetchImpl: (input, init) => fetch(input, init) },
});

export type Membership = {
  companyId: string;
  companyName: string;
  companySlug: string;
  companyStatus: string;
  roleName: string;
  status: string;
};

export type Me = {
  user: { id: string; name: string; email: string; isPlatformAdmin: boolean };
  memberships: Membership[];
};

export const fetchMe = () => api<Me>('/api/me', { company: null });

const FALLBACK = 'The service is busy. Try again shortly.';

/**
 * The catalogue message from a Better Auth client error. Our API re-emits auth
 * errors as `{ error: { code, message } }`, which the client nests under `error`.
 */
export function authErrorMessage(error: unknown): string {
  const e = error as { error?: { message?: unknown }; message?: unknown } | null;
  if (e && typeof e.error?.message === 'string') return e.error.message;
  return FALLBACK;
}

/** Ends the session and forgets the active company. */
export async function signOut(): Promise<void> {
  try {
    await authClient.signOut();
  } finally {
    setActiveCompany(null);
  }
}
