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

-- The owner role (migrations, platform admin) is exempt via superuser/BYPASSRLS.
