import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMPANY_KEY, getActiveCompany, setActiveCompany } from '../src/lib/company';

const ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

describe('active company storage', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses the sd.company localStorage key', () => {
    expect(COMPANY_KEY).toBe('sd.company');
    setActiveCompany(ID);
    expect(localStorage.getItem('sd.company')).toBe(ID);
    expect(getActiveCompany()).toBe(ID);
  });

  it('is null when nothing is stored', () => {
    expect(getActiveCompany()).toBeNull();
  });

  it('setActiveCompany(null) clears the choice', () => {
    setActiveCompany(ID);
    setActiveCompany(null);
    expect(localStorage.getItem('sd.company')).toBeNull();
    expect(getActiveCompany()).toBeNull();
  });

  it('survives storage that throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => setActiveCompany(ID)).not.toThrow();
    expect(() => setActiveCompany(null)).not.toThrow();
    expect(getActiveCompany()).toBeNull();
  });
});
