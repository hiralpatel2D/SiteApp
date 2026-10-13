import { MODES, THEMES } from '../theme/theme';
import { useTheme } from '../theme/ThemeProvider';

const group = 'flex flex-wrap gap-1.5';
const btn =
  'min-h-9 cursor-pointer whitespace-nowrap rounded-[calc(var(--r)/2)] border border-line px-3 font-mono text-[11px] font-medium uppercase tracking-widest text-muted aria-pressed:border-accent aria-pressed:bg-accent aria-pressed:text-on-accent';

export function ThemeSwitcher() {
  const { theme, modePref, setTheme, setModePref } = useTheme();
  return (
    <div className="flex flex-col gap-3">
      <div role="group" aria-label="Theme" className="flex flex-col gap-1.5">
        <span className="font-mono text-[11px] uppercase tracking-widest text-muted">Theme</span>
        <div className={group}>
          {THEMES.map((t) => (
            <button
              key={t.value}
              type="button"
              className={btn}
              aria-pressed={theme === t.value}
              onClick={() => setTheme(t.value)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div role="group" aria-label="Mode" className="flex flex-col gap-1.5">
        <span className="font-mono text-[11px] uppercase tracking-widest text-muted">Mode</span>
        <div className={group}>
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              className={btn}
              aria-pressed={modePref === m.value}
              onClick={() => setModePref(m.value)}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
