import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '../src/capabilities';
import { SYSTEM_ROLES, defaultCapabilities } from '../src/roles';

describe('roles', () => {
  it('has nine system roles', () => expect(SYSTEM_ROLES).toHaveLength(9));
  it('super_admin has every capability', () =>
    expect(new Set(defaultCapabilities('super_admin'))).toEqual(new Set(CAPABILITIES)));
  it('client has no manage capability', () =>
    expect(defaultCapabilities('client').some((c) => c.endsWith('.manage'))).toBe(false));
  it('store_keeper sees stock but not drawings', () => {
    const c = defaultCapabilities('store_keeper');
    expect(c).toContain('stock.view');
    expect(c).not.toContain('drawings.view');
  });
  it('every default is a known capability', () =>
    SYSTEM_ROLES.forEach((r) =>
      defaultCapabilities(r.key).forEach((c) => expect(CAPABILITIES).toContain(c)),
    ));
  it('projects.all only for super_admin and admin', () => {
    for (const r of SYSTEM_ROLES) {
      expect(defaultCapabilities(r.key).includes('projects.all')).toBe(
        r.key === 'super_admin' || r.key === 'admin',
      );
    }
  });
});
