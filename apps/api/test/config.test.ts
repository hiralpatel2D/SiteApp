import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config';

const base = { DATABASE_URL: 'postgres://a', MIGRATION_DATABASE_URL: 'postgres://b' };

describe('loadConfig', () => {
  it('names the missing variable', () =>
    expect(() => loadConfig({ MIGRATION_DATABASE_URL: 'x' })).toThrow('DATABASE_URL'));
  it('rejects non-numeric PORT', () =>
    expect(() => loadConfig({ ...base, PORT: 'abc' })).toThrow('PORT'));
  it('defaults port and env', () =>
    expect(loadConfig(base)).toMatchObject({ port: 3000, nodeEnv: 'development' }));
});
