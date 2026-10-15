import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { routeTree } from '../src/routeTree.gen';
import { ApiError } from '../src/lib/api';
import { isPasswordChangeRequired, landingFor, type Me } from '../src/lib/auth';
import { getActiveCompany, setActiveCompany } from '../src/lib/company';

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const REQUIRED = {
  error: { code: 'password_change_required', message: 'Set a new password to continue.' },
};

function me(
  opts: { mustChangePassword?: boolean; isPlatformAdmin?: boolean; memberships?: number } = {},
): Me {
  return {
    user: {
      id: 'u1',
      name: 'Owner',
      email: 'owner@example.test',
      isPlatformAdmin: opts.isPlatformAdmin ?? true,
      mustChangePassword: opts.mustChangePassword ?? false,
    },
    memberships: Array.from({ length: opts.memberships ?? 0 }, () => ({
      companyId: COMPANY_ID,
      companyName: 'Mehta Infra',
      companySlug: 'mehta-infra',
      companyStatus: 'active',
      roleName: 'Super Admin',
      status: 'active',
    })),
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

const urlOf = (input: unknown) => String(input instanceof Request ? input.url : input);

describe('landingFor', () => {
  it('sends a user who must change their password to /change-password first', () => {
    expect(landingFor(me({ mustChangePassword: true }))).toBe('/change-password');
    expect(landingFor(me({ mustChangePassword: true, memberships: 1 }))).toBe('/change-password');
  });
  it('platform admins without memberships go to /platform, everyone else to /companies', () => {
    expect(landingFor(me())).toBe('/platform');
    expect(landingFor(me({ memberships: 1 }))).toBe('/companies');
    expect(landingFor(me({ isPlatformAdmin: false }))).toBe('/companies');
  });
});

describe('isPasswordChangeRequired', () => {
  it('matches only the 403 password_change_required error', () => {
    expect(isPasswordChangeRequired(new ApiError(403, 'password_change_required', 'x'))).toBe(true);
    expect(isPasswordChangeRequired(new ApiError(403, 'forbidden', 'x'))).toBe(false);
    expect(isPasswordChangeRequired(new Error('x'))).toBe(false);
  });
});

describe('password change guard', () => {
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

  for (const path of ['/platform', '/companies', '/home']) {
    it(`${path} redirects to /change-password while the flag is set`, async () => {
      setActiveCompany(COMPANY_ID);
      fetchMock.mockImplementation((input: unknown) => {
        const url = urlOf(input);
        if (url.includes('/api/me'))
          return Promise.resolve(json(200, me({ mustChangePassword: true, memberships: 1 })));
        return Promise.resolve(json(403, REQUIRED));
      });
      const router = renderAt(path);
      await vi.waitFor(() => expect(router.state.location.pathname).toBe('/change-password'));
      expect(await screen.findByRole('heading', { name: 'Set a new password' })).toBeTruthy();
    });
  }

  it('/home redirects on a 403 password_change_required and keeps the company', async () => {
    setActiveCompany(COMPANY_ID);
    fetchMock.mockImplementation((input: unknown) => {
      const url = urlOf(input);
      // /api/me fails here, so only the context call can trigger the redirect.
      if (url.includes('/api/me')) return Promise.resolve(json(503, {}));
      return Promise.resolve(json(403, REQUIRED));
    });
    const router = renderAt('/home');
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/change-password'));
    expect(getActiveCompany()).toBe(COMPANY_ID);
  });

  it('/platform redirects when the companies list answers password_change_required', async () => {
    fetchMock.mockImplementation((input: unknown) => {
      const url = urlOf(input);
      if (url.includes('/api/me')) return Promise.resolve(json(200, me()));
      return Promise.resolve(json(403, REQUIRED));
    });
    const router = renderAt('/platform');
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/change-password'));
  });
});

describe('/change-password', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let changed: boolean;
  beforeEach(() => {
    changed = false;
    fetchMock = vi.fn((input: unknown, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.includes('/api/me/password')) {
        const body = JSON.parse(String(init?.body)) as { currentPassword: string };
        if (body.currentPassword !== '123456789') {
          return Promise.resolve(
            json(400, {
              error: {
                code: 'validation_failed',
                message: 'Check the highlighted fields.',
                details: { currentPassword: 'Your current password is not correct.' },
              },
            }),
          );
        }
        changed = true;
        return Promise.resolve(json(200, { ok: true }));
      }
      if (url.includes('/api/me')) {
        return Promise.resolve(json(200, me({ mustChangePassword: !changed })));
      }
      return Promise.resolve(json(200, []));
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  async function fill(current: string, next: string, confirm: string) {
    await userEvent.type(await screen.findByLabelText('Current password'), current);
    await userEvent.type(screen.getByLabelText('New password'), next);
    await userEvent.type(screen.getByLabelText('Confirm new password'), confirm);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  }

  it('checks the confirmation on the device before calling the API', async () => {
    renderAt('/change-password');
    expect(await screen.findByText('At least 10 characters.')).toBeTruthy();
    await fill('123456789', 'new-password-1', 'new-password-2');
    expect((await screen.findByRole('alert')).textContent).toBe('Check the highlighted fields.');
    expect(screen.getByText('The passwords do not match.')).toBeTruthy();
    expect(fetchMock.mock.calls.some(([u]) => urlOf(u).includes('/api/me/password'))).toBe(false);
  });

  it('shows the field error for a wrong current password', async () => {
    renderAt('/change-password');
    await fill('wrong-password', 'new-password-1', 'new-password-1');
    expect((await screen.findByRole('alert')).textContent).toBe('Check the highlighted fields.');
    expect(screen.getByText('Your current password is not correct.')).toBeTruthy();
  });

  it('saves and goes to /platform for a platform admin without companies', async () => {
    const router = renderAt('/change-password');
    await fill('123456789', 'new-password-1', 'new-password-1');
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/platform'));
  });
});
