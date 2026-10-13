-- Roles, grants and row-level security. Applied by src/db/migrate.ts after the
-- Drizzle migrations, inside one transaction, on every run: must stay idempotent.
-- Runs as the owner/migration role, which must be superuser or BYPASSRLS
-- because FORCE ROW LEVEL SECURITY also applies to the table owner.
-- The app_user password is set by migrate.ts (ALTER ROLE ... PASSWORD built
-- with escapeLiteral); never put credentials in this file.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
-- Re-assert on every run in case the role was altered by hand.
ALTER ROLE app_user LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;

GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON projects, roles, role_capabilities TO app_user;
-- audit_log is append-only for the app role. Revoke first so older databases,
-- which were granted UPDATE/DELETE before, are tightened on re-run.
REVOKE UPDATE, DELETE ON audit_log FROM app_user;
GRANT SELECT, INSERT ON audit_log TO app_user;
-- No role may create objects in the public schema by default.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT SELECT ON companies TO app_user;

-- companies: app_user may read only its own company row (no write grants).
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS own_company ON companies;
CREATE POLICY own_company ON companies FOR SELECT
  USING (id = nullif(current_setting('app.company_id', true), '')::uuid);

-- projects: tenant isolation on company_id.
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON projects;
CREATE POLICY tenant_isolation ON projects
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);

-- roles: tenant isolation on company_id.
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON roles;
CREATE POLICY tenant_isolation ON roles
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);

-- role_capabilities: tenant isolation on company_id.
ALTER TABLE role_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_capabilities FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON role_capabilities;
CREATE POLICY tenant_isolation ON role_capabilities
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);

-- audit_log: tenant isolation on company_id.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON audit_log;
CREATE POLICY tenant_isolation ON audit_log
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- Identity (Plan 2).
-- ---------------------------------------------------------------------------

-- Global identity tables: used by Better Auth before any tenant is chosen.
-- Not company data, so no RLS; app_user gets DML, PUBLIC gets nothing.
REVOKE ALL ON users, sessions, accounts, verifications FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON users, sessions, accounts, verifications TO app_user;

-- Tenant tables.
REVOKE ALL ON memberships, project_assignments, invitations FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON memberships, project_assignments, invitations TO app_user;

-- memberships: tenant isolation on company_id.
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON memberships;
CREATE POLICY tenant_isolation ON memberships
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);

-- project_assignments: tenant isolation on company_id.
ALTER TABLE project_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_assignments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON project_assignments;
CREATE POLICY tenant_isolation ON project_assignments
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);

-- invitations: tenant isolation on company_id.
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON invitations;
CREATE POLICY tenant_isolation ON invitations
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);

-- Pre-tenant lookups. SECURITY DEFINER (owned by this owner role, which
-- bypasses RLS) so they work before app.company_id is set, but each returns
-- only rows keyed by its argument and only the listed columns. search_path is
-- pinned so a caller cannot shadow the referenced tables or operators.

-- Companies the signed-in user belongs to (active and deactivated memberships).
CREATE OR REPLACE FUNCTION app_user_memberships(p_user uuid)
RETURNS TABLE(
  membership_id uuid, company_id uuid, company_name text, company_slug text,
  company_status text, role_id uuid, role_key text, role_name text, membership_status text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $fn$
  SELECT m.id, c.id, c.name, c.slug, c.status, r.id, r.key, r.name, m.status
    FROM public.memberships m
    JOIN public.companies c ON c.id = m.company_id
    JOIN public.roles r ON r.company_id = m.company_id AND r.id = m.role_id
   WHERE m.user_id = p_user
   ORDER BY c.name, c.id
$fn$;
REVOKE ALL ON FUNCTION app_user_memberships(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_user_memberships(uuid) TO app_user;

-- An invitation by the SHA-256 hex of its token (invite link landing page).
CREATE OR REPLACE FUNCTION app_invitation_lookup(p_token_hash text)
RETURNS TABLE(
  invitation_id uuid, company_id uuid, company_name text, company_status text, email text,
  role_name text, expires_at timestamptz, accepted_at timestamptz, revoked_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $fn$
  SELECT i.id, c.id, c.name, c.status, i.email, r.name, i.expires_at, i.accepted_at, i.revoked_at
    FROM public.invitations i
    JOIN public.companies c ON c.id = i.company_id
    JOIN public.roles r ON r.company_id = i.company_id AND r.id = i.role_id
   WHERE i.token_hash = p_token_hash
$fn$;
REVOKE ALL ON FUNCTION app_invitation_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_invitation_lookup(text) TO app_user;

-- The owner role (migrations, platform admin) is exempt via superuser/BYPASSRLS.
