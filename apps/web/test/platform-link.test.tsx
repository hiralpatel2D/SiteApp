import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { routeTree } from '../src/routeTree.gen';
import { setActiveCompany } from '../src/lib/company';

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function me(isPlatformAdmin: boolean) {
  return {
    user: {
      id: 'u1',
      name: 'Owner',
      email: 'owner@example.test',
      isPlatformAdmin,
      mustChangePassword: false,
    },
    memberships: [
      {
        companyId: COMPANY_ID,
        companyName: 'Mehta Infra',
        companySlug: 'mehta-infra',
        companyStatus: 'active',
        roleName: 'Super Admin',
        status: 'active',
      },
    ],
  };
}

const context = {
  company: { id: COMPANY_ID, name: 'Mehta Infra', slug: 'mehta-infra' },
  role: { id: 'r1', name: 'Super Admin', key: 'super_admin' },
  capabilities: [],
};

function respond(isPlatformAdmin: boolean) {
  return (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/me')) return Promise.resolve(json(200, me(isPlatformAdmin)));
    if (url.includes('/api/company/context')) return Promise.resolve(json(200, context));
    return Promise.resolve(json(404, { error: { code: 'not_found', message: 'Not found.' } }));
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

describe('Platform admin link', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    setActiveCompany(null);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setActiveCompany(null);
  });

  it('/companies opens the only company for a platform admin too, with the link there', async () => {
    fetchMock.mockImplementation(respond(true));
    const router = renderAt('/companies');
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/home'));
    expect(await screen.findByRole('link', { name: 'Platform admin' })).toBeTruthy();
    expect(screen.getByText('Mehta Infra')).toBeTruthy();
  });

  it('/home hides "Switch company" when there is only one company', async () => {
    setActiveCompany(COMPANY_ID);
    fetchMock.mockImplementation(respond(true));
    renderAt('/home');
    expect(await screen.findByRole('link', { name: 'Platform admin' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Switch company' })).toBeNull();
  });

  it('opening the app while signed in skips the sign-in form', async () => {
    fetchMock.mockImplementation(respond(false));
    const router = renderAt('/');
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/home'));
    expect(await screen.findByText('Mehta Infra')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
  });

  it('/home shows the link to a platform admin', async () => {
    setActiveCompany(COMPANY_ID);
    fetchMock.mockImplementation(respond(true));
    renderAt('/home');
    expect(await screen.findByRole('link', { name: 'Platform admin' })).toBeTruthy();
  });

  it('/home hides the link from everyone else', async () => {
    setActiveCompany(COMPANY_ID);
    fetchMock.mockImplementation(respond(false));
    renderAt('/home');
    expect(await screen.findByText('Super Admin')).toBeTruthy();
    // Let the /api/me lookup settle before asserting absence.
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/me'))).toBe(true),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('link', { name: 'Platform admin' })).toBeNull();
  });

  it('/companies still skips the picker for a non-admin with one active membership', async () => {
    fetchMock.mockImplementation(respond(false));
    const router = renderAt('/companies');
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/home'));
  });
});
