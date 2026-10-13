import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolvePath(__dirname, '../src/tokens.css'), 'utf8');

// Every asserted token parses as hex or color-mix(hex N%, transparent); unparseable ones (oklch --good-bg) are not asserted.
// Light-mode accents carry only large (>=18.66px bold) text; WCAG large-text AA is 3:1.
const LARGE_TEXT_ACCENT = new Set(['swiss-v2/light', 'field-ops/light']);

type Vars = Record<string, string>;
const rgb = (h: string): number[] => {
  let x = h.replace('#', '');
  if (x.length === 3) x = [...x].map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16));
};
const lum = (c: number[]) => {
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const ratio = (a: number[], b: number[]) => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
/** Resolve a hex or `color-mix(in srgb, #hex N%, transparent)` over `over`. Returns null if unparseable. */
function resolve(v: string | undefined, over: number[]): number[] | null {
  if (!v) return null;
  if (/^#[0-9a-f]{3,6}$/i.test(v)) return rgb(v);
  const m = /^color-mix\(in srgb, (#[0-9a-f]{3,6}) (\d+)%, transparent\)$/i.exec(v);
  if (!m) return null;
  const f = rgb(m[1]!);
  const p = Number(m[2]) / 100;
  return f.map((c, i) => c * p + over[i]! * (1 - p));
}

function parse(): Map<string, Vars> {
  const out = new Map<string, Vars>();
  const root = /:root(?:\[data-theme='([\w-]+)'\])?(?:\[data-mode='(\w+)'\])?\s*\{([^}]*)\}/g;
  for (const m of css.matchAll(root)) {
    const key = `${m[1] ?? ''}/${m[2] ?? ''}`;
    const vars: Vars = out.get(key) ?? {};
    for (const d of m[3]!.matchAll(/(--[\w-]+):\s*([^;]+);/g)) vars[d[1]!] = d[2]!.trim();
    out.set(key, vars);
  }
  return out;
}

const all = parse();
const base = all.get('/') ?? {};
const combos = ['swiss-v2', 'field-ops'].flatMap((t) =>
  ['light', 'dark', 'sun'].map((m) => ({
    name: `${t}/${m}`,
    sun: m === 'sun',
    vars: { ...base, ...all.get(`${t}/`), ...all.get(`${t}/${m}`) } as Vars,
  })),
);

describe('theme contrast (WCAG 2.x)', () => {
  it('finds all six theme x mode blocks', () => {
    expect(combos.every((c) => c.vars['--app-bg'])).toBe(true);
  });
  for (const { name, sun, vars } of combos) {
    describe(name, () => {
      const white = [255, 255, 255];
      const get = (k: string, over = white) => {
        const c = resolve(vars[k], over);
        if (!c) throw new Error(`${name}: cannot parse ${k}=${vars[k]}`);
        return c;
      };
      const bg = get('--app-bg');
      const card = get('--card', bg);
      const min = sun ? 7 : 4.5;
      it(`text vs bg/card >= ${min}`, () => {
        expect(ratio(get('--text', bg), bg)).toBeGreaterThanOrEqual(min);
        expect(ratio(get('--text', card), card)).toBeGreaterThanOrEqual(min);
      });
      it(`muted vs bg/card >= ${min}`, () => {
        expect(ratio(get('--muted', bg), bg)).toBeGreaterThanOrEqual(min);
        expect(ratio(get('--muted', card), card)).toBeGreaterThanOrEqual(min);
      });
      const accentMin = LARGE_TEXT_ACCENT.has(name) ? 3 : 4.5;
      it(`on-accent vs accent >= ${accentMin}`, () => {
        expect(ratio(get('--on-accent'), get('--accent'))).toBeGreaterThanOrEqual(accentMin);
      });
      it('field-line vs card >= 3', () => {
        expect(ratio(get('--field-line', card), card)).toBeGreaterThanOrEqual(3);
      });
    });
  }
});
