import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { routeTree } from '../src/routeTree.gen';
import { api } from '../src/lib/api';
import { setActiveCompany } from '../src/lib/company';
import { clearViewAs, getViewAsToken, setViewAs } from '../src/lib/viewas';

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const ENG = {
  membershipId: 'm-eng',
  name: 'Esha Engineer',
  email: 'esha@x.test',
  roleName: 'Site Engineer',
  roleKey: 'site_engineer',
};
const PEOPLE = [
  ENG,
  {
    ...ENG,
    membershipId: 'm-pm',
    name: 'Pooja PM',
    email: 'pooja@x.test',
    roleName: 'Project Manager',
  },
];

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const me = {
  user: {
    id: 'u1',
    name: 'Boss',
    email: 'boss@x.test',
    isPlatformAdmin: false,
    mustChangePassword: false,
  },
  memberships: [
    {
      companyId: COMPANY_ID,
      companyName: 'V and P',
      companySlug: 'vp',
      companyStatus: 'active',
      roleName: 'Super Admin',
      status: 'active',
    },
  ],
};

type Seen = { url: string; method: string; headers: Headers }[];

function setup(ctxExtra: Record<string, unknown>, capabilities = ['projects.view', 'users.view']) {
  const seen: Seen = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push({ url, method: init?.method ?? 'GET', headers: new Headers(init?.headers) });
    if (url.includes('/api/me')) return Promise.resolve(json(200, me));
    if (url.includes('/api/company/context'))
      return Promise.resolve(
        json(200, {
          company: { id: COMPANY_ID, name: 'V and P', slug: 'vp' },
          role: { id: 'r1', name: 'Super Admin', key: 'super_admin' },
          capabilities,
          ...ctxExtra,
        }),
      );
    if (url.includes('/api/company/view-as/people'))
      return Promise.resolve(json(200, { people: PEOPLE }));
    if (url.endsWith('/api/company/view-as/stop')) return Promise.resolve(json(200, { ok: true }));
    if (url.endsWith('/api/company/view-as'))
      return Promise.resolve(json(200, { token: 'tok-123', expiresAt: 'x', person: ENG }));
    if (url.includes('/api/projects')) return Promise.resolve(json(200, []));
    return Promise.resolve(json(404, { error: { code: 'not_found', message: 'Not found.' } }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return seen;
}

function renderAt(path: string) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(<RouterProvider router={router} />);
  return router;
}

const assign = vi.fn();
const realLocation = window.location;

describe('View as (Super Admin)', () => {
  beforeEach(() => {
    setActiveCompany(COMPANY_ID);
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...realLocation, assign },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    assign.mockClear();
    clearViewAs(COMPANY_ID);
    setActiveCompany(null);
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  });

  it('the menu offers "View as…" only to a Super Admin', async () => {
    setup({ canViewAs: true, viewAs: null });
    renderAt('/home');
    const menu = await screen.findByRole('navigation', { name: 'Main menu' });
    expect(await within(menu).findByRole('link', { name: /View as/ })).toBeTruthy();
  });

  it('is hidden from everyone else', async () => {
    setup({ canViewAs: false, viewAs: null });
    renderAt('/home');
    const menu = await screen.findByRole('navigation', { name: 'Main menu' });
    await within(menu).findByRole('link', { name: 'Home' });
    expect(within(menu).queryByRole('link', { name: /View as|Switch view/ })).toBeNull();
  });

  it('lists the people by role, then View stores the token and reloads into the view', async () => {
    const seen = setup({ canViewAs: true, viewAs: null });
    renderAt('/view-as');
    const eng = await screen.findByRole('region', { name: 'Site Engineer' });
    expect(within(eng).getByText('Esha Engineer')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Project Manager' })).toBeTruthy();
    expect(screen.getByText(/read-only/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'View as Esha Engineer' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/home'));
    expect(getViewAsToken(COMPANY_ID)).toBe('tok-123');
    const start = seen.find((s) => s.url.endsWith('/api/company/view-as') && s.method === 'POST');
    expect(start).toBeTruthy();
  });

  it('shows a banner while viewing, hides Platform admin, and Exit stops and clears', async () => {
    setViewAs(COMPANY_ID, { token: 'tok-123', person: ENG });
    const seen = setup({ canViewAs: true, viewAs: ENG });
    renderAt('/home');
    const banner = (
      await screen.findByText('Viewing as Esha Engineer · Site Engineer · read-only')
    ).closest('[role="status"]') as HTMLElement;
    expect(banner.textContent).toContain('Viewing as Esha Engineer · Site Engineer · read-only');
    // Every request carries the token while viewing.
    await waitFor(() =>
      expect(
        seen.filter((s) => s.url.includes('/api/company/context'))[0]!.headers.get('x-view-as'),
      ).toBe('tok-123'),
    );
    await userEvent.click(within(banner).getByRole('button', { name: 'Exit view' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/home'));
    expect(getViewAsToken(COMPANY_ID)).toBeNull();
    expect(
      seen.some((s) => s.url.endsWith('/api/company/view-as/stop') && s.method === 'POST'),
    ).toBe(true);
  });

  it('the people page tells anyone else it is for Super Admins only', async () => {
    setup({ canViewAs: false, viewAs: null });
    renderAt('/view-as');
    expect(
      await screen.findByText('Only a Super Admin can view the app as someone else.'),
    ).toBeTruthy();
  });

  it('api() sends the token only for the company it was started in', async () => {
    const seen = setup({ canViewAs: true, viewAs: null });
    setViewAs(COMPANY_ID, { token: 'tok-123', person: ENG });
    await api('/api/projects');
    expect(seen.at(-1)!.headers.get('x-view-as')).toBe('tok-123');
    clearViewAs(COMPANY_ID);
    await api('/api/projects');
    expect(seen.at(-1)!.headers.get('x-view-as')).toBeNull();
    setViewAs(COMPANY_ID, { token: 'tok-123', person: ENG });
    await api('/api/projects', { company: '22222222-2222-4222-8222-222222222222' });
    expect(seen.at(-1)!.headers.get('x-view-as')).toBeNull();
  });
});
