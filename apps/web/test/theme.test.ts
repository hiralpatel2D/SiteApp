import { describe, expect, it } from 'vitest';
import { readStoredTheme, resolveMode, writeStoredTheme } from '../src/theme/theme';

function fakeStorage(data: Record<string, string>): Storage {
  return {
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
  } as unknown as Storage;
}
function throwingStorage(): Storage {
  const boom = () => {
    throw new Error('blocked');
  };
  return { getItem: boom, setItem: boom } as unknown as Storage;
}

describe('theme', () => {
  it('system follows the device', () => {
    expect(resolveMode('system', true)).toBe('dark');
    expect(resolveMode('system', false)).toBe('light');
  });
  it('explicit mode wins', () => expect(resolveMode('sun', true)).toBe('sun'));
  it('defaults when empty', () =>
    expect(readStoredTheme(fakeStorage({}))).toEqual({ theme: 'field-ops', mode: 'system' }));
  it('ignores unknown stored theme', () =>
    expect(readStoredTheme(fakeStorage({ 'sd.theme': '{"theme":"blue","mode":"dark"}' }))).toEqual({
      theme: 'field-ops',
      mode: 'dark',
    }));
  it('ignores malformed JSON', () =>
    expect(readStoredTheme(fakeStorage({ 'sd.theme': 'nope' }))).toEqual({
      theme: 'field-ops',
      mode: 'system',
    }));
  it('falls back when storage throws', () =>
    expect(readStoredTheme(throwingStorage())).toEqual({ theme: 'field-ops', mode: 'system' }));
  it('write swallows storage errors', () =>
    expect(() =>
      writeStoredTheme({ theme: 'swiss-v2', mode: 'light' }, throwingStorage()),
    ).not.toThrow());
  it('round-trips', () => {
    const s = fakeStorage({});
    writeStoredTheme({ theme: 'swiss-v2', mode: 'sun' }, s);
    expect(readStoredTheme(s)).toEqual({ theme: 'swiss-v2', mode: 'sun' });
  });
});
