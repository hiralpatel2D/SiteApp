import { randomInt } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { ORIGIN, OWNER, ensureOwner } from './owner';
import { withTestDb } from './test-db';

// Self Attendance end to end, against the real API (API_FACE_ENGINE=fake: every frame
// reads as one live face with the same face code) and the test database. The browser
// face guide is faked too (window.__SD_FAKE_FACE__), and Chromium gets a fake camera.
const ADMIN = { name: 'Priya Kulkarni', email: 'priya@kulkarnibuild.example' };
const ENGINEER = { name: 'Kiran Rao', email: 'kiran@kulkarnibuild.example' };
const FAR_ENGINEER = { name: 'Sunil Jadhav', email: 'sunil@kulkarnibuild.example' };
const PROJECT = 'Harbour View';

/** The site, and a spot about 1 km north of it (outside the default 100 m radius). */
const SITE = { latitude: 19.076, longitude: 72.8777, accuracy: 10 };
const FAR = { latitude: 19.085, longitude: 72.8777, accuracy: 10 };

const PHONE = { width: 360, height: 740 };
const SLOW = { timeout: 20_000 };

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => ensureOwner(request));

/** A signed-out user with their own browser, location, camera and IP (sign-in rate limit). */
async function newUser(
  browser: Browser,
  where: typeof SITE,
  viewport?: typeof PHONE,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL: ORIGIN,
    ...(viewport ? { viewport } : {}),
  });
  await context.grantPermissions(['geolocation', 'camera'], { origin: ORIGIN });
  await context.setGeolocation(where);
  await context.setExtraHTTPHeaders({
    'x-client-ip': `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`,
  });
  await context.addInitScript(() => {
    window.__SD_FAKE_FACE__ = true;
  });
  return { context, page: await context.newPage() };
}

async function noHorizontalScroll(page: Page): Promise<void> {
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(PHONE.width);
}

async function join(page: Page, inviteUrl: string, name: string): Promise<void> {
  await page.goto(inviteUrl);
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Choose a password').fill(`${name.split(' ')[0]!.toLowerCase()}-pass-123`);
  await page.getByRole('button', { name: 'Join' }).click();
  await expect(page).toHaveURL(/\/home$/);
}

async function invite(page: Page, email: string): Promise<string> {
  const link = page.getByTestId('invite-link');
  const before = (await link.count()) ? await link.textContent() : null;
  await page.getByLabel('Their email').fill(email);
  await page.getByLabel('Role').selectOption({ label: 'Site Engineer' });
  await page.getByRole('button', { name: 'Create invite' }).click();
  await expect(link).toContainText('/invite/');
  if (before) await expect(link).not.toHaveText(before);
  return (await link.textContent())!.trim();
}

/** No assignment screen yet: put the engineers on the project directly. */
async function assignToProject(emails: string[], projectName: string): Promise<void> {
  await withTestDb(async (client) => {
    const { rowCount } = await client.query(
      `insert into project_assignments (id, company_id, membership_id, project_id)
       select gen_random_uuid(), m.company_id, m.id, p.id
         from memberships m
         join users u on u.id = m.user_id
         join projects p on p.company_id = m.company_id and p.name = $2
        where u.email = any($1)`,
      [emails, projectName],
    );
    expect(rowCount).toBe(emails.length);
  });
}

/** Consent, then the guided capture; ends on "Registered. Your photo is waiting for approval." */
async function registerFace(page: Page, phone = false): Promise<void> {
  await page.goto('/attendance');
  await page.getByRole('link', { name: 'Register your face' }).click();
  await expect(page).toHaveURL(/\/attendance\/register$/);
  if (phone) await noHorizontalScroll(page);
  await page.getByRole('button', { name: 'I agree' }).click();
  await expect(page.getByText('Registered. Your photo is waiting for approval.')).toBeVisible(SLOW);
  if (phone) await noHorizontalScroll(page);
}

async function approveFace(admin: Page, name: string): Promise<void> {
  await admin.goto('/attendance/approvals');
  await admin.getByRole('tab', { name: 'Faces' }).click();
  const row = admin
    .getByRole('list', { name: 'Faces waiting for approval' })
    .getByRole('listitem')
    .filter({ hasText: name });
  await expect(row.getByRole('img', { name })).toBeVisible();
  await row.getByRole('button', { name: 'Approve' }).click();
  await expect(admin.getByRole('status')).toHaveText(`Approved ${name}.`);
}

test('attendance: set up the site, register and approve faces, check in inside and outside the radius', async ({
  browser,
}) => {
  test.setTimeout(180_000);

  // The platform owner creates the company; its Super Admin joins.
  const owner = await newUser(browser, SITE);
  await owner.page.goto('/');
  await owner.page.getByLabel('Email').fill(OWNER.email);
  await owner.page.getByLabel('Password', { exact: true }).fill(OWNER.password);
  await owner.page.getByRole('button', { name: 'Sign in' }).click();
  await expect(owner.page).toHaveURL(/\/platform$/);
  await owner.page.getByLabel('Company name').fill('Kulkarni Builders');
  await owner.page.getByLabel('Workspace name').fill('kulkarni-builders');
  await owner.page.getByLabel('Super Admin email').fill(ADMIN.email);
  await owner.page.getByRole('button', { name: 'Create company' }).click();
  const adminInvite = (await owner.page.getByTestId('invite-link').textContent())!.trim();
  await owner.context.close();

  const admin = await newUser(browser, SITE);
  const a = admin.page;
  await join(a, adminInvite, ADMIN.name);

  // The admin adds the project and invites two site engineers.
  await a.goto('/projects');
  await a.getByLabel('Project name').fill(PROJECT);
  await a.getByLabel('Short code').fill('HV-01');
  await a.getByRole('button', { name: 'Add project' }).click();
  await expect(a.getByText(`${PROJECT} added. It now opens on Home.`)).toBeVisible();
  await a.goto('/team');
  const engineerInvite = await invite(a, ENGINEER.email);
  const farInvite = await invite(a, FAR_ENGINEER.email);

  const eng = await newUser(browser, SITE);
  const e = eng.page;
  await join(e, engineerInvite, ENGINEER.name);
  // The second engineer works on a phone, standing about 1 km from the site.
  const far = await newUser(browser, FAR, PHONE);
  const f = far.page;
  await join(f, farInvite, FAR_ENGINEER.name);
  await assignToProject([ENGINEER.email, FAR_ENGINEER.email], PROJECT);

  // 1. Before set-up, attendance says so.
  await e.goto('/attendance');
  await expect(
    e.getByText(
      'Attendance is not set up for this project yet. Ask your admin to set the site location.',
    ),
  ).toBeVisible();

  // The admin stands on site and saves its location.
  await a.goto('/attendance/settings');
  await a.getByRole('button', { name: 'Use my current location' }).click();
  await expect(a.getByRole('status')).toHaveText('Location set (±10 m). Save to keep it.');
  await expect(a.getByLabel('Latitude')).toHaveValue('19.076000');
  await expect(a.getByLabel('Longitude')).toHaveValue('72.877700');
  await a.getByRole('button', { name: 'Save' }).click();
  await expect(a.getByRole('status')).toHaveText('Settings saved.');

  // 2. The engineer registers a face; the admin approves it.
  await registerFace(e);
  await e.goto('/attendance');
  await expect(
    e.getByText('Your face registration is waiting for approval by a senior.'),
  ).toBeVisible();
  await approveFace(a, ENGINEER.name);

  // 3. Checking in on site: green confirmation, then a green Home tile.
  await e.goto('/attendance');
  await e.getByRole('button', { name: 'Check in' }).click();
  await expect(e.getByText(/^0 m from site · ±10 m$/)).toBeVisible();
  const onSite = e.getByText(new RegExp(`^Checked in at .+ · ${PROJECT} · 0 m from site$`));
  await expect(onSite).toBeVisible(SLOW);
  await expect(e.getByText('Sent for approval')).toHaveCount(0);
  await e.getByRole('button', { name: 'Done' }).click();
  await expect(e.getByRole('list', { name: 'Today' })).toContainText('Checked in at');
  await expect(e.getByRole('button', { name: 'Check out' })).toBeVisible();
  await e.goto('/home');
  const tile = e.getByRole('link', { name: /Self Attendance/ });
  await expect(tile).toContainText(/Checked in \d/);
  await expect(tile).toHaveClass(/bg-good-bg/);

  // 4 and 6. At 360 px, the far engineer registers, is approved and checks in from
  // outside the radius: a pending confirmation that gives the radius reason.
  await registerFace(f, true);
  await approveFace(a, FAR_ENGINEER.name);
  await f.goto('/attendance');
  await noHorizontalScroll(f);
  await f.getByRole('button', { name: 'Check in' }).click();
  await expect(f.getByText(/ m from site · ±10 m$/)).toBeVisible();
  await noHorizontalScroll(f);
  await expect(f.getByText('Sent for approval', { exact: true })).toBeVisible(SLOW);
  await expect(f.getByRole('list', { name: 'Reasons' })).toContainText(
    /Outside site radius \(.+, allowed 100 m\)/,
  );
  await noHorizontalScroll(f);
  await f.getByRole('button', { name: 'Done' }).click();
  await expect(f.getByRole('list', { name: 'Today' })).toContainText('waiting for approval');
  await f.goto('/home');
  const farTile = f.getByRole('link', { name: /Self Attendance/ });
  await expect(farTile).toContainText('Pending approval');
  await expect(farTile).not.toHaveClass(/bg-good-bg/);
  await noHorizontalScroll(f);

  // 5. The admin, also on a phone now, approves it under Approvals → Check-ins.
  await a.setViewportSize(PHONE);
  await a.goto('/attendance/approvals');
  await a.getByRole('tab', { name: 'Check-ins' }).click();
  const row = a
    .getByRole('list', { name: 'Check-ins waiting for approval' })
    .getByRole('listitem')
    .filter({ hasText: FAR_ENGINEER.name });
  await expect(row.getByRole('list', { name: 'Reasons' })).toContainText('Outside site radius');
  await expect(row).toContainText('(allowed 100 m)');
  // The 3 evidence photos survive the database intact: each decodes as the 8x8 JPEG sent.
  const photos = row.getByRole('img');
  await expect(photos).toHaveCount(3);
  for (const img of await photos.all()) {
    await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(8);
  }
  await noHorizontalScroll(a);
  await row.getByRole('button', { name: 'Approve' }).click();
  await expect(a.getByRole('status')).toHaveText(`Approved ${FAR_ENGINEER.name}.`);
  await expect(a.getByText('No check-ins waiting for approval.')).toBeVisible();
  await noHorizontalScroll(a);

  // Approved: the far engineer's tile turns green too.
  await f.reload();
  await expect(farTile).toHaveClass(/bg-good-bg/);
  await expect(farTile).not.toContainText('Pending approval');

  // 6. The remaining key screens at 360 px.
  await a.goto('/attendance/settings');
  await expect(a.getByLabel('Latitude')).toHaveValue('19.076');
  await noHorizontalScroll(a);
  await e.setViewportSize(PHONE);
  for (const path of ['/home', '/attendance', '/attendance/register']) {
    await e.goto(path);
    await expect(e.getByRole('main')).not.toContainText('Loading…');
    await noHorizontalScroll(e);
  }

  // 7. The log, the monthly summary and the Excel file, with who may see what.
  // The engineer sees only their own log, and no summary or Everyone tab.
  await e.goto('/attendance');
  await e.getByRole('link', { name: 'Attendance log' }).click();
  await expect(e).toHaveURL(/\/attendance\/log$/);
  const mine = e.getByRole('list', { name: 'Attendance by day' });
  await expect(mine).toContainText(/In \d\d:\d\d · Recorded/, SLOW);
  await expect(mine).not.toContainText(FAR_ENGINEER.name);
  await expect(e.getByRole('tab', { name: 'Everyone' })).toHaveCount(0);
  await expect(e.getByRole('link', { name: 'Monthly summary' })).toHaveCount(0);
  await noHorizontalScroll(e);
  await e.getByRole('button', { name: 'Open menu' }).click();
  const engineerMenu = e.getByRole('navigation', { name: 'Main menu' });
  await expect(engineerMenu.getByRole('link', { name: 'Attendance log' })).toBeVisible();
  await expect(engineerMenu.getByRole('link', { name: 'Monthly summary' })).toHaveCount(0);
  await expect(engineerMenu.getByRole('link', { name: 'Approvals' })).toHaveCount(0);
  await e.goto('/attendance/summary');
  await expect(e.getByText('You do not have access to the monthly summary.')).toBeVisible();

  // The admin sees everyone, the summary and the download.
  await a.goto('/attendance');
  await a.getByRole('link', { name: 'Attendance log' }).click();
  await a.getByRole('tab', { name: 'Everyone' }).click();
  const everyone = a.getByRole('list', { name: 'Attendance by day' });
  await expect(everyone).toContainText(ENGINEER.name, SLOW);
  await expect(everyone).toContainText(FAR_ENGINEER.name);
  await expect(everyone).toContainText('Approved');
  await noHorizontalScroll(a);
  await a.getByRole('link', { name: 'Monthly summary' }).click();
  await expect(a).toHaveURL(/\/attendance\/summary$/);
  const people = a.getByRole('list', { name: 'People' });
  await expect(people).toContainText(ENGINEER.name, SLOW);
  await expect(people.getByRole('listitem').filter({ hasText: ENGINEER.name })).toContainText(
    'Present 1',
  );
  await expect(people.getByRole('listitem').filter({ hasText: FAR_ENGINEER.name })).toContainText(
    'Present 1',
  );
  const dayTable = a.getByRole('table', { name: /^Day by day, \w+ \d{4}$/ });
  await expect(dayTable.getByRole('rowheader', { name: ENGINEER.name })).toBeVisible();
  await expect(dayTable.getByRole('columnheader').nth(1)).toContainText('01');
  await noHorizontalScroll(a);
  const [download] = await Promise.all([
    a.waitForEvent('download'),
    a.getByRole('button', { name: 'Download Excel' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^attendance-Harbour-View-\d{4}-\d{2}\.xlsx$/);
  const bytes = await readFile((await download.path())!);
  expect(bytes.length).toBeGreaterThan(2000);
  expect(bytes.subarray(0, 2).toString()).toBe('PK');
  // An earlier month still lists the assigned people (as absent), not an error.
  const prior = new Date();
  prior.setUTCMonth(prior.getUTCMonth() - 1, 1);
  await a.getByLabel('Month').fill(prior.toISOString().slice(0, 7));
  await expect(people).toContainText(ENGINEER.name, SLOW);
  await expect(people.getByRole('listitem').filter({ hasText: ENGINEER.name })).toContainText(
    'Present 0',
  );
  await a.getByRole('button', { name: 'Open menu' }).click();
  const adminMenu = a.getByRole('navigation', { name: 'Main menu' });
  for (const name of ['Attendance log', 'Monthly summary', 'Approvals', 'Site settings']) {
    await expect(adminMenu.getByRole('link', { name })).toBeVisible();
  }

  // 8. The Super Admin previews the app as the engineer (read-only), then exits.
  await a.goto('/home');
  await a.getByRole('button', { name: 'Open menu' }).click();
  await a
    .getByRole('navigation', { name: 'Main menu' })
    .getByRole('link', { name: 'View as…' })
    .click();
  await expect(a).toHaveURL(/\/view-as$/);
  await expect(a.getByRole('region', { name: 'Site Engineer' })).toContainText(ENGINEER.name);
  await noHorizontalScroll(a);
  await a.getByRole('button', { name: `View as ${ENGINEER.name}` }).click();
  await expect(a).toHaveURL(/\/home$/);
  await expect(a.getByText(`Viewing as ${ENGINEER.name} · Site Engineer · read-only`)).toBeVisible(
    SLOW,
  );
  await noHorizontalScroll(a);

  // What the engineer sees: their own log, no Everyone tab, no approvals or summary.
  await a.goto('/attendance/log');
  const viewed = a.getByRole('list', { name: 'Attendance by day' });
  await expect(viewed).toContainText(/In \d\d:\d\d · Recorded/, SLOW);
  await expect(viewed).not.toContainText(FAR_ENGINEER.name);
  await expect(a.getByRole('tab', { name: 'Everyone' })).toHaveCount(0);
  await a.goto('/attendance/approvals');
  await expect(a.getByText('You do not have access to approvals.')).toBeVisible(SLOW);
  await a.getByRole('button', { name: 'Open menu' }).click();
  const viewMenu = a.getByRole('navigation', { name: 'Main menu' });
  await expect(viewMenu.getByRole('link', { name: 'Attendance log' })).toBeVisible();
  for (const name of ['Approvals', 'Site settings', 'Monthly summary']) {
    await expect(viewMenu.getByRole('link', { name })).toHaveCount(0);
  }
  await expect(viewMenu.getByRole('link', { name: 'Switch view' })).toBeVisible();

  // Read-only: the server refuses any change while viewing.
  const write = await a.evaluate(async () => {
    const company = localStorage.getItem('sd.company')!;
    const { token } = JSON.parse(sessionStorage.getItem(`sd.viewas.${company}`)!) as {
      token: string;
    };
    const res = await fetch('/api/projects', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-company-id': company, 'x-view-as': token },
      body: JSON.stringify({ name: 'Nope', code: 'NO-1' }),
    });
    return { status: res.status, body: (await res.json()) as { error: { code: string } } };
  });
  expect(write.status).toBe(403);
  expect(write.body.error.code).toBe('read_only_view');

  // Exit: back to the Super Admin's own view, with everything again.
  await a.getByRole('button', { name: 'Close menu' }).click();
  await a.getByRole('button', { name: 'Exit view' }).click();
  await expect(a).toHaveURL(/\/home$/);
  await expect(a.getByText(/Viewing as/)).toHaveCount(0);
  await a.getByRole('button', { name: 'Open menu' }).click();
  const ownMenu = a.getByRole('navigation', { name: 'Main menu' });
  for (const name of ['Approvals', 'Site settings', 'Monthly summary', 'View as…']) {
    await expect(ownMenu.getByRole('link', { name })).toBeVisible();
  }

  await Promise.all([admin.context.close(), eng.context.close(), far.context.close()]);
});
