import { defineConfig } from 'vitest/config';

// Vitest 3.2+ deprecates vitest.workspace files in favour of `test.projects`.
// Globs match nothing until apps/api and apps/web exist (later tasks).
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
    passWithNoTests: true,
  },
});
