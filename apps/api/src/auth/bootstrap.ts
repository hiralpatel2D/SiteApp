import { eq, sql } from 'drizzle-orm';
import { newId } from '@sitediary/shared';
import type { Config } from '../config';
import type { Pools } from '../db/pools';
import { accounts, users } from '../db/schema';
import { createAuth } from './auth';

/** Serialises bootstrap across instances starting at the same time. */
const BOOTSTRAP_LOCK_KEY = 72_410_002;

export type BootstrapResult = 'created' | 'exists' | 'disabled';

/**
 * Creates the first owner account from BOOTSTRAP_OWNER_EMAIL/PASSWORD when no
 * user has that email yet: a platform admin who must change the temporary
 * password at first sign-in. An existing user is never touched (its password
 * is never reset). Runs on the owner pool, in one transaction under an
 * advisory lock, so concurrent start-ups create the account at most once.
 */
export async function bootstrapOwner(
  deps: { pools: Pools; config: Config },
  log: (message: string) => void = console.log,
): Promise<BootstrapResult> {
  const owner = deps.config.bootstrapOwner;
  if (!owner) return 'disabled';

  const exists = async (db: Pick<Pools['ownerDb'], 'select'>) =>
    (await db.select({ id: users.id }).from(users).where(eq(users.email, owner.email))).length > 0;
  if (await exists(deps.pools.ownerDb)) return 'exists';

  // Hash with Better Auth's own configured hasher, so sign-in verifies it.
  const auth = createAuth({
    pools: deps.pools,
    config: deps.config,
    email: { sendInvitation: async () => {}, sendPasswordReset: async () => {} },
    canSignUp: async () => false,
  });
  const hash = await (await auth.$context).password.hash(owner.password);

  const created = await deps.pools.ownerDb.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${BOOTSTRAP_LOCK_KEY})`);
    if (await exists(tx)) return false;
    const id = newId();
    const inserted = await tx
      .insert(users)
      .values({
        id,
        email: owner.email,
        name: 'Owner',
        emailVerified: false,
        isPlatformAdmin: true,
        mustChangePassword: true,
      })
      .onConflictDoNothing({ target: users.email })
      .returning({ id: users.id });
    if (inserted.length === 0) return false;
    await tx.insert(accounts).values({
      id: newId(),
      userId: id,
      accountId: id,
      providerId: 'credential',
      password: hash,
    });
    return true;
  });
  if (!created) return 'exists';
  log(`Owner account created for ${owner.email}; password change required at first sign-in.`);
  return 'created';
}
