import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider, useTheme } from '../src/theme/ThemeProvider';
import { ThemeSwitcher } from '../src/components/ThemeSwitcher';

function mockMatchMedia(dark: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: dark,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
}

describe('ThemeProvider', () => {
  beforeEach(() => mockMatchMedia(false));

  it('applies attributes to <html>', () => {
    render(
      <ThemeProvider>
        <div />
      </ThemeProvider>,
    );
    expect(document.documentElement.dataset.theme).toBe('field-ops');
    expect(document.documentElement.dataset.mode).toBe('light');
  });

  it('system mode follows a dark device', () => {
    mockMatchMedia(true);
    render(
      <ThemeProvider>
        <div />
      </ThemeProvider>,
    );
    expect(document.documentElement.dataset.mode).toBe('dark');
  });

  it('switching mode updates <html>', async () => {
    const Btn = () => {
      const t = useTheme();
      return <button onClick={() => t.setModePref('dark')}>dark</button>;
    };
    render(
      <ThemeProvider>
        <Btn />
      </ThemeProvider>,
    );
    await userEvent.click(screen.getByText('dark'));
    expect(document.documentElement.dataset.mode).toBe('dark');
  });

  it('ThemeSwitcher changes theme and persists it', async () => {
    render(
      <ThemeProvider>
        <ThemeSwitcher />
      </ThemeProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Swiss v2' }));
    await userEvent.click(screen.getByRole('button', { name: 'Sunlight' }));
    expect(document.documentElement.dataset.theme).toBe('swiss-v2');
    expect(document.documentElement.dataset.mode).toBe('sun');
    expect(screen.getByRole('button', { name: 'Sunlight' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(JSON.parse(localStorage.getItem('sd.theme') ?? '{}')).toEqual({
      theme: 'swiss-v2',
      mode: 'sun',
    });
  });
});
