import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'api',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // DB-backed test files share one database and truncate it between tests,
    // so run this project's files one after another in a single process.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
