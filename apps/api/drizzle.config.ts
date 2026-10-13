import { defineConfig } from 'drizzle-kit';

// Generates SQL migrations into ./drizzle. Apply them with `pnpm db:migrate`
// (src/db/migrate.ts), which also applies the row-level security in rls.sql.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
