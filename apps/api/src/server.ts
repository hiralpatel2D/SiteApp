import { serve } from '@hono/node-server';
import { loadConfig } from './config';
import { createApp } from './app';

let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

// TODO(Task 4): replace with a real Postgres ping via the Drizzle client.
const checkDb = async (): Promise<boolean> => false;

const app = createApp({ checkDb });
serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`API listening on port ${info.port}`);
});
