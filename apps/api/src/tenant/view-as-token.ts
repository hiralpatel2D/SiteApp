import { createHmac, timingSafeEqual } from 'node:crypto';

/** How long a "view as" session lasts before the Super Admin has to pick the person again. */
export const VIEW_AS_TTL_MS = 2 * 60 * 60 * 1000;

export type ViewAsClaims = {
  /** The real signed-in user. */
  u: string;
  /** The company the view is in. */
  c: string;
  /** The membership being viewed. */
  t: string;
  /** Expiry, epoch ms. */
  exp: number;
};

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');
const sign = (secret: string, body: string) =>
  createHmac('sha256', `view-as:${secret}`).update(body).digest();

/** A signed token: only the audited start endpoint can make one. */
export function signViewAs(secret: string, claims: ViewAsClaims): string {
  const body = b64(JSON.stringify(claims));
  return `${body}.${b64(sign(secret, body))}`;
}

/**
 * The claims of a genuine, unexpired token for this user and company, else null (never throws:
 * a bad token is just no view-as).
 */
export function verifyViewAs(
  secret: string,
  token: string,
  userId: string,
  companyId: string,
  now = Date.now(),
): ViewAsClaims | null {
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const want = sign(secret, body);
  const got = Buffer.from(mac, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString()) as ViewAsClaims;
    if (claims.u !== userId || claims.c !== companyId || typeof claims.t !== 'string') return null;
    if (!(claims.exp > now)) return null;
    return claims;
  } catch {
    return null;
  }
}
