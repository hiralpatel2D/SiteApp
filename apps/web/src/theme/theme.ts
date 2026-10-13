export type ThemeName = 'field-ops' | 'swiss-v2';
export type ModePref = 'system' | 'light' | 'dark' | 'sun';
export type Mode = 'light' | 'dark' | 'sun';

export interface StoredTheme {
  theme: ThemeName;
  mode: ModePref;
}

export const THEME_STORAGE_KEY = 'sd.theme';
export const DEFAULT_THEME: StoredTheme = { theme: 'field-ops', mode: 'system' };

export const THEMES: readonly { value: ThemeName; label: string }[] = [
  { value: 'field-ops', label: 'Field Ops' },
  { value: 'swiss-v2', label: 'Swiss v2' },
];

export const MODES: readonly { value: ModePref; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'sun', label: 'Sunlight' },
];

const isTheme = (v: unknown): v is ThemeName => THEMES.some((t) => t.value === v);
const isModePref = (v: unknown): v is ModePref => MODES.some((m) => m.value === v);

export function resolveMode(pref: ModePref, systemDark: boolean): Mode {
  if (pref === 'system') return systemDark ? 'dark' : 'light';
  return pref;
}

function defaultStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function readStoredTheme(storage: Storage | undefined = defaultStorage()): StoredTheme {
  try {
    const raw = storage?.getItem(THEME_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_THEME };
    const parsed: unknown = JSON.parse(raw);
    const obj =
      typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    return {
      theme: isTheme(obj.theme) ? obj.theme : DEFAULT_THEME.theme,
      mode: isModePref(obj.mode) ? obj.mode : DEFAULT_THEME.mode,
    };
  } catch {
    return { ...DEFAULT_THEME };
  }
}

export function writeStoredTheme(
  value: StoredTheme,
  storage: Storage | undefined = defaultStorage(),
): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Storage can be blocked (private windows); the theme just won't persist.
  }
}
