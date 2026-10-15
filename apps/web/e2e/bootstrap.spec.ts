import { randomInt } from 'node:crypto';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

// Runs against the real API and the local test database (see playwright.config.ts).
const ORIGIN = 'http://localhost:4173';
const OWNER = { email: 'owner@sitediary.test', password: 'owner-password-123', name: 'Owner' };

test.describe.configure({ mode: 'serial' });

/** A fresh client IP per test keeps the sign-in rate limit (5/min per IP) out of the way. */
async function freshIp(context: BrowserContext): Promise<void> {
  const ip = `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
  await context.setExtraHTTPHeaders({ 'x-client-ip': ip });
}

test.beforeAll(async ({ request }) => {
  // The owner's email is in PLATFORM_ADMIN_EMAILS, so public sign-up is allowed.
  // A 403 means the account already exists (the e2e setup empties the DB first).
  const res = await request.post('/api/auth/sign-up/email', {
    headers: { origin: ORIGIN },
    data: OWNER,
  });
  expect([200, 403]).toContain(res.status());
});

test.beforeEach(async ({ context }) => freshIp(context));

async function signInOnPage(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function createCompany(
  page: Page,
  c: { name: string; slug: string; email: string },
): Promise<string> {
  await page.getByLabel('Company name').fill(c.name);
  await page.getByLabel('Workspace name').fill(c.slug);
  await page.getByLabel('Super Admin email').fill(c.email);
  await page.getByRole('button', { name: 'Create company' }).click();
  const link = page.getByTestId('invite-link');
  await expect(link).toBeVisible();
  return (await link.textContent())!.trim();
}

test('platform admin → company → invite → super admin lands in home', async ({ page }) => {
  await signInOnPage(page, OWNER.email, OWNER.password);
  await expect(page).toHaveURL(/\/platform$/);

  const inviteUrl = await createCompany(page, {
    name: 'Mehta Infra',
    slug: 'mehta-infra',
    email: 'anita@mehtainfra.example',
  });
  expect(inviteUrl).toMatch(/^http:\/\/localhost:4173\/invite\/[\w-]+$/);
  await expect(page.getByRole('button', { name: 'Copy link' })).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'mehta-infra' })).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/$/);

  await page.goto(inviteUrl);
  await expect(page.getByText('Join Mehta Infra as Super Admin')).toBeVisible();
  await page.getByLabel('Your name').fill('Anita Mehta');
  await page.getByLabel('Choose a password').fill('anita-password-123');
  await page.getByRole('button', { name: 'Join' }).click();

  await expect(page).toHaveURL(/\/home$/);
  const menu = page.getByRole('navigation', { name: 'Main menu' });
  await expect(menu.getByText('Mehta Infra')).toBeVisible();
  await expect(menu.getByText('Super Admin')).toBeVisible();

  // Opening the app while signed in goes straight to the company's main page.
  await page.goto('/');
  await expect(page).toHaveURL(/\/home$/);

  // So does signing in again: with one company there is nothing to pick.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/$/);
  await signInOnPage(page, 'anita@mehtainfra.example', 'anita-password-123');
  await expect(page).toHaveURL(/\/home$/);

  // The Super Admin invites a team member from the Team page.
  await menu.getByRole('link', { name: 'Team' }).click();
  await expect(page).toHaveURL(/\/team$/);
  await expect(page.getByText('anita@mehtainfra.example')).toBeVisible();
  await page.getByLabel('Their email').fill('ravi@mehtainfra.example');
  await page.getByLabel('Role').selectOption({ label: 'Site Engineer' });
  await page.getByRole('button', { name: 'Create invite' }).click();
  await expect(page.getByTestId('invite-link')).toContainText('/invite/');
  await expect(page.getByRole('link', { name: 'Share on WhatsApp' })).toBeVisible();
  await expect(page.getByText(/ravi@mehtainfra\.example/).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Waiting to join' })).toBeVisible();

  // Add the first project; Home then opens on it with the module tiles.
  await menu.getByRole('link', { name: 'Projects' }).click();
  await page.getByLabel('Project name').fill('Riverside Tower');
  await page.getByLabel('Short code').fill('RT-P2');
  await page.getByRole('button', { name: 'Add project' }).click();
  await expect(page.getByText('Riverside Tower added. It now opens on Home.')).toBeVisible();
  await menu.getByRole('link', { name: 'Home' }).click();
  await expect(page.getByRole('heading', { name: 'Riverside Tower' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Self Attendance' })).toBeVisible();
});

test('invite link opened twice shows "This invitation has already been used."', async ({
  page,
}) => {
  await signInOnPage(page, OWNER.email, OWNER.password);
  await expect(page).toHaveURL(/\/platform$/);
  const inviteUrl = await createCompany(page, {
    name: 'Shah Builders',
    slug: 'shah-builders',
    email: 'ravi@shahbuilders.example',
  });
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/$/);

  await page.goto(inviteUrl);
  await page.getByLabel('Your name').fill('Ravi Shah');
  await page.getByLabel('Choose a password').fill('ravi-password-123');
  await page.getByRole('button', { name: 'Join' }).click();
  await expect(page).toHaveURL(/\/home$/);

  await page.goto(inviteUrl);
  await expect(page.getByRole('alert')).toHaveText('This invitation has already been used.');
});

test('360px: invite and platform pages have no horizontal scroll', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await signInOnPage(page, OWNER.email, OWNER.password);
  await expect(page).toHaveURL(/\/platform$/);
  const inviteUrl = await createCompany(page, {
    name: 'Desai Constructions Private Limited',
    slug: 'desai-constructions',
    email: 'meera.desai.site.engineer@desaiconstructions.example',
  });
  const noScroll = () => page.evaluate(() => document.documentElement.scrollWidth);
  expect(await noScroll()).toBeLessThanOrEqual(360);
  for (const name of ['Copy link', 'Create company']) {
    const btn = page.getByRole('button', { name, exact: true });
    expect(await btn.evaluate((b) => b.scrollWidth <= b.clientWidth)).toBe(true);
  }

  // On a phone the menu is a drawer: closed until the menu button opens it.
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeHidden();
  await page.getByRole('button', { name: 'Open menu' }).click();
  const signOut = page.getByRole('button', { name: 'Sign out' });
  await expect(signOut).toBeVisible();
  expect(await noScroll()).toBeLessThanOrEqual(360);
  await signOut.click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto(inviteUrl);
  await expect(page.getByText(/Join Desai Constructions/)).toBeVisible();
  expect(await noScroll()).toBeLessThanOrEqual(360);
  const join = page.getByRole('button', { name: 'Join' });
  expect(await join.evaluate((b) => b.scrollWidth <= b.clientWidth)).toBe(true);
});
