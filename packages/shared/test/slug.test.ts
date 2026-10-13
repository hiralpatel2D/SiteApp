import { describe, expect, it } from 'vitest';
import { normaliseSlug, projectCodeSchema, slugSchema } from '../src/slug';

describe('slug', () => {
  it.each([
    ['Mehta Infra', 'mehta-infra'],
    ['  --Shah__Builders--  ', 'shah-builders'],
    ['RK  Steel & Co.', 'rk-steel-co'],
    ['Ünïcode Bau', 'unicode-bau'],
  ])('normaliseSlug(%s) → %s', (i, o) => expect(normaliseSlug(i)).toBe(o));
  it('slugSchema rejects too short', () => expect(slugSchema.safeParse('ab').success).toBe(false));
  it('slugSchema rejects 41 chars', () =>
    expect(slugSchema.safeParse('a'.repeat(41)).success).toBe(false));
  it('projectCodeSchema uppercases', () =>
    expect(projectCodeSchema.parse(' rt-ph2 ')).toBe('RT-PH2'));
  it('projectCodeSchema rejects spaces', () =>
    expect(projectCodeSchema.safeParse('RT PH2').success).toBe(false));
});
