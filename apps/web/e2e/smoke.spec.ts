import { expect, test } from '@playwright/test';

test('sign-in screen renders in Field Ops', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('SITE DIARY')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('field-ops');
});

test('no horizontal scroll or clipped button at 360px', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('/');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  const btn = page.getByRole('button', { name: 'Sign in' });
  expect(await btn.evaluate((b) => b.scrollWidth <= b.clientWidth)).toBe(true);
});
