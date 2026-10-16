import { describe, it, expect } from 'vitest';
import { DEV_FACE_TEMPLATE_KEY, loadConfig } from '../src/config';

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

  describe('face template key', () => {
    const key = Buffer.alloc(32, 7).toString('base64');
    it('decodes FACE_TEMPLATE_KEY from base64', () =>
      expect(loadConfig({ ...base, FACE_TEMPLATE_KEY: key }).faceTemplateKey).toEqual(
        Buffer.alloc(32, 7),
      ));
    it('rejects a key that is not 32 bytes', () =>
      expect(() =>
        loadConfig({ ...base, FACE_TEMPLATE_KEY: Buffer.alloc(16).toString('base64') }),
      ).toThrow('FACE_TEMPLATE_KEY'));
    it('rejects a key that is not base64', () =>
      expect(() => loadConfig({ ...base, FACE_TEMPLATE_KEY: '!!not base64!!' })).toThrow(
        'FACE_TEMPLATE_KEY',
      ));
    it('requires the key in production', () =>
      expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow('FACE_TEMPLATE_KEY'));
    it('falls back to the fixed development key outside production', () => {
      expect(loadConfig(base).faceTemplateKey).toEqual(DEV_FACE_TEMPLATE_KEY);
      expect(loadConfig({ ...base, NODE_ENV: 'test' }).faceTemplateKey).toEqual(
        DEV_FACE_TEMPLATE_KEY,
      );
      expect(DEV_FACE_TEMPLATE_KEY).toHaveLength(32);
    });
    it('accepts a key in production', () =>
      expect(
        loadConfig({ ...base, NODE_ENV: 'production', FACE_TEMPLATE_KEY: key }).faceTemplateKey,
      ).toHaveLength(32));
  });

  describe('face engine', () => {
    const prod = {
      ...base,
      NODE_ENV: 'production',
      FACE_TEMPLATE_KEY: Buffer.alloc(32).toString('base64'),
    };
    it('defaults to human', () => expect(loadConfig(base).faceEngine).toBe('human'));
    it('accepts fake outside production', () =>
      expect(loadConfig({ ...base, API_FACE_ENGINE: 'fake' }).faceEngine).toBe('fake'));
    it('refuses fake in production', () =>
      expect(() => loadConfig({ ...prod, API_FACE_ENGINE: 'fake' })).toThrow('API_FACE_ENGINE'));
    it('rejects an unknown engine', () =>
      expect(() => loadConfig({ ...base, API_FACE_ENGINE: 'other' })).toThrow('API_FACE_ENGINE'));
    it('uses human in production by default', () =>
      expect(loadConfig(prod).faceEngine).toBe('human'));
  });
});
