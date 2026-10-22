import { expect, type APIRequestContext } from '@playwright/test';

export const ORIGIN = 'http://localhost:4173';
export const OWNER = {
  email: 'owner@sitediary.test',
  password: 'owner-password-123',
  name: 'Owner',
};

/**
 * Makes sure the platform owner exists. Its email is in PLATFORM_ADMIN_EMAILS, so
 * public sign-up is allowed; a 403 means the account already exists. Specs run in
 * parallel, so two sign-ups can race: the loser may get another error, and asking
 * again then answers 403.
 */
export async function ensureOwner(request: APIRequestContext): Promise<void> {
  let status = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await request.post('/api/auth/sign-up/email', {
      headers: { origin: ORIGIN },
      data: OWNER,
    });
    status = res.status();
    if (status === 200 || status === 403) return;
  }
  expect([200, 403]).toContain(status);
}
