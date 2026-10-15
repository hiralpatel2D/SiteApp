import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { routeTree } from '../src/routeTree.gen';
import { setActiveCompany } from '../src/lib/company';

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const ROLE_ID = '22222222-2222-4222-8222-222222222222';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const me = {
  user: {
    id: 'u1',
    name: 'Hiral Patel',
    email: 'owner@example.test',
    isPlatformAdmin: true,
    mustChangePassword: false,
  },
  memberships: [
    {
      companyId: COMPANY_ID,
      companyName: 'V and P',
      companySlug: 'vinayak-group',
      companyStatus: 'active',
      roleName: 'Super Admin',
      status: 'active',
    },
  ],
};

function context(capabilities: string[]) {
  return {
    company: { id: COMPANY_ID, name: 'V and P', slug: 'vinayak-group' },
    role: { id: 'r1', name: 'Super Admin', key: 'super_admin' },
    capabilities,
  };
}

function renderAt(path: string) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(<RouterProvider router={router} />);
  return router;
}

describe('Team', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let posted: unknown;
  beforeEach(() => {
    posted = undefined;
    fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/api/me')) return Promise.resolve(json(200, me));
      if (url.includes('/api/company/context'))
        return Promise.resolve(json(200, context(['users.view', 'users.manage', 'roles.view'])));
      if (url.includes('/api/users'))
        return Promise.resolve(
          json(200, [
            {
              membershipId: 'm1',
              name: 'Hiral Patel',
              email: 'owner@example.test',
              roleId: 'r1',
              roleName: 'Super Admin',
              status: 'active',
            },
          ]),
        );
      if (url.includes('/api/roles'))
        return Promise.resolve(json(200, [{ id: ROLE_ID, name: 'Site Engineer', key: null }]));
      if (url.includes('/api/invitations') && init?.method === 'POST') {
        posted = JSON.parse(String(init.body));
        return Promise.resolve(
          json(201, {
            id: 'i1',
            email: 'ravi@example.test',
            roleName: 'Site Engineer',
            inviteUrl: 'https://app.example/invite/abc',
            expiresAt: '2026-10-22T00:00:00.000Z',
          }),
        );
      }
      if (url.includes('/api/invitations')) return Promise.resolve(json(200, { invitations: [] }));
      return Promise.resolve(json(404, { error: { code: 'not_found', message: 'Not found.' } }));
    });
    vi.stubGlobal('fetch', fetchMock);
    setActiveCompany(COMPANY_ID);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setActiveCompany(null);
  });

  it('the menu has Home, Team, Platform admin and the theme buttons', async () => {
    renderAt('/home');
    const menu = await screen.findByRole('navigation', { name: 'Main menu' });
    expect(await within(menu).findByRole('link', { name: 'Team' })).toBeTruthy();
    expect(within(menu).getByRole('link', { name: 'Home' })).toBeTruthy();
    expect(within(menu).getByRole('link', { name: 'Platform admin' })).toBeTruthy();
    expect(within(menu).getByRole('group', { name: 'Theme' })).toBeTruthy();
    expect(within(menu).getByRole('button', { name: 'Sign out' })).toBeTruthy();
  });

  it('invites someone and offers the link to copy or share on WhatsApp', async () => {
    renderAt('/team');
    expect(await screen.findByText('owner@example.test')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Their email'), 'ravi@example.test');
    await screen.findByRole('option', { name: 'Site Engineer' });
    await userEvent.selectOptions(screen.getByLabelText('Role'), ROLE_ID);
    await userEvent.click(screen.getByRole('button', { name: 'Create invite' }));

    expect((await screen.findByTestId('invite-link')).textContent).toBe(
      'https://app.example/invite/abc',
    );
    expect(posted).toEqual({ email: 'ravi@example.test', roleId: ROLE_ID });
    const share = screen.getByRole('link', { name: 'Share on WhatsApp' });
    expect(share.getAttribute('href')).toContain('https://wa.me/?text=');
    expect(decodeURIComponent(share.getAttribute('href')!)).toContain(
      'https://app.example/invite/abc',
    );
  });

  it('asks for a role before sending', async () => {
    renderAt('/team');
    await userEvent.type(await screen.findByLabelText('Their email'), 'ravi@example.test');
    await screen.findByRole('option', { name: 'Site Engineer' });
    await userEvent.click(screen.getByRole('button', { name: 'Create invite' }));
    expect(await screen.findByText('Choose a role.')).toBeTruthy();
    expect(posted).toBeUndefined();
  });
});
