import { randomInt } from 'node:crypto';
import { expect, test } from '@playwright/test';

// Runs against the real API and the local test database (see playwright.config.ts).

test.beforeEach(async ({ context }) => {
  const ip = `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
  await context.setExtraHTTPHeaders({ 'x-client-ip': ip });
});

test('sign-in no longer links to the owner setup page', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Create owner account/ })).toHaveCount(0);
});

test('owner setup refuses emails that are not the platform owner', async ({ page }) => {
  await page.goto('/setup');
  await page.getByLabel('Your name').fill('Someone Else');
  await page.getByLabel('Email').fill(`someone-${randomInt(1e9)}@example.test`);
  await page.getByLabel('Choose a password').fill('a-long-password-1');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'Site Diary is invite-only. Ask your company admin for an invitation.',
  );
  await expect(page).toHaveURL(/\/setup$/);
});
