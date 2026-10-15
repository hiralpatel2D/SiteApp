import { createAuthClient } from 'better-auth/client';
import { ApiError, api } from './api';
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
  user: {
    id: string;
    name: string;
    email: string;
    isPlatformAdmin: boolean;
    /** Set for a bootstrapped owner: the API refuses everything else until it is changed. */
    mustChangePassword: boolean;
  };
  memberships: Membership[];
};

/** Where a signed-in user goes next: the forced password change comes first. */
export function landingFor(me: Me): '/change-password' | '/platform' | '/companies' | '/home' {
  if (me.user.mustChangePassword) return '/change-password';
  if (onlyActiveCompany(me)) return '/home';
  return me.user.isPlatformAdmin && me.memberships.length === 0 ? '/platform' : '/companies';
}

/** The company id when the user belongs to exactly one, and it is active; else null. */
export function onlyActiveCompany(me: Me): string | null {
  const only = me.memberships.length === 1 ? me.memberships[0] : undefined;
  return only && only.companyStatus === 'active' ? only.companyId : null;
}

/** `landingFor`, plus making the company active when the landing is its main page. */
export function enterApp(me: Me): ReturnType<typeof landingFor> {
  const to = landingFor(me);
  if (to === '/home') setActiveCompany(onlyActiveCompany(me));
  return to;
}

/** True for the API's 403 `password_change_required`. */
export function isPasswordChangeRequired(err: unknown): boolean {
  return err instanceof ApiError && err.status === 403 && err.code === 'password_change_required';
}

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
