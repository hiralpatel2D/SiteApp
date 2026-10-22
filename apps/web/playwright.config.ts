import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

// Locally, point PW_CHROMIUM at a preinstalled Chromium binary. CI installs
// browsers with `playwright install` and leaves it unset.
const executablePath = process.env.PW_CHROMIUM || undefined;

// The e2e suite runs the real API against the test database. Locally the
// database settings come from apps/api/.env.test (run `scripts/test-db.sh start`
// first); in CI they are in the job's environment. loadEnvFile never overrides
// variables that are already set.
const envFile = fileURLToPath(new URL('../api/.env.test', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const WEB_URL = 'http://localhost:4173';
const API_PORT = '3000';

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: WEB_URL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          executablePath,
          // A fake camera, allowed without a prompt, so getUserMedia succeeds.
          args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
        },
      },
    },
  ],
  webServer: [
    {
      // Migrate, then start the API. The web preview proxies /api here.
      command: 'pnpm --filter api db:migrate && pnpm --filter api start',
      url: `http://localhost:${API_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        NODE_ENV: 'test',
        PORT: API_PORT,
        APP_BASE_URL: WEB_URL,
        PLATFORM_ADMIN_EMAILS: 'owner@sitediary.test',
        // Face reading without models: every frame is one live face with the same code.
        API_FACE_ENGINE: 'fake',
        BETTER_AUTH_SECRET:
          process.env.BETTER_AUTH_SECRET || 'test-only-better-auth-secret-0123456789abcdef',
      },
    },
    {
      command: 'pnpm build && pnpm preview --port 4173 --strictPort',
      url: WEB_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { API_URL: `http://localhost:${API_PORT}` },
    },
  ],
});
