import { pathToFileURL } from 'node:url';
import { and, eq, inArray, like } from 'drizzle-orm';
import { SYSTEM_ROLES, newId, type SystemRoleKey } from '@sitediary/shared';
import { createAuth } from '../auth/auth';
import { createCompany } from '../companies/create-company';
import { loadConfig, type Config } from '../config';
import { createPools, type Pools } from '../db/pools';
import {
  accounts,
  attendanceEntries,
  auditLog,
  companies,
  faceRegistrations,
  memberships,
  projectAssignments,
  projects,
  roles,
  users,
} from '../db/schema';

/**
 * Throwaway employees for testing roles and visibility. Every one has an email
 * on TEST_EMAIL_DOMAIN, which is the only thing `removeTestEmployees` deletes by,
 * so real people can never be matched. `.example` is reserved and cannot receive mail.
 */
export const TEST_EMAIL_DOMAIN = 'sitediary-test.example';
export const DEFAULT_TEST_PASSWORD = 'TestEmployee#2026';
export const TEST_WORKSPACE = { name: 'Test Workspace', slug: 'test-workspace' } as const;

/** One per system role, except Super Admin and Admin (none of the test staff may administer). */
const ADMIN_KEYS: readonly SystemRoleKey[] = ['super_admin', 'admin'];
export const TEST_EMPLOYEES: readonly { role: SystemRoleKey; name: string; email: string }[] =
  SYSTEM_ROLES.filter((r) => !ADMIN_KEYS.includes(r.key)).map((r) => ({
    role: r.key,
    name: `Test ${r.name}`,
    email: `${r.key.replace(/_/g, '-')}@${TEST_EMAIL_DOMAIN}`,
  }));

export type SeedResult = {
  created: { name: string; email: string; role: string }[];
  skipped: string[];
  projects: number;
};

async function findCompany(pools: Pools, slug: string, createIfMissing: boolean) {
  const find = async () =>
    (await pools.ownerDb.select().from(companies).where(eq(companies.slug, slug)))[0];
  const existing = await find();
  if (existing) return existing;
  if (!createIfMissing) throw new Error(`No company with workspace name "${slug}".`);
  // A fresh workspace: the nine system roles plus one sample project to assign people to.
  const { companyId } = await createCompany(pools.ownerDb, { name: TEST_WORKSPACE.name, slug });
  await pools.ownerDb
    .insert(projects)
    .values({ id: newId(), companyId, name: 'Test Site', code: 'TEST', status: 'active' });
  return (await find())!;
}

/**
 * Creates the test employees in one company, as the owner role: a verified user
 * with a password (no forced change), an active membership in their role, and
 * every active project of the company. Nobody has to accept an invitation or
 * change a password, so each can sign in straight away. Safe to run again.
 */
export async function seedTestEmployees(
  deps: { pools: Pools; config: Config },
  input: { companySlug: string; password?: string; createIfMissing?: boolean },
): Promise<SeedResult> {
  const { ownerDb } = deps.pools;
  const company = await findCompany(deps.pools, input.companySlug, input.createIfMissing ?? false);
  const password = input.password ?? DEFAULT_TEST_PASSWORD;

  // Hash with Better Auth's own hasher, so sign-in verifies it.
  const auth = createAuth({
    ...deps,
    email: { sendInvitation: async () => {}, sendPasswordReset: async () => {} },
    canSignUp: async () => false,
  });
  const hash = await (await auth.$context).password.hash(password);

  return ownerDb.transaction(async (tx) => {
    const roleRows = await tx
      .select({ id: roles.id, key: roles.key })
      .from(roles)
      .where(eq(roles.companyId, company.id));
    const roleId = new Map(roleRows.map((r) => [r.key, r.id]));
    const projectRows = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.companyId, company.id), eq(projects.status, 'active')));

    const result: SeedResult = { created: [], skipped: [], projects: projectRows.length };
    for (const e of TEST_EMPLOYEES) {
      const rid = roleId.get(e.role);
      if (!rid) throw new Error(`Company "${company.slug}" has no ${e.role} role.`);

      const [existing] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, e.email));
      if (existing) {
        result.skipped.push(e.email);
        continue;
      }
      const userId = newId();
      const membershipId = newId();
      await tx.insert(users).values({
        id: userId,
        email: e.email,
        name: e.name,
        emailVerified: true,
        mustChangePassword: false,
      });
      await tx.insert(accounts).values({
        id: newId(),
        userId,
        accountId: userId,
        providerId: 'credential',
        password: hash,
      });
      await tx.insert(memberships).values({
        id: membershipId,
        companyId: company.id,
        userId,
        roleId: rid,
        status: 'active',
      });
      if (projectRows.length > 0) {
        await tx.insert(projectAssignments).values(
          projectRows.map((p) => ({
            id: newId(),
            companyId: company.id,
            membershipId,
            projectId: p.id,
          })),
        );
      }
      result.created.push({ name: e.name, email: e.email, role: e.role });
    }

    if (result.created.length > 0) {
      await tx.insert(auditLog).values({
        id: newId(),
        companyId: company.id,
        action: 'test_employees.seeded',
        entity: 'company',
        entityId: company.id,
        after: { emails: result.created.map((c) => c.email) },
      });
    }
    return result;
  });
}

/**
 * Deletes every test employee (by email domain) from every company, with what
 * hangs off them: project assignments, face registrations, attendance entries,
 * memberships, sessions and sign-in credentials. Returns how many people went.
 */
export async function removeTestEmployees(pools: Pools): Promise<number> {
  return pools.ownerDb.transaction(async (tx) => {
    const found = await tx
      .select({ id: users.id })
      .from(users)
      .where(like(users.email, `%@${TEST_EMAIL_DOMAIN}`));
    if (found.length === 0) return 0;
    const userIds = found.map((u) => u.id);

    const ms = await tx
      .select({ id: memberships.id, companyId: memberships.companyId })
      .from(memberships)
      .where(inArray(memberships.userId, userIds));
    const membershipIds = ms.map((m) => m.id);
    if (membershipIds.length > 0) {
      await tx
        .delete(attendanceEntries)
        .where(inArray(attendanceEntries.membershipId, membershipIds));
      await tx
        .delete(faceRegistrations)
        .where(inArray(faceRegistrations.membershipId, membershipIds));
      await tx
        .delete(projectAssignments)
        .where(inArray(projectAssignments.membershipId, membershipIds));
      await tx.delete(memberships).where(inArray(memberships.id, membershipIds));
    }
    // sessions and accounts cascade from users.
    await tx.delete(users).where(inArray(users.id, userIds));

    for (const companyId of new Set(ms.map((m) => m.companyId))) {
      await tx.insert(auditLog).values({
        id: newId(),
        companyId,
        action: 'test_employees.removed',
        entity: 'company',
        entityId: companyId,
        after: { count: ms.filter((m) => m.companyId === companyId).length },
      });
    }
    return userIds.length;
  });
}

/** CLI: `pnpm --filter api test-employees seed|remove|list [--company <slug>] [--password <pw>]` */
async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const flag = (name: string) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const usage =
    'Usage: test-employees seed [--company <workspace>] [--password <pw>] | remove | list';
  if (command !== 'seed' && command !== 'remove' && command !== 'list') throw new Error(usage);

  const config = loadConfig(process.env);
  const pools = createPools(config);
  try {
    if (command === 'seed') {
      // No --company: use (and create if needed) the separate Test Workspace.
      const companySlug = flag('company') ?? TEST_WORKSPACE.slug;
      const password = flag('password') ?? DEFAULT_TEST_PASSWORD;
      const r = await seedTestEmployees(
        { pools, config },
        { companySlug, password, createIfMissing: companySlug === TEST_WORKSPACE.slug },
      );
      console.table(r.created);
      if (r.skipped.length > 0) console.log(`Already existed, left alone: ${r.skipped.join(', ')}`);
      console.log(
        `Created ${r.created.length}, each on ${r.projects} active project(s). Password: ${password}`,
      );
    } else if (command === 'remove') {
      console.log(`Removed ${await removeTestEmployees(pools)} test employee(s).`);
    } else {
      const { rows } = await pools.owner.query(
        `select u.name, u.email, c.slug as company, r.name as role
           from users u
           join memberships m on m.user_id = u.id
           join companies c on c.id = m.company_id
           join roles r on r.company_id = m.company_id and r.id = m.role_id
          where u.email like $1 order by c.slug, r.name`,
        [`%@${TEST_EMAIL_DOMAIN}`],
      );
      console.table(rows);
    }
  } finally {
    await Promise.all([pools.owner.end(), pools.app.end()]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
