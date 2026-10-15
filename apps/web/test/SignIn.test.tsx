import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router';
import { RESET_SENT, SignIn } from '../src/components/SignIn';
import { ThemeProvider } from '../src/theme/ThemeProvider';

function renderSignIn() {
  const router = createRouter({
    routeTree: createRootRoute({ component: SignIn }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  return render(
    <ThemeProvider>
      <RouterProvider router={router} />
    </ThemeProvider>,
  );
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('SignIn', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows the catalogue message in an alert when sign-in fails', async () => {
    // A fresh Response per call: the signed-in check on mount reads one too.
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        json(429, {
          error: {
            code: 'rate_limited',
            message: 'Too many attempts. Wait a minute and try again.',
          },
        }),
      ),
    );
    renderSignIn();
    expect(await screen.findByText('Every site, every day, on record.')).toBeTruthy();
    expect(screen.queryByLabelText('Company workspace (optional)')).toBeNull();
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.example');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong-password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Too many attempts. Wait a minute and try again.',
    );
  });

  it('forgot password always shows the same answer', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json(200, { status: true })));
    renderSignIn();
    await userEvent.click(await screen.findByRole('button', { name: 'Forgot password?' }));
    await userEvent.type(screen.getByLabelText('Email'), 'nobody@b.example');
    await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByText(RESET_SENT)).toBeTruthy();
    expect(RESET_SENT).toBe('If that email has an account, a reset link is on its way.');
  });

  it('the eye button shows and hides the password', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json(401, {})));
    renderSignIn();
    const password = (await screen.findByLabelText('Password')) as HTMLInputElement;
    expect(password.type).toBe('password');
    await userEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(password.type).toBe('text');
    await userEvent.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(password.type).toBe('password');
  });

  it('has no owner sign-up link and no theme buttons (those live in the app menu)', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json(401, {})));
    renderSignIn();
    await screen.findByRole('button', { name: 'Sign in' });
    expect(screen.queryByRole('link', { name: /Create owner account/ })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Theme' })).toBeNull();
  });
});
