import { describe, expect, it } from 'vitest';
import { isId, newId } from '../src/ids';

describe('ids', () => {
  it('newId returns a v7 uuid', () => {
    const id = newId();
    expect(isId(id)).toBe(true);
    expect(id[14]).toBe('7');
  });
  it('newId is time-ordered', () => {
    const a = newId();
    const b = newId();
    expect(a < b).toBe(true);
  });
  it('isId rejects junk', () => {
    expect(isId('proj-3')).toBe(false);
    expect(isId(42)).toBe(false);
  });
});
