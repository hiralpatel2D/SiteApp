import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SignIn } from '../src/components/SignIn';
import { ThemeProvider } from '../src/theme/ThemeProvider';

describe('SignIn', () => {
  it('shows fields and the next-release message on submit', async () => {
    render(
      <ThemeProvider>
        <SignIn />
      </ThemeProvider>,
    );
    expect(screen.getByText('Every site, every day, on record.')).toBeTruthy();
    expect(screen.getByLabelText('Company workspace (optional)')).toBeTruthy();
    expect(screen.getByLabelText('Email')).toBeTruthy();
    expect(screen.getByLabelText('Password')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByText('Sign-in is switched on in the next release.')).toBeTruthy();
  });
});
