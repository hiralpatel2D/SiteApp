import { randomInt } from 'node:crypto';
import { newId } from '@sitediary/shared';
import { createApp, type AppDeps } from '../../src/app';

import { createAuth } from '../../src/auth/auth';
import type { Config } from '../../src/config';
import type { EmailSender } from '../../src/email/email';
import { accounts, users } from '../../src/db/schema';
import { cfg, ownerDb, pools } from './db';

type Hono = ReturnType<typeof createApp>;

export type SentEmail =
  | {
      kind: 'invitation';
      to: string;
      data: Parameters<EmailSender['sendInvitation']>[1];
    }
  | { kind: 'passwordReset'; to: string; data: Parameters<EmailSender['sendPasswordReset']>[1] };

/** EmailSender that records instead of sending. */
export function recordingEmail(): EmailSender & { sent: SentEmail[] } {
  const sent: SentEmail[] = [];
  return {
    sent,
    async sendInvitation(to, data) {
      sent.push({ kind: 'invitation', to, data });
    },
    async sendPasswordReset(to, data) {
      sent.push({ kind: 'passwordReset', to, data });
    },
  };
}

/** A full app wired to the test database, with a recording email sender. */
export function testApp(overrides: { config?: Partial<Config>; email?: EmailSender } = {}): {
  app: Hono;
  email: EmailSender & { sent: SentEmail[] };
  deps: AppDeps;
} {
  const email = recordingEmail();
  const deps: AppDeps = {
    checkDb: async () => true,
    pools,
    config: { ...cfg, ...overrides.config },
    email: overrides.email ?? email,
  };
  return { app: createApp(deps), email, deps };
}

/**
 * A random client IP. Better Auth's rate limiter keeps a process-wide memory
 * store keyed by IP and path, so helpers use a fresh IP per call to stay clear
 * of each other's limits; tests about limits pass a fixed `ip`.
 */
export function randomIp(): string {
  return `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
}

/** `name=value; name2=value2` from a response's Set-Cookie headers (cleared cookies dropped). */
export function cookieFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0]!.trim())
    .filter((pair) => !pair.endsWith('='))
    .join('; ');
}

type ReqOptions = {
  cookie?: string;
  company?: string;
  method?: string;
  body?: unknown;
  /** Defaults to the configured app origin; `null` omits the header. */
  origin?: string | null;
  ip?: string;
  headers?: Record<string, string>;
};

/** A same-origin request as the web app would send it. */
export function req(app: Hono, path: string, opts: ReqOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { 'x-client-ip': opts.ip ?? randomIp() };
  const origin = opts.origin === undefined ? cfg.appBaseUrl : opts.origin;
  if (origin !== null) headers.origin = origin;
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.company) headers['x-company-id'] = opts.company;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return Promise.resolve(
    app.request(path, {
      method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
      headers: { ...headers, ...opts.headers },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
  );
}

async function expectOk(res: Response, what: string): Promise<Response> {
  if (res.status !== 200) {
    throw new Error(`${what} failed: ${res.status} ${await res.text()}`);
  }
  return res;
}

/** Signs up through Better Auth (subject to the invite-only gate); returns the session cookie. */
export async function signUp(
  app: Hono,
  user: { email: string; password: string; name: string },
): Promise<string> {
  const res = await req(app, '/api/auth/sign-up/email', { body: user });
  return cookieFrom(await expectOk(res, `sign-up ${user.email}`));
}

/** Signs in through Better Auth; returns the session cookie. */
export async function signIn(app: Hono, email: string, password: string): Promise<string> {
  const res = await req(app, '/api/auth/sign-in/email', { body: { email, password } });
  return cookieFrom(await expectOk(res, `sign-in ${email}`));
}

let hasherAuth: ReturnType<typeof createAuth> | undefined;

/** Hashes with Better Auth's own configured password hasher. */
async function hashPassword(password: string): Promise<string> {
  hasherAuth ??= createAuth({
    pools,
    config: cfg,
    email: recordingEmail(),
    canSignUp: async () => false,
  });
  return (await hasherAuth.$context).password.hash(password);
}

/**
 * Creates a user with an email/password credential directly in the database as
 * the owner role, bypassing the invite-only sign-up gate. Sign in with
 * `signIn(app, email, password)` afterwards.
 */
export async function seedUser(input: {
  email: string;
  password: string;
  name: string;
  isPlatformAdmin?: boolean;
}): Promise<{ id: string; email: string }> {
  const id = newId();
  const email = input.email.trim().toLowerCase();
  await ownerDb.insert(users).values({
    id,
    email,
    name: input.name,
    emailVerified: false,
    isPlatformAdmin: input.isPlatformAdmin ?? false,
  });
  await ownerDb.insert(accounts).values({
    id: newId(),
    userId: id,
    accountId: id,
    providerId: 'credential',
    password: await hashPassword(input.password),
  });
  return { id, email };
}
