import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config';

const base = {
  DATABASE_URL: 'postgres://a',
  MIGRATION_DATABASE_URL: 'postgres://b',
  APP_DB_PASSWORD: 'secret',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  APP_BASE_URL: 'https://app.sitediary.test',
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

  it('requires BETTER_AUTH_SECRET', () => {
    expect(() => loadConfig({ ...base, BETTER_AUTH_SECRET: undefined })).toThrow(
      'BETTER_AUTH_SECRET',
    );
  });
  it('rejects a BETTER_AUTH_SECRET shorter than 32 characters', () =>
    expect(() => loadConfig({ ...base, BETTER_AUTH_SECRET: 'x'.repeat(31) })).toThrow(
      'BETTER_AUTH_SECRET',
    ));
  it('exposes the auth secret', () =>
    expect(loadConfig(base).betterAuthSecret).toBe('x'.repeat(32)));

  it('requires APP_BASE_URL', () => {
    expect(() => loadConfig({ ...base, APP_BASE_URL: undefined })).toThrow('APP_BASE_URL');
  });
  it('rejects a relative APP_BASE_URL', () =>
    expect(() => loadConfig({ ...base, APP_BASE_URL: '/app' })).toThrow('APP_BASE_URL'));
  it('rejects a non-http APP_BASE_URL', () =>
    expect(() => loadConfig({ ...base, APP_BASE_URL: 'ftp://x.test' })).toThrow('APP_BASE_URL'));
  it('rejects an APP_BASE_URL with a path', () =>
    expect(() => loadConfig({ ...base, APP_BASE_URL: 'https://x.test/app' })).toThrow(
      'APP_BASE_URL',
    ));
  it('strips a trailing slash from APP_BASE_URL', () =>
    expect(loadConfig({ ...base, APP_BASE_URL: 'https://x.test:8443/' }).appBaseUrl).toBe(
      'https://x.test:8443',
    ));

  it('defaults PLATFORM_ADMIN_EMAILS to an empty list', () =>
    expect(loadConfig(base).platformAdminEmails).toEqual([]));
  it('splits, trims and lowercases PLATFORM_ADMIN_EMAILS', () =>
    expect(
      loadConfig({ ...base, PLATFORM_ADMIN_EMAILS: ' Owner@SiteDiary.test , ,b@x.test ' })
        .platformAdminEmails,
    ).toEqual(['owner@sitediary.test', 'b@x.test']));

  describe('bootstrap owner', () => {
    const admins = { ...base, PLATFORM_ADMIN_EMAILS: 'owner@sitediary.test' };
    it('is null when neither variable is set', () =>
      expect(loadConfig(admins).bootstrapOwner).toBeNull());
    it('lowercases and trims the email and keeps the password as given', () =>
      expect(
        loadConfig({
          ...admins,
          BOOTSTRAP_OWNER_EMAIL: '  Owner@SiteDiary.TEST ',
          BOOTSTRAP_OWNER_PASSWORD: '123456789',
        }).bootstrapOwner,
      ).toEqual({ email: 'owner@sitediary.test', password: '123456789' }));
    it('names BOOTSTRAP_OWNER_PASSWORD when only the email is set', () =>
      expect(() =>
        loadConfig({ ...admins, BOOTSTRAP_OWNER_EMAIL: 'owner@sitediary.test' }),
      ).toThrow('BOOTSTRAP_OWNER_PASSWORD'));
    it('names BOOTSTRAP_OWNER_EMAIL when only the password is set', () =>
      expect(() => loadConfig({ ...admins, BOOTSTRAP_OWNER_PASSWORD: '123456789' })).toThrow(
        'BOOTSTRAP_OWNER_EMAIL',
      ));
    it('treats an empty password as missing', () =>
      expect(() =>
        loadConfig({
          ...admins,
          BOOTSTRAP_OWNER_EMAIL: 'owner@sitediary.test',
          BOOTSTRAP_OWNER_PASSWORD: '',
        }),
      ).toThrow('BOOTSTRAP_OWNER_PASSWORD'));
    it('requires the email to be in PLATFORM_ADMIN_EMAILS', () =>
      expect(() =>
        loadConfig({
          ...admins,
          BOOTSTRAP_OWNER_EMAIL: 'someone@else.test',
          BOOTSTRAP_OWNER_PASSWORD: '123456789',
        }),
      ).toThrow(/BOOTSTRAP_OWNER_EMAIL must be listed in PLATFORM_ADMIN_EMAILS/));
    it('rejects a password shorter than 8 characters', () =>
      expect(() =>
        loadConfig({
          ...admins,
          BOOTSTRAP_OWNER_EMAIL: 'owner@sitediary.test',
          BOOTSTRAP_OWNER_PASSWORD: '1234567',
        }),
      ).toThrow(/BOOTSTRAP_OWNER_PASSWORD must be at least 8 characters/));
    it('accepts an 8-character password', () =>
      expect(
        loadConfig({
          ...admins,
          BOOTSTRAP_OWNER_EMAIL: 'owner@sitediary.test',
          BOOTSTRAP_OWNER_PASSWORD: '12345678',
        }).bootstrapOwner?.password,
      ).toBe('12345678'));
  });
});
