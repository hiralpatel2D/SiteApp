import { randomInt, randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import { expect, test, type Page } from '@playwright/test';
import { withTestDb } from './test-db';

// Runs against the real API and the local test database (see playwright.config.ts).
// Seeds the account a bootstrapped owner gets (BOOTSTRAP_OWNER_EMAIL/PASSWORD):
// a platform admin with a temporary password that must be changed.
const TEMP_PASSWORD = '123456789';
const NEW_PASSWORD = 'my-own-password-1';

async function seedMustChangeOwner(email: string): Promise<void> {
  // Better Auth's default hasher, which the API is configured with.
  const hash = await hashPassword(TEMP_PASSWORD);
  await withTestDb(async (client) => {
    const id = randomUUID();
    await client.query('begin');
    try {
      await client.query(
        `insert into users (id, email, name, email_verified, is_platform_admin, must_change_password)
         values ($1, $2, 'Owner', false, true, true)`,
        [id, email],
      );
      await client.query(
        `insert into accounts (id, user_id, account_id, provider_id, password)
         values ($1, $2, $3, 'credential', $4)`,
        [randomUUID(), id, id, hash],
      );
      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      throw err;
    }
  });
}

test.beforeEach(async ({ context }) => {
  // A fresh client IP keeps the sign-in rate limit (5/min per IP) out of the way.
  const ip = `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
  await context.setExtraHTTPHeaders({ 'x-client-ip': ip });
});

async function signInOnPage(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('first sign-in with a temporary password forces a new password', async ({ page }) => {
  const email = `first-owner-${randomInt(1e9)}@sitediary.test`;
  await seedMustChangeOwner(email);

  await signInOnPage(page, email, TEMP_PASSWORD);
  await expect(page).toHaveURL(/\/change-password$/);
  await expect(page.getByRole('heading', { name: 'Set a new password' })).toBeVisible();

  // Other pages send the user back until the password is changed.
  await page.goto('/platform');
  await expect(page).toHaveURL(/\/change-password$/);

  await page.getByLabel('Current password').fill(TEMP_PASSWORD);
  await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel('Confirm new password').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page).toHaveURL(/\/platform$/);
  await expect(page.getByRole('heading', { name: 'Platform admin' })).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/$/);

  // The temporary password no longer works; the new one does.
  await signInOnPage(page, email, TEMP_PASSWORD);
  await expect(page.getByRole('alert')).toHaveText('Email or password is incorrect.');
  await signInOnPage(page, email, NEW_PASSWORD);
  await expect(page).toHaveURL(/\/platform$/);
});

test('360px: the new password page has no horizontal scroll', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  const email = `narrow-owner-${randomInt(1e9)}@sitediary.test`;
  await seedMustChangeOwner(email);
  await signInOnPage(page, email, TEMP_PASSWORD);
  await expect(page).toHaveURL(/\/change-password$/);
  await expect(page.getByLabel('Confirm new password')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
});
