import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  readStoredTheme,
  resolveMode,
  writeStoredTheme,
  type Mode,
  type ModePref,
  type ThemeName,
} from './theme';

interface ThemeContextValue {
  theme: ThemeName;
  modePref: ModePref;
  mode: Mode;
  setTheme: (theme: ThemeName) => void;
  setModePref: (mode: ModePref) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);
const DARK_QUERY = '(prefers-color-scheme: dark)';

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [stored, setStored] = useState(() => readStoredTheme());
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(DARK_QUERY);
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    setSystemDark(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const mode = resolveMode(stored.mode, systemDark);

  useEffect(() => {
    document.documentElement.dataset.theme = stored.theme;
    document.documentElement.dataset.mode = mode;
  }, [stored.theme, mode]);

  const setTheme = useCallback((theme: ThemeName) => {
    setStored((prev) => {
      const next = { ...prev, theme };
      writeStoredTheme(next);
      return next;
    });
  }, []);
  const setModePref = useCallback((modePref: ModePref) => {
    setStored((prev) => {
      const next = { ...prev, mode: modePref };
      writeStoredTheme(next);
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({ theme: stored.theme, modePref: stored.mode, mode, setTheme, setModePref }),
    [stored, mode, setTheme, setModePref],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}
