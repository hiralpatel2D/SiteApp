import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config';

const base = {
  DATABASE_URL: 'postgres://a',
  MIGRATION_DATABASE_URL: 'postgres://b',
  APP_DB_PASSWORD: 'secret',
};

describe('loadConfig', () => {
  it('names the missing variable', () =>
    expect(() => loadConfig({ MIGRATION_DATABASE_URL: 'x' })).toThrow('DATABASE_URL'));
  it('rejects non-numeric PORT', () =>
    expect(() => loadConfig({ ...base, PORT: 'abc' })).toThrow('PORT'));
  it('requires APP_DB_PASSWORD', () =>
    expect(() => loadConfig({ ...base, APP_DB_PASSWORD: '' })).toThrow('APP_DB_PASSWORD'));
  it('defaults port and env', () =>
    expect(loadConfig(base)).toMatchObject({
      port: 3000,
      nodeEnv: 'development',
      appDbPassword: 'secret',
    }));
});
